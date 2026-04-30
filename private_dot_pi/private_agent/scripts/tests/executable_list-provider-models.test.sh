#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
SOURCE_SCRIPT="$ROOT_DIR/agent/scripts/list-provider-models.sh"

fail() {
  echo "not ok - $1" >&2
  exit 1
}

pass() {
  echo "ok - $1"
}

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pi-list-provider-models-test.XXXXXX")
cleanup() {
  rm -rf -- "$TMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

FIXTURE_AGENT="$TMP_ROOT/agent"
FIXTURE_SCRIPTS="$FIXTURE_AGENT/scripts"
mkdir -p "$FIXTURE_SCRIPTS" "$TMP_ROOT/bin"
cp "$SOURCE_SCRIPT" "$FIXTURE_SCRIPTS/list-provider-models.sh"
chmod +x "$FIXTURE_SCRIPTS/list-provider-models.sh"

cat > "$FIXTURE_AGENT/models.json" <<'JSON'
{
  "providers": {
    "local-openai": {
      "baseUrl": "http://local.test/v1",
      "api": "openai-completions",
      "apiKey": "TEST_LOCAL_API_KEY",
      "models": []
    },
    "custom-compat": {
      "baseUrl": "http://compat.test/v1",
      "api": "openai-completions",
      "apiKey": "literal-token",
      "compat": {
        "supportsDeveloperRole": true,
        "supportsReasoningEffort": true,
        "maxTokensField": "max_tokens"
      },
      "models": []
    }
  }
}
JSON

cat > "$TMP_ROOT/bin/curl" <<'SH'
#!/bin/sh
url=
header=
while [ "$#" -gt 0 ]; do
  case $1 in
    -H)
      shift
      header=$1
      ;;
    http*)
      url=$1
      ;;
  esac
  shift
done
case "$url" in
  http://local.test/v1/models)
    [ "$header" = "accept: application/json" ] || true
    cat <<'JSON'
{
  "data": [
    {
      "id": "qwen3-coder",
      "display_name": "Qwen3 Coder",
      "context_window": 262144,
      "max_output_tokens": 32768,
      "input_modalities": ["text", "image"]
    },
    {
      "id": "embedding-model",
      "name": "Embedding Model",
      "context_window": 8192
    },
    {
      "id": "gpt-image-1",
      "name": "GPT Image",
      "context_window": 0
    }
  ]
}
JSON
    ;;
  http://compat.test/v1/models)
    cat <<'JSON'
[
  {
    "id": "plain-chat",
    "label": "Plain Chat",
    "capabilities": { "reasoning": false },
    "max_context_length": 64000,
    "max_completion_tokens": 8000
  }
]
JSON
    ;;
  *)
    echo "unexpected url: $url" >&2
    exit 1
    ;;
esac
SH
chmod +x "$TMP_ROOT/bin/curl"

OUTPUT=$(cd "$TMP_ROOT" && TEST_LOCAL_API_KEY=env-token PATH="$TMP_ROOT/bin:$PATH" "$FIXTURE_SCRIPTS/list-provider-models.sh") || fail "list-provider-models.sh should generate models.json entries"
printf '%s\n' "$OUTPUT" | jq empty || fail "output should be valid JSON"

