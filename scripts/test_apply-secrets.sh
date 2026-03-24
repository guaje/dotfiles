#!/usr/bin/env bash

# Test script for check-secrets.sh (Option 2 - Apply Verification)
# Verifies that 'chezmoi apply' correctly renders secrets using SOPS and templates.
# Relying on chezmoi.toml configuration for SOPS_AGE_KEY_FILE and secret command.

set -e

SOURCE_DIR=$(chezmoi source-path)

# Helper function to clean up test files
cleanup() {
    echo "Cleaning up test files..."
    # Clean home directory
    rm -f test_data.yaml test_data.json test_data.toml 2>/dev/null
    rm -rf .config/test_dir 2>/dev/null
    
    # Clean source directory - handle specific test prefixes surgically
    for prefix in test_data test_sub; do
        # Remove files in the root of the source dir with these prefixes
        find "$SOURCE_DIR" -maxdepth 1 -name "*${prefix}*" -exec rm -rf {} + 2>/dev/null
        # Remove files in the secrets dir with these prefixes
        if [ -d "$SOURCE_DIR/secrets" ]; then
            find "$SOURCE_DIR/secrets" -maxdepth 1 -name "*${prefix}*" -exec rm -rf {} + 2>/dev/null
        fi
    done
    
    # Specifically clean the test_dir in dot_config
    rm -rf "$SOURCE_DIR/dot_config/private_test_dir" 2>/dev/null
}

trap cleanup EXIT

echo "Starting apply-rendering tests for check-secrets.sh (Option 2)..."

# 1. Test Option 2: SOPS Strategy (YAML)
echo "Testing Apply Rendering (YAML)..."
cat <<EOF > test_data.yaml
app_name: MyTestApp
API_KEY: yaml-secret-key
port: 8080
db_password: yaml-db-pass
EOF
export TEST_CHOICE=2

set +e
chezmoi add test_data.yaml >/dev/null 2>&1
set -e
# Ensure file is gone before apply to avoid prompt and ensure it's recreated
rm -f test_data.yaml

# Relying on chezmoi.toml [env] for SOPS_AGE_KEY_FILE during apply
chezmoi apply --force test_data.yaml >/dev/null 2>&1
if grep -q "yaml-secret-key" test_data.yaml; then
    echo "✅ Apply Rendering (YAML) passed"
else
    echo "❌ Apply Rendering (YAML) failed"
    exit 1
fi

# 2. Test Option 2: SOPS Strategy (JSON)
echo "Testing Apply Rendering (JSON)..."
cat <<EOF > test_data.json
{
  "app_name": "MyTestApp",
  "API_KEY": "json-secret-key",
  "port": 8080,
  "db_password": "json-db-pass"
}
EOF
set +e
chezmoi add test_data.json >/dev/null 2>&1
set -e
rm -f test_data.json

chezmoi apply --force test_data.json >/dev/null 2>&1
if grep -q "json-secret-key" test_data.json; then
    echo "✅ Apply Rendering (JSON) passed"
else
    echo "❌ Apply Rendering (JSON) failed"
    exit 1
fi

# 3. Test Option 2: SOPS Strategy (TOML)
echo "Testing Apply Rendering (TOML)..."
cat <<EOF > test_data.toml
app_name = "MyTestApp"
API_KEY = "toml-secret-key"
port = 8080
db_password = "toml-db-pass"
EOF
set +e
chezmoi add test_data.toml >/dev/null 2>&1
set -e
rm -f test_data.toml

chezmoi apply --force test_data.toml >/dev/null 2>&1
if grep -q "toml-secret-key" test_data.toml; then
    echo "✅ Apply Rendering (TOML) passed"
else
    echo "❌ Apply Rendering (TOML) failed"
    exit 1
fi

# 4. Test Option 2: SOPS Strategy (Subdirectory)
echo "Testing Apply Rendering (Subdirectory)..."
mkdir -p .config/test_dir
cat <<EOF > .config/test_dir/test_sub.yaml
API_KEY: sub-secret-key
EOF
set +e
chezmoi add .config/test_dir/test_sub.yaml >/dev/null 2>&1
set -e
rm -f .config/test_dir/test_sub.yaml

chezmoi apply --force .config/test_dir/test_sub.yaml >/dev/null 2>&1
if grep -q "sub-secret-key" .config/test_dir/test_sub.yaml; then
    echo "✅ Apply Rendering (Subdirectory) passed"
else
    echo "❌ Apply Rendering (Subdirectory) failed"
    exit 1
fi

echo "All apply-rendering tests passed successfully!"
