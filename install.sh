#!/usr/bin/env bash
# Louro — instalador.
#
# Instala no lugar onde você clonou (não copia nada pra /opt ou /usr), então
# pra atualizar basta um `git pull`. Nada aqui pede sudo: tudo vai pro seu
# próprio usuário.
#
#   ./install.sh                      atalho padrão (Ctrl+Space)
#   ./install.sh --atalho "Meta+V"    outro atalho

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${LOURO_PORT:-8765}"
PROFILE="$HOME/.local/share/louro-chrome"
SHORTCUT="Ctrl+Space"
KWIN_RULE="louro-engine-hidden"
DESKTOP_FILE="louro-toggle.desktop"

while [ $# -gt 0 ]; do
  case "$1" in
    --atalho) SHORTCUT="${2:-Ctrl+Space}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "opção desconhecida: $1" >&2; exit 1 ;;
  esac
done

falhou=0
aviso() { printf '  \033[33m!\033[0m %s\n' "$*"; }
erro()  { printf '  \033[31mx\033[0m %s\n' "$*"; falhou=1; }
ok()    { printf '  \033[32mv\033[0m %s\n' "$*"; }

echo
echo "Louro — ditado por voz"
echo "======================"
echo
echo "1. Conferindo o sistema"

# --- ambiente gráfico ---------------------------------------------------
if [ "${XDG_SESSION_TYPE:-}" != "wayland" ]; then
  erro "Isto só funciona no Wayland (você está em '${XDG_SESSION_TYPE:-desconhecido}')."
else
  ok "Wayland"
fi

if ! command -v kwriteconfig6 >/dev/null 2>&1; then
  erro "Não achei o KDE Plasma 6 (kwriteconfig6). O Louro depende do KWin e do
      gtk-layer-shell pra bolinha não roubar o foco. Em GNOME e XFCE não roda."
else
  ok "KDE Plasma 6"
fi

# --- programas ----------------------------------------------------------
CHROME=""
for c in google-chrome-stable google-chrome chrome; do
  command -v "$c" >/dev/null 2>&1 && { CHROME="$c"; break; }
done
if [ -z "$CHROME" ]; then
  erro "Google Chrome não encontrado. Precisa ser o Chrome oficial: o Chromium
      não traz a chave do serviço de fala do Google e não funciona aqui."
else
  ok "Chrome ($CHROME)"
fi

for prog in node curl ydotool wl-copy python3; do
  command -v "$prog" >/dev/null 2>&1 && ok "$prog" || erro "$prog não encontrado"
done

# --- bibliotecas do python ----------------------------------------------
if python3 -c "import gi, cairo; gi.require_version('Gtk','3.0')" >/dev/null 2>&1; then
  ok "python-gobject + cairo"
else
  erro "Faltam os bindings do GTK pro Python (python-gobject e pycairo)"
fi

if python3 -c "import gi; gi.require_version('GtkLayerShell','0.1')" >/dev/null 2>&1; then
  ok "gtk-layer-shell"
else
  erro "gtk-layer-shell não encontrado. É ele que deixa a bolinha por cima de
      tudo sem tirar o foco do que você está usando"
fi

# --- digitacao virtual ---------------------------------------------------
if lsmod 2>/dev/null | grep -q '^uinput'; then
  ok "módulo uinput carregado"
else
  aviso "módulo uinput não está carregado. Sem ele o texto não é colado.
      Resolva com:  sudo modprobe uinput
                    echo uinput | sudo tee /etc/modules-load.d/uinput.conf"
fi

if systemctl --user is-active ydotool >/dev/null 2>&1; then
  ok "ydotoold rodando"
else
  aviso "ydotoold não está rodando. Resolva com:
        systemctl --user enable --now ydotool"
fi

if [ "$falhou" -eq 1 ]; then
  cat <<EOF

Faltou coisa. Como instalar as dependências:

  Arch/Manjaro   sudo pacman -S nodejs python-gobject python-cairo \\
                   gtk-layer-shell ydotool wl-clipboard curl
  Debian/Ubuntu  sudo apt install nodejs python3-gi python3-cairo \\
                   gir1.2-gtklayershell-0.1 ydotool wl-clipboard curl
  Fedora         sudo dnf install nodejs python3-gobject python3-cairo \\
                   gtk-layer-shell ydotool wl-clipboard curl

