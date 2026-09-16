#!/usr/bin/env bash
# Tests for the hardened age-identity bootstrap hook. The hook template is
# rendered with a placeholder substitution and the `chezmoi age decrypt` call
# is mocked, so no passphrase prompt or real ciphertext is required.
set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd -P)
TEMPLATE=$SCRIPT_DIR/../run_onchange_before_decrypt-private-key.sh.tmpl
[[ -f $TEMPLATE ]] || { printf 'missing hook template\n' >&2; exit 1; }

ROOT=$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-test.XXXXXX")
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT

fail() { printf '❌ %s\n' "$*" >&2; exit 1; }
pass() { printf '✅ %s\n' "$*"; }

# Fake age identity files: only the public key comment is verified by the hook.
KEY_MATCH="age1matchmatchmatchmatchmatchmatchmatchmatchmatchmatchmatchm"
KEY_OTHER="age1otherotherotherotherotherotherotherotherotherotherothero"

make_identity() { # $1 = destination file, $2 = recipient ('' for no comment)
    if [[ -n ${2:-} ]]; then
        printf '# created: 2020-01-01\n# public key: %s\nAGE-SECRET-KEY-1FAKEFAKE\n' "$2" > "$1"
    else
        printf '# created: 2020-01-01\nAGE-SECRET-KEY-1FAKEFAKE\n' > "$1"
    fi
}

new_case() {
    CASE=$(mktemp -d "$ROOT/case.XXXXXX")
    HOME_DIR=$CASE/home
    SOURCE_DIR=$CASE/source
    mkdir -p "$HOME_DIR/.config/chezmoi" "$SOURCE_DIR"
    printf 'recipient = "%s"\n' "$KEY_MATCH" > "$HOME_DIR/.config/chezmoi/chezmoi.toml"
    : > "$SOURCE_DIR/key.txt.age"
    make_identity "$CASE/identity-ok" "$KEY_MATCH"
    make_identity "$CASE/identity-nocomment" ''
    make_identity "$CASE/identity-mismatch" "$KEY_OTHER"
    sed "s|{{ \.chezmoi\.sourceDir }}|$SOURCE_DIR|" "$TEMPLATE" > "$CASE/hook.sh"
    chmod +x "$CASE/hook.sh"
    # Mock decrypt: copies the requested identity to the --output path, or
    # fails when MOCK_DECRYPT is set to a failure mode. The heredoc is quoted
    # so nothing is expanded at write time; case-specific paths arrive via the
    # environment instead.
    mkdir -p "$CASE/bin"
    cat > "$CASE/bin/chezmoi" <<'EOF'
#!/usr/bin/env bash
set -eu
out=
prev=
for arg in "$@"; do
    if [[ $prev == --output ]]; then out=$arg; fi
    prev=$arg
done
[[ -n $out ]] || exit 1
case ${MOCK_DECRYPT:-ok} in
    ok)
        cp "$MOCK_IDENTITY_FILE" "$out"
        if [[ -n ${MOCK_CONCURRENT_KEY:-} ]]; then
            # Simulate a concurrent installer that wins the race.
            cp "$MOCK_CONCURRENT_KEY" "$(dirname "$out")/key.txt"
        fi
        ;;
    fail) exit 97 ;;
esac
EOF
    chmod +x "$CASE/bin/chezmoi"
}

run_hook() {
    env PATH="$CASE/bin:$PATH" MOCK_IDENTITY_FILE="${MOCK_IDENTITY_FILE:-$CASE/identity-ok}" \
        HOME="$HOME_DIR" sh "$CASE/hook.sh"
}

# The hook is a no-op when the source carries no identity backup.
new_case
rm -f "$SOURCE_DIR/key.txt.age"
run_hook || fail 'missing ciphertext should be a no-op'
[[ ! -e $HOME_DIR/.config/chezmoi/key.txt ]] || fail 'missing ciphertext installed a key'
pass 'missing ciphertext is a no-op'

# Fresh machine: the identity is decrypted, verified, and installed atomically.
new_case
run_hook > "$CASE/out" 2> "$CASE/err"
grep -q 'restored the age identity' "$CASE/out" || fail 'success message missing'
[[ -f $HOME_DIR/.config/chezmoi/key.txt ]] || fail 'key not installed'
cmp -s "$CASE/identity-ok" "$HOME_DIR/.config/chezmoi/key.txt" || fail 'installed key differs from decrypted identity'
[[ $(stat -c '%a' "$HOME_DIR/.config/chezmoi/key.txt" 2>/dev/null || stat -f '%Lp' "$HOME_DIR/.config/chezmoi/key.txt") == 600 ]] \
    || fail 'installed key is not mode 600'
