import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai";

const execAsync = promisify(exec);

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
  service?: "chat" | "imageGeneration";
  providerConfig?: Provider;
}

interface Provider {
  baseUrl?: string;
  apiKey?: string;
  models: ModelMetadata[];
  services?: {
    imageGeneration?: ModelMetadata[];
  };
}

interface ModelsFile {
  providers: Record<string, Provider>;
}

interface SettingsFile {
  enabledModels?: string[];
  imageGenerationProviders?: Record<string, { models?: ModelMetadata[] }>;
}

interface CacheFile {
  checkedAt: number;
  results: ModelHealthResult[];
}

export interface ModelHealthResult {
  id: string;
  status: "ok" | "not-found" | "auth-missing" | "error";
  error?: string;
  name?: string;
  service?: "chat" | "imageGeneration";
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
  const [settingsFile, settingsConfigFile] = await Promise.all([
    readSettingsFile(SETTINGS_PATH),
    readSettingsFile(SETTINGS_CONFIG_PATH),
  ]);

  return {
    ...(settingsFile || {}),
    ...(settingsConfigFile || {}),
    enabledModels: settingsConfigFile?.enabledModels ?? settingsFile?.enabledModels,
    imageGenerationProviders: settingsConfigFile?.imageGenerationProviders ?? settingsFile?.imageGenerationProviders,
  };
}

function splitModelId(fullId: string): { provider: string; modelId: string } | null {
  const [provider, ...rest] = fullId.split("/");
  const modelId = rest.join("/");
  if (!provider || !modelId) return null;
  return { provider, modelId };
}

function getConfiguredImageGenerationModels(settingsFile: SettingsFile, modelsFile: ModelsFile): ModelMetadata[] {
  const configuredProviders = settingsFile.imageGenerationProviders || {};
  const models: ModelMetadata[] = [];

  for (const [providerId, provider] of Object.entries(configuredProviders)) {
    for (const model of provider.models || []) {
      const fullId = `${providerId}/${model.id}`;
      models.push({
        ...model,
        id: fullId,
        name: model.name || model.id,
        service: "imageGeneration",
        providerConfig: modelsFile.providers[providerId],
      });
    }
  }

  return models;
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
          allMetadata.push({ ...model, id: fullId, service: "chat" });
        }
      }
    }

    for (const enabledId of enabledModelIds) {
      if (allMetadata.find((model) => model.id === enabledId)) continue;

      const parts = splitModelId(enabledId);
      if (!parts) continue;

      // Built-in providers may not be listed in models.json, but if a provider is
      // listed there, treat its model list as the scoped set for that provider.
      // This avoids probing stale enabled entries for provider-scoped models that
      // are no longer available to this account.
      if (Object.hasOwn(modelsFile.providers, parts.provider)) continue;

      allMetadata.push({ id: enabledId, name: parts.modelId, service: "chat" });
    }

    allMetadata.push(...getConfiguredImageGenerationModels(settingsFile, modelsFile));

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

async function resolveApiKey(value: string | undefined): Promise<string> {
  if (!value) return "";
  if (value.startsWith("$")) return process.env[value.slice(1)] || "";
  if (value.startsWith("!")) {
    const { stdout } = await execAsync(value.slice(1));
    return stdout.trim();
  }
  return value;
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

function modelHealthResult(
  metadata: ModelMetadata,
  status: ModelHealthResult["status"],
  error?: string,
): ModelHealthResult {
  return {
    id: metadata.id,
    status,
    ...(error ? { error } : {}),
    name: metadata.name,
    service: metadata.service || "chat",
  };
}

async function probeImageGenerationModel(metadata: ModelMetadata): Promise<ModelHealthResult> {
  const parts = splitModelId(metadata.id);
  if (!parts) {
    return modelHealthResult(metadata, "error", "Invalid model id");
  }

  const provider = metadata.providerConfig;
  if (!provider) {
    return modelHealthResult(metadata, "not-found", "Image generation provider not found in models.json");
  }

  if (!provider.baseUrl) {
    return modelHealthResult(metadata, "error", "Image generation provider is missing baseUrl");
  }

  try {
    const apiKey = await resolveApiKey(provider.apiKey);
    if (!apiKey) {
      return modelHealthResult(metadata, "auth-missing", "No API key available");
    }

    const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/images/generations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: parts.modelId,
        prompt: "Health check image: a simple solid color square. No text.",
        n: 1,
        size: "16x16",
        response_format: "b64_json",
      }),
      signal: AbortSignal.timeout(10000),
    });

    const text = await response.text();
    if (!response.ok) {
      return modelHealthResult(
        metadata,
        response.status === 404 ? "not-found" : "error",
        `Image generation request failed (${response.status}): ${text}`,
      );
    }

    const item = (JSON.parse(text) as { data?: Array<{ b64_json?: unknown; url?: unknown }> }).data?.[0];
    if (typeof item?.b64_json !== "string" && typeof item?.url !== "string") {
      return modelHealthResult(metadata, "error", "Image generation response did not include b64_json or url");
    }

    return modelHealthResult(metadata, "ok");
  } catch (error) {
    return modelHealthResult(metadata, "error", formatProbeError(error));
  }
}

