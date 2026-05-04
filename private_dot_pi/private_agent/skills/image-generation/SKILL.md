---
name: image-generation
description: Generate images with available image generation models configured in agent/models.json and pi settings. Use when the user asks to create, generate, render, draw, or make an image, illustration, logo, icon, poster, mockup, or visual asset from a prompt using healthy configured provider models.
---

# Image Generation

Use this skill when the user wants a new image or visual asset generated from text or an input image. The image models must come from pi configuration and must be marked healthy before use; do not assume a provider or model ID.

## Required Availability Check

Before generating any image:

1. Read `agent/model-health-cache.json`.
2. Only use cached results where:
   - `service` is `imageGeneration`
   - `status` is `ok`
3. If there are no healthy image generation results, do **not** call an image generation endpoint. Tell the user that no image generation models are currently available and suggest running `/model-health` to refresh the cache.
4. If the cache file is missing, invalid, or stale according to `MODEL_HEALTH_CACHE_TTL_MS` in `model-health-check.ts`, do **not** assume availability. Tell the user the health cache needs to be refreshed with `/model-health` before image generation.

The health extension gets configured image models from `imageGenerationProviders` in `agent/settings.config.json` or `agent/settings.json`, and provider connection details from `agent/models.json`. Follow that same source-of-truth.

## Workflow

1. Perform the required availability check above.
2. Read `agent/settings.config.json` and `agent/models.json`.
3. Match each healthy cache result such as `provider/model-id` to:
   - `agent/settings.config.json` → `imageGenerationProviders[provider].models[]`
   - `agent/models.json` → `providers[provider]` for `baseUrl`, `apiKey`, and API compatibility.
4. If more than one healthy image model exists, choose the best fit from metadata and user constraints, or ask the user which model to use.
5. Build a complete generation prompt:
   - Subject and action
   - Style or medium
   - Composition/framing
   - Lighting/color palette
   - Aspect ratio or output size
   - Text to include or avoid
   - Negative constraints, if supported
6. Call the selected provider's OpenAI-compatible image generation endpoint and save the result to a file.
7. Trigger a generated-image notification by calling `notifyGeneratedImage(savedImagePath, ctx)` from `agent/extensions/native-notify.ts` when you are operating from extension code that has a Pi extension context. If you generated the image from a script or shell workflow without an extension context, ask Pi/the user to call that function with the saved path rather than reimplementing notification logic.
8. Return the saved path, model, provider, and a short note about any assumptions.

## Listing Healthy Image Models

From the repository root or `~/.pi`, list currently healthy image generation models from the cache with:

```bash
jq -r '
  .results[]?
  | select(.service == "imageGeneration" and .status == "ok")
  | [.id, (.name // (.id | split("/")[-1]))]
  | @tsv
' agent/model-health-cache.json
```

If this prints nothing, do not invent a model and do not call the image endpoint.

To inspect configured image generation models, use:

```bash
jq -r '
  .imageGenerationProviders
  | to_entries[]?
  | .key as $provider
  | (.value.models // [])[]
  | [$provider, .id, (.name // .id)]
  | @tsv
' agent/settings.config.json
```

A configured model is not enough; it must also be healthy in `agent/model-health-cache.json`.

## Endpoint

Use the selected provider's `baseUrl` from `agent/models.json` and append `/images/generations` after trimming a trailing slash:

```text
POST ${baseUrl}/images/generations
Authorization: Bearer ${apiKey}
Content-Type: application/json
```

Typical body:

```json
{
  "model": "<selected-image-model-id>",
  "prompt": "<final prompt>",
  "n": 1,
  "size": "1024x1024",
  "response_format": "b64_json"
}
```

Only include optional fields such as `quality`, `style`, `background`, `moderation`, `negative_prompt`, `image`, or `mask` when the selected model/provider metadata or API docs indicate support, or when the user explicitly requests them and the provider accepts them.

## Safe API Key Handling

Resolve `apiKey` without printing it:

- Literal values are used as-is in an environment variable.
- Values like `$ENV_VAR` are resolved from the environment.
- Values beginning with `!` are shell commands; run the command and capture stdout.

Never include the key in final answers, logs, filenames, or generated artifacts.

## Reference Node Script

Use an inline Node script for robust JSON handling and base64/URL outputs. It reads the health cache first, refuses to generate when no healthy image models are available, then reads pi configuration, selects a healthy model, calls the endpoint, and writes a PNG. Adjust prompt, size, and output path for the user's request.

