#!/usr/bin/env bash
# Carry the repository's deletions through to the destination. The pre-hook
# snapshots chezmoi's mapping in bulk; target inspection is deferred until post
# identifies a deletion or rename candidate. This deliberately uses bash: every
# parsed path list is NUL-delimited.
#
# Modes:
#   pre    chezmoi update pre-hook: snapshot the managed mapping. A preview gets
#          this hook but never a post hook, so it snapshots nothing.
#   post   chezmoi update post-hook: diff that snapshot against HEAD, remove the
#          destinations whose sources are gone, prune the directories that left
#          empty, then settle whatever is still on the ledger. Finishing an update
#          is this one command, never a command plus a cleanup step. Under
#          --dry-run nothing is unlinked and every verified candidate goes to the
#          pending ledger instead.
#   clean  Retry that ledger by hand, with --list to report first. Ordinarily
#          optional: the post hook does the same thing as part of the update.
#
# The repository is the source of truth and there is no second gate: stopping
# tracking a file is the decision, and the update executes it, one verified file at
# a time however many the commit removed. What never gets deleted is what a check
# cannot prove - a target chezmoi still manages under any entry type, a target
# outside the destination directory or behind a symlinked or group-writable parent,
# a target whose contents changed since this run recorded it, a directory that still
# holds something. A preview deletes nothing.
#
# Directories are removed only by rmdir, which cannot succeed unless the directory
# is empty including hidden files, and only along the way up from a file this run
# actually removed, only for directories chezmoi does not manage, and only inside
# the destination directory. One untracked leftover stops it, and nothing a
# directory holds is ever opened, which is why no deletion here needs an "undo".
#
# State lives at $CHEZMOI_CACHE_DIR/check-removed-files/<id of this working tree>/,
# so two chezmoi sources sharing the shared cache cannot consume each other's
# snapshots or throw away a baseline the other still owes. It is written and read by
# this script alone, and anything it cannot parse is dropped rather than acted on:
#   current/      this update's snapshot, published atomically by pre
#   last/         the snapshot the last consumed post diffed against, kept so an
#                 update that never reached pre (or lost its snapshot, or pulled
#                 nothing) still carries out its removals. Consumed once, then
#                 advanced, so an old baseline cannot report the same file twice.
#   pending.nul   targets whose removal was verified but could not be carried out,
#                 retried by the next update
#   lock/         spans pre through post

set -euo pipefail

MODE=${1:-}

# A hook must never fail the chezmoi update it is attached to, so only a manual
# invocation has an audience to report a setup failure to.
usage_error() {
    if [[ $MODE == clean ]]; then
        exit 1
    fi
    exit 0
}

# State parsing reads NUL-delimited records with `mapfile -d`, which arrived in 4.4.
# An older bash would fail every read, and unreadable state is dropped rather than
# acted on, so a too-old bash must refuse loudly instead of quietly eating the ledger.
if (( BASH_VERSINFO[0] < 4 || ( BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4 ) )); then
    printf 'check-removed-files: Bash 4.4 or newer is required.\n' >&2
    usage_error
fi

# The repository is the source of truth: stopping tracking a file is the decision,
# and the update carries it out. Nothing is deleted on an unproven check - a target
# is only unlinked when it is a regular file or symlink inside the destination
# directory, nothing in chezmoi manages it any more, its source is provably absent
# from HEAD, and its contents have not changed since this run recorded them. How
# many targets an update removed is never itself a reason to doubt the repository.

log() {
    printf '%s\n' "$*" >&2
}

is_dry_run() {
    local arg
    for arg in "$@"; do
        # --dry-run=false asks for the opposite of a preview; the ledger must not
        # be filled on the strength of a misread flag.
        case $arg in
            --dry-run | -n | --dry-run=true | --dry-run=1) return 0 ;;
        esac
    done
    # A preview reaches a hook two ways: forwarded argv, and CHEZMOI_ARGS, which is
    # what chezmoi actually sets for a hook that gets no argv of its own. Both have
    # to recognise the same flags, or a preview would be run as a real deletion.
    [[ ${CHEZMOI_ARGS:-} =~ (^|[[:space:]])(--dry-run(=(true|1))?|-n)([[:space:]]|$) ]]
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
    # parents cannot escape. Record/verify identity checks close the race
    # immediately before the unlink.
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

discard_state() { # <path> ...
    # State this script cannot use is dropped, not filed away: an update must never
    # act on evidence it did not verify, and a directory of leftovers from every
    # malformed run would be read by nobody. Nothing here records what was deleted -
    # git does that - so state that cannot be read has no further use.
    local path
    for path in "$@"; do
        [[ -e $path ]] && rm -rf -- "$path" 2>/dev/null || true
    done
    return 0
}

# Scratch files are named by mktemp and reclaimed by the run that wrote them. A
# killed run leaves them behind and nothing else would ever look, so reap the
# names that are unmistakably ours and old enough that no live run can hold one.
SCRATCH_MAX_AGE_MINUTES=1440
reap_scratch() {
    find "$STATE_ROOT" -maxdepth 1 -type f -mmin +"$SCRATCH_MAX_AGE_MINUTES" \
        \( -name '.pending.*' -o -name '.diff.*' -o -name '.managed.*' -o -name '.managed-check.*' \
            -o -name '.managed-json.*' -o -name '.managed-prune.*' \) \
        -delete 2>/dev/null || true
    find "$STATE_ROOT" -maxdepth 1 -type d -mmin +"$SCRATCH_MAX_AGE_MINUTES" \
        \( -name '.transaction.*' -o -name '.last.*' \) \
        -exec rm -rf -- {} + 2>/dev/null || true
}
transaction_owner_alive() { # -> 0 when some live chezmoi holds the lock
    local owner
    [[ -d $LOCK_DIR ]] || return 1
    owner=$(cat "$LOCK_DIR/token" 2>/dev/null || true)
    [[ ${owner%%.*} =~ ^[0-9]+$ ]] && kill -0 "${owner%%.*}" 2>/dev/null
}

