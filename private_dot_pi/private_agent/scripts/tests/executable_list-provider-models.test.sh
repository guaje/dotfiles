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
      "input_modalities": ["text", "image"],
      "reasoning": true
    },
    {
      "id": "embedding-model",
      "name": "Embedding Model",
      "context_window": 8192,
      "dimensions": 1536
    },
    {
      "id": "gpt-image-1",
      "name": "GPT Image",
      "context_window": 0
    },
    {
      "id": "rerank-model",
      "name": "Rerank Model",
      "context_window": 4096
    },
    {
      "id": "whisper-large-v3",
      "name": "Whisper Large"
    },
    {
      "id": "tts-model",
      "name": "TTS Model"
    },
    {
      "id": "moderation-model",
      "name": "Moderation Model",
      "context_window": 32768
    }
  ]
}
JSON
    ;;
  http://local.test/v1/model/info?model=qwen3-coder)
    cat <<'JSON'
{
  "model_info": {
    "input_cost_per_token": 0.000001,
    "output_cost_per_token": 0.000002
  }
}
JSON
    ;;
  http://local.test/v1/model/info?model=embedding-model)
    cat <<'JSON'
{
  "model_info": {
    "input": ["text"]
  }
}
JSON
    ;;
  http://local.test/v1/model/info?model=gpt-image-1)
    cat <<'JSON'
{
  "model_info": {
    "input": ["text"]
  }
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
LOCAL_ID=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.chat[0].id')
LOCAL_NAME=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.chat[0].name')
LOCAL_REASONING=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.chat[0].reasoning')
LOCAL_INPUT=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.chat[0].input | join(",")')
LOCAL_CONTEXT=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.chat[0].contextWindow')
LOCAL_MAX=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.chat[0].maxTokens')
LOCAL_COST=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.chat[0].cost | [.input, .output] | join(",")')
LOCAL_SERVICE_CHAT=$(printf '%s\n' "$OUTPUT" | jq '.providers["local-openai"].services.chat | length')
LOCAL_SERVICE_EMBEDDINGS=$(printf '%s\n' "$OUTPUT" | jq '.providers["local-openai"].services.embeddings | length')
LOCAL_SERVICE_EMBEDDING_ID=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.embeddings[0].id')
LOCAL_SERVICE_IMAGE=$(printf '%s\n' "$OUTPUT" | jq '.providers["local-openai"].services.imageGeneration | length')
LOCAL_SERVICE_IMAGE_ID=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.imageGeneration[0].id')
LOCAL_EMBEDDINGS_SHAPE=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.embeddings[0] | [has("input"), has("reasoning"), has("maxTokens"), has("cost"), .contextWindow, .dimensions] | join(",")')
LOCAL_IMAGE_SHAPE=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.imageGeneration[0] | [has("input"), has("reasoning"), has("contextWindow"), has("maxTokens"), has("cost"), (.output // [] | join("+"))] | join(",")')
LOCAL_RERANKING_SHAPE=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.reranking[0] | [has("input"), has("reasoning"), has("maxTokens"), has("cost"), .contextWindow] | join(",")')
LOCAL_SPEECH_TO_TEXT_SHAPE=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.speechToText[0] | [has("input"), has("reasoning"), has("contextWindow"), has("maxTokens"), has("cost"), (.output // [] | join("+"))] | join(",")')
LOCAL_TEXT_TO_SPEECH_SHAPE=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.textToSpeech[0] | [has("input"), has("reasoning"), has("contextWindow"), has("maxTokens"), has("cost"), (.output // [] | join("+"))] | join(",")')
LOCAL_MODERATION_SHAPE=$(printf '%s\n' "$OUTPUT" | jq -r '.providers["local-openai"].services.moderation[0] | [has("input"), has("reasoning"), has("maxTokens"), has("cost"), .contextWindow] | join(",")')
[ "$LOCAL_API" = "<api-key>" ] || fail "output should redact apiKey values"
[ "$LOCAL_COMPAT_DEV" = "false" ] || fail "OpenAI-compatible providers should default supportsDeveloperRole to false"
[ "$LOCAL_COMPAT_REASONING" = "false" ] || fail "OpenAI-compatible providers should default supportsReasoningEffort to false"
[ "$LOCAL_COUNT" = "7" ] || fail "all service models should be included by default"
[ "$LOCAL_ID" = "qwen3-coder" ] || fail "should include discovered chat model id"
[ "$LOCAL_NAME" = "Qwen3 Coder" ] || fail "should prefer display_name for model name"
[ "$LOCAL_REASONING" = "true" ] || fail "should infer Qwen3 reasoning support"
[ "$LOCAL_INPUT" = "text,image" ] || fail "should preserve discovered image input support"
[ "$LOCAL_CONTEXT" = "262144" ] || fail "should map context_window to contextWindow"
[ "$LOCAL_MAX" = "32768" ] || fail "should map max_output_tokens to maxTokens"
[ "$LOCAL_COST" = "0.000001,0.000002" ] || fail "cost should be included when returned by the model info endpoint"
[ "$LOCAL_SERVICE_CHAT" = "1" ] || fail "services should list discovered chat models"
[ "$LOCAL_SERVICE_EMBEDDINGS" = "1" ] || fail "services should list discovered embedding models"
[ "$LOCAL_SERVICE_EMBEDDING_ID" = "embedding-model" ] || fail "embedding service should include embedding model id"
[ "$LOCAL_SERVICE_IMAGE" = "1" ] || fail "services should list discovered image generation models"
[ "$LOCAL_SERVICE_IMAGE_ID" = "gpt-image-1" ] || fail "imageGeneration service should include image model id"
[ "$LOCAL_EMBEDDINGS_SHAPE" = "true,false,false,false,8192,1536" ] || fail "embeddings models should include endpoint-provided optional properties"
[ "$LOCAL_IMAGE_SHAPE" = "true,false,false,false,false," ] || fail "image generation models should not include chat-only or invented output properties"
[ "$LOCAL_RERANKING_SHAPE" = "false,false,false,false,4096" ] || fail "reranking models should not include chat-only or invented input properties"
[ "$LOCAL_SPEECH_TO_TEXT_SHAPE" = "false,false,false,false,false," ] || fail "speech-to-text models should not include chat-only or invented input/output properties"
[ "$LOCAL_TEXT_TO_SPEECH_SHAPE" = "false,false,false,false,false," ] || fail "text-to-speech models should not include chat-only or invented input/output properties"
[ "$LOCAL_MODERATION_SHAPE" = "false,false,false,false,32768" ] || fail "moderation models should not include chat-only or invented input properties"
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

CHAT_OUTPUT=$(cd "$TMP_ROOT" && TEST_LOCAL_API_KEY=env-token PATH="$TMP_ROOT/bin:$PATH" "$FIXTURE_SCRIPTS/list-provider-models.sh" --type chat) || fail "list-provider-models.sh should filter chat service models"
CHAT_COUNT=$(printf '%s\n' "$CHAT_OUTPUT" | jq '.providers["local-openai"].models | length')
CHAT_ID=$(printf '%s\n' "$CHAT_OUTPUT" | jq -r '.providers["local-openai"].models[0].id')
CHAT_SERVICES=$(printf '%s\n' "$CHAT_OUTPUT" | jq -r '.providers["local-openai"].services | keys | join(",")')
[ "$CHAT_COUNT" = "1" ] || fail "--type chat should include only chat models"
[ "$CHAT_ID" = "qwen3-coder" ] || fail "--type chat should include the chat model"
[ "$CHAT_SERVICES" = "chat" ] || fail "--type chat should include only the chat service"
pass "list-provider-models.sh can filter chat models by service type"

EMBEDDINGS_OUTPUT=$(cd "$TMP_ROOT" && TEST_LOCAL_API_KEY=env-token PATH="$TMP_ROOT/bin:$PATH" "$FIXTURE_SCRIPTS/list-provider-models.sh" --type=embeddings) || fail "list-provider-models.sh should filter embedding service models"
EMBEDDINGS_COUNT=$(printf '%s\n' "$EMBEDDINGS_OUTPUT" | jq '.providers["local-openai"].models | length')
EMBEDDINGS_ID=$(printf '%s\n' "$EMBEDDINGS_OUTPUT" | jq -r '.providers["local-openai"].models[0].id')
EMBEDDINGS_SERVICES=$(printf '%s\n' "$EMBEDDINGS_OUTPUT" | jq -r '.providers["local-openai"].services | keys | join(",")')
[ "$EMBEDDINGS_COUNT" = "1" ] || fail "--type embeddings should include only embedding models"
[ "$EMBEDDINGS_ID" = "embedding-model" ] || fail "--type embeddings should include the embedding model"
[ "$EMBEDDINGS_SERVICES" = "embeddings" ] || fail "--type embeddings should include only the embeddings service"
pass "list-provider-models.sh can filter embedding models by service type"

HELP_OUTPUT=$("$FIXTURE_SCRIPTS/list-provider-models.sh" --help) || fail "--help should exit successfully"
printf '%s\n' "$HELP_OUTPUT" | grep -q -- '--type TYPE' || fail "--help should document --type"
printf '%s\n' "$HELP_OUTPUT" | grep -q 'imageGeneration' || fail "--help should list accepted --type values"
pass "list-provider-models.sh documents usage with --help"

if (cd "$TMP_ROOT" && TEST_LOCAL_API_KEY=env-token PATH="$TMP_ROOT/bin:$PATH" "$FIXTURE_SCRIPTS/list-provider-models.sh" --type invalid >/dev/null 2>&1); then
  fail "invalid --type should fail"
fi
pass "list-provider-models.sh rejects invalid service types"
