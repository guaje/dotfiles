#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONFIG_FILE="$SCRIPT_DIR/../models.json"
TYPE=
VALID_TYPES='chat embeddings imageGeneration reranking speechToText textToSpeech moderation'

usage() {
  cat <<EOF
Usage: $(basename "$0") [--type TYPE] [CONFIG_FILE]

Fetch each configured provider's /models endpoint and print models.json-style
provider entries. If --type is omitted, all discovered services are printed.

Options:
  --type TYPE    Only print models for one service type. TYPE must be one of:
                   chat
                   embeddings
                   imageGeneration
                   reranking
                   speechToText
                   textToSpeech
                   moderation
  --help, -h     Show this help message.

Arguments:
  CONFIG_FILE    Optional models.json path. Defaults to:
                   $SCRIPT_DIR/../models.json

Environment:
  API keys referenced by CONFIG_FILE may be resolved from environment variables
  or shell commands prefixed with !, matching pi models.json behavior.
EOF
}

is_valid_type() {
  type=$1
  for valid_type in $VALID_TYPES; do
    [ "$type" = "$valid_type" ] && return 0
  done
  return 1
}

while [ "$#" -gt 0 ]; do
  case $1 in
    --help|-h)
      usage
      exit 0
      ;;
    --type)
      shift
      if [ "$#" -eq 0 ]; then
        printf 'Missing value for --type\n' >&2
        usage >&2
        exit 1
      fi
      TYPE=$1
      if ! is_valid_type "$TYPE"; then
        printf 'Invalid --type: %s\n' "$TYPE" >&2
        usage >&2
        exit 1
      fi
      ;;
    --type=*)
      TYPE=${1#--type=}
      if ! is_valid_type "$TYPE"; then
        printf 'Invalid --type: %s\n' "$TYPE" >&2
        usage >&2
        exit 1
      fi
      ;;
    --*)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
    *)
      CONFIG_FILE=$1
      ;;
  esac
  shift
