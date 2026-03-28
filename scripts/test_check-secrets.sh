#!/bin/sh

# Portable test script for check-secrets.sh.
# Validates all 4 choices and multiple file formats.

set -eu

SOURCE_DIR=$(chezmoi source-path)
TEST_ROOT=$HOME
export SOPS_AGE_KEY_FILE="$HOME/.config/chezmoi/key.txt"

cleanup() {
    echo "Cleaning up test files..."

    rm -f "$TEST_ROOT/test_data.yaml" "$TEST_ROOT/test_data.json" "$TEST_ROOT/test_data.toml" 2>/dev/null || true
    rm -f "$TEST_ROOT/test_abort.yaml" "$TEST_ROOT/test_plain.yaml" "$TEST_ROOT/test_full.yaml" 2>/dev/null || true
    rm -rf "$TEST_ROOT/.config/test_dir" 2>/dev/null || true
    rm -rf "$HOME/.pi/agent/themes/test_check_secrets" 2>/dev/null || true
    rm -rf "$SOURCE_DIR/private_dot_pi/private_agent/private_themes/private_test_check_secrets" 2>/dev/null || true
    rm -rf "$SOURCE_DIR/secrets/private_dot_pi/private_agent/private_themes/private_test_check_secrets" 2>/dev/null || true

    for prefix in test_abort test_plain test_full test_data test_sub; do
        find "$SOURCE_DIR" -maxdepth 1 \( -name "*${prefix}*" -o -name "private_*${prefix}*" -o -name "encrypted_*${prefix}*" \) -exec rm -rf {} + 2>/dev/null || true
        if [ -d "$SOURCE_DIR/secrets" ]; then
            find "$SOURCE_DIR/secrets" -name "*${prefix}*" -exec rm -rf {} + 2>/dev/null || true
        fi
    done

    rm -rf "$SOURCE_DIR/dot_config/test_dir" "$SOURCE_DIR/dot_config/private_test_dir" 2>/dev/null || true
}

fail() {
    echo "❌ $1"
    exit 1
}

