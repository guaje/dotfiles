#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
SOURCE_SCRIPT="$ROOT_DIR/agent/scripts/merge-settings.sh"

fail() {
  echo "not ok - $1" >&2
  exit 1
}

pass() {
  echo "ok - $1"
}

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pi-merge-settings-test.XXXXXX")
cleanup() {
  rm -rf -- "$TMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

FIXTURE_AGENT="$TMP_ROOT/agent"
FIXTURE_SCRIPTS="$FIXTURE_AGENT/scripts"
mkdir -p "$FIXTURE_SCRIPTS"
cp "$SOURCE_SCRIPT" "$FIXTURE_SCRIPTS/merge-settings.sh"
chmod +x "$FIXTURE_SCRIPTS/merge-settings.sh"

# preserves lastChangelogVersion and replaces the rest
cat > "$FIXTURE_AGENT/settings.config.json" <<'JSON'
{
  "defaultProvider": "openai-codex",
  "theme": "catppuccin-mocha",
  "enabledModels": ["openai-codex/gpt-5.4"]
}
JSON
cat > "$FIXTURE_AGENT/settings.json" <<'JSON'
{
  "lastChangelogVersion": "0.67.68",
  "defaultProvider": "old-provider",
  "extra": true
}
JSON
OUTPUT=$(cd "$TMP_ROOT" && "$FIXTURE_SCRIPTS/merge-settings.sh") || fail "merge-settings.sh should succeed with existing settings.json"
[ "$OUTPUT" = "Wrote settings.json" ] || fail "merge-settings.sh should print the output path"
LAST_CHANGELOG=$(jq -r '.lastChangelogVersion' "$FIXTURE_AGENT/settings.json")
DEFAULT_PROVIDER=$(jq -r '.defaultProvider' "$FIXTURE_AGENT/settings.json")
THEME=$(jq -r '.theme' "$FIXTURE_AGENT/settings.json")
ENABLED_MODEL=$(jq -r '.enabledModels[0]' "$FIXTURE_AGENT/settings.json")
HAS_EXTRA=$(jq 'has("extra")' "$FIXTURE_AGENT/settings.json")
[ "$LAST_CHANGELOG" = "0.67.68" ] || fail "should preserve lastChangelogVersion"
[ "$DEFAULT_PROVIDER" = "openai-codex" ] || fail "should replace defaultProvider from config"
[ "$THEME" = "catppuccin-mocha" ] || fail "should merge theme from config"
[ "$ENABLED_MODEL" = "openai-codex/gpt-5.4" ] || fail "should merge enabledModels from config"
[ "$HAS_EXTRA" = "false" ] || fail "should drop keys not present in settings.config.json"
pass "merge-settings.sh preserves lastChangelogVersion and rewrites the rest"

# writes settings.json when missing
rm -f "$FIXTURE_AGENT/settings.json"
cat > "$FIXTURE_AGENT/settings.config.json" <<'JSON'
{
  "theme": "catppuccin-mocha",
  "extensions": ["-extensions/google-search.ts"]
}
JSON
cd "$TMP_ROOT" && "$FIXTURE_SCRIPTS/merge-settings.sh" >/dev/null
[ -f "$FIXTURE_AGENT/settings.json" ] || fail "should create settings.json when missing"
CREATED_THEME=$(jq -r '.theme' "$FIXTURE_AGENT/settings.json")
CREATED_EXTENSION=$(jq -r '.extensions[0]' "$FIXTURE_AGENT/settings.json")
[ "$CREATED_THEME" = "catppuccin-mocha" ] || fail "created settings.json should include theme"
[ "$CREATED_EXTENSION" = "-extensions/google-search.ts" ] || fail "created settings.json should include extensions"
pass "merge-settings.sh creates settings.json from settings.config.json"

# fails clearly when config is missing
rm -f "$FIXTURE_AGENT/settings.config.json"
set +e
ERROR_OUTPUT=$(cd "$TMP_ROOT" && "$FIXTURE_SCRIPTS/merge-settings.sh" 2>&1)
STATUS=$?
set -e
[ "$STATUS" -eq 1 ] || fail "should exit 1 when settings.config.json is missing"
printf '%s' "$ERROR_OUTPUT" | grep -q 'Missing config file:' || fail "should report missing settings.config.json"
pass "merge-settings.sh fails clearly when settings.config.json is missing"
