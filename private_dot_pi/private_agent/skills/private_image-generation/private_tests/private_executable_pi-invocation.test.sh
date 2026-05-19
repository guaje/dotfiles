#!/bin/sh
# End-to-end test for the image-generation skill's generate-image script.
# Stubs the image generation HTTP endpoint with a minimal Node HTTP server,
# builds temporary fixture files (models.json, settings.config.json,
# model-health-cache.json, model-health-check.ts), runs the script, then asserts
# a PNG was written and the JSON output matches expectations.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SKILL_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SCRIPT_FILE=$SKILL_DIR/scripts/generate-image.mjs

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'PASS %s\n' "$1"
}

# ---------------------------------------------------------------------------
# 1. Locate the generation script
# ---------------------------------------------------------------------------
TMP_BASE=${TMPDIR:-/tmp}
[ -s "$SCRIPT_FILE" ] || fail 'generate-image.mjs must exist'

# ---------------------------------------------------------------------------
# 2. Minimal 1x1 PNG in base64
# ---------------------------------------------------------------------------
STUB_PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAACAAHiIbwzAAAAAElFTkSuQmCC"

# ---------------------------------------------------------------------------
# 3. Build fixture directory
# ---------------------------------------------------------------------------
TMP_ROOT=$(mktemp -d "$TMP_BASE/image-gen-test-XXXXXX")
AGENT_DIR=$TMP_ROOT/agent
EXTENSIONS_DIR=$AGENT_DIR/extensions
OUT_DIR=$TMP_ROOT/generated-images
mkdir -p "$EXTENSIONS_DIR"

# Fake API key value used in all fixture files.
FAKE_API_KEY="test-api-key-fixture"

# ---------------------------------------------------------------------------
# 4. Start a stub HTTP server (Node) that handles /models and /images/generations
# ---------------------------------------------------------------------------
SERVER_SCRIPT=$(mktemp "$TMP_BASE/image-gen-server-XXXXXX.mjs")
# shellcheck disable=SC2064
trap 'rm -f "$SERVER_SCRIPT"; rm -rf "$TMP_ROOT"' EXIT HUP INT TERM

cat > "$SERVER_SCRIPT" <<SERVEREOF
import http from 'node:http';
import crypto from 'node:crypto';

const PNG_B64 = '${STUB_PNG_B64}';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Auth guard - must have Bearer header.
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing auth' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-image-model', object: 'model' }] }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/images/generations') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      // Write the received request to stdout so the test can inspect it.
      process.stdout.write(JSON.stringify({ received: parsed }) + '\n');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: PNG_B64 }],
      }));
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', path: req.url }));
});

server.listen(0, '127.0.0.1', () => {
  // Print the port for the test to read.
  process.stdout.write('PORT=' + server.address().port + '\n');
});
SERVEREOF

# Start the server and capture its port.
SERVER_OUT=$(mktemp)
# shellcheck disable=SC2064
trap 'rm -f "$SERVER_SCRIPT" "$SERVER_OUT"; rm -rf "$TMP_ROOT"' EXIT HUP INT TERM

node "$SERVER_SCRIPT" > "$SERVER_OUT" &
SERVER_PID=$!
# shellcheck disable=SC2064
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -f "$SERVER_SCRIPT" "$SERVER_OUT"; rm -rf "$TMP_ROOT"' EXIT HUP INT TERM

# Wait for PORT= line.
PORT=""
for i in $(seq 1 40); do
  PORT=$(grep -m1 '^PORT=' "$SERVER_OUT" 2>/dev/null | cut -d= -f2 || true)
  [ -n "$PORT" ] && break
  sleep 0.1
done
[ -n "$PORT" ] || fail 'stub HTTP server did not start in time'

BASE_URL="http://127.0.0.1:${PORT}/v1"

# ---------------------------------------------------------------------------
# 5. Write fixture files
# ---------------------------------------------------------------------------

# model-health-cache.json: fresh, has one healthy imageGeneration model.
cat > "$AGENT_DIR/model-health-cache.json" <<CACHEEOF
{
  "checkedAt": $(node -e 'process.stdout.write(String(Date.now()))'),
  "results": [
    {
      "id": "test-provider/test-image-model",
      "status": "ok",
      "name": "test-image-model",
      "service": "imageGeneration"
    }
  ]
}
CACHEEOF

# model-health-check.ts: stub that exports only the TTL constant.
cat > "$EXTENSIONS_DIR/model-health-check.ts" <<EXTEOF
export const MODEL_HEALTH_CACHE_TTL_MS = 15 * 60 * 1000;
EXTEOF

# models.json: test provider with stub base URL.
cat > "$AGENT_DIR/models.json" <<MODELSEOF
{
  "providers": {
    "test-provider": {
      "baseUrl": "${BASE_URL}",
      "api": "openai-completions",
      "apiKey": "${FAKE_API_KEY}",
      "models": []
    }
  }
}
MODELSEOF

# settings.config.json: imageGenerationProviders pointing to test model.
cat > "$AGENT_DIR/settings.config.json" <<SETTINGSEOF
{
  "imageGenerationProviders": {
    "test-provider": {
      "models": [
        { "id": "test-image-model", "name": "test-image-model" }
      ]
    }
  }
}
SETTINGSEOF

# ---------------------------------------------------------------------------
# 6. Run the extracted script in the fixture directory
# ---------------------------------------------------------------------------
SCRIPT_OUTPUT=$(
  cd "$TMP_ROOT" && \
  IMAGE_PROMPT="a tiny red square" \
  IMAGE_SIZE="256x256" \
  IMAGE_OUT_DIR="$OUT_DIR" \
  IMAGE_AGENT_DIR="$AGENT_DIR" \
  node "$SCRIPT_FILE" 2>&1
)

