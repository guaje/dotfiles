#!/bin/sh
# Skill discoverability test: asks pi to describe the image-generation skill's
# availability-check workflow and expected behaviour, then asserts key concepts
# are reflected in a structured JSON response.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SKILL_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
OUTPUT_FILE=$(mktemp)
trap 'rm -f "$OUTPUT_FILE"' EXIT HUP INT TERM

fail() {
  printf 'FAIL %s\n\nModel response:\n%s\n' "$1" "$(cat "$OUTPUT_FILE")" >&2
  exit 1
}

assert_contains() {
  pattern=$1
  message=$2
  grep -Eq "$pattern" "$OUTPUT_FILE" || fail "$message"
}

assert_not_contains() {
  pattern=$1
  message=$2
  if grep -Eq "$pattern" "$OUTPUT_FILE"; then
    fail "$message"
  fi
}

PROMPT='/skill:image-generation Use only the loaded image-generation skill. Do not call tools or access the web.
Return strict JSON only, with no markdown fences and no prose, matching this exact shape:
{
  "availabilityCheck": {
    "cacheFile": "<path to health cache file the skill reads>",
    "requiredService": "<service value checked in cache results>",
    "requiredStatus": "<status value required to use a model>",
    "missingCacheAction": "<what to tell the user when cache is missing or stale>",
    "noHealthyModelsAction": "<what to tell the user when no ok imageGeneration models exist>"
  },
  "configSources": {
    "providerConnections": "<file read for baseUrl and apiKey>",
    "imageModelList": "<file and field read for the list of configured image models>"
  },
  "endpoint": {
    "path": "<HTTP path appended to baseUrl>",
    "method": "<HTTP method>",
    "defaultResponseFormat": "<response_format value used by default>"
  },
  "noHealthyModels": {
    "shouldCallEndpoint": false,
    "userGuidance": "<command or action suggested to the user>"
  }
}'

if [ -n "${PI_IMAGE_GENERATION_MODEL:-}" ]; then
  pi -p \
    --no-tools \
    --no-extensions \
    --no-prompt-templates \
    --no-themes \
    --skill "$SKILL_DIR" \
    --model "$PI_IMAGE_GENERATION_MODEL" \
    "$PROMPT" > "$OUTPUT_FILE"
else
  pi -p \
    --no-tools \
    --no-extensions \
    --no-prompt-templates \
    --no-themes \
    --skill "$SKILL_DIR" \
    "$PROMPT" > "$OUTPUT_FILE"
fi

NOWS=$(tr -d '[:space:]' < "$OUTPUT_FILE")

# Response must be a bare JSON object.
[ "$(printf '%s' "$NOWS" | cut -c 1)" = "{" ] || fail 'response must start with a JSON object'
[ "$(printf '%s' "$NOWS" | sed 's/.*\(.\)$/\1/')" = "}" ] || fail 'response must end with a JSON object'
assert_not_contains '```' 'response must not contain markdown fences'

# Health cache file.
assert_contains '"cacheFile"' 'missing cacheFile field'
assert_contains 'model-health-cache\.json' 'cacheFile should reference model-health-cache.json'

# Required service and status filters.
assert_contains '"requiredService"' 'missing requiredService field'
assert_contains 'imageGeneration' 'requiredService should be imageGeneration'
assert_contains '"requiredStatus"' 'missing requiredStatus field'
assert_contains '"ok"' 'requiredStatus should be ok'

# Missing/stale cache guidance.
assert_contains '"missingCacheAction"' 'missing missingCacheAction field'
assert_contains '/model-health' 'missingCacheAction should suggest /model-health'

# No healthy models guidance.
assert_contains '"noHealthyModelsAction"' 'missing noHealthyModelsAction field'
assert_contains '/model-health' 'noHealthyModelsAction should suggest /model-health'

# Config sources.
assert_contains '"providerConnections"' 'missing providerConnections field'
assert_contains 'models\.json' 'providerConnections should reference models.json'
assert_contains '"imageModelList"' 'missing imageModelList field'
assert_contains 'imageGenerationProviders' 'imageModelList should reference imageGenerationProviders setting'

# Endpoint shape.
assert_contains '"path"' 'missing endpoint path field'
assert_contains '/images/generations' 'endpoint path should be /images/generations'
assert_contains '"method"' 'missing endpoint method field'
assert_contains '(POST|post)' 'endpoint method should be POST'
assert_contains '"defaultResponseFormat"' 'missing defaultResponseFormat field'
assert_contains 'b64_json' 'defaultResponseFormat should be b64_json'

# No healthy models → do not call endpoint.
assert_contains '"shouldCallEndpoint"[[:space:]]*:[[:space:]]*false' 'shouldCallEndpoint must be false when no healthy models exist'
assert_contains '"userGuidance"' 'missing userGuidance field'
assert_contains '/model-health' 'userGuidance should suggest /model-health'

printf 'PASS image-generation discoverability: skill covers health check, config sources, endpoint, and no-model guidance\n'
