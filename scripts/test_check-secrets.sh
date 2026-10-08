#!/usr/bin/env bash

# Isolated integration test for check-secrets.sh.
set -euo pipefail
SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091 # Sourced dynamically from the script directory.
. "$SCRIPT_DIR/test_fixture.sh"
setup_secret_fixture
NEWLINE_TEST_FILE="$TEST_ROOT/test_newline
sensitive.yaml"
export SOPS_AGE_KEY_FILE="$HOME/.config/chezmoi/key.txt"

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

echo "Starting tests for check-secrets.sh..."

# Hook launchers are a checked-in configuration contract, not fixture setup.
echo "Testing hook configuration..."
assert_hook_launcher_contract || fail 'hook launcher contract failed'
pass "hook configuration passed"

# source-path must predict add's eventual mapping before partial encryption is allowed
# to install its template. Cover normal, hidden, nested, executable and private
# destination cases supported by this chezmoi version.
echo "Testing prospective source-path compatibility..."
for oracle in "$HOME/oracle-normal" "$HOME/.oracle-hidden" "$HOME/.config/oracle/nested" "$HOME/oracle-executable" "$HOME/oracle-private"; do
    mkdir -p "$(dirname "$oracle")"
    printf 'oracle\n' > "$oracle"
    case $oracle in *executable) chmod 700 "$oracle" ;; *private) chmod 600 "$oracle" ;; esac
    expected=$(prospective_fixture_mapping "$oracle")
    CHECK_SECRETS_BYPASS=1 chezmoi add "$oracle"
    actual=$(chezmoi source-path "$oracle")
    [[ $expected == "$actual" ]] || fail "source-path was not prospective for $oracle (expected=$expected actual=$actual)"
done
find "$SOURCE_DIR/." -name '*oracle*' -exec rm -rf {} + || true
rm -rf "$HOME/oracle-normal" "$HOME/.oracle-hidden" "$HOME/.config/oracle" "$HOME/oracle-executable" "$HOME/oracle-private"
pass "prospective source-path compatibility passed"

# Aborting previews the finding but publishes nothing.
echo "Testing abort behavior..."
prepare_test_dirs
CANARY='CHECK_SECRETS_CANARY_may_be_previewed'
printf '%s\n' "AUTH: $CANARY" > "$TEST_ROOT/test_abort.yaml"
status=0
ABORT_OUTPUT=$(run_chezmoi_add 4 "$TEST_ROOT/test_abort.yaml" 2>&1) || status=$?
# The preview intentionally echoes the matching line so the user can identify
# it; assert that it is shown and that nothing is published to the source.
if ! printf '%s' "$ABORT_OUTPUT" | grep -Fq "$CANARY"; then
    fail "Sensitive line preview did not show the matching line"
fi
if find "$SOURCE_DIR/." -type f -exec grep -Fql "$CANARY" {} + | grep -q .; then
    fail "Secret canary was written to the chezmoi source directory"
fi
[[ $status -ne 0 ]] || fail "abort choice allowed chezmoi add to continue"
pass "abort behavior passed"

# A filename containing a newline must still be scanned before add.
echo "Testing newline path secret detection..."
printf '%s\n' 'SECRET: newline-path-secret' > "$NEWLINE_TEST_FILE"
NEWLINE_OUTPUT=$(TEST_CHOICE=4 "$SOURCE_DIR/scripts/check-secrets.sh" add "$NEWLINE_TEST_FILE" 2>&1 || true)
if printf '%s' "$NEWLINE_OUTPUT" | grep -q 'Sensitive information detected'; then
    pass "newline path secret detection passed"
else
    printf '%s\n' "$NEWLINE_OUTPUT"
    fail "newline path secret detection failed"
fi

# Plain selection leaves an exact, non-template source entry and no sidecar.
echo "Testing plain add behavior..."
prepare_test_dirs
printf '%s\n' 'SECRET: plain-test' > "$TEST_ROOT/test_plain.yaml"
run_chezmoi_add 3 "$TEST_ROOT/test_plain.yaml" || fail 'plain selection did not complete the add'
PLAIN_SOURCE=$(template_source_path "$TEST_ROOT/test_plain.yaml")
PLAIN_SOPS=$(sops_source_path "$TEST_ROOT/test_plain.yaml")
[[ -f $PLAIN_SOURCE ]] || fail 'plain selection did not create a source entry'
cmp -s "$TEST_ROOT/test_plain.yaml" "$PLAIN_SOURCE" || fail 'plain source entry differs from its input'
[[ $PLAIN_SOURCE != *.tmpl ]] || fail 'plain selection created a template'
[[ ! -e $PLAIN_SOPS ]] || fail 'plain selection created a SOPS sidecar'
pass "plain add behavior passed"

# Full encryption produces a private encrypted source entry that round-trips.
echo "Testing full encryption behavior..."
prepare_test_dirs
printf '%s\n' 'API_KEY: full-encrypt-test' > "$TEST_ROOT/test_full.yaml"
run_chezmoi_add 1 "$TEST_ROOT/test_full.yaml" >/dev/null 2>&1 || true
FULL_SOURCE=$(find "$SOURCE_DIR/." -maxdepth 2 -type f -name '*test_full*' -print -quit)
case $(basename "$FULL_SOURCE") in
    encrypted_private_*) ;;
    *) fail "full encryption source entry is not private and encrypted" ;;
