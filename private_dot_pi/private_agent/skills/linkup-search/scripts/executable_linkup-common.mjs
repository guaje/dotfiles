import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDir = dirname(fileURLToPath(import.meta.url));
export const agentDir = resolve(process.env.LINKUP_AGENT_DIR || resolve(thisDir, '../../..'));
const settingsConfigPath = join(agentDir, 'settings.config.json');
const settingsPath = join(agentDir, 'settings.json');

export function readJson(filePath) {
  if (!existsSync(filePath)) return undefined;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function resolveSecret(value) {
  if (!value) return '';
  if (value.startsWith('!')) return execSync(value.slice(1), { encoding: 'utf8' }).trim();
  if (value.startsWith('$')) return process.env[value.slice(1)] || '';
  return value;
}

export function loadLinkupConfig() {
  const settings = readJson(settingsConfigPath) || readJson(settingsPath) || {};
  const linkup = settings.linkup && typeof settings.linkup === 'object' ? settings.linkup : {};
  return {
    apiKey: resolveSecret(process.env.LINKUP_API_KEY || settings.linkupAPIKey || linkup.apiKey || ''),
    baseUrl: String(settings.linkupBaseUrl || linkup.baseUrl || 'https://api.linkup.so').replace(/\/$/, ''),
  };
}

export function jsonError(message, code = 2) {
  console.error(JSON.stringify({ error: message, exitCode: code }));
  process.exit(code);
}

export function csvEnv(name) {
  const raw = process.env[name] || '';
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

export function boolEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return raw.toLowerCase() === 'true';
}

export function parseJsonEnv(name) {
  const raw = process.env[name] || '';
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    jsonError(`Invalid JSON in ${name}: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
}

export function requireApiKey() {
  const config = loadLinkupConfig();
  if (!config.apiKey) {
    jsonError('Missing Linkup API key. Add "linkupAPIKey" to agent/settings.config.json or set LINKUP_API_KEY in the environment.', 2);
  }
  return config;
}

export async function postJson(path, body) {
  const { apiKey, baseUrl } = requireApiKey();
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    jsonError(`Network error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    jsonError(`Non-JSON response (${response.status}): ${text.slice(0, 200)}`, 1);
  }

  if (!response.ok) {
    const message = json?.error?.message || json?.error || text;
    jsonError(`Linkup API error (${response.status}): ${message}`, 1);
  }

  console.log(JSON.stringify(json, null, 2));
}
