#!/usr/bin/env bash
# 0xgarou LP bot: sekali klik untuk menjalankan bot.
# Dipakai juga oleh shortcut Desktop (start.sh).
set -u

DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
cd "$DIR" || exit 1

pause() { [ -t 0 ] && read -r -p "Tekan Enter untuk menutup jendela... " _; }
fail() { echo; echo "✖ $1"; pause; exit 1; }

# Satu bot per token: dua salinan akan berebut update Telegram.
exec 9>.bot.lock
if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
  echo "✖ Bot sudah berjalan di jendela lain."
  echo "  Log:   $DIR/bot.log"
  echo "  Stop:  pkill -f 'tsx src/index.ts'"
  pause
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js tidak ada. Pasang dulu: sudo apt install nodejs"
fi

if [ ! -d node_modules ] || [ package.json -nt node_modules/.installed ]; then
  echo "▶ Memasang/menyegarkan paket..."
  npm install --no-audit --no-fund || fail "Gagal memasang paket. Cek koneksi internet."
  touch node_modules/.installed
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "⚠ File .env baru dibuat dari contoh."
  echo "  Isi PRIVATE_KEY dan TELEGRAM_BOT_TOKEN, simpan, lalu klik shortcut lagi."
  (xdg-open .env >/dev/null 2>&1 9>&- &) 2>/dev/null || true
  pause
  exit 1
fi

echo "🚀 Menjalankan 0xgarou LP Bot... (Ctrl+C untuk berhenti)"
npm start
code=$?
echo
if [ $code -eq 0 ]; then echo "👋 Bot dihentikan."; else echo "✖ Bot berhenti dengan kode $code. Lihat pesan di atas."; fi
pause
exit $code
