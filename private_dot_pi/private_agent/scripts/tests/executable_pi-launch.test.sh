#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
SOURCE_MERGE="$ROOT_DIR/agent/scripts/merge-settings.sh"
SOURCE_LAUNCH="$ROOT_DIR/agent/scripts/pi-launch.sh"

fail() {
  echo "not ok - $1" >&2
  exit 1
}

pass() {
  echo "ok - $1"
}

make_fixture() {
  FIXTURE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pi-launch-test.XXXXXX")
  FIXTURE_AGENT="$FIXTURE_ROOT/agent"
  FIXTURE_SCRIPTS="$FIXTURE_AGENT/scripts"
  mkdir -p "$FIXTURE_SCRIPTS"
  cp "$SOURCE_MERGE" "$FIXTURE_SCRIPTS/merge-settings.sh"
  cp "$SOURCE_LAUNCH" "$FIXTURE_SCRIPTS/pi-launch.sh"
  chmod +x "$FIXTURE_SCRIPTS/merge-settings.sh" "$FIXTURE_SCRIPTS/pi-launch.sh"
}

cleanup_fixture() {
  rm -rf -- "$FIXTURE_ROOT"
}

trap 'cleanup_fixture' EXIT HUP INT TERM

# uses PI_REAL_BIN and merges first
make_fixture
cat > "$FIXTURE_AGENT/settings.config.json" <<'JSON'
{
  "theme": "catppuccin-mocha"
}
JSON
cat > "$FIXTURE_AGENT/settings.json" <<'JSON'
{
  "lastChangelogVersion": "0.67.68",
  "theme": "old"
}
JSON
cat > "$FIXTURE_ROOT/fake-pi.sh" <<'SH'
#!/bin/sh
printf 'fake-pi %s\n' "$*"
SH
chmod +x "$FIXTURE_ROOT/fake-pi.sh"
OUTPUT=$(cd "$FIXTURE_ROOT" && PI_REAL_BIN="$FIXTURE_ROOT/fake-pi.sh" "$FIXTURE_SCRIPTS/pi-launch.sh" --version) || fail "pi-launch.sh should succeed with PI_REAL_BIN"
[ "$OUTPUT" = "fake-pi --version" ] || fail "pi-launch.sh should exec PI_REAL_BIN"
MERGED_THEME=$(jq -r '.theme' "$FIXTURE_AGENT/settings.json")
MERGED_VERSION=$(jq -r '.lastChangelogVersion' "$FIXTURE_AGENT/settings.json")
[ "$MERGED_THEME" = "catppuccin-mocha" ] || fail "pi-launch.sh should merge settings before launching"
[ "$MERGED_VERSION" = "0.67.68" ] || fail "pi-launch.sh should preserve lastChangelogVersion"
pass "pi-launch.sh merges settings and execs PI_REAL_BIN"
cleanup_fixture

# falls back to PATH lookup
make_fixture
cat > "$FIXTURE_AGENT/settings.config.json" <<'JSON'
{
  "theme": "catppuccin-mocha"
}
JSON
mkdir -p "$FIXTURE_ROOT/bin"
cat > "$FIXTURE_ROOT/bin/pi" <<'SH'
#!/bin/sh
printf 'path-pi %s\n' "$*"
SH
chmod +x "$FIXTURE_ROOT/bin/pi"
OUTPUT=$(cd "$FIXTURE_ROOT" && PATH="$FIXTURE_ROOT/bin:$PATH" "$FIXTURE_SCRIPTS/pi-launch.sh" hello) || fail "pi-launch.sh should succeed with PATH lookup"
[ "$OUTPUT" = "path-pi hello" ] || fail "pi-launch.sh should exec pi from PATH"
pass "pi-launch.sh falls back to PATH lookup"
cleanup_fixture

# errors when PATH resolves back to wrapper
make_fixture
cat > "$FIXTURE_ROOT/settings.config.json" <<'JSON'
{
  "theme": "catppuccin-mocha"
}
JSON
mkdir -p "$FIXTURE_ROOT/bin"
cp "$FIXTURE_SCRIPTS/pi-launch.sh" "$FIXTURE_ROOT/bin/pi"
cp "$FIXTURE_SCRIPTS/merge-settings.sh" "$FIXTURE_ROOT/bin/merge-settings.sh"
chmod +x "$FIXTURE_ROOT/bin/pi" "$FIXTURE_ROOT/bin/merge-settings.sh"
set +e
ERROR_OUTPUT=$(cd "$FIXTURE_ROOT" && PATH="$FIXTURE_ROOT/bin:$PATH" "$FIXTURE_ROOT/bin/pi" 2>&1)
STATUS=$?
set -e
[ "$STATUS" -eq 1 ] || fail "pi-launch.sh should exit 1 when PATH points back to the wrapper"
printf '%s' "$ERROR_OUTPUT" | grep -q 'Could not find the real pi binary' || fail "pi-launch.sh should explain how to set PI_REAL_BIN"
pass "pi-launch.sh errors when PATH resolves back to the wrapper"
cleanup_fixture
