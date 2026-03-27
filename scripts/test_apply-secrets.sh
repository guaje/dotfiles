#!/bin/sh

# Portable test script for check-secrets.sh apply verification.
# Verifies that `chezmoi apply` correctly renders secrets using SOPS and templates.

set -eu

SOURCE_DIR=$(chezmoi source-path)
export SOPS_AGE_KEY_FILE="$HOME/.config/chezmoi/key.txt"
export TEST_CHOICE=2

cleanup() {
    echo "Cleaning up test files..."

    rm -f test_data.yaml test_data.json test_data.toml 2>/dev/null || true
    rm -rf .config/test_dir 2>/dev/null || true

    for prefix in test_data test_sub; do
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

trap cleanup EXIT HUP INT TERM

echo "Starting apply-rendering tests for check-secrets.sh (Option 2)..."

# 1. Test Option 2: SOPS Strategy (YAML)
echo "Testing Apply Rendering (YAML)..."
cat <<'EOF' > test_data.yaml
app_name: MyTestApp
API_KEY: yaml-secret-key
port: 8080
db_password: yaml-db-pass
EOF

echo "Running: chezmoi add test_data.yaml"
chezmoi add test_data.yaml || true
rm -f test_data.yaml

echo "Running: chezmoi apply --force test_data.yaml"
if chezmoi apply --force test_data.yaml \
    && [ -f test_data.yaml ] \
    && grep -q "yaml-secret-key" test_data.yaml \
    && grep -q "yaml-db-pass" test_data.yaml; then
    pass "Apply Rendering (YAML) passed"
else
    fail "Apply Rendering (YAML) failed"
fi

# 2. Test Option 2: SOPS Strategy (JSON)
echo "Testing Apply Rendering (JSON)..."
cat <<'EOF' > test_data.json
{
  "app_name": "MyTestApp",
  "API_KEY": "json-secret-key",
  "port": 8080,
  "db_password": "json-db-pass"
}
EOF
chezmoi add test_data.json || true
rm -f test_data.json

if chezmoi apply --force test_data.json \
    && [ -f test_data.json ] \
    && grep -q "json-secret-key" test_data.json \
    && grep -q "json-db-pass" test_data.json; then
    pass "Apply Rendering (JSON) passed"
else
    fail "Apply Rendering (JSON) failed"
fi

# 3. Test Option 2: SOPS Strategy (TOML)
echo "Testing Apply Rendering (TOML)..."
cat <<'EOF' > test_data.toml
app_name = "MyTestApp"
API_KEY = "toml-secret-key"
port = 8080
db_password = "toml-db-pass"
EOF
chezmoi add test_data.toml || true
rm -f test_data.toml

if chezmoi apply --force test_data.toml \
    && [ -f test_data.toml ] \
    && grep -q "toml-secret-key" test_data.toml \
    && grep -q "toml-db-pass" test_data.toml; then
    pass "Apply Rendering (TOML) passed"
else
    fail "Apply Rendering (TOML) failed"
fi

# 4. Test Option 2: SOPS Strategy (Subdirectory)
echo "Testing Apply Rendering (Subdirectory)..."
mkdir -p .config/test_dir
cat <<'EOF' > .config/test_dir/test_sub.yaml
API_KEY: sub-secret-key
db_password: sub-db-pass
EOF
chezmoi add .config/test_dir/test_sub.yaml || true
rm -f .config/test_dir/test_sub.yaml

if chezmoi apply --force .config/test_dir/test_sub.yaml \
    && [ -f .config/test_dir/test_sub.yaml ] \
    && grep -q "sub-secret-key" .config/test_dir/test_sub.yaml \
    && grep -q "sub-db-pass" .config/test_dir/test_sub.yaml; then
    pass "Apply Rendering (Subdirectory) passed"
else
    fail "Apply Rendering (Subdirectory) failed"
fi

echo "All apply-rendering tests passed successfully!"
