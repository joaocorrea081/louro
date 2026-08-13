# Louro

**Ditado por voz de graça no Linux.** Aperta o atalho, fala à vontade, o texto
cai onde o cursor estiver — terminal, navegador, editor, campo de formulário.

Louro é o papagaio: você fala, ele repete.

```
Ctrl+Space  ->  ● bolinha verde aparece, pode falar
Ctrl+Space  ->  a bolinha some e o texto aparece onde você estava
```

## Por que isso existe

Ditado por voz bom, hoje, cobra por minuto ou pesa na máquina.

As opções que existem caem em dois grupos. Umas mandam o áudio pra uma API paga
(OpenAI, Google Cloud, Deepgram): funcionam bem, mas você fica olhando o
contador enquanto fala, e falar é justamente o que você quer fazer à vontade.
Outras rodam o modelo na sua máquina (Whisper, Vosk): não custam nada por uso,
mas exigem baixar modelo de gigabytes e uma máquina com fôlego — em computador
modesto, ou demora, ou erra.

Eu queria as duas coisas: **não gastar nada e poder falar sem cronômetro**.

A saída estava aberta na tela o tempo todo — o **navegador**. O reconhecimento de
voz do Chrome (o mesmo que roda no ditado do Google Docs) é gratuito, ilimitado,
e entende português muito bem. Ele já está instalado, já funciona, e ninguém
estava usando isso fora de uma aba de navegador.

O Louro é a ponte: o Chrome vira um motor de fala rodando escondido, e o texto
que ele reconhece é entregue no aplicativo que você estiver usando. Sem chave de
API, sem mensalidade, sem modelo pra baixar, sem placa de vídeo.

## A troca (leia antes de instalar)

**Seu áudio vai pros servidores do Google.** É assim que o reconhecimento do
Chrome funciona — o mesmo que acontece quando você usa o ditado do Google Docs.

