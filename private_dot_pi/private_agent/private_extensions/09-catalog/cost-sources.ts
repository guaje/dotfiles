import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CostRates } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REVIEWED_COSTS_PATH = path.resolve(__dirname, "../03-stats/assets/model-cost-overrides.json");

export const AUTHORITATIVE_CATALOG_URL = process.env.PI_CATALOG_METADATA_URL || "https://openrouter.ai/api/v1/models";
export const AUTHORITATIVE_COST_PROVENANCE = "authoritative:openrouter:/api/v1/models";
const REQUEST_TIMEOUT_MS = 10_000;
const OLLAMA_CLOUD_MODELS_URL = "https://ollama.com/api/tags";
const OLLAMA_CLOUD_MAX_BYTES = 2_097_152;

type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue { return !!value && typeof value === "object" && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function numeric(value: unknown): number | undefined {
  if (finite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Costs are normalized to USD per million tokens. Unknown is deliberately undefined. */
export function normalizeCost(raw: unknown): CostRates | undefined {
  if (!record(raw)) return undefined;
  const source = record(raw.cost) ? raw.cost : raw;
  const input = source.input ?? source.prompt ?? source.input_per_million;
  const output = source.output ?? source.completion ?? source.output_per_million;
  if (!finite(input) || !finite(output) || (input === 0 && output === 0)) return undefined;
  return { input, output, cacheRead: finite(source.cacheRead) ? source.cacheRead : 0, cacheWrite: finite(source.cacheWrite) ? source.cacheWrite : 0 };
}

/** OpenRouter publishes USD-per-token strings, unlike provider inventories' per-million numbers. */
function normalizeAuthoritativeCost(raw: unknown): CostRates | undefined {
  if (!record(raw)) return undefined;
  const input = numeric(raw.prompt ?? raw.input);
  const output = numeric(raw.completion ?? raw.output);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = numeric(raw.input_cache_read ?? raw.cacheRead) ?? 0;
  const cacheWrite = numeric(raw.input_cache_write ?? raw.cacheWrite) ?? 0;
  const perMillion = (value: number) => Math.round(value * 1_000_000 * 1e12) / 1e12;
  return { input: perMillion(input), output: perMillion(output), cacheRead: perMillion(cacheRead), cacheWrite: perMillion(cacheWrite) };
}

export interface AuthoritativeModelMetadata {
  id: string;
  name?: string;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: CostRates;
}

export interface AuthoritativeCatalog {
  provenance: string;
  models: Map<string, AuthoritativeModelMetadata>;
}

export interface OllamaCloudModelMetadata {
  id: string;
  /** Present in the unauthenticated public Cloud inventory. */
  available: boolean;
  /** Only explicit numeric price fields are accepted. */
  cost?: CostRates;
}

export interface OllamaCloudCatalog {
  provenance: "ollama-cloud:/api/tags";
  models: Map<string, OllamaCloudModelMetadata>;
}

function inputFrom(raw: RecordValue): ("text" | "image")[] | undefined {
  const values = Array.isArray(raw.input) ? raw.input : record(raw.architecture) ? raw.architecture.input_modalities : undefined;
  if (!Array.isArray(values)) return undefined;
  const input = values.filter((value): value is "text" | "image" => value === "text" || value === "image");
  return input.length ? input : undefined;
}

/** Parse only exact source identities; names and fuzzy matches are never safe price mappings. */
export function parseAuthoritativeCatalog(body: unknown, provenance = AUTHORITATIVE_COST_PROVENANCE): AuthoritativeCatalog {
  const data = Array.isArray(body) ? body : record(body) && Array.isArray(body.data) ? body.data : [];
  const models = new Map<string, AuthoritativeModelMetadata>();
  for (const raw of data) {
    if (!record(raw) || typeof raw.id !== "string" || !raw.id) continue;
    const contextWindow = numeric(raw.context_length ?? raw.contextWindow);
    const topProvider = record(raw.top_provider) ? raw.top_provider : undefined;
    const maxTokens = numeric(raw.max_completion_tokens ?? raw.maxTokens ?? topProvider?.max_completion_tokens);
    const input = inputFrom(raw);
    const cost = normalizeAuthoritativeCost(raw.pricing ?? raw.cost);
    models.set(raw.id, {
      id: raw.id,
      ...(typeof raw.name === "string" ? { name: raw.name } : {}),
      ...(input ? { input } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(cost ? { cost } : {}),
    });
  }
  return { provenance, models };
}

/** Best-effort public fallback. Provider inventory remains the availability authority. */
export function normalizedModelSuffix(id: string): string {
  return id.split("/").at(-1)?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
}

/** Return the unique OpenRouter model with the same normalized runtime suffix. */
export function uniqueNormalizedAuthoritativeMatch(id: string, catalog: AuthoritativeCatalog): AuthoritativeModelMetadata | undefined {
  const suffix = normalizedModelSuffix(id);
  if (!suffix) return undefined;
  const matches = [...catalog.models.values()].filter((model) => normalizedModelSuffix(model.id) === suffix);
  return matches.length === 1 ? matches[0] : undefined;
}

export async function loadAuthoritativeCatalog(signal?: AbortSignal, url = AUTHORITATIVE_CATALOG_URL): Promise<AuthoritativeCatalog> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`authoritative model catalog returned ${response.status}`);
    let provenance: string;
    try {
      const source = new URL(url);
      provenance = source.hostname === "openrouter.ai" && source.pathname === "/api/v1/models"
        ? AUTHORITATIVE_COST_PROVENANCE
        : `authoritative:${source.hostname}${source.pathname}`;
    } catch { provenance = "authoritative:configured-source"; }
    return parseAuthoritativeCatalog(await response.json(), provenance);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function explicitOllamaCost(raw: RecordValue): CostRates | undefined {
  const pricing = record(raw.pricing) ? raw.pricing : raw;
  const bounded = (value: unknown, maximum: number): number | undefined => {
    const parsed = numeric(value);
    return parsed !== undefined && parsed <= maximum ? parsed : undefined;
  };
  const rate = (keys: string[], maximum: number) => keys.map((key) => bounded(pricing[key], maximum)).find((value): value is number => value !== undefined);
  const inputToken = rate(["input_cost_per_token", "input_per_token", "prompt_cost_per_token", "prompt_per_token"], 1);
  const outputToken = rate(["output_cost_per_token", "output_per_token", "completion_cost_per_token", "completion_per_token"], 1);
  const inputMillion = rate(["input_per_million", "input_cost_per_million", "prompt_per_million", "prompt_cost_per_million"], 1_000_000);
  const outputMillion = rate(["output_per_million", "output_cost_per_million", "completion_per_million", "completion_cost_per_million"], 1_000_000);
  const result = inputToken !== undefined && outputToken !== undefined
    ? { input: inputToken * 1_000_000, output: outputToken * 1_000_000, cacheRead: 0, cacheWrite: 0 }
    : inputMillion !== undefined && outputMillion !== undefined
      ? { input: inputMillion, output: outputMillion, cacheRead: 0, cacheWrite: 0 }
      : undefined;
  return result && (result.input !== 0 || result.output !== 0) ? result : undefined;
}

function safeOllamaCloudUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "ollama.com" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/api/tags") throw new Error("unsafe Ollama Cloud availability URL");
  return parsed;
}

async function boundedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!Number.isSafeInteger(Number(length)) || Number(length) < 0 || Number(length) > OLLAMA_CLOUD_MAX_BYTES)) throw new Error("Ollama Cloud response exceeds byte limit");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Ollama Cloud response has no body");
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new Error("operation aborted");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > OLLAMA_CLOUD_MAX_BYTES) throw new Error("Ollama Cloud response exceeds byte limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("Ollama Cloud returned invalid JSON"); }
}

