#!/usr/bin/env bash
set -euo pipefail

BASE="$HOME/.config/swiftbar/iu-vpn"
# shellcheck disable=SC1091
source "$BASE/config.env"

MODE="${1:-chrome}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$(dirname "$LOG_FILE")"

echo "============================================================" | tee -a "$LOG_FILE"
echo "Starting IU VPN at $(date)" | tee -a "$LOG_FILE"
echo "Host: $VPN_HOST" | tee -a "$LOG_FILE"
if [[ -n "${VPN_USER:-}" ]]; then
  echo "User: $VPN_USER" | tee -a "$LOG_FILE"
else
  echo "User: prompt" | tee -a "$LOG_FILE"
fi
echo "Mode: $MODE" | tee -a "$LOG_FILE"
echo "Server certificate pin: $SERVERCERT_PIN" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "Notes:" | tee -a "$LOG_FILE"
echo "- If sudo asks for Password, enter your Mac password." | tee -a "$LOG_FILE"
echo "- Complete IU/Duo authentication in the browser window." | tee -a "$LOG_FILE"
echo "- Leave this Terminal window open while connected." | tee -a "$LOG_FILE"
echo "- Press Ctrl-C here, or use the SwiftBar Disconnect item, to disconnect." | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# A SAML wrapper or sudo prompt alone is not an active VPN tunnel.
if pgrep -x openconnect >/dev/null 2>&1; then
  echo "IU VPN already appears to be running." | tee -a "$LOG_FILE"
  exit 0
fi

if [[ ! -x "$OPENCONNECT_SAML" ]]; then
  echo "ERROR: openconnect-saml not found/executable at: $OPENCONNECT_SAML" | tee -a "$LOG_FILE"
  echo "Try: uv tool install 'openconnect-saml[chrome]'" | tee -a "$LOG_FILE"
  exit 1
fi

cmd=("$OPENCONNECT_SAML" --server "$VPN_HOST")
if [[ -n "${VPN_USER:-}" ]]; then
  cmd+=(--user "$VPN_USER")
fi

case "$MODE" in
  chrome)
    cmd+=(--browser chrome --chrome-channel chrome)
    ;;
  headless|default)
    cmd+=(--browser headless)
    ;;
  qt)
    cmd+=(--browser qt)
    ;;
  *)
    echo "Unknown mode: $MODE" | tee -a "$LOG_FILE"
    exit 2
    ;;
esac

cmd+=(-- --servercert "$SERVERCERT_PIN")

printf 'Running:' | tee -a "$LOG_FILE"
printf ' %q' "${cmd[@]}" | tee -a "$LOG_FILE"
printf '\n\n' | tee -a "$LOG_FILE"

"${cmd[@]}" 2>&1 | tee -a "$LOG_FILE"
