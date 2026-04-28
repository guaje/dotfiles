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
  "defaultProvider": "test-provider",
  "theme": "catppuccin-mocha",
  "enabledModels": ["test-provider/test-model"]
}
JSON
cat > "$FIXTURE_AGENT/settings.json" <<'JSON'
{
  "lastChangelogVersion": "test-changelog-version",
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
[ "$LAST_CHANGELOG" = "test-changelog-version" ] || fail "should preserve lastChangelogVersion"
[ "$DEFAULT_PROVIDER" = "test-provider" ] || fail "should replace defaultProvider from config"
[ "$THEME" = "catppuccin-mocha" ] || fail "should merge theme from config"
[ "$ENABLED_MODEL" = "test-provider/test-model" ] || fail "should merge enabledModels from config"
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

# falls back to node when jq is unavailable
NODE_BIN=$(command -v node || true)
DIRNAME_BIN=$(command -v dirname || true)
RM_BIN=$(command -v rm || true)
MV_BIN=$(command -v mv || true)
[ -n "$NODE_BIN" ] || fail "node is required for fallback test"
[ -n "$DIRNAME_BIN" ] || fail "dirname is required for fallback test"
[ -n "$RM_BIN" ] || fail "rm is required for fallback test"
[ -n "$MV_BIN" ] || fail "mv is required for fallback test"
mkdir -p "$TMP_ROOT/bin"
cat > "$TMP_ROOT/bin/node" <<SH
#!/bin/sh
exec "$NODE_BIN" "\$@"
SH
cat > "$TMP_ROOT/bin/dirname" <<SH
#!/bin/sh
exec "$DIRNAME_BIN" "\$@"
SH
cat > "$TMP_ROOT/bin/rm" <<SH
#!/bin/sh
exec "$RM_BIN" "\$@"
SH
cat > "$TMP_ROOT/bin/mv" <<SH
#!/bin/sh
exec "$MV_BIN" "\$@"
SH
chmod +x "$TMP_ROOT/bin/node" "$TMP_ROOT/bin/dirname" "$TMP_ROOT/bin/rm" "$TMP_ROOT/bin/mv"
cat > "$FIXTURE_AGENT/settings.config.json" <<'JSON'
{
  "theme": "catppuccin-mocha",
  "autoModelSelectionEnabled": false
}
JSON
cat > "$FIXTURE_AGENT/settings.json" <<'JSON'
{
  "lastChangelogVersion": "test-changelog-version",
  "theme": "old"
}
JSON
OUTPUT=$(cd "$TMP_ROOT" && PATH="$TMP_ROOT/bin" "$FIXTURE_SCRIPTS/merge-settings.sh") || fail "merge-settings.sh should fall back to node when jq is unavailable"
[ "$OUTPUT" = "Wrote settings.json" ] || fail "node fallback should still print the output path"
FALLBACK_THEME=$(jq -r '.theme' "$FIXTURE_AGENT/settings.json")
FALLBACK_AUTO_MODEL=$(jq -r '.autoModelSelectionEnabled' "$FIXTURE_AGENT/settings.json")
FALLBACK_CHANGELOG=$(jq -r '.lastChangelogVersion' "$FIXTURE_AGENT/settings.json")
[ "$FALLBACK_THEME" = "catppuccin-mocha" ] || fail "node fallback should merge config"
[ "$FALLBACK_AUTO_MODEL" = "false" ] || fail "node fallback should preserve boolean values"
[ "$FALLBACK_CHANGELOG" = "test-changelog-version" ] || fail "node fallback should preserve lastChangelogVersion"
pass "merge-settings.sh falls back to node when jq is unavailable"

# fails clearly when config is missing
rm -f "$FIXTURE_AGENT/settings.config.json"
set +e
ERROR_OUTPUT=$(cd "$TMP_ROOT" && "$FIXTURE_SCRIPTS/merge-settings.sh" 2>&1)
STATUS=$?
set -e
[ "$STATUS" -eq 1 ] || fail "should exit 1 when settings.config.json is missing"
printf '%s' "$ERROR_OUTPUT" | grep -q 'Missing config file:' || fail "should report missing settings.config.json"
pass "merge-settings.sh fails clearly when settings.config.json is missing"
