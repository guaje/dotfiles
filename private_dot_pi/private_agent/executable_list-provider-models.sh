#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONFIG_FILE=${1:-"$SCRIPT_DIR/models.json"}

if [ ! -f "$CONFIG_FILE" ]; then
  printf 'Config file not found: %s\n' "$CONFIG_FILE" >&2
  exit 1
fi

for cmd in curl jq mktemp; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$cmd" >&2
    exit 1
  fi
done

providers_file=$(mktemp)
response_file=$(mktemp)
cleanup() {
  rm -f "$providers_file" "$response_file"
}
trap cleanup EXIT INT HUP TERM

jq -r '
  .providers
  | to_entries[]
  | select(.value.baseUrl and .value.apiKey)
  | [.key, .value.baseUrl, .value.apiKey]
  | @tsv
' "$CONFIG_FILE" > "$providers_file"

first_provider=1

while IFS='	' read -r provider_name base_url api_key; do
  [ -n "$provider_name" ] || continue

  if ! curl -fsS -X GET "${base_url%/}/models" \
      -H "Authorization: Bearer $api_key" \
      -H 'accept: application/json' \
      > "$response_file"; then
    printf 'Failed to fetch models for provider: %s\n' "$provider_name" >&2
    exit 1
  fi

  if [ "$first_provider" -eq 0 ]; then
    printf '\n'
  fi
  first_provider=0

  printf 'Provider: %s\n' "$provider_name"

  jq -r '
    if type == "object" then .data else . end
    | if type == "array" then .[] else empty end
    | select(type == "object" and .id)
    | "{\n  \"id\": \(.id | @json),\n  \"name\": \((.name // .id) | @json)\n}"
  ' "$response_file"
done < "$providers_file"
