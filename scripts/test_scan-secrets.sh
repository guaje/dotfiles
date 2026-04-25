#!/bin/sh

# Portable test script for scan-secrets.sh.
# Verifies text, JSON, SARIF, and GitHub Actions output modes for CI/pre-commit usage.

set -eu

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
if printf '%s' "$TEXT_OUTPUT" | grep -q "secret detected: $TEST_ROOT/scan_secret.txt:2: GITHUB_TOKEN"; then
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
if printf '%s' "$JSON_OUTPUT" | grep -q '"files_scanned": 1' \
   && printf '%s' "$JSON_OUTPUT" | grep -q '"findings": 1' \
   && printf '%s' "$JSON_OUTPUT" | grep -Fq "\"file\":\"$TEST_ROOT/scan_json_secret.txt\"" \
   && printf '%s' "$JSON_OUTPUT" | grep -q '"label":"GOOGLE_API_KEY"' \
   && printf '%s' "$JSON_OUTPUT" | grep -q '"line":1'; then
    pass "JSON output mode with finding passed"
else
    echo "$JSON_OUTPUT"
    fail "JSON output mode with finding failed"
fi

# 3. JSON mode on clean input returns empty findings and success.
echo "Testing JSON output mode with clean input..."
printf '%s\n' 'just text' > "$TEST_ROOT/scan_json_clean.txt"
JSON_CLEAN_OUTPUT=$($SCAN_SCRIPT --format json "$TEST_ROOT/scan_json_clean.txt")
if printf '%s' "$JSON_CLEAN_OUTPUT" | grep -q '"files_scanned": 1' \
   && printf '%s' "$JSON_CLEAN_OUTPUT" | grep -q '"findings": 0' \
   && printf '%s' "$JSON_CLEAN_OUTPUT" | grep -q '"findings": \['; then
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
if printf '%s' "$SARIF_OUTPUT" | grep -q '"version": "2.1.0"' \
   && printf '%s' "$SARIF_OUTPUT" | grep -q '"ruleId":"GITHUB_APP_TOKEN"' \
   && printf '%s' "$SARIF_OUTPUT" | grep -Fq "\"uri\":\"$TEST_ROOT/scan_sarif_secret.txt\"" \
   && printf '%s' "$SARIF_OUTPUT" | grep -q '"startLine":1'; then
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
if printf '%s' "$GHA_OUTPUT" | grep -Fq "::error file=$TEST_ROOT/scan_gha_secret.txt,line=1,title=password::Potential secret detected (password)"; then
    pass "GitHub Actions annotation mode passed"
else
    echo "$GHA_OUTPUT"
    fail "GitHub Actions annotation mode failed"
fi

# 6. Invalid format should fail.
echo "Testing invalid format handling..."
if $SCAN_SCRIPT --format xml "$TEST_ROOT/scan_json_clean.txt" >/dev/null 2>&1; then
    fail "Invalid format handling failed"
else
    pass "Invalid format handling passed"
fi

echo "All scan-secrets.sh tests passed successfully!"
