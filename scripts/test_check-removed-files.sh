#!/usr/bin/env bash
# Integration tests for check-removed-files.sh. A tiny chezmoi mock keeps each
# case in its own git/source/destination/cache fixture.

set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
HOOK="$SCRIPT_DIR/check-removed-files.sh"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/check-removed-files-test.XXXXXX")
# The hook canonicalizes the work tree via git; macOS reports /tmp as
# /private/tmp, so tests must compare against the physical path too.
ROOT=$(CDPATH='' cd -- "$ROOT" && pwd -P)

cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT HUP INT TERM

fail() { printf '❌ %s\n' "$*" >&2; exit 1; }
pass() { printf '✅ %s\n' "$*"; }

make_mock() {
    mkdir -p "$CASE/bin"
    cat > "$CASE/bin/chezmoi" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' "${1:-}" >> "$MOCK_CALLS"
case ${1:-} in
    managed) cat "$MOCK_MANAGED" ;;
    source-path|cat) exit 97 ;;
    *) exit 1 ;;
esac
EOF
    chmod +x "$CASE/bin/chezmoi"
}

new_case() {
    CASE=$(mktemp -d "$ROOT/case.XXXXXX")
    SRC="$CASE/source"
    DEST="$CASE/destination"
    CACHE="$CASE/cache"
    MAP="$CASE/map"
    MANAGED="$CASE/managed.json"
    CALLS="$CASE/chezmoi.calls"
    mkdir -p "$SRC" "$DEST" "$CACHE"
    : > "$MAP"
    printf '%s\n' '{}' > "$MANAGED"
    : > "$CALLS"
    git -C "$SRC" init -q
    git -C "$SRC" config user.email test@example.invalid
    git -C "$SRC" config user.name test
    make_mock
}

set_mapping() { printf '%s\t%s\n' "$1" "$2" > "$MAP"; }
set_managed() {
    local targets
    targets=$(printf '%s\0' "$@" | jq -Rs 'split("\u0000")[:-1]')
    jq -Rn --arg dest "$DEST" --arg src "$SRC" --argjson targets "$targets" '
        reduce inputs as $line ({};
            ($line | split("\t")) as $parts |
            if ($targets | index($parts[0])) == null then .
            else . + {
                ($parts[0] | ltrimstr($dest + "/")): {
                    absolute: $parts[0],
                    sourceAbsolute: $parts[1],
                    sourceRelative: ($parts[1] | ltrimstr($src + "/"))
                }
            }
            end
        )
    ' < "$MAP" > "$MANAGED"
}
clear_managed() { printf '%s\n' '{}' > "$MANAGED"; }
commit_all() { git -C "$SRC" add -A && git -C "$SRC" commit -qm "$1"; }

run_hook() {
    env PATH="$CASE/bin:$PATH" MOCK_MAP="$MAP" MOCK_MANAGED="$MANAGED" MOCK_CALLS="$CALLS" \
        CHEZMOI_SOURCE_DIR="$SRC" CHEZMOI_DEST_DIR="$DEST" \
        CHEZMOI_WORKING_TREE="$SRC" CHEZMOI_CACHE_DIR="$CACHE" \
        "$HOOK" "$@"
}

# script(1) supplies a controlling terminal. Its stdin becomes the answer to
# the hook's /dev/tty prompt.
run_post_answer() {
    local answer=$1
    if [[ $(uname -s) == Darwin ]]; then
        printf '%b\n' "$answer" | env PATH="$CASE/bin:$PATH" MOCK_MAP="$MAP" MOCK_MANAGED="$MANAGED" MOCK_CALLS="$CALLS" \
            CHEZMOI_SOURCE_DIR="$SRC" CHEZMOI_DEST_DIR="$DEST" \
            CHEZMOI_WORKING_TREE="$SRC" CHEZMOI_CACHE_DIR="$CACHE" \
            script -q /dev/null "$HOOK" post >/dev/null
    else
        printf '%b\n' "$answer" | env PATH="$CASE/bin:$PATH" MOCK_MAP="$MAP" MOCK_MANAGED="$MANAGED" MOCK_CALLS="$CALLS" \
            CHEZMOI_SOURCE_DIR="$SRC" CHEZMOI_DEST_DIR="$DEST" \
            CHEZMOI_WORKING_TREE="$SRC" CHEZMOI_CACHE_DIR="$CACHE" \
            script -qec "'$HOOK' post" /dev/null >/dev/null
    fi
}

prepare_file() {
    TARGET="$DEST/managed-file"
    SOURCE_FILE="$SRC/managed-file"
    printf '%s' original > "$SOURCE_FILE"
    cp "$SOURCE_FILE" "$TARGET"
    set_mapping "$TARGET" "$SOURCE_FILE"
    set_managed "$TARGET"
    commit_all initial
}

