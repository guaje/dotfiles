#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
SCRIPT="$ROOT/agent/scripts/refresh-artificial-analysis.sh"
fail() { echo "not ok - $1" >&2; exit 1; }
pass() { echo "ok - $1"; }
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pi-aa-refresh-test.XXXXXX")
cleanup() { rm -rf -- "$TMP_ROOT"; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/snapshots"; chmod 700 "$TMP_ROOT/snapshots"
cat > "$TMP_ROOT/settings.config.json" <<'JSON'
{"enabledModels":["test-provider/test-model"]}
JSON
cat > "$TMP_ROOT/models.json" <<'JSON'
{"providers":{"test-provider":{"models":[{"id":"test-model","name":"Synthetic"}]}}}
JSON
cat > "$TMP_ROOT/credentials.json" <<'JSON'
{"artificialAnalysis":{"apiKey":"test-aa-secret"}}
JSON
chmod 600 "$TMP_ROOT/credentials.json"
cat > "$TMP_ROOT/bin/curl" <<'SH'
#!/bin/sh
set -eu
[ "${1-}" = -q ] || { echo curlrc-not-disabled >&2; exit 1; }
config= output= writeout= url= header=
while [ "$#" -gt 0 ]; do
 case $1 in
  --config) shift; config=$1;;
  --output) shift; output=$1;;
  --write-out) shift; writeout=$1;;
  -H|--header|--oauth2-bearer) header=1; shift;;
  *) url=$1;;
 esac
 shift
done
if [ -n "$config" ]; then
 grep -q 'x-api-key: test-aa-secret' "$config" || { echo bad-api-auth >&2; exit 1; }
 if [ "${PI_AA_API_MODE:-full}" = reduced ]; then
  printf '%s\n' '{"intelligence_index_version":4.1,"pagination":{"has_more":false},"data":[{"id":"aa-synthetic-id","name":"Synthetic Reviewed Model","slug":"synthetic-reviewed-model","openrouter_api_id":"test-model","evaluations":{"artificial_analysis_intelligence_index":72,"artificial_analysis_coding_index":75,"artificial_analysis_agentic_index":70}}]}'
 else
  printf '%s\n' '{"intelligence_index_version":4.1,"pagination":{"has_more":false},"data":[{"id":"aa-synthetic-id","name":"Synthetic Reviewed Model","slug":"synthetic-reviewed-model","openrouter_api_id":"test-model","evaluations":{"artificial_analysis_intelligence_index":72,"artificial_analysis_coding_index":75,"artificial_analysis_agentic_index":70,"tau2_telecom":0.7,"tau_banking":0.8,"gdpval_aa_normalized":0.75,"hle":0.6,"gpqa_diamond":0.8,"critpt":0.7,"aa_lcr":0.9,"ifbench":0.85,"aa_omniscience_accuracy":0.65,"aa_omniscience_non_hallucination_rate":0.8}}]}'
 fi
 exit 0
fi
# A public request must be unauthenticated: the script must not pass API config/headers.
[ -z "$header" ] || { echo public-page-header >&2; exit 1; }
[ -n "$output" ] || { echo public-page-missing-output >&2; exit 1; }
case $url in https://artificialanalysis.ai/models/synthetic-reviewed-model) :;; *) echo unsafe-request:$url >&2; exit 1;; esac
name='Synthetic Reviewed Model'; id=aa-synthetic-id; slug=synthetic-reviewed-model
case ${PI_AA_FIXTURE_MODE:-success} in
 page-null) fields='"intelligenceIndex":null,"agenticIndex":null,"gdpvalNormalized":null,"tau2":null,"tauBanking":null,"lcr":null,"ifbench":null,"hle":null,"gpqa":null,"critpt":null,"omniscienceBreakdown":{"accuracy":null,"hallucinationRate":null}';;
 identity) id=wrong-id; fields='"intelligenceIndex":72';;
 conflict) fields='"intelligenceIndex":73';;
 malformed) printf '<title>Intelligence Index v4.1.1</title><script>self.__next_f.push([1,"{\\\"currentModel\\\":{"])</script>' > "$output"; printf '%s' "$url"; exit 0;;
 duplicate) fields='"intelligenceIndex":72';;
 *) fields='"intelligenceIndex":72,"agenticIndex":70,"gdpvalNormalized":0.75,"tau2":0.7,"tauBanking":0.8,"lcr":0.9,"ifbench":0.85,"hle":0.6,"gpqa":0.8,"critpt":0.7,"omniscienceBreakdown":{"accuracy":0.65,"hallucinationRate":0.2},"intelligenceIndexOutputTokensPerTask":{"output":321}';;