O Chrome vem de https://google.com/chrome (não serve o Chromium).
EOF
  exit 1
fi

# --- permissão de microfone ---------------------------------------------
echo
echo "2. Preparando o motor de fala"

mkdir -p "$PROFILE/Default"
PREFS="$PROFILE/Default/Preferences"
[ -f "$PREFS" ] || echo '{}' > "$PREFS"

# base::Time do Chrome: microssegundos desde 1601-01-01
STAMP=$(( ($(date +%s) + 11644473600) * 1000000 ))
python3 - "$PREFS" "$STAMP" "$PORT" <<'PY'
import json, sys
path, stamp, port = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path) as f:
        prefs = json.load(f)
except (json.JSONDecodeError, FileNotFoundError):
    prefs = {}

exc = prefs.setdefault("profile", {}).setdefault("content_settings", {}).setdefault("exceptions", {})
exc.setdefault("media_stream_mic", {})[f"http://127.0.0.1:{port},*"] = {
    "last_modified": stamp,
    "setting": 1,   # 1 = permitir
}
with open(path, "w") as f:
    json.dump(prefs, f, separators=(",", ":"))
PY
ok "microfone liberado só pra http://127.0.0.1:$PORT no perfil dedicado"

# --- serviços ------------------------------------------------------------
echo
echo "3. Instalando os serviços"

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

cat > "$UNIT_DIR/louro-bridge.service" <<EOF
[Unit]
Description=Louro — ponte do ditado por voz
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Type=simple
Environment=LOURO_PORT=$PORT
ExecStart=$(command -v node) $DIR/bridge.js
Restart=always
RestartSec=2

[Install]
WantedBy=graphical-session.target
EOF

cat > "$UNIT_DIR/louro-engine.service" <<EOF
[Unit]
Description=Louro — motor de reconhecimento (Chrome escondido)
PartOf=graphical-session.target
After=louro-bridge.service
Requires=louro-bridge.service

[Service]
Type=simple
# A janela nasce escondida pela regra do KWin "$KWIN_RULE". As flags
# --disable-*background* impedem o Chrome de suspender a página por ela estar
# minimizada — sem isso o reconhecimento morre em segundo plano.
ExecStart=$(command -v "$CHROME") \\
  --user-data-dir=$PROFILE \\
  --app=http://127.0.0.1:$PORT \\
  --window-size=360,150 \\
  --no-first-run \\
  --no-default-browser-check \\
  --disable-features=Translate,MediaRouter \\
  --disable-background-timer-throttling \\
  --disable-backgrounding-occluded-windows \\
  --disable-renderer-backgrounding
Restart=always
RestartSec=3

[Install]
WantedBy=graphical-session.target
EOF

cat > "$UNIT_DIR/louro-overlay.service" <<EOF
[Unit]
Description=Louro — bolinha de gravacao
PartOf=graphical-session.target
After=louro-bridge.service
Requires=louro-bridge.service

[Service]
Type=simple
Environment=LOURO_PORT=$PORT
ExecStart=$(command -v python3) $DIR/overlay.py
Restart=always
RestartSec=2

[Install]
WantedBy=graphical-session.target
EOF

systemctl --user daemon-reload
ok "três serviços instalados"

# --- regra que esconde a janela do Chrome --------------------------------
echo
echo "4. Escondendo a janela do motor"

kwrule() { kwriteconfig6 --file kwinrulesrc --group "$KWIN_RULE" --key "$1" "$2"; }
kwrule Description "Louro: janela do motor de fala sempre escondida"
kwrule wmclass "chrome-127.0.0.1"
kwrule wmclasscomplete false
kwrule wmclassmatch 2     # 2 = casa por pedaco do nome
kwrule types 1
kwrule minimize true
kwrule minimizerule 3     # 3 = aplica ao abrir
for prop in skiptaskbar skippager skipswitcher; do
  kwrule "$prop" true
  kwrule "${prop}rule" 2  # 2 = forca sempre
done

# entra na lista sem apagar regras que você já tinha
EXISTING=$(kreadconfig6 --file kwinrulesrc --group General --key rules 2>/dev/null)
case ",$EXISTING," in
  *",$KWIN_RULE,"*) NEW="$EXISTING" ;;
  *) NEW="${EXISTING:+$EXISTING,}$KWIN_RULE" ;;