/** Unauthenticated, endpoint-pinned Cloud availability. No price is inferred from availability. */
export async function loadOllamaCloudCatalog(signal?: AbortSignal, url = OLLAMA_CLOUD_MODELS_URL): Promise<OllamaCloudCatalog> {
  const endpoint = safeOllamaCloudUrl(url);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(endpoint, { headers: { accept: "application/json" }, redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`Ollama Cloud availability returned ${response.status}`);
    const body = await boundedJson(response, controller.signal);
    const entries = record(body) && Array.isArray(body.models) ? body.models : record(body) && Array.isArray(body.data) ? body.data : null;
    if (!entries) throw new Error("Ollama Cloud availability response has no model array");
    const models = new Map<string, OllamaCloudModelMetadata>();
    for (const entry of entries) {
      if (!record(entry)) continue;
      const id = typeof entry.name === "string" ? entry.name : typeof entry.model === "string" ? entry.model : typeof entry.id === "string" ? entry.id : undefined;
      if (!id) continue;
      const cost = explicitOllamaCost(entry);
      models.set(id, { id, available: true, ...(cost ? { cost } : {}) });
    }
    return { provenance: "ollama-cloud:/api/tags", models };
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export function ollamaCloudModel(id: string, catalog: OllamaCloudCatalog): OllamaCloudModelMetadata | undefined {
  const exact = catalog.models.get(id);
  if (exact) return exact;
  const suffix = normalizedModelSuffix(id); const matches = [...catalog.models.values()].filter((model) => normalizedModelSuffix(model.id) === suffix);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Exact identity lookup only; reviewed overrides are intentionally the final fallback. */
export function reviewedCost(runtimeId: string, overrides: Record<string, unknown>): CostRates | undefined {
  return normalizeCost(overrides[runtimeId]);
}

export async function loadReviewedCosts(overridesPath = REVIEWED_COSTS_PATH): Promise<Map<string, CostRates>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(overridesPath, "utf8"));
    if (!record(parsed)) return new Map();
    const entries = record(parsed.models) ? parsed.models : parsed;
    const costs = new Map<string, CostRates>();
    for (const [runtimeId, raw] of Object.entries(entries)) {
      const cost = normalizeCost(raw);
      if (cost) costs.set(runtimeId, cost);
    }
    return costs;
  } catch {
    return new Map();
  }
}
