#!/bin/sh

# Portable test script for check-secrets.sh.
# Validates all 4 choices and multiple file formats.

set -eu

SOURCE_DIR=$(chezmoi source-path)
TEST_ROOT="$HOME/.test"
CONFIG_TEST_ROOT="$HOME/.config/test"
SOURCE_NAMING_TEST_ROOT="$HOME/.test_dir/test_subdir"
export SOPS_AGE_KEY_FILE="$HOME/.config/chezmoi/key.txt"

cleanup() {
    echo "Cleaning up test files..."

    rm -f "$TEST_ROOT/test_data.yaml" "$TEST_ROOT/test_data.json" "$TEST_ROOT/test_data.toml" "$TEST_ROOT/test_multi.json" 2>/dev/null || true
    rm -f "$TEST_ROOT/test_abort.yaml" "$TEST_ROOT/test_plain.yaml" "$TEST_ROOT/test_full.yaml" "$TEST_ROOT/test_token.json" "$TEST_ROOT/test_openai.json" "$TEST_ROOT/test_postman.json" "$TEST_ROOT/test_clean.txt" "$TEST_ROOT/test_placeholder.yaml" 2>/dev/null || true
    rm -rf "$CONFIG_TEST_ROOT" "$SOURCE_NAMING_TEST_ROOT" "$HOME/.test_dir" 2>/dev/null || true

    for prefix in test_abort test_plain test_full test_data test_multi test_sub test_chezmoi_naming test_token test_openai test_postman test_clean test_placeholder; do
        find "$SOURCE_DIR" -maxdepth 1 \( -name "*${prefix}*" -o -name "private_*${prefix}*" -o -name "encrypted_*${prefix}*" \) -exec rm -rf {} + 2>/dev/null || true
        if [ -d "$SOURCE_DIR/secrets" ]; then
            find "$SOURCE_DIR/secrets" -name "*${prefix}*" -exec rm -rf {} + 2>/dev/null || true
        fi
    done

    rm -rf "$SOURCE_DIR/dot_test" "$SOURCE_DIR/dot_config/test" "$SOURCE_DIR/dot_config/test_dir" "$SOURCE_DIR/dot_config/private_test_dir" "$SOURCE_DIR/dot_test_dir/test_subdir" "$SOURCE_DIR/dot_test_dir" 2>/dev/null || true

    if [ -d "$SOURCE_DIR/secrets" ]; then
        find "$SOURCE_DIR/secrets" -depth -mindepth 1 -type d -empty -exec rmdir {} \; 2>/dev/null || true
    fi
}

fail() {
    echo "❌ $1"
    exit 1
}

pass() {
    echo "✅ $1"
}

run_chezmoi_add() {
    choice=$1
    shift
    TEST_CHOICE=$choice chezmoi add "$@"
}

prepare_test_dirs() {
    mkdir -p "$TEST_ROOT" "$CONFIG_TEST_ROOT" "$SOURCE_NAMING_TEST_ROOT"
}

template_source_path() {
    chezmoi source-path "$1"
}

