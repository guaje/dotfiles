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
    if [[ -n ${CASE:-} && -f $CASE/clean.txt ]]; then
        printf '%s\n' '--- clean output ---' >&2
        tr -d '\r' < "$CASE/clean.txt" >&2
    fi
    failures=$((failures + 1))
    # One broken case can leave state that breaks the next, so the default is to
    # stop at the first failure. A policy change needs the whole list at once,
    # which is what CHECK_REMOVED_FILES_TEST_CONTINUE=true is for; the exit status
    # still reports every failure counted.
    [[ ${CHECK_REMOVED_FILES_TEST_CONTINUE:-} == true ]] || exit 1
}
pass() { printf '✅ %s\n' "$*"; }
failures=0

make_mock() {
    mkdir -p "$CASE/bin"
    cat > "$CASE/bin/chezmoi" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$MOCK_CALLS"
case ${1:-} in
    managed) cat "$MOCK_MANAGED" ;;
    source-path|cat) exit 97 ;;
    *) exit 1 ;;
esac
EOF
    chmod +x "$CASE/bin/chezmoi"
}

source_id() { # <work-tree>: mirrors how the hook names its state directory
    local hash
    if command -v sha256sum >/dev/null 2>&1; then
        hash=$(printf '%s' "$1" | sha256sum | awk '{print $1}')
    else
        hash=$(printf '%s' "$1" | shasum -a 256 | awk '{print $1}')
    fi
    printf '%s' "${hash:0:16}"
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
    # The hook namespaces its state by working tree, since ~/.cache/chezmoi is shared
    # by every chezmoi source on the machine, so a case has to look for its state
    # where the hook actually writes it instead of hard-coding one directory.
    STATE=$CACHE/check-removed-files/$(source_id "$(git -C "$SRC" rev-parse --show-toplevel)")
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
        CHEZMOI_ARGS= \
        CHEZMOI_SOURCE_DIR="$SRC" CHEZMOI_DEST_DIR="$DEST" \
        CHEZMOI_WORKING_TREE="$SRC" CHEZMOI_CACHE_DIR="$CACHE" \
        "$HOOK" "$@"
}


run_post_args() { # <CHEZMOI_ARGS value> [hook argv...] - the general form
    local chezmoi_args=$1
    shift
    if ! env PATH="$CASE/bin:$PATH" MOCK_MAP="$MAP" MOCK_MANAGED="$MANAGED" MOCK_CALLS="$CALLS" \
        CHEZMOI_ARGS="$chezmoi_args" \
        CHEZMOI_SOURCE_DIR="$SRC" CHEZMOI_DEST_DIR="$DEST" \
        CHEZMOI_WORKING_TREE="$SRC" CHEZMOI_CACHE_DIR="$CACHE" \
        "$HOOK" post "$@" > "$CASE/session.txt" 2>&1; then
        fail 'post hook exited non-zero'
    fi
}

run_post() { # [pre-verify command]
    # The post hook of a normal update. The optional argument is the test-only seam
    # that runs between the first safety snapshot and the verification immediately
    # before the unlink, which is how the race-detection cases are made deterministic.
    local before_verify=${1:-}
    if ! env PATH="$CASE/bin:$PATH" MOCK_MAP="$MAP" MOCK_MANAGED="$MANAGED" MOCK_CALLS="$CALLS" \
        CHEZMOI_ARGS= \
        CHECK_REMOVED_FILES_TEST_BEFORE_VERIFY="$before_verify" \
        CHEZMOI_SOURCE_DIR="$SRC" CHEZMOI_DEST_DIR="$DEST" \
        CHEZMOI_WORKING_TREE="$SRC" CHEZMOI_CACHE_DIR="$CACHE" \
        "$HOOK" post > "$CASE/session.txt" 2>&1; then
        fail 'post hook exited non-zero'
    fi
}

run_post_dry() {
    # CHEZMOI_ARGS is one way --dry-run reaches a hook; it is passed here rather
    # than as a shell prefix assignment, which bash would leave set in the calling
    # shell and leak into every later case.
    run_post_args 'update --dry-run'
}

run_post_dry_argv() {
    # The hook launcher in .chezmoi.toml.tmpl forwards the chezmoi command line as
    # hook argv, so --dry-run has to be recognised there too.
    run_post_args '' update --dry-run
}

run_clean() {
    # Deliberately returns the status so a case can assert on it.
    local status=0
    env PATH="$CASE/bin:$PATH" MOCK_MAP="$MAP" MOCK_MANAGED="$MANAGED" MOCK_CALLS="$CALLS" \
        CHEZMOI_ARGS= \
        CHEZMOI_SOURCE_DIR="$SRC" CHEZMOI_DEST_DIR="$DEST" \
        CHEZMOI_WORKING_TREE="$SRC" CHEZMOI_CACHE_DIR="$CACHE" \
        "$HOOK" clean "$@" > "$CASE/clean.txt" 2>&1 || status=$?
    return "$status"
}

unsafe_seam() { # <path>: makes that path's parent group-writable at verification time
    # A group-writable directory fails the safety check that runs immediately before
    # the unlink, which is how a case makes the hook verify a removal, refuse it, and
    # write it down for a retry - the only thing the pending ledger is for now.
    printf '#!/usr/bin/env bash\nset -eu\nchmod 777 %q\n' "$(dirname "$1")" > "$CASE/unsafe-parent"
    chmod +x "$CASE/unsafe-parent"
}