async function probeModel(metadata: ModelMetadata, ctx: ProbeContext): Promise<ModelHealthResult> {
  if (metadata.service === "imageGeneration") {
    return probeImageGenerationModel(metadata);
  }

  const parts = splitModelId(metadata.id);
  if (!parts) {
    return modelHealthResult(metadata, "error", "Invalid model id");
  }

  const model = ctx.modelRegistry.find(parts.provider, parts.modelId);
  if (!model) {
    return modelHealthResult(metadata, "not-found", "Model not found in registry");
  }

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || (!auth.apiKey && !auth.headers)) {
      return modelHealthResult(metadata, "auth-missing", auth.ok ? "No API key or request headers available" : (auth.error || "Authentication unavailable"));
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

    return modelHealthResult(metadata, "ok");
  } catch (error) {
    return modelHealthResult(metadata, "error", formatProbeError(error));
  }
}

function resultDisplayName(result: ModelHealthResult): string {
  return result.name || result.id.split("/")[1] || result.id;
}

function serviceLabel(service: ModelHealthResult["service"], count: number): string {
  if (service === "imageGeneration") {
    return `image generation model${count === 1 ? "" : "s"}`;
  }
  return `chat model${count === 1 ? "" : "s"}`;
}

function formatHealthySummary(healthy: ModelHealthResult[]): string {
  const byService = new Map<ModelHealthResult["service"], ModelHealthResult[]>();
  for (const result of healthy) {
    const service = result.service || "chat";
    byService.set(service, [...(byService.get(service) || []), result]);
  }

  const groups: string[] = [];
  for (const service of ["chat", "imageGeneration"] as const) {
    const group = byService.get(service) || [];
    if (group.length === 0) continue;
    groups.push(`${group.length} ${serviceLabel(service, group.length)} (${group.map(resultDisplayName).join(", ")})`);
  }

  return groups.join(", ");
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

  const details = formatHealthySummary(healthy);
  ctx.ui.notify(`${prefix}: ${healthy.length} enabled model${healthy.length === 1 ? "" : "s"} queryable. ${details}`, "info");

  if (failing.length > 0) {
    const summary = failing.map((result) => `${result.id} (${result.error || result.status})`).join(", ");
    ctx.ui.notify(`${prefix}: ${failing.length} unavailable model${failing.length === 1 ? "" : "s"}: ${summary}`, "warning");
  }
}

export async function checkModelHealth(ctx: ProbeContext, options: ModelHealthOptions = {}): Promise<ModelHealthResult[]> {
  const cacheTtlMs = options.cacheTtlMs ?? MODEL_HEALTH_CACHE_TTL_MS;
  const concurrencyLimit = options.concurrencyLimit ?? MODEL_PROBE_CONCURRENCY_LIMIT;

  const models = await getEnabledModelsMetadata();

  if (!options.forceRefresh) {
    const cached = await getFreshCachedResults(cacheTtlMs);
    if (cached) {
      const currentIds = new Set(models.map((model) => model.id));
      const cachedIds = new Set(cached.map((result) => result.id));
      const hasAllCurrentModels = models.every((model) => cachedIds.has(model.id));
      if (hasAllCurrentModels) {
        const currentCached = cached.filter((result) => currentIds.has(result.id));
        if (options.notify) notifyProbeSummary(currentCached, ctx, true);
        return currentCached;
      }
    }
  }

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
