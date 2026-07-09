import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";

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
  /** Per-result freshness timestamp (ms since epoch). Set by every probe. Absent
   * on caches written before per-result freshness was introduced; treated as
   * stale by `getFreshCachedModelResult` so a single-model refresh is forced. */
  checkedAt?: number;
  /** End-to-end latency (ms) of the chat probe request, when measured. */
  latencyMs?: number;
  /** Estimated completion throughput (tokens/sec) from the 8-token probe sample. */
  tokensPerSecond?: number;
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
    const cache = JSON.parse(data) as CacheFile;
    // Migration: older caches have no per-result checkedAt. Stamp each entry
    // with the batch checkedAt so batch consumers (getFreshCachedResults) keep
    // working unchanged; single-model consumers (getFreshCachedModelResult)
    // will treat the entry as fresh-or-stale against the batch timestamp.
    if (cache?.results) {
      for (const result of cache.results) {
        if (result.checkedAt === undefined) result.checkedAt = cache.checkedAt;
      }
    }
    return cache;
  } catch {
    return null;
  }
}

async function writeCacheFile(results: ModelHealthResult[]): Promise<void> {
  const payload: CacheFile = { checkedAt: Date.now(), results };
  await writeFile(CACHE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function getFreshCachedResults(cacheTtlMs: number): Promise<ModelHealthResult[] | null> {
  const cache = await readCacheFile();
  if (!cache) return null;
  if (Date.now() - cache.checkedAt > cacheTtlMs) return null;
  return cache.results;
}

/** Read one model's cached result if it is fresh at the per-result level. */
export async function getFreshCachedModelResult(
  modelId: string,
  cacheTtlMs: number,
): Promise<ModelHealthResult | null> {
  const cache = await readCacheFile();
  if (!cache) return null;
  const entry = cache.results.find((r) => r.id === modelId);
  if (!entry) return null;
  const checkedAt = entry.checkedAt ?? cache.checkedAt;
  if (Date.now() - checkedAt > cacheTtlMs) return null;
  return entry;
}

/** Update exactly one model's entry in the cache, leaving all others and the
 * batch `checkedAt` untouched. Used by single-model refresh-on-demand so a
 * probe of one model cannot make stale entries for other models look fresh. */
export async function mergeModelResult(result: ModelHealthResult): Promise<void> {
  const cache = (await readCacheFile()) ?? { checkedAt: Date.now(), results: [] };
  const index = cache.results.findIndex((r) => r.id === result.id);
  if (index === -1) cache.results.push(result);
  else cache.results[index] = result;
  await writeFile(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

/** Probe a single model and merge its fresh result into the cache. Returns the
 * fresh result. Does not touch the batch `checkedAt` or any other entry. */
export async function probeModelHealth(
  modelId: string,
  ctx: ProbeContext,
): Promise<ModelHealthResult> {
  const allModels = await getEnabledModelsMetadata();
  const metadata = allModels.find((m) => m.id === modelId);
  if (!metadata) {
    const result: ModelHealthResult = {
      id: modelId,
      status: "not-found",
      error: "Model not found in enabled models or imageGenerationProviders",
      checkedAt: Date.now(),
    };
    await mergeModelResult(result);
    return result;
  }
  const result = await probeModel(metadata, ctx);
  await mergeModelResult(result);
  return result;
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
  metrics?: { latencyMs?: number; tokensPerSecond?: number },
): ModelHealthResult {
  return {
    id: metadata.id,
    status,
    ...(error ? { error } : {}),
    name: metadata.name,
    service: metadata.service || "chat",
    checkedAt: Date.now(),
    ...(metrics?.latencyMs !== undefined ? { latencyMs: metrics.latencyMs } : {}),
    ...(metrics?.tokensPerSecond !== undefined ? { tokensPerSecond: metrics.tokensPerSecond } : {}),
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

    const t0 = Date.now();
    const response = await completeSimple(
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
    const latencyMs = Date.now() - t0;

    // completeSimple does not throw on model-level errors; a non-ok stopReason
    // means the request reached the API but the model is not usable (e.g. it
    // aborted or errored mid-generation). Surface that as an error instead of
    // a false-positive "ok".
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return modelHealthResult(metadata, "error", response.errorMessage || `model stopped: ${response.stopReason}`, { latencyMs });
    }

    const outputTokens = response.usage?.output ?? 0;
    const tokensPerSecond = latencyMs > 0 && outputTokens > 0 ? outputTokens / (latencyMs / 1000) : undefined;
    return modelHealthResult(metadata, "ok", undefined, { latencyMs, ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}) });
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

  const prefix = usedCache ? "Model health (cached)" : "Model health";
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
  // Fail closed: no fresh health data -> no model is provably healthy.
  // A missing or stale cache must not silently promote every enabled model
  // (including unreachable ones, e.g. VPN-only) to "healthy".
  const cached = await getFreshCachedResults(options.cacheTtlMs ?? MODEL_HEALTH_CACHE_TTL_MS);
  if (!cached) return [];

  const healthyIds = new Set(cached.filter((result) => result.status === "ok").map((result) => result.id));
  // Fail closed: if the probe found zero healthy models, return [] rather than
  // falling back to the full list. The caller asked for *healthy* models.
  return models.filter((model) => healthyIds.has(model.id));
}

/** Build the /model-health table as pre-formatted monospaced lines: a header
 * line, a per-model table of available chat models with estimated throughput
 * and E2E latency, then one-line summaries for image-generation models and any
 * unavailable models. Pure: no I/O, no TUI — fully unit-testable. */
/** Minimal theme interface for the health table renderer. The real pi Theme
 * satisfies this; keeping it narrow avoids depending on the full Theme type. */
export interface HealthTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const PASSTHROUGH_HEALTH_THEME: HealthTheme = { fg: (_c, t) => t, bold: (t) => t };

/** Build the /model-health table as pre-formatted, theme-colored lines: a
 * header line, a per-model table of available chat models with estimated
 * throughput and E2E latency, then one-line summaries for image-generation
 * models and any unavailable models. Pure: no I/O, no TUI — fully unit-testable. */
/** Pi caps widget content at InteractiveMode.MAX_WIDGET_LINES (10). The widget
 * path passes this so the table compacts to fit (folds image/unavailable
 * counts into the header and drops decorations when short on space) instead
 * of being truncated with "... (widget truncated)". The notify path omits it
 * for the full layout. */
/** Build the /model-health table as pre-formatted, theme-colored lines: a
 * header line, a per-model table of available chat models with estimated
 * throughput and E2E latency, then summaries for image-generation models and
 * any unavailable models. Pure: no I/O, no TUI — fully unit-testable. */
export function formatHealthTable(
  results: ModelHealthResult[],
  theme: HealthTheme = PASSTHROUGH_HEALTH_THEME,
): string[] {
  const okChat = results.filter((r) => r.status === "ok" && (r.service || "chat") === "chat");
  const okImage = results.filter((r) => r.status === "ok" && r.service === "imageGeneration");
  const failing = results.filter((r) => r.status !== "ok");
  const healthy = okChat.length + okImage.length;

  const lines: string[] = [];
  lines.push(
    theme.fg("toolTitle", theme.bold(
      `Model health: ${healthy} enabled model${healthy === 1 ? "" : "s"} queryable`,
    )),
  );

  if (okChat.length > 0) {
    const NAME_W = 30;
    const truncate = (t: string) => (t.length > NAME_W ? `${t.slice(0, NAME_W - 1)}…` : t);
    const nameCol = (r: ModelHealthResult) => truncate(r.name || r.id.split("/")[1] || r.id).padEnd(NAME_W);
    const tpsCol = (r: ModelHealthResult) =>
      (r.tokensPerSecond !== undefined ? r.tokensPerSecond.toFixed(1) : "—").padStart(10);
    const latCol = (r: ModelHealthResult) =>
      (r.latencyMs !== undefined ? `${(r.latencyMs / 1000).toFixed(2)}s` : "—").padStart(11);

    lines.push("");
    lines.push(`  ${theme.fg("dim", `${"Model".padEnd(NAME_W)}  ${"Est. tok/s".padStart(10)}  ${"E2E latency".padStart(11)}`)}`);
    lines.push(`  ${theme.fg("dim", `${"─".repeat(NAME_W)}  ${"─".repeat(10)}  ${"─".repeat(11)}`)}`);
    for (const r of okChat) {
      lines.push(`  ${theme.fg("text", nameCol(r))}  ${theme.fg("toolOutput", tpsCol(r))}  ${theme.fg("toolOutput", latCol(r))}`);
    }
  }

  if (okImage.length > 0) {
    lines.push("");
    lines.push(
      theme.fg("muted",
        `${okImage.length} image generation model${okImage.length === 1 ? "" : "s"} (${okImage.map((r) => r.name || r.id).join(", ")})`,
      ),
    );
  }

  if (failing.length > 0) {
    lines.push("");
    lines.push(
      theme.fg("error",
        `Unavailable: ${failing.map((r) => `${r.id} (${r.error || r.status})`).join(", ")}`,
      ),
    );
  }

  return lines;
}

/** Custom-message renderer for the "model-health" chat entry. Builds a themed
 * Container of Text lines from the results carried in `message.details`. The
 * real Theme satisfies HealthTheme (fg/bold), so it is passed straight through
 * to formatHealthTable. */
function healthMessageRenderer(
  message: { details?: ModelHealthResult[] },
  _options: { expanded: boolean },
  theme: HealthTheme,
) {
  const container = new Container();
  for (const line of formatHealthTable(message.details ?? [], theme)) {
    container.addChild(new Text(line, 1, 0));
  }
  return container;
}

/** Render the /model-health table. In the TUI it appends the table to the chat
 * scrollback as a custom message (rendered by healthMessageRenderer) so it
 * persists with the conversation and is never replaced by generated text; in
 * non-interactive modes it falls back to a single multi-line notification. */
export async function renderHealthTable(
  results: ModelHealthResult[],
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  const ui = ctx.ui as {
    theme?: HealthTheme;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
  };
  const sendMessage = (pi as { sendMessage?: (message: unknown, options?: { triggerTurn?: boolean }) => Promise<void> }).sendMessage;
  if (ctx.mode === "tui" && typeof sendMessage === "function") {
    await sendMessage?.(
      { customType: "model-health", content: "", display: true, details: results },
      { triggerTurn: false },
    );
    return;
  }
  ui.notify?.(formatHealthTable(results, ui.theme ?? PASSTHROUGH_HEALTH_THEME).join("\n"), "info");
}

export default function modelHealthCheckExtension(pi: ExtensionAPI) {
  // Render /model-health results as a custom chat message (customMessageRenderer
  // appends a themed table to the chat scrollback). Registered once at load.
  pi.registerMessageRenderer?.("model-health", healthMessageRenderer as never);

  // Render the full health table on startup and on /reload (which re-emits
  // session_start with reason "reload"), so launch/reload match /model-health
  // instead of the legacy one-line toast. Skip "new"/"resume"/"fork" so
  // switching sessions does not re-render. Uses the fresh cache when available
  // and only re-probes when stale, so reload is instant unless the cache expired.
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "reload") return;
    const results = await checkModelHealth(ctx, { notify: false, cacheTtlMs: MODEL_HEALTH_CACHE_TTL_MS });
    await renderHealthTable(results, ctx, pi);
  });

  pi.registerCommand?.("model-health", {
    description: "Check availability of enabled models and update health cache",
    handler: async (_args, ctx) => {
      const results = await checkModelHealth(ctx, { notify: false, forceRefresh: true, cacheTtlMs: 3600_000 });
      await renderHealthTable(results, ctx, pi);
    },
  });
}
