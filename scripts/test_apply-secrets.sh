#!/bin/sh

# Portable test script for check-secrets.sh apply verification.
# Verifies that `chezmoi apply` correctly renders secrets using SOPS and templates.

set -eu

SOURCE_DIR=$(chezmoi source-path)
TEST_ROOT="$HOME/.test"
CONFIG_TEST_ROOT="$HOME/.config/test"
export SOPS_AGE_KEY_FILE="$HOME/.config/chezmoi/key.txt"
export TEST_CHOICE=2

cleanup() {
    echo "Cleaning up test files..."

    rm -rf "$TEST_ROOT" "$CONFIG_TEST_ROOT" 2>/dev/null || true

    for prefix in test_data test_sub; do
        find "$SOURCE_DIR" -maxdepth 2 \( -name "*${prefix}*" -o -name "private_*${prefix}*" -o -name "encrypted_*${prefix}*" \) -exec rm -rf {} + 2>/dev/null || true
        if [ -d "$SOURCE_DIR/secrets" ]; then
            find "$SOURCE_DIR/secrets" -name "*${prefix}*" -exec rm -rf {} + 2>/dev/null || true
        fi
    done

    rm -rf "$SOURCE_DIR/dot_test" "$SOURCE_DIR/private_dot_test" 2>/dev/null || true
    rm -rf "$SOURCE_DIR/dot_config/test" "$SOURCE_DIR/dot_config/private_test" 2>/dev/null || true
}

prepare_test_dirs() {
    cleanup
    mkdir -p "$TEST_ROOT" "$CONFIG_TEST_ROOT"
}

fail() {
    echo "❌ $1"
    exit 1
}

pass() {
    echo "✅ $1"
}

trap cleanup EXIT HUP INT TERM

echo "Starting apply-rendering tests for check-secrets.sh (Option 2)..."

# 1. Test Option 2: SOPS Strategy (YAML)
echo "Testing Apply Rendering (YAML)..."
prepare_test_dirs
cat <<'EOF' > "$TEST_ROOT/test_data.yaml"
app_name: MyTestApp
API_KEY: yaml-secret-key
port: 8080
db_password: yaml-db-pass
EOF

echo "Running: chezmoi add $TEST_ROOT/test_data.yaml"
chezmoi add "$TEST_ROOT/test_data.yaml" || true
rm -f "$TEST_ROOT/test_data.yaml"

echo "Running: chezmoi apply --force $TEST_ROOT/test_data.yaml"
if chezmoi apply --force "$TEST_ROOT/test_data.yaml" \
    && [ -f "$TEST_ROOT/test_data.yaml" ] \
    && grep -q "yaml-secret-key" "$TEST_ROOT/test_data.yaml" \
    && grep -q "yaml-db-pass" "$TEST_ROOT/test_data.yaml"; then
    pass "Apply Rendering (YAML) passed"
else
    fail "Apply Rendering (YAML) failed"
fi

# 2. Test Option 2: SOPS Strategy (JSON)
echo "Testing Apply Rendering (JSON)..."
prepare_test_dirs
cat <<'EOF' > "$TEST_ROOT/test_data.json"
{
  "app_name": "MyTestApp",
  "API_KEY": "json-secret-key",
  "port": 8080,
  "db_password": "json-db-pass"
}
EOF
chezmoi add "$TEST_ROOT/test_data.json" || true
rm -f "$TEST_ROOT/test_data.json"

if chezmoi apply --force "$TEST_ROOT/test_data.json" \
    && [ -f "$TEST_ROOT/test_data.json" ] \
    && grep -q "json-secret-key" "$TEST_ROOT/test_data.json" \
    && grep -q "json-db-pass" "$TEST_ROOT/test_data.json"; then
    pass "Apply Rendering (JSON) passed"
else
    fail "Apply Rendering (JSON) failed"
fi

# 3. Test Option 2: SOPS Strategy (TOML)
echo "Testing Apply Rendering (TOML)..."
prepare_test_dirs
cat <<'EOF' > "$TEST_ROOT/test_data.toml"
app_name = "MyTestApp"
API_KEY = "toml-secret-key"
port = 8080
db_password = "toml-db-pass"
EOF
chezmoi add "$TEST_ROOT/test_data.toml" || true
rm -f "$TEST_ROOT/test_data.toml"

if chezmoi apply --force "$TEST_ROOT/test_data.toml" \
    && [ -f "$TEST_ROOT/test_data.toml" ] \
    && grep -q "toml-secret-key" "$TEST_ROOT/test_data.toml" \
    && grep -q "toml-db-pass" "$TEST_ROOT/test_data.toml"; then
    pass "Apply Rendering (TOML) passed"
else
    fail "Apply Rendering (TOML) failed"
fi

# 4. Test Option 2: SOPS Strategy (Subdirectory)
echo "Testing Apply Rendering (Subdirectory)..."
prepare_test_dirs
cat <<'EOF' > "$CONFIG_TEST_ROOT/test_sub.yaml"
API_KEY: sub-secret-key
db_password: sub-db-pass
EOF
chezmoi add "$CONFIG_TEST_ROOT/test_sub.yaml" || true
rm -f "$CONFIG_TEST_ROOT/test_sub.yaml"

if chezmoi apply --force "$CONFIG_TEST_ROOT/test_sub.yaml" \
    && [ -f "$CONFIG_TEST_ROOT/test_sub.yaml" ] \
    && grep -q "sub-secret-key" "$CONFIG_TEST_ROOT/test_sub.yaml" \
    && grep -q "sub-db-pass" "$CONFIG_TEST_ROOT/test_sub.yaml"; then
    pass "Apply Rendering (Subdirectory) passed"
else
    fail "Apply Rendering (Subdirectory) failed"
fi

echo "All apply-rendering tests passed successfully!"