esac
kwriteconfig6 --file kwinrulesrc --group General --key rules "$NEW"
kwriteconfig6 --file kwinrulesrc --group General --key count "$(echo "$NEW" | tr ',' '\n' | grep -c .)"
busctl --user call org.kde.KWin /KWin org.kde.KWin reconfigure >/dev/null 2>&1
ok "regra do KWin aplicada (suas outras regras foram preservadas)"

# --- atalho global --------------------------------------------------------
echo
echo "5. Configurando o atalho"

mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Louro — ligar/desligar ditado
Exec=curl -s -m 3 -X POST http://127.0.0.1:$PORT/toggle
NoDisplay=true
StartupNotify=false
EOF

kwriteconfig6 --file kglobalshortcutsrc \
  --group services --group "$DESKTOP_FILE" --key _launch "$SHORTCUT"

# Gravar no arquivo só valeria depois de deslogar, então registramos ao vivo.
# No Plasma 6 Wayland o kglobalaccel roda dentro do kwin_wayland — reiniciar o
# serviço plasma-kglobalaccel não adianta, ele esta morto de proposito.
busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel \
  doRegister as 4 "$DESKTOP_FILE" "_launch" "Louro" "Ligar/desligar ditado" \
  >/dev/null 2>&1

# doRegister cria o componente mas não amarra a tecla; isso e o setShortcut,
# que cobra o atalho como inteiro no formato do Qt (modificadores | tecla).
KEYCODE=$(python3 - "$SHORTCUT" <<'PY'
import sys

MODS = {
    "shift": 0x02000000, "ctrl": 0x04000000, "control": 0x04000000,
    "alt": 0x08000000, "meta": 0x10000000, "super": 0x10000000, "win": 0x10000000,
}
KEYS = {
    "space": 0x20, "tab": 0x01000001, "return": 0x01000004, "enter": 0x01000004,
    "esc": 0x01000000, "escape": 0x01000000, "backspace": 0x01000003,
    "insert": 0x01000006, "delete": 0x01000007, "del": 0x01000007,
    "home": 0x01000010, "end": 0x01000011,
    "pageup": 0x01000016, "pagedown": 0x01000017,
    "left": 0x01000012, "up": 0x01000013, "right": 0x01000014, "down": 0x01000015,
    "print": 0x01000009, "pause": 0x01000008, "menu": 0x01000055,
}
for n in range(1, 13):
    KEYS[f"f{n}"] = 0x01000030 + (n - 1)

parts = [p.strip().lower() for p in sys.argv[1].split("+") if p.strip()]
total = 0
for part in parts[:-1]:
    if part not in MODS:
        sys.exit(1)
    total |= MODS[part]

key = parts[-1]
if key in KEYS:
    total |= KEYS[key]
elif len(key) == 1 and key.isalnum():
    total |= ord(key.upper())
else:
    sys.exit(1)

print(total)
PY
) || KEYCODE=""

if [ -n "$KEYCODE" ]; then
  # flag 2 = SetPresent (aplica agora)
  busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel \
    setShortcut asaiu 4 "$DESKTOP_FILE" "_launch" "Louro" "Ligar/desligar ditado" \
    1 "$KEYCODE" 2 >/dev/null 2>&1
  ok "atalho $SHORTCUT registrado e valendo agora"
else
  aviso "não entendi o atalho '$SHORTCUT' pra ativar na hora; ele foi gravado e
      passa a valer no próximo login (ou defina em Configurações > Atalhos)"
fi

# --- subir ----------------------------------------------------------------
echo
echo "6. Ligando"

systemctl --user enable louro-bridge louro-engine louro-overlay >/dev/null 2>&1
systemctl --user restart louro-bridge louro-engine louro-overlay
sleep 5

if curl -sf -m 3 "http://127.0.0.1:$PORT/state" | grep -q '"pageConnected":true'; then
  ok "motor de fala conectado"
else
  aviso "o motor ainda não respondeu; veja com: $DIR/louro status"
fi

cat <<EOF

Pronto.

  Aperte $SHORTCUT, fale, aperte $SHORTCUT de novo.
  O texto cai onde o cursor estiver.

  $DIR/louro status     ver se está tudo de pé
  $DIR/louro logs       ver o que foi ouvido

Coloque no PATH pra chamar de qualquer lugar:
  ln -s $DIR/louro ~/.local/bin/louro

EOF
