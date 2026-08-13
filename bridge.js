#!/usr/bin/env node
'use strict';

/**
 * Louro — ponte do ditado por voz.
 *
 * O Chrome faz o reconhecimento de fala (Web Speech API, motor do Google, de
 * graca) numa janela escondida; este servidor coordena tudo e cola o texto no
 * app que estiver em foco.
 *
 * Fluxo de um ciclo:
 *   1. Atalho global dispara POST /toggle
 *   2. Servidor manda "start" por SSE -> pagina comeca a ouvir, overlay aparece
 *   3. Atalho de novo -> POST /toggle -> manda "stop" -> overlay some na hora
 *   4. Pagina devolve o texto em POST /type -> servidor cola no app focado
 *
 * O overlay usa gtk-layer-shell sem foco de teclado e a janela do Chrome fica
 * escondida, entao o foco nunca sai do terminal — nao ha janela pra "devolver"
 * o foco antes de colar.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

// A porta faz parte da identidade da janela do Chrome (a regra do KWin casa
// com "chrome-127.0.0.1"), entao mudar aqui exige mudar a regra tambem.
const PORT = Number(process.env.LOURO_PORT) || 8765;
const HOST = '127.0.0.1';
const HTML_PATH = path.join(__dirname, 'engine.html');

// keycodes do linux/input-event-codes.h
const KEY_LEFTSHIFT = 42;
const KEY_INSERT = 110;

// ydotool type ignora caracteres nao-ASCII (come todo acento do portugues) e o
// KWin nao expoe zwp_virtual_keyboard_manager_v1, entao wtype tambem esta fora.
// Clipboard + Shift+Insert e o unico caminho que preserva "coracao" inteiro.
const PASTE_KEYS = [
  `${KEY_LEFTSHIFT}:1`,
  `${KEY_INSERT}:1`,
  `${KEY_INSERT}:0`,
  `${KEY_LEFTSHIFT}:0`,
];

// margem pro wl-copy realmente assumir o clipboard antes de mandar a tecla
const CLIPBOARD_SETTLE_MS = 150;

// Se a pagina nao devolver nada nesse prazo apos o stop, destrava o estado.
// Pelo Chrome o texto ja esta pronto; pela OpenAI ainda falta subir o audio e
// esperar a resposta, entao o prazo e bem maior.
const STOP_TIMEOUT_CHROME_MS = 8000;
const STOP_TIMEOUT_OPENAI_MS = 75000;

// --- configuracao do usuario ---------------------------------------------
const CONFIG_DIR = path.join(os.homedir(), '.config', 'louro');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  engine: 'chrome',                 // 'chrome' (gratis) | 'openai' (chave sua)
  language: 'pt-BR',
  openaiModel: 'gpt-4o-transcribe',
  openaiApiKey: '',
};

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_TIMEOUT_MS = 60000;
// limite de upload da API; audio de ditado nem chega perto, mas melhor avisar
// antes de mandar do que receber um 413 sem explicacao
const OPENAI_MAX_BYTES = 25 * 1024 * 1024;

let config = { ...DEFAULT_CONFIG };

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    config = { ...DEFAULT_CONFIG, ...saved };
  } catch (err) {
    if (err.code !== 'ENOENT') log('ERRO lendo config:', err.message);
    config = { ...DEFAULT_CONFIG };
  }
}

function saveConfig(patch) {
  config = { ...config, ...patch };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // guarda a chave da OpenAI, entao ninguem alem do dono le
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600);
}

/** Config sem segredo, do jeito que pode ir pro navegador. */
function publicConfig() {
  const { openaiApiKey, ...rest } = config;
  return { ...rest, hasOpenaiKey: Boolean(openaiApiKey) };
}

let state = 'idle'; // 'idle' | 'recording' | 'stopping'
let stopTimer = null;

/** Clientes SSE conectados, por tipo. */
const clients = new Set();

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