[[ $(stat -c '%a' "$HOME_DIR/.config/chezmoi" 2>/dev/null || stat -f '%Lp' "$HOME_DIR/.config/chezmoi") == 700 ]] \
    || fail 'config directory is not mode 700'
[[ -z $(find "$HOME_DIR/.config/chezmoi" -name '.key.txt.*' -print -quit) ]] || fail 'temporary file leftovers'
pass 'fresh bootstrap installs a verified identity'

# An existing identity is never replaced.
new_case
make_identity "$HOME_DIR/.config/chezmoi/key.txt" "$KEY_MATCH"
run_hook > "$CASE/out" 2>&1
cmp -s "$CASE/identity-ok" "$HOME_DIR/.config/chezmoi/key.txt" || fail 'existing key was replaced'
pass 'existing matching identity is left untouched'

# An existing identity that contradicts the configured recipient fails closed.
new_case
make_identity "$HOME_DIR/.config/chezmoi/key.txt" "$KEY_OTHER"
if run_hook > "$CASE/out" 2>&1; then
    fail 'mismatched existing identity was accepted'
fi
grep -q 'existing age identity does not match' "$CASE/out" || fail 'mismatch diagnostic missing'
grep -Fq "$KEY_OTHER" "$HOME_DIR/.config/chezmoi/key.txt" || fail 'mismatched key was modified'
pass 'existing mismatched identity fails closed'

# Decrypted content without an age-keygen public key comment is refused.
new_case
MOCK_DECRYPT=fail run_hook > "$CASE/out" 2>&1 && fail 'failed decrypt was accepted'
[[ ! -e $HOME_DIR/.config/chezmoi/key.txt ]] || fail 'failed decrypt installed a key'
grep -q 'unable to decrypt' "$CASE/out" || fail 'decrypt failure diagnostic missing'
[[ -z $(find "$HOME_DIR/.config/chezmoi" -name '.key.txt.*' -print -quit) ]] || fail 'temporary file leftovers'
pass 'failed decryption leaves no key behind'

new_case
MOCK_IDENTITY_FILE="$CASE/identity-nocomment" run_hook > "$CASE/out" 2>&1 && fail 'identity without public key comment was accepted'
[[ ! -e $HOME_DIR/.config/chezmoi/key.txt ]] || fail 'unverifiable identity was installed'
grep -q 'does not carry an age-keygen public key comment' "$CASE/out" || fail 'comment diagnostic missing'
pass 'identity without public key comment is refused'

# A decrypted identity contradicting the configured recipient is refused.
new_case
MOCK_IDENTITY_FILE="$CASE/identity-mismatch" run_hook > "$CASE/out" 2>&1 && fail 'mismatched decrypted identity was accepted'
[[ ! -e $HOME_DIR/.config/chezmoi/key.txt ]] || fail 'mismatched identity was installed'
grep -q 'decrypted age identity does not match' "$CASE/out" || fail 'mismatch diagnostic missing'
pass 'mismatched decrypted identity is refused'

# A concurrently installed identity wins and the hook installs nothing.
new_case
MOCK_CONCURRENT_KEY="$CASE/identity-mismatch" run_hook > "$CASE/out" 2>&1 \
    && fail 'concurrent install was not detected'
grep -Fq "$KEY_OTHER" "$HOME_DIR/.config/chezmoi/key.txt" || fail 'concurrent key was clobbered'
[[ -z $(find "$HOME_DIR/.config/chezmoi" -name '.key.txt.*' -print -quit) ]] || fail 'temporary file leftovers'
pass 'concurrently installed identity is not clobbered'

# Without a configured recipient, verification is skipped but installation
# still works (fresh setups before the config is generated).
new_case
printf 'encryption = "age"\n' > "$HOME_DIR/.config/chezmoi/chezmoi.toml"
run_hook > "$CASE/out" 2>&1
cmp -s "$CASE/identity-ok" "$HOME_DIR/.config/chezmoi/key.txt" || fail 'unverifiable setup did not install the key'
pass 'missing recipient skips verification but still installs'

printf 'All bootstrap tests passed.\n'
