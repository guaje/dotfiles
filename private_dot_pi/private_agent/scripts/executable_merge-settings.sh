#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AGENT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CONFIG_PATH="$AGENT_DIR/settings.config.json"
SETTINGS_PATH="$AGENT_DIR/settings.json"
TMP_PATH="$SETTINGS_PATH.tmp.$$"

cleanup() {
  rm -f -- "$TMP_PATH"
}
trap cleanup EXIT HUP INT TERM

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Missing config file: $CONFIG_PATH" >&2
  exit 1
fi

if [ -f "$SETTINGS_PATH" ]; then
  jq '
    (input // {}) as $config
    | (.lastChangelogVersion? | if . == null then {} else { lastChangelogVersion: . } end) + $config
  ' "$SETTINGS_PATH" "$CONFIG_PATH" > "$TMP_PATH"
else
  jq '.' "$CONFIG_PATH" > "$TMP_PATH"
fi

mv -- "$TMP_PATH" "$SETTINGS_PATH"
trap - EXIT HUP INT TERM

echo "Wrote ${SETTINGS_PATH#$AGENT_DIR/}"
