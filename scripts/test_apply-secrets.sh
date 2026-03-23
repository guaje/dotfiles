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
    rm -f test_data.yaml test_data.json test_data.toml
    rm -rf .config/test_dir
    
    # Clean source directory - find all files/dirs with 'test_data' or 'test_sub' in their name
    find "$SOURCE_DIR" -name "*test_data*" -exec rm -rf {} +
    find "$SOURCE_DIR" -name "*test_sub*" -exec rm -rf {} +
}

trap cleanup EXIT

# We explicitly DO NOT export SOPS_AGE_KEY_FILE here to test chezmoi.toml integration.
# However, for 'chezmoi add', the hook might need it if it's not inherited.
# Actually, the hook is run by bash, and chezmoi.toml [env] should handle it for chezmoi commands.
# Let's see if the hook works without it. If not, we'll only export it for 'add' and unset it for 'apply'.

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
# We export it briefly for the 'add' phase just in case, but will unset for 'apply'
export SOPS_AGE_KEY_FILE="$HOME/.config/chezmoi/key.txt"
set +e
chezmoi add test_data.yaml >/dev/null 2>&1
set -e
# check-secrets.sh already deleted the file

# Unset to ensure we test chezmoi.toml's [env] and [secret]
unset SOPS_AGE_KEY_FILE

chezmoi apply test_data.yaml >/dev/null 2>&1
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
export SOPS_AGE_KEY_FILE="$HOME/.config/chezmoi/key.txt"
set +e
chezmoi add test_data.json >/dev/null 2>&1
set -e
unset SOPS_AGE_KEY_FILE

chezmoi apply test_data.json >/dev/null 2>&1
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
export SOPS_AGE_KEY_FILE="$HOME/.config/chezmoi/key.txt"
set +e
chezmoi add test_data.toml >/dev/null 2>&1
set -e
unset SOPS_AGE_KEY_FILE

chezmoi apply test_data.toml >/dev/null 2>&1
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
export SOPS_AGE_KEY_FILE="$HOME/.config/chezmoi/key.txt"
set +e
chezmoi add .config/test_dir/test_sub.yaml >/dev/null 2>&1
set -e
unset SOPS_AGE_KEY_FILE

chezmoi apply .config/test_dir/test_sub.yaml >/dev/null 2>&1
if grep -q "sub-secret-key" .config/test_dir/test_sub.yaml; then
    echo "✅ Apply Rendering (Subdirectory) passed"
else
    echo "❌ Apply Rendering (Subdirectory) failed"
    exit 1
fi

echo "All apply-rendering tests passed successfully!"
