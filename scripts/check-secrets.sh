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

relpath() {
    python3 - "$1" "$2" <<'PY'
import os, sys
path = os.path.abspath(sys.argv[1])
base = os.path.abspath(sys.argv[2])
print(os.path.relpath(path, base))
PY
}

relpath_from_home() {
    relpath "$1" "$HOME"
}

chezmoi_relpath() {
    printf '%s' "$1" | sed -e 's@^\.@dot_@' -e 's@/\.@/dot_@g'
}

strip_quotes() {
    printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

matches_sensitive_file() {
    input_file=$1

    SENSITIVE_PATTERNS="$SENSITIVE_PATTERNS" python3 - "$input_file" <<'PY'
import os
import re
import sys

input_file = sys.argv[1]
patterns = [p.strip() for p in os.environ.get("SENSITIVE_PATTERNS", "").splitlines() if p.strip()]

with open(input_file, "r", encoding="utf-8") as f:
    content = f.read()

assignment_re = re.compile(r'["\']?(?P<key>[A-Za-z0-9_.-]+)["\']?\s*[:=]', re.MULTILINE)


def normalize(value):
    return re.sub(r'[^A-Za-z0-9]+', '', value).upper()

normalized_patterns = [(pattern, normalize(pattern)) for pattern in patterns]

for match in assignment_re.finditer(content):
    key = match.group("key")
    normalized_key = normalize(key)
    for pattern, normalized_pattern in normalized_patterns:
        if normalized_pattern and normalized_pattern in normalized_key:
            print(pattern)
            sys.exit(0)

normalized_content = normalize(content)
for pattern, normalized_pattern in normalized_patterns:
    if normalized_pattern and normalized_pattern in normalized_content:
        print(pattern)
        sys.exit(0)

sys.exit(1)
PY
}

extract_sensitive_values() {
    input_file=$1
    template_file=$2
    secrets_file=$3
    sops_file_name=$4

    SENSITIVE_PATTERNS="$SENSITIVE_PATTERNS" python3 - "$input_file" "$template_file" "$secrets_file" "$sops_file_name" <<'PY'
import collections
import os
import re
import sys

input_file, template_file, secrets_file, sops_file_name = sys.argv[1:5]
patterns = [p.strip() for p in os.environ.get("SENSITIVE_PATTERNS", "").splitlines() if p.strip()]

with open(input_file, "r", encoding="utf-8") as f:
    content = f.read()

assignment_re = re.compile(
    r'(?P<prefix>["\']?(?P<key>[A-Za-z0-9_.-]+)["\']?\s*[:=]\s*)(?P<value>"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[^,\n\r}\]]+)',
    re.MULTILINE,
)


def normalize(value):
    return re.sub(r'[^A-Za-z0-9]+', '', value).upper()

normalized_patterns = [normalize(pattern) for pattern in patterns if pattern.strip()]

occurrences = []
for match in assignment_re.finditer(content):
    key = match.group("key").strip()
    normalized_key = normalize(key)
    if not any(pattern and pattern in normalized_key for pattern in normalized_patterns):
        continue

    raw_value = match.group("value")
    trimmed_value = raw_value.strip()
    if not trimmed_value:
        continue

    if len(trimmed_value) >= 2 and trimmed_value[0] == trimmed_value[-1] and trimmed_value[0] in ('"', "'"):
        secret_value = trimmed_value[1:-1]
        replace_start = match.start("value") + raw_value.find(trimmed_value) + 1
        replace_end = replace_start + len(secret_value)
    else:
        secret_value = trimmed_value
        replace_start = match.start("value") + raw_value.find(trimmed_value)
        replace_end = replace_start + len(trimmed_value)

    occurrences.append({
        "key": key,
        "value": secret_value,
        "replace_start": replace_start,
        "replace_end": replace_end,
    })

if not occurrences:
    sys.exit(2)

counts = collections.Counter(item["key"] for item in occurrences)
seen = collections.Counter()
secrets = []
for item in occurrences:
    seen[item["key"]] += 1
    if counts[item["key"]] == 1:
        secret_name = item["key"]
    else:
        secret_name = f'{item["key"]}__{seen[item["key"]]}'
    item["secret_name"] = secret_name
    secrets.append((secret_name, item["value"]))

result = content
for item in reversed(occurrences):
    template_ref = '{{ (index ((secret "-d" (joinPath .chezmoi.sourceDir "secrets/' + sops_file_name + '") | fromYaml).data | fromYaml) "' + item["secret_name"] + '") }}'
    result = result[:item["replace_start"]] + template_ref + result[item["replace_end"]:]

with open(template_file, "w", encoding="utf-8") as f:
    f.write('{{- /* chezmoi:template */ -}}\n')
    f.write(result)

with open(secrets_file, "w", encoding="utf-8") as f:
    for key, value in secrets:
        escaped = value.replace("'", "''")
        f.write(f"{key}: '{escaped}'\n")
PY
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
            ABS_FILE=$(python3 - "$file" <<'PY'
import os, sys
print(os.path.abspath(sys.argv[1]))
PY
)

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
            TMP_KEYS_FILE=$(mktemp "${TMPDIR:-/tmp}/check-secrets.keys.XXXXXX") || {
                rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE"
                exit 1
            }

            log 'Identifying and extracting secrets...'

            if ! extract_sensitive_values "$file" "$TMP_TEMPLATE_FILE" "$TMP_SECRETS_FILE" "$SOPS_FILE_NAME"; then
                status=$?
                if [ "$status" -ne 2 ]; then
                    rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE" "$TMP_KEYS_FILE" "$SOURCE_FILE"
                    exit 1
                fi
            fi

            if [ ! -s "$TMP_SECRETS_FILE" ]; then
                log 'No extractable secrets found; aborting.'
                rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE" "$TMP_KEYS_FILE" "$SOURCE_FILE"
                exit 1
            fi

            log "Creating sops-encrypted file at $SOPS_SOURCE_PATH..."
            if ! sops --encrypt --age "$AGE_KEY" "$TMP_SECRETS_FILE" > "$SOPS_SOURCE_PATH"; then
                rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE" "$TMP_KEYS_FILE" "$SOURCE_FILE"
                exit 1
            fi

            log "Replacing $SOURCE_FILE with template content..."
            cp "$TMP_TEMPLATE_FILE" "$SOURCE_FILE" || {
                rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE" "$TMP_KEYS_FILE" "$SOURCE_FILE"
                exit 1
            }

            FINAL_SOURCE_FILE=${SOURCE_FILE_BASE}.tmpl
            if [ "$SOURCE_FILE" != "$FINAL_SOURCE_FILE" ]; then
                mv "$SOURCE_FILE" "$FINAL_SOURCE_FILE" || {
                    rm -f "$TMP_SECRETS_FILE" "$TMP_TEMPLATE_FILE" "$TMP_KEYS_FILE" "$SOURCE_FILE"
                    exit 1
                }
            fi

            log 'Cleaning up...'
            rm -f "$file" "$TMP_TEMPLATE_FILE" "$TMP_SECRETS_FILE" "$TMP_KEYS_FILE"

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
