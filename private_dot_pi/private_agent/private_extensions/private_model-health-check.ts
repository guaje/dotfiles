import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODELS_PATH = path.resolve(__dirname, "../models.json");
const SETTINGS_CONFIG_PATH = path.resolve(__dirname, "../settings.config.json");
const SETTINGS_PATH = path.resolve(__dirname, "../settings.json");
const CACHE_PATH = path.resolve(__dirname, "../model-health-cache.json");

export const MODEL_HEALTH_CACHE_TTL_MS = 15 * 60 * 1000;
export const MODEL_PROBE_CONCURRENCY_LIMIT = 3;

interface ModelMetadata {
  id: string;
  name: string;
  reasoning?: boolean;
}

interface Provider {
  models: ModelMetadata[];
}

interface ModelsFile {
  providers: Record<string, Provider>;
}

interface SettingsFile {
  enabledModels?: string[];
}

interface CacheFile {
  checkedAt: number;
  results: ModelHealthResult[];
}

export interface ModelHealthResult {
  id: string;
  status: "ok" | "not-found" | "auth-missing" | "error";
  error?: string;
}

interface ProbeContext {
  modelRegistry: {
    find: (provider: string, modelId: string) => unknown;
    getApiKeyAndHeaders: (model: unknown) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
  };
  ui?: { notify: (message: string, level: "info" | "warning" | "error" | "success") => void };
}

export interface ModelHealthOptions {
  /** Notify user about health status */
  notify?: boolean;
  /** Force refresh cache */
  forceRefresh?: boolean;
  /** Cache TTL in milliseconds */
  cacheTtlMs?: number;
  /** Concurrency limit for probing */
  concurrencyLimit?: number;
}

async function readSettingsFile(filePath: string): Promise<SettingsFile | null> {
  try {
    const data = await readFile(filePath, "utf8");
    return JSON.parse(data) as SettingsFile;
  } catch {
    return null;
  }
}

async function getSettings(): Promise<SettingsFile> {
  return (await readSettingsFile(SETTINGS_CONFIG_PATH)) ||
         (await readSettingsFile(SETTINGS_PATH)) ||
         {};
}

function splitModelId(fullId: string): { provider: string; modelId: string } | null {
  const [provider, ...rest] = fullId.split("/");
  const modelId = rest.join("/");
  if (!provider || !modelId) return null;
  return { provider, modelId };
}

async function getEnabledModelsMetadata(): Promise<ModelMetadata[]> {
  try {
    const [modelsData, settingsFile] = await Promise.all([
      readFile(MODELS_PATH, "utf8"),
      getSettings(),
    ]);

    const modelsFile = JSON.parse(modelsData) as ModelsFile;
    const enabledModelIds = settingsFile.enabledModels || [];
    const allMetadata: ModelMetadata[] = [];

    for (const [providerId, provider] of Object.entries(modelsFile.providers)) {
      for (const model of provider.models) {
        const fullId = `${providerId}/${model.id}`;
        if (enabledModelIds.includes(fullId)) {
          allMetadata.push({ ...model, id: fullId });
        }
      }
    }

    for (const enabledId of enabledModelIds) {
      if (!allMetadata.find((model) => model.id === enabledId)) {
        allMetadata.push({ id: enabledId, name: enabledId.split("/")[1] || enabledId });
      }
    }

    return allMetadata;
  } catch (error) {
    console.error("Error reading model metadata for availability checks:", error);
    return [];
  }
}

function formatProbeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function readCacheFile(): Promise<CacheFile | null> {
  try {
    const data = await readFile(CACHE_PATH, "utf8");
    return JSON.parse(data) as CacheFile;
  } catch {
    return null;
  }
}

