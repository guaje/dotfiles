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

if command -v jq >/dev/null 2>&1; then
  if [ -f "$SETTINGS_PATH" ]; then
    jq '
      (input // {}) as $config
      | (.lastChangelogVersion? | if . == null then {} else { lastChangelogVersion: . } end) + $config
    ' "$SETTINGS_PATH" "$CONFIG_PATH" > "$TMP_PATH"
  else
    jq '.' "$CONFIG_PATH" > "$TMP_PATH"
  fi
elif command -v node >/dev/null 2>&1; then
  CONFIG_PATH="$CONFIG_PATH" SETTINGS_PATH="$SETTINGS_PATH" TMP_PATH="$TMP_PATH" node <<'NODE'
const fs = require("node:fs");

const configPath = process.env.CONFIG_PATH;
const settingsPath = process.env.SETTINGS_PATH;
const tmpPath = process.env.TMP_PATH;

if (!configPath || !settingsPath || !tmpPath) {
  throw new Error("Missing merge-settings paths in environment");
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const existing = fs.existsSync(settingsPath)
  ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
  : {};

const merged = {
  ...(existing.lastChangelogVersion == null ? {} : { lastChangelogVersion: existing.lastChangelogVersion }),
  ...config,
};

fs.writeFileSync(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
NODE
else
  echo "merge-settings.sh requires either jq or node on PATH" >&2
  exit 1
fi

mv -- "$TMP_PATH" "$SETTINGS_PATH"
trap - EXIT HUP INT TERM

echo "Wrote ${SETTINGS_PATH#$AGENT_DIR/}"
