#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONFIG_FILE=${1:-"$SCRIPT_DIR/../models.json"}

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

resolve_value() {
  value=$1

  case $value in
    !*)
      command=${value#!}
      # models.json supports shell-command values. Match pi's documented
      # behavior by evaluating the command and using stdout as the value.
      sh -c "$command"
      ;;
    *)
      if env_value=$(printenv "$value" 2>/dev/null); then
        printf '%s' "$env_value"
      else
        printf '%s' "$value"
      fi
      ;;
  esac
}

providers_file=$(mktemp)
response_file=$(mktemp)
entries_file=$(mktemp)
cleanup() {
  rm -f "$providers_file" "$response_file" "$entries_file"
}
trap cleanup EXIT INT HUP TERM

jq -r '
  .providers
  | to_entries[]
  | select(.value.baseUrl and .value.apiKey)
  | [
      .key,
      .value.baseUrl,
      (.value.api // "openai-completions"),
      .value.apiKey,
      (.value.compat // null | @json)
    ]
  | @tsv
' "$CONFIG_FILE" > "$providers_file"

while IFS='	' read -r provider_name base_url api api_key_expr compat_json; do
  [ -n "$provider_name" ] || continue

  api_key=$(resolve_value "$api_key_expr")

  if ! curl -fsS -X GET "${base_url%/}/models" \
      -H "Authorization: Bearer $api_key" \
      -H 'accept: application/json' \
      > "$response_file"; then
    printf 'Failed to fetch models for provider: %s\n' "$provider_name" >&2
    exit 1
  fi

  jq \
    --arg provider "$provider_name" \
    --arg baseUrl "$base_url" \
    --arg api "$api" \
    --arg apiKey "$api_key_expr" \
    --argjson compat "$compat_json" \
    '
      def models_array:
        if type == "object" and (.data | type) == "array" then .data
        elif type == "array" then .
        else []
        end;

      def first_number(paths; default):
        first(paths[] as $path | getpath($path) | select(type == "number")) // default;

      def input_types:
        if (.input | type) == "array" then .input
        elif (.input_modalities | type) == "array" then
          if (.input_modalities | index("image")) then ["text", "image"] else ["text"] end
        elif (.modalities | type) == "array" then
          if (.modalities | index("image")) then ["text", "image"] else ["text"] end
        elif (.capabilities.vision // .supports_vision // false) == true then ["text", "image"]
        else ["text"]
        end;

      def supports_reasoning:
        if (.reasoning | type) == "boolean" then .reasoning
        elif (.supports_reasoning | type) == "boolean" then .supports_reasoning
        elif (.capabilities.reasoning | type) == "boolean" then .capabilities.reasoning
        elif (.capabilities.thinking | type) == "boolean" then .capabilities.thinking
        elif (.id | test("(?i)(^o[134]($|-)|gpt-oss|deepseek-r1|qwq|qwen3|reasoning|thinking)")) then true
        else false
        end;

      def is_chat_model:
        if (env.PI_INCLUDE_NON_CHAT_MODELS // "") == "1" then true
        elif (.id | test("(?i)(embed|embedding|rerank|reranker|whisper|image|tts|stt|moderation)")) then false
        else true
        end;

      def provider_compat:
        if $compat != null then $compat
        elif $api == "openai-completions" then {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false
        }
        else null
        end;

      models_array
      | map(select(type == "object" and .id and is_chat_model))
      | sort_by(.id)
      | map({
          id,
          name: (.name // .display_name // .label // .id),
          reasoning: supports_reasoning,
          input: input_types,
          contextWindow: first_number([
            ["contextWindow"],
            ["context_window"],
            ["context_length"],
            ["max_context_length"],
            ["max_model_len"],
            ["max_sequence_length"],
            ["max_seq_len"],
            ["limits", "contextWindow"],
            ["limits", "context_window"],
            ["limits", "max_context_length"]
          ]; 128000),
          maxTokens: first_number([
            ["maxTokens"],
            ["max_tokens"],
            ["max_output_tokens"],
            ["max_completion_tokens"],
            ["limits", "maxTokens"],
            ["limits", "max_output_tokens"],
            ["limits", "max_completion_tokens"]
          ]; 16384),
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0
          }
        }) as $models
      | {
          ($provider): (
            {
              baseUrl: $baseUrl,
              api: $api,
              apiKey: $apiKey
            }
            + (if provider_compat == null then {} else {compat: provider_compat} end)
            + {models: $models}
          )
        }
    ' "$response_file" >> "$entries_file"
done < "$providers_file"

jq -s '{providers: add}' "$entries_file"