async function writeCacheFile(results: ModelHealthResult[]): Promise<void> {
  const payload: CacheFile = { checkedAt: Date.now(), results };
  await writeFile(CACHE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function getFreshCachedResults(cacheTtlMs: number): Promise<ModelHealthResult[] | null> {
  const cache = await readCacheFile();
  if (!cache) return null;
  if (Date.now() - cache.checkedAt > cacheTtlMs) return null;
  return cache.results;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= values.length) return;
      results[currentIndex] = await mapper(values[currentIndex]!, currentIndex);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(limit, values.length || 1)) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function probeModel(metadata: ModelMetadata, ctx: ProbeContext): Promise<ModelHealthResult> {
  const parts = splitModelId(metadata.id);
  if (!parts) {
    return { id: metadata.id, status: "error", error: "Invalid model id" };
  }

  const model = ctx.modelRegistry.find(parts.provider, parts.modelId);
  if (!model) {
    return { id: metadata.id, status: "not-found", error: "Model not found in registry" };
  }

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || (!auth.apiKey && !auth.headers)) {
      return {
        id: metadata.id,
        status: "auth-missing",
        error: auth.ok ? "No API key or request headers available" : (auth.error || "Authentication unavailable"),
      };
    }

    await completeSimple(
      model as never,
      {
        messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 8,
        signal: AbortSignal.timeout(10000),
      },
    );

    return { id: metadata.id, status: "ok" };
  } catch (error) {
    return { id: metadata.id, status: "error", error: formatProbeError(error) };
  }
}

function notifyProbeSummary(results: ModelHealthResult[], ctx: ProbeContext, usedCache: boolean): void {
  if (!ctx.ui) return;

  const prefix = usedCache ? "Model health check used cached results" : "Model health check checked model availability";
  const failing = results.filter((result) => result.status !== "ok");
  const healthy = results.filter((result) => result.status === "ok");

  if (healthy.length === 0) {
    ctx.ui.notify(`${prefix}: 0 of ${results.length} enabled model${results.length === 1 ? "" : "s"} queryable`, "warning");
    return;
  }

  const healthyNames = healthy.map((r) => r.id.split("/")[1] || r.id).join(", ");
  ctx.ui.notify(`${prefix}: ${healthy.length} enabled model${healthy.length === 1 ? "" : "s"} queryable (${healthyNames})`, "info");

  if (failing.length > 0) {
    const summary = failing.map((result) => `${result.id} (${result.error || result.status})`).join(", ");
    ctx.ui.notify(`${prefix}: ${failing.length} unavailable model${failing.length === 1 ? "" : "s"}: ${summary}`, "warning");
  }
}

export async function checkModelHealth(ctx: ProbeContext, options: ModelHealthOptions = {}): Promise<ModelHealthResult[]> {
  const cacheTtlMs = options.cacheTtlMs ?? MODEL_HEALTH_CACHE_TTL_MS;
  const concurrencyLimit = options.concurrencyLimit ?? MODEL_PROBE_CONCURRENCY_LIMIT;

  if (!options.forceRefresh) {
    const cached = await getFreshCachedResults(cacheTtlMs);
    if (cached) {
      if (options.notify) notifyProbeSummary(cached, ctx, true);
      return cached;
    }
  }

  const models = await getEnabledModelsMetadata();
  const results = await mapWithConcurrency(models, concurrencyLimit, (model) => probeModel(model, ctx));
  await writeCacheFile(results);

  if (options.notify) notifyProbeSummary(results, ctx, false);
  return results;
}

export async function getHealthyEnabledModels<T extends { id: string }>(
  models: T[],
  options: { cacheTtlMs?: number } = {},
): Promise<T[]> {
  const cached = await getFreshCachedResults(options.cacheTtlMs ?? MODEL_HEALTH_CACHE_TTL_MS);
  if (!cached) return models;

  const healthyIds = new Set(cached.filter((result) => result.status === "ok").map((result) => result.id));
  const healthy = models.filter((model) => healthyIds.has(model.id));
  return healthy.length > 0 ? healthy : models;
}

export default function modelHealthCheckExtension(pi: ExtensionAPI) {
  // Run health check once on initial startup (session_start) only.
  pi.on("session_start", async (_event, ctx) => {
    // Use a global flag so that a reload (which re‑imports this module) does not trigger another check.
    if ((globalThis as any).__modelHealthChecked) return;
    (globalThis as any).__modelHealthChecked = true;
    await checkModelHealth(ctx, { notify: true, cacheTtlMs: MODEL_HEALTH_CACHE_TTL_MS });
  });

  pi.registerCommand?.("model-health", {
    description: "Check availability of enabled models and update health cache",
    handler: async (_args, ctx) => {
      await checkModelHealth(ctx, { notify: true, forceRefresh: true, cacheTtlMs: 3600_000 });
    },
  });
}