LOCAL_API=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].apiKey')
LOCAL_COMPAT_DEV=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].compat.supportsDeveloperRole')
LOCAL_COMPAT_REASONING=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].compat.supportsReasoningEffort')
LOCAL_COUNT=$(printf '%s\n' "$OUTPUT" | jq '.providers["local-openai"].models | length')
LOCAL_ID=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].models[0].id')
LOCAL_NAME=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].models[0].name')
LOCAL_REASONING=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].models[0].reasoning')
LOCAL_INPUT=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].models[0].input | join(",")')
LOCAL_CONTEXT=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].models[0].contextWindow')
LOCAL_MAX=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].models[0].maxTokens')
LOCAL_COST=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].models[0].cost | [.input, .output, .cacheRead, .cacheWrite] | join(",")')
LOCAL_SERVICE_CHAT=$(printf '%s\n' "$OUTPUT" | jq '.providers["local-openai"].services.chat | length')
LOCAL_SERVICE_EMBEDDINGS=$(printf '%s\n' "$OUTPUT" | jq '.providers["local-openai"].services.embeddings | length')
LOCAL_SERVICE_EMBEDDING_ID=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.embeddings[0].id')
LOCAL_SERVICE_IMAGE=$(printf '%s\n' "$OUTPUT" | jq '.providers["local-openai"].services.imageGeneration | length')
LOCAL_SERVICE_IMAGE_ID=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.imageGeneration[0].id')
[ "$LOCAL_API" = "TEST_LOCAL_API_KEY" ] || fail "output should preserve the apiKey expression for models.json"
[ "$LOCAL_COMPAT_DEV" = "false" ] || fail "OpenAI-compatible providers should default supportsDeveloperRole to false"
[ "$LOCAL_COMPAT_REASONING" = "false" ] || fail "OpenAI-compatible providers should default supportsReasoningEffort to false"
[ "$LOCAL_COUNT" = "1" ] || fail "non-chat models should be filtered by default"
[ "$LOCAL_ID" = "qwen3-coder" ] || fail "should include discovered chat model id"
[ "$LOCAL_NAME" = "Qwen3 Coder" ] || fail "should prefer display_name for model name"
[ "$LOCAL_REASONING" = "true" ] || fail "should infer Qwen3 reasoning support"
[ "$LOCAL_INPUT" = "text,image" ] || fail "should preserve discovered image input support"
[ "$LOCAL_CONTEXT" = "262144" ] || fail "should map context_window to contextWindow"
[ "$LOCAL_MAX" = "32768" ] || fail "should map max_output_tokens to maxTokens"
[ "$LOCAL_COST" = "0,0,0,0" ] || fail "self-hosted models should get zero cost entries"
[ "$LOCAL_SERVICE_CHAT" = "1" ] || fail "services should list discovered chat models"
[ "$LOCAL_SERVICE_EMBEDDINGS" = "1" ] || fail "services should list discovered embedding models"
[ "$LOCAL_SERVICE_EMBEDDING_ID" = "embedding-model" ] || fail "embedding service should include embedding model id"
[ "$LOCAL_SERVICE_IMAGE" = "1" ] || fail "services should list discovered image generation models"
[ "$LOCAL_SERVICE_IMAGE_ID" = "gpt-image-1" ] || fail "imageGeneration service should include image model id"
pass "list-provider-models.sh prints complete models.json entries and all discovered services"

CUSTOM_COMPAT=$(printf '%s\n' "$OUTPUT" | jq -c '.providers["custom-compat"].compat')
CUSTOM_MODEL=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["custom-compat"].models[0].name')
CUSTOM_CONTEXT=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["custom-compat"].models[0].contextWindow')
CUSTOM_MAX=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["custom-compat"].models[0].maxTokens')
[ "$CUSTOM_COMPAT" = '{"supportsDeveloperRole":true,"supportsReasoningEffort":true,"maxTokensField":"max_tokens"}' ] || fail "provider compat should be preserved when configured"
[ "$CUSTOM_MODEL" = "Plain Chat" ] || fail "should prefer label for model name when name is missing"
[ "$CUSTOM_CONTEXT" = "64000" ] || fail "should map max_context_length to contextWindow"
[ "$CUSTOM_MAX" = "8000" ] || fail "should map max_completion_tokens to maxTokens"
pass "list-provider-models.sh preserves configured compat and maps alternate limit fields"

INCLUDE_OUTPUT=$(cd "$TMP_ROOT" && PI_INCLUDE_NON_CHAT_MODELS=1 TEST_LOCAL_API_KEY=env-token PATH="$TMP_ROOT/bin:$PATH" "$FIXTURE_SCRIPTS/list-provider-models.sh") || fail "list-provider-models.sh should include all models when requested"
INCLUDE_COUNT=$(printf '%s\n' "$INCLUDE_OUTPUT" | jq '.providers["local-openai"].models | length')
[ "$INCLUDE_COUNT" = "3" ] || fail "PI_INCLUDE_NON_CHAT_MODELS=1 should include filtered models"
pass "list-provider-models.sh can include non-chat models on request"
