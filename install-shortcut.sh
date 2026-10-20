#!/usr/bin/env bash
# Membuat ikon "0xgarou LP Bot" di folder proyek, di Desktop dan di menu aplikasi (Linux).
#   ./install-shortcut.sh           -> pasang
#   ./install-shortcut.sh --remove  -> hapus
set -e
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
NAME="0xgarou-lp-bot.desktop"
DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"

if [ "${1:-}" = "--remove" ]; then
  rm -f "$APPS/$NAME" "$DESK/$NAME" "$DIR/$NAME"
  update-desktop-database "$APPS" 2>/dev/null || true
  echo "✔ Shortcut dihapus."
  exit 0
fi

chmod +x "$DIR/start.sh"
mkdir -p "$APPS"
cat > "$APPS/$NAME" <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=0xgarou LP Bot
Comment=Bot Telegram pemantau posisi LP di Robinhood Chain
Exec="$DIR/start.sh"
Path=$DIR
Icon=$DIR/assets/icon.svg
Terminal=true
Categories=Utility;Finance;
StartupNotify=false
DESKTOP
chmod +x "$APPS/$NAME"

# Folder proyek: ikon di samping start.sh.
cp "$APPS/$NAME" "$DIR/$NAME"
chmod +x "$DIR/$NAME"

if [ -d "$DESK" ]; then
  cp "$APPS/$NAME" "$DESK/$NAME"
  chmod +x "$DESK/$NAME"
  # GNOME: tandai tepercaya supaya bisa diklik dua kali
  command -v gio >/dev/null 2>&1 && gio set "$DESK/$NAME" metadata::trusted true 2>/dev/null || true
fi
update-desktop-database "$APPS" 2>/dev/null || true

echo "✔ Shortcut dibuat:"
echo "   • Folder proyek: $DIR/$NAME"
[ -d "$DESK" ] && echo "   • Desktop:       $DESK/$NAME"
echo "   • Menu aplikasi: cari \"0xgarou LP Bot\""
echo "Jika ikon di Desktop belum bisa diklik: klik kanan → \"Allow Launching\" / \"Izinkan Meluncurkan\"."
