#!/bin/sh

# Portable secret-check hook for chezmoi add.
# Works with POSIX sh and avoids bash/macOS/GNU-specific features.

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
SOURCE_DIR=$(chezmoi source-path)
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
CHECK_SECRETS_AWK=$SCRIPT_DIR/check-secrets.awk
AGE_KEY=$(awk -F: '/public key:/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$HOME/.config/chezmoi/key.txt" 2>/dev/null)

TTY_AVAILABLE=false
if ( : </dev/tty >/dev/tty ) 2>/dev/null; then
    exec 3</dev/tty 4>/dev/tty
    TTY_AVAILABLE=true
fi

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
        printf '%s\n' "$arg"
    done
    if [ -n "${CHEZMOI_ARGS:-}" ]; then
        for arg in $CHEZMOI_ARGS; do
            printf '%s\n' "$arg"
        done
    fi
}

is_bypass=false
if [ "${CHECK_SECRETS_BYPASS:-}" = 1 ]; then
    is_bypass=true
else
    for arg in $(iter_all_args "$@"); do
        case "$arg" in
            --encrypt|-e|*.tmpl|*.sops.yaml)
                is_bypass=true
                break
                ;;
        esac
    done
fi

if [ "$is_bypass" = true ]; then
    exit 0
fi

FILES_TO_ADD_TMP=$(mktemp "${TMPDIR:-/tmp}/check-secrets.files.XXXXXX") || exit 1
cleanup_files_tmp() {
    rm -f "$FILES_TO_ADD_TMP"
}
trap 'cleanup_files_tmp; cleanup_tty' EXIT HUP INT TERM

collect_files() {
    for arg in "$@"; do
        case "$arg" in
            add|'') continue ;;
            -*) continue ;;
            *) printf '%s\n' "$arg" >> "$FILES_TO_ADD_TMP" ;;
        esac
    done
}

collect_files "$@"
if [ ! -s "$FILES_TO_ADD_TMP" ] && [ -n "${CHEZMOI_ARGS:-}" ]; then
    # shellcheck disable=SC2086
    collect_files $CHEZMOI_ARGS
fi