discard_transaction() { # <own-token, empty when this run owns nothing>
    # Re-check immediately before destroying state. A pre hook that started
    # after this run began owns its lock and snapshot, even on the unlocked
    # baseline path, and this run may only discard a lock it still holds.
    local own_token=${1:-}
    if [[ -d $LOCK_DIR ]] \
        && { [[ -z $own_token ]] || [[ $own_token != $(cat "$LOCK_DIR/token" 2>/dev/null || true) ]]; } \
        && transaction_owner_alive; then
        return 0
    fi
    rm -rf -- "$STATE_ROOT/current" "$LOCK_DIR"
}

release_stale_lock() {
    # A lock is only this run's to break when its owner is gone. Another update -
    # quite possibly a different chezmoi source sharing this cache directory - may
    # hold it legitimately, and stealing it would let a third run walk over an
    # update that is still in progress.
    transaction_owner_alive || rm -rf -- "$LOCK_DIR"
}

publish_baseline() { # <own-token of the transaction this run holds, if any>
    # The caller validated `current`. Retaining it as `last` is what makes a
    # removal survivable: an update that reaches post without a usable pre
    # snapshot (interrupted run, wiped cache, a pull driven outside
    # `chezmoi update`) is still diffed against the mapping HEAD was based on.
    local own_token=${1:-}
    [[ -d $STATE_ROOT/current && -f $STATE_ROOT/current/complete ]] || return 0
    # Promote only a transaction this run still holds. On the unlocked baseline
    # path a new pre hook may have started since the liveness check, and stealing
    # a live update's snapshot would leave its post with nothing of its own.
    if [[ -z $own_token || ! -f $LOCK_DIR/token \
        || $own_token != $(cat "$LOCK_DIR/token" 2>/dev/null || true) ]]; then
        return 0
    fi
    # Park the newcomer before the old evidence goes away: if the rename fails,
    # this run must not have destroyed the baseline *and* discarded the only
    # transaction that could replace it. A parked directory is reaped as scratch.
    local parked=$STATE_ROOT/.last.$BASHPID
    rm -rf -- "$parked" 2>/dev/null
    mv -- "$STATE_ROOT/current" "$parked" || return 0
    # What this run supersedes is dropped: it describes removals that have already
    # been reported, and keeping two baselines would report them twice.
    discard_state "$STATE_ROOT/last"
    mv -- "$parked" "$STATE_ROOT/last" 2>/dev/null \
        || log 'check-removed-files: unable to retain the baseline for later updates.'
}

# Removals that were verified against a real source deletion but could not be
# carried out at the time - the target failed a check, the management listing was
# unavailable, a preview saw them and deleted nothing. The next update retries them.
# A row holds the target, the source path that used to back it, the unlinkable type,
# the contents it was verified against, and the HEAD it was confirmed under.
PENDING_FIELDS=5
PENDING_FILE=
declare -a PENDING=()
PENDING_DIRTY=false