esac
record=$(printf '{"currentModel":{"id":"%s","slug":"%s","name":"%s",%s}}' "$id" "$slug" "$name" "$fields")
escaped=$(printf '%s' "$record" | sed 's/\\/\\\\/g; s/"/\\"/g')
printf '<title>Intelligence Index v4.1.1</title><script>{"currentModel":{"id":"html-decoy"}}</script><script>self.__next_f.push([1,"%s"])</script>' "$escaped" > "$output"
if [ "${PI_AA_FIXTURE_MODE:-success}" = duplicate ]; then
 duplicate_record=$(printf '{"currentModel":{"id":"%s","slug":"%s","name":"%s"}}' "$id" "$slug" "$name")
 duplicate_escaped=$(printf '%s' "$duplicate_record" | sed 's/\\/\\\\/g; s/"/\\"/g')
 printf '<script>self.__next_f.push([1,"%s"])</script>' "$duplicate_escaped" >> "$output"
fi
case ${PI_AA_FIXTURE_MODE:-success} in unsafe-url) printf '%s' 'https://evil.example/models/synthetic-reviewed-model';; *) printf '%s' "$url";; esac
SH
chmod +x "$TMP_ROOT/bin/curl"
ENV="PI_AA_SETTINGS_CONFIG=$TMP_ROOT/settings.config.json PI_AA_MODELS_CONFIG=$TMP_ROOT/models.json PI_CREDENTIALS_CONFIG=$TMP_ROOT/credentials.json PI_AA_SNAPSHOT_ROOT=$TMP_ROOT/snapshots PI_AA_PUBLIC_PAGE_DELAY=0"
run() { env $ENV PATH="$TMP_ROOT/bin:$PATH" "$@"; }

# Offline modes do not call curl and legacy snapshots fail closed.
mkdir -p "$TMP_ROOT/v2/models"; chmod 700 "$TMP_ROOT/v2" "$TMP_ROOT/v2/models"
printf '{"version":2}' > "$TMP_ROOT/v2/manifest.json"; chmod 600 "$TMP_ROOT/v2/manifest.json"
set +e; OUTPUT=$(PI_AA_SNAPSHOT_ROOT="$TMP_ROOT/v2" sh "$SCRIPT" --check 2>&1); STATUS=$?; set -e
[ "$STATUS" -ne 0 ] && printf %s "$OUTPUT" | grep -q 'unsupported manifest' || fail "v2 must fail closed"
MISSING=$(PI_AA_SETTINGS_CONFIG="$TMP_ROOT/settings.config.json" PI_AA_MODELS_CONFIG="$TMP_ROOT/models.json" PI_AA_SNAPSHOT_ROOT="$TMP_ROOT/v2" sh "$SCRIPT" --missing); printf '%s\n' "$MISSING" | grep -q test-provider || fail "missing should remain network-free"
pass "legacy and offline modes fail closed without network"

PI_AA_API_MODE=reduced run sh "$SCRIPT" --add test-provider/test-model --aa-model-id aa-synthetic-id >/dev/null
FILE=$(jq -r '.models[0].file' "$TMP_ROOT/snapshots/manifest.json")
jq -e '.version==4 and .scores.coding==75 and .scores.toolUse==77.5 and .toolUse.derivation=={version:"v1",rule:"tau3-banking+gdpval-aa",score:77.5} and .toolUse.components.tau2Telecom.benchmark.id=="tau2-telecom" and .scores.faithfulness==80 and .outputTokens=={} and .publicPage.url=="https://artificialanalysis.ai/models/synthetic-reviewed-model" and .publicPage.extractorVersion=="aa-current-model-rsc-v1"' "$TMP_ROOT/snapshots/models/$FILE" >/dev/null || fail "public page should supplement and preserve API coding"
run sh "$SCRIPT" --check >/dev/null || fail "v4 snapshot must validate offline"
[ "$(wc -l < "$TMP_ROOT/snapshots/manifest.json")" -gt 1 ] || fail "manifest JSON should be human-readable"
[ "$(wc -l < "$TMP_ROOT/snapshots/models/$FILE")" -gt 1 ] || fail "snapshot JSON should be human-readable"
jq -e 'all(.models[]; has("modelId") and (has("aaModelId") | not))' "$TMP_ROOT/snapshots/manifest.json" >/dev/null || fail "v4 manifest entries must use modelId"
jq -e 'has("modelId") and (has("aaModelId") | not)' "$TMP_ROOT/snapshots/models/$FILE" >/dev/null || fail "v4 snapshots must use modelId"
pass "authenticated API and unauthenticated public page supplement readable v4 provenance"

# Null page fields must not replace API values, nor make up values.
PI_AA_FIXTURE_MODE=page-null PI_AA_API_MODE=reduced run sh "$SCRIPT" --refresh test-provider/test-model >/dev/null
FILE=$(jq -r '.models[0].file' "$TMP_ROOT/snapshots/manifest.json")
jq -e '.scores.intelligence==72 and .scores.toolUse==null and .outputTokens=={}' "$TMP_ROOT/snapshots/models/$FILE" >/dev/null || fail "page nulls must preserve API values and unavailable output tokens"
pass "page null behavior preserves authority and unavailable Tool Use"

