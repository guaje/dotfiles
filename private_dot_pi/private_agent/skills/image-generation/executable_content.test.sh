#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SKILL_FILE=$SCRIPT_DIR/SKILL.md

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  pattern=$1
  message=$2
  grep -Eq "$pattern" "$SKILL_FILE" || fail "$message"
}

assert_not_contains() {
  pattern=$1
  message=$2
  if grep -Eq "$pattern" "$SKILL_FILE"; then
    fail "$message"
  fi
}

assert_contains 'Read `agent/model-health-cache\.json`' 'skill should require reading the model health cache before use'
assert_contains 'MODEL_HEALTH_CACHE_TTL_MS' 'skill should use the extension cache TTL when judging freshness'
assert_contains 'model-health-check\.ts' 'skill should reference model-health-check.ts for cache staleness'
assert_contains 'service` is `imageGeneration`|service == "imageGeneration"' 'skill should filter image generation health results'
assert_contains 'status` is `ok`|status == "ok"' 'skill should require ok health status'
assert_contains 'no image generation models are currently available|No image generation models are currently available' 'skill should fail clearly when no healthy image models are available'
assert_contains '/model-health' 'skill should tell the user how to refresh health results'
assert_contains 'imageGenerationProviders' 'skill should use configured image generation provider settings'
assert_contains 'agent/models\.json' 'skill should use models.json for provider connection details'
assert_contains '/images/generations' 'skill should document the image generation endpoint'
assert_contains 'response_format.*b64_json|b64_json.*response_format' 'skill should request base64 output by default'
assert_contains 'Never include the key' 'skill should protect API keys'
assert_contains 'Do not claim an image was generated unless' 'skill should require healthy cache and successful write before claiming success'
assert_contains 'IMAGE_MODEL' 'script should allow model override without hardcoded IDs'
assert_contains 'IMAGE_PROVIDER' 'script should allow provider override without hardcoded IDs'
assert_not_contains 'gpt-image-1|dall-e|imagen-[0-9]|flux|sdxl' 'skill should not hardcode real image model IDs'

printf 'PASS image-generation content covers health-aware image generation workflow\n'