esac
# A successful age round-trip already proves the ciphertext is not plaintext.
if [ -f "$FULL_SOURCE" ] \
   && [ "$(find "$SOURCE_DIR/." -maxdepth 2 -type f -name '*test_full*' | wc -l)" -eq 1 ] \
   && age --decrypt --identity "$SOPS_AGE_KEY_FILE" "$FULL_SOURCE" 2>/dev/null | grep -Fxq 'API_KEY: full-encrypt-test'; then
    pass "full encryption behavior passed"
else
    fail "full encryption did not safely round-trip"
fi

# The mapping oracle must honor the command's non-default destination for its
# source-path lookups as well as its sacrificial add.
echo "Testing partial encryption with a custom destination..."
CUSTOM_DEST="$TEST_FIXTURE/custom-destination"
mkdir -p "$CUSTOM_DEST"
printf '%s\n' 'API_KEY: custom-destination-secret' > "$CUSTOM_DEST/test_custom_destination.yaml"
CUSTOM_TARGET="$CUSTOM_DEST/test_custom_destination.yaml"
CUSTOM_SOURCE=$(prospective_fixture_mapping "$CUSTOM_TARGET" "$CUSTOM_DEST")
CUSTOM_SOURCE=${CUSTOM_SOURCE%.literal}
CHEZMOI_DEST_DIR="$CUSTOM_DEST" TEST_CHOICE=2 \
    "$SOURCE_DIR/scripts/check-secrets.sh" add "$CUSTOM_TARGET" >/dev/null 2>&1 || true
CUSTOM_CIPHER="$SOURCE_DIR/secrets/${CUSTOM_SOURCE#"$SOURCE_DIR"/}.sops.yaml"
if [ -f "$CUSTOM_SOURCE.tmpl" ] && [ -f "$CUSTOM_CIPHER" ] \
   && sops --decrypt "$CUSTOM_CIPHER" | grep -Fq 'custom-destination-secret' \
   && ! grep -Fq 'custom-destination-secret' "$CUSTOM_SOURCE.tmpl"; then
    pass "custom destination mapping passed"
else
    fail "custom destination mapping failed"
fi

# Signals at either side of the sacrificial add must remove the tracked oracle,
# including the short-lived plaintext source copy created by add.
echo "Testing mapping oracle signal cleanup..."
ORACLE_TMP="$TEST_FIXTURE/oracle-tmp"
mkdir -p "$ORACLE_TMP"
for failpoint in term-after-oracle-create term-after-oracle-add; do
    target="$TEST_ROOT/oracle-$failpoint.yaml"
    canary="ORACLE_CANARY_${failpoint}"
    printf 'API_KEY: %s\n' "$canary" > "$target"
    TMPDIR="$ORACLE_TMP" CHECK_SECRETS_FAILPOINT=$failpoint TEST_CHOICE=2 \
        "$SOURCE_DIR/scripts/check-secrets.sh" add "$target" >/dev/null 2>&1 || true
    if find "$ORACLE_TMP" -maxdepth 1 -name 'check-secrets-oracle.*' -print -quit | grep -q .; then
        fail "$failpoint left its mapping oracle behind"
    fi
    if grep -R -Fq "$canary" "$ORACLE_TMP" 2>/dev/null; then
        fail "$failpoint left oracle plaintext behind"
    fi
done
pass "mapping oracle signal cleanup passed"

# Partial encryption creates a generated YAML template and stable sidecar.
echo "Testing partial YAML encryption..."
prepare_test_dirs
write_option2_yaml_fixture
YAML_OUTPUT=$(run_chezmoi_add 2 "$TEST_ROOT/test_data.yaml" 2>&1 || true)
if ! printf '%s' "$YAML_OUTPUT" | grep -Fq 'yaml-secret-key'; then
    fail "partial encryption did not preview the matching sensitive line"
fi
YAML_TMPL=$(template_source_path "$TEST_ROOT/test_data.yaml")
YAML_SOPS=$(sops_source_path "$TEST_ROOT/test_data.yaml")
if [ -f "$YAML_TMPL" ] && [ -f "$YAML_SOPS" ] \
   && sops --decrypt "$YAML_SOPS" | grep -q "yaml-secret-key" \
   && ! grep -Fq 'yaml-secret-key' "$YAML_TMPL" \
   && grep -Fqx '{{- /* check-secrets:generated:v1 */ -}}' "$YAML_TMPL" \
   && [ "$(find "$(dirname "$YAML_SOPS")" -maxdepth 1 -name "$(basename "$YAML_SOPS")*" -type f | wc -l)" -eq 1 ]; then
    pass "partial YAML encryption passed"
else
    fail "partial YAML encryption failed"
fi

