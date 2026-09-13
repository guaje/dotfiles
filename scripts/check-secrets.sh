#!/usr/bin/env bash

# Secret-check hook for chezmoi add. Bash is required for the isolated mapping
# oracle and safe signal cleanup.

set -u

if (( BASH_VERSINFO[0] < 4 )); then
    printf '%s\n' 'check-secrets: Bash 4 or newer is required.' >&2
    exit 1
fi

SENSITIVE_PATTERNS='API_KEY
PASSWORD
PASSWD
PASSPHRASE
SECRET
TOKEN
AUTH
CREDENTIAL
ACCESS_KEY
SECRET_KEY
PRIVATE_KEY
CLIENT_SECRET
WEBHOOK
DSN
CONNECTION_STRING
COOKIE
SESSION'
# Hooks receive CHEZMOI_SOURCE_DIR for the exact command invocation. Falling
# back keeps direct/manual execution working, while avoiding a nested chezmoi
# lookup that can select a different config/source checkout.
SOURCE_DIR=${CHEZMOI_SOURCE_DIR:-$(chezmoi source-path)}
# The conventional chezmoi source path may itself be a symlink (including in
# isolated tests). Canonicalize that trusted root once, then reject symlinks
# below it when validating publication paths.
SOURCE_DIR=$(CDPATH='' cd -- "$SOURCE_DIR" 2>/dev/null && pwd -P) || exit 1
SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
CHECK_SECRETS_AWK=$SCRIPT_DIR/check-secrets.awk
GENERATED_TEMPLATE_MARKER='{{- /* check-secrets:generated:v1 */ -}}'

# Shells do not expand a tilde after parameter expansion. Normalize legacy
# generated configs that still supply SOPS_AGE_KEY_FILE as ~/.config/...
normalize_home_path() {
    # shellcheck disable=SC2088 # Match a deliberately unexpanded legacy tilde.
    case $1 in
        '~/'*) printf '%s/%s\n' "$HOME" "${1#\~/}" ;;
        *) printf '%s\n' "$1" ;;
    esac
}
SOPS_AGE_KEY_FILE=$(normalize_home_path "${SOPS_AGE_KEY_FILE:-$HOME/.config/chezmoi/key.txt}")
export SOPS_AGE_KEY_FILE
AGE_KEY=$(awk -F: '/public key:/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$SOPS_AGE_KEY_FILE" 2>/dev/null)

TTY_AVAILABLE=false
if ( : </dev/tty >/dev/tty ) 2>/dev/null; then
    exec 3</dev/tty 4>/dev/tty
    TTY_AVAILABLE=true
fi

# shellcheck disable=SC2329 # Invoked through signal traps.
cleanup_tty() {
    if [ "$TTY_AVAILABLE" = true ]; then
        exec 3<&-
        exec 4>&-
    fi
}

log() {
    if [ "$TTY_AVAILABLE" = true ]; then
        printf '%s\n' "$*" >&4
    else
        printf '%s\n' "$*" >&2
    fi
}

prompt_choice() {
    if [ -n "${TEST_CHOICE:-}" ]; then
        CHOICE=$TEST_CHOICE
        log "Auto-selecting option: $CHOICE"
        return 0
    fi

    if [ "$TTY_AVAILABLE" = true ]; then
        printf 'Select an option [1-4]: ' >&4
        IFS= read -r CHOICE <&3
        return 0
    fi

    CHOICE=4
    log 'No interactive terminal available; aborting.'
    return 0
}

iter_all_args() {
    for arg in "$@"; do
        printf '%s\0' "$arg"
    done
    if [ -n "${CHEZMOI_ARGS:-}" ]; then
        # CHEZMOI_ARGS is a legacy space-delimited command string. Hook
        # arguments themselves remain NUL-delimited end-to-end.
        # shellcheck disable=SC2086
        for arg in $CHEZMOI_ARGS; do
            printf '%s\0' "$arg"
        done
    fi
}

is_bypass=false
if [ "${CHECK_SECRETS_BYPASS:-}" = 1 ]; then
    is_bypass=true
else
    while IFS= read -r -d '' arg; do
        case "$arg" in
            --encrypt|-e|*.tmpl|*.sops.yaml)
                is_bypass=true
                break
                ;;
        esac
    done < <(iter_all_args "$@")