# ---------------------------------------------------------------------------
# 7. Assert JSON output shape
# ---------------------------------------------------------------------------
printf '%s\n' "$SCRIPT_OUTPUT" | grep -q '"path"' \
  || fail "script output missing path field. Output: $SCRIPT_OUTPUT"

printf '%s\n' "$SCRIPT_OUTPUT" | grep -q '"provider"[[:space:]]*:[[:space:]]*"test-provider"' \
  || fail "script output provider mismatch. Output: $SCRIPT_OUTPUT"

printf '%s\n' "$SCRIPT_OUTPUT" | grep -q '"model"[[:space:]]*:[[:space:]]*"test-image-model"' \
  || fail "script output model mismatch. Output: $SCRIPT_OUTPUT"

printf '%s\n' "$SCRIPT_OUTPUT" | grep -q '"size"[[:space:]]*:[[:space:]]*"256x256"' \
  || fail "script output size mismatch. Output: $SCRIPT_OUTPUT"

pass 'script output JSON has correct provider, model, and size fields'

# ---------------------------------------------------------------------------
# 8. Assert the PNG was actually written to disk
# ---------------------------------------------------------------------------
OUT_PATH=$(printf '%s\n' "$SCRIPT_OUTPUT" | grep '"path"' | sed 's/.*"path"[[:space:]]*:[[:space:]]*"//;s/".*//')
[ -n "$OUT_PATH" ] || fail "could not parse output path from: $SCRIPT_OUTPUT"
[ -f "$OUT_PATH" ] || fail "expected PNG file not found at: $OUT_PATH"

PNG_SIZE=$(wc -c < "$OUT_PATH" | tr -d ' ')
[ "$PNG_SIZE" -gt 0 ] || fail 'output PNG file is empty'

# Verify PNG magic bytes.
PNG_MAGIC=$(od -A n -N 4 -t x1 "$OUT_PATH" | tr -d ' \n')
[ "$PNG_MAGIC" = "89504e47" ] || fail "output file does not have PNG magic bytes (got: $PNG_MAGIC)"

pass 'PNG written to disk with correct magic bytes'

# ---------------------------------------------------------------------------
# 9. Assert the filename slug is derived from the prompt
# ---------------------------------------------------------------------------
FILENAME=$(basename "$OUT_PATH")
printf '%s\n' "$FILENAME" | grep -q 'a-tiny-red-square' \
  || fail "filename should contain slug from prompt (got: $FILENAME)"

pass 'output filename slug derived from prompt'

# ---------------------------------------------------------------------------
# 10. Test: missing cache → error
# ---------------------------------------------------------------------------
rm "$AGENT_DIR/model-health-cache.json"
MISSING_CACHE_OUTPUT=$(
  cd "$TMP_ROOT" && \
  IMAGE_PROMPT="test" IMAGE_OUT_DIR="$OUT_DIR" \
  IMAGE_AGENT_DIR="$AGENT_DIR" \
  node "$SCRIPT_FILE" 2>&1 || true
)
printf '%s\n' "$MISSING_CACHE_OUTPUT" | grep -qi 'cache\|model-health' \
  || fail "missing cache should produce an error mentioning the cache or /model-health. Got: $MISSING_CACHE_OUTPUT"
pass 'missing cache produces actionable error'

# ---------------------------------------------------------------------------
# 11. Test: stale cache → error
# ---------------------------------------------------------------------------
STALE_TS=$(node -e 'process.stdout.write(String(Date.now() - 20 * 60 * 1000))')
cat > "$AGENT_DIR/model-health-cache.json" <<STALEEOF
{
  "checkedAt": ${STALE_TS},
  "results": [
    { "id": "test-provider/test-image-model", "status": "ok", "service": "imageGeneration", "name": "test-image-model" }
  ]
}
STALEEOF

STALE_OUTPUT=$(
  cd "$TMP_ROOT" && \
  IMAGE_PROMPT="test" IMAGE_OUT_DIR="$OUT_DIR" \
  IMAGE_AGENT_DIR="$AGENT_DIR" \
  node "$SCRIPT_FILE" 2>&1 || true
)
printf '%s\n' "$STALE_OUTPUT" | grep -qi 'stale\|cache\|model-health' \
  || fail "stale cache should produce an error mentioning staleness or /model-health. Got: $STALE_OUTPUT"
pass 'stale cache produces actionable error'

# ---------------------------------------------------------------------------
# 12. Test: no healthy imageGeneration models → error
# ---------------------------------------------------------------------------
cat > "$AGENT_DIR/model-health-cache.json" <<NOMODEOF
{
  "checkedAt": $(node -e 'process.stdout.write(String(Date.now()))'),
  "results": [
    { "id": "test-provider/test-image-model", "status": "error", "service": "imageGeneration", "name": "test-image-model" }
  ]
}
NOMODEOF

NO_HEALTHY_OUTPUT=$(
  cd "$TMP_ROOT" && \
  IMAGE_PROMPT="test" IMAGE_OUT_DIR="$OUT_DIR" \
  IMAGE_AGENT_DIR="$AGENT_DIR" \
  node "$SCRIPT_FILE" 2>&1 || true
)
printf '%s\n' "$NO_HEALTHY_OUTPUT" | grep -qi 'available\|model-health' \
  || fail "no healthy models should produce an error mentioning availability or /model-health. Got: $NO_HEALTHY_OUTPUT"
pass 'no healthy imageGeneration models produces actionable error'

printf 'PASS image-generation end-to-end: PNG written, JSON output correct, error paths covered\n'
