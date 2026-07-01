#!/usr/bin/env bash
set -euo pipefail

BASE="$HOME/.config/swiftbar/iu-vpn"

osascript <<OSA
 tell application "Terminal"
   activate
   do script "cd '$BASE' && './disconnect.sh'"
 end tell
OSA