function broadcast(event, data = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

function hasClient(kind) {
  for (const client of clients) if (client.kind === kind) return true;
  return false;
}

function setState(next) {
  state = next;
  broadcast('state', { state });
}

/**
 * Cola o texto no app em foco: enche as areas de transferencia e manda
 * Shift+Insert.
 *
 * Precisa encher as DUAS. Shift+Insert le do clipboard em campos GTK/Qt, mas
 * varios terminais leem da primary selection (o texto que voce marcou com o
 * mouse) — se so o clipboard fosse preenchido, o terminal colaria a ultima
 * coisa selecionada em vez do que foi ditado.
 */
function pasteText(text) {
  // wl-copy daemoniza segurando os pipes herdados; 'ignore' evita travar aqui.
  const targets = [
    spawn('wl-copy', ['--', text], { stdio: 'ignore' }),
    spawn('wl-copy', ['--primary', '--', text], { stdio: 'ignore' }),
  ];

  let pending = targets.length;
  let failed = false;

  for (const proc of targets) {
    proc.on('error', (err) => {
      failed = true;
      log('ERRO wl-copy:', err.message);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        failed = true;
        log(`ERRO wl-copy saiu com codigo ${code}`);
      }
      if (--pending > 0) return;
      if (failed) {
        log('ERRO nao consegui preparar o texto — nao vou colar');
        return;
      }
      setTimeout(() => {
        execFile('ydotool', ['key', ...PASTE_KEYS], (err) => {
          if (err) {
            log('ERRO ydotool key:', err.message);
            log('   (texto continua no clipboard — da pra colar na mao)');
            return;
          }
          log(`colado (${text.length} chars)`);
        });
      }, CLIPBOARD_SETTLE_MS);
    });
  }
}

/**
 * Manda o audio pra OpenAI e devolve o texto.
 *
 * A chave nunca sai daqui: a pagina grava o audio e entrega os bytes, quem
 * fala com a API e o servidor. Assim a chave nao aparece em nada que rode
 * dentro do navegador.
 */
async function transcribeWithOpenAI(audio, mimeType) {
  if (!config.openaiApiKey) throw new Error('nenhuma chave da OpenAI configurada');
  if (audio.length > OPENAI_MAX_BYTES) {
    throw new Error('audio maior que o limite de 25 MB da OpenAI');
  }

  const extension = mimeType.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mimeType }), `audio.${extension}`);
  form.append('model', config.openaiModel);
  // a API espera ISO-639-1 ("pt"), nao a etiqueta completa ("pt-BR")
  form.append('language', config.language.split('-')[0]);

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    body: form,
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    let message = `OpenAI respondeu ${response.status}`;
    try {
      const parsed = JSON.parse(detail);
      if (parsed.error?.message) message += `: ${parsed.error.message}`;
    } catch {
      if (detail) message += `: ${detail.slice(0, 200)}`;
    }
    throw new Error(message);
  }

  const result = await response.json();
  return (result.text || '').trim();
}

function handleTranscribe(req, res) {
  const chunks = [];
  let size = 0;

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > OPENAI_MAX_BYTES) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    clearStopTimer();
    const mimeType = req.headers['content-type'] || 'audio/webm';
    const audio = Buffer.concat(chunks);
    log(`audio recebido (${Math.round(audio.length / 1024)} KB), mandando pra OpenAI`);

    try {
      const text = await transcribeWithOpenAI(audio, mimeType);
      if (text) {
        log(`texto da OpenAI: "${text}"`);
        pasteText(text);
      } else {
        log('OpenAI nao entendeu nada (silencio?)');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chars: text.length }));
    } catch (err) {
      log('ERRO OpenAI:', err.message);
      broadcast('error', { message: err.message });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    } finally {
      setState('idle');
    }
  });
}

function clearStopTimer() {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
}

function handleToggle(res) {
  if (state === 'stopping') {
    log('toggle ignorado (ainda finalizando o anterior)');
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state, ignored: true }));
    return;
  }

  if (state === 'idle') {
    if (!hasClient('page')) {
      log('ERRO toggle sem a pagina do Chrome conectada');
      broadcast('error', { message: 'motor de fala desconectado' });
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'pagina de reconhecimento nao conectada' }));
      return;
    }
    log('>> gravando');
    setState('recording');
    broadcast('start');
  } else {
    log('<< parando');
    // o overlay some assim que ve este evento, antes de qualquer colagem
    setState('stopping');
    broadcast('stop');
    clearStopTimer();
    const limit =
      config.engine === 'openai' ? STOP_TIMEOUT_OPENAI_MS : STOP_TIMEOUT_CHROME_MS;
    stopTimer = setTimeout(() => {
      log('ERRO nada voltou a tempo — destravando');
      broadcast('error', { message: 'a transcricao demorou demais' });
      setState('idle');
    }, limit);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ state }));
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      log('ERRO lendo', filePath, err.message);
      res.writeHead(500);
      res.end('erro lendo ' + path.basename(filePath));
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