Se você precisa de ditado que não sai da sua máquina, o Louro **não** é pra
você: use [nerd-dictation](https://github.com/ideasman42/nerd-dictation) (Vosk)
ou [Whispering](https://github.com/epicenter-md/epicenter) (Whisper local). São
bons e resolvem esse caso.

O Louro é pra quem quer ditar de graça, sem limite de tempo, em máquina
qualquer, e não se incomoda com isso.

## Dois motores, você escolhe

| | Chrome (padrão) | OpenAI |
|---|---|---|
| Custo | nada | a partir de US$ 0,003 por minuto, direto com eles |
| Chave | não precisa | a sua |
| Pontuação e maiúsculas | não põe | põe sozinho |
| Acerta jargão em inglês | erra às vezes | bem melhor |
| Áudio vai para | Google | OpenAI |

A mesma frase, ditada nos dois:

```
Chrome   o pássaro voa até a montanha com emoção e gratidão
OpenAI   O pássaro voou até a montanha com emoção e gratidão.
```

A pontuação costuma pesar mais que a precisão no dia a dia: com o Chrome você
dita e depois volta pra pôr as vírgulas e os pontos.

Modelos disponíveis no painel, do mais recomendado ao mais antigo:

| Modelo | Custo/min | Observação |
|---|---|---|
| `gpt-transcribe` | US$ 0,0045 | o mais novo (jul/2026) e o padrão daqui |
| `gpt-4o-mini-transcribe` | US$ 0,003 | o mais barato |
| `gpt-4o-transcribe` | US$ 0,006 | geração anterior |
| `whisper-1` | US$ 0,006 | o antigo, erra bem mais |

Abra a configuração com `louro config`: dá pra trocar o motor, colar a chave da
OpenAI e escolher o idioma. **A chave fica só na sua máquina**, num arquivo que
só você lê (`~/.config/louro/config.json`, permissão 600) — quem conversa com a
OpenAI é o serviço local, então ela nunca é entregue ao navegador.

Ditar uma hora inteira no modelo mais caro sai por volta de US$ 0,36. Para uso
normal, some no fim do mês.

## Instalação

Precisa de **KDE Plasma 6 no Wayland** e do **Google Chrome** (o Chromium não
serve: ele não traz a chave do serviço de fala do Google).

```bash
git clone https://github.com/joaocorrea081/louro.git
cd louro
./install.sh
```

O instalador confere as dependências e diz o que falta antes de mexer em
qualquer coisa. Não pede sudo — instala tudo no seu usuário.

Pra usar outro atalho:

```bash
./install.sh --atalho "Meta+V"
```

Desinstalar:

```bash
./uninstall.sh
```

### Dependências

| Distro | Comando |
|---|---|
| Arch/Manjaro | `sudo pacman -S nodejs python-gobject python-cairo gtk-layer-shell ydotool wl-clipboard curl` |
| Debian/Ubuntu | `sudo apt install nodejs python3-gi python3-cairo gir1.2-gtklayershell-0.1 ydotool wl-clipboard curl` |
| Fedora | `sudo dnf install nodejs python3-gobject python3-cairo gtk-layer-shell ydotool wl-clipboard curl` |

O `ydotool` precisa do módulo `uinput` e do daemon ligado:

```bash
sudo modprobe uinput
echo uinput | sudo tee /etc/modules-load.d/uinput.conf   # pros próximos boots
systemctl --user enable --now ydotool
```

## Uso

Depois de instalado, sobe sozinho no login. Não tem interface pra abrir: é o
atalho e a bolinha.

```bash
louro config     # abre a configuração no navegador
louro status     # as três peças estão de pé?
louro logs       # o que foi ouvido e colado
louro restart
louro disable    # parar de subir no login
```

**Trocar o atalho depois de instalado**: Configurações do Sistema → Atalhos →
Atalhos Personalizados → "Louro". Ou rode o `install.sh --atalho` de novo.

## Como funciona

Três peças pequenas:

| Peça | Arquivo | O que faz |
|---|---|---|
| ponte | `bridge.js` | servidor local (porta 8765): coordena o ciclo e cola o texto |
| motor | Chrome | reconhece a fala numa janela escondida; a página é `engine.html` |
| bolinha | `overlay.py` | o indicador visual enquanto você fala |
| painel | `config.html` | a configuração, servida pela própria ponte |

No modo OpenAI o Chrome deixa de reconhecer e passa só a gravar: a página
manda os bytes do áudio para a ponte, que faz o upload para a API. É por isso
que a chave nunca precisa existir dentro do navegador.

```
Ctrl+Space -> POST /toggle -> SSE "start" -> Chrome ouve + bolinha aparece
Ctrl+Space -> POST /toggle -> SSE "stop"  -> bolinha some na hora
           -> Chrome devolve o texto em POST /type -> ponte cola no app em foco
```

### Decisões que não são óbvias

**Por que o texto vai pelo clipboard e não é digitado?**
`ydotool type` ignora todo caractere fora do ASCII — "Ação, coração" chegava
como "Ao, corao". E `wtype`, que resolveria, não funciona aqui: o KWin expõe só
`zwp_input_method_v1`, não o `zwp_virtual_keyboard_manager_v1` que o wtype
exige. Sobrou clipboard + `Shift+Insert`, que preserva os acentos e funciona em
GTK, Qt e terminais.

O texto é escrito nas **duas** áreas de transferência — clipboard e *primary
selection* (o que você marca com o mouse). Campos GTK/Qt leem o Shift+Insert do
clipboard, mas vários terminais leem da primary; preenchendo só uma, o terminal
colava a última coisa selecionada em vez da fala.

Efeito colateral aceito: **o texto ditado sobrescreve as duas áreas**. Também
serve de rede de segurança — se a colagem falhar, é só colar na mão.

**Por que a bolinha é GTK e não uma janela do Chrome?**
Ela usa `gtk-layer-shell` na camada OVERLAY com `KeyboardMode.NONE`: fica acima
de tudo e **nunca aceita foco de teclado**. Por isso o aplicativo onde você está
não perde o foco em momento nenhum, e o texto cai no lugar certo. Uma janela do
Chrome roubaria o foco.

**Por que o Chrome nasce escondido?**
Regra do KWin `louro-engine-hidden`, casando com `wmclass=chrome-127.0.0.1` — só
a janela do Louro, não o seu Chrome pessoal. As flags
`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` e
`--disable-background-timer-throttling` impedem o Chrome de suspender a página
por estar minimizada; sem elas o reconhecimento morre em segundo plano.

**A bolinha reage à sua voz**: o halo cresce conforme o volume que está entrando
no microfone. Isso não é enfeite — é como você descobre que o microfone está
mudo ou no dispositivo errado. Bolinha parada enquanto você fala significa que
nada está sendo captado; se ela ficar vermelha, o áudio parou de chegar.

**Ditados longos**: o Chrome encerra a sessão de reconhecimento sozinho depois de
um tanto de silêncio. A página reabre e continua acumulando no mesmo texto, então
falar com pausas não corta a frase.

**Permissão de microfone**: gravada uma vez no perfil dedicado
(`~/.local/share/louro-chrome`), liberada só pra `http://127.0.0.1:8765`.

## Quando dá problema

```bash
louro status    # alguma peça caiu?
louro logs      # o log mostra erro de reconhecimento?
```

| Sintoma | Causa provável |
|---|---|
| "nenhum microfone disponivel" | o Chrome recusa *monitor* de sink como microfone; veja `pactl get-default-source` |
| transcreve mas não cola | `systemctl --user status ydotool` e `lsmod \| grep uinput` |
| cola o texto errado | outra coisa reescreveu o clipboard entre falar e colar |
| a janela do Chrome apareceu | `busctl --user call org.kde.KWin /KWin org.kde.KWin reconfigure` |
| nada acontece no atalho | outro programa pode ter tomado a tecla; troque nas Configurações do Sistema |

Pra depurar o motor, abra `http://127.0.0.1:8765` no seu Chrome normal — a
página mostra o estado e o último texto ouvido.

## Limites conhecidos

- **Só KDE Plasma 6 no Wayland.** GNOME, XFCE e X11 precisariam de outro jeito
  de fazer a bolinha e o atalho global.
- **Só Chrome oficial.** O Chromium não tem a chave do serviço de fala.
- **Depende de uma API que não é contrato público.** Se o Google mudar o
  reconhecimento do Chrome, quebra — e não há o que fazer do lado de cá.
- **Erra jargão técnico em inglês** no meio do português ("login" vira
  "alguém"). A Web Speech API não aceita dicionário nem contexto.

## Licença

MIT — veja [LICENSE](LICENSE).
