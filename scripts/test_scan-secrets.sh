#!/usr/bin/env bash

# Isolated scanner integration test.
set -euo pipefail
SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091 # Sourced dynamically from the script directory.
. "$SCRIPT_DIR/test_fixture.sh"
setup_secret_fixture
SCAN_SCRIPT="$SOURCE_DIR/scripts/scan-secrets.sh"

cleanup() {
    echo "Cleaning up scan-secrets test files..."
    finish_secret_fixture || exit 1
}

fail() {
    echo "❌ $1" >&2
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

assert_hook_launcher_contract || fail 'hook launcher contract failed'
pass "hook configuration passed"

prepare_test_dir

# 1. Text mode detects secrets and reports line number.
echo "Testing text output mode..."
cat <<'EOF' > "$TEST_ROOT/scan_secret.txt"
hello
token=ghp_abcdefghijklmnopqrstuvwxyz1234567890
EOF
TEXT_OUTPUT=$("$SCAN_SCRIPT" "$TEST_ROOT/scan_secret.txt" 2>&1 >/dev/null || true)
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
JSON_OUTPUT=$("$SCAN_SCRIPT" --format json "$TEST_ROOT/scan_json_secret.txt" 2>/dev/null || true)
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
JSON_CLEAN_OUTPUT=$("$SCAN_SCRIPT" --format json "$TEST_ROOT/scan_json_clean.txt")
if grep -q '"files_scanned": 1' <<< "$JSON_CLEAN_OUTPUT" \
   && grep -q '"findings": 0' <<< "$JSON_CLEAN_OUTPUT"; then
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
SARIF_OUTPUT=$("$SCAN_SCRIPT" --format sarif "$TEST_ROOT/scan_sarif_secret.txt" 2>/dev/null || true)
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
GHA_STATUS=0
GHA_OUTPUT=$("$SCAN_SCRIPT" --format gha "$TEST_ROOT/scan_gha_secret.txt" 2>&1) || GHA_STATUS=$?
GHA_PREFIX="::error file=$TEST_ROOT/scan_gha_secret.txt,line=1,title="
GHA_LABEL=${GHA_OUTPUT#"$GHA_PREFIX"}
GHA_LABEL=${GHA_LABEL%%::*}
if [[ $GHA_STATUS -eq 1 && $GHA_LABEL == password \
   && $GHA_OUTPUT == "$GHA_PREFIX$GHA_LABEL::Potential secret detected ($GHA_LABEL)" ]]; then
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
HOSTILE_OUTPUT=$("$SCAN_SCRIPT" --format gha -- "$HOSTILE_FILE" 2>&1 || true)
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
HOSTILE_JSON_OUTPUT=$("$SCAN_SCRIPT" --format json -- "$HOSTILE_FILE" 2>/dev/null || true)
HOSTILE_SARIF_OUTPUT=$("$SCAN_SCRIPT" --format sarif -- "$HOSTILE_FILE" 2>/dev/null || true)
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
if "$SCAN_SCRIPT" --format xml "$TEST_ROOT/scan_json_clean.txt" >/dev/null 2>&1; then
    fail "Invalid format handling failed"
else
    pass "Invalid format handling passed"
fi

# Provider-specific vectors belong at the reusable scanner boundary.
echo "Testing Postman token detection..."
printf '%s\n' 'value=PMAK-v1-abcdefghijklmnopqrstuvwxyz123456' > "$TEST_ROOT/scan_postman_upper.txt"
printf '%s\n' 'value=pmak-abcdefghijklmnopqrstuvwxyz123456' > "$TEST_ROOT/scan_postman_lower.txt"
printf '%s\n' 'value=pma-abcdefghijklmnopqrstuvwxyz123456' > "$TEST_ROOT/scan_postman_near_miss.txt"
for postman_file in "$TEST_ROOT/scan_postman_upper.txt" "$TEST_ROOT/scan_postman_lower.txt"; do
    POSTMAN_STATUS=0
    POSTMAN_OUTPUT=$("$SCAN_SCRIPT" "$postman_file" 2>&1) || POSTMAN_STATUS=$?
    [[ $POSTMAN_STATUS -eq 1 ]] || fail "Postman token was not detected: $postman_file"
    printf '%s' "$POSTMAN_OUTPUT" | grep -Fq 'POSTMAN_API_KEY' \
        || fail "Postman token was detected only by a generic key rule: $postman_file"
done
"$SCAN_SCRIPT" --quiet "$TEST_ROOT/scan_postman_near_miss.txt" \
    || fail 'bare pma- near-miss was detected as a Postman token'
pass 'uppercase and lowercase Postman tokens are detected without pma- false positives'

# Explicit input paths are a caller contract; missing files fail closed.
echo "Testing nonexistent explicit path behavior..."
NONEXISTENT_STATUS=0
NONEXISTENT_OUTPUT=$("$SCAN_SCRIPT" "$TEST_ROOT/does-not-exist" 2>&1) || NONEXISTENT_STATUS=$?
[[ $NONEXISTENT_STATUS -eq 1 ]] || fail 'nonexistent explicit path did not fail'
printf '%s' "$NONEXISTENT_OUTPUT" | grep -Fq 'Cannot scan missing or non-regular file' \
    || fail 'nonexistent explicit path omitted its diagnostic'
pass 'nonexistent explicit path fails with a diagnostic'

# Invoking without a file is invalid and explains the boundary failure.
echo "Testing empty invocation behavior..."
EMPTY_STATUS=0
EMPTY_OUTPUT=$("$SCAN_SCRIPT" 2>&1) || EMPTY_STATUS=$?
[[ $EMPTY_STATUS -eq 1 ]] || fail 'empty invocation did not exit 1'
printf '%s' "$EMPTY_OUTPUT" | grep -Fq 'No files to scan' || fail 'empty invocation omitted its diagnostic'
pass 'empty invocation fails with a diagnostic'

# Quiet text mode suppresses per-file success output.
echo "Testing quiet clean output..."
printf '%s\n' 'clean input' > "$TEST_ROOT/scan_quiet_clean.txt"
QUIET_OUTPUT=$("$SCAN_SCRIPT" --quiet "$TEST_ROOT/scan_quiet_clean.txt") \
    || fail 'quiet scan of clean input failed'
[[ $QUIET_OUTPUT != *'ok:'* ]] || fail 'quiet mode emitted per-file success output'
pass 'quiet mode suppresses clean output'

# The scanner has no hidden Python dependency and must still detect secrets
# when python/python3 resolve only to failing PATH shims.
echo "Testing scanner without Python..."
NO_PYTHON_BIN="$TEST_FIXTURE/no-python-bin"
mkdir -p "$NO_PYTHON_BIN"
printf '%s\n' '#!/bin/sh' 'exit 127' > "$NO_PYTHON_BIN/python"
cp "$NO_PYTHON_BIN/python" "$NO_PYTHON_BIN/python3"
chmod +x "$NO_PYTHON_BIN/python" "$NO_PYTHON_BIN/python3"
printf '%s\n' 'hello world' > "$TEST_ROOT/scan_no_python_clean.txt"
env PATH="$NO_PYTHON_BIN:$PATH" "$SCAN_SCRIPT" --quiet "$TEST_ROOT/scan_no_python_clean.txt" \
    || fail 'clean scan failed when Python executables were unavailable'
printf '%s\n' 'token=ghp_abcdefghijklmnopqrstuvwxyz1234567890' > "$TEST_ROOT/scan_no_python_secret.txt"
NO_PYTHON_SECRET_STATUS=0
env PATH="$NO_PYTHON_BIN:$PATH" "$SCAN_SCRIPT" --quiet "$TEST_ROOT/scan_no_python_secret.txt" \
    >/dev/null 2>&1 || NO_PYTHON_SECRET_STATUS=$?
[[ $NO_PYTHON_SECRET_STATUS -eq 1 ]] \
    || fail 'scanner failed open on a secret when Python executables were unavailable'
pass 'scanner detects secrets without Python'

echo "All scan-secrets.sh tests passed successfully!"