fi

if [ "$is_bypass" = true ]; then
    exit 0
fi

FILES_TO_ADD_TMP=$(mktemp "${TMPDIR:-/tmp}/check-secrets.files.XXXXXX") || exit 1
ORACLE_ROOT=
ORACLE_PARENT=

# The oracle briefly contains a plaintext copy of the target. Keep its path in
# the invoking shell so every normal/signal exit can remove it. The basename
# and canonical parent checks prevent a corrupted variable from broadening the
# recursive removal.
# shellcheck disable=SC2329 # Invoked through signal traps.
cleanup_oracle_root() {
    local root=${ORACLE_ROOT:-} parent=${ORACLE_PARENT:-} leaf
    [[ -n $root && -n $parent ]] || return 0
    ORACLE_ROOT=
    ORACLE_PARENT=
    [[ $parent == /* && -d $parent && ! -L $parent ]] || return 1
    case $root in
        "$parent"/check-secrets-oracle.*) ;;
        *) return 1 ;;
    esac
    leaf=${root#"$parent"/}
    [[ $leaf == check-secrets-oracle.* && $leaf != */* ]] || return 1
    rm -rf -- "$root"
}

# shellcheck disable=SC2329 # Invoked through signal traps.
cleanup_files_tmp() {
    rm -f "$FILES_TO_ADD_TMP" "${TMP_SECRETS_FILE:-}" "${TMP_TEMPLATE_FILE:-}" \
        "${TMP_IDS_FILE:-}" "${TMP_DUPLICATE_BINDINGS_FILE:-}" \
        "${TMP_OLD_SECRETS_FILE:-}" "${TMP_OLD_RENDERED_FILE:-}" \
        "${TMP_OLD_TEMPLATE_FILE:-}" "${TMP_OLD_EXTRACTED_SECRETS_FILE:-}" \
        "${TMP_OLD_IDS_FILE:-}" "${TMP_OLD_DUPLICATE_BINDINGS_FILE:-}" \
        "${TMP_SORTED_IDS_FILE:-}" "${TMP_OLD_SORTED_IDS_FILE:-}" \
        "${CIPHER_TMP:-}" "${TEMPLATE_TMP:-}"
}
trap 'cleanup_oracle_root; cleanup_files_tmp; cleanup_tty' EXIT
trap 'cleanup_oracle_root; cleanup_files_tmp; cleanup_tty; exit 129' HUP
trap 'cleanup_oracle_root; cleanup_files_tmp; cleanup_tty; exit 130' INT
trap 'cleanup_oracle_root; cleanup_files_tmp; cleanup_tty; exit 143' TERM

collect_files() {
    for arg in "$@"; do
        case "$arg" in
            add|'') continue ;;
            -*) continue ;;
            *) printf '%s\0' "$arg" >> "$FILES_TO_ADD_TMP" ;;
        esac
    done
}

collect_files "$@"
if [ ! -s "$FILES_TO_ADD_TMP" ] && [ -n "${CHEZMOI_ARGS:-}" ]; then
    # shellcheck disable=SC2086
    collect_files $CHEZMOI_ARGS
fi

