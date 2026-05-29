#!/bin/sh
set -eu

case "${PREFIX:-}" in
  */com.termux/files/usr) ;;
  *) exit 0 ;;
esac

shared="$HOME/storage/shared"
if [ ! -d "$shared" ]; then
  echo "Skipping Pi notification icons: run termux-setup-storage first"
  exit 0
fi

src="$HOME/.pi/agent/extensions/assets"
dest="$shared/Pictures/pi"

if [ ! -f "$src/pi-logo.png" ] || [ ! -f "$src/pi-logo-status.png" ]; then
  echo "Skipping Pi notification icons: source icons are missing in $src" >&2
  exit 0
fi

mkdir -p "$dest"
cp -f "$src/pi-logo.png" "$dest/pi-logo.png"
cp -f "$src/pi-logo-status.png" "$dest/pi-logo-status.png"

chmod 0644 "$dest/pi-logo.png" "$dest/pi-logo-status.png" 2>/dev/null || true

echo "Installed Pi notification icons to $dest"
