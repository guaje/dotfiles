#!/usr/bin/env bash

# Test script for check-secrets.sh
# Automates testing of all 4 options and multiple file formats.

set -e

SOURCE_DIR=$(chezmoi source-path)
CHECK_SECRETS_SCRIPT="$SOURCE_DIR/scripts/check-secrets.sh"
export SOPS_AGE_KEY_FILE="$HOME/.config/chezmoi/key.txt"

# Helper function to clean up test files
cleanup() {
    echo "Cleaning up test files..."
    # Clean home directory
    rm -f test_data.yaml test_data.json test_data.toml 2>/dev/null
    rm -rf .config/test_dir 2>/dev/null
    rm -f test_abort.yaml test_plain.yaml test_full.yaml 2>/dev/null
    
    # Clean source directory - handle specific test prefixes surgically
    for prefix in test_abort test_plain test_full test_data test_sub; do
        # Remove files in the root of the source dir with these prefixes (including private_ and encrypted_)
        find "$SOURCE_DIR" -maxdepth 1 \( -name "*${prefix}*" -o -name "private_*${prefix}*" -o -name "encrypted_*${prefix}*" \) -exec rm -rf {} + 2>/dev/null
        # Remove files in the secrets dir with these prefixes
        if [ -d "$SOURCE_DIR/secrets" ]; then
            find "$SOURCE_DIR/secrets" -name "*${prefix}*" -exec rm -rf {} + 2>/dev/null
        fi
    done
    
    # Specifically clean the test_dir in dot_config (including private_ prefix)
    rm -rf "$SOURCE_DIR/dot_config/test_dir" "$SOURCE_DIR/dot_config/private_test_dir" 2>/dev/null
}

trap cleanup EXIT

echo "Starting tests for check-secrets.sh..."

# 1. Test Option 4: Abort
echo "Testing Option 4 (Abort)..."
echo "AUTH: abort-test" > test_abort.yaml
export TEST_CHOICE=4
if chezmoi add test_abort.yaml 2>/dev/null; then
    echo "❌ Option 4 failed: chezmoi add should have been aborted"
    exit 1
else
    echo "✅ Option 4 passed"
fi

# 2. Test Option 3: Plain
echo "Testing Option 3 (Plain)..."
echo "SECRET: plain-test" > test_plain.yaml
export TEST_CHOICE=3
if chezmoi add test_plain.yaml; then
    echo "✅ Option 3 passed"
else
    echo "❌ Option 3 failed"
    exit 1
fi

# 3. Test Option 1: Full Encryption
echo "Testing Option 1 (Full Encryption)..."
echo "API_KEY: full-encrypt-test" > test_full.yaml
export TEST_CHOICE=1
set +e
chezmoi add test_full.yaml >/dev/null 2>&1
set -e
if ls "$SOURCE_DIR/encrypted_private_test_full.yaml.age" >/dev/null 2>&1; then
    echo "✅ Option 1 passed"
else
    echo "❌ Option 1 failed: encrypted file not found in source"
    exit 1
fi

# 4. Test Option 2: SOPS Strategy (YAML)
echo "Testing Option 2 (SOPS - YAML)..."
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
# Expected path: secrets/test_data.yaml.sops.yaml (no dot_ because it's not a dotfile)
if sops --decrypt "$SOURCE_DIR/secrets/test_data.yaml.sops.yaml" | grep -q "yaml-secret-key"; then
    echo "✅ Option 2 (YAML) passed"
else
    echo "❌ Option 2 (YAML) failed"
    exit 1
fi

# 5. Test Option 2: SOPS Strategy (JSON)
echo "Testing Option 2 (SOPS - JSON)..."
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
if sops --decrypt "$SOURCE_DIR/secrets/test_data.json.sops.yaml" | grep -q "json-secret-key"; then
    echo "✅ Option 2 (JSON) passed"
else
    echo "❌ Option 2 (JSON) failed"
    exit 1
fi

# 6. Test Option 2: SOPS Strategy (TOML)
echo "Testing Option 2 (SOPS - TOML)..."
cat <<EOF > test_data.toml
app_name = "MyTestApp"
API_KEY = "toml-secret-key"
port = 8080
db_password = "toml-db-pass"
EOF
set +e
chezmoi add test_data.toml >/dev/null 2>&1
set -e
if sops --decrypt "$SOURCE_DIR/secrets/test_data.toml.sops.yaml" | grep -q "toml-secret-key"; then
    echo "✅ Option 2 (TOML) passed"
else
    echo "❌ Option 2 (TOML) failed"
    exit 1
fi

# 7. Test Option 2: SOPS Strategy (Subdirectory)
echo "Testing Option 2 (Subdirectory)..."
mkdir -p .config/test_dir
cat <<EOF > .config/test_dir/test_sub.yaml
API_KEY: sub-secret-key
EOF
set +e
chezmoi add .config/test_dir/test_sub.yaml >/dev/null 2>&1
set -e
# Expected path: secrets/dot_config/test_dir/test_sub.yaml.sops.yaml
if sops --decrypt "$SOURCE_DIR/secrets/dot_config/test_dir/test_sub.yaml.sops.yaml" | grep -q "sub-secret-key"; then
    echo "✅ Option 2 (Subdirectory) passed"
else
    echo "❌ Option 2 (Subdirectory) failed"
    echo "Expected secret at: $SOURCE_DIR/secrets/dot_config/test_dir/test_sub.yaml.sops.yaml"
    exit 1
fi

echo "All tests passed successfully!"
