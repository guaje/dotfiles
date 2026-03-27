#!/bin/sh

# Portable secret-check hook for chezmoi add.
# Works with POSIX sh and avoids bash/macOS/GNU-specific features.

SENSITIVE_PATTERNS='API_KEY
PASSWORD
SECRET
TOKEN
AUTH'
SOURCE_DIR=$(chezmoi source-path)
AGE_KEY=$(awk -F: '/public key:/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$HOME/.config/chezmoi/key.txt" 2>/dev/null)

TTY_AVAILABLE=false
if { exec 3</dev/tty 4>/dev/tty; } 2>/dev/null; then
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
for arg in $(iter_all_args "$@"); do
    case "$arg" in
        --encrypt|-e|*.tmpl|*.sops.yaml)
            is_bypass=true
            break
            ;;
    esac
done

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

relpath_from_home() {
    python3 - "$1" "$HOME" <<'PY'
import os, sys
path = os.path.abspath(sys.argv[1])
home = os.path.abspath(sys.argv[2])
print(os.path.relpath(path, home))
PY
}

chezmoi_relpath() {
    printf '%s' "$1" | sed -e 's@^\.@dot_@' -e 's@/\.@/dot_@g'
}

strip_quotes() {
    printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

replace_value_in_template() {
    key=$1
    value=$2
    template_ref=$3
    template_file=$4

    python3 - "$key" "$value" "$template_ref" "$template_file" <<'PY'
import re
import sys

key, value, template_ref, path = sys.argv[1:5]
with open(path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

key_re = re.escape(key)
new_lines = []
for line in lines:
    if re.match(r'^\s*["\']?' + key_re + r'["\']?\s*[:=]', line):
        new_lines.append(line.replace(value, template_ref, 1))
    else:
        new_lines.append(line)

with open(path, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)
PY
}

while IFS= read -r file; do
    [ -n "$file" ] || continue
    [ -f "$file" ] || continue

    FOUND_SENSITIVE=false
    MATCHED_PATTERN=
    OLD_IFS=$IFS
    IFS='
'
    for pattern in $SENSITIVE_PATTERNS; do
        if grep -qi "$pattern" "$file"; then
            FOUND_SENSITIVE=true
            MATCHED_PATTERN=$pattern
            break
        fi
    done
    IFS=$OLD_IFS

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
            ABS_FILE=$(python3 - "$file" <<'PY'
import os, sys
print(os.path.abspath(sys.argv[1]))
PY
)
            REL_PATH=$(relpath_from_home "$ABS_FILE") || exit 1
            CHEZMOI_REL_PATH=$(chezmoi_relpath "$REL_PATH")
            SOPS_FILE_NAME=${CHEZMOI_REL_PATH}.sops.yaml
            SOPS_SOURCE_PATH=$SOURCE_DIR/secrets/$SOPS_FILE_NAME

            mkdir -p "$(dirname "$SOPS_SOURCE_PATH")" || exit 1

            TMP_SECRETS_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.secrets.XXXXXX") || exit 1
            TMP_TEMPLATE_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.template.XXXXXX") || {
                rm -f "$TMP_SECRETS_FILE"
                exit 1
            }
            TMP_KEYS_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.keys.XXXXXX") || {
                rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE"
                exit 1
            }

            printf '%s\n' '{{- /* chezmoi:template */ -}}' > "$TMP_TEMPLATE_FILE"
            cat "$file" >> "$TMP_TEMPLATE_FILE"

            log 'Identifying and extracting secrets...'

            OLD_IFS=$IFS
            IFS='
'
            for pattern in $SENSITIVE_PATTERNS; do
                grep -Ei "$pattern" "$file" 2>/dev/null | while IFS= read -r line; do
                    [ -n "$line" ] || continue

                    case "$line" in
                        *=*)
                            key_raw=$(printf '%s\n' "$line" | cut -d'=' -f1)
                            value_raw=$(printf '%s\n' "$line" | cut -d'=' -f2-)
                            ;;
                        *:*)
                            key_raw=$(printf '%s\n' "$line" | cut -d':' -f1)
                            value_raw=$(printf '%s\n' "$line" | cut -d':' -f2-)
                            ;;
                        *)
                            continue
                            ;;
                    esac

                    key=$(strip_quotes "$key_raw")
                    value=$(strip_quotes "$(printf '%s' "$value_raw" | sed 's/,[[:space:]]*$//')")

                    [ -n "$key" ] || continue
                    [ -n "$value" ] || continue

                    if grep -Fxq "$key" "$TMP_KEYS_FILE" 2>/dev/null; then
                        continue
                    fi

                    printf '%s\n' "$key" >> "$TMP_KEYS_FILE"
                    printf '%s: %s\n' "$key" "$value" >> "$TMP_SECRETS_FILE"

                    template_ref="{{ (index ((secret \"-d\" (joinPath .chezmoi.sourceDir \"secrets/$SOPS_FILE_NAME\") | fromYaml).data | fromYaml) \"$key\") }}"
                    replace_value_in_template "$key" "$value" "$template_ref" "$TMP_TEMPLATE_FILE"
                done
            done
            IFS=$OLD_IFS

            if [ ! -s "$TMP_SECRETS_FILE" ]; then
                log 'No extractable secrets found; aborting.'
                rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE" "$TMP_KEYS_FILE"
                exit 1
            fi

            log "Creating sops-encrypted file at $SOPS_SOURCE_PATH..."
            if ! sops --encrypt --age "$AGE_KEY" "$TMP_SECRETS_FILE" > "$SOPS_SOURCE_PATH"; then
                rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE" "$TMP_KEYS_FILE"
                exit 1
            fi

            FINAL_TMPL_NAME=${file}.tmpl
            log "Adding template $FINAL_TMPL_NAME to chezmoi..."
            cp "$TMP_TEMPLATE_FILE" "$FINAL_TMPL_NAME" || {
                rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE" "$TMP_KEYS_FILE"
                exit 1
            }
            chezmoi add "$FINAL_TMPL_NAME" || {
                rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE" "$TMP_KEYS_FILE" "$FINAL_TMPL_NAME"
                exit 1
            }

            SOURCE_FILE=$(chezmoi source-path "$FINAL_TMPL_NAME" 2>/dev/null)
            case "$SOURCE_FILE" in
                *.literal)
                    NEW_SOURCE_FILE=${SOURCE_FILE%.literal}
                    mv "$SOURCE_FILE" "$NEW_SOURCE_FILE"
                    ;;
            esac

            log 'Cleaning up...'
            rm -f "$file" "$FINAL_TMPL_NAME" "$TMP_TEMPLATE_FILE" "$TMP_SECRETS_FILE" "$TMP_KEYS_FILE"

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