# Re-adding an already templated target updates that template in place rather
# than producing a .tmpl.tmpl source and a .tmpl.sops sidecar.
printf '%s\n' 'app_name: MyRenamedApp' 'API_KEY: yaml-secret-key-updated' 'port: 9090' 'db_password: yaml-db-pass-updated' > "$TEST_ROOT/test_data.yaml"
run_chezmoi_add 2 "$TEST_ROOT/test_data.yaml" >/dev/null 2>&1 || true
if [ -f "$YAML_TMPL" ] \
   && ! find "$(dirname "$YAML_TMPL")" -maxdepth 1 -name "$(basename "$YAML_TMPL").tmpl" -print -quit | grep -q . \
   && grep -Fq "${YAML_SOPS#"$SOURCE_DIR"/}" "$YAML_TMPL" \
   && grep -Fq 'MyRenamedApp' "$YAML_TMPL" \
   && sops --decrypt "$YAML_SOPS" | grep -Fq 'yaml-secret-key-updated'; then
    pass "Option 2 re-add safely updates compatible generated pair"
else
    fail "Option 2 re-add created a nested template"
fi

# Re-add interruption after ciphertext replacement must leave the old template
# renderable with the new same-identifier payload. A retry must converge to the
# requested pair without source plaintext or pending files.
echo "Testing Option 2 re-add interruption and retry safety..."
for failpoint in readd-after-cipher-replace readd-before-template-replace readd-term-after-cipher readd-hup-after-cipher; do
    printf '%s\n' 'app_name: ReaddBaseline' "API_KEY: baseline-$failpoint" 'port: 8080' 'db_password: baseline-db' > "$TEST_ROOT/test_data.yaml"
    run_chezmoi_add 2 "$TEST_ROOT/test_data.yaml" >/dev/null 2>&1 || true
    baseline_template_sum=$(cksum "$YAML_TMPL")
    canary="READD_CANARY_${failpoint}"
    printf '%s\n' 'app_name: ReaddFinal' "API_KEY: $canary" 'port: 9090' 'db_password: final-db' > "$TEST_ROOT/test_data.yaml"
    env CHECK_SECRETS_FAILPOINT="$failpoint" TEST_CHOICE=2 chezmoi add "$TEST_ROOT/test_data.yaml" >/dev/null 2>&1 || true
    [ "$(cksum "$YAML_TMPL")" = "$baseline_template_sum" ] || fail "$failpoint replaced the template"
    sops --decrypt "$YAML_SOPS" | grep -Fq "$canary" || fail "$failpoint did not leave valid replacement ciphertext"
    intermediate_render=$(chezmoi execute-template < "$YAML_TMPL")
    printf '%s' "$intermediate_render" | grep -Fq 'app_name: ReaddBaseline' || fail "$failpoint left an unrenderable intermediate pair"
    printf '%s' "$intermediate_render" | grep -Fq "$canary" || fail "$failpoint intermediate pair used stale ciphertext"
    if grep -R -Fq --exclude='*.sops.yaml' "$canary" "$SOURCE_DIR"; then
        fail "$failpoint leaked plaintext into source"
    fi
    run_chezmoi_add 2 "$TEST_ROOT/test_data.yaml" >/dev/null 2>&1 || true
    cmp -s <(chezmoi execute-template < "$YAML_TMPL") "$TEST_ROOT/test_data.yaml" || fail "$failpoint retry did not converge"
    if find "$SOURCE_DIR/." -type f -name '.*.pending.*' -print -quit | grep -q .; then
        fail "$failpoint left a pending source file"
    fi
done
pass "Option 2 re-add interruption and retry safety passed"

# Legacy generated configs exported this value with a literal tilde. The hook
# must normalize it before direct SOPS decryption/validation.
echo "Testing legacy tilde SOPS key path..."
TILDE_TARGET="$TEST_ROOT/legacy-tilde.yaml"
printf '%s\n' 'API_KEY: legacy-tilde-secret' > "$TILDE_TARGET"
# shellcheck disable=SC2088 # Exercise a deliberately unexpanded legacy tilde.
SOPS_AGE_KEY_FILE='~/.config/chezmoi/key.txt' TEST_CHOICE=2 \
    "$SOURCE_DIR/scripts/check-secrets.sh" add "$TILDE_TARGET" >/dev/null 2>&1 || true
TILDE_TMPL=$(template_source_path "$TILDE_TARGET")
TILDE_SOPS=$(sops_source_path "$TILDE_TARGET")
if [ -f "$TILDE_TMPL" ] && sops --decrypt "$TILDE_SOPS" | grep -Fq 'legacy-tilde-secret'; then
    pass "legacy tilde SOPS key path passed"
else
    fail "legacy tilde SOPS key path failed"
fi

