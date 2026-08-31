import { lstat, mkdir, readFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, validateCanonicalMappings, type CanonicalMapping } from "./schema.ts";

const AA_DIR = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_DIR = path.resolve(AA_DIR, "../../..");
export const DEFAULT_ROOT = path.join(AGENT_DIR, "extensions/04-subagents/assets/aa");
export const DEFAULT_MANIFEST = path.join(DEFAULT_ROOT, "manifest.json");
export const DEFAULT_MAPPINGS = path.join(DEFAULT_ROOT, "canonical-mappings.json");
const CATALOG_PATHS = new Set(["/api/v2/language/models/free"]);

export interface AaPaths { agentDir: string; settings: string; modelsConfig: string; credentials: string; snapshotRoot: string; modelsDir: string; manifest: string; mappings: string; catalogState: string; }
export interface Limits { apiBytes: number; publicBytes: number; maxAgeMs: number; timeoutMs: number; pageDelayMs: number; publicRedirects: number; }
export interface BaseConfig { paths: AaPaths; limits: Limits; apiUrl: URL; }
export interface RuntimeConfig extends BaseConfig { enabledModels: string[]; aliases: Map<string, string>; stateCanonical: Map<string, string>; stateSupportsReasoningEffort: Map<string, boolean>; }
export interface WriterConfig extends RuntimeConfig { providerSupportsReasoningEffort: Map<string, boolean>; apiKey: string; }

function envPath(env: NodeJS.ProcessEnv, key: string, fallback: string): string { return path.resolve(env[key] || fallback); }
function bounded(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum: number, maximum: number, scale = 1, integer = false): number {
  const raw = env[key]; if (raw === undefined || raw === "") return fallback;
  const value = Number(raw) * scale;
  if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) throw new Error(`${key} is outside the allowed range`);
  return value;
}
export function validateCatalogUrl(raw: string): URL {
  let url: URL; try { url = new URL(raw); } catch { throw new Error("invalid Artificial Analysis API URL"); }
  if (url.protocol !== "https:" || url.hostname !== "artificialanalysis.ai" || url.port || url.username || url.password || url.search || url.hash || !CATALOG_PATHS.has(url.pathname)) throw new Error("Artificial Analysis API URL is not an allowed canonical endpoint");
  return url;
}
export function baseConfig(env: NodeJS.ProcessEnv = process.env): BaseConfig {
  const snapshotRoot = envPath(env, "PI_AA_SNAPSHOT_ROOT", DEFAULT_ROOT);
  const paths = {
    agentDir: AGENT_DIR,
    settings: envPath(env, "PI_AA_SETTINGS_CONFIG", path.join(AGENT_DIR, "settings.config.json")),
    modelsConfig: envPath(env, "PI_AA_MODELS_CONFIG", path.join(AGENT_DIR, "models.json")),
    credentials: envPath(env, "PI_CREDENTIALS_CONFIG", path.join(AGENT_DIR, "credentials.json")),
    snapshotRoot,
    modelsDir: path.join(snapshotRoot, "models"),
    manifest: path.join(snapshotRoot, "manifest.json"),
    mappings: envPath(env, "PI_AA_CANONICAL_MAPPINGS", path.join(snapshotRoot, "canonical-mappings.json")),
    catalogState: envPath(env, "PI_CATALOG_STATE", path.join(AGENT_DIR, "catalog-state.json")),
  };
  return { paths, apiUrl: validateCatalogUrl(env.PI_AA_API_URL || "https://artificialanalysis.ai/api/v2/language/models/free"), limits: {
    apiBytes: bounded(env, "PI_AA_MAX_BYTES", 2_097_152, 1, 64 * 1024 * 1024, 1, true),
    publicBytes: bounded(env, "PI_AA_PUBLIC_MAX_BYTES", 8_388_608, 1, 64 * 1024 * 1024, 1, true),
    maxAgeMs: bounded(env, "PI_AA_SNAPSHOT_MAX_AGE_MS", 2_592_000_000, 1, 31_536_000_000, 1, true),
    timeoutMs: bounded(env, "PI_AA_REQUEST_TIMEOUT_MS", 30_000, 1, 300_000, 1, true),
    pageDelayMs: bounded(env, "PI_AA_PUBLIC_PAGE_DELAY", 1_000, 0, 60_000, 1_000),
    publicRedirects: bounded(env, "PI_AA_PUBLIC_PAGE_MAX_REDIRECTS", 2, 0, 10, 1, true),
  }};
}

