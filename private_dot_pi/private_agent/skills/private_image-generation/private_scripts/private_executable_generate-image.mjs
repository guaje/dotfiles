#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(process.env.IMAGE_AGENT_DIR || resolve(scriptDir, '../../..'));
const modelsPath = join(agentDir, 'models.json');
const settingsConfigPath = join(agentDir, 'settings.config.json');
const settingsPath = join(agentDir, 'settings.json');
const cachePath = join(agentDir, 'model-health-cache.json');
const healthExtensionPath = join(agentDir, 'extensions/06-model-health-check.ts');

const prompt = process.env.IMAGE_PROMPT || 'A concise image prompt goes here';
const requestedModel = process.env.IMAGE_MODEL || '';
const requestedProvider = process.env.IMAGE_PROVIDER || '';
const size = process.env.IMAGE_SIZE || '1024x1024';
const outDir = process.env.IMAGE_OUT_DIR || getDefaultGeneratedImagesDir();
const openDelaySeconds = Number(process.env.IMAGE_OPEN_DELAY_SECONDS || 5);

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

function getDefaultGeneratedImagesDir() {
  const home = process.env.HOME || '.';
  const termuxPicturesDir = join(home, 'storage', 'pictures');
  if ((process.env.TERMUX_VERSION || process.env.PREFIX?.includes('/com.termux/')) && existsSync(termuxPicturesDir)) {
    return join(termuxPicturesDir, 'generated');
  }
  try {
    const picturesDir = execFileSync('xdg-user-dir', ['PICTURES'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (picturesDir) return join(picturesDir, 'generated');
  } catch (error) {
    // Fall back below when xdg-user-dir is unavailable.
  }
  return join(home, 'Pictures', 'generated');
}

function isTermux() {
  return Boolean(process.env.TERMUX_VERSION || process.env.PREFIX?.includes('/com.termux/'));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function commandExists(command) {
  try {
    execFileSync('sh', ['-c', `command -v ${command} >/dev/null 2>&1`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isAutoNotificationAvailable() {
  if (!isTermux()) return false;
  if (process.env.IMAGE_FORCE_OPEN === '1') return false;
  if (process.env.IMAGE_DISABLE_AUTONOTIFICATION === '1') return false;
  // Explicit override so callers (and tests) can force the AutoNotification-available
  // branch on any OS, instead of relying on `am` being on PATH (which is also true
  // on macOS via /usr/bin/am, making the detection OS-dependent).
  if (process.env.IMAGE_FORCE_AUTONOTIFICATION === '1') return true;
  return commandExists('am');
}

function openInTermux(imagePath) {
  if (!isTermux()) return 'Use pi inline terminal image rendering when supported; otherwise open the saved path locally.';
  if (isAutoNotificationAvailable()) {
    return 'Termux detected. Skipped immediate image open because AutoNotification is available; open the image from the generated-image notification.';
  }

  const delay = Number.isFinite(openDelaySeconds) && openDelaySeconds >= 0 ? openDelaySeconds : 5;
  const realImagePath = realpathSync(imagePath);
  const imageCommand = `am start -a android.intent.action.VIEW -d ${shellQuote(`file://${realImagePath}`)} -t image/png`;
  const termuxOpenCommand = `termux-open --chooser --content-type image/png ${shellQuote(imagePath)}`;
  const folderCommand = `termux-open --chooser ${shellQuote(dirname(imagePath))}`;
  const opener = `(sleep ${delay}; ${imageCommand} || ${termuxOpenCommand} || ${folderCommand}) >/dev/null 2>&1 &`;
  try {
    execFileSync('sh', ['-c', opener], { stdio: 'ignore' });
    return `Termux detected. AutoNotification unavailable; scheduled image open in ${delay}s with Android activity manager; fallbacks: ${termuxOpenCommand}; ${folderCommand}.`;
  } catch (error) {
    return `Termux detected, but scheduling image open failed. Run: ${imageCommand}. If that fails, run: ${termuxOpenCommand}. Folder fallback: ${folderCommand}.`;
  }
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
const settingsConfig = existsSync(settingsConfigPath) ? readJson(settingsConfigPath) : readJson(settingsPath);
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

const display = openInTermux(outPath);

console.log(JSON.stringify({
  path: outPath,
  provider: selected.providerName,
  model: selected.model.id,
  size,
  display,
  notification: 'Call notifyGeneratedImage(outPath, ctx) from agent/extensions/07-native-notify.ts when an extension context is available.',
}, null, 2));