# Interruption states must never place plaintext in source. Cipher-first
# failpoints may leave only a valid, unreferenced ciphertext orphan.
echo "Testing Option 2 interruption and retry safety..."
for spec in before-cipher-install:none after-cipher-install:cipher before-template-install:cipher term-after-cipher:cipher hup-after-cipher:cipher; do
    failpoint=${spec%%:*}
    expected_state=${spec#*:}
    target="$TEST_ROOT/interrupt-$failpoint.yaml"
    canary="INTERRUPT_CANARY_${failpoint}"
    printf 'API_KEY: %s\n' "$canary" > "$target"
    expected_source=$(prospective_fixture_mapping "$target")
    expected_source=${expected_source%.literal}
    env CHECK_SECRETS_FAILPOINT="$failpoint" TEST_CHOICE=2 chezmoi add "$target" >/dev/null 2>&1 || true
    if grep -R -Fq --exclude='*.sops.yaml' "$canary" "$SOURCE_DIR"; then
        fail "$failpoint leaked plaintext into source"
    fi
    [ ! -e "$expected_source.tmpl" ] || fail "$failpoint published a template"
    interrupt_cipher="$SOURCE_DIR/secrets/${expected_source#"$SOURCE_DIR"/}.sops.yaml"
    if [ "$expected_state" = none ]; then
        [ ! -e "$interrupt_cipher" ] || fail "$failpoint left source artifacts"
    else
        [ -f "$interrupt_cipher" ] || fail "$failpoint did not leave stable ciphertext orphan"
        sops --decrypt "$interrupt_cipher" | grep -Fq "$canary" || fail "$failpoint orphan is invalid"
    fi
    # Retrying must publish a valid pair without exposing the canary.
    run_chezmoi_add 2 "$target" >/dev/null 2>&1 || true
    [ -f "$expected_source.tmpl" ] || fail "$failpoint retry did not publish template"
    ! grep -Fq "$canary" "$expected_source.tmpl" || fail "$failpoint retry leaked into template"
done
pass "Option 2 interruption and retry safety passed"

# Existing template and stable ciphertext collisions are preserved.
echo "Testing Option 2 collision preservation..."
COLLISION_TARGET="$TEST_ROOT/collision.yaml"
printf '%s\n' 'API_KEY: COLLISION_CANARY' > "$COLLISION_TARGET"
COLLISION_SOURCE=$(prospective_fixture_mapping "$COLLISION_TARGET")
COLLISION_SOURCE=${COLLISION_SOURCE%.literal}
mkdir -p "$(dirname "$COLLISION_SOURCE")"
printf '%s' template-sentinel > "$COLLISION_SOURCE.tmpl"
run_chezmoi_add 2 "$COLLISION_TARGET" >/dev/null 2>&1 || true
[ "$(cat "$COLLISION_SOURCE.tmpl")" = template-sentinel ] || fail 'template collision was clobbered'
rm -f "$COLLISION_SOURCE.tmpl"
COLLISION_CIPHER="$SOURCE_DIR/secrets/${COLLISION_SOURCE#"$SOURCE_DIR"/}.sops.yaml"
mkdir -p "$(dirname "$COLLISION_CIPHER")"
printf '%s' cipher-sentinel > "$COLLISION_CIPHER"
run_chezmoi_add 2 "$COLLISION_TARGET" >/dev/null 2>&1 || true
[ "$(cat "$COLLISION_CIPHER")" = cipher-sentinel ] || fail 'cipher collision was clobbered'
[ ! -e "$COLLISION_SOURCE.tmpl" ] || fail 'cipher collision published template'
pass "Option 2 collision preservation passed"

# A matching stable orphan is resumable, but a changed extraction must not
# replace or publish anything.
echo "Testing stable orphan mismatch preservation..."
ORPHAN_TARGET="$TEST_ROOT/orphan-mismatch.yaml"
printf '%s\n' 'API_KEY: orphan-original' > "$ORPHAN_TARGET"
ORPHAN_SOURCE=$(prospective_fixture_mapping "$ORPHAN_TARGET")
ORPHAN_SOURCE=${ORPHAN_SOURCE%.literal}
env CHECK_SECRETS_FAILPOINT=after-cipher-install TEST_CHOICE=2 chezmoi add "$ORPHAN_TARGET" >/dev/null 2>&1 || true
ORPHAN_CIPHER="$SOURCE_DIR/secrets/${ORPHAN_SOURCE#"$SOURCE_DIR"/}.sops.yaml"
ORPHAN_SUM=$(cksum "$ORPHAN_CIPHER")
printf '%s\n' 'API_KEY: orphan-changed' > "$ORPHAN_TARGET"
run_chezmoi_add 2 "$ORPHAN_TARGET" >/dev/null 2>&1 || true
[ "$(cksum "$ORPHAN_CIPHER")" = "$ORPHAN_SUM" ] || fail 'mismatched orphan was replaced'
[ ! -e "$ORPHAN_SOURCE.tmpl" ] || fail 'mismatched orphan published a template'
pass "stable orphan mismatch preservation passed"

# Generic-marker templates, including the repository's legacy nested fromYaml
# style, are manual and must never be treated as generated output.
echo "Testing manual template preservation..."
MANUAL_TARGET="$TEST_ROOT/manual.yaml"
printf '%s\n' 'API_KEY: manual-new-value' > "$MANUAL_TARGET"
MANUAL_SOURCE=$(prospective_fixture_mapping "$MANUAL_TARGET")
MANUAL_SOURCE=${MANUAL_SOURCE%.literal}
mkdir -p "$(dirname "$MANUAL_SOURCE")"
cat > "$MANUAL_SOURCE.tmpl" <<'EOF'
{{- /* chezmoi:template */ -}}
API_KEY: {{ (index ((secret "-d" (joinPath .chezmoi.sourceDir "secrets/manual.sops.yaml") | fromYaml).data | fromYaml) "API_KEY") }}
EOF
MANUAL_SUM=$(cksum "$MANUAL_SOURCE.tmpl")
run_chezmoi_add 2 "$MANUAL_TARGET" >/dev/null 2>&1 || true
[ "$(cksum "$MANUAL_SOURCE.tmpl")" = "$MANUAL_SUM" ] || fail 'manual nested template was modified'
[ ! -e "$SOURCE_DIR/secrets/${MANUAL_SOURCE#"$SOURCE_DIR"/}.sops.yaml" ] || fail 'manual template gained a sidecar'
pass "manual template preservation passed"

# Stable-path symlinks and malformed generated pairs fail closed.
echo "Testing symlink and malformed pair rejection..."
SYMLINK_TARGET="$TEST_ROOT/symlink-cipher.yaml"
printf '%s\n' 'API_KEY: symlink-value' > "$SYMLINK_TARGET"
SYMLINK_SOURCE=$(prospective_fixture_mapping "$SYMLINK_TARGET")
SYMLINK_SOURCE=${SYMLINK_SOURCE%.literal}
SYMLINK_CIPHER="$SOURCE_DIR/secrets/${SYMLINK_SOURCE#"$SOURCE_DIR"/}.sops.yaml"
mkdir -p "$(dirname "$SYMLINK_CIPHER")"
printf '%s' outside-sentinel > "$TEST_FIXTURE/outside-cipher"
ln -s "$TEST_FIXTURE/outside-cipher" "$SYMLINK_CIPHER"
run_chezmoi_add 2 "$SYMLINK_TARGET" >/dev/null 2>&1 || true
[ "$(cat "$TEST_FIXTURE/outside-cipher")" = outside-sentinel ] || fail 'cipher symlink target was modified'
[ ! -e "$SYMLINK_SOURCE.tmpl" ] || fail 'cipher symlink published a template'

TEMPLATE_LINK_TARGET="$TEST_ROOT/symlink-template.yaml"
printf '%s\n' 'API_KEY: symlink-template-value' > "$TEMPLATE_LINK_TARGET"
TEMPLATE_LINK_SOURCE=$(prospective_fixture_mapping "$TEMPLATE_LINK_TARGET")
TEMPLATE_LINK_SOURCE=${TEMPLATE_LINK_SOURCE%.literal}
mkdir -p "$(dirname "$TEMPLATE_LINK_SOURCE")"
printf '%s' template-link-sentinel > "$TEST_FIXTURE/outside-template"
ln -s "$TEST_FIXTURE/outside-template" "$TEMPLATE_LINK_SOURCE.tmpl"
run_chezmoi_add 2 "$TEMPLATE_LINK_TARGET" >/dev/null 2>&1 || true
[ "$(cat "$TEST_FIXTURE/outside-template")" = template-link-sentinel ] || fail 'template symlink target was modified'
[ ! -e "$SOURCE_DIR/secrets/${TEMPLATE_LINK_SOURCE#"$SOURCE_DIR"/}.sops.yaml" ] || fail 'template symlink gained a sidecar'

LINK_INPUT="$TEST_ROOT/input-link.yaml"
printf '%s\n' 'API_KEY: linked-input-value' > "$TEST_FIXTURE/linked-input"
ln -s "$TEST_FIXTURE/linked-input" "$LINK_INPUT"
TEST_CHOICE=2 "$SOURCE_DIR/scripts/check-secrets.sh" add "$LINK_INPUT" >/dev/null 2>&1 || true
LINK_SOURCE=$(prospective_fixture_mapping "$LINK_INPUT")
LINK_SOURCE=${LINK_SOURCE%.literal}
[ ! -e "$LINK_SOURCE.tmpl" ] || fail 'input symlink published a template'

MALFORMED_TARGET="$TEST_ROOT/malformed-generated.yaml"
printf '%s\n' 'API_KEY: malformed-new' > "$MALFORMED_TARGET"
MALFORMED_SOURCE=$(prospective_fixture_mapping "$MALFORMED_TARGET")
MALFORMED_SOURCE=${MALFORMED_SOURCE%.literal}
MALFORMED_CIPHER="$SOURCE_DIR/secrets/${MALFORMED_SOURCE#"$SOURCE_DIR"/}.sops.yaml"
mkdir -p "$(dirname "$MALFORMED_SOURCE")" "$(dirname "$MALFORMED_CIPHER")"
printf '%s\n' '{{- /* chezmoi:template */ -}}' '{{- /* check-secrets:generated:v1 */ -}}' '{{ broken' > "$MALFORMED_SOURCE.tmpl"
printf '%s\n' "API_KEY: 'malformed-old'" > "$TEST_FIXTURE/malformed-plain"
sops --encrypt --age "$(awk -F: '/public key:/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$SOPS_AGE_KEY_FILE")" \
    "$TEST_FIXTURE/malformed-plain" > "$MALFORMED_CIPHER"
