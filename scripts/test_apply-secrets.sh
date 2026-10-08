#!/usr/bin/env bash

# Isolated apply-rendering integration test.
set -euo pipefail
SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091 # Sourced dynamically from the script directory.
. "$SCRIPT_DIR/test_fixture.sh"
setup_secret_fixture
export TEST_CHOICE=2

cleanup() {
    echo "Cleaning up test files..."
    finish_secret_fixture || exit 1
}

fail() {
    echo "❌ $1" >&2
    exit 1
}

pass() {
    echo "✅ $1"
}

trap cleanup EXIT HUP INT TERM

echo "Starting apply-rendering tests for check-secrets.sh (Option 2)..."

assert_hook_launcher_contract || fail 'hook launcher contract failed'
pass "hook configuration passed"

# 1. Test Option 2: SOPS Strategy (YAML)
echo "Testing Apply Rendering (YAML)..."
prepare_test_dirs
write_option2_yaml_fixture

echo "Running: chezmoi add $TEST_ROOT/test_data.yaml"
run_chezmoi_add 2 "$TEST_ROOT/test_data.yaml" || true
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
write_option2_json_fixture
run_chezmoi_add 2 "$TEST_ROOT/test_data.json" || true
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
write_option2_toml_fixture
run_chezmoi_add 2 "$TEST_ROOT/test_data.toml" || true
rm -f "$TEST_ROOT/test_data.toml"

if chezmoi apply --force "$TEST_ROOT/test_data.toml" \
    && [ -f "$TEST_ROOT/test_data.toml" ] \
    && grep -q "toml-secret-key" "$TEST_ROOT/test_data.toml" \
    && grep -q "toml-db-pass" "$TEST_ROOT/test_data.toml"; then
    pass "Apply Rendering (TOML) passed"
else
    fail "Apply Rendering (TOML) failed"
fi

# 4. Test Option 2: SOPS Strategy (duplicate sensitive keys)
echo "Testing Apply Rendering (duplicate sensitive keys)..."
prepare_test_dirs
write_option2_duplicate_fixture
run_chezmoi_add 2 "$TEST_ROOT/test_multi.json" || true
rm -f "$TEST_ROOT/test_multi.json"

if chezmoi apply --force "$TEST_ROOT/test_multi.json" \
    && [ -f "$TEST_ROOT/test_multi.json" ] \
    && grep -q '"password": "password1"' "$TEST_ROOT/test_multi.json" \
    && grep -q '"password": "password2"' "$TEST_ROOT/test_multi.json"; then
    pass "Apply Rendering (duplicate sensitive keys) passed"
else
    fail "Apply Rendering (duplicate sensitive keys) failed"
fi

# 5. Test Option 2: SOPS Strategy (Subdirectory)
echo "Testing Apply Rendering (Subdirectory)..."
prepare_test_dirs
write_option2_subdirectory_fixture
run_chezmoi_add 2 "$CONFIG_TEST_ROOT/test_sub.yaml" || true
rm -f "$CONFIG_TEST_ROOT/test_sub.yaml"

if chezmoi apply --force "$CONFIG_TEST_ROOT/test_sub.yaml" \
    && [ -f "$CONFIG_TEST_ROOT/test_sub.yaml" ] \
    && grep -q "sub-secret-key" "$CONFIG_TEST_ROOT/test_sub.yaml" \
    && grep -q "sub-db-pass" "$CONFIG_TEST_ROOT/test_sub.yaml"; then
    pass "Apply Rendering (Subdirectory) passed"
else
    fail "Apply Rendering (Subdirectory) failed"
fi

# 6. Test Option 2: chezmoi source naming
echo "Testing Apply Rendering (chezmoi source naming)..."
prepare_test_dirs
write_option2_source_naming_fixture
run_chezmoi_add 2 "$SOURCE_NAMING_TEST_ROOT/test_chezmoi_naming.json" || true
rm -f "$SOURCE_NAMING_TEST_ROOT/test_chezmoi_naming.json"

if chezmoi apply --force "$SOURCE_NAMING_TEST_ROOT/test_chezmoi_naming.json" \
    && [ -f "$SOURCE_NAMING_TEST_ROOT/test_chezmoi_naming.json" ] \
    && grep -q "chezmoi-naming-secret" "$SOURCE_NAMING_TEST_ROOT/test_chezmoi_naming.json" \
    && grep -q "chezmoi-naming-test" "$SOURCE_NAMING_TEST_ROOT/test_chezmoi_naming.json"; then
    pass "Apply Rendering (chezmoi source naming) passed"
else
    fail "Apply Rendering (chezmoi source naming) failed"
fi

echo "All apply-rendering tests passed successfully!"
