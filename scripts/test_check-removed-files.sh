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

fail() {
    printf '❌ %s\n' "$*" >&2
    if [[ -n ${CASE:-} && -f $CASE/session.txt ]]; then
        printf '%s\n' '--- hook session output ---' >&2
        tr -d '\r' < "$CASE/session.txt" >&2
    fi
    exit 1
}
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
        CHECK_REMOVED_FILES_NO_TTY=true \
        CHEZMOI_SOURCE_DIR="$SRC" CHEZMOI_DEST_DIR="$DEST" \
        CHEZMOI_WORKING_TREE="$SRC" CHEZMOI_CACHE_DIR="$CACHE" \
        "$HOOK" "$@"
}

run_post_answer() {
    local answer=$1 before_verify=${2:-}
    if ! env PATH="$CASE/bin:$PATH" MOCK_MAP="$MAP" MOCK_MANAGED="$MANAGED" MOCK_CALLS="$CALLS" \
        CHECK_REMOVED_FILES_NO_TTY= CHECK_REMOVED_FILES_ANSWERS="$(printf '%b' "$answer")" \
        CHECK_REMOVED_FILES_TEST_BEFORE_VERIFY="$before_verify" \
        CHEZMOI_SOURCE_DIR="$SRC" CHEZMOI_DEST_DIR="$DEST" \
        CHEZMOI_WORKING_TREE="$SRC" CHEZMOI_CACHE_DIR="$CACHE" \
        "$HOOK" post > "$CASE/session.txt" 2>&1; then
        fail 'answer-injected post hook failed'
    fi
}

