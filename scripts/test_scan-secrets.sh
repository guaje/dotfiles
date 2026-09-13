#!/usr/bin/env bash

# Isolated scanner integration test.
set -euo pipefail
SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091 # Sourced dynamically from the script directory.
. "$SCRIPT_DIR/test_fixture.sh"
setup_secret_fixture
SOURCE_DIR=$(chezmoi source-path)
TEST_ROOT="$HOME/.test"
SCAN_SCRIPT="$SOURCE_DIR/scripts/scan-secrets.sh"

cleanup() {
    echo "Cleaning up scan-secrets test files..."
    rm -f \
        "$TEST_ROOT/scan_secret.txt" \
        "$TEST_ROOT/scan_clean.txt" \
        "$TEST_ROOT/scan_json_secret.txt" \
        "$TEST_ROOT/scan_json_clean.txt" \
        "$TEST_ROOT/scan_sarif_secret.txt" \
        "$TEST_ROOT/scan_gha_secret.txt" \
        2>/dev/null || true
    finish_secret_fixture
}

fail() {
    echo "❌ $1"
    exit 1
}

pass() {
    echo "✅ $1"
}

prepare_test_dir() {
    mkdir -p "$TEST_ROOT"
}

trap cleanup EXIT HUP INT TERM

echo "Starting tests for scan-secrets.sh..."

prepare_test_dir

# 1. Text mode detects secrets and reports line number.
echo "Testing text output mode..."
cat <<'EOF' > "$TEST_ROOT/scan_secret.txt"
hello
token=ghp_abcdefghijklmnopqrstuvwxyz1234567890
EOF
TEXT_OUTPUT=$($SCAN_SCRIPT "$TEST_ROOT/scan_secret.txt" 2>&1 >/dev/null || true)
if grep -q "secret detected: $TEST_ROOT/scan_secret.txt:2: GITHUB_TOKEN" <<< "$TEXT_OUTPUT"; then
    pass "Text output mode passed"
else
    echo "$TEXT_OUTPUT"
    fail "Text output mode failed"
fi

# 2. JSON mode detects secrets and emits machine-readable output.
echo "Testing JSON output mode with finding..."
cat <<'EOF' > "$TEST_ROOT/scan_json_secret.txt"
api_key=AIzaabcdefghijklmnopqrstuvwxyz123456789
EOF
JSON_OUTPUT=$($SCAN_SCRIPT --format json "$TEST_ROOT/scan_json_secret.txt" 2>/dev/null || true)
if grep -q '"files_scanned": 1' <<< "$JSON_OUTPUT" \
   && grep -q '"findings": 1' <<< "$JSON_OUTPUT" \
   && grep -Fq "\"file\":\"$TEST_ROOT/scan_json_secret.txt\"" <<< "$JSON_OUTPUT" \
   && grep -q '"label":"GOOGLE_API_KEY"' <<< "$JSON_OUTPUT" \
   && grep -q '"line":1' <<< "$JSON_OUTPUT"; then
    pass "JSON output mode with finding passed"
else
    echo "$JSON_OUTPUT"
    fail "JSON output mode with finding failed"
fi

# 3. JSON mode on clean input returns empty findings and success.
echo "Testing JSON output mode with clean input..."
printf '%s\n' 'just text' > "$TEST_ROOT/scan_json_clean.txt"
JSON_CLEAN_OUTPUT=$($SCAN_SCRIPT --format json "$TEST_ROOT/scan_json_clean.txt")
if grep -q '"files_scanned": 1' <<< "$JSON_CLEAN_OUTPUT" \
   && grep -q '"findings": 0' <<< "$JSON_CLEAN_OUTPUT" \
   && grep -q '"findings": \[' <<< "$JSON_CLEAN_OUTPUT"; then
    pass "JSON output mode with clean input passed"
else
    echo "$JSON_CLEAN_OUTPUT"
    fail "JSON output mode with clean input failed"
fi

# 4. SARIF mode emits code-scanning compatible results.
echo "Testing SARIF output mode..."
cat <<'EOF' > "$TEST_ROOT/scan_sarif_secret.txt"
client_secret=ghs_abcdefghijklmnopqrstuvwxyz1234567890
EOF
SARIF_OUTPUT=$($SCAN_SCRIPT --format sarif "$TEST_ROOT/scan_sarif_secret.txt" 2>/dev/null || true)
if grep -q '"version": "2.1.0"' <<< "$SARIF_OUTPUT" \
   && grep -q '"ruleId":"GITHUB_APP_TOKEN"' <<< "$SARIF_OUTPUT" \
   && grep -Fq "\"uri\":\"$TEST_ROOT/scan_sarif_secret.txt\"" <<< "$SARIF_OUTPUT" \
   && grep -q '"startLine":1' <<< "$SARIF_OUTPUT"; then
    pass "SARIF output mode passed"
else
    echo "$SARIF_OUTPUT"
    fail "SARIF output mode failed"
fi

# 5. GitHub Actions annotation mode emits workflow commands.
echo "Testing GitHub Actions annotation output mode..."
cat <<'EOF' > "$TEST_ROOT/scan_gha_secret.txt"
password=supersecretvalue
EOF
GHA_OUTPUT=$($SCAN_SCRIPT --format gha "$TEST_ROOT/scan_gha_secret.txt" 2>&1 || true)
if grep -Fq "::error file=$TEST_ROOT/scan_gha_secret.txt,line=1,title=password::Potential secret detected (password)" <<< "$GHA_OUTPUT"; then
    pass "GitHub Actions annotation mode passed"