pass() {
    echo "✅ $1"
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
printf '%s\n' 'AUTH: abort-test' > "$TEST_ROOT/test_abort.yaml"
export TEST_CHOICE=4
if chezmoi add "$TEST_ROOT/test_abort.yaml" 2>/dev/null; then
    fail "Option 4 failed: chezmoi add should have been aborted"
else
    pass "Option 4 passed"
fi

# 2. Test Option 3: Plain
echo "Testing Option 3 (Plain)..."
printf '%s\n' 'SECRET: plain-test' > "$TEST_ROOT/test_plain.yaml"
export TEST_CHOICE=3
if chezmoi add "$TEST_ROOT/test_plain.yaml"; then
    pass "Option 3 passed"
else
    fail "Option 3 failed"
fi

# 3. Test Option 1: Full Encryption
echo "Testing Option 1 (Full Encryption)..."
printf '%s\n' 'API_KEY: full-encrypt-test' > "$TEST_ROOT/test_full.yaml"
export TEST_CHOICE=1
chezmoi add "$TEST_ROOT/test_full.yaml" >/dev/null 2>&1 || true
if [ -f "$SOURCE_DIR/encrypted_private_test_full.yaml.age" ]; then
    pass "Option 1 passed"
else
    fail "Option 1 failed: encrypted file not found in source"
fi

# 4. Test Option 2: SOPS Strategy (YAML)
echo "Testing Option 2 (SOPS - YAML)..."
cat <<'EOF' > "$TEST_ROOT/test_data.yaml"
app_name: MyTestApp
API_KEY: yaml-secret-key
port: 8080
db_password: yaml-db-pass
EOF
export TEST_CHOICE=2
chezmoi add "$TEST_ROOT/test_data.yaml" >/dev/null 2>&1 || true
YAML_TMPL=$(template_source_path "$TEST_ROOT/test_data.yaml")
YAML_SOPS=$(sops_source_path "$TEST_ROOT/test_data.yaml")
if [ -f "$YAML_TMPL" ] && sops --decrypt "$YAML_SOPS" | grep -q "yaml-secret-key"; then
    pass "Option 2 (YAML) passed"
else
    fail "Option 2 (YAML) failed"
fi

# 5. Test Option 2: SOPS Strategy (JSON)
echo "Testing Option 2 (SOPS - JSON)..."
cat <<'EOF' > "$TEST_ROOT/test_data.json"
{
  "app_name": "MyTestApp",
  "API_KEY": "json-secret-key",
  "port": 8080,
  "db_password": "json-db-pass"
}
EOF
chezmoi add "$TEST_ROOT/test_data.json" >/dev/null 2>&1 || true
JSON_TMPL=$(template_source_path "$TEST_ROOT/test_data.json")
JSON_SOPS=$(sops_source_path "$TEST_ROOT/test_data.json")
if [ -f "$JSON_TMPL" ] && sops --decrypt "$JSON_SOPS" | grep -q "json-secret-key"; then
    pass "Option 2 (JSON) passed"
else
    fail "Option 2 (JSON) failed"
fi

# 6. Test Option 2: SOPS Strategy (TOML)
echo "Testing Option 2 (SOPS - TOML)..."
cat <<'EOF' > "$TEST_ROOT/test_data.toml"
app_name = "MyTestApp"
API_KEY = "toml-secret-key"
port = 8080
db_password = "toml-db-pass"
EOF
chezmoi add "$TEST_ROOT/test_data.toml" >/dev/null 2>&1 || true
TOML_TMPL=$(template_source_path "$TEST_ROOT/test_data.toml")
TOML_SOPS=$(sops_source_path "$TEST_ROOT/test_data.toml")
if [ -f "$TOML_TMPL" ] && sops --decrypt "$TOML_SOPS" | grep -q "toml-secret-key"; then
    pass "Option 2 (TOML) passed"
else
    fail "Option 2 (TOML) failed"
fi

# 7. Test Option 2: SOPS Strategy (Subdirectory)
echo "Testing Option 2 (Subdirectory)..."
mkdir -p "$TEST_ROOT/.config/test_dir"
cat <<'EOF' > "$TEST_ROOT/.config/test_dir/test_sub.yaml"
API_KEY: sub-secret-key
EOF
chezmoi add "$TEST_ROOT/.config/test_dir/test_sub.yaml" >/dev/null 2>&1 || true
SUB_TMPL=$(template_source_path "$TEST_ROOT/.config/test_dir/test_sub.yaml")
SUB_SOPS=$(sops_source_path "$TEST_ROOT/.config/test_dir/test_sub.yaml")
if [ -f "$SUB_TMPL" ] && sops --decrypt "$SUB_SOPS" | grep -q "sub-secret-key"; then
    pass "Option 2 (Subdirectory) passed"
else
    echo "Expected secret at: $SUB_SOPS"
    fail "Option 2 (Subdirectory) failed"
fi

# 8. Test Option 2: SOPS Strategy follows chezmoi source naming

echo "Testing Option 2 (chezmoi source naming)..."
mkdir -p "$HOME/.pi/agent/themes/test_check_secrets"
cat <<'EOF' > "$HOME/.pi/agent/themes/test_check_secrets/catppuccin-mocha.json"
{
  "API_KEY": "theme-secret-key",
  "name": "Catppuccin Mocha"
}
EOF
chezmoi add "$HOME/.pi/agent/themes/test_check_secrets/catppuccin-mocha.json" >/dev/null 2>&1 || true
if [ -f "$SOURCE_DIR/private_dot_pi/private_agent/private_themes/private_test_check_secrets/private_catppuccin-mocha.json.tmpl" ] \
   && sops --decrypt "$SOURCE_DIR/secrets/private_dot_pi/private_agent/private_themes/private_test_check_secrets/private_catppuccin-mocha.json.sops.yaml" | grep -q "theme-secret-key"; then
    pass "Option 2 (chezmoi source naming) passed"
else
    fail "Option 2 (chezmoi source naming) failed"
fi

echo "All tests passed successfully!"