MALFORMED_SUM=$(cksum "$MALFORMED_SOURCE.tmpl" "$MALFORMED_CIPHER")
run_chezmoi_add 2 "$MALFORMED_TARGET" >/dev/null 2>&1 || true
[ "$(cksum "$MALFORMED_SOURCE.tmpl" "$MALFORMED_CIPHER")" = "$MALFORMED_SUM" ] || fail 'malformed generated pair was modified'
pass "symlink and malformed pair rejection passed"

# Identifier add/remove/rename changes and ambiguous duplicate reordering must
# fail before either stable source file is changed.
echo "Testing structural re-add rejection..."
STRUCT_TARGET="$TEST_ROOT/structural.yaml"
cat > "$STRUCT_TARGET" <<'EOF'
API_KEY: structural-api
PASSWORD: structural-password
mode: original
EOF
run_chezmoi_add 2 "$STRUCT_TARGET" >/dev/null 2>&1 || true
STRUCT_TMPL=$(template_source_path "$STRUCT_TARGET")
STRUCT_CIPHER=$(sops_source_path "$STRUCT_TARGET")
STRUCT_SUM=$(cksum "$STRUCT_TMPL" "$STRUCT_CIPHER")
for structural_case in add remove remove-all rename; do
    case $structural_case in
        add) printf '%s\n' 'API_KEY: structural-api' 'PASSWORD: structural-password' 'TOKEN: structural-token' 'mode: original' > "$STRUCT_TARGET" ;;
        remove) printf '%s\n' 'API_KEY: structural-api' 'mode: original' > "$STRUCT_TARGET" ;;
        remove-all) printf '%s\n' 'mode: no-secrets-remain' > "$STRUCT_TARGET" ;;
        rename) printf '%s\n' 'TOKEN: structural-api' 'PASSWORD: structural-password' 'mode: original' > "$STRUCT_TARGET" ;;
    esac
    run_chezmoi_add 2 "$STRUCT_TARGET" >/dev/null 2>&1 || true
    [ "$(cksum "$STRUCT_TMPL" "$STRUCT_CIPHER")" = "$STRUCT_SUM" ] || fail "$structural_case changed a generated pair"