abspath_path() {
    target=$1
    case $target in
        /*) ;;
        *) target=$PWD/$target ;;
    esac

    target_dir=$(dirname "$target") || return 1
    target_base=$(basename "$target") || return 1
    (
        cd "$target_dir" 2>/dev/null || exit 1
        printf '%s/%s\n' "$(pwd -P)" "$target_base"
    )
}

abspath_dir() {
    target=$1
    case $target in
        /*) ;;
        *) target=$PWD/$target ;;
    esac
    (
        cd "$target" 2>/dev/null || exit 1
        pwd -P
    )
}

relpath() {
    path_abs=$(abspath_path "$1") || return 1
    base_abs=$(abspath_dir "$2") || return 1
    awk -v path="$path_abs" -v base="$base_abs" '
BEGIN {
    path_count = split(path, path_parts, "/")
    base_count = split(base, base_parts, "/")
    common = 1
    while (common <= path_count && common <= base_count && path_parts[common] == base_parts[common]) {
        common++
    }
    result = ""
    for (i = common; i < base_count; i++) {
        result = result (result ? "/" : "") ".."
    }
    for (i = common; i <= path_count; i++) {
        if (path_parts[i] == "") {
            continue
        }
        result = result (result ? "/" : "") path_parts[i]
    }
    if (result == "") {
        result = "."
    }
    print result
}'
}

matches_sensitive_file() {
    input_file=$1

    SENSITIVE_PATTERNS="$SENSITIVE_PATTERNS" awk \
        -v mode=detect \
        -f "$CHECK_SECRETS_AWK" \
        "$input_file"
}

extract_sensitive_values() {
    input_file=$1
    template_file=$2
    secrets_file=$3
    sops_file_name=$4

    SENSITIVE_PATTERNS="$SENSITIVE_PATTERNS" awk \
        -v mode=extract \
        -v template_file="$template_file" \
        -v secrets_file="$secrets_file" \
        -v sops_file_name="$sops_file_name" \
        -f "$CHECK_SECRETS_AWK" \
        "$input_file"
}

while IFS= read -r file; do
    [ -n "$file" ] || continue
    [ -f "$file" ] || continue

    FOUND_SENSITIVE=false
    MATCHED_PATTERN=$(matches_sensitive_file "$file" 2>/dev/null || true)
    if [ -n "$MATCHED_PATTERN" ]; then
        FOUND_SENSITIVE=true
    fi

    if [ "$FOUND_SENSITIVE" != true ]; then
        continue
    fi

    log "⚠️  WARNING: Sensitive information detected in $file (pattern: $MATCHED_PATTERN)"
    log 'How would you like to proceed?'
    log "1) Full Encryption: chezmoi add --encrypt $file"
    log '2) SOPS Strategy: Partial encryption using sops and templates'
    log '3) Plain: Add as a plain file (NOT RECOMMENDED)'
    log '4) Abort'

    prompt_choice

    case "$CHOICE" in
        1)
            log "Running: chezmoi add --encrypt $file"
            if chezmoi add --encrypt "$file"; then
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
            log "Adding $file to chezmoi to determine source naming..."
            CHECK_SECRETS_BYPASS=1 chezmoi add "$file" || exit 1

            SOURCE_FILE=$(chezmoi source-path "$file" 2>/dev/null) || exit 1
            SOURCE_FILE_BASE=$SOURCE_FILE
            case "$SOURCE_FILE_BASE" in
                *.literal)
                    SOURCE_FILE_BASE=${SOURCE_FILE_BASE%.literal}
                    ;;
            esac

            SOURCE_REL_PATH=$(relpath "$SOURCE_FILE_BASE" "$SOURCE_DIR") || exit 1
            SOPS_FILE_NAME=${SOURCE_REL_PATH}.sops.yaml
            SOPS_SOURCE_PATH=$SOURCE_DIR/secrets/$SOPS_FILE_NAME

            mkdir -p "$(dirname "$SOPS_SOURCE_PATH")" || exit 1

            TMP_SECRETS_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.secrets.XXXXXX") || exit 1
            TMP_TEMPLATE_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.template.XXXXXX") || {
                rm -f "$TMP_SECRETS_FILE"
                exit 1
            }

            log 'Identifying and extracting secrets...'

            if ! extract_sensitive_values "$file" "$TMP_TEMPLATE_FILE" "$TMP_SECRETS_FILE" "$SOPS_FILE_NAME"; then
                status=$?
                if [ "$status" -ne 2 ]; then
                    rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE" "$SOURCE_FILE"
                    exit 1
                fi
            fi

            if [ ! -s "$TMP_SECRETS_FILE" ]; then
                log 'No extractable secrets found; aborting.'
                rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE" "$SOURCE_FILE"
                exit 1
            fi

            log "Creating sops-encrypted file at $SOPS_SOURCE_PATH..."
            if ! sops --encrypt --age "$AGE_KEY" "$TMP_SECRETS_FILE" > "$SOPS_SOURCE_PATH"; then
                rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE" "$SOURCE_FILE"
                exit 1
            fi

            log "Replacing $SOURCE_FILE with template content..."
            cp "$TMP_TEMPLATE_FILE" "$SOURCE_FILE" || {
                rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE" "$SOURCE_FILE"
                exit 1
            }

            FINAL_SOURCE_FILE=${SOURCE_FILE_BASE}.tmpl
            if [ "$SOURCE_FILE" != "$FINAL_SOURCE_FILE" ]; then
                mv "$SOURCE_FILE" "$FINAL_SOURCE_FILE" || {
                    rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE" "$SOURCE_FILE"
                    exit 1
                }
            fi

            log 'Cleaning up...'
            rm -f "$TMP_TEMPLATE_FILE" "$TMP_SECRETS_FILE"

            log '✅ SOPS strategy complete.'
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
