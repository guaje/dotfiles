import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogModel, CatalogProvider, CatalogState, NativeModelObservation, ThinkingLevelMap } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CATALOG_STATE_PATH = path.resolve(__dirname, "../../catalog-state.json");
const validRate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const optionalRate = (value: unknown) => value === undefined || validRate(value);
const safeKey = (key: string) => !/(?:api.?key|authorization|credential|password|secret|token|headers?)/i.test(key);

function safeValue(value: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (value === null || typeof value === "boolean" || typeof value === "number") return true;
  if (typeof value === "string") return value.length <= 4096;
  if (Array.isArray(value)) return value.length <= 128 && value.every((entry) => safeValue(entry, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).every(([key, entry]) => safeKey(key) && safeValue(entry, depth + 1));
}

const validCost = (cost: any) => !cost || [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(validRate);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const validThinkingLevelMap = (value: unknown): value is ThinkingLevelMap => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.entries(value as Record<string, unknown>).every(([level, target]) => THINKING_LEVELS.has(level) && (target === null || typeof target === "string" && target.length <= 4096 && !/[\x00-\x1f\x7f]/.test(target)));
const validModel = (value: unknown): value is CatalogModel => {
  if (!value || typeof value !== "object") return false;
  const model = value as CatalogModel;
  return typeof model.id === "string" && !!model.id
    && typeof model.name === "string" && !!model.name
    && typeof model.canonicalId === "string" && !!model.canonicalId
    && (model.reasoning === undefined || typeof model.reasoning === "boolean")
    && (model.thinkingLevelMap === undefined || validThinkingLevelMap(model.thinkingLevelMap))
    && (model.thinkingLevelMapProvenance === undefined || model.thinkingLevelMapProvenance === "provider" || model.thinkingLevelMapProvenance === "provider-inferred" || model.thinkingLevelMapProvenance === "reviewed")
    && Array.isArray(model.input) && model.input.length > 0 && model.input.every((x) => x === "text" || x === "image")
    && optionalRate(model.contextWindow) && optionalRate(model.maxTokens)
    && (model.available === undefined || typeof model.available === "boolean")
    && typeof model.active === "boolean"
    && (model.costProvenance === undefined || typeof model.costProvenance === "string")
    && validCost(model.cost)
    && Object.keys(model).every((key) => ["id", "name", "canonicalId", "reasoning", "thinkingLevelMap", "thinkingLevelMapProvenance", "input", "contextWindow", "maxTokens", "cost", "costProvenance", "available", "active"].includes(key));
};

function safeBaseUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

const validProvider = (provider: any): provider is CatalogProvider => provider
  && typeof provider.id === "string" && !!provider.id
  && safeBaseUrl(provider.baseUrl) && typeof provider.api === "string"
  && (provider.compat === undefined || safeValue(provider.compat))
  && Object.keys(provider).every((key) => ["id", "baseUrl", "api", "compat", "models"].includes(key))
  && Array.isArray(provider.models) && provider.models.every(validModel);

const validNativeModel = (value: unknown): value is NativeModelObservation => {
  if (!value || typeof value !== "object") return false;
  const model = value as NativeModelObservation;
  return typeof model.id === "string" && model.id.includes("/")
    && typeof model.canonicalId === "string" && !!model.canonicalId
    && typeof model.name === "string" && !!model.name
    && (model.reasoning === undefined || typeof model.reasoning === "boolean")
    && (model.thinkingLevelMap === undefined || validThinkingLevelMap(model.thinkingLevelMap))
    && (model.thinkingLevelMapProvenance === undefined || model.thinkingLevelMapProvenance === "provider" || model.thinkingLevelMapProvenance === "provider-inferred" || model.thinkingLevelMapProvenance === "reviewed")
    && (model.supportsReasoningEffort === undefined || typeof model.supportsReasoningEffort === "boolean")
    && Array.isArray(model.input) && model.input.length > 0 && model.input.every((x) => x === "text" || x === "image")
    && optionalRate(model.contextWindow) && optionalRate(model.maxTokens)
    && validCost(model.cost)
    && (model.costProvenance === undefined || typeof model.costProvenance === "string")
    && validRate(model.observedAt) && (model.available === undefined || typeof model.available === "boolean") && typeof model.active === "boolean"
    && Object.keys(model).every((key) => ["id", "canonicalId", "name", "reasoning", "thinkingLevelMap", "thinkingLevelMapProvenance", "supportsReasoningEffort", "input", "contextWindow", "maxTokens", "cost", "costProvenance", "observedAt", "available", "active"].includes(key));
};

export function validateCatalogState(value: unknown): value is CatalogState {
  if (!value || typeof value !== "object") return false;
  const state = value as CatalogState;
  return state.version === 2 && validRate(state.updatedAt)
    && Object.keys(state).every((key) => ["version", "updatedAt", "providers", "nativeModels"].includes(key))
    && Array.isArray(state.providers) && state.providers.every(validProvider)
    && Array.isArray(state.nativeModels) && state.nativeModels.every(validNativeModel);
}

function migrateState(value: unknown): CatalogState | null {
  if (validateCatalogState(value)) return value;
  if (!value || typeof value !== "object") return null;
  const legacy = value as any;
  if (legacy.version !== 1 || !validRate(legacy.updatedAt) || !Array.isArray(legacy.providers) || !legacy.providers.every(validProvider)) return null;
  return { version: 2, updatedAt: 0, providers: legacy.providers, nativeModels: [] };
}

export async function loadCatalogState(statePath = CATALOG_STATE_PATH): Promise<CatalogState | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(statePath, "utf8"));
    const state = migrateState(raw);
    if (!state) return null;
    const requiresInventoryRefresh = state.providers.some((provider) => provider.models.some((model) => model.available === undefined));
    return {
      ...state,
      ...(requiresInventoryRefresh ? { updatedAt: 0 } : {}),
      providers: state.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => {
          const migrated = { ...model, available: model.available ?? model.active };
          return migrated.cost && migrated.cost.input === 0 && migrated.cost.output === 0
            ? { ...migrated, cost: undefined, costProvenance: "unknown" }
            : migrated;
        }),
      })),
    };
  } catch {
    return null;
  }
}

/** Write a complete last-known-good state without ever including resolved credentials. */
export async function saveCatalogState(state: CatalogState, statePath = CATALOG_STATE_PATH): Promise<void> {
  if (!validateCatalogState(state)) throw new Error("Refusing to write invalid catalog state");
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, statePath);
    await chmod(statePath, 0o600);
  } catch (error) {
    throw error;
  }
}

export function canonicalIdsFromState(state: CatalogState | null): Map<string, string> {
  const ids = new Map<string, string>();
  for (const provider of state?.providers ?? []) {
    for (const model of provider.models) ids.set(`${provider.id}/${model.id}`, model.canonicalId);
  }
  for (const model of state?.nativeModels ?? []) ids.set(model.id, model.canonicalId);
  return ids;
}