sops_source_path() {
    source_file=$(template_source_path "$1")
    source_file=${source_file%.tmpl}
    rel_path=${source_file#"$SOURCE_DIR"/}
    printf '%s/secrets/%s.sops.yaml\n' "$SOURCE_DIR" "$rel_path"
}

trap cleanup EXIT HUP INT TERM

echo "Starting tests for check-secrets.sh..."

# 1. Test Option 4: Abort
echo "Testing Option 4 (Abort)..."
prepare_test_dirs
printf '%s\n' 'AUTH: abort-test' > "$TEST_ROOT/test_abort.yaml"
if run_chezmoi_add 4 "$TEST_ROOT/test_abort.yaml" 2>/dev/null; then
    fail "Option 4 failed: chezmoi add should have been aborted"
else
    pass "Option 4 passed"
fi

# 2. Test Option 3: Plain
echo "Testing Option 3 (Plain)..."
prepare_test_dirs
printf '%s\n' 'SECRET: plain-test' > "$TEST_ROOT/test_plain.yaml"
if run_chezmoi_add 3 "$TEST_ROOT/test_plain.yaml"; then
    pass "Option 3 passed"
else
    fail "Option 3 failed"
fi

# 3. Test Option 1: Full Encryption
echo "Testing Option 1 (Full Encryption)..."
prepare_test_dirs
printf '%s\n' 'API_KEY: full-encrypt-test' > "$TEST_ROOT/test_full.yaml"
run_chezmoi_add 1 "$TEST_ROOT/test_full.yaml" >/dev/null 2>&1 || true
if [ -f "$SOURCE_DIR/dot_test/encrypted_private_test_full.yaml.age" ]; then
    pass "Option 1 passed"
else
    fail "Option 1 failed: encrypted file not found in source"
fi

# 4. Test Option 2: SOPS Strategy (YAML)
echo "Testing Option 2 (SOPS - YAML)..."
prepare_test_dirs
cat <<'EOF' > "$TEST_ROOT/test_data.yaml"
app_name: MyTestApp
API_KEY: yaml-secret-key
port: 8080
db_password: yaml-db-pass
EOF
run_chezmoi_add 2 "$TEST_ROOT/test_data.yaml" >/dev/null 2>&1 || true
YAML_TMPL=$(template_source_path "$TEST_ROOT/test_data.yaml")
YAML_SOPS=$(sops_source_path "$TEST_ROOT/test_data.yaml")
if [ -f "$YAML_TMPL" ] && sops --decrypt "$YAML_SOPS" | grep -q "yaml-secret-key"; then
    pass "Option 2 (YAML) passed"
else
    fail "Option 2 (YAML) failed"
fi

# 5. Test Option 2: SOPS Strategy (JSON)
echo "Testing Option 2 (SOPS - JSON)..."
prepare_test_dirs
cat <<'EOF' > "$TEST_ROOT/test_data.json"
{
  "app_name": "MyTestApp",
  "apiKey": "json-secret-key",
  "dbPassword": "json-db-pass",
  "port": 8080
}
EOF
run_chezmoi_add 2 "$TEST_ROOT/test_data.json" >/dev/null 2>&1 || true
JSON_TMPL=$(template_source_path "$TEST_ROOT/test_data.json")
JSON_SOPS=$(sops_source_path "$TEST_ROOT/test_data.json")
if [ -f "$JSON_TMPL" ] && sops --decrypt "$JSON_SOPS" | grep -q "json-secret-key"; then
    pass "Option 2 (JSON) passed"
else
    fail "Option 2 (JSON) failed"
fi

# 6. Test Option 2: SOPS Strategy (TOML)
echo "Testing Option 2 (SOPS - TOML)..."
prepare_test_dirs
cat <<'EOF' > "$TEST_ROOT/test_data.toml"
app_name = "MyTestApp"
API_KEY = "toml-secret-key"
port = 8080
db_password = "toml-db-pass"
EOF
run_chezmoi_add 2 "$TEST_ROOT/test_data.toml" >/dev/null 2>&1 || true
TOML_TMPL=$(template_source_path "$TEST_ROOT/test_data.toml")
TOML_SOPS=$(sops_source_path "$TEST_ROOT/test_data.toml")
if [ -f "$TOML_TMPL" ] && sops --decrypt "$TOML_SOPS" | grep -q "toml-secret-key"; then
    pass "Option 2 (TOML) passed"
else
    fail "Option 2 (TOML) failed"
fi

# 7. Test Option 2: SOPS Strategy (duplicate sensitive keys)
echo "Testing Option 2 (duplicate sensitive keys)..."
prepare_test_dirs
cat <<'EOF' > "$TEST_ROOT/test_multi.json"
{"hosts": [{"username": "username1", "password": "password1"}, {"username": "username2", "password": "password2"}]}
EOF
run_chezmoi_add 2 "$TEST_ROOT/test_multi.json" >/dev/null 2>&1 || true
MULTI_TMPL=$(template_source_path "$TEST_ROOT/test_multi.json")
MULTI_SOPS=$(sops_source_path "$TEST_ROOT/test_multi.json")
if [ -f "$MULTI_TMPL" ] \
   && grep -q 'password__1' "$MULTI_TMPL" \
   && grep -q 'password__2' "$MULTI_TMPL" \
   && sops --decrypt "$MULTI_SOPS" | grep -q 'password1' \
   && sops --decrypt "$MULTI_SOPS" | grep -q 'password2'; then
    pass "Option 2 (duplicate sensitive keys) passed"
else
    fail "Option 2 (duplicate sensitive keys) failed"
fi

# 8. Test Option 2: SOPS Strategy (Subdirectory)
echo "Testing Option 2 (Subdirectory)..."
prepare_test_dirs
cat <<'EOF' > "$CONFIG_TEST_ROOT/test_sub.yaml"
API_KEY: sub-secret-key
EOF
run_chezmoi_add 2 "$CONFIG_TEST_ROOT/test_sub.yaml" >/dev/null 2>&1 || true
SUB_TMPL=$(template_source_path "$CONFIG_TEST_ROOT/test_sub.yaml")
SUB_SOPS=$(sops_source_path "$CONFIG_TEST_ROOT/test_sub.yaml")
if [ -f "$SUB_TMPL" ] && sops --decrypt "$SUB_SOPS" | grep -q "sub-secret-key"; then
    pass "Option 2 (Subdirectory) passed"
else
    echo "Expected secret at: $SUB_SOPS"
    fail "Option 2 (Subdirectory) failed"
fi

# 9. Test Option 2: SOPS Strategy follows chezmoi source naming

echo "Testing Option 2 (chezmoi source naming)..."
prepare_test_dirs
cat <<'EOF' > "$SOURCE_NAMING_TEST_ROOT/test_chezmoi_naming.json"
{
  "service": "chezmoi-naming-test",
  "API_KEY": "chezmoi-naming-secret",
  "enabled": true
}
EOF
run_chezmoi_add 2 "$SOURCE_NAMING_TEST_ROOT/test_chezmoi_naming.json" >/dev/null 2>&1 || true
THEME_TMPL=$(template_source_path "$SOURCE_NAMING_TEST_ROOT/test_chezmoi_naming.json")
THEME_SOPS=$(sops_source_path "$SOURCE_NAMING_TEST_ROOT/test_chezmoi_naming.json")
if [ -f "$THEME_TMPL" ] \
   && sops --decrypt "$THEME_SOPS" | grep -q "chezmoi-naming-secret"; then
    pass "Option 2 (chezmoi source naming) passed"
else
    echo "Expected template at: $THEME_TMPL"
    echo "Expected secret at: $THEME_SOPS"
    fail "Option 2 (chezmoi source naming) failed"
fi

# 10. Test strong token detection independent of key names
echo "Testing strong token detection..."
prepare_test_dirs
cat <<'EOF' > "$TEST_ROOT/test_token.json"
{
  "service": "github",
  "value": "ghp_abcdefghijklmnopqrstuvwxyz1234567890"
}
EOF
run_chezmoi_add 2 "$TEST_ROOT/test_token.json" >/dev/null 2>&1 || true
TOKEN_TMPL=$(template_source_path "$TEST_ROOT/test_token.json")
TOKEN_SOPS=$(sops_source_path "$TEST_ROOT/test_token.json")
if [ -f "$TOKEN_TMPL" ] \
   && sops --decrypt "$TOKEN_SOPS" | grep -q "ghp_abcdefghijklmnopqrstuvwxyz1234567890"; then
    pass "Strong token detection passed"
else
    fail "Strong token detection failed"
fi

# 11. Test additional provider token detection

echo "Testing additional provider token detection..."
prepare_test_dirs
cat <<'EOF' > "$TEST_ROOT/test_openai.json"
{
  "service": "openai",
  "value": "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"
}
EOF
run_chezmoi_add 2 "$TEST_ROOT/test_openai.json" >/dev/null 2>&1 || true
OPENAI_TMPL=$(template_source_path "$TEST_ROOT/test_openai.json")
OPENAI_SOPS=$(sops_source_path "$TEST_ROOT/test_openai.json")
if [ -f "$OPENAI_TMPL" ] \
   && sops --decrypt "$OPENAI_SOPS" | grep -q "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"; then
    pass "Additional provider token detection passed"
else
    fail "Additional provider token detection failed"
fi

# 12. Test placeholder values do not trigger detection
echo "Testing placeholder filtering..."
prepare_test_dirs
cat <<'EOF' > "$TEST_ROOT/test_placeholder.yaml"
api_key: YOUR_API_KEY
password: changeme
EOF
PLACEHOLDER_OUTPUT=$(TEST_CHOICE=4 chezmoi add "$TEST_ROOT/test_placeholder.yaml" 2>&1 || true)
PLACEHOLDER_SOURCE=$(template_source_path "$TEST_ROOT/test_placeholder.yaml")
if printf '%s' "$PLACEHOLDER_OUTPUT" | grep -q 'Sensitive information detected'; then
    fail "Placeholder filtering failed: warning was emitted"
elif [ -f "$PLACEHOLDER_SOURCE" ]; then
    pass "Placeholder filtering passed"
else
    fail "Placeholder filtering failed: file was not added"
fi

# 13. Test reusable scan script with provider-specific detector
echo "Testing reusable scan script..."
prepare_test_dirs
cat <<'EOF' > "$TEST_ROOT/test_postman.json"
{
  "service": "postman",
  "token": "PMAK-v1-abcdefghijklmnopqrstuvwxyz123456"
}
EOF
if "$SOURCE_DIR/scripts/scan-secrets.sh" --quiet "$TEST_ROOT/test_postman.json" >/dev/null 2>&1; then
    fail "Reusable scan script failed to detect provider-specific token"
else
    pass "Reusable scan script detection passed"
fi

# 14. Test reusable scan script on a clean file
echo "Testing reusable scan script on clean input..."
prepare_test_dirs
printf '%s\n' 'hello world' > "$TEST_ROOT/test_clean.txt"
if "$SOURCE_DIR/scripts/scan-secrets.sh" --quiet "$TEST_ROOT/test_clean.txt" >/dev/null 2>&1; then
    pass "Reusable scan script clean input passed"
else
    fail "Reusable scan script clean input failed"
fi

# 15. Assert check-secrets.sh no longer depends on python
echo "Testing python-free implementation..."
if rg -n 'python3|python -' "$SOURCE_DIR/scripts/check-secrets.sh" "$SOURCE_DIR/scripts/check-secrets.awk" "$SOURCE_DIR/scripts/scan-secrets.sh" >/dev/null 2>&1; then
    fail "Python-free implementation failed"
else
    pass "Python-free implementation passed"
fi

echo "All tests passed successfully!"
