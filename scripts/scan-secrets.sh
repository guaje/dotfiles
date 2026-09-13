#!/usr/bin/env bash

# Reusable secret scanner for CI/pre-commit.
# Uses the same awk detector as check-secrets.sh, but does not depend on chezmoi add hooks.

set -euo pipefail

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
SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
CHECK_SECRETS_AWK=$SCRIPT_DIR/check-secrets.awk
QUIET=false
USE_GIT_STAGED=false
FORMAT=text

usage() {
    cat <<'EOF'
Usage:
  scan-secrets.sh [--quiet] [--format text|json|sarif|gha] FILE...
  scan-secrets.sh [--quiet] [--format text|json|sarif|gha] --git-staged

Options:
  --git-staged              Scan staged files from git diff --cached
  --quiet                   Suppress per-file OK output in text mode
  --format text|json|sarif|gha
                            Output plain text, JSON summary, SARIF, or GitHub Actions annotations
  -h, --help                Show this help

Exit codes:
  0  No secrets detected
  1  Secrets detected or invalid input
EOF
}

collect_git_staged() {
    git diff --cached --name-only --diff-filter=ACMR -z
}

json_escape() {
    local value=$1 char escaped='' code hex
    local LC_ALL=C

    while [ -n "$value" ]; do
        char=${value%"${value#?}"}
        value=${value#?}
        case $char in
            \\) escaped+=$'\\\\' ;;
            '"') escaped+='\"' ;;
            $'\b') escaped+='\b' ;;
            $'\f') escaped+='\f' ;;
            $'\n') escaped+='\n' ;;
            $'\r') escaped+='\r' ;;
            $'\t') escaped+='\t' ;;
            [[:cntrl:]])
                printf -v code '%d' "'$char"
                printf -v hex '\u%04x' "$code"
                escaped+=$hex
                ;;
            *) escaped+=$char ;;
        esac
    done
    printf '%s' "$escaped"
}

append_json_finding() {
    file=$1
    label=$2
    line=$3

    if [ "$json_first" = true ]; then
        json_first=false
    else
        printf ',\n' >> "$RESULTS_TMP"
    fi
    printf '    {"file":"%s","label":"%s","line":%s}' \
        "$(json_escape "$file")" \
        "$(json_escape "$label")" \
        "${line:-0}" >> "$RESULTS_TMP"
}

append_sarif_rule() {
    label=$1
    if printf '%s\n' "$sarif_rules_seen" | grep -Fxq "$label"; then
        return 0
    fi
    sarif_rules_seen=${sarif_rules_seen}${sarif_rules_seen:+\n}$label
    if [ "$sarif_rules_first" = true ]; then
        sarif_rules_first=false
    else
        printf ',\n' >> "$RULES_TMP"
    fi
    printf '        {"id":"%s","name":"%s","shortDescription":{"text":"Sensitive information detector: %s"},"fullDescription":{"text":"Potential secret detected by scan-secrets.sh"},"properties":{"tags":["security","secrets"]}}' \
        "$(json_escape "$label")" \
        "$(json_escape "$label")" \
        "$(json_escape "$label")" >> "$RULES_TMP"
}

append_sarif_result() {
    file=$1
    label=$2
    line=$3

    append_sarif_rule "$label"
    if [ "$sarif_results_first" = true ]; then
        sarif_results_first=false
    else
        printf ',\n' >> "$RESULTS_TMP"
    fi
    printf '      {"ruleId":"%s","level":"error","message":{"text":"Potential secret detected: %s"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"%s"},"region":{"startLine":%s}}}]}' \
        "$(json_escape "$label")" \
        "$(json_escape "$label")" \
        "$(json_escape "$file")" \
        "${line:-1}" >> "$RESULTS_TMP"
}