done

DUP_TARGET="$TEST_ROOT/duplicate-reorder.json"
cat > "$DUP_TARGET" <<'EOF'
{
  "hosts": [
    {"name": "alpha", "password": "alpha-password"},
    {"name": "beta", "password": "beta-password"}
  ]
}
EOF
run_chezmoi_add 2 "$DUP_TARGET" >/dev/null 2>&1 || true
DUP_TMPL=$(template_source_path "$DUP_TARGET")
DUP_CIPHER=$(sops_source_path "$DUP_TARGET")
DUP_SUM=$(cksum "$DUP_TMPL" "$DUP_CIPHER")
cat > "$DUP_TARGET" <<'EOF'
{
  "hosts": [
    {"name": "beta", "password": "beta-password"},
    {"name": "alpha", "password": "alpha-password"}
  ]
}
EOF
run_chezmoi_add 2 "$DUP_TARGET" >/dev/null 2>&1 || true
[ "$(cksum "$DUP_TMPL" "$DUP_CIPHER")" = "$DUP_SUM" ] || fail 'ambiguous duplicate reorder changed a generated pair'
pass "structural re-add rejection passed"

# Identifier comparison failure must preserve both stable source files.
echo "Testing identifier comparison failure..."
SORT_TARGET="$TEST_ROOT/sort-failure.yaml"
printf '%s\n' 'API_KEY: sort-before' 'mode: before' > "$SORT_TARGET"
run_chezmoi_add 2 "$SORT_TARGET" >/dev/null 2>&1 || true
SORT_TMPL=$(template_source_path "$SORT_TARGET")
SORT_CIPHER=$(sops_source_path "$SORT_TARGET")
SORT_SUM=$(cksum "$SORT_TMPL" "$SORT_CIPHER")
printf '%s\n' 'API_KEY: sort-after' 'mode: after' > "$SORT_TARGET"
for compare_failpoint in identifier-compare identifier-compare-existing; do
    SORT_OUTPUT=$(env CHECK_SECRETS_FAILPOINT="$compare_failpoint" TEST_CHOICE=2 \
        "$SOURCE_DIR/scripts/check-secrets.sh" add "$SORT_TARGET" 2>&1 || true)
    [[ $(cksum "$SORT_TMPL" "$SORT_CIPHER") == "$SORT_SUM" ]] \
        || fail "$compare_failpoint changed a generated pair"
    printf '%s' "$SORT_OUTPUT" | grep -Fq 'identifier comparison failed' \
        || fail "$compare_failpoint emitted no diagnostic"
done
pass "identifier comparison failures passed"