run_post_no_tty() {
    if ! env PATH="$CASE/bin:$PATH" MOCK_MAP="$MAP" MOCK_MANAGED="$MANAGED" MOCK_CALLS="$CALLS" \
        CHECK_REMOVED_FILES_ANSWERS= CHECK_REMOVED_FILES_CHOICE= CHECK_REMOVED_FILES_NO_TTY=true \
        CHEZMOI_SOURCE_DIR="$SRC" CHEZMOI_DEST_DIR="$DEST" \
        CHEZMOI_WORKING_TREE="$SRC" CHEZMOI_CACHE_DIR="$CACHE" \
        "$HOOK" post </dev/null > "$CASE/session.txt" 2>&1; then
        fail 'non-TTY post hook exited non-zero'
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

# Snapshot records use the production reader shape and carry its schema version.
new_case
prepare_file
run_hook pre
SCRIPT_STATE_VERSION=$(sed -n 's/^STATE_VERSION=//p' "$HOOK")
[[ $SCRIPT_STATE_VERSION =~ ^[1-9][0-9]*$ ]] || fail 'production state version is not a positive integer'
SNAPSHOT_RECORDS=0
while IFS= read -r -d '' snapshot_target \
    && IFS= read -r -d '' snapshot_target_relative \
    && IFS= read -r -d '' snapshot_source \
    && IFS= read -r -d '' snapshot_source_relative \
    && IFS= read -r -d '' snapshot_git_relative \
    && IFS= read -r -d '' snapshot_version \
    && IFS= read -r -d '' snapshot_provenance; do
    SNAPSHOT_RECORDS=$((SNAPSHOT_RECORDS + 1))
    [[ $snapshot_target == "$TARGET" \
        && $snapshot_target_relative == managed-file \
        && $snapshot_source == "$SOURCE_FILE" \
        && $snapshot_source_relative == managed-file \
        && $snapshot_git_relative == managed-file \
        && $snapshot_version == "$SCRIPT_STATE_VERSION" \
        && $snapshot_provenance == worktree ]] || fail 'bulk snapshot violated its versioned contract'
done < "$CACHE/check-removed-files-v1/current/snapshot.nul"
[[ $SNAPSHOT_RECORDS -eq 1 ]] || fail 'bulk snapshot record count is wrong'
pass 'bulk snapshot stores a versioned path and provenance mapping'

# A record from an older schema must never authorize deletion, even when the
# transaction metadata itself is valid for the current reader.
new_case
prepare_file
run_hook pre
SNAPSHOT="$CACHE/check-removed-files-v1/current/snapshot.nul"
REWRITTEN_SNAPSHOT="$CASE/snapshot.nul"
exec 5< "$SNAPSHOT"
IFS= read -r -d '' old_target <&5 || fail 'could not read snapshot target'
IFS= read -r -d '' old_target_relative <&5 || fail 'could not read snapshot target-relative path'
IFS= read -r -d '' old_source <&5 || fail 'could not read snapshot source'
IFS= read -r -d '' old_source_relative <&5 || fail 'could not read snapshot source-relative path'
IFS= read -r -d '' old_git_relative <&5 || fail 'could not read snapshot git-relative path'
IFS= read -r -d '' _old_schema <&5 || fail 'could not read snapshot schema'
IFS= read -r -d '' old_provenance <&5 || fail 'could not read snapshot provenance'
exec 5<&-
STALE_STATE_VERSION=$((SCRIPT_STATE_VERSION - 1))
printf '%s\0%s\0%s\0%s\0%s\0%s\0%s\0' \
    "$old_target" "$old_target_relative" "$old_source" "$old_source_relative" \
    "$old_git_relative" "$STALE_STATE_VERSION" "$old_provenance" > "$REWRITTEN_SNAPSHOT" \
    || fail 'could not rewrite snapshot schema'
mv "$REWRITTEN_SNAPSHOT" "$SNAPSHOT" || fail 'could not install mismatched-schema snapshot'
remove_source
run_post_answer y
[[ -f $TARGET ]] || fail 'mismatched snapshot schema allowed deletion'
pass 'mismatched snapshot schema leaves the target untouched'

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
# Performance/fan-out guard: pre must make exactly one bulk managed call.
[[ $(wc -l < "$CALLS") -eq 1 && $(<"$CALLS") == managed ]] \
    || fail 'pre did not make exactly one bulk managed call for 320 entries'
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
grep -Fq 'Delete unmanaged target' "$CASE/session.txt" || fail 'deletion prompt contract changed'
pass 'deleted unchanged file is accepted'

# Keep one real controlling-terminal path so /dev/tty detection and reads are
# covered independently of the deterministic answer-queue seam.
if command -v expect >/dev/null 2>&1; then
    new_case
    prepare_file
    run_hook pre
    remove_source
    # SC2016: $env(...) is expanded by Tcl inside the single-quoted expect
    # script, never by bash.
    # shellcheck disable=SC2016
    if ! env PATH="$CASE/bin:$PATH" MOCK_MAP="$MAP" MOCK_MANAGED="$MANAGED" MOCK_CALLS="$CALLS" \
        CHECK_REMOVED_FILES_NO_TTY= CHECK_REMOVED_FILES_ANSWERS= CHECK_REMOVED_FILES_CHOICE= \
        HOOK="$HOOK" SESSION_FILE="$CASE/session.txt" \
        CHEZMOI_SOURCE_DIR="$SRC" CHEZMOI_DEST_DIR="$DEST" \
        CHEZMOI_WORKING_TREE="$SRC" CHEZMOI_CACHE_DIR="$CACHE" \
        expect -c '
            set timeout 30
            log_user 0
            log_file $env(SESSION_FILE)
            spawn -noecho $env(HOOK) post
            expect {
                -re {Delete unmanaged target .*\[q\]uit: } { send -- "y\r" }
                eof { exit 98 }
                timeout { exec kill -9 [exp_pid]; exit 124 }
            }
            expect {
                eof {}
                timeout { exec kill -9 [exp_pid]; exit 124 }
            }
            set result [wait]
            exit [lindex $result 3]
        '; then
        fail 'real PTY prompt case failed or timed out'
    fi
    [[ ! -e $TARGET ]] || fail 'real PTY confirmation did not unlink the target'
    # The prompt contract is already pinned by the expect regex above and by
    # the answer-queue case; do not also grep the session log, because BSD
    # pty log capture under expect is not reliable for /dev/tty writes.
    pass 'real PTY prompt accepts an individual deletion'
else
    printf '%s\n' '⏭ skipping: expect unavailable'
fi

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
run_post_no_tty
[[ -f $TARGET ]] || fail 'non-TTY post removed a target'
grep -Fq "no interactive terminal; leaving $TARGET." "$CASE/session.txt" \
    || fail 'non-TTY report-only diagnostic changed'
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
grep -Fq "leaving $TARGET (changed, unsafe, or managed again)." "$CASE/session.txt" \
    || fail 'directory report-only diagnostic changed'
! grep -Fq 'Delete unmanaged target' "$CASE/session.txt" || fail 'directory report-only case prompted'
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
run_post_answer y "$CASE/mutate-parent"
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
E2E_ENV=(env HOME="$E2E/home" XDG_CONFIG_HOME="$E2E/home/.config" XDG_CACHE_HOME="$E2E/home/.cache" CHECK_REMOVED_FILES_NO_TTY=true)
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