/** Le um corpo JSON e entrega o objeto (ou {} se vier quebrado). */
function readJson(req, done) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1e6) req.destroy();
  });
  req.on('end', () => {
    try {
      done(JSON.parse(body));
    } catch (err) {
      log('ERRO body invalido:', err.message);
      done({});
    }
  });
}

function handleType(req, res) {
  readJson(req, (parsed) => {
    clearStopTimer();
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';

    if (text) {
      log(`texto recebido: "${text}"`);
      pasteText(text);
    } else {
      log('nada reconhecido (silencio ou fala nao entendida)');
    }

    setState('idle');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, chars: text.length }));
  });
}

function handleEvents(req, res, url) {
  const kind = url.searchParams.get('client') || 'unknown';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 1000\n\n');
  res.write(`event: state\ndata: ${JSON.stringify({ state })}\n\n`);
  // a pagina precisa saber qual motor usar antes da primeira gravacao
  res.write(`event: config\ndata: ${JSON.stringify(publicConfig())}\n\n`);

  const client = { res, kind };
  clients.add(client);
  log(`+ ${kind} conectado (${clients.size} no total)`);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
    log(`- ${kind} desconectado (${clients.size} restantes)`);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case 'GET /':
      serveFile(res, HTML_PATH, 'text/html; charset=utf-8');
      return;

    case 'GET /events':
      handleEvents(req, res, url);
      return;

    case 'POST /toggle':
      handleToggle(res);
      return;

    case 'POST /type':
      handleType(req, res);
      return;

    // Nivel do microfone, ~10x por segundo enquanto grava. Vai direto pro
    // overlay, que usa isso pra bolinha reagir a voz de verdade. Nao responde
    // corpo nenhum: chega por sendBeacon e ninguem espera resposta.
    case 'POST /level':
      readJson(req, (body) => {
        if (state === 'recording' && typeof body.level === 'number') {
          broadcast('level', { level: body.level });
        }
        res.writeHead(204);
        res.end();
      });
      return;

    // a janela do Chrome fica escondida, entao o diagnostico dela sai por aqui
    case 'POST /log':
      readJson(req, (body) => {
        const level = body.level === 'error' ? 'ERRO' : 'pagina:';
        log(level, body.message || '');
        res.writeHead(204);
        res.end();
      });
      return;

    case 'POST /transcribe':
      handleTranscribe(req, res);
      return;

    case 'GET /config':
      serveFile(res, path.join(__dirname, 'config.html'), 'text/html; charset=utf-8');
      return;

    case 'GET /api/config':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(publicConfig()));
      return;

    case 'POST /api/config':
      readJson(req, (body) => {
        const patch = {};
        if (body.engine === 'chrome' || body.engine === 'openai') patch.engine = body.engine;
        if (typeof body.language === 'string' && body.language) patch.language = body.language;
        if (typeof body.openaiModel === 'string' && body.openaiModel) {
          patch.openaiModel = body.openaiModel;
        }
        // string vazia apaga a chave; ausente mantem a que ja estava
        if (typeof body.openaiApiKey === 'string') patch.openaiApiKey = body.openaiApiKey.trim();

        try {
          saveConfig(patch);
        } catch (err) {
          log('ERRO salvando config:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }

        log(`config salva (motor: ${config.engine}, idioma: ${config.language})`);
        broadcast('config', publicConfig());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(publicConfig()));
      });
      return;

    case 'GET /state':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          state,
          engine: config.engine,
          pageConnected: hasClient('page'),
          overlayConnected: hasClient('overlay'),
        })
      );
      return;

    default:
      res.writeHead(404);
      res.end();
  }
});

loadConfig();

server.listen(PORT, HOST, () => {
  log(`Louro no ar em http://${HOST}:${PORT} (motor: ${config.engine})`);
});
