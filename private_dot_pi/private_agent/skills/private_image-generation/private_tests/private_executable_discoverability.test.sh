#!/bin/sh
# Deterministic discoverability test for the image-generation skill guidance.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SKILL_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SKILL_FILE=$SKILL_DIR/SKILL.md

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  pattern=$1
  message=$2
  grep -Eq "$pattern" "$SKILL_FILE" || fail "$message"
}

[ -s "$SKILL_FILE" ] || fail 'SKILL.md must exist'

assert_contains 'model-health-cache\.json' 'skill should reference model-health-cache.json'
assert_contains 'service.*imageGeneration|imageGeneration.*service' 'skill should require imageGeneration service results'
assert_contains 'status.*ok|ok.*status' 'skill should require ok health status'
assert_contains '/model-health' 'skill should suggest /model-health for missing/stale/no healthy cache'
assert_contains 'settings\.config\.json' 'skill should reference settings.config.json'
assert_contains 'settings\.json' 'skill should reference settings.json'
assert_contains 'models\.json' 'skill should reference models.json for provider connections'
assert_contains 'imageGenerationProviders' 'skill should reference imageGenerationProviders'
assert_contains '/images/generations' 'skill should document the image generation endpoint path'
assert_contains 'POST' 'skill should document POST method'
assert_contains 'b64_json' 'skill should document b64_json response format'
assert_contains 'do not.*call.*endpoint|do \*\*not\*\* call' 'skill should forbid endpoint calls without healthy models'

printf 'PASS image-generation discoverability: skill covers health check, config sources, endpoint, and no-model guidance\n'
