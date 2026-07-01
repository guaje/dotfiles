#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-chrome}"
BASE="$HOME/.config/swiftbar/iu-vpn"

case "$MODE" in
  chrome|headless|default|qt) ;;
  *) MODE="chrome" ;;
esac

osascript <<OSA
 tell application "Terminal"
   activate
   do script "cd '$BASE' && './connect.sh' '$MODE'"
 end tell
OSA
