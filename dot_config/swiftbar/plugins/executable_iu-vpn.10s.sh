#!/usr/bin/env bash

BASE="$HOME/.config/swiftbar/iu-vpn"
CONFIG="$BASE/config.env"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# shellcheck disable=SC1090
[[ -f "$CONFIG" ]] && source "$CONFIG"
VPN_HOST="${VPN_HOST:-vpn.uits.iu.edu}"
LOG_FILE="${LOG_FILE:-$BASE/iu-vpn.log}"

connected=false
if pgrep -f "openconnect.*${VPN_HOST}" >/dev/null 2>&1 || pgrep -f "openconnect-saml.*${VPN_HOST}" >/dev/null 2>&1; then
  connected=true
fi

if [[ "$connected" == true ]]; then
  echo "IU | sfimage=lock.shield"
else
  echo "IU | sfimage=lock.open"
fi

echo "---"
echo "IU VPN ($VPN_HOST)"
echo "---"
if [[ "$connected" == true ]]; then
  echo "Disconnect | bash=$BASE/disconnect-terminal.sh terminal=false refresh=true"
else
  echo "Connect — Chrome/Duo | bash=$BASE/connect-terminal.sh param1=chrome terminal=false refresh=true"
  echo "Connect — manual/default browser | bash=$BASE/connect-terminal.sh param1=headless terminal=false refresh=true"
fi
echo "Refresh | refresh=true"
echo "---"
echo "Open log | bash=/usr/bin/open param1=$LOG_FILE terminal=false"
echo "Open config | bash=/usr/bin/open param1=$CONFIG terminal=false"
echo "Open scripts folder | bash=/usr/bin/open param1=$BASE terminal=false"
echo "---"
echo "Server cert pin: ${SERVERCERT_PIN:-not set} | size=11"