defer_removal() { # [target]: verify the removal, refuse it once, leave it recorded
    local path=${1:-$TARGET}
    unsafe_seam "$path"
    run_post "$CASE/unsafe-parent"
    chmod 700 "$(dirname "$path")"
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

# Missing state is an ordinary no-op, and stays that way: a post with nothing to
# consume must not create state either.
new_case
run_hook post
for leftover in current last lock pending.nul; do
    [[ ! -e $STATE/$leftover ]] || {
        printf 'unexpected %s\n' "$leftover" >&2
        fail 'a post with no state created state'
    }
done
pass 'missing state is a no-op'

# chezmoi creates its cache directory only when something needs it, and on
# Android/Termux ~/.cache is routinely absent. A missing cache directory must
# not silence the hook: that is exactly how orphaned targets survive forever.
new_case
prepare_file
rm -rf "$CACHE"
run_hook pre
[[ -d $CACHE && ! -L $CACHE ]] || fail 'pre did not create the chezmoi cache directory'
CACHE_MODE=$(stat -c '%a' "$CACHE" 2>/dev/null || stat -f '%Lp' "$CACHE")
(( (8#$CACHE_MODE & 022) == 0 )) \
    || fail "created cache directory is group or world accessible ($CACHE_MODE)"
[[ -f $STATE/current/snapshot.nul ]] \
    || fail 'pre wrote no snapshot when the cache directory had to be created'
remove_source
run_post
[[ ! -e $TARGET ]] || fail 'target survived an update whose cache directory did not exist beforehand'
pass 'missing cache directory is created instead of disabling the hook'

# Snapshot records use the production reader shape: target, its two source
# representations, the git-relative path that proves provenance, and provenance.
new_case
prepare_file
run_hook pre
SNAPSHOT_RECORDS=0
while IFS= read -r -d '' snapshot_target \
    && IFS= read -r -d '' snapshot_target_relative \
    && IFS= read -r -d '' snapshot_source \
    && IFS= read -r -d '' snapshot_source_relative \
    && IFS= read -r -d '' snapshot_git_relative \
    && IFS= read -r -d '' snapshot_provenance; do
    SNAPSHOT_RECORDS=$((SNAPSHOT_RECORDS + 1))
    [[ $snapshot_target == "$TARGET" \
        && $snapshot_target_relative == managed-file \
        && $snapshot_source == "$SOURCE_FILE" \
        && $snapshot_source_relative == managed-file \
        && $snapshot_git_relative == managed-file \
        && $snapshot_provenance == worktree ]] || fail 'bulk snapshot violated its record contract'
done < "$STATE/current/snapshot.nul"
[[ $SNAPSHOT_RECORDS -eq 1 ]] || fail 'bulk snapshot record count is wrong'
pass 'bulk snapshot stores a path and provenance mapping'

# State written in a shape this script does not write - a record from an older
# binary, or a ledger half-written by an interrupted run - must misalign into
# something it refuses, never into permission to delete.
new_case
prepare_file
run_hook pre
SNAPSHOT="$STATE/current/snapshot.nul"
REWRITTEN_SNAPSHOT="$CASE/snapshot.nul"
exec 5< "$SNAPSHOT"
IFS= read -r -d '' old_target <&5 || fail 'could not read snapshot target'
IFS= read -r -d '' old_target_relative <&5 || fail 'could not read snapshot target-relative path'
IFS= read -r -d '' old_source <&5 || fail 'could not read snapshot source'
IFS= read -r -d '' old_source_relative <&5 || fail 'could not read snapshot source-relative path'
IFS= read -r -d '' old_git_relative <&5 || fail 'could not read snapshot git-relative path'
IFS= read -r -d '' old_provenance <&5 || fail 'could not read snapshot provenance'
exec 5<&-
printf '%s\0%s\0%s\0%s\0%s\0%s\0%s\0' \
    "$old_target" "$old_target_relative" "$old_source" "$old_source_relative" \
    "$old_git_relative" "4" "$old_provenance" > "$REWRITTEN_SNAPSHOT" \
    || fail 'could not rewrite the snapshot in another shape'
mv "$REWRITTEN_SNAPSHOT" "$SNAPSHOT" || fail 'could not install the mismatched snapshot'
remove_source
run_post
[[ -f $TARGET ]] || fail 'a record shape this script does not write authorized deletion'
grep -Fq 'leaving ambiguous target' "$CASE/session.txt" \
    || fail 'the unreadable record was not reported as ambiguous'
pass 'state in an unreadable record shape leaves the target untouched'

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
[[ $(wc -l < "$CALLS") -eq 1 && $(<"$CALLS") == managed* ]] \
    || fail 'pre did not make exactly one bulk managed call for 320 entries'
pass 'pre chezmoi invocation count is constant across 320 entries'

# Missing jq or malformed bulk JSON cannot publish deletion state.
new_case
prepare_file
printf '%s\n' 'not-json' > "$MANAGED"
run_hook pre
[[ ! -e $STATE/current && ! -e $STATE/lock ]] \
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
[[ ! -e $STATE/current && ! -e $STATE/lock ]] \
    || fail 'unavailable jq published state'
pass 'unavailable jq fails closed'

# A failed update leaves pre-state behind. A later pre must reclaim a lock
# whose parent chezmoi PID no longer exists instead of disabling the hook.
new_case
prepare_file
STALE_ROOT="$STATE"
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

# The ordinary case: the source is gone, nothing manages the target any more, and
# the update removes the file and says which one it removed and why.
new_case
prepare_file
run_hook pre
remove_source
run_post
[[ ! -e $TARGET ]] || fail 'a verified orphan survived the update that removed its source'
grep -Fq "deleted; no longer managed by chezmoi: $TARGET" "$CASE/session.txt" \
    || fail 'the run did not say which deletion it was carrying out'
grep -Fq "deleted $TARGET." "$CASE/session.txt" \
    || fail 'the completed deletion was not reported'
pass 'a verified orphan is removed by the update'

# Asset and model directories routinely lose a dozen generated files in one commit.
# The repository decided that, so an unattended update applies all of it: one
# cleanup, not five deletions and a to-do list.
new_case
many_targets=()
for name in one two three four five six; do
    printf '%s\n' "$name" > "$SRC/asset-$name"
    printf '%s\n' "$name" > "$DEST/.config-model-$name"
    printf '%s\t%s\n' "$DEST/.config-model-$name" "$SRC/asset-$name" >> "$MAP"
    many_targets+=("$DEST/.config-model-$name")
done
set_managed "${many_targets[@]}"
commit_all initial
run_hook pre
rm "$SRC"/asset-one "$SRC"/asset-two "$SRC"/asset-three "$SRC"/asset-four \
    "$SRC"/asset-five "$SRC"/asset-six
commit_all remove
clear_managed
run_post
for path in "${many_targets[@]}"; do
    [[ ! -e $path ]] || fail "an unattended bulk cleanup left $path behind"
done
[[ ! -e $STATE/pending.nul ]] \
    || fail 'a bulk cleanup the update could carry out was left on the ledger'
pass 'a bulk cleanup is applied by an unattended update'

# A directory exists because chezmoi made it for the files inside it. Once the
# repository stops tracking all of them the empty shell goes too, and a chain of
# emptied directories is pruned up to the first one still holding something.
new_case
for name in a b; do
    printf '%s\n' "$name" > "$SRC/deep-$name"
    mkdir -p "$DEST/.config/assets/inner"
    printf '%s\n' "$name" > "$DEST/.config/assets/inner/$name"
    printf '%s\t%s\n' "$DEST/.config/assets/inner/$name" "$SRC/deep-$name" >> "$MAP"
done
printf 'keep me' > "$DEST/.config/keeper"
set_managed "$DEST/.config/assets/inner/a" "$DEST/.config/assets/inner/b"
commit_all initial
run_hook pre
rm "$SRC"/deep-a "$SRC"/deep-b
commit_all remove
clear_managed
run_post
[[ -d $DEST/.config/assets/inner ]] && fail 'an emptied directory survived the cleanup'
[[ -d $DEST/.config/assets ]] && fail 'a directory emptied by pruning survived'
[[ -d $DEST/.config ]] || fail 'pruning went past a directory that still holds a file'
[[ -f $DEST/.config/keeper ]] || fail 'pruning removed a file it was never asked about'
pass 'a directory the cleanup emptied is removed with its files'

# The shape a generated asset generation really has: one manifest beside a directory
# of per-model snapshots. The manifest sorts before the snapshots, so walking up from
# each removed file reaches the parent while the snapshot directory is still inside it.
# An update that removed every file in that tree has to come back for the parent once
# the child is gone, or the shell of the tree survives in the destination forever.
new_case
mkdir -p "$DEST/.config/generation/models"
printf 'keep me' > "$DEST/.config/keeper"
printf 'manifest\n' > "$SRC/generation-manifest.json"
printf 'one\n' > "$SRC/generation-one.json"
printf 'two\n' > "$SRC/generation-two.json"
cp "$SRC/generation-manifest.json" "$DEST/.config/generation/manifest.json"
cp "$SRC/generation-one.json" "$DEST/.config/generation/models/one.json"
cp "$SRC/generation-two.json" "$DEST/.config/generation/models/two.json"
{
    printf '%s\t%s\n' "$DEST/.config/generation/manifest.json" "$SRC/generation-manifest.json"
    printf '%s\t%s\n' "$DEST/.config/generation/models/one.json" "$SRC/generation-one.json"
    printf '%s\t%s\n' "$DEST/.config/generation/models/two.json" "$SRC/generation-two.json"
} >> "$MAP"
set_managed "$DEST/.config/generation/manifest.json" \
    "$DEST/.config/generation/models/one.json" "$DEST/.config/generation/models/two.json"
commit_all initial
run_hook pre
rm "$SRC"/generation-manifest.json "$SRC"/generation-one.json "$SRC"/generation-two.json
commit_all remove
clear_managed
run_post
[[ ! -e $DEST/.config/generation ]] \
    || fail 'a directory left empty by the removal of its own subdirectory survived'
grep -Fq "removed empty directory $DEST/.config/generation/models." "$CASE/session.txt" \
    || fail 'the emptied subdirectory was not reported'
grep -Fq "removed empty directory $DEST/.config/generation." "$CASE/session.txt" \
    || fail 'the emptied parent was not reported'
[[ -d $DEST/.config ]] || fail 'pruning walked past a directory that still holds a file'
[[ -f $DEST/.config/keeper ]] || fail 'pruning removed a file it was never asked about'
pass 'a parent emptied by the removal of its subdirectory is pruned too'

# The promise that no data is lost rests on rmdir succeeding only on an empty
# directory: one untracked leftover, and the shell stays.
new_case
for name in a b; do
    printf '%s\n' "$name" > "$SRC/keep-$name"
    mkdir -p "$DEST/.config/legacy"
    printf '%s\n' "$name" > "$DEST/.config/legacy/$name"
    printf '%s\t%s\n' "$DEST/.config/legacy/$name" "$SRC/keep-$name" >> "$MAP"
done
printf 'never tracked' > "$DEST/.config/legacy/local-only"
set_managed "$DEST/.config/legacy/a" "$DEST/.config/legacy/b"
commit_all initial
run_hook pre
rm "$SRC"/keep-a "$SRC"/keep-b
commit_all remove
clear_managed
run_post
[[ ! -e $DEST/.config/legacy/a && ! -e $DEST/.config/legacy/b ]] \
    || fail 'the tracked files of a partly untracked directory were kept'
[[ -d $DEST/.config/legacy ]] || fail 'a directory holding an untracked file was removed'
[[ -f $DEST/.config/legacy/local-only ]] \
    || fail 'a file the repository never tracked was removed with the directory'
pass 'a directory with anything left in it is kept'

# A directory chezmoi renders itself - a create_ target, an external directory, a
# config directory - is managed whatever else is empty, and stays.
new_case
for name in a b; do
    printf '%s\n' "$name" > "$SRC/owned-$name"
    mkdir -p "$DEST/.config/owned"
    printf '%s\n' "$name" > "$DEST/.config/owned/$name"
    printf '%s\t%s\n' "$DEST/.config/owned/$name" "$SRC/owned-$name" >> "$MAP"
done
# The directory itself is a chezmoi target that outlives the files inside it.
printf 'managed directory' > "$SRC/dot_owned"
printf '%s\t%s\n' "$DEST/.config/owned" "$SRC/dot_owned" >> "$MAP"
set_managed "$DEST/.config/owned/a" "$DEST/.config/owned/b" "$DEST/.config/owned"
commit_all initial
run_hook pre
rm "$SRC"/owned-a "$SRC"/owned-b
commit_all remove
# Only the directory is managed any more; the two files under it are not.
set_managed "$DEST/.config/owned"
run_post
[[ -d $DEST/.config/owned ]] || fail 'a directory chezmoi still manages was removed'
[[ ! -e $DEST/.config/owned/a && ! -e $DEST/.config/owned/b ]] \
    || fail 'the untracked files of a managed directory were kept'
pass 'a managed directory is never pruned'

# The manual drain prunes too: it is the same decision reached by the other door,
# and a directory left behind by `clean` is a directory nobody owns any more. Here
# the removal is refused once - the parent went unsafe between the snapshot and the
# unlink - so the files, and their directory, wait for the retry.
new_case

for name in a b; do
    printf '%s\n' "$name" > "$SRC/clean-$name"
    mkdir -p "$DEST/.config/cleaned"
    printf '%s\n' "$name" > "$DEST/.config/cleaned/$name"
    printf '%s\t%s\n' "$DEST/.config/cleaned/$name" "$SRC/clean-$name" >> "$MAP"
done
set_managed "$DEST/.config/cleaned/a" "$DEST/.config/cleaned/b"
commit_all initial
run_hook pre
rm "$SRC"/clean-a "$SRC"/clean-b
commit_all remove
clear_managed
cat > "$CASE/unsafe-parent" <<'EOF'
#!/usr/bin/env bash
set -eu
chmod 777 "$(dirname "$1")"
EOF
chmod +x "$CASE/unsafe-parent"
run_post "$CASE/unsafe-parent"
[[ -f $DEST/.config/cleaned/a && -f $DEST/.config/cleaned/b ]] \
    || fail 'a removal the checks refused was carried out anyway'
[[ -d $DEST/.config/cleaned ]] || fail 'a refused removal still pruned its directory'
chmod 700 "$DEST/.config/cleaned"
run_clean || fail 'clean exited non-zero'
grep -Fq "removed empty directory $DEST/.config/cleaned." "$CASE/clean.txt" \
    || fail 'clean removed the files but left their directory behind'
[[ ! -d $DEST/.config/cleaned ]] || fail 'clean reported pruning a directory it kept'
pass 'clean prunes the directories it emptied'

# A preview promises to change nothing, and an empty directory is a change. The
# candidates it verifies are written down for the real run that follows.
new_case
printf 'preview' > "$SRC/preview-file"
mkdir -p "$DEST/.config/previewed"
printf 'preview' > "$DEST/.config/previewed/preview-file"
printf '%s\t%s\n' "$DEST/.config/previewed/preview-file" "$SRC/preview-file" >> "$MAP"
set_managed "$DEST/.config/previewed/preview-file"
commit_all initial
run_hook pre
rm "$SRC/preview-file"
commit_all remove
clear_managed
run_hook post --dry-run > "$CASE/session.txt" 2>&1 || true
[[ -f $DEST/.config/previewed/preview-file ]] || fail 'a preview removed a file'
[[ -d $DEST/.config/previewed ]] || fail 'a preview pruned a directory'
grep -Fq "would remove $DEST/.config/previewed/preview-file" "$CASE/session.txt" \
    || fail 'the preview did not name the file it declined to remove'
[[ -f $STATE/pending.nul ]] \
    || fail 'the preview threw away what it had verified'
pass 'a preview neither deletes nor prunes'

# A git directory is not this hook's to tidy, however empty the repository left it.
# Nothing in a .git path is ever offered for rmdir on the way up out of a deletion.
new_case
printf 'fragment' > "$SRC/git-fragment"
mkdir -p "$DEST/.git/hooks"
printf 'fragment' > "$DEST/.git/hooks/fragment"
printf '%s\t%s\n' "$DEST/.git/hooks/fragment" "$SRC/git-fragment" >> "$MAP"
set_managed "$DEST/.git/hooks/fragment"
commit_all initial
run_hook pre
rm "$SRC/git-fragment"
commit_all remove
clear_managed
run_post
[[ ! -e $DEST/.git/hooks/fragment ]] \
    || fail 'the tracked file inside a git directory survived'
grep -Fq "removed empty directory $DEST/.git" "$CASE/session.txt" \
    && fail 'a git directory was pruned'
[[ -d $DEST/.git && -d $DEST/.git/hooks ]] || fail 'a git directory was removed'
pass 'a .git path is never pruned'

# The destination directory is where this hook is allowed to work, not something
# it is allowed to leave behind: an update that empties it does not rmdir it.
new_case
prepare_file
run_hook pre
remove_source
run_post
[[ ! -e $TARGET ]] || fail 'the file directly in the destination survived'
[[ -d $DEST ]] || fail 'the destination directory itself was pruned'
if grep -Fq "removed empty directory $DEST." "$CASE/session.txt"; then
    fail 'the destination directory was reported as pruned'
fi
pass 'pruning stops at the destination directory'

# A file the repository stopped tracking is the repository's decision too, even
# when it was edited by hand: nothing here keeps a copy of contents that were never
# in git, which is exactly why the recorded fingerprint, not a look at the file, is
# what an unlink is allowed to rely on.
new_case
prepare_file
printf '%s' locally-modified > "$TARGET"
run_hook pre
remove_source
run_post
[[ ! -e $TARGET ]] || fail 'a locally edited orphan survived the update that removed its source'
pass 'a locally edited orphan is removed too'

# A preview neither deletes nor re-decides: two previews of the same update leave
# the same record and the same files behind. CHEZMOI_ARGS is what carries --dry-run
# to a chezmoi hook, which is given no argv of its own.
new_case
prepare_file
run_hook pre
remove_source
run_post_dry
LEDGER=$STATE/pending.nul
[[ -f $LEDGER ]] || fail 'a preview recorded nothing'
[[ -f $TARGET ]] || fail 'a dry run removed a target'
grep -Fq "dry run; would remove $TARGET (left pending)." "$CASE/session.txt" \
    || fail 'dry run did not report the candidate it passed over'
cp "$LEDGER" "$CASE/ledger.before"
run_post_dry
cmp -s "$LEDGER" "$CASE/ledger.before" \
    || fail 'a second preview rewrote the pending ledger'
[[ -f $TARGET ]] || fail 'a second preview removed a target'
pass 'a dry run deletes nothing and decides nothing twice'

# A preview may neither unlink nor lose what it verified: the run that does act has
# to be able to act on it. --dry-run=false is a real run, which means it deletes.
new_case
prepare_file
printf '%s' second > "$SRC/second-file"
cp "$SRC/second-file" "$DEST/second-file"
printf '%s\t%s\n' "$DEST/second-file" "$SRC/second-file" >> "$MAP"
set_managed "$TARGET" "$DEST/second-file"
commit_all second-file
run_hook pre
rm -f "$SRC/managed-file" "$SRC/second-file"
commit_all remove-sources
clear_managed
run_post_dry
if [[ $(grep -cF 'dry run; would remove' "$CASE/session.txt") -ne 2 ]]; then
    fail 'dry-run post did not report both orphan candidates'
fi
pending_fields=$(sed -n 's/^PENDING_FIELDS=//p' "$HOOK")
mapfile -d '' ledger_fields < "$STATE/pending.nul"
[[ ${#ledger_fields[@]} -eq $((2 * pending_fields)) ]] \
    || fail 'a preview lost the candidates that it had verified'
[[ -f $TARGET && -f $DEST/second-file ]] || fail 'a preview removed a target'
run_post_dry_argv
if [[ $(grep -cF 'dry run; would remove' "$CASE/session.txt") -ne 2 ]]; then
    fail '--dry-run reaching the hook as argv was not recognised as a preview'
fi
mapfile -d '' ledger_fields < "$STATE/pending.nul"
[[ ${#ledger_fields[@]} -eq $((2 * pending_fields)) ]] \
    || fail 'a second preview counted the same candidates twice'
if ! env PATH="$CASE/bin:$PATH" MOCK_MAP="$MAP" MOCK_MANAGED="$MANAGED" MOCK_CALLS="$CALLS" \
    CHEZMOI_ARGS= \
    CHEZMOI_SOURCE_DIR="$SRC" CHEZMOI_DEST_DIR="$DEST" \
    CHEZMOI_WORKING_TREE="$SRC" CHEZMOI_CACHE_DIR="$CACHE" \
    "$HOOK" post --dry-run=false </dev/null > "$CASE/session.txt" 2>&1; then
    fail 'post --dry-run=false exited non-zero'
fi
if grep -Fq 'dry run;' "$CASE/session.txt"; then
    fail '--dry-run=false was read as a request for a preview'
fi
[[ ! -e $TARGET && ! -e $DEST/second-file ]] \
    || fail '--dry-run=false was treated as a preview instead of a real update'
[[ ! -e $STATE/pending.nul ]] \
    || fail 'the run that deleted both targets left them pending'
pass 'a preview records what it verified and removes nothing'

# An update that pulled nothing proves nothing on its own, but the retained
# baseline may still owe a removal. It has to speak once, then be consumed, so the
# same removal is not announced again on every later no-op update.
new_case

prepare_file
run_hook pre
remove_source
# The update carries the decision out, and the snapshot it consumed is retained as
# the baseline the next update falls back on.
run_post
[[ ! -e $TARGET ]] || fail 'the update left the orphan its repository stopped tracking'
[[ -d $STATE/last ]] || fail 'a consumed update left no baseline'
BASELINE_HEAD=$(tr '\0' '\n' < "$STATE/last/meta.nul" | sed -n 2p)
[[ -n $BASELINE_HEAD ]] || fail 'the baseline recorded no HEAD'
[[ $BASELINE_HEAD == $(git -C "$SRC" rev-parse HEAD~1) ]] \
    || fail 'the baseline did not record the pre-update HEAD'
# A fresh transaction at the current HEAD, as any `chezmoi update` with nothing
# to pull produces: the baseline is older than HEAD, so it is consulted, and the
# file it describes is already gone.
set_managed
run_hook pre
run_post
grep -Fq 'nothing was pulled; using the retained baseline.' "$CASE/session.txt" \
    || fail 'an update that pulled nothing ignored the retained baseline'
! grep -Fq 'deleted ' "$CASE/session.txt" \
    || fail 'a consumed baseline reported a file that was already removed'
[[ $(tr '\0' '\n' < "$STATE/last/meta.nul" | sed -n 2p) \
    == $(git -C "$SRC" rev-parse HEAD) ]] \
    || fail 'a consumed baseline was not advanced'
# The update after that has nothing left to say about it either.
run_hook pre
run_post
! grep -Fq 'deleted ' "$CASE/session.txt" \
    || fail 'a third update found the same removal again'
pass 'a no-op update carries out the retained baseline once'

# The repository is the source of truth, so an unattended update carries out the
# decision the repository already made instead of waiting for a reply that will
# never arrive: it removes the verified orphan and says so, out loud.
new_case
prepare_file
run_hook pre
remove_source
run_post
[[ ! -e $TARGET ]] || fail 'an unattended update left the orphan its repository stopped tracking'
grep -Fq 'no longer managed by chezmoi' "$CASE/session.txt" \
    || fail 'the update did not say what it removed and on what evidence'
[[ ! -e $STATE/pending.nul ]] \
    || fail 'a decision that was carried out stayed on the ledger'
pass 'an unattended update enforces what the repository decided'

# The difference between a preview and a real run is the difference between keeping
# your files and losing them, so every spelling chezmoi can hand to a hook has to be
# read the same way, through CHEZMOI_ARGS and through forwarded argv alike.
new_case
prepare_file
for flag in '--dry-run' '--dry-run=true' '--dry-run=1' '-n'; do
    run_hook pre update "$flag"
    [[ ! -e $STATE/current && ! -e $STATE/lock ]] \
        || fail "a preview whose flag read $flag took an update snapshot"
done
run_hook pre
remove_source
for flag in '--dry-run' '--dry-run=true' '--dry-run=1' '-n'; do
    run_post_args "update $flag"
    [[ -f $TARGET ]] || fail "a preview whose flag read $flag deleted a target"
    run_post_args '' update "$flag"
    [[ -f $TARGET ]] || fail "a preview passed as argv ($flag) deleted a target"
done
run_post_args 'update --dry-run=false'
[[ ! -e $TARGET ]] || fail '--dry-run=false was treated as a preview and deleted nothing'
pass 'every spelling of --dry-run is read as a preview'

# A deferred removal is not a command to remember either: the next update settles
# it. By the round after, the transaction proves nothing and only the ledger still
# knows this target was ever managed.
new_case
prepare_file
run_hook pre
remove_source
defer_removal
[[ -f $TARGET ]] || fail 'a removal the checks refused was carried out anyway'
[[ -f $STATE/pending.nul ]] \
    || fail 'the refused removal was never written down'
run_hook pre
run_post
[[ ! -e $TARGET ]] || fail 'a plain chezmoi update left the recorded orphan behind'
[[ ! -e $STATE/pending.nul ]] \
    || fail 'a settled decision stayed on the ledger'
pass 'a later update settles what an earlier one recorded'

# Most updates delete nothing at all, and that path still has to reach the end of
# the hook. An empty candidate list used to abort the hook on `set -u`, which
# skipped whatever was owed from earlier updates without a word about it.
new_case

prepare_file
run_hook pre
remove_source
defer_removal
# Pretend the evidence behind that removal has since been consumed, so the ledger row
# is all that is left; then move HEAD with a commit that deletes nothing, so this
# update has no candidate of its own at all.
rm -rf "$STATE/last"
printf '%s' unrelated > "$SRC/later-file"
commit_all later-file
run_hook pre
run_post
grep -Fq 'still waiting' "$CASE/session.txt" \
    || fail 'a post hook with nothing to remove stopped before the ledger'
[[ ! -e $TARGET ]] || fail 'the debt from an earlier update was never settled'
pass 'an update with nothing to remove still finishes the job'

# Deleting is not the only thing a ledger entry is for, and a preview may not do
# the deleting: it records what it verified and touches nothing.
new_case
prepare_file
run_hook pre
remove_source
run_post_dry
[[ -f $TARGET ]] || fail 'a preview removed a target'
grep -Fq "dry run; would remove $TARGET (left pending)." "$CASE/session.txt" \
    || fail 'the preview did not name the deletion it would have made'
[[ -f $STATE/pending.nul ]] \
    || fail 'the preview threw away the candidate it had verified'
pass 'a preview reports the deletions it would make'

# Chezmoi runs the pre hook of a preview but never its post hook, so a preview that
# took a snapshot would leave a transaction for the next real update to treat as an
# interrupted one - a false incident on the one path that runs most often.
new_case
prepare_file
run_hook pre update --dry-run
[[ ! -e $STATE/current ]] \
    || fail 'a preview snapshotted the managed mapping'
[[ ! -e $STATE/lock ]] \
    || fail 'a preview opened an update transaction that nothing will close'
pass 'a preview opens no update transaction'

# A target whose contents change between the verification and the unlink is not
# the file that was decided about, so it is left and recorded. The update that
# snapshots what it holds now is the one allowed to remove it.
new_case

prepare_file
run_hook pre
remove_source
cat > "$CASE/mutate-contents" <<'EOF'
#!/usr/bin/env bash
set -eu
printf 'edited-after-the-fact' > "$1"
EOF
chmod +x "$CASE/mutate-contents"
run_post "$CASE/mutate-contents"
[[ -f $TARGET ]] || fail 'a target edited under the verification was deleted'
[[ -f $STATE/pending.nul ]] \
    || fail 'a target that failed verification was not recorded for a retry'
run_clean || fail 'clean exited non-zero'
grep -Fq "leaving $TARGET (changed since it was recorded)." "$CASE/clean.txt" \
    || fail 'the changed-after-recording diagnostic changed'
[[ -f $TARGET ]] || fail 'clean deleted a target whose contents are not the ones it verified'
# The next update records the file as it stands, and then it can be removed.
run_hook pre
run_post
[[ ! -e $TARGET ]] || fail 'a later update left the orphan in place'
pass 'a target edited after it was recorded waits for the next update'

# A clean invocation must not guess at an unrecognised flag: a mistyped option may
# never be read as a request to delete.
new_case

prepare_file
run_hook pre
remove_source
defer_removal
if run_clean --confirm; then
    fail 'clean accepted an unknown argument'
fi
[[ -f $TARGET ]] || fail 'an unknown clean argument removed a target'
grep -Fq 'unknown argument' "$CASE/clean.txt" \
    || fail 'unknown argument diagnostic changed'
pass 'clean rejects unknown arguments'

# Scratch files are only reclaimed once no live run can be holding one, and the
# management question asked before an unlink has to cover every entry type: a
# destination that chezmoi took back as a directory, a script, or an external
# resource is still chezmoi\'s.
new_case
prepare_file
run_hook pre
mkdir -p "$STATE"
: > "$STATE/.diff.stale"
: > "$STATE/.managed-check.stale"
: > "$STATE/.diff.recent"
touch -t 202001010000 \
    "$STATE/.diff.stale" \
    "$STATE/.managed-check.stale"
remove_source
run_post
[[ ! -e $STATE/.diff.stale ]] \
    || fail 'a day-old scratch file was never reclaimed'
[[ ! -e $STATE/.managed-check.stale ]] \
    || fail 'a day-old management listing was never reclaimed'
[[ -e $STATE/.diff.recent ]] \
    || fail 'scratch belonging to a live run was reclaimed'
grep -Fxq 'managed --include=files,symlinks --path-style=all --format=json' "$CALLS" \
    || fail 'the snapshot no longer asks for just files and symlinks'
grep -Fxq 'managed --include=all --path-style=all --format=json' "$CALLS" \
    || fail 'the management check before an unlink ignores entries that are not files'
pass 'stale scratch is reclaimed and the deletion check sees every entry type'

# A source that came back is a dotfile again, not an orphan.
new_case

prepare_file
run_hook pre
remove_source
defer_removal
[[ -f $STATE/pending.nul ]] || fail 'no ledger to retire'
git -C "$SRC" checkout HEAD~1 -- managed-file
commit_all restore
run_clean --list || fail 'clean exited non-zero'
[[ -f $TARGET ]] || fail 'clean removed a target whose source came back'
grep -Fq 'its source exists again' "$CASE/clean.txt" \
    || fail 'the returned-source diagnostic changed'
[[ ! -e $STATE/pending.nul ]] \
    || fail 'a returned source left the entry pending'
pass 'clean retires entries whose source came back'

# A ledger this script cannot parse is never acted on, and never kept either.
new_case

prepare_file
run_hook pre
remove_source
defer_removal
printf 'garbage' > "$STATE/pending.nul"
if run_clean; then
    fail 'a corrupt ledger was reported as a clean no-op'
fi
[[ -f $TARGET ]] || fail 'a corrupt ledger authorized a deletion'
grep -Fq 'pending ledger is unreadable' "$CASE/clean.txt" \
    || fail 'the corrupt ledger diagnostic changed'
[[ ! -e $STATE/pending.nul ]] \
    || fail 'a corrupt ledger was left in place'
pass 'a corrupt ledger is dropped, not obeyed'

# State this script cannot use is dropped rather than filed away, so there is no
# leftover tree to wonder about later.
new_case
prepare_file
run_hook pre
rm -f "$STATE/current/snapshot.nul"
remove_source
run_post
[[ -f $TARGET ]] || fail 'a truncated snapshot authorized a deletion'
[[ ! -e $STATE/current ]] \
    || fail 'a truncated snapshot was kept as a transaction'
[[ ! -e $STATE/quarantine ]] \
    || fail 'unreadable state was filed away instead of dropped'
pass 'unreadable state is dropped rather than kept'

# A target that is managed again - taken back by a later commit, after the deletion
# this evidence describes - is no decision to keep retrying.
new_case

prepare_file
run_hook pre
remove_source
defer_removal
[[ -f $STATE/pending.nul ]] || fail 'no ledger to retire'
printf '%s' reclaimed > "$SRC/other-source"
set_mapping "$TARGET" "$SRC/other-source"
set_managed "$TARGET"
commit_all reclaim
rm -rf "$STATE/current" "$STATE/lock"
run_post
[[ -f $TARGET ]] || fail 'a re-adopted target was removed'
grep -Fq 'using the retained baseline.' "$CASE/session.txt" \
    || fail 'the re-adopted target case did not reach the baseline path'
! grep -Fq "deleted $TARGET." "$CASE/session.txt" \
    || fail 'a managed target was removed'
[[ ! -e $STATE/pending.nul ]] \
    || fail 'a re-adopted target stayed in the pending ledger'
pass 'a target chezmoi took back leaves the ledger'

# One orphan is one entry, however many updates report it. Here the removal stays
# impossible for the whole case, so each round must refresh the same row instead of
# appending another one.
new_case

prepare_file
run_hook pre
remove_source
unsafe_seam "$TARGET"
run_post "$CASE/unsafe-parent"
grep -Fq '1 orphaned target(s) recorded by earlier updates' "$CASE/session.txt" \
    || fail 'the first update did not report the removal it could not carry out'
rm -rf "$STATE/current" "$STATE/lock"
run_post
! grep -Fq '2 orphaned target(s)' "$CASE/session.txt" \
    || fail 'the same orphan was announced as two entries'
mapfile -d '' ledger_fields < "$STATE/pending.nul"
[[ ${#ledger_fields[@]} -eq $(sed -n 's/^PENDING_FIELDS=//p' "$HOOK") ]] \
    || fail 'a repeated orphan was appended to the ledger instead of refreshed'
chmod 700 "$DEST"
pass 'a repeated orphan is counted once'

# A recorded source path is data, not a pattern: a name git would glob must be
# looked up literally, or an existing source reads as an absent one.
new_case

TARGET="$DEST/we[ir]d-name"
SOURCE_FILE="$SRC/we[ir]d-name"
printf '%s' original > "$SOURCE_FILE"
cp "$SOURCE_FILE" "$TARGET"
set_mapping "$TARGET" "$SOURCE_FILE"
set_managed "$TARGET"
commit_all initial
run_hook pre
rm -f "$SOURCE_FILE"
commit_all remove
clear_managed
defer_removal
[[ -f $STATE/pending.nul ]] \
    || fail 'a source path with glob characters never reached the ledger'
git -C "$SRC" checkout 'HEAD~1' -- ':(literal)we[ir]d-name'
commit_all restore
run_clean --list || fail 'clean exited non-zero for a globbed source name'
grep -Fq 'its source exists again' "$CASE/clean.txt" \
    || fail 'an existing source was read as absent because its name globbed'
if grep -Fq 'pending: ' "$CASE/clean.txt"; then
    fail 'a live source was still listed for deletion'
fi
[[ -f $TARGET ]] || fail 'a globbed source name removed the target'
pass 'source paths are matched literally'

# "git cannot answer" is not "the source is gone", for a manual clean, which
# has nobody to ask first.
new_case

prepare_file
run_hook pre
remove_source
defer_removal
cat > "$CASE/bin/git" <<EOF
#!/usr/bin/env bash
for arg in "\$@"; do
    [[ \$arg == ls-tree ]] && exit 128
done
exec '$(command -v git)' "\$@"
EOF
chmod +x "$CASE/bin/git"
run_clean || fail 'clean exited non-zero when git could not answer'
[[ -f $TARGET ]] || fail 'an unanswerable source check authorized a deletion'
grep -Fq 'its source could not be checked' "$CASE/clean.txt" \
    || fail 'the unanswerable source check was reported as something else'
[[ -f $STATE/pending.nul ]] \
    || fail 'an entry was retired although its source could not be checked'
pass 'clean waits when git cannot answer'

# An update that never reached the pre hook - a pull run outside `chezmoi
# update`, an interrupted apply, a wiped cache - still has to report its
# removals instead of discarding them with the snapshot it never got.
new_case

prepare_file
TARGET_SECOND="$DEST/second-file"
SOURCE_SECOND="$SRC/second-file"
printf '%s' second > "$SOURCE_SECOND"
cp "$SOURCE_SECOND" "$TARGET_SECOND"
printf '%s\t%s\n' "$TARGET_SECOND" "$SOURCE_SECOND" >> "$MAP"
set_managed "$TARGET" "$TARGET_SECOND"
commit_all second
run_hook pre
rm -f "$SOURCE_FILE"
commit_all remove-first
set_managed "$TARGET_SECOND"
run_post
[[ ! -e $TARGET ]] || fail 'the first deletion did not happen'
[[ -d $STATE/last ]] \
    || fail 'a consumed update left no baseline for the next one'
# Now the missed pre hook: HEAD moves with no transaction and no lock at all.
rm -rf "$STATE/current" "$STATE/lock"
rm -f "$SOURCE_SECOND"
commit_all remove-second
clear_managed
run_post
[[ ! -e $TARGET_SECOND ]] || fail 'a snapshot-less update discarded its own removals'
grep -Fq 'using the retained baseline.' "$CASE/session.txt" \
    || fail 'the baseline fallback did not say so'
pass 'a missed pre hook falls back to the retained baseline'

# Consumed evidence is not a reason to ask twice: the second target is gone and
# the baseline still predates it, so a later post must stay quiet - and must
# leave the baseline in place for the update after that.
new_case

prepare_file
run_hook pre
remove_source
run_post
[[ ! -e $TARGET ]] || fail 'the first deletion did not happen'
rm -rf "$STATE/current" "$STATE/lock"
run_post
grep -Fq 'using the retained baseline.' "$CASE/session.txt" \
    || fail 'the baseline fallback did not run'
! grep -Fq "deleted $TARGET." "$CASE/session.txt" \
    || fail 'already removed targets were offered for deletion again'
BASELINE_HEAD=$(tr '\0' '\n' < "$STATE/last/meta.nul" | sed -n 2p)
run_post
grep -Fq 'using the retained baseline.' "$CASE/session.txt" \
    || fail 'a baseline-derived post consumed the baseline'
[[ -d $STATE/last ]] \
    || fail 'a baseline-derived post dropped the baseline'
[[ $(tr '\0' '\n' < "$STATE/last/meta.nul" | sed -n 2p) == "$BASELINE_HEAD" ]] \
    || fail 'a baseline-derived post rewrote the baseline HEAD'
pass 'vanished targets are not offered again'

# Baseline state this run cannot read is dropped, not vetoed: a hook that kept
# refusing to settle anything because of one broken file would leave every later
# update unable to carry out its own removals either.
new_case
prepare_file
run_hook pre
remove_source
run_post
rm -rf "$STATE/current" "$STATE/lock"
rm -f "$STATE/last/snapshot.nul"
run_post
grep -Fq 'retained baseline is unreadable; dropping it.' "$CASE/session.txt" \
    || fail 'an unreadable baseline went unnoticed'
[[ ! -e $STATE/last ]] \
    || fail 'baseline state this run could not read was kept'
[[ ! -e $STATE/quarantine ]] \
    || fail 'unreadable state was filed away instead of dropped'
# And the next update settles back to normal on its own.
run_hook pre
run_post
[[ -r $STATE/last/snapshot.nul ]] \
    || fail 'a later update did not leave a usable baseline behind'
[[ $(tr '\0' '\n' < "$STATE/last/meta.nul" | sed -n 2p) \
    == $(git -C "$SRC" rev-parse HEAD) ]] \
    || fail 'the new baseline did not describe the present'
pass 'an unreadable baseline is retired instead of stalling the hook'

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
run_post
[[ ! -L $TARGET && -f $REFERENT ]] || fail 'symlink handling followed or retained the link'
pass 'symlink is safely unlinked'

# A git rename means the old destination is orphaned; the new source is untouched.
new_case
prepare_file
run_hook pre
git -C "$SRC" mv managed-file renamed-file
git -C "$SRC" commit -qm rename
clear_managed
run_post
[[ ! -e $TARGET ]] || fail 'accepted renamed source target remained'
pass 'a renamed source removes the destination it used to render'

# A directory in place of an old file is never removed. A symlinked parent is
# also unsafe, so both classes remain report-only.
new_case
prepare_file
run_hook pre
rm "$TARGET"
mkdir "$TARGET"
remove_source
run_post
[[ -d $TARGET ]] || fail 'directory target was removed'
grep -Fq "leaving $TARGET (changed, unsafe, or managed again)." "$CASE/session.txt" \
    || fail 'directory report-only diagnostic changed'
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
run_post
[[ -f $CASE/outside/managed-file ]] || fail 'unsafe symlink-parent target was removed'
pass 'unsafe path is report-only'

# A group/world-writable destination component is never a safe unlink.
new_case
prepare_file
run_hook pre
remove_source
chmod 777 "$DEST"
run_post
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
run_post
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
run_post
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
run_post "$CASE/mutate-parent"
[[ -f $TARGET ]] || fail 'changed directory identity allowed deletion'
pass 'changed directory identity is report-only'

# Transaction state is disabled when the cache trust anchor is shared.
new_case
prepare_file
chmod 777 "$CACHE"
run_hook pre
remove_source
run_post
[[ -f $TARGET ]] || fail 'unsafe cache anchor allowed deletion'
pass 'unsafe cache anchor disables deletion'

# A permissive directory on the way to the state cannot be trusted with it either:
# that path is what the deletion evidence is written under.
new_case
prepare_file
mkdir -p "$CACHE/check-removed-files"
chmod 777 "$CACHE/check-removed-files"
run_hook pre
remove_source
run_post
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
run_post
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
# A directory full of generated assets, the shape a model-asset directory has.
mkdir -p "$E2E/seed/dot_config/assets"
for e2e_seed in one two three four five six seven; do
    printf 'model %s\n' "$e2e_seed" > "$E2E/seed/dot_config/assets/model-$e2e_seed"
done
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
# A second host, same repository, same headless update, where one commit drops a
# whole directory of generated assets.
mkdir -p "$E2E/bulkhome/.local/share" "$E2E/bulkhome/.config/chezmoi"
git clone -q "$E2E/remote.git" "$E2E/bulkhome/.local/share/chezmoi"
cp "$E2E/home/.config/chezmoi/chezmoi.toml" "$E2E/bulkhome/.config/chezmoi/chezmoi.toml"
E2E_ENV_BULK=(env HOME="$E2E/bulkhome" XDG_CONFIG_HOME="$E2E/bulkhome/.config" XDG_CACHE_HOME="$E2E/bulkhome/.cache")
"${E2E_ENV_BULK[@]}" chezmoi apply --no-tty
[[ -d $E2E/bulkhome/.config/assets ]] || fail 'the fixture applied no asset directory'
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
[[ ! -e $E2E/home/.cache/chezmoi/check-removed-files/current ]] \
    || fail 'real update hook left transaction state'
pass 'real update hook launcher avoids persistent-state deadlock'

# That update ran headlessly, under a HOME whose ~/.cache did not exist before
# chezmoi was invoked: the file the repository stopped tracking is gone, and no
# decision was left waiting for somebody to notice it.
[[ ! -e $E2E/home/managed-file ]] \
    || fail 'the real headless update left the orphan its repository stopped tracking'
[[ ! -e $E2E/home/.cache/chezmoi/check-removed-files/pending.nul ]] \
    || fail 'a decision the update carried out stayed on the ledger'
pass 'a real headless update removes what its repository stopped tracking'

# The other host pulls two commits at once, one of which deletes a directory full
# of generated files. One update, no terminal: all seven destinations go, the
# directory they filled goes with them, and `clean` - run from a plain shell with
# no hook environment to inherit - has nothing left to report.
rm -r "$E2E/upstream/dot_config"
git -C "$E2E/upstream" add -A
git -C "$E2E/upstream" commit -qm 'remove the generated asset directory'
git -C "$E2E/upstream" push -q
E2E_BULK_OUTPUT=$("${E2E_ENV_BULK[@]}" chezmoi update --no-tty 2>&1) || {
    printf '%s\n' "$E2E_BULK_OUTPUT" >&2
    fail 'the real update that removed a directory of assets failed'
}
for e2e_name in one two three four five six seven; do
    [[ ! -e $E2E/bulkhome/.config/assets/model-$e2e_name ]] \
        || fail "the update left the asset model-$e2e_name behind"
done
[[ ! -e $E2E/bulkhome/managed-file ]] \
    || fail 'the same update ignored the deletion it pulled first'
[[ ! -d $E2E/bulkhome/.config/assets ]] \
    || fail 'the directory the repository emptied was left behind'
[[ -d $E2E/bulkhome/.config ]] || fail 'pruning removed a directory that still held files'
if ! env HOME="$E2E/bulkhome" XDG_CONFIG_HOME="$E2E/bulkhome/.config" XDG_CACHE_HOME="$E2E/bulkhome/.cache" \
    CHEZMOI_SOURCE_DIR= CHEZMOI_DEST_DIR= CHEZMOI_WORKING_TREE= CHEZMOI_CACHE_DIR= \
    "$HOOK" clean --list > "$E2E/clean.txt" 2>&1; then
    cat "$E2E/clean.txt" >&2
    fail 'the real clean --list invocation failed'
fi
grep -Fq 'no orphaned targets are pending' "$E2E/clean.txt" \
    || fail 'a bulk cleanup the update carried out was left on the ledger'
pass 'one headless update applies a bulk deletion and prunes the directory it emptied'

if ((failures > 0)); then
    printf '%d check-removed-files case(s) failed.\n' "$failures" >&2
    exit 1
fi
printf 'All check-removed-files tests passed.\n'