# With an identical generated template, a value-only re-add atomically changes
# the stable ciphertext and leaves the template byte-for-byte untouched.
echo "Testing value-only stable update..."
VALUE_TARGET="$TEST_ROOT/value-only.yaml"
printf '%s\n' 'API_KEY: value-before' 'mode: stable' > "$VALUE_TARGET"
run_chezmoi_add 2 "$VALUE_TARGET" >/dev/null 2>&1 || true
VALUE_TMPL=$(template_source_path "$VALUE_TARGET")
VALUE_CIPHER=$(sops_source_path "$VALUE_TARGET")
VALUE_TEMPLATE_SUM=$(cksum "$VALUE_TMPL")
VALUE_CIPHER_SUM=$(cksum "$VALUE_CIPHER")
printf '%s\n' 'API_KEY: value-after' 'mode: stable' > "$VALUE_TARGET"
run_chezmoi_add 2 "$VALUE_TARGET" >/dev/null 2>&1 || true
[ "$(cksum "$VALUE_TMPL")" = "$VALUE_TEMPLATE_SUM" ] || fail 'value-only update changed template'
[ "$(cksum "$VALUE_CIPHER")" != "$VALUE_CIPHER_SUM" ] || fail 'value-only update did not replace ciphertext'
sops --decrypt "$VALUE_CIPHER" | grep -Fq 'value-after' || fail 'value-only ciphertext has wrong payload'
if find "$SOURCE_DIR/." -type f -name '.*.pending.*' -print -quit | grep -q .; then
    fail 'pending source temporary survived an operation'
fi
pass "value-only stable update passed"

# Option 2 extraction and template rendering must not hide a Python dependency.
echo "Testing Option 2 without Python..."
NO_PYTHON_BIN="$TEST_FIXTURE/check-secrets-no-python-bin"
mkdir -p "$NO_PYTHON_BIN"
printf '%s\n' '#!/bin/sh' 'exit 127' > "$NO_PYTHON_BIN/python"
cp "$NO_PYTHON_BIN/python" "$NO_PYTHON_BIN/python3"
chmod +x "$NO_PYTHON_BIN/python" "$NO_PYTHON_BIN/python3"
NO_PYTHON_TARGET="$TEST_ROOT/no-python.yaml"
printf '%s\n' 'API_KEY: no-python-secret' 'mode: portable' > "$NO_PYTHON_TARGET"
env PATH="$NO_PYTHON_BIN:$PATH" TEST_CHOICE=2 chezmoi add "$NO_PYTHON_TARGET" >/dev/null 2>&1 || true
NO_PYTHON_TMPL=$(template_source_path "$NO_PYTHON_TARGET")
NO_PYTHON_SOPS=$(sops_source_path "$NO_PYTHON_TARGET")
if [ -f "$NO_PYTHON_TMPL" ] \
   && sops --decrypt "$NO_PYTHON_SOPS" | grep -Fq 'no-python-secret' \
   && env PATH="$NO_PYTHON_BIN:$PATH" chezmoi execute-template < "$NO_PYTHON_TMPL" | grep -Fq 'no-python-secret'; then
    pass "Option 2 works without Python"
else
    fail "Option 2 failed without Python"
fi

# Direct AWK coverage verifies quote/backslash encoding and control rejection.
echo "Testing template string encoding..."
ENCODE_INPUT="$TEST_FIXTURE/encode-input.yaml"
ENCODE_TEMPLATE="$TEST_FIXTURE/encode-template"
ENCODE_SECRETS="$TEST_FIXTURE/encode-secrets"
printf '%s\n' 'API_KEY: encode-secret-value' > "$ENCODE_INPUT"
SENSITIVE_PATTERNS='API_KEY' awk -v mode=extract -v template_file="$ENCODE_TEMPLATE" -v secrets_file="$ENCODE_SECRETS" \
    -v 'sops_file_name=dir/a"b\\c.sops.yaml' -f "$SOURCE_DIR/scripts/check-secrets.awk" "$ENCODE_INPUT"
grep -Fq 'a\"b\\c.sops.yaml' "$ENCODE_TEMPLATE" || fail 'template path was not Go-string escaped'
CONTROL_TEMPLATE="$TEST_FIXTURE/control-template"
if SENSITIVE_PATTERNS='API_KEY' awk -v mode=extract -v template_file="$CONTROL_TEMPLATE" -v secrets_file="$TEST_FIXTURE/control-secrets" \
    -v $'sops_file_name=bad\rpath' -f "$SOURCE_DIR/scripts/check-secrets.awk" "$ENCODE_INPUT"; then
    fail 'control-bearing template path was accepted'
fi
[ ! -e "$CONTROL_TEMPLATE" ] || fail 'control rejection wrote its template output'
[ ! -e "$TEST_FIXTURE/control-secrets" ] || fail 'control rejection wrote its secrets output'
pass "template string encoding passed"

# JSON extraction uses the same generated-pair contract.
echo "Testing partial JSON encryption..."
prepare_test_dirs
write_option2_json_fixture
run_chezmoi_add 2 "$TEST_ROOT/test_data.json" >/dev/null 2>&1 || true
JSON_TMPL=$(template_source_path "$TEST_ROOT/test_data.json")
JSON_SOPS=$(sops_source_path "$TEST_ROOT/test_data.json")
if [ -f "$JSON_TMPL" ] && sops --decrypt "$JSON_SOPS" | grep -q "json-secret-key"; then
    pass "partial JSON encryption passed"