else
    echo "$GHA_OUTPUT"
    fail "GitHub Actions annotation mode failed"
fi

# 6. Explicit paths are kept as NUL-delimited Bash array entries end-to-end.
echo "Testing hostile explicit path names and GHA escaping..."
HOSTILE_DIR="$TEST_ROOT/space tab	unicode-λ"
mkdir -p "$HOSTILE_DIR"
HOSTILE_FILE="$HOSTILE_DIR/leading,-:name
next"
printf '%s\n' 'token=ghp_abcdefghijklmnopqrstuvwxyz1234567890' > "$HOSTILE_FILE"
HOSTILE_OUTPUT=$($SCAN_SCRIPT --format gha -- "$HOSTILE_FILE" 2>&1 || true)
if [ "$(printf '%s\n' "$HOSTILE_OUTPUT" | grep -c '^::error ' )" -eq 1 ] \
   && grep -q '%0A' <<< "$HOSTILE_OUTPUT" \
   && grep -q '%2C' <<< "$HOSTILE_OUTPUT" \
   && grep -q '%3A' <<< "$HOSTILE_OUTPUT"; then
    pass "hostile explicit path handling passed"
else
    printf '%s\n' "$HOSTILE_OUTPUT"
    fail "hostile explicit path handling failed"
fi

# 7. JSON and SARIF preserve newlines in hostile paths.
echo "Testing JSON and SARIF newline path escaping..."
HOSTILE_JSON_PATH=${HOSTILE_FILE//$'\t'/\\t}
HOSTILE_JSON_PATH=${HOSTILE_JSON_PATH//$'\n'/\\n}
HOSTILE_JSON_OUTPUT=$($SCAN_SCRIPT --format json -- "$HOSTILE_FILE" 2>/dev/null || true)
HOSTILE_SARIF_OUTPUT=$($SCAN_SCRIPT --format sarif -- "$HOSTILE_FILE" 2>/dev/null || true)
if grep -Fq "\"file\":\"$HOSTILE_JSON_PATH\"" <<< "$HOSTILE_JSON_OUTPUT" \
   && grep -Fq "\"uri\":\"$HOSTILE_JSON_PATH\"" <<< "$HOSTILE_SARIF_OUTPUT"; then
    pass "JSON and SARIF newline path escaping passed"
else
    printf '%s\n' "$HOSTILE_JSON_OUTPUT" "$HOSTILE_SARIF_OUTPUT"
    fail "JSON and SARIF newline path escaping failed"
fi

# 8. Exercise the real git --staged NUL producer with hostile names.
echo "Testing hostile staged Git paths..."
STAGED_REPO="$TEST_FIXTURE/staged-repo"
mkdir -p "$STAGED_REPO"
git -C "$STAGED_REPO" init -q
git -C "$STAGED_REPO" config user.email test@example.invalid
git -C "$STAGED_REPO" config user.name test
STAGED_ONE=$'line\ncomma,colon:percent%'
STAGED_TWO=$'-leading-dash'
STAGED_THREE=$'space tab\tunicode-λ'
printf '%s\n' 'token=ghp_abcdefghijklmnopqrstuvwxyz1234567890' > "$STAGED_REPO/$STAGED_ONE"
printf '%s\n' 'token=ghp_abcdefghijklmnopqrstuvwxyz1234567890' > "$STAGED_REPO/$STAGED_TWO"
printf '%s\n' 'token=ghp_abcdefghijklmnopqrstuvwxyz1234567890' > "$STAGED_REPO/$STAGED_THREE"
git -C "$STAGED_REPO" add -- "$STAGED_ONE" "$STAGED_TWO" "$STAGED_THREE"
STAGED_GHA=$(cd "$STAGED_REPO" && "$SCAN_SCRIPT" --format gha --git-staged 2>&1 || true)
STAGED_JSON=$(cd "$STAGED_REPO" && "$SCAN_SCRIPT" --format json --git-staged 2>/dev/null || true)
STAGED_SARIF=$(cd "$STAGED_REPO" && "$SCAN_SCRIPT" --format sarif --git-staged 2>/dev/null || true)
if [ "$(printf '%s\n' "$STAGED_GHA" | grep -c '^::error ')" -eq 3 ] \
   && grep -q '%0A' <<< "$STAGED_GHA" \
   && grep -q '%2C' <<< "$STAGED_GHA" \
   && grep -q '%3A' <<< "$STAGED_GHA" \
   && grep -q '%25' <<< "$STAGED_GHA" \
   && grep -q '"files_scanned": 3' <<< "$STAGED_JSON" \
   && grep -q '"version": "2.1.0"' <<< "$STAGED_SARIF"; then
    pass "hostile staged Git paths passed"
else
    printf '%s\n' "$STAGED_GHA" "$STAGED_JSON"
    fail "hostile staged Git paths failed"
fi

# 9. Invalid format should fail.
echo "Testing invalid format handling..."
if $SCAN_SCRIPT --format xml "$TEST_ROOT/scan_json_clean.txt" >/dev/null 2>&1; then
    fail "Invalid format handling failed"
else
    pass "Invalid format handling passed"
fi

echo "All scan-secrets.sh tests passed successfully!"
