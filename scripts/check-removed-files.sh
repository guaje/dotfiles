#!/usr/bin/env bash
# Offer to remove orphaned targets after their mapped source files disappear
# from git. The pre-hook snapshots chezmoi's mapping in bulk; target inspection
# is deferred until post identifies a deletion or rename candidate. This
# deliberately uses bash: every parsed path list is NUL-delimited.

set -euo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
    printf '%s\n' 'check-removed-files: Bash 4 or newer is required.' >&2
    exit 1
fi

STATE_VERSION=2
# Keep the directory stable across schema upgrades so a post-hook running the
# new script can quarantine state written by the pre-update script.
STATE_DIRECTORY_VERSION=1
MODE=${1:-}

log() {
    if [[ ${TTY_AVAILABLE:-false} == true ]]; then
        printf '%s\n' "$*" >&4
    else
        printf '%s\n' "$*" >&2
    fi
}

open_tty() {
    TTY_AVAILABLE=false
    if [[ -r /dev/tty && -w /dev/tty ]] && (: </dev/tty >/dev/tty) 2>/dev/null; then
        exec 3</dev/tty 4>/dev/tty
        TTY_AVAILABLE=true
    fi
}

# shellcheck disable=SC2329 # Invoked through the EXIT trap.
close_tty() {
    if [[ ${TTY_AVAILABLE:-false} == true ]]; then
        exec 3<&- 4>&-
    fi
}

is_dry_run() {
    local arg
    for arg in "$@"; do
        [[ $arg == --dry-run || $arg == -n || $arg == --dry-run=* ]] && return 0
    done
    [[ ${CHEZMOI_ARGS:-} =~ (^|[[:space:]])(--dry-run|-n)([[:space:]]|$) ]]
}

hash_stdin() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 | awk '{print $1}'
    else
        return 1
    fi
}