done

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
info_response_file=$(mktemp)
info_entries_file=$(mktemp)
info_file=$(mktemp)
model_ids_file=$(mktemp)
entries_file=$(mktemp)
cleanup() {
  rm -f "$providers_file" "$response_file" "$info_response_file" "$info_entries_file" "$info_file" "$model_ids_file" "$entries_file"
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

any_failed=0
while IFS='	' read -r provider_name base_url api api_key_expr compat_json; do
  [ -n "$provider_name" ] || continue

  api_key=$(resolve_value "$api_key_expr")

  if ! curl -fsS --max-time 10 -X GET "${base_url%/}/models" \
      -H "Authorization: Bearer $api_key" \
      -H 'accept: application/json' \
      > "$response_file"; then
    printf 'Failed to fetch models for provider: %s\n' "$provider_name" >&2
    any_failed=1
    continue
  fi

  : > "$info_entries_file"
  if ! jq -r '
    def models_array:
      if type == "object" and (.data | type) == "array" then .data
      elif type == "array" then .
      else []
      end;
    models_array | .[] | select(type == "object" and .id) | .id
  ' "$response_file" > "$model_ids_file"; then
    printf 'Failed to parse models response for provider: %s\n' "$provider_name" >&2
    any_failed=1
    continue
  fi

  info_base_url=${base_url%/}
  case $info_base_url in
    */v1)
      info_v1_url=$info_base_url
      info_root_url=${info_base_url%/v1}
      ;;
    *)
      info_v1_url=$info_base_url/v1
      info_root_url=$info_base_url
      ;;
  esac

  while IFS= read -r model_id; do
    [ -n "$model_id" ] || continue
    encoded_model=$(jq -nr --arg model "$model_id" '$model | @uri')

    if curl -fsS --max-time 5 -X GET "$info_v1_url/model/info?model=$encoded_model" \
        -H "Authorization: Bearer $api_key" \
        -H 'accept: application/json' \
        > "$info_response_file" 2>/dev/null; then
      jq --arg id "$model_id" '
        def info_object:
          if type == "object" then
            if (.data | type) == "array" then (.data | map(select(.model_name == $id)) | if length > 0 then .[0] else {} end)
            elif (.data | type) == "object" then .data
            else .
            end
          else {}
          end;
        {($id): info_object}
      ' "$info_response_file" >> "$info_entries_file" 2>/dev/null || true
    elif curl -fsS --max-time 5 -X GET "$info_root_url/model/info?model=$encoded_model" \
        -H "Authorization: Bearer $api_key" \
        -H 'accept: application/json' \
        > "$info_response_file" 2>/dev/null; then
      jq --arg id "$model_id" '
        def info_object:
          if type == "object" then
            if (.data | type) == "array" then (.data | map(select(.model_name == $id)) | if length > 0 then .[0] else {} end)
            elif (.data | type) == "object" then .data
            else .
            end
          else {}
          end;
        {($id): info_object}
      ' "$info_response_file" >> "$info_entries_file" 2>/dev/null || true
    fi
  done < "$model_ids_file"

  if [ -s "$info_entries_file" ]; then
    jq -s 'add // {}' "$info_entries_file" > "$info_file"
  else
    printf '{}\n' > "$info_file"
  fi

  jq \
    --arg provider "$provider_name" \
    --arg baseUrl "$base_url" \
    --arg api "$api" \
    --arg apiKey "$api_key_expr" \
    --arg type "$TYPE" \
    --argjson compat "$compat_json" \
    --slurpfile modelInfo "$info_file" \
    '
      def models_array:
        if type == "object" and (.data | type) == "array" then .data
        elif type == "array" then .
        else []
        end;

      def info_roots:
        ., (._info // {}), (._info.model_info // {}), (._info.litellm_model_info // {});

      def first_number(paths; default):
        first(paths[] as $path | info_roots | getpath($path) | select(type == "number")) // default;

      def first_array(paths):
        first(paths[] as $path | info_roots | getpath($path) | select(type == "array")) // null;

      def first_boolean(paths):
        first(paths[] as $path | info_roots | getpath($path) | select(type == "boolean")) // null;

      def first_object(paths):
        first(paths[] as $path | info_roots | getpath($path) | select(type == "object")) // null;

      def input_types:
        first_array([["input"], ["input_modalities"], ["modalities"]]) as $input
        | if $input != null then
            if ($input | index("image")) then $input else $input end
          elif first_boolean([["capabilities", "vision"], ["supports_vision"]]) == true then ["text", "image"]
          else null
          end;

      def supports_reasoning:
        first_boolean([
          ["reasoning"],
          ["supports_reasoning"],
          ["capabilities", "reasoning"],
          ["capabilities", "thinking"]
        ]);

      def service_type:
        if (.id | test("(?i)(embed|embedding)")) then "embeddings"
        elif (.id | test("(?i)(dall[-_ ]?e|gpt[-_ ]?image|image|imagen|flux|stable[-_ ]?diffusion|sdxl|midjourney)")) then "imageGeneration"
        elif (.id | test("(?i)(rerank|reranker)")) then "reranking"
        elif (.id | test("(?i)(whisper|transcrib|speech[-_ ]?to[-_ ]?text|stt)")) then "speechToText"
        elif (.id | test("(?i)(tts|text[-_ ]?to[-_ ]?speech|voice|audio)")) then "textToSpeech"
        elif (.id | test("(?i)(moderation|safety)")) then "moderation"
        else "chat"
        end;

      def provider_compat:
        if $compat != null then $compat
        elif $api == "openai-completions" then {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false
        }
        else null
        end;

      def optional_number(name; paths):
        first_number(paths; null) as $number
        | if $number == null then {} else {(name): $number} end;

      def common_model:
        {
          id,
          name: (.name // .display_name // .label // .id)
        };

      def optional_input:
        input_types as $input
        | if $input == null then {} else {input: $input} end;

      def optional_reasoning:
        supports_reasoning as $reasoning
        | if $reasoning == null then {} else {reasoning: $reasoning} end;

      def context_window:
        optional_number("contextWindow"; [
          ["contextWindow"],
          ["context_window"],
          ["context_length"],
          ["max_context_length"],
          ["max_input_tokens"],
          ["max_model_len"],
          ["max_sequence_length"],
          ["max_seq_len"],
          ["limits", "contextWindow"],
          ["limits", "context_window"],
          ["limits", "max_context_length"]
        ]);

      def max_tokens:
        optional_number("maxTokens"; [
          ["maxTokens"],
          ["max_tokens"],
          ["max_output_tokens"],
          ["max_completion_tokens"],
          ["limits", "maxTokens"],
          ["limits", "max_output_tokens"],
          ["limits", "max_completion_tokens"]
        ]);

      def optional_cost:
        first_object([["cost"]]) as $cost
        | if $cost != null then {cost: $cost}
          else
            first_object([["pricing"]]) as $pricing
            | {
                input: ($pricing.input // $pricing.prompt // $pricing.input_tokens // first_number([["input_cost_per_token"]]; null)),
                output: ($pricing.output // $pricing.completion // $pricing.output_tokens // first_number([["output_cost_per_token"]]; null)),
                cacheRead: ($pricing.cacheRead // $pricing.cache_read // first_number([["cache_read_input_token_cost"]]; null)),
                cacheWrite: ($pricing.cacheWrite // $pricing.cache_write // first_number([["cache_creation_input_token_cost"]]; null))
              }
              | with_entries(select(.value != null and .value != 0)) as $derived_cost
              | if ($derived_cost | length) == 0 then {} else {cost: $derived_cost} end
          end;

      def normalized_model:
        service_type as $service
        | if $service == "chat" then
            common_model
            + optional_reasoning
            + optional_input
            + context_window
            + max_tokens
            + optional_cost
          elif $service == "embeddings" then
            common_model
            + optional_input
            + context_window
            + optional_number("dimensions"; [["dimensions"], ["embedding_dimensions"], ["output_dimensions"]])
          elif $service == "imageGeneration" then
            common_model
            + optional_input
          elif $service == "reranking" then
            common_model
            + optional_input
            + context_window
          elif $service == "speechToText" then
            common_model
            + optional_input
          elif $service == "textToSpeech" then
            common_model
            + optional_input
          elif $service == "moderation" then
            common_model
            + optional_input
            + context_window
          else
            common_model
          end;

      models_array
      | map(select(type == "object" and .id))
      | sort_by(.id)
      | map(. + {_info: (($modelInfo[0][.id]) // {})} | . + {service: service_type, model: normalized_model})
      | map(select($type == "" or .service == $type)) as $discovered
      | ($discovered | map(.model)) as $models
      | ($discovered
          | group_by(.service)
          | map({key: .[0].service, value: map(.model)})
          | from_entries) as $services
      | {
          ($provider): (
            {
              baseUrl: $baseUrl,
              api: $api,
              apiKey: "<api-key>"
            }
            + (if provider_compat == null then {} else {compat: provider_compat} end)
            + {models: $models, services: $services}
          )
        }
    ' "$response_file" >> "$entries_file"
done < "$providers_file"

jq -s '{providers: add}' "$entries_file"
exit "$any_failed"