before=$(cat "$TMP_ROOT/snapshots/manifest.json")
for mode in identity malformed duplicate conflict unsafe-url; do
 set +e; OUTPUT=$(PI_AA_FIXTURE_MODE=$mode run sh "$SCRIPT" --refresh test-provider/test-model 2>&1); STATUS=$?; set -e
 [ "$STATUS" -ne 0 ] || fail "$mode must reject publication"
 [ "$(cat "$TMP_ROOT/snapshots/manifest.json")" = "$before" ] || fail "$mode failure must be atomic"
done
pass "identity, malformed/duplicate RSC, conflict, unsafe effective URL, and atomic failure reject"

grep -q 'curl -q' "$SCRIPT" || fail "curl must disable user curlrc"
grep -q -- '--config "\$CURL_CONFIG"' "$SCRIPT" || fail "API must use private curl config"
grep -q "Intentionally no --config" "$SCRIPT" || fail "public curl authentication boundary must be explicit"
grep -q -- "--proto '=https'" "$SCRIPT" || fail "public curl must pin HTTPS"
grep -q 'mv "\$next" "\$MANIFEST"' "$SCRIPT" || fail "manifest must publish last"
pass "bounded HTTPS public curl and publication conventions are explicit"

MAX_ROOT="$TMP_ROOT/max-snapshots"; mkdir -p "$MAX_ROOT"; chmod 700 "$MAX_ROOT"
env PI_AA_SETTINGS_CONFIG="$TMP_ROOT/settings.config.json" PI_AA_MODELS_CONFIG="$TMP_ROOT/models.json" PI_CREDENTIALS_CONFIG="$TMP_ROOT/credentials.json" PI_AA_SNAPSHOT_ROOT="$MAX_ROOT" PI_AA_PUBLIC_PAGE_DELAY=0 PATH="$TMP_ROOT/bin:$PATH" sh "$SCRIPT" --add test-provider/test-model --aa-model-id aa-synthetic-id --thinking-level max >/dev/null
jq -e '.models[0].thinkingLevel=="max"' "$MAX_ROOT/manifest.json" >/dev/null || fail "max thinking variant must be preserved"
pass "max is an exact Pi and benchmark thinking variant"

cat > "$TMP_ROOT/models-fixed.json" <<'JSON'
{"providers":{"test-provider":{"compat":{"supportsReasoningEffort":false},"models":[{"id":"test-model","name":"Synthetic Fixed"}]}}}
JSON
set +e
OUTPUT=$(env PI_AA_SETTINGS_CONFIG="$TMP_ROOT/settings.config.json" PI_AA_MODELS_CONFIG="$TMP_ROOT/models-fixed.json" PI_CREDENTIALS_CONFIG="$TMP_ROOT/credentials.json" PI_AA_SNAPSHOT_ROOT="$TMP_ROOT/fixed-snapshots" PI_AA_PUBLIC_PAGE_DELAY=0 PATH="$TMP_ROOT/bin:$PATH" sh "$SCRIPT" --add test-provider/test-model --aa-model-id aa-synthetic-id --thinking-level max 2>&1)
STATUS=$?
set -e
[ "$STATUS" -ne 0 ] && printf '%s' "$OUTPUT" | grep -q 'does not support selectable reasoning effort' || fail "fixed-effort providers must reject specific effort mappings"
pass "fixed-effort providers accept only generic benchmark mappings"

# --refresh-all may consume only strict v3 identity mappings and publishes v4 last.
MIGRATION_ROOT="$TMP_ROOT/migration"; mkdir -p "$MIGRATION_ROOT/models"; chmod 700 "$MIGRATION_ROOT" "$MIGRATION_ROOT/models"
printf '%s\n' '{"version":3,"models":[{"provider":"test-provider","model":"test-model","thinkingLevel":null,"aaModelId":"aa-synthetic-id","file":"legacy.json","capturedAt":1,"contentDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}' > "$MIGRATION_ROOT/manifest.json"; chmod 600 "$MIGRATION_ROOT/manifest.json"
env PI_AA_SETTINGS_CONFIG="$TMP_ROOT/settings.config.json" PI_AA_MODELS_CONFIG="$TMP_ROOT/models.json" PI_CREDENTIALS_CONFIG="$TMP_ROOT/credentials.json" PI_AA_SNAPSHOT_ROOT="$MIGRATION_ROOT" PI_AA_PUBLIC_PAGE_DELAY=0 PATH="$TMP_ROOT/bin:$PATH" sh "$SCRIPT" --refresh-all >/dev/null
jq -e '.version == 4 and (.models|length) == 1' "$MIGRATION_ROOT/manifest.json" >/dev/null || fail "v3 mapping-only migration must publish v4"
pass "strict v3 mapping-only migration publishes v4 atomically"