else
    fail "partial JSON encryption failed"
fi

# TOML extraction uses the same generated-pair contract.
echo "Testing partial TOML encryption..."
prepare_test_dirs
write_option2_toml_fixture
run_chezmoi_add 2 "$TEST_ROOT/test_data.toml" >/dev/null 2>&1 || true
TOML_TMPL=$(template_source_path "$TEST_ROOT/test_data.toml")
TOML_SOPS=$(sops_source_path "$TEST_ROOT/test_data.toml")
if [ -f "$TOML_TMPL" ] && sops --decrypt "$TOML_SOPS" | grep -q "toml-secret-key"; then
    pass "partial TOML encryption passed"
else
    fail "partial TOML encryption failed"
fi

# Duplicate sensitive keys receive stable positional identifiers.
echo "Testing duplicate sensitive keys..."
prepare_test_dirs
write_option2_duplicate_fixture
run_chezmoi_add 2 "$TEST_ROOT/test_multi.json" >/dev/null 2>&1 || true
MULTI_TMPL=$(template_source_path "$TEST_ROOT/test_multi.json")
MULTI_SOPS=$(sops_source_path "$TEST_ROOT/test_multi.json")
if [ -f "$MULTI_TMPL" ] \
   && grep -q 'password__1' "$MULTI_TMPL" \
   && grep -q 'password__2' "$MULTI_TMPL" \
   && sops --decrypt "$MULTI_SOPS" | grep -q 'password1' \
   && sops --decrypt "$MULTI_SOPS" | grep -q 'password2'; then
    pass "duplicate sensitive key encryption passed"
else
    fail "duplicate sensitive key encryption failed"
fi

# Subdirectory mappings preserve the expected chezmoi source hierarchy.
echo "Testing partial encryption in a subdirectory..."
prepare_test_dirs
write_option2_subdirectory_fixture
run_chezmoi_add 2 "$CONFIG_TEST_ROOT/test_sub.yaml" || true
SUB_TMPL=$(template_source_path "$CONFIG_TEST_ROOT/test_sub.yaml")
SUB_SOPS=$(sops_source_path "$CONFIG_TEST_ROOT/test_sub.yaml")
if [ -f "$SUB_TMPL" ] && sops --decrypt "$SUB_SOPS" | grep -q "sub-secret-key"; then
    pass "subdirectory partial encryption passed"
else
    echo "Expected secret at: $SUB_SOPS"
    fail "subdirectory partial encryption failed"
fi

# Chezmoi attribute naming is pinned independently of the hook's path oracle.
echo "Testing partial encryption source naming..."
prepare_test_dirs
# Pin typical user-home permissions so chezmoi maps non-private attributes;
# a 700-mode fixture HOME would otherwise prepend private_ to every segment
# and the literal expectations below would not describe the contract.
chmod 755 "$HOME/.test_dir" "$SOURCE_NAMING_TEST_ROOT"
write_option2_source_naming_fixture
chmod 644 "$SOURCE_NAMING_TEST_ROOT/test_chezmoi_naming.json"
run_chezmoi_add 2 "$SOURCE_NAMING_TEST_ROOT/test_chezmoi_naming.json" >/dev/null 2>&1 || true
THEME_TMPL="$SOURCE_DIR/dot_test_dir/test_subdir/test_chezmoi_naming.json.tmpl"
THEME_SOPS="$SOURCE_DIR/secrets/dot_test_dir/test_subdir/test_chezmoi_naming.json.sops.yaml"
if [ -f "$THEME_TMPL" ] \
   && sops --decrypt "$THEME_SOPS" | grep -q "chezmoi-naming-secret"; then
    pass "partial encryption source naming passed"
else
    echo "Expected template at: $THEME_TMPL"
    echo "Expected secret at: $THEME_SOPS"
    fail "partial encryption source naming failed"
fi

# Strong token detection is independent of key names.
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

# Additional provider tokens are detected.
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

# Placeholder values do not trigger detection.
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

# Numeric token limit settings do not trigger detection.
echo "Testing numeric token limit filtering..."
prepare_test_dirs
cat <<'EOF' > "$TEST_ROOT/test_limits.json"
{
  "maxTokens": 16384,
  "maxOutputTokens": 4096,
  "tokenLimit": 200000
}
EOF
LIMITS_OUTPUT=$(TEST_CHOICE=4 chezmoi add "$TEST_ROOT/test_limits.json" 2>&1 || true)
LIMITS_SOURCE=$(template_source_path "$TEST_ROOT/test_limits.json")
if printf '%s' "$LIMITS_OUTPUT" | grep -q 'Sensitive information detected'; then
    fail "Numeric token limit filtering failed: warning was emitted"
elif [ -f "$LIMITS_SOURCE" ]; then
    pass "Numeric token limit filtering passed"
else
    fail "Numeric token limit filtering failed: file was not added"
fi

echo "All tests passed successfully!"