```bash
node <<'NODE'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

const agentDir = resolve('agent');
const modelsPath = join(agentDir, 'models.json');
const settingsConfigPath = join(agentDir, 'settings.config.json');
const cachePath = join(agentDir, 'model-health-cache.json');
const healthExtensionPath = join(agentDir, 'extensions/model-health-check.ts');

const prompt = process.env.IMAGE_PROMPT || 'A concise image prompt goes here';
const requestedModel = process.env.IMAGE_MODEL || '';
const requestedProvider = process.env.IMAGE_PROVIDER || '';
const size = process.env.IMAGE_SIZE || '1024x1024';
const outDir = process.env.IMAGE_OUT_DIR || 'generated-images';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function resolveApiKey(value) {
  if (!value) return '';
  if (value.startsWith('!')) return execSync(value.slice(1), { encoding: 'utf8' }).trim();
  if (value.startsWith('$')) return process.env[value.slice(1)] || '';
  return value;
}

function getCacheTtlMs() {
  const source = readFileSync(healthExtensionPath, 'utf8');
  const match = source.match(/MODEL_HEALTH_CACHE_TTL_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
  if (match) return Number(match[1]) * Number(match[2]) * Number(match[3]);
  return 15 * 60 * 1000;
}

if (!existsSync(cachePath)) {
  throw new Error('No model health cache found. Run /model-health before generating images.');
}

const cache = readJson(cachePath);
const cacheTtlMs = getCacheTtlMs();
if (!Number.isFinite(cache.checkedAt) || Date.now() - cache.checkedAt > cacheTtlMs) {
  throw new Error('Model health cache is stale. Run /model-health before generating images.');
}

const healthyImageResults = (cache.results || []).filter((result) =>
  result.service === 'imageGeneration' && result.status === 'ok'
);
if (healthyImageResults.length === 0) {
  throw new Error('No image generation models are currently available. Run /model-health to refresh availability.');
}

const modelsConfig = readJson(modelsPath);
const settingsConfig = readJson(settingsConfigPath);
const healthyIds = new Set(healthyImageResults.map((result) => result.id));

const candidates = [];
for (const [providerName, providerSettings] of Object.entries(settingsConfig.imageGenerationProviders || {})) {
  const provider = modelsConfig.providers?.[providerName];
  for (const model of providerSettings.models || []) {
    const fullId = `${providerName}/${model.id}`;
    if (!healthyIds.has(fullId)) continue;
    candidates.push({ providerName, provider, model, fullId });
  }
}

const selected = candidates.find(({ providerName, model, fullId }) =>
  (!requestedProvider || providerName === requestedProvider) &&
  (!requestedModel || model.id === requestedModel || fullId === requestedModel)
) || candidates[0];

if (!selected) throw new Error('No configured image generation model matches the healthy cache results. Run /model-health and verify imageGenerationProviders.');
if (!selected.provider?.baseUrl) throw new Error(`Missing baseUrl for provider ${selected.providerName}`);

const apiKey = resolveApiKey(selected.provider.apiKey || '');
if (!apiKey) throw new Error(`Missing API key for provider ${selected.providerName}`);

const response = await fetch(`${String(selected.provider.baseUrl).replace(/\/$/, '')}/images/generations`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: selected.model.id,
    prompt,
    n: 1,
    size,
    response_format: 'b64_json',
  }),
});

const text = await response.text();
if (!response.ok) throw new Error(`Image generation failed (${response.status}): ${text}`);
const json = JSON.parse(text);
const item = json.data?.[0];
if (!item) throw new Error('Image generation response did not include data[0]');

mkdirSync(outDir, { recursive: true });
const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'image';
const suffix = randomBytes(4).toString('hex');

let outPath;
if (item.b64_json) {
  outPath = join(outDir, `${slug}-${suffix}.png`);
  writeFileSync(outPath, Buffer.from(item.b64_json, 'base64'));
} else if (item.url) {
  const imageResponse = await fetch(item.url);
  if (!imageResponse.ok) throw new Error(`Failed to download generated image (${imageResponse.status})`);
  outPath = join(outDir, `${slug}-${suffix}.png`);
  writeFileSync(outPath, Buffer.from(await imageResponse.arrayBuffer()));
} else {
  throw new Error('Image response included neither b64_json nor url');
}

console.log(JSON.stringify({
  path: outPath,
  provider: selected.providerName,
  model: selected.model.id,
  size,
  notification: 'Call notifyGeneratedImage(outPath, ctx) from agent/extensions/native-notify.ts when an extension context is available.',
}, null, 2));
NODE
```

## User Interaction Rules

- Ask a clarifying question if the request lacks a subject or desired visual output.
- If the user does not specify size, use `1024x1024` unless the model metadata indicates a better default.
- If the user asks for a logo, icon, poster, or UI mockup, ask whether exact text must be rendered; image models often render text imperfectly.
- Do not claim an image was generated unless the health cache had an `ok` image generation model, the API call succeeded, and a file was written.
- If no healthy image generation model is available, say so and suggest `/model-health`; do not attempt generation.
- If generation fails, report the provider/model, HTTP status, and actionable next step without exposing secrets.