file_mode() {
    stat -c '%a' -- "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

fingerprint() {
    local path=$1 mode link hash
    if [[ -L $path ]]; then
        # Safe targets are absolute, so no option separator is needed on BSD
        # readlink implementations that do not accept `--`.
        link=$(readlink "$path") || return 1
        hash=$(printf '%s\0' "$link" | hash_stdin) || return 1
        printf 'symlink:%s\n' "$hash"
    elif [[ -f $path ]]; then
        mode=$(file_mode "$path") || return 1
        hash=$(hash_stdin < "$path") || return 1
        printf 'file:%s:%s\n' "$mode" "$hash"
    else
        return 1
    fi
}

path_is_descendant() {
    local path=$1 base=$2
    [[ $path == "$base"/* ]]
}

directory_identity() {
    # GNU and BSD stat have incompatible formats. An unavailable stat is not
    # an excuse to delete: callers treat every failure as report-only.
    stat -c '%d:%i:%a' -- "$1" 2>/dev/null || stat -f '%d:%i:%Lp' "$1" 2>/dev/null
}

# Snapshots cover only components from CHEZMOI_DEST_DIR down. Ancestors such as
# / and /home are intentionally outside this threat model. Other principals
# must not be able to replace, symlink, or make writable any checked component;
# a malicious process running as this same UID remains out of scope.
declare -A SAFE_DIRECTORY_IDENTITIES=()
safe_target() {
    # Do not resolve the target itself: it may be the symlink we intend to
    # unlink. Resolve its parent physically, so lexical .. and symlinked
    # parents cannot escape. Record/verify identity checks close the prompt
    # race immediately before unlink.
    local target=$1 destination=$2 phase=${3:-record} parent base canonical_parent canonical_destination
    local relative component current identity mode snapshot=
    parent=$(dirname -- "$target") || return 1
    base=$(basename -- "$target") || return 1
    [[ $base != . && $base != .. ]] || return 1
    [[ -d $destination && ! -L $destination ]] || return 1
    canonical_destination=$(CDPATH='' cd -P -- "$destination" && pwd) || return 1
    canonical_parent=$(CDPATH='' cd -P -- "$parent" && pwd) || return 1
    [[ $canonical_parent == "$canonical_destination" ]] \
        || path_is_descendant "$canonical_parent" "$canonical_destination" || return 1
    [[ $target == "$canonical_parent/$base" ]] || return 1

    current=$canonical_destination
    relative=${canonical_parent#"$canonical_destination"}
    relative=${relative#/}
    while :; do
        [[ -d $current && ! -L $current ]] || return 1
        identity=$(directory_identity "$current") || return 1
        mode=${identity##*:}
        [[ $mode =~ ^[0-7]+$ ]] || return 1
        (( (8#$mode & 022) == 0 )) || return 1
        snapshot=${snapshot}${snapshot:+,}$current=$identity
        [[ -z $relative ]] && break
        component=${relative%%/*}
        [[ -n $component && $component != . && $component != .. ]] || return 1
        current=$current/$component
        if [[ $relative == */* ]]; then relative=${relative#*/}; else relative=; fi
    done
    if [[ $phase == verify ]]; then
        [[ ${SAFE_DIRECTORY_IDENTITIES[$target]+set} ]] || return 1
        [[ ${SAFE_DIRECTORY_IDENTITIES[$target]} == "$snapshot" ]] || return 1
    else
        SAFE_DIRECTORY_IDENTITIES[$target]=$snapshot
    fi
}

quarantine_current() {
    local why=$1 stamp
    [[ -e $STATE_ROOT/current ]] || return 0
    mkdir -p "$STATE_ROOT/quarantine" 2>/dev/null || return 0
    stamp=$(date +%s 2>/dev/null || printf '%s' unknown)
    mv "$STATE_ROOT/current" "$STATE_ROOT/quarantine/${stamp}.${RANDOM}.${why}" 2>/dev/null || true
}

read_metadata() {
    local meta=$1
    META=()
    [[ -f $meta ]] || return 1
    mapfile -d '' -t META < "$meta" || return 1
    [[ ${#META[@]} -eq 6 ]] || return 1
    [[ ${META[0]} == "$STATE_VERSION" ]] || return 1
    [[ -n ${META[1]} && -n ${META[2]} && -n ${META[3]} && -n ${META[4]} && -n ${META[5]} ]]
}

write_managed_mapping() {
    # The JSON form is the only bulk chezmoi API that includes target and
    # source paths together. jq both validates the complete document and emits
    # a NUL-delimited stream, so malformed or unavailable tooling fails closed.
    local output=$1 json
    command -v jq >/dev/null 2>&1 || return 1
    json=$(mktemp "$STATE_ROOT/.managed-json.XXXXXXXX") || return 1
    if ! chezmoi managed --include=files,symlinks --path-style=all --format=json > "$json" 2>/dev/null \
        || ! jq -j '
            def path_string:
                type == "string" and length > 0 and index("\u0000") == null;
            if type != "object" then error("managed output is not an object")
            elif all(to_entries[];
                (.key | path_string) and (.key | startswith("/") | not) and
                (.value | type == "object") and
                (.value.absolute | path_string) and (.value.absolute | startswith("/")) and
                (.value.sourceAbsolute | path_string) and (.value.sourceAbsolute | startswith("/")) and
                (.value.sourceRelative | path_string) and
                (.value.sourceRelative | startswith("/") | not))
            then to_entries[] |
                .key, "\u0000",
                .value.absolute, "\u0000",
                .value.sourceAbsolute, "\u0000",
                .value.sourceRelative, "\u0000"
            else error("managed entry is malformed")
            end
        ' "$json" > "$output" 2>/dev/null; then
        rm -f "$json" "$output"
        return 1
    fi
    rm -f "$json"
}

is_managed_now() {
    # 0 means managed, 1 means confidently unmanaged, and 2 means that the
    # listing failed. Callers must never treat the last case as permission to
    # delete. This race-closing query is only made for confirmed candidates.
    local wanted=$1 _ignored target result=1 listing
    listing=$(mktemp "$STATE_ROOT/.managed-check.XXXXXXXX") || return 2
    if ! write_managed_mapping "$listing"; then
        rm -f "$listing"
        return 2
    fi
    while IFS= read -r -d '' _ignored \
        && IFS= read -r -d '' target \
        && IFS= read -r -d '' _ignored \
        && IFS= read -r -d '' _ignored; do
        if [[ $target == "$wanted" ]]; then
            result=0
            break
        fi
    done < "$listing"
    rm -f "$listing"
    return "$result"
}

is_confidently_unmanaged() {
    is_managed_now "$1"
    [[ $? -eq 1 ]]
}

prompt_delete() {
    local target=$1 answer=${CHECK_REMOVED_FILES_CHOICE:-}
    if [[ -z $answer ]]; then
        printf 'Delete unmanaged target %q? [y]es/[N]o/[s]kip all/[q]uit: ' "$target" >&4
        IFS= read -r answer <&3 || answer=q
    fi
    case $answer in
        y|Y|yes|YES) return 0 ;;
        s|S|skip-all|SKIP-ALL) return 4 ;;
        q|Q|quit|QUIT) return 2 ;;
        *) return 1 ;;
    esac
}

pre() {
    local managed_file target_relative target source source_relative git_relative provenance
    local token owner_pid old_token
    # The transaction root was created and checked during initialization. The
    # lock intentionally spans pre through post. Reclaim it only when its
    # recorded owner no longer exists; this prevents a failed update from
    # disabling all future snapshots while preserving concurrent-update safety.
    if ! mkdir -m 700 "$LOCK_DIR" 2>/dev/null; then
        old_token=$(cat "$LOCK_DIR/token" 2>/dev/null || true)
        owner_pid=${old_token%%.*}
        if [[ $owner_pid =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
            log 'check-removed-files: another update snapshot is active; skipping.'
            return 0
        fi
        [[ -e $STATE_ROOT/current ]] && quarantine_current interrupted
        rm -rf "$LOCK_DIR"
        if ! mkdir -m 700 "$LOCK_DIR" 2>/dev/null; then
            log 'check-removed-files: unable to reclaim interrupted update snapshot; skipping.'
            return 0
        fi
    fi
    if [[ -e $STATE_ROOT/current ]]; then
        quarantine_current superseded
    fi
    TX=$(mktemp -d "$STATE_ROOT/.transaction.XXXXXXXX") || {
        rmdir "$LOCK_DIR" 2>/dev/null || true
        return 0
    }
    # PPID is the parent chezmoi process because the hook launcher execs this
    # script. It remains alive across pre/post and disappears after a failed
    # update, unlike this short-lived pre-hook process.
    token="$PPID.${RANDOM}.${RANDOM}"
    printf '%s\n' "$token" > "$LOCK_DIR/token"
    OLD_HEAD=$(git -C "$WORK_TREE" rev-parse --verify HEAD 2>/dev/null) || {
        rm -rf "$TX" "$LOCK_DIR"; return 0;
    }
    printf '%s\0%s\0%s\0%s\0%s\0%s\0' \
        "$STATE_VERSION" "$token" "$OLD_HEAD" "$SOURCE_DIR" "$DEST_DIR" "$WORK_TREE" > "$TX/meta.nul"
    : > "$TX/snapshot.nul"
    managed_file="$TX/managed.nul"
    if ! write_managed_mapping "$managed_file"; then
        log 'check-removed-files: bulk managed mapping unavailable or malformed; skipping snapshot.'
        rm -rf "$TX" "$LOCK_DIR"; return 0
    fi
    # Snapshot only chezmoi's bulk path mapping. In particular, do not inspect,
    # render, or hash each target here: most updates remove no source files.
    # The final fields record whether both source path representations agree
    # with the trusted source/work tree and the corresponding git-relative
    # path. Target type remains deliberately unknown until post finds a source
    # deletion or rename candidate.
    while IFS= read -r -d '' target_relative \
        && IFS= read -r -d '' target \
        && IFS= read -r -d '' source \
        && IFS= read -r -d '' source_relative; do
        git_relative=
        provenance=ambiguous
        if [[ $target == /* && -n $target_relative && $target_relative != /* \
            && $source == "$SOURCE_DIR/$source_relative" \
            && $source == "$WORK_TREE"/* \
            && -n $source_relative && $source_relative != /* ]]; then
            git_relative=${source#"$WORK_TREE"/}
            [[ -n $git_relative ]] && provenance=worktree
        fi
        printf '%s\0%s\0%s\0%s\0%s\0%s\0%s\0' \
            "$target" "$target_relative" "$source" "$source_relative" \
            "$git_relative" file-or-symlink "$provenance"
    done < "$managed_file" >> "$TX/snapshot.nul"
    rm -f "$managed_file"
    printf '%s\n' complete > "$TX/complete"
    if ! mv "$TX" "$STATE_ROOT/current"; then
        rm -rf "$TX" "$LOCK_DIR"
    fi
}

post() {
    local token old_head source_dir dest_dir work_tree current_head diff_file status old_path new_path
    local target _ignored git_relative managed_type provenance
    local type fingerprint change decision malformed_diff=false
    local skip_all=false
    local -A changes=() managed_now=()

    if [[ ! -d $LOCK_DIR || ! -f $LOCK_DIR/token ]]; then
        [[ -e $STATE_ROOT/current ]] && quarantine_current unlocked
        return 0
    fi
    # current is only published after complete is written. Anything else is
    # corrupt rather than a snapshot a later update may inherit.
    if [[ ! -f $STATE_ROOT/current/complete ]]; then
        [[ -e $STATE_ROOT/current ]] && quarantine_current incomplete
        rm -rf "$LOCK_DIR"
        return 0
    fi
    token=$(<"$LOCK_DIR/token")
    if ! read_metadata "$STATE_ROOT/current/meta.nul"; then
        quarantine_current incompatible; rm -rf "$LOCK_DIR"; return 0
    fi
    if [[ ${META[1]} != "$token" ]]; then
        quarantine_current token-mismatch; rm -rf "$LOCK_DIR"; return 0
    fi
    old_head=${META[2]}; source_dir=${META[3]}; dest_dir=${META[4]}; work_tree=${META[5]}
    if [[ $source_dir != "$SOURCE_DIR" || $dest_dir != "$DEST_DIR" || $work_tree != "$WORK_TREE" ]]; then
        quarantine_current environment-mismatch; rm -rf "$LOCK_DIR"; return 0
    fi
    current_head=$(git -C "$WORK_TREE" rev-parse --verify HEAD 2>/dev/null) || {
        quarantine_current git-error; rm -rf "$LOCK_DIR"; return 0;
    }
    if [[ $current_head == "$old_head" ]]; then
        # No source update happened. This is still an ordinary, consumed post.
        rm -rf "$STATE_ROOT/current" "$LOCK_DIR"
        return 0
    fi

    diff_file=$(mktemp "$STATE_ROOT/.diff.XXXXXXXX") || {
        quarantine_current diff-error; rm -rf "$LOCK_DIR"; return 0;
    }
    if ! git -C "$WORK_TREE" diff --name-status -z -M "$old_head" "$current_head" > "$diff_file"; then
        rm -f "$diff_file"; quarantine_current diff-error; rm -rf "$LOCK_DIR"; return 0
    fi
    while IFS= read -r -d '' status; do
        case $status in
            D*)
                if ! IFS= read -r -d '' old_path; then
                    malformed_diff=true
                    break
                fi
                changes["$old_path"]=deleted
                ;;
            R*)
                if ! IFS= read -r -d '' old_path || ! IFS= read -r -d '' new_path || [[ -z $new_path ]]; then
                    malformed_diff=true
                    break
                fi
                changes["$old_path"]=renamed
                ;;
            *)
                if ! IFS= read -r -d '' old_path; then
                    malformed_diff=true
                    break
                fi
                ;;
        esac
    done < "$diff_file"
    if [[ $malformed_diff == true ]]; then
        rm -f "$diff_file"
        quarantine_current malformed-diff
        rm -rf "$LOCK_DIR"
        return 0
    fi
    rm -f "$diff_file"

    # Diff and current mapping are both collected before any target is
    # inspected. A fresh mapping is queried again immediately before unlinking
    # each accepted candidate to close the hook/apply race.
    local current_file
    current_file=$(mktemp "$STATE_ROOT/.managed.XXXXXXXX") || {
        quarantine_current managed-error; rm -rf "$LOCK_DIR"; return 0;
    }
    if ! write_managed_mapping "$current_file"; then
        log 'check-removed-files: current managed mapping unavailable or malformed; leaving targets.'
        rm -f "$current_file"; quarantine_current managed-error; rm -rf "$LOCK_DIR"; return 0
    fi
    while IFS= read -r -d '' _ignored \
        && IFS= read -r -d '' target \
        && IFS= read -r -d '' _ignored \
        && IFS= read -r -d '' _ignored; do
        managed_now["$target"]=1
    done < "$current_file"
    rm -f "$current_file"

    while IFS= read -r -d '' target \
        && IFS= read -r -d '' _ignored \
        && IFS= read -r -d '' _ignored \
        && IFS= read -r -d '' _ignored \
        && IFS= read -r -d '' git_relative \
        && IFS= read -r -d '' managed_type \
        && IFS= read -r -d '' provenance; do
        [[ $provenance == worktree && $managed_type == file-or-symlink ]] || {
            log "check-removed-files: leaving ambiguous target $target (external or unmapped source)."
            continue
        }
        change=${changes[$git_relative]:-}
        [[ -n $change ]] || continue
        [[ -n ${managed_now[$target]+yes} ]] && continue
        if is_dry_run "$@"; then
            log "check-removed-files: dry run; would consider deleting $target."
            continue
        fi
        if [[ $TTY_AVAILABLE != true ]]; then
            log "check-removed-files: no interactive terminal; leaving $target."
            continue
        fi
        if [[ $skip_all == true ]]; then
            log "check-removed-files: leaving $target."
            continue
        fi

        # Pre deliberately did not touch targets. Type, fingerprint, path, and
        # current-management checks are paid only for actual source-removal
        # candidates. A regular file and a symlink are the only unlinkable
        # types; test the link first so its referent is never classified.
        if ! safe_target "$target" "$DEST_DIR"; then
            log "check-removed-files: leaving $target (changed, unsafe, or managed again)."
            continue
        fi
        if [[ -L $target ]]; then
            type='symlink'
        elif [[ -f $target ]]; then
            type='file'
        else
            log "check-removed-files: leaving $target (changed, unsafe, or managed again)."
            continue
        fi
        fingerprint=$(fingerprint "$target" 2>/dev/null || true)
        if [[ -z $fingerprint ]]; then
            log "check-removed-files: leaving $target (changed, unsafe, or managed again)."
            continue
        fi
        log "check-removed-files: old source was $change; target is unmanaged: $target"
        decision=1
        if prompt_delete "$target"; then
            decision=0
        else
            decision=$?
        fi
        case $decision in
            4)
                skip_all=true
                log "check-removed-files: leaving $target and remaining targets."
                continue
                ;;
            2)
                log 'check-removed-files: user quit; leaving remaining targets.'
                break
                ;;
            1)
                log "check-removed-files: leaving $target."
                continue
                ;;
        esac
        # A test-only executable seam makes the identity-change check
        # deterministic without widening production behavior.
        if [[ -n ${CHECK_REMOVED_FILES_TEST_BEFORE_VERIFY:-} ]]; then
            "$CHECK_REMOVED_FILES_TEST_BEFORE_VERIFY" "$target" "$DEST_DIR" || true
        fi
        # Recheck immediately before unlinking. rm -f unlinks symlinks and
        # regular files only after the type check above; it never recurses.
        if safe_target "$target" "$DEST_DIR" verify \
            && is_confidently_unmanaged "$target" \
            && { [[ $type == file && -f $target && ! -L $target ]] || [[ $type == symlink && -L $target ]]; } \
            && [[ $(fingerprint "$target" 2>/dev/null || true) == "$fingerprint" ]]; then
            # The fingerprint comparison is intentionally the final operation
            # before the non-recursive unlink.
            rm -f -- "$target" && log "check-removed-files: deleted $target."
        else
            log "check-removed-files: leaving $target (changed, unsafe, or managed again)."
        fi
    done < "$STATE_ROOT/current/snapshot.nul"

    rm -rf "$STATE_ROOT/current" "$LOCK_DIR"
    return 0
}

case $MODE in
    pre|post) ;;
    *) exit 0 ;;
esac

SOURCE_DIR=${CHEZMOI_SOURCE_DIR:-}
DEST_DIR=${CHEZMOI_DEST_DIR:-}
WORK_TREE=${CHEZMOI_WORKING_TREE:-}
CACHE_DIR=${CHEZMOI_CACHE_DIR:-}
[[ -n $SOURCE_DIR && -n $DEST_DIR && -n $WORK_TREE && -n $CACHE_DIR ]] || exit 0

# CHEZMOI_CACHE_DIR is the transaction-state trust anchor. If another
# principal can replace its contents, source/deletion evidence is not trusted.
[[ -d $CACHE_DIR && ! -L $CACHE_DIR ]] || exit 0
CACHE_IDENTITY=$(directory_identity "$CACHE_DIR" 2>/dev/null) || exit 0
CACHE_MODE=${CACHE_IDENTITY##*:}
[[ $CACHE_MODE =~ ^[0-7]+$ ]] || exit 0
(( (8#$CACHE_MODE & 022) == 0 )) || exit 0

# Do not infer a repository from arbitrary directories: update hooks should be
# inert for non-git chezmoi sources.
WORK_TREE=$(git -C "$WORK_TREE" rev-parse --show-toplevel 2>/dev/null) || exit 0
STATE_ROOT="$CACHE_DIR/check-removed-files-v$STATE_DIRECTORY_VERSION"
LOCK_DIR="$STATE_ROOT/lock"
# A safe cache parent alone is insufficient if a permissive umask created a
# shared transaction directory beneath it. Do not consume state unless this
# deterministic child is private too.
if [[ ! -e $STATE_ROOT ]]; then
    mkdir -m 700 "$STATE_ROOT" 2>/dev/null || exit 0
fi
[[ -d $STATE_ROOT && ! -L $STATE_ROOT ]] || exit 0
STATE_ROOT_IDENTITY=$(directory_identity "$STATE_ROOT" 2>/dev/null) || exit 0
STATE_ROOT_MODE=${STATE_ROOT_IDENTITY##*:}
[[ $STATE_ROOT_MODE =~ ^[0-7]+$ ]] || exit 0
(( (8#$STATE_ROOT_MODE & 022) == 0 )) || exit 0
open_tty
trap close_tty EXIT

case $MODE in
    pre) pre ;;
    post) post "$@" ;;
esac

exit 0
