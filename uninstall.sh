#!/usr/bin/env bash
# Louro — desinstalador. Tira tudo que o install.sh colocou.
#
#   ./uninstall.sh          mantem o perfil do Chrome (permissão de microfone)
#   ./uninstall.sh --tudo   apaga o perfil também

set -uo pipefail

PROFILE="$HOME/.local/share/louro-chrome"
KWIN_RULE="louro-engine-hidden"
DESKTOP_FILE="louro-toggle.desktop"
APAGAR_PERFIL=0

[ "${1:-}" = "--tudo" ] && APAGAR_PERFIL=1

echo "Desinstalando o Louro..."

systemctl --user disable --now louro-bridge louro-engine louro-overlay >/dev/null 2>&1
rm -f "$HOME/.config/systemd/user"/louro-{bridge,engine,overlay}.service
systemctl --user daemon-reload
echo "  serviços removidos"

rm -f "$HOME/.local/share/applications/$DESKTOP_FILE"
kwriteconfig6 --file kglobalshortcutsrc \
  --group services --group "$DESKTOP_FILE" --key _launch --delete 2>/dev/null
echo "  atalho removido"

# tira o Louro da lista sem encostar nas outras regras do KWin
EXISTING=$(kreadconfig6 --file kwinrulesrc --group General --key rules 2>/dev/null)
REST=$(echo "$EXISTING" | tr ',' '\n' | grep -v "^$KWIN_RULE$" | paste -sd,)
kwriteconfig6 --file kwinrulesrc --group General --key rules "$REST"
kwriteconfig6 --file kwinrulesrc --group General --key count \
  "$(echo "$REST" | tr ',' '\n' | grep -c .)"
kwriteconfig6 --file kwinrulesrc --group "$KWIN_RULE" --key Description --delete 2>/dev/null
busctl --user call org.kde.KWin /KWin org.kde.KWin reconfigure >/dev/null 2>&1
echo "  regra do KWin removida (as suas foram preservadas)"

if [ "$APAGAR_PERFIL" -eq 1 ]; then
  rm -rf "$PROFILE"
  echo "  perfil do Chrome apagado"
else
  echo "  perfil do Chrome mantido em $PROFILE (use --tudo pra apagar)"
fi

echo
echo "Pronto. Os arquivos do projeto continuam onde estão. Apague a pasta se quiser."
