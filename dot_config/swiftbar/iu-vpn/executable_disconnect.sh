#!/usr/bin/env bash
set -euo pipefail

BASE="$HOME/.config/swiftbar/iu-vpn"
# shellcheck disable=SC1091
source "$BASE/config.env"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

echo "Disconnecting IU VPN at $(date)..."

# openconnect is commonly running as root under sudo, so sudo may ask for your Mac password.
sudo pkill -INT -f "openconnect.*${VPN_HOST}" 2>/dev/null || true
pkill -INT -f "openconnect-saml.*${VPN_HOST}" 2>/dev/null || true

sleep 2

# Fallback if SIGINT did not stop it.
sudo pkill -TERM -f "openconnect.*${VPN_HOST}" 2>/dev/null || true
pkill -TERM -f "openconnect-saml.*${VPN_HOST}" 2>/dev/null || true

echo "Done. You can close this Terminal window."