validate_relative_path() {
    local value=$1 component
    local -a components
    case $value in
        ''|/*|*'//'*) return 1 ;;
    esac
    IFS=/ read -r -a components <<< "$value"
    for component in "${components[@]}"; do
        case $component in
            ''|.|..) return 1 ;;
        esac
    done
    return 0
}

validate_source_directory() {
    local directory=$1 relative component current
    case $directory in
        "$SOURCE_DIR") relative= ;;
        "$SOURCE_DIR"/*) relative=${directory#"$SOURCE_DIR"/} ;;
        *) return 1 ;;
    esac
    [[ -d $SOURCE_DIR && ! -L $SOURCE_DIR ]] || return 1
    current=$SOURCE_DIR
    [[ -z $relative ]] && return 0
    validate_relative_path "$relative" || return 1
    IFS=/ read -r -a components <<< "$relative"
    for component in "${components[@]}"; do
        current=$current/$component
        if [[ -e $current || -L $current ]]; then
            [[ -d $current && ! -L $current ]] || return 1
        fi
    done
}

ensure_source_directory() {
    local directory=$1 relative component current
    validate_source_directory "$directory" || return 1
    [[ $directory == "$SOURCE_DIR" ]] && return 0
    relative=${directory#"$SOURCE_DIR"/}
    current=$SOURCE_DIR
    IFS=/ read -r -a components <<< "$relative"
    for component in "${components[@]}"; do
        current=$current/$component
        if [[ ! -e $current && ! -L $current ]]; then
            mkdir "$current" || return 1
        fi
        [[ -d $current && ! -L $current ]] || return 1
    done
}

install_no_clobber() {
    local pending=$1 destination=$2
    # Hard links are denied on some Android/Termux filesystems. mv -n is
    # available on the supported GNU/BSD platforms; because it can report
    # success when it skips a collision, verify that the pending file moved.
    mv -n "$pending" "$destination" 2>/dev/null || return 1
    [[ ! -e $pending && ! -L $pending ]]
}

# chezmoi source-path only maps managed targets. Ask an isolated, mode-0700
# sacrificial source to perform the mapping, then discard it. This is a
# compatibility oracle, never the checked-out source: its short-lived copy of
# the target is protected and is removed before any real-source mutation.
prospective_source_path() {
    local target=$1 oracle_source oracle_path relative destination oracle_parent
    # chezmoi interprets relative add targets beneath its destination even when
    # the hook itself runs with the source directory as its working directory.
    # Pass an absolute target to the isolated oracle to preserve that meaning.
    destination=${CHEZMOI_DEST_DIR:-$HOME}
    case $target in
        /*) ;;
        *) target=$destination/$target ;;
    esac
    oracle_parent=$(CDPATH='' cd -- "${TMPDIR:-/tmp}" && pwd -P) || return 1
    [[ -d $oracle_parent && ! -L $oracle_parent ]] || return 1
    ORACLE_PARENT=$oracle_parent
    ORACLE_ROOT=$(mktemp -d "$ORACLE_PARENT/check-secrets-oracle.XXXXXX") || {
        ORACLE_PARENT=
        return 1
    }
    chmod 700 "$ORACLE_ROOT" || { cleanup_oracle_root; return 1; }
    case ${CHECK_SECRETS_FAILPOINT:-} in
        term-after-oracle-create) kill -TERM "$BASHPID"; return 1 ;;
    esac
    oracle_source=$ORACLE_ROOT/source
    mkdir "$oracle_source" || { cleanup_oracle_root; return 1; }
    cp -a "$SOURCE_DIR/." "$oracle_source/" || { cleanup_oracle_root; return 1; }
    # Preserve an existing source mapping (especially a .tmpl attribute).
    # Only add in the sacrificial copy when the target is genuinely unmanaged.
    oracle_path=$(chezmoi --config /dev/null --config-format toml --cache "$ORACLE_ROOT/cache" --persistent-state "$ORACLE_ROOT/state" --source "$oracle_source" --destination "$destination" source-path "$target" 2>/dev/null) || oracle_path=
    if [[ -z $oracle_path ]]; then
        if ! CHECK_SECRETS_BYPASS=1 chezmoi --config /dev/null --config-format toml --cache "$ORACLE_ROOT/cache" --persistent-state "$ORACLE_ROOT/state" --source "$oracle_source" --destination "$destination" add --force "$target" >/dev/null 2>&1; then
            cleanup_oracle_root
            return 1
        fi
        case ${CHECK_SECRETS_FAILPOINT:-} in
            term-after-oracle-add) kill -TERM "$BASHPID"; return 1 ;;
        esac
        oracle_path=$(chezmoi --config /dev/null --config-format toml --cache "$ORACLE_ROOT/cache" --persistent-state "$ORACLE_ROOT/state" --source "$oracle_source" --destination "$destination" source-path "$target" 2>/dev/null) || {
            cleanup_oracle_root
            return 1
        }
    fi
    case $oracle_path in
        "$oracle_source"/*) relative=${oracle_path#"$oracle_source"/} ;;
        *) cleanup_oracle_root; return 1 ;;
    esac
    cleanup_oracle_root || return 1
    validate_relative_path "$relative" || return 1
    PROSPECTIVE_SOURCE_PATH=$SOURCE_DIR/$relative
}

matches_sensitive_file() {
    input_file=$1

    SENSITIVE_PATTERNS="$SENSITIVE_PATTERNS" awk \
        -v mode=detect \
        -v output_format=tsv \
        -f "$CHECK_SECRETS_AWK" \
        "$input_file"
}

preview_sensitive_lines() {
    input_file=$1

    SENSITIVE_PATTERNS="$SENSITIVE_PATTERNS" awk \
        -v mode=preview \
        -f "$CHECK_SECRETS_AWK" \
        "$input_file"
}

extract_sensitive_values() {
    local input_file=$1 template_file=$2 secrets_file=$3 sops_file_name=$4
    local ids_file=${5:-} duplicate_bindings_file=${6:-}

    SENSITIVE_PATTERNS="$SENSITIVE_PATTERNS" awk \
        -v mode=extract \
        -v template_file="$template_file" \
        -v secrets_file="$secrets_file" \
        -v sops_file_name="$sops_file_name" \
        -v ids_file="$ids_file" \
        -v duplicate_bindings_file="$duplicate_bindings_file" \
        -f "$CHECK_SECRETS_AWK" \
        "$input_file"
}

managed_by_generated_template() {
    local target=$1 candidate
    prospective_source_path "$target" || return 1
    candidate=$PROSPECTIVE_SOURCE_PATH
    case $candidate in
        "$SOURCE_DIR"/*.tmpl)
            [[ -f $candidate && ! -L $candidate ]] \
                && grep -Fqx "$GENERATED_TEMPLATE_MARKER" "$candidate"
            ;;
        *) return 1 ;;
    esac
}

while IFS= read -r -d '' file; do
    [ -n "$file" ] || continue
    [ -f "$file" ] || continue

    FOUND_SENSITIVE=false
    MATCHED_PATTERN=$(matches_sensitive_file "$file" 2>/dev/null || true)
    if [ -n "$MATCHED_PATTERN" ]; then
        FOUND_SENSITIVE=true
    fi

    if [ "$FOUND_SENSITIVE" != true ]; then
        # Removing the final secret would otherwise bypass the menu and let the
        # outer add overwrite a generated template. Treat it as a structural
        # identifier change and fail before real-source mutation.
        if managed_by_generated_template "$file"; then
            log 'Secret identifiers changed; migrate the template and ciphertext manually.'
            exit 1
        fi
        continue
    fi

    MATCHED_DETECTOR=$(printf '%s\n' "$MATCHED_PATTERN" | awk -F '\t' 'NR == 1 { print $1 }')
    MATCHED_LINE=$(printf '%s\n' "$MATCHED_PATTERN" | awk -F '\t' 'NR == 1 { print $2 }')
    log "⚠️  Sensitive information detected: $file:${MATCHED_LINE:-0}:${MATCHED_DETECTOR:-UNKNOWN}: [REDACTED]"
    log 'Sensitive locations (redacted):'
    if PREVIEW_LINES=$(preview_sensitive_lines "$file" 2>/dev/null || true) && [ -n "$PREVIEW_LINES" ]; then
        printf '%s\n' "$PREVIEW_LINES" | while IFS= read -r preview_line; do
            [ -n "$preview_line" ] || continue
            log "  $preview_line"
        done
    fi
    log 'How would you like to proceed?'
    log "1) Full Encryption: chezmoi add --encrypt $file"
    log '2) Partial SOPS encryption: extract selected values into a stable encrypted sidecar'
    log '3) Plain: Add as a plain file (NOT RECOMMENDED)'
    log '4) Abort'

    prompt_choice

    case "$CHOICE" in
        1)
            log "Running: chezmoi add --encrypt $file"
            if CHECK_SECRETS_BYPASS=1 chezmoi add --encrypt "$file"; then
                SOURCE_FILE=$(chezmoi source-path "$file" 2>/dev/null)
                case "$(basename "$SOURCE_FILE")" in
                    encrypted_private_*)
                        ;;
                    encrypted_*)
                        dir=$(dirname "$SOURCE_FILE")
                        base=$(basename "$SOURCE_FILE")
                        new_base=$(printf '%s' "$base" | sed 's/^encrypted_/encrypted_private_/')
                        if [ "$base" != "$new_base" ]; then
                            mv "$SOURCE_FILE" "$dir/$new_base"
                        fi
                        ;;
                esac
            fi
            exit 1
            ;;
        2)
            if [[ -L $file ]]; then
                log 'Refusing to extract secrets from a symbolic link.'
                exit 1
            fi
            # Never run add against the real source before conversion: the
            # isolated oracle predicts chezmoi's source name without publishing
            # plaintext.
            umask 077
            if ! prospective_source_path "$file"; then
                log 'Unable to safely determine the prospective chezmoi source path; aborting.'
                exit 1
            fi
            SOURCE_FILE=$PROSPECTIVE_SOURCE_PATH
            SOURCE_FILE_BASE=${SOURCE_FILE%.literal}
            REPLACING_TEMPLATE=false
            if [[ $SOURCE_FILE_BASE == *.tmpl ]]; then
                REPLACING_TEMPLATE=true
                SOURCE_FILE_BASE=${SOURCE_FILE_BASE%.tmpl}
            fi
            SOURCE_REL_PATH=${SOURCE_FILE_BASE#"$SOURCE_DIR"/}
            [[ $SOURCE_REL_PATH != "$SOURCE_FILE_BASE" ]] || { log 'Prospective source escaped source root; aborting.'; exit 1; }
            validate_relative_path "$SOURCE_REL_PATH" || { log 'Unsafe prospective source path; aborting.'; exit 1; }

            SOPS_FILE_NAME=${SOURCE_REL_PATH}.sops.yaml
            SOPS_SOURCE_PATH=$SOURCE_DIR/secrets/$SOPS_FILE_NAME
            TEMPLATE_SOURCE_PATH=${SOURCE_FILE_BASE}.tmpl
            TEMPLATE_DIR=$(dirname "$TEMPLATE_SOURCE_PATH")
            SOPS_DIR=$(dirname "$SOPS_SOURCE_PATH")
            TEMPLATE_LEAF=$(basename "$TEMPLATE_SOURCE_PATH")
            SOPS_LEAF=$(basename "$SOPS_SOURCE_PATH")
            case $TEMPLATE_SOURCE_PATH in "$SOURCE_DIR"/*) ;; *) log 'Prospective template escaped source; aborting.'; exit 1 ;; esac
            case $SOPS_SOURCE_PATH in "$SOURCE_DIR"/secrets/*) ;; *) log 'Prospective ciphertext escaped source; aborting.'; exit 1 ;; esac
            if ! validate_source_directory "$TEMPLATE_DIR" || ! validate_source_directory "$SOPS_DIR"; then
                log 'Unsafe source directory or symbolic link detected; aborting.'
                exit 1
            fi

            if [[ -e $SOURCE_FILE_BASE || -L $SOURCE_FILE_BASE ]]; then
                log 'A non-template source entry already manages this target; refusing automatic conversion.'
                exit 1
            fi

            TEMPLATE_EXISTS=false
            if [[ -e $TEMPLATE_SOURCE_PATH || -L $TEMPLATE_SOURCE_PATH ]]; then
                TEMPLATE_EXISTS=true
                # The generic marker is also used by hand-maintained templates.
                # Only this versioned marker authorizes automatic updates.
                if [[ $REPLACING_TEMPLATE != true || ! -f $TEMPLATE_SOURCE_PATH || -L $TEMPLATE_SOURCE_PATH ]] \
                    || ! grep -Fqx "$GENERATED_TEMPLATE_MARKER" "$TEMPLATE_SOURCE_PATH"; then
                    log 'Expected template source already exists; refusing to clobber it.'
                    exit 1
                fi
            fi
            if [[ -e $SOPS_SOURCE_PATH || -L $SOPS_SOURCE_PATH ]]; then
                [[ -f $SOPS_SOURCE_PATH && ! -L $SOPS_SOURCE_PATH ]] || {
                    log 'Stable ciphertext path is not a regular file; aborting.'
                    exit 1
                }
            elif [[ $TEMPLATE_EXISTS == true ]]; then
                log 'Generated template has no stable ciphertext sidecar; aborting.'
                exit 1
            fi
            [[ -n $AGE_KEY ]] || { log 'No age recipient configured; aborting.'; exit 1; }

            TMP_SECRETS_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.secrets.XXXXXX") || exit 1
            TMP_TEMPLATE_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.template.XXXXXX") || exit 1
            TMP_IDS_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.ids.XXXXXX") || exit 1
            TMP_DUPLICATE_BINDINGS_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.bindings.XXXXXX") || exit 1
            chmod 600 "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE" "$TMP_IDS_FILE" "$TMP_DUPLICATE_BINDINGS_FILE" 2>/dev/null || true
            log 'Identifying and extracting secrets...'
            if extract_sensitive_values "$file" "$TMP_TEMPLATE_FILE" "$TMP_SECRETS_FILE" \
                "$SOPS_FILE_NAME" "$TMP_IDS_FILE" "$TMP_DUPLICATE_BINDINGS_FILE"; then
                :
            else
                status=$?
                [[ $status -eq 2 ]] && log 'No extractable secrets found; aborting.'
                exit 1
            fi
            [[ -s $TMP_SECRETS_FILE && -s $TMP_IDS_FILE ]] || exit 1
            TMP_SORTED_IDS_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.sorted-ids.XXXXXX") || exit 1
            LC_ALL=C sort "$TMP_IDS_FILE" > "$TMP_SORTED_IDS_FILE" || exit 1

            if [[ $TEMPLATE_EXISTS == true ]]; then
                # Canonical regeneration proves that the version marker was not
                # pasted onto a hand-written or malformed template.
                TMP_OLD_SECRETS_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.old-secrets.XXXXXX") || exit 1
                TMP_OLD_RENDERED_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.old-rendered.XXXXXX") || exit 1
                TMP_OLD_TEMPLATE_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.old-template.XXXXXX") || exit 1
                TMP_OLD_EXTRACTED_SECRETS_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.old-extracted.XXXXXX") || exit 1
                TMP_OLD_IDS_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.old-ids.XXXXXX") || exit 1
                TMP_OLD_DUPLICATE_BINDINGS_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.old-bindings.XXXXXX") || exit 1
                TMP_OLD_SORTED_IDS_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.old-sorted-ids.XXXXXX") || exit 1
                chmod 600 "$TMP_OLD_SECRETS_FILE" "$TMP_OLD_RENDERED_FILE" "$TMP_OLD_TEMPLATE_FILE" \
                    "$TMP_OLD_EXTRACTED_SECRETS_FILE" "$TMP_OLD_IDS_FILE" \
                    "$TMP_OLD_DUPLICATE_BINDINGS_FILE" "$TMP_OLD_SORTED_IDS_FILE" 2>/dev/null || true
                if ! sops --decrypt --output-type binary "$SOPS_SOURCE_PATH" > "$TMP_OLD_SECRETS_FILE" 2>/dev/null \
                    || ! chezmoi execute-template < "$TEMPLATE_SOURCE_PATH" > "$TMP_OLD_RENDERED_FILE" 2>/dev/null \
                    || ! extract_sensitive_values "$TMP_OLD_RENDERED_FILE" "$TMP_OLD_TEMPLATE_FILE" \
                        "$TMP_OLD_EXTRACTED_SECRETS_FILE" "$SOPS_FILE_NAME" "$TMP_OLD_IDS_FILE" \
                        "$TMP_OLD_DUPLICATE_BINDINGS_FILE" \
                    || ! cmp -s "$TMP_OLD_TEMPLATE_FILE" "$TEMPLATE_SOURCE_PATH" \
                    || ! cmp -s "$TMP_OLD_EXTRACTED_SECRETS_FILE" "$TMP_OLD_SECRETS_FILE"; then
                    log 'Existing generated template/ciphertext pair is malformed or incompatible; aborting.'
                    exit 1
                fi
                LC_ALL=C sort "$TMP_OLD_IDS_FILE" > "$TMP_OLD_SORTED_IDS_FILE" || exit 1
                if ! cmp -s "$TMP_SORTED_IDS_FILE" "$TMP_OLD_SORTED_IDS_FILE"; then
                    log 'Secret identifiers changed; migrate the template and ciphertext manually.'
                    exit 1
                fi

                TEMPLATE_CHANGED=false
                if ! cmp -s "$TMP_TEMPLATE_FILE" "$TEMPLATE_SOURCE_PATH"; then
                    TEMPLATE_CHANGED=true
                    # Duplicate identifiers are positional. Changed generated
                    # line context is ambiguous and therefore fails closed.
                    if [[ -s $TMP_OLD_DUPLICATE_BINDINGS_FILE ]] \
                        && ! cmp -s "$TMP_DUPLICATE_BINDINGS_FILE" "$TMP_OLD_DUPLICATE_BINDINGS_FILE"; then
                        log 'Ambiguous duplicate secret binding change; migrate manually.'
                        exit 1
                    fi
                fi
                # Existing ciphertext has the same identifiers and is a safe
                # render oracle for a compatible proposed template.
                if [[ $TEMPLATE_CHANGED == true ]] \
                    && ! chezmoi execute-template < "$TMP_TEMPLATE_FILE" >/dev/null 2>&1; then
                    log 'Template render oracle failed; aborting.'
                    exit 1
                fi

                CIPHERTEXT_CHANGED=false
                if ! cmp -s "$TMP_SECRETS_FILE" "$TMP_OLD_SECRETS_FILE"; then
                    ensure_source_directory "$SOPS_DIR" || exit 1
                    CIPHER_TMP=$(mktemp "$SOPS_DIR/.${SOPS_LEAF}.pending.XXXXXX") || exit 1
                    if ! sops --encrypt --input-type binary --output-type yaml --age "$AGE_KEY" \
                        "$TMP_SECRETS_FILE" > "$CIPHER_TMP" 2>/dev/null \
                        || ! sops --decrypt --input-type yaml --output-type binary "$CIPHER_TMP" 2>/dev/null \
                            | cmp -s "$TMP_SECRETS_FILE" -; then
                        exit 1
                    fi
                    [[ -f $SOPS_SOURCE_PATH && ! -L $SOPS_SOURCE_PATH ]] || exit 1
                    mv -f "$CIPHER_TMP" "$SOPS_SOURCE_PATH" || exit 1
                    CIPHER_TMP=
                    CIPHERTEXT_CHANGED=true
                    case ${CHECK_SECRETS_FAILPOINT:-} in
                        readd-after-cipher-replace) exit 75 ;;
                        readd-term-after-cipher) kill -TERM "$BASHPID"; exit 75 ;;
                        readd-hup-after-cipher) kill -HUP "$BASHPID"; exit 75 ;;
                    esac
                fi

                if [[ $TEMPLATE_CHANGED == true ]]; then
                    ensure_source_directory "$TEMPLATE_DIR" || exit 1
                    TEMPLATE_TMP=$(mktemp "$TEMPLATE_DIR/.${TEMPLATE_LEAF}.pending.XXXXXX") || exit 1
                    cp "$TMP_TEMPLATE_FILE" "$TEMPLATE_TMP" || exit 1
                    [[ -f $TEMPLATE_SOURCE_PATH && ! -L $TEMPLATE_SOURCE_PATH ]] || exit 1
                    case ${CHECK_SECRETS_FAILPOINT:-} in
                        readd-before-template-replace) exit 75 ;;
                    esac
                    mv -f "$TEMPLATE_TMP" "$TEMPLATE_SOURCE_PATH" || exit 1
                    TEMPLATE_TMP=
                fi
                if [[ $TEMPLATE_CHANGED == false && $CIPHERTEXT_CHANGED == true ]]; then
                    log '✅ SOPS value update complete (only stable ciphertext was atomically replaced).'
                else
                    log '✅ SOPS generated template is up to date.'
                fi
                log 'The following non-zero chezmoi hook status is expected: it prevents the outer add from overwriting the safe template with plaintext.'
                exit 1
            fi

            # First creation, or recovery from a stable ciphertext orphan.
            NEW_CIPHER_INSTALLED=false
            if [[ -e $SOPS_SOURCE_PATH ]]; then
                TMP_OLD_SECRETS_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.orphan.XXXXXX") || exit 1
                chmod 600 "$TMP_OLD_SECRETS_FILE" 2>/dev/null || true
                if ! sops --decrypt --output-type binary "$SOPS_SOURCE_PATH" > "$TMP_OLD_SECRETS_FILE" 2>/dev/null \
                    || ! cmp -s "$TMP_OLD_SECRETS_FILE" "$TMP_SECRETS_FILE"; then
                    log 'Stable ciphertext orphan does not exactly match the extracted payload; refusing to resume.'
                    exit 1
                fi
            else
                case ${CHECK_SECRETS_FAILPOINT:-} in before-cipher-install) exit 75 ;; esac
                ensure_source_directory "$SOPS_DIR" && ensure_source_directory "$TEMPLATE_DIR" || exit 1
                CIPHER_TMP=$(mktemp "$SOPS_DIR/.${SOPS_LEAF}.pending.XXXXXX") || exit 1
                if ! sops --encrypt --input-type binary --output-type yaml --age "$AGE_KEY" \
                    "$TMP_SECRETS_FILE" > "$CIPHER_TMP" 2>/dev/null \
                    || ! sops --decrypt --input-type yaml --output-type binary "$CIPHER_TMP" 2>/dev/null \
                        | cmp -s "$TMP_SECRETS_FILE" -; then
                    exit 1
                fi
                install_no_clobber "$CIPHER_TMP" "$SOPS_SOURCE_PATH" || exit 1
                CIPHER_TMP=
                NEW_CIPHER_INSTALLED=true
            fi

            if ! chezmoi execute-template < "$TMP_TEMPLATE_FILE" >/dev/null 2>&1; then
                log 'Template render oracle failed; aborting.'
                [[ $NEW_CIPHER_INSTALLED == true ]] && rm -f "$SOPS_SOURCE_PATH"
                exit 1
            fi
            case ${CHECK_SECRETS_FAILPOINT:-} in
                after-cipher-install) exit 75 ;;
                term-after-cipher) kill -TERM "$$"; exit 75 ;;
                hup-after-cipher) kill -HUP "$$"; exit 75 ;;
            esac
            ensure_source_directory "$TEMPLATE_DIR" || exit 1
            TEMPLATE_TMP=$(mktemp "$TEMPLATE_DIR/.${TEMPLATE_LEAF}.pending.XXXXXX") || exit 1
            cp "$TMP_TEMPLATE_FILE" "$TEMPLATE_TMP" || exit 1
            case ${CHECK_SECRETS_FAILPOINT:-} in before-template-install) exit 75 ;; esac
            if ! install_no_clobber "$TEMPLATE_TMP" "$TEMPLATE_SOURCE_PATH"; then
                [[ $NEW_CIPHER_INSTALLED == true ]] && rm -f "$SOPS_SOURCE_PATH"
                exit 1
            fi
            TEMPLATE_TMP=
            log '✅ SOPS strategy complete (stable ciphertext installed before generated template).'
            log 'The following non-zero chezmoi hook status is expected: it prevents the outer add from overwriting the safe template with plaintext.'
            exit 1
            ;;
        3)
            log 'Proceeding with plain add.'
            ;;
        *)
            log 'Aborting.'
            exit 1
            ;;
    esac
done < "$FILES_TO_ADD_TMP"

exit 0