gha_property_escape() {
    local value=$1
    value=${value//'%'/'%25'}
    value=${value//$'\r'/'%0D'}
    value=${value//$'\n'/'%0A'}
    value=${value//':'/'%3A'}
    value=${value//','/'%2C'}
    printf '%s' "$value"
}

gha_message_escape() {
    local value=$1
    value=${value//'%'/'%25'}
    value=${value//$'\r'/'%0D'}
    value=${value//$'\n'/'%0A'}
    printf '%s' "$value"
}

emit_gha_annotation() {
    local file=$1 label=$2 line=$3 message
    message="Potential secret detected ($label)"
    printf '::error file=%s,line=%s,title=%s::%s\n' \
        "$(gha_property_escape "$file")" \
        "$(gha_property_escape "${line:-1}")" \
        "$(gha_property_escape "$label")" \
        "$(gha_message_escape "$message")"
}

scan_file() {
    file=$1
    local scan_path=$file
    # Git paths are repository-relative and may begin with '-'. Prefix those
    # before passing them to awk so they cannot be interpreted as options.
    [[ $scan_path == -* ]] && scan_path=./$scan_path

    if [ ! -f "$scan_path" ]; then
        return 0
    fi

    files_scanned=$((files_scanned + 1))

    if result=$(SENSITIVE_PATTERNS="$SENSITIVE_PATTERNS" awk -v mode=detect -v output_format=tsv -f "$CHECK_SECRETS_AWK" "$scan_path" 2>/dev/null); then
        label=$(printf '%s\n' "$result" | awk -F '\t' 'NR==1 {print $1}')
        line=$(printf '%s\n' "$result" | awk -F '\t' 'NR==1 {print $2}')
        findings=$((findings + 1))
        case "$FORMAT" in
            json)
                append_json_finding "$file" "$label" "$line"
                ;;
            sarif)
                append_sarif_result "$file" "$label" "$line"
                ;;
            gha)
                emit_gha_annotation "$file" "$label" "$line"
                ;;
            *)
                printf 'secret detected: %s:%s: %s\n' "$file" "${line:-0}" "$label" >&2
                ;;
        esac
        return 1
    fi

    if [ "$FORMAT" = text ] && [ "$QUIET" != true ]; then
        printf 'ok: %s\n' "$file"
    fi
    return 0
}

RESULTS_TMP=$(mktemp "${TMPDIR:-/tmp}/scan-secrets.results.XXXXXX") || exit 1
RULES_TMP=$(mktemp "${TMPDIR:-/tmp}/scan-secrets.rules.XXXXXX") || {
    rm -f "$RESULTS_TMP"
    exit 1
}
# shellcheck disable=SC2329 # Invoked through the EXIT trap.
cleanup() {
    rm -f "$RESULTS_TMP" "$RULES_TMP"
}
trap cleanup EXIT HUP INT TERM

FILES=()
while [ $# -gt 0 ]; do
    case $1 in
        --git-staged)
            USE_GIT_STAGED=true
            ;;
        --quiet)
            QUIET=true
            ;;
        --format)
            shift
            [ $# -gt 0 ] || {
                printf 'Missing value for --format\n' >&2
                usage >&2
                exit 1
            }
            FORMAT=$1
            ;;
        --format=*)
            FORMAT=${1#--format=}
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        --)
            shift
            break
            ;;
        -*)
            printf 'Unknown option: %s\n' "$1" >&2
            usage >&2
            exit 1
            ;;
        *)
            FILES+=("$1")
            ;;
    esac
    shift
done

case $FORMAT in
    text|json|sarif|gha)
        ;;
    *)
        printf 'Invalid format: %s\n' "$FORMAT" >&2
        usage >&2
        exit 1
        ;;
esac

while [ $# -gt 0 ]; do
    FILES+=("$1")
    shift
done

if [ "$USE_GIT_STAGED" = true ]; then
    while IFS= read -r -d '' file; do
        FILES+=("$file")
    done < <(collect_git_staged)
fi

if [ ${#FILES[@]} -eq 0 ]; then
    printf 'No files to scan\n' >&2
    usage >&2
    exit 1
fi

files_scanned=0
findings=0
found=0
json_first=true
sarif_rules_first=true
sarif_results_first=true
sarif_rules_seen=

for file in "${FILES[@]}"; do
    if ! scan_file "$file"; then
        found=1
    fi
done

case "$FORMAT" in
    json)
        printf '{\n'
        printf '  "summary": {"files_scanned": %s, "findings": %s},\n' "$files_scanned" "$findings"
        printf '  "findings": [\n'
        cat "$RESULTS_TMP"
        if [ -s "$RESULTS_TMP" ]; then
            printf '\n'
        fi
        printf '  ]\n'
        printf '}\n'
        ;;
    sarif)
        printf '{\n'
        printf '  "%s": "https://json.schemastore.org/sarif-2.1.0.json",\n' "\$schema"
        printf '  "version": "2.1.0",\n'
        printf '  "runs": [\n'
        printf '    {\n'
        printf '      "tool": {\n'
        printf '        "driver": {\n'
        printf '          "name": "scan-secrets.sh",\n'
        printf '          "informationUri": "https://github.com/twpayne/chezmoi",\n'
        printf '          "rules": [\n'
        cat "$RULES_TMP"
        if [ -s "$RULES_TMP" ]; then
            printf '\n'
        fi
        printf '          ]\n'
        printf '        }\n'
        printf '      },\n'
        printf '      "results": [\n'
        cat "$RESULTS_TMP"
        if [ -s "$RESULTS_TMP" ]; then
            printf '\n'
        fi
        printf '      ]\n'
        printf '    }\n'
        printf '  ]\n'
        printf '}\n'
        ;;
esac

exit "$found"