remove_source() {
    rm -f "$SOURCE_FILE"
    commit_all remove
    clear_managed
}

# Missing state is an ordinary no-op.
new_case
run_hook post
pass 'missing state is a no-op'

# The bulk snapshot records both target/source path forms plus deferred type
# and trusted work-tree provenance metadata.
new_case
prepare_file
run_hook pre
mapfile -d '' -t SNAPSHOT < "$CACHE/check-removed-files-v1/current/snapshot.nul"
[[ ${#SNAPSHOT[@]} -eq 7 \
    && ${SNAPSHOT[0]} == "$TARGET" \
    && ${SNAPSHOT[1]} == managed-file \
    && ${SNAPSHOT[2]} == "$SOURCE_FILE" \
    && ${SNAPSHOT[3]} == managed-file \
    && ${SNAPSHOT[4]} == managed-file \
    && ${SNAPSHOT[5]} == file-or-symlink \
    && ${SNAPSHOT[6]} == worktree ]] || fail 'bulk snapshot schema is incomplete'
pass 'bulk snapshot stores path and provenance mapping'

# Pre must not turn the managed set into nested chezmoi work. The mock records
# every invocation; the entry count is intentionally much larger than normal
# unit fixtures.
new_case
MANY_TARGETS=()
for index in $(seq 1 320); do
    target="$DEST/managed-$index"
    source="$SRC/managed-$index"
    printf '%s' "$index" > "$source"
    printf '%s' "$index" > "$target"
    printf '%s\t%s\n' "$target" "$source" >> "$MAP"
    MANY_TARGETS+=("$target")
done
set_managed "${MANY_TARGETS[@]}"
commit_all initial
: > "$CALLS"
run_hook pre
[[ $(grep -c '^managed$' "$CALLS" || true) -eq 1 ]] \
    || fail 'pre did not use exactly one bulk managed call'
[[ $(grep -Ec '^(source-path|cat)$' "$CALLS" || true) -eq 0 ]] \
    || fail 'pre performed per-entry chezmoi mapping/render calls'
[[ $(wc -l < "$CALLS") -eq 1 ]] || fail 'pre made unexpected chezmoi calls'
pass 'pre chezmoi invocation count is constant across 320 entries'

# Missing jq or malformed bulk JSON cannot publish deletion state.
new_case
prepare_file
printf '%s\n' 'not-json' > "$MANAGED"
run_hook pre
[[ ! -e $CACHE/check-removed-files-v1/current && ! -e $CACHE/check-removed-files-v1/lock ]] \
    || fail 'malformed managed JSON published state'
pass 'malformed managed JSON fails closed'

new_case
prepare_file
cat > "$CASE/bin/jq" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$CASE/bin/jq"
run_hook pre
[[ ! -e $CACHE/check-removed-files-v1/current && ! -e $CACHE/check-removed-files-v1/lock ]] \
    || fail 'unavailable jq published state'
pass 'unavailable jq fails closed'

# A failed update leaves pre-state behind. A later pre must reclaim a lock
# whose parent chezmoi PID no longer exists instead of disabling the hook.
new_case
prepare_file
STALE_ROOT="$CACHE/check-removed-files-v1"
mkdir -p "$STALE_ROOT/lock" "$STALE_ROOT/current"
printf '%s\n' '999999.stale.token' > "$STALE_ROOT/lock/token"
printf '%s\n' stale > "$STALE_ROOT/current/complete"
run_hook pre
[[ $(cat "$STALE_ROOT/lock/token") != '999999.stale.token' ]] \
    || fail 'interrupted update lock was not reclaimed'
remove_source
run_hook post
[[ ! -e $STALE_ROOT/current && ! -e $STALE_ROOT/lock ]] \
    || fail 'reclaimed transaction was not consumed'
pass 'interrupted update state is reclaimed'

# A clean, deleted source can be accepted.
new_case
prepare_file
run_hook pre
remove_source
run_post_answer y
[[ ! -e $TARGET ]] || fail 'accepted deleted file remained'
pass 'deleted unchanged file is accepted'

# Declining leaves the target in place.
new_case
prepare_file
run_hook pre
remove_source
run_post_answer n
[[ -f $TARGET ]] || fail 'skipped deleted file was removed'
pass 'deleted unchanged file can be skipped'

# There is no delete-all decision: each candidate needs its own answer because
# pre no longer proves the old rendered target state.
new_case
TARGET_ONE="$DEST/managed-one"
TARGET_TWO="$DEST/managed-two"
SOURCE_ONE="$SRC/managed-one"
SOURCE_TWO="$SRC/managed-two"
printf '%s' original > "$SOURCE_ONE"
printf '%s' original > "$SOURCE_TWO"
cp "$SOURCE_ONE" "$TARGET_ONE"
cp "$SOURCE_TWO" "$TARGET_TWO"
printf '%s\t%s\n%s\t%s\n' "$TARGET_ONE" "$SOURCE_ONE" "$TARGET_TWO" "$SOURCE_TWO" > "$MAP"
set_managed "$TARGET_ONE" "$TARGET_TWO"
commit_all initial
run_hook pre
rm "$SOURCE_ONE" "$SOURCE_TWO"
commit_all remove
clear_managed
run_post_answer 'A\ny'
[[ -e $TARGET_ONE && ! -e $TARGET_TWO ]] || fail 'bulk answer bypassed individual confirmation'
pass 'each deletion candidate requires individual confirmation'

# With no pre-update fingerprint, even a locally changed candidate is removed
# only when the user explicitly confirms that individual target.
new_case
prepare_file
printf '%s' locally-modified > "$TARGET"
run_hook pre
remove_source
run_post_answer y
[[ ! -e $TARGET ]] || fail 'confirmed modified target remained'
pass 'modified file requires explicit individual confirmation'

# Dry runs must not prompt or remove targets.
new_case
prepare_file
run_hook pre
remove_source
CHEZMOI_ARGS='update --dry-run' run_hook post
[[ -f $TARGET ]] || fail 'dry-run removed a target'
pass 'dry run does not delete'

# Without a controlling terminal the hook only reports and skips.
new_case
prepare_file
run_hook pre
remove_source
run_hook post
[[ -f $TARGET ]] || fail 'non-TTY post removed a target'
pass 'no TTY skips deletion'

# Symlink deletion unlinks the managed link, never its referent.
new_case
TARGET="$DEST/managed-link"
SOURCE_FILE="$SRC/managed-link"
REFERENT="$DEST/referent"
printf '%s' keep > "$REFERENT"
printf '%s' referent > "$SOURCE_FILE"
ln -s referent "$TARGET"
set_mapping "$TARGET" "$SOURCE_FILE"
set_managed "$TARGET"
commit_all initial
run_hook pre
rm "$SOURCE_FILE"
commit_all remove
clear_managed
run_post_answer y
[[ ! -L $TARGET && -f $REFERENT ]] || fail 'symlink handling followed or retained the link'
pass 'symlink is safely unlinked'

# A git rename is still an individual prompt and can be accepted.
new_case
prepare_file
run_hook pre
git -C "$SRC" mv managed-file renamed-file
git -C "$SRC" commit -qm rename
clear_managed
run_post_answer y
[[ ! -e $TARGET ]] || fail 'accepted renamed source target remained'
pass 'rename is individually handled'

# A directory in place of an old file is never removed. A symlinked parent is
# also unsafe, so both classes remain report-only.
new_case
prepare_file
run_hook pre
rm "$TARGET"
mkdir "$TARGET"
remove_source
run_post_answer y
[[ -d $TARGET ]] || fail 'directory target was removed'
pass 'directory target is report-only'

new_case
mkdir -p "$CASE/outside"
mkdir -p "$SRC/unsafe"
TARGET="$DEST/unsafe/managed-file"
SOURCE_FILE="$SRC/unsafe/managed-file"
printf '%s' original > "$SOURCE_FILE"
ln -s "$CASE/outside" "$DEST/unsafe"
printf '%s' original > "$CASE/outside/managed-file"
set_mapping "$TARGET" "$SOURCE_FILE"
set_managed "$TARGET"
commit_all initial
run_hook pre
rm "$SOURCE_FILE"
commit_all remove
clear_managed
run_post_answer y
[[ -f $CASE/outside/managed-file ]] || fail 'unsafe symlink-parent target was removed'
pass 'unsafe path is report-only'

# A group/world-writable destination component is report-only even with a yes.
new_case
prepare_file
run_hook pre
remove_source
chmod 777 "$DEST"
run_post_answer y
[[ -f $TARGET ]] || fail 'writable destination target was removed'
pass 'writable destination is report-only'

# Missing or malformed metadata must fail closed.
new_case
prepare_file
run_hook pre
remove_source
cat > "$CASE/bin/stat" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$CASE/bin/stat"
run_post_answer y
[[ -f $TARGET ]] || fail 'missing stat metadata allowed deletion'
pass 'unavailable stat is report-only'

new_case
prepare_file
run_hook pre
remove_source
cat > "$CASE/bin/stat" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' malformed
EOF
chmod +x "$CASE/bin/stat"
run_post_answer y
[[ -f $TARGET ]] || fail 'malformed stat metadata allowed deletion'
pass 'malformed stat metadata is report-only'

# Deterministically replace the destination directory after the first safety
# snapshot but before the immediate pre-unlink verification.
new_case
prepare_file
run_hook pre
remove_source
cat > "$CASE/mutate-parent" <<'EOF'
#!/usr/bin/env bash
set -eu
target=$1
parent=$(dirname "$target")
base=$(basename "$target")
mv "$parent" "$parent.replaced"
mkdir -m 700 "$parent"
cp "$parent.replaced/$base" "$parent/$base"
EOF
chmod +x "$CASE/mutate-parent"
CHECK_REMOVED_FILES_TEST_BEFORE_VERIFY="$CASE/mutate-parent" run_post_answer y
[[ -f $TARGET ]] || fail 'changed directory identity allowed deletion'
pass 'changed directory identity is report-only'

# Transaction state is disabled when the cache trust anchor is shared.
new_case
prepare_file
chmod 777 "$CACHE"
run_hook pre
remove_source
run_post_answer y
[[ -f $TARGET ]] || fail 'unsafe cache anchor allowed deletion'
pass 'unsafe cache anchor disables deletion'

# A permissive transaction root under an otherwise safe cache cannot be used
# as trusted state.
new_case
prepare_file
mkdir -p "$CACHE/check-removed-files-v1"
chmod 777 "$CACHE/check-removed-files-v1"
run_hook pre
remove_source
run_post_answer y
[[ -f $TARGET ]] || fail 'unsafe transaction root allowed deletion'
pass 'unsafe transaction root disables deletion'

# A lexically prefixed path containing .. must not escape the destination.
new_case
mkdir -p "$CASE/outside"
TARGET="$DEST/../outside/managed-file"
SOURCE_FILE="$SRC/managed-file"
printf '%s' original > "$SOURCE_FILE"
printf '%s' original > "$CASE/outside/managed-file"
set_mapping "$TARGET" "$SOURCE_FILE"
set_managed "$TARGET"
commit_all initial
run_hook pre
rm "$SOURCE_FILE"
commit_all remove
clear_managed
run_post_answer y
[[ -f $CASE/outside/managed-file ]] || fail 'traversal path escaped the destination'
pass 'traversal path is report-only'

# Exercise the hook through a real `chezmoi update`. The launcher must use the
# exported CHEZMOI_SOURCE_DIR; invoking `chezmoi source-path` here recursively
# would contend on the parent's persistent-state lock and produce /scripts/...
# after the substitution fails.
echo 'Testing real update hook launcher...'
E2E="$ROOT/update-e2e"
mkdir -p "$E2E/seed"
git -C "$E2E/seed" init -q
git -C "$E2E/seed" config user.email test@example.invalid
git -C "$E2E/seed" config user.name test
cp "$HOOK" "$E2E/seed/check-removed-files.sh"
printf 'initial\n' > "$E2E/seed/managed-file"
git -C "$E2E/seed" add .
git -C "$E2E/seed" commit -qm initial
git clone -q --bare "$E2E/seed" "$E2E/remote.git"
mkdir -p "$E2E/home/.local/share" "$E2E/home/.config/chezmoi"
git clone -q "$E2E/remote.git" "$E2E/home/.local/share/chezmoi"
cat > "$E2E/home/.config/chezmoi/chezmoi.toml" <<'EOF'
[hooks.update.pre]
command = "bash"
args = ["-c", "exec \"$CHEZMOI_SOURCE_DIR/check-removed-files.sh\" pre \"$@\"", "--"]
[hooks.update.post]
command = "bash"
args = ["-c", "exec \"$CHEZMOI_SOURCE_DIR/check-removed-files.sh\" post \"$@\"", "--"]
EOF
E2E_ENV=(env HOME="$E2E/home" XDG_CONFIG_HOME="$E2E/home/.config" XDG_CACHE_HOME="$E2E/home/.cache")
"${E2E_ENV[@]}" chezmoi apply --no-tty
mkdir -p "$E2E/upstream"
git clone -q "$E2E/remote.git" "$E2E/upstream"
git -C "$E2E/upstream" config user.email test@example.invalid
git -C "$E2E/upstream" config user.name test
rm "$E2E/upstream/managed-file"
git -C "$E2E/upstream" add -u
git -C "$E2E/upstream" commit -qm remove
git -C "$E2E/upstream" push -q
E2E_OUTPUT=$("${E2E_ENV[@]}" chezmoi update --no-tty 2>&1) || {
    printf '%s\n' "$E2E_OUTPUT" >&2
    fail 'real update hook failed'
}
case $E2E_OUTPUT in
    *'persistent state lock'*|*'/check-removed-files.sh: No such file'*)
        printf '%s\n' "$E2E_OUTPUT" >&2
        fail 'update hook recursively invoked chezmoi'
        ;;
esac
[[ ! -e $E2E/home/.cache/chezmoi/check-removed-files-v1/current ]] \
    || fail 'real update hook left transaction state'
pass 'real update hook launcher avoids persistent-state deadlock'

printf 'All check-removed-files tests passed.\n'
