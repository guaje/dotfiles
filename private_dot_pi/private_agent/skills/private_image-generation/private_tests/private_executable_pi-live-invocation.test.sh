#!/bin/sh
# Live pi skill-invocation test for the image-generation skill.
# Runs `pi --no-session -p` with only this skill loaded and unrelated subsystems
# disabled, asks for strict JSON about the skill's mandatory health check, and
# asserts the reply is JSON with the expected keys and values.
#
# Requires a working pi binary and an explicitly opted-in model, because it calls a
# live model. CI has neither, so the test skips and exits 0 there:
#   PI_IMAGE_GENERATION_MODEL=test-provider/test-model sh agent/skills/image-generation/tests/pi-live-invocation.test.sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AGENT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$AGENT_DIR/.." && pwd)
SKILL_DIR=$AGENT_DIR/skills/image-generation

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'PASS %s\n' "$1"
}

skip() {
  printf 'SKIP %s\n' "$1"
  exit 0
}

# ---------------------------------------------------------------------------
# 1. Gate on a real pi binary and an explicitly configured model
# ---------------------------------------------------------------------------
command -v pi >/dev/null 2>&1 || skip 'pi binary is not installed'
[ -n "${PI_IMAGE_GENERATION_MODEL:-}" ] || skip 'PI_IMAGE_GENERATION_MODEL is not set'
[ -s "$SKILL_DIR/SKILL.md" ] || fail 'image-generation SKILL.md must exist'

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/image-gen-live-XXXXXX")
REPLY_FILE=$TMP_ROOT/reply.txt
# shellcheck disable=SC2064
trap 'rm -rf "$TMP_ROOT"' EXIT HUP INT TERM

# ---------------------------------------------------------------------------
# 2. Ask for a machine-checkable answer that only the skill text can provide
# ---------------------------------------------------------------------------
PROMPT='Using only the image-generation skill instructions, answer with one single line of JSON and nothing else. Keys: "healthCheckField" is the exact model-health-cache field name the skill checks for per-model freshness; "cacheFile" is the cache file path the skill reads; "unhealthyAction" must be exactly one of "refuse" or "generate" describing what the skill allows when the model is not healthy.'

TIMEOUT=''
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT='timeout 300'
fi

# shellcheck disable=SC2086
(
  cd "$REPO_ROOT" && \
  $TIMEOUT pi --no-session -p \
    --skill "$SKILL_DIR" \
    --model "$PI_IMAGE_GENERATION_MODEL" \
    --no-tools --no-extensions --no-prompt-templates --no-themes \
    "$PROMPT"
) >"$REPLY_FILE" 2>&1 || fail "pi invocation failed; output: $(cat "$REPLY_FILE")"

REPLY=$(cat "$REPLY_FILE")
[ -n "$REPLY" ] || fail 'pi returned an empty reply'

# ---------------------------------------------------------------------------
# 3. The reply must carry a JSON object
# ---------------------------------------------------------------------------
JSON=$(printf '%s\n' "$REPLY" | grep -Eo '\{.*\}' | head -n 1 || true)
[ -n "$JSON" ] || fail "reply is not JSON: $REPLY"

if command -v jq >/dev/null 2>&1; then
  printf '%s' "$JSON" | jq -e '
      (.healthCheckField | type == "string")
      and (.cacheFile | type == "string")
      and (.unhealthyAction | type == "string")' >/dev/null \
    || fail "reply JSON is missing required keys: $JSON"
  pass 'live pi reply parses as JSON with the expected keys'
else
  printf '%s' "$JSON" | grep -Eq '"healthCheckField"[[:space:]]*:' \
    || fail "reply JSON is missing healthCheckField: $JSON"
  printf '%s' "$JSON" | grep -Eq '"cacheFile"[[:space:]]*:' \
    || fail "reply JSON is missing cacheFile: $JSON"
  printf '%s' "$JSON" | grep -Eq '"unhealthyAction"[[:space:]]*:' \
    || fail "reply JSON is missing unhealthyAction: $JSON"
  pass 'live pi reply contains the expected JSON keys (jq unavailable, grep only)'
fi

# ---------------------------------------------------------------------------
# 4. The answer must reflect the skill's actual health-check policy
# ---------------------------------------------------------------------------
printf '%s' "$JSON" | grep -Eq 'checkedAt' \
  || fail "skill answer should name the per-model checkedAt field: $JSON"
pass 'live answer names the per-model health cache field'

printf '%s' "$JSON" | grep -Eq 'model-health-cache\.json' \
  || fail "skill answer should name model-health-cache.json: $JSON"
pass 'live answer names the model health cache file'

printf '%s' "$JSON" | grep -Eq '"unhealthyAction"[[:space:]]*:[[:space:]]*"refuse"' \
  || fail "an unhealthy image model must not be used for generation: $JSON"
pass 'live answer refuses generation when the image model is unhealthy'

printf 'PASS image-generation live pi invocation: skill loaded, strict JSON reply, health-check policy correct\n'