export async function assertSecureFile(file: string, mode = 0o600): Promise<void> {
  let info; try { info = await lstat(file); } catch { throw new Error(`missing required file: ${path.basename(file)}`); }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`unsafe file type: ${path.basename(file)}`);
  if ((info.mode & 0o777) !== mode) throw new Error(`unsafe permissions on ${path.basename(file)} (expected ${mode.toString(8)})`);
}
export async function assertSecureDirectory(directory: string): Promise<void> {
  let info; try { info = await lstat(directory); } catch { throw new Error(`missing required directory: ${path.basename(directory)}`); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe directory type: ${path.basename(directory)}`);
  if ((info.mode & 0o777) !== 0o700) throw new Error(`unsafe permissions on ${path.basename(directory)} (expected 700)`);
}
export async function ensureSecureDirectory(directory: string): Promise<void> {
  let created = false;
  try { await mkdir(directory, { mode: 0o700 }); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (created) await chmod(directory, 0o700);
  await assertSecureDirectory(directory);
}
export async function readSecureJson(file: string): Promise<unknown> { await assertSecureFile(file); try { return JSON.parse(await readFile(file, "utf8")); } catch { throw new Error(`invalid JSON in ${path.basename(file)}`); } }
export async function readOptionalSecureJson(file: string): Promise<unknown | null> {
  try { return await readSecureJson(file); } catch (error) { if ((error as Error).message.startsWith("missing required file:")) return null; throw error; }
}

function parseEnabled(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.enabledModels) || value.enabledModels.some((id) => typeof id !== "string" || /[\x00-\x1f\x7f]/.test(id) || !/^[^/]+\/.+/.test(id))) throw new Error("invalid enabledModels settings");
  return [...new Set(value.enabledModels)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
function sensitive(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(sensitive);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => /^(?:api.?key|authorization|credentials?|password|secret|access.?token|refresh.?token|headers?)$/i.test(key) || sensitive(item));
}
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
function validThinkingLevelMap(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0 && Object.entries(value).every(([level, target]) => THINKING_LEVELS.has(level) && (target === null || typeof target === "string" && target.length <= 4096 && !/[\x00-\x1f\x7f]/.test(target)));
}
function parseState(value: unknown): { canonical: Map<string, string>; supportsReasoningEffort: Map<string, boolean> } {
  const canonical = new Map<string, string>(); const supportsReasoningEffort = new Map<string, boolean>(); if (value === null) return { canonical, supportsReasoningEffort };
  if (!isRecord(value) || sensitive(value) || !Array.isArray(value.providers)) throw new Error("invalid or credential-bearing catalog state");
  for (const provider of value.providers) {
    if (!isRecord(provider) || typeof provider.id !== "string" || /[\x00-\x1f\x7f]/.test(provider.id) || !Array.isArray(provider.models)) throw new Error("invalid catalog state");
    for (const model of provider.models) if (!isRecord(model) || typeof model.id !== "string" || typeof model.canonicalId !== "string" || /[\x00-\x1f\x7f]/.test(`${provider.id}/${model.id}${model.canonicalId}`) || !model.canonicalId.includes("/")) throw new Error("invalid catalog state"); else canonical.set(`${provider.id}/${model.id}`, model.canonicalId);
  }
  if (Array.isArray(value.nativeModels)) for (const model of value.nativeModels) {
    if (!isRecord(model) || typeof model.id !== "string" || typeof model.canonicalId !== "string" || /[\x00-\x1f\x7f]/.test(`${model.id}${model.canonicalId}`) || !model.canonicalId.includes("/") || (model.supportsReasoningEffort !== undefined && typeof model.supportsReasoningEffort !== "boolean")) throw new Error("invalid catalog state");
    canonical.set(model.id, model.canonicalId);
    if (typeof model.supportsReasoningEffort === "boolean") supportsReasoningEffort.set(model.id, model.supportsReasoningEffort);
    else if (validThinkingLevelMap(model.thinkingLevelMap)) supportsReasoningEffort.set(model.id, true);
  }
  return { canonical, supportsReasoningEffort };
}
function mappingProjection(value: unknown): { aliases: Map<string, string>; mappings: CanonicalMapping[] } {
  if (value === null) return { aliases: new Map(), mappings: [] };
  if (!validateCanonicalMappings(value)) throw new Error("invalid canonical mappings");
  const mappings = value.mappings;
  return { mappings, aliases: new Map(mappings.map((entry) => [`${entry.provider}/${entry.model}`, entry.canonicalId])) };
}

export async function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): Promise<RuntimeConfig> {
  const base = baseConfig(env);
  const settings = await readSecureJson(base.paths.settings);
  const mappingsValue = await readOptionalSecureJson(base.paths.mappings);
  const stateValue = await readOptionalSecureJson(base.paths.catalogState);
  const { aliases } = mappingProjection(mappingsValue); const state = parseState(stateValue);
  return { ...base, enabledModels: parseEnabled(settings), aliases, stateCanonical: state.canonical, stateSupportsReasoningEffort: state.supportsReasoningEffort };
}
export async function loadMappings(config: BaseConfig): Promise<CanonicalMapping[]> { return mappingProjection(await readOptionalSecureJson(config.paths.mappings)).mappings; }
export async function loadRequiredMappings(config: BaseConfig): Promise<CanonicalMapping[]> { return mappingProjection(await readSecureJson(config.paths.mappings)).mappings; }
export function canonicalIdentity(config: RuntimeConfig, runtimeId: string): string { return config.aliases.get(runtimeId) ?? config.stateCanonical.get(runtimeId) ?? runtimeId; }

function parseModels(value: unknown): Map<string, boolean> {
  if (!isRecord(value) || !isRecord(value.providers)) throw new Error("invalid models compatibility config");
  const result = new Map<string, boolean>();
  for (const [provider, raw] of Object.entries(value.providers)) {
    if (!isRecord(raw)) throw new Error("invalid models compatibility config");
    const compat = raw.compat;
    if (isRecord(compat) && compat.supportsReasoningEffort !== undefined && typeof compat.supportsReasoningEffort !== "boolean") throw new Error("invalid models compatibility config");
    const supported = !isRecord(compat) || compat.supportsReasoningEffort !== false;
    result.set(provider, supported);
  }
  return result;
}
async function apiKey(base: BaseConfig, env: NodeJS.ProcessEnv): Promise<string> {
  if (typeof env.AA_API_KEY === "string" && env.AA_API_KEY.trim()) return env.AA_API_KEY.trim();
  const value = await readSecureJson(base.paths.credentials);
  if (!isRecord(value) || !isRecord(value.artificialAnalysis) || typeof value.artificialAnalysis.apiKey !== "string" || !value.artificialAnalysis.apiKey.trim()) throw new Error("Artificial Analysis API key is missing");
  return value.artificialAnalysis.apiKey.trim();
}
export async function loadWriterConfig(env: NodeJS.ProcessEnv = process.env): Promise<WriterConfig> {
  const runtime = await loadRuntimeConfig(env);
  const modelsValue = await readSecureJson(runtime.paths.modelsConfig);
  return { ...runtime, providerSupportsReasoningEffort: parseModels(modelsValue), apiKey: await apiKey(runtime, env) };
}
export async function loadDiscoverConfig(env: NodeJS.ProcessEnv = process.env): Promise<RuntimeConfig & { apiKey: string }> { const runtime = await loadRuntimeConfig(env); return { ...runtime, apiKey: await apiKey(runtime, env) }; }
