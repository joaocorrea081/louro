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

// se a pagina nao devolver texto nesse prazo apos o stop, destrava o estado
const STOP_TIMEOUT_MS = 8000;

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
    stopTimer = setTimeout(() => {
      log('ERRO pagina nao devolveu texto a tempo — destravando');
      setState('idle');
    }, STOP_TIMEOUT_MS);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ state }));
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
      fs.readFile(HTML_PATH, (err, data) => {
        if (err) {
          res.writeHead(500);
          res.end('erro lendo dictation.html');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
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

    // a janela do Chrome fica escondida, entao o diagnostico dela sai por aqui
    case 'POST /log':
      readJson(req, (body) => {
        const level = body.level === 'error' ? 'ERRO' : 'pagina:';
        log(level, body.message || '');
        res.writeHead(204);
        res.end();
      });
      return;

    case 'GET /state':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          state,
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

server.listen(PORT, HOST, () => {
  log(`ponte de ditado no ar em http://${HOST}:${PORT}`);
});