read_pending() {
    # A ledger this script cannot parse is never acted on. It is dropped, so the
    # next run works from a list this script wrote itself.
    local index
    PENDING=()
    [[ -f $PENDING_FILE ]] || return 0
    mapfile -d '' -t PENDING < "$PENDING_FILE" || { PENDING=(); return 1; }
    (( ${#PENDING[@]} % PENDING_FIELDS == 0 )) || { PENDING=(); return 1; }
    for (( index = 0; index < ${#PENDING[@]}; index += PENDING_FIELDS )); do
        [[ -n ${PENDING[index]} && -n ${PENDING[index + 1]} &&
            -n ${PENDING[index + 2]} && -n ${PENDING[index + 3]} \
            && -n ${PENDING[index + 4]} ]] || { PENDING=(); return 1; }
    done
}

write_pending() {
    # Empty means nothing is pending: remove the file rather than leave a
    # zero-byte ledger that looks like unread state.
    local file index
    if (( ${#PENDING[@]} == 0 )); then
        rm -f -- "$PENDING_FILE"
        return 0
    fi
    file=$(mktemp "$STATE_ROOT/.pending.XXXXXXXX") || return 1
    for (( index = 0; index < ${#PENDING[@]}; index += PENDING_FIELDS )); do
        if ! printf '%s\0' "${PENDING[@]:index:PENDING_FIELDS}" >> "$file"; then
            rm -f -- "$file"
            return 1
        fi
    done
    if ! mv -f -- "$file" "$PENDING_FILE"; then
        rm -f -- "$file"
        return 1
    fi
}

pending_find() { # <target> -> prints the record offset, or fails
    local wanted=$1 index
    for (( index = 0; index < ${#PENDING[@]}; index += PENDING_FIELDS )); do
        if [[ ${PENDING[index]} == "$wanted" ]]; then
            printf '%s' "$index"
            return 0
        fi
    done
    return 1
}

pending_add() { # <target> <git-relative> <type> <fingerprint> <head>
    # 0 when a row was added, 1 when an existing row was refreshed; one orphan is
    # one row either way, which is what keeps the summary honest.
    local index
    if index=$(pending_find "$1"); then
        if [[ ${PENDING[index + 1]} != "$2" || ${PENDING[index + 2]} != "$3" \
            || ${PENDING[index + 3]} != "$4" || ${PENDING[index + 4]} != "$5" ]]; then
            PENDING_DIRTY=true
        fi
        PENDING[index + 1]=$2
        PENDING[index + 2]=$3
        PENDING[index + 3]=$4
        PENDING[index + 4]=$5
        return 1
    fi
    PENDING+=("$1" "$2" "$3" "$4" "$5")
    PENDING_DIRTY=true
    return 0
}

pending_drop() { # <target>
    local wanted=$1 index
    local -a kept=()
    pending_find "$wanted" >/dev/null || return 0
    for (( index = 0; index < ${#PENDING[@]}; index += PENDING_FIELDS )); do
        if [[ ${PENDING[index]} == "$wanted" ]]; then
            continue
        fi
        kept+=("${PENDING[@]:index:PENDING_FIELDS}")
    done
    PENDING=(${kept[@]+"${kept[@]}"})
    PENDING_DIRTY=true
}

read_metadata() {
    local meta=$1
    META=()
    [[ -f $meta ]] || return 1
    mapfile -d '' -t META < "$meta" || return 1
    [[ ${#META[@]} -eq 2 ]] || return 1
    [[ -n ${META[0]} && -n ${META[1]} ]]
}

write_managed_mapping() { # <output> [entry-types]
    # The JSON form is the only bulk chezmoi API that includes target and
    # source paths together. jq both validates the complete document and emits
    # a NUL-delimited stream, so malformed or unavailable tooling fails closed.
    #
    # The caller decides how wide the net is. A snapshot only needs files and
    # symlinks, because nothing else can ever be a deletion candidate. A question
    # about whether a target is *still* chezmoi's has to cover every kind of entry
    # chezmoi renders - a directory, a script, a config target, an external
    # resource - because a re-adopted destination is a reason not to delete it
    # whatever shape the new owner takes.
    local output=$1 include=${2:-files,symlinks} json
    command -v jq >/dev/null 2>&1 || return 1
    json=$(mktemp "$STATE_ROOT/.managed-json.XXXXXXXX") || return 1
    if ! chezmoi managed --include="$include" --path-style=all --format=json > "$json" 2>/dev/null \
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
    # delete. This race-closing query is only made for confirmed candidates, and
    # it asks about every entry type: a destination that chezmoi now renders as a
    # directory, a script, or an external resource is still chezmoi's.
    local wanted=$1 _ignored target result=1 listing
    listing=$(mktemp "$STATE_ROOT/.managed-check.XXXXXXXX") || return 2
    if ! write_managed_mapping "$listing" all; then
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

prune_emptied_dirs() { # <removed-path> ...
    # When every file a directory was made for is gone, the directory goes with
    # them. This is the only place a directory is ever removed, and it cannot lose
    # anything: rmdir succeeds only on a directory that is genuinely empty, hidden
    # files included, so one untracked leftover stops it. A directory chezmoi still
    # manages is left alone, as is anything along a .git path, and the walk upwards
    # stops at the destination directory itself.
    #
    # Every candidate is collected before any is removed, then tried in passes that
    # stop when a pass removes nothing. A parent is therefore judged only after its
    # children had their turn, which is what makes a nested removal work: the usual
    # layout is a directory holding both loose files and a subdirectory of generated
    # ones, so a single walk-up per file reaches that parent while the subdirectory
    # is still in it, and the parent would survive an update that emptied all of it.
    #
    # Management is answered from one bulk listing taken after the deletions rather
    # than by a `chezmoi managed` per candidate: a bulk cleanup of a hundred generated
    # directories would otherwise cost a hundred chezmoi runs.
    local path dir contents removed listing target
    local -a candidates=()
    local -A collected=() rejected=() managed_set=()
    [[ -n $DEST_DIR && $DEST_DIR != / ]] || return 0
    for path in "$@"; do
        dir=$(dirname -- "$path")
        while [[ $dir == "$DEST_DIR"/* && $dir != "$DEST_DIR" ]]; do
            case $dir in
                */.git | */.git/*) break ;;
            esac
            # A parent that is not a real directory ends the chain: nothing above a
            # symlink is inside the destination directory in any sense that matters.
            [[ -d $dir && ! -L $dir ]] || break
            [[ -z ${collected[$dir]+x} ]] || break
            collected[$dir]=1
            candidates+=("$dir")
            dir=$(dirname -- "$dir")
        done
    done
    (( ${#candidates[@]} > 0 )) || return 0

    listing=$(mktemp "$STATE_ROOT/.managed-prune.XXXXXXXX") || return 0
    if ! write_managed_mapping "$listing" all; then
        # Without the list there is no way to know which of these directories chezmoi
        # still owns, so none of them is touched.
        rm -f "$listing"
        return 0
    fi
    while IFS= read -r -d '' _ignored \
        && IFS= read -r -d '' target \
        && IFS= read -r -d '' _ignored \
        && IFS= read -r -d '' _ignored; do
        managed_set[$target]=1
    done < "$listing"
    rm -f "$listing"

    while true; do
        removed=false
        for dir in ${candidates[@]+"${candidates[@]}"}; do
            [[ -z ${rejected[$dir]+x} ]] || continue
            [[ -z ${managed_set[$dir]+x} ]] || continue
            if [[ ! -d $dir || -L $dir ]]; then
                rejected[$dir]=1
                continue
            fi
            # A directory that cannot be listed is not known to be empty.
            contents=$(ls -A -- "$dir" 2>/dev/null) || {
                rejected[$dir]=1
                continue
            }
            # Not empty yet: it may well empty later in this same loop, so this is the
            # one refusal that is worth asking about again on the next pass.
            [[ -z $contents ]] || continue
            # rmdir cannot remove anything but an empty directory, which is the whole
            # reason no further check is needed here.
            if ! rmdir -- "$dir" 2>/dev/null; then
                rejected[$dir]=1
                continue
            fi
            log "check-removed-files: removed empty directory $dir."
            removed=true
        done
        [[ $removed == true ]] || break
    done
    return 0
}

settle_candidates() { # <dry-run flag>
    # Everything the caller verified is executed here, one target at a time. The
    # repository decided when it dropped the source; the only open question is
    # whether each destination still passes the checks, and attempt_delete asks
    # that immediately before the unlink.
    local count=${#cand_target[@]} index removed=0 target
    local -a deleted_paths=()
    ((count > 0)) || return 0
    if [[ $1 == true ]]; then
        # A preview may verify all of the above but may not unlink, so it writes the
        # list down for the real run that follows and changes nothing.
        for ((index = 0; index < count; index++)); do
            pending_add "${cand_target[index]}" "${cand_rel[index]}" \
                "${cand_type[index]}" "${cand_fp[index]}" "$current_head" || true
            log "check-removed-files: dry run; would remove ${cand_target[index]} (left pending)."
        done
        log "check-removed-files: dry run; $count orphaned target(s) verified and left pending."
        return 0
    fi
    for ((index = 0; index < count; index++)); do
        target=${cand_target[index]}
        log "check-removed-files: ${cand_change[index]}; no longer managed by chezmoi: $target"
        if attempt_delete "$target" "${cand_type[index]}" "${cand_fp[index]}"; then
            pending_drop "$target"
            deleted_paths+=("$target")
            removed=$((removed + 1))
        else
            # Verification failed at the last moment, which is not a decision to
            # delete something else: keep the file, and keep the evidence for a retry.
            pending_add "$target" "${cand_rel[index]}" "${cand_type[index]}" \
                "${cand_fp[index]}" "$current_head" || true
        fi
    done
    prune_emptied_dirs ${deleted_paths[@]+"${deleted_paths[@]}"}
    if ((removed > 0)); then
        log "check-removed-files: removed $removed orphaned target(s); their sources are still in the repository history at ${old_head:-an earlier commit} if one has to come back."
    fi
    return 0
}

pre() {
    local managed_file target_relative target source source_relative git_relative provenance
    local token owner_pid old_token
    # A preview runs this hook but never the post hook - chezmoi does not run the
    # post phase under --dry-run - so taking a snapshot here would only leave a
    # transaction for the next update to explain away as an interrupted one.
    if is_dry_run "$@"; then
        return 0
    fi
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
        [[ -e $STATE_ROOT/current ]] && discard_state "$STATE_ROOT/current"
        rm -rf "$LOCK_DIR"
        if ! mkdir -m 700 "$LOCK_DIR" 2>/dev/null; then
            log 'check-removed-files: unable to reclaim interrupted update snapshot; skipping.'
            return 0
        fi
    fi
    if [[ -e $STATE_ROOT/current ]]; then
        discard_state "$STATE_ROOT/current"
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
    printf '%s\0%s\0' "$token" "$OLD_HEAD" > "$TX/meta.nul"
    : > "$TX/snapshot.nul"
    managed_file="$TX/managed.nul"
    if ! write_managed_mapping "$managed_file"; then
        log 'check-removed-files: bulk managed mapping unavailable or malformed; skipping snapshot.'
        rm -rf "$TX" "$LOCK_DIR"; return 0
    fi
    # Snapshot only chezmoi's bulk path mapping. In particular, do not inspect,
    # render, or hash each target here: most updates remove no source files.
    # The last field records whether both source path representations agree with
    # the trusted source/work tree and the corresponding git-relative path. The
    # target type is deliberately unknown until post finds a source deletion or
    # rename candidate.
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
        printf '%s\0%s\0%s\0%s\0%s\0%s\0' \
            "$target" "$target_relative" "$source" "$source_relative" \
            "$git_relative" "$provenance"
    done < "$managed_file" >> "$TX/snapshot.nul"
    rm -f "$managed_file"
    printf '%s\n' complete > "$TX/complete"
    if ! mv "$TX" "$STATE_ROOT/current"; then
        rm -rf "$TX" "$LOCK_DIR"
    fi
}

attempt_delete() { # <target> <type> <fingerprint> -> 0 unlinked, 1 left alone
    # A test-only executable seam makes the identity-change check
    # deterministic without widening production behavior.
    if [[ -n ${CHECK_REMOVED_FILES_TEST_BEFORE_VERIFY:-} ]]; then
        "$CHECK_REMOVED_FILES_TEST_BEFORE_VERIFY" "$1" "$DEST_DIR" || true
    fi
    # Recheck immediately before unlinking. rm -f unlinks symlinks and
    # regular files only after the type check above; it never recurses.
    if safe_target "$1" "$DEST_DIR" verify \
        && is_confidently_unmanaged "$1" \
        && { [[ $2 == file && -f $1 && ! -L $1 ]] || [[ $2 == symlink && -L $1 ]]; } \
        && [[ $(fingerprint "$1" 2>/dev/null || true) == "$3" ]]; then
        # The fingerprint comparison is intentionally the final operation
        # before the non-recursive unlink.
        rm -f -- "$1" && { log "check-removed-files: deleted $1."; return 0; }
    fi
    log "check-removed-files: leaving $1 (changed, unsafe, or managed again)."
    return 1
}

post() {
    # Inspecting one update is a function with a dozen safety returns, and none of
    # them may skip retrying the removals still on the ledger: finishing a chezmoi
    # update has to stay a single command rather than two.
    local dry_run=false
    if is_dry_run "$@"; then
        dry_run=true
    fi
    post_transaction "$dry_run"
    # A preview may not unlink anything, so everything it verified simply stays
    # recorded for the real run that follows.
    if [[ $dry_run != true ]]; then
        drain_recorded_decisions
    fi
    return 0
}

post_transaction() { # <dry-run flag>
    local old_head current_head diff_file status old_path new_path
    local target _ignored git_relative provenance
    local type fingerprint change malformed_diff=false
    local baseline_used=false
    local snapshot_dir='' own_token='' dry_run=$1
    local -A changes=() managed_now=()
    # Declared empty on purpose: settle_candidates counts them, and counting an
    # undeclared name would abort the hook under `set -u` on every update that
    # removed nothing - which is most of them.
    local -a cand_target=() cand_change=() cand_rel=() cand_type=() cand_fp=()

    # Prefer this update's own snapshot. `current` is only published once
    # complete is written, so anything else is corrupt rather than inheritable.
    if [[ ! -d $LOCK_DIR || ! -f $LOCK_DIR/token ]]; then
        [[ -e $STATE_ROOT/current ]] && discard_state "$STATE_ROOT/current"
    elif [[ ! -f $STATE_ROOT/current/complete ]]; then
        [[ -e $STATE_ROOT/current ]] && discard_state "$STATE_ROOT/current"
        release_stale_lock
    elif ! read_metadata "$STATE_ROOT/current/meta.nul"; then
        discard_state "$STATE_ROOT/current"; release_stale_lock
    elif [[ ${META[0]} != $(<"$LOCK_DIR/token") ]]; then
        discard_state "$STATE_ROOT/current"; release_stale_lock
    elif [[ ! -r $STATE_ROOT/current/snapshot.nul ]]; then
        # Checked, not assumed: the record loop redirects from this file, and an
        # unvalidated redirection would abort the hook itself.
        discard_state "$STATE_ROOT/current"; release_stale_lock
    else
        snapshot_dir=$STATE_ROOT/current
        own_token=${META[0]}
    fi

    # Fall back to the retained baseline. Without it, a removal whose snapshot
    # was lost - interrupted update, wiped cache, a pull that ran without the
    # pre hook - would be discarded silently and never carried out at all.
    if [[ -z $snapshot_dir && -e $STATE_ROOT/last ]]; then
        if [[ -f $STATE_ROOT/last/complete && -r $STATE_ROOT/last/snapshot.nul ]] \
            && read_metadata "$STATE_ROOT/last/meta.nul"; then
            snapshot_dir=$STATE_ROOT/last
            baseline_used=true
            log 'check-removed-files: no snapshot for this update; using the retained baseline.'
        else
            # Evidence this run cannot read has to leave, or it would veto every
            # later post as well. Nothing in it records what was deleted - git does
            # that - so there is nothing to keep and nothing to rebuild from it.
            log 'check-removed-files: the retained baseline is unreadable; dropping it.'
            discard_state "$STATE_ROOT/last"
        fi
    fi
    [[ -n $snapshot_dir ]] || return 0
    if [[ $baseline_used == true ]] && transaction_owner_alive; then
        # This path runs unlocked, so stay out of the way of a live pre/post
        # pair instead of racing it for the same targets.
        log 'check-removed-files: another update is in flight; skipping.'
        return 0
    fi
    old_head=${META[1]}
    current_head=$(git -C "$WORK_TREE" rev-parse --verify HEAD 2>/dev/null) || {
        if [[ $baseline_used == false ]]; then
            discard_state "$STATE_ROOT/current"
        fi
        discard_transaction "$own_token"
        return 0
    }
    if [[ $current_head == "$old_head" ]]; then
        # Nothing was pulled, so this transaction proves nothing about removals.
        # The retained baseline may still describe removals that nobody reported
        # - a preview saw them and deleted nothing, an update lost its snapshot -
        # so if it predates HEAD, fall through and let it speak. The candidate
        # loop skips targets that are already gone, so an old baseline can never
        # re-offer a deletion that already happened, and the final publish turns
        # the evidence into a current baseline so it speaks once, not forever.
        if [[ $baseline_used == false ]] \
            && [[ -f $STATE_ROOT/last/complete && -r $STATE_ROOT/last/snapshot.nul ]] \
            && read_metadata "$STATE_ROOT/last/meta.nul" \
            && [[ ${META[1]} != "$current_head" ]]; then
            log 'check-removed-files: nothing was pulled; using the retained baseline.'
            snapshot_dir=$STATE_ROOT/last
            baseline_used=true
            old_head=${META[1]}
            # own_token is deliberately kept: this run still holds the lock it
            # inherited, and holding it is what keeps a concurrent update out of
            # the same targets.
        else
            if [[ $baseline_used == false && ! -e $STATE_ROOT/last ]]; then
                publish_baseline "$own_token"
            fi
            discard_transaction "$own_token"
            return 0
        fi
    fi

    diff_file=$(mktemp "$STATE_ROOT/.diff.XXXXXXXX") || {
        [[ $baseline_used == false ]] && discard_state "$STATE_ROOT/current"
        discard_transaction "$own_token"
        return 0
    }
    if ! git -C "$WORK_TREE" diff --name-status -z -M "$old_head" "$current_head" > "$diff_file"; then
        rm -f "$diff_file"
        [[ $baseline_used == false ]] && discard_state "$STATE_ROOT/current"
        discard_transaction "$own_token"
        return 0
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
        if [[ $baseline_used == false ]]; then
            discard_state "$STATE_ROOT/current"
        fi
        discard_transaction "$own_token"
        return 0
    fi
    rm -f "$diff_file"

    # Diff and current mapping are both collected before any target is
    # inspected. A fresh mapping is queried again immediately before unlinking
    # each accepted candidate to close the hook/apply race.
    local current_file
    current_file=$(mktemp "$STATE_ROOT/.managed.XXXXXXXX") || {
        [[ $baseline_used == false ]] && discard_state "$STATE_ROOT/current"
        discard_transaction "$own_token"
        return 0
    }
    if ! write_managed_mapping "$current_file" all; then
        log 'check-removed-files: current managed mapping unavailable or malformed; leaving targets.'
        rm -f "$current_file"
        if [[ $baseline_used == false ]]; then
            discard_state "$STATE_ROOT/current"
        fi
        discard_transaction "$own_token"
        return 0
    fi
    while IFS= read -r -d '' _ignored \
        && IFS= read -r -d '' target \
        && IFS= read -r -d '' _ignored \
        && IFS= read -r -d '' _ignored; do
        managed_now["$target"]=1
    done < "$current_file"
    rm -f "$current_file"
    if ! read_pending; then
        log 'check-removed-files: pending ledger is unreadable; dropping it.'
        discard_state "$PENDING_FILE"
    fi

    while IFS= read -r -d '' target \
        && IFS= read -r -d '' _ignored \
        && IFS= read -r -d '' _ignored \
        && IFS= read -r -d '' _ignored \
        && IFS= read -r -d '' git_relative \
        && IFS= read -r -d '' provenance; do
        [[ $provenance == worktree ]] || {
            log "check-removed-files: leaving ambiguous target $target (external or unmapped source)."
            continue
        }
        change=${changes[$git_relative]:-}
        [[ -n $change ]] || continue
        if [[ -n ${managed_now[$target]+yes} ]]; then
            # chezmoi owns this target again (a revert, a re-add, a different
            # source claiming it), so no decision is owed for it.
            pending_drop "$target"
            continue
        fi
        # An earlier run, `chezmoi apply --remove`, or the user already dealt
        # with it. Stale evidence is never a reason to report the same file again.
        if [[ ! -e $target && ! -L $target ]]; then
            pending_drop "$target"
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

        # Verification is identical for a preview and for a real run; only
        # settle_candidates decides whether the unlink happens.
        cand_target+=("$target")
        cand_change+=("$change")
        cand_rel+=("$git_relative")
        cand_type+=("$type")
        cand_fp+=("$fingerprint")
    done < "$snapshot_dir/snapshot.nul"

    settle_candidates "$dry_run"

    if [[ $PENDING_DIRTY == true ]] && ! write_pending; then
        log 'check-removed-files: unable to record the pending cleanup list.'
    fi
    # Retain the evidence this run actually consumed. A run that worked from the
    # retained baseline normally has nothing newer to keep, and publish_baseline
    # is a no-op unless a complete transaction still exists - which is exactly the
    # no-pull fall-through, where the removals reported here are now consumed and
    # the next no-op update must not report them again.
    publish_baseline "$own_token"
    discard_transaction "$own_token"
    return 0
}

clean() {
    # Retry the pending ledger outside an update. Post confirmed every row against a
    # real source deletion once already; each entry is verified again here, because
    # "pending" is a note about the past and not a permission for now.
    local list_only=false during_update=false
    local target git_relative type fingerprint index listing listing_status
    local live_type live_fingerprint is_managed_rc current_head
    local removed=0
    local -a deleted_paths=()
    local -a kept=()
    while (($#)); do
        case $1 in
            --list | -l) list_only=true ;;
            --during-update)
                # Internal: the post hook retries the ledger itself so that finishing
                # an update never needs a second command. This run *is* that update,
                # so the "an update is in flight" check would refuse its own lock.
                during_update=true
                ;;
            -h | --help)
                log 'usage: check-removed-files.sh clean [--list]'
                log '       --list reports what is waiting and removes nothing.'
                return 0
                ;;
            *)
                # Never treat an unrecognised flag as "the safe option was asked
                # for": a mistyped argument must not start a deletion run either.
                log "check-removed-files: clean: unknown argument $1."
                log 'usage: check-removed-files.sh clean [--list]'
                return 2
                ;;
        esac
        shift
    done

    if ! read_pending; then
        log 'check-removed-files: pending ledger is unreadable; dropping it.'
        discard_state "$PENDING_FILE"
        # State this script cannot parse is a broken setup, not a clean no-op.
        return 1
    fi
    if (( ${#PENDING[@]} == 0 )); then
        [[ $during_update == true ]] || log 'check-removed-files: no orphaned targets are pending.'
        return 0
    fi
    # Deleting while an update is applying would race that update's own view of
    # what is managed - unless this *is* that update, holding the lock itself.
    if [[ $during_update != true ]] && transaction_owner_alive; then
        log 'check-removed-files: an update is in flight; try again afterwards.'
        return 1
    fi
    current_head=$(git -C "$WORK_TREE" rev-parse --verify HEAD 2>/dev/null) || {
        log 'check-removed-files: clean: cannot resolve HEAD; leaving every target.'
        return 1
    }

    for (( index = 0; index < ${#PENDING[@]}; index += PENDING_FIELDS )); do
        target=${PENDING[index]}
        git_relative=${PENDING[index + 1]}
        type=${PENDING[index + 2]}
        fingerprint=${PENDING[index + 3]}
        # Already gone: removed by hand, by an earlier pass, or by the update whose
        # ledger this is. Nothing to do, and nothing left to remember.
        [[ -e $target || -L $target ]] || continue
        # Has the source come back (revert, re-add, cherry-pick)? Ask in a way that
        # separates "git answered: not in HEAD" from "git could not answer", because
        # the second one is not permission to unlink anything.
        listing=''
        listing_status=0
        listing=$(git -C "$WORK_TREE" ls-tree -r --name-only "$current_head" -- ":(literal)$git_relative" 2>/dev/null) || listing_status=$?
        if [[ $listing_status -ne 0 ]]; then
            log "check-removed-files: leaving $target (its source could not be checked)."
            kept+=("${PENDING[@]:index:PENDING_FIELDS}")
            continue
        fi
        if [[ -n $listing ]]; then
            log "check-removed-files: leaving $target (its source exists again)."
            continue
        fi
        case $type in
            file | symlink) ;;
            *)
                log "check-removed-files: leaving $target (recorded type is unusable)."
                kept+=("${PENDING[@]:index:PENDING_FIELDS}")
                continue
                ;;
        esac
        if ! safe_target "$target" "$DEST_DIR"; then
            log "check-removed-files: leaving $target (changed, unsafe, or managed again)."
            kept+=("${PENDING[@]:index:PENDING_FIELDS}")
            continue
        fi
        if [[ -L $target ]]; then
            live_type='symlink'
        elif [[ -f $target ]]; then
            live_type='file'
        else
            log "check-removed-files: leaving $target (changed, unsafe, or managed again)."
            kept+=("${PENDING[@]:index:PENDING_FIELDS}")
            continue
        fi
        if [[ $live_type != "$type" ]]; then
            log "check-removed-files: leaving $target (its type changed since it was recorded)."
            kept+=("${PENDING[@]:index:PENDING_FIELDS}")
            continue
        fi
        live_fingerprint=$(fingerprint "$target" 2>/dev/null || true)
        if [[ -z $live_fingerprint ]]; then
            log "check-removed-files: leaving $target (changed, unsafe, or managed again)."
            kept+=("${PENDING[@]:index:PENDING_FIELDS}")
            continue
        fi
        is_managed_rc=0
        is_managed_now "$target" || is_managed_rc=$?
        case $is_managed_rc in
            0)
                log "check-removed-files: leaving $target (managed again)."
                continue
                ;;
            2)
                # An unreadable managed list is never read as "free to delete".
                log "check-removed-files: leaving $target (current management unavailable)."
                kept+=("${PENDING[@]:index:PENDING_FIELDS}")
                continue
                ;;
        esac
        if [[ $list_only == true ]]; then
            log "check-removed-files: pending: $target (source $git_relative was removed)."
            kept+=("${PENDING[@]:index:PENDING_FIELDS}")
            continue
        fi
        # A row records the contents that were verified. A target edited since then is
        # not that file any more, so it waits for an update whose own snapshot covers
        # what it holds now.
        if [[ $live_fingerprint != "$fingerprint" ]]; then
            log "check-removed-files: leaving $target (changed since it was recorded)."
            kept+=("${PENDING[@]:index:PENDING_FIELDS}")
            continue
        fi
        log "check-removed-files: source is gone from HEAD; target is unmanaged: $target"
        if attempt_delete "$target" "$type" "$fingerprint"; then
            removed=$((removed + 1))
            deleted_paths+=("$target")
        else
            kept+=("${PENDING[@]:index:PENDING_FIELDS}")
        fi
    done

    prune_emptied_dirs ${deleted_paths[@]+"${deleted_paths[@]}"}

    PENDING=(${kept[@]+"${kept[@]}"})
    if ! write_pending; then
        log 'check-removed-files: unable to rewrite the pending ledger.'
        return 1
    fi
    if [[ $during_update == true ]]; then
        # Asked as part of an update, so phrase the result as part of that update.
        log "check-removed-files: removed $removed recorded target(s); $(( ${#PENDING[@]} / PENDING_FIELDS )) still waiting."
        return 0
    fi
    log "check-removed-files: clean removed $removed target(s); $(( ${#PENDING[@]} / PENDING_FIELDS )) still pending."
    return 0
}

drain_recorded_decisions() {
    # A removal that an update could not carry out must not become a second command
    # to remember, so the same run retries the list.
    local rows
    if ! read_pending; then
        log 'check-removed-files: pending ledger is unreadable; dropping it.'
        discard_state "$PENDING_FILE"
        return 0
    fi
    rows=$(( ${#PENDING[@]} / PENDING_FIELDS ))
    (( rows > 0 )) || return 0
    log "check-removed-files: $rows orphaned target(s) recorded by earlier updates are still waiting."
    clean --during-update || true
    # `clean` re-read and rewrote the ledger from disk; the copy this run built up
    # in memory is stale and must never be written back over its work.
    PENDING_DIRTY=false
}

case $MODE in
    pre|post|clean) ;;
    *) exit 0 ;;
esac

SOURCE_DIR=${CHEZMOI_SOURCE_DIR:-}
DEST_DIR=${CHEZMOI_DEST_DIR:-}
WORK_TREE=${CHEZMOI_WORKING_TREE:-}
CACHE_DIR=${CHEZMOI_CACHE_DIR:-}

if [[ $MODE == clean \
    && ( -z $SOURCE_DIR || -z $DEST_DIR || -z $WORK_TREE || -z $CACHE_DIR ) ]]; then
    # `clean` is also run by hand, where chezmoi's hook environment is absent.
    # Derive the same values instead of exiting silently on a manual command.
    if ! command -v chezmoi >/dev/null 2>&1; then
        printf 'check-removed-files: clean: chezmoi is unavailable.\n' >&2
        exit 1
    fi
    SOURCE_DIR=${SOURCE_DIR:-$(chezmoi source-path 2>/dev/null || true)}
    WORK_TREE=${WORK_TREE:-$SOURCE_DIR}
    # A manual clean must rebuild the same environment the hook was handed, so the
    # destination comes from chezmoi rather than from a guess at $HOME.
    DEST_DIR=${DEST_DIR:-$(chezmoi target-path 2>/dev/null || true)}
    DEST_DIR=${DEST_DIR:-${HOME:-}}
    CACHE_DIR=${CACHE_DIR:-${XDG_CACHE_HOME:-${HOME:-}/.cache}/chezmoi}
fi
# A trailing slash on the destination makes every "$DEST_DIR/..." prefix test below
# fail, which would silently disable both deletion and pruning for the whole run.
if [[ -n $DEST_DIR && $DEST_DIR != / ]]; then
    DEST_DIR=${DEST_DIR%/}
fi
if [[ -z $SOURCE_DIR || -z $DEST_DIR || -z $WORK_TREE || -z $CACHE_DIR ]]; then
    # Hooks stay a silent no-op for a source chezmoi cannot describe; a manual
    # clean has to say what it could not find, and fail.
    if [[ $MODE == clean ]]; then
        printf 'check-removed-files: clean: the chezmoi source, destination, or cache directory is unavailable.\n' >&2
        exit 1
    fi
    exit 0
fi

# CHEZMOI_CACHE_DIR is the transaction-state trust anchor. If another
# principal can replace its contents, source/deletion evidence is not trusted.
# chezmoi creates this directory only once something needs it, and on
# Android/Termux ~/.cache is routinely absent: requiring it to pre-exist made
# every hook exit silently, so no target was ever offered for removal. Create
# it privately, then hold it to the existing checks.
# A setup problem must never be reported as success by a manual clean, but it
# must also never fail the update a hook is attached to.
setup_failed() {
    if [[ $MODE == clean ]]; then
        printf 'check-removed-files: clean: %s\n' "$1" >&2
        exit 1
    fi
    exit 0
}

if [[ ! -e $CACHE_DIR && ! -L $CACHE_DIR ]]; then
    # umask rather than -m, because -m only applies to the deepest component:
    # the parents must not be created group- or world-writable either.
    (umask 077 && mkdir -p -- "$CACHE_DIR") 2>/dev/null || setup_failed 'unable to create the chezmoi cache directory.'
fi
[[ -d $CACHE_DIR && ! -L $CACHE_DIR ]] || setup_failed 'the chezmoi cache directory is not a private directory.'
CACHE_IDENTITY=$(directory_identity "$CACHE_DIR" 2>/dev/null) || setup_failed 'unable to read the chezmoi cache directory. A current version of coreutils or BSD stat is required.'
CACHE_MODE=${CACHE_IDENTITY##*:}
[[ $CACHE_MODE =~ ^[0-7]+$ ]] || setup_failed 'the chezmoi cache directory has unreadable metadata.'
(( (8#$CACHE_MODE & 022) == 0 )) || setup_failed 'the chezmoi cache directory is writable by others.'

# Do not infer a repository from arbitrary directories: update hooks should be
# inert for non-git chezmoi sources.
WORK_TREE=$(git -C "$WORK_TREE" rev-parse --show-toplevel 2>/dev/null) || setup_failed 'the chezmoi source directory is not a git working tree.'
# $XDG_CACHE_HOME/chezmoi is shared by every chezmoi source on the machine, and this
# state says what may be deleted. Namespacing it by working tree means a second
# source can neither offer another source's targets for deletion nor throw away the
# baseline it still owes, without any per-record ownership bookkeeping.
SOURCE_ID=$(printf '%s' "$WORK_TREE" | hash_stdin 2>/dev/null) || setup_failed 'no SHA-256 implementation is available.'
[[ $SOURCE_ID =~ ^[0-9a-f]+$ ]] || setup_failed 'unable to identify this chezmoi source.'
STATE_PARENT="$CACHE_DIR/check-removed-files"
STATE_ROOT="$STATE_PARENT/${SOURCE_ID:0:16}"
LOCK_DIR="$STATE_ROOT/lock"
# The namespaced state directory lives under a shared one, so both levels are created
# privately and both are held to the same check: a permissive umask anywhere on the
# path would let another principal write the evidence this script deletes from.
for STATE_DIR in "$STATE_PARENT" "$STATE_ROOT"; do
    if [[ ! -e $STATE_DIR ]]; then
        # umask rather than -m, because -m only applies to the deepest component.
        (umask 077 && mkdir -p -- "$STATE_DIR") 2>/dev/null \
            || setup_failed 'unable to create the state directory.'
    fi
    [[ -d $STATE_DIR && ! -L $STATE_DIR ]] \
        || setup_failed 'the state directory is not a private directory.'
    STATE_DIR_MODE=$(directory_identity "$STATE_DIR" 2>/dev/null) \
        || setup_failed 'unable to read the state directory metadata.'
    STATE_DIR_MODE=${STATE_DIR_MODE##*:}
    [[ $STATE_DIR_MODE =~ ^[0-7]+$ ]] \
        || setup_failed 'the state directory has unreadable metadata.'
    (( (8#$STATE_DIR_MODE & 022) == 0 )) \
        || setup_failed 'the state directory is writable by others.'
done
PENDING_FILE="$STATE_ROOT/pending.nul"
reap_scratch

status=0
if [[ $MODE == clean ]]; then
    shift
    clean "$@" || status=$?
else
    # A hook may never fail the update it is attached to. Run it in a subshell
    # that re-enables errexit, because a plain `|| true` would switch set -e off
    # for the whole hook body and let a failed check fall through to a delete.
    ( set -euo pipefail
        if [[ $MODE == post ]]; then
            post "${@:2}"
        else
            # The hook launcher forwards chezmoi's own command line, so the pre hook
            # can see that this is only a preview and skip work nobody will consume.
            pre "${@:2}"
        fi
    ) || true
fi

exit "$status"
