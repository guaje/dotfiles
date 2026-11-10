import { exec } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { MODEL_HEALTH_CACHE_TTL_MS as POLICY_CACHE_TTL_MS, MODEL_PROBE_CONCURRENCY_LIMIT as POLICY_PROBE_CONCURRENCY_LIMIT } from "./policy.ts";
import { getModelHealthSettings } from "./settings.ts";

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODELS_PATH = path.resolve(__dirname, "../../models.json");
const SETTINGS_CONFIG_PATH = path.resolve(__dirname, "../../settings.config.json");
const SETTINGS_PATH = path.resolve(__dirname, "../../settings.json");
const CACHE_PATH = path.resolve(__dirname, "../../model-health-cache.json");

export const MODEL_HEALTH_CACHE_TTL_MS = POLICY_CACHE_TTL_MS;
export const MODEL_PROBE_CONCURRENCY_LIMIT = POLICY_PROBE_CONCURRENCY_LIMIT;
export const RELOAD_HEALTH_RENDER_DELAY_MS = 100;

interface ModelMetadata {
  id: string;
  name: string;
  reasoning?: boolean;
  service?: "chat" | "imageGeneration";
  source?: "auth" | "user";
  providerConfig?: Provider;
}

interface Provider {
  baseUrl?: string;
  apiKey?: string;
  models?: ModelMetadata[];
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
  /** End-to-end latency (ms) of the chat probe request, thinking included, when measured. */
  latencyMs?: number;
  /** Wall-clock ms from the probe request to the model's first generated token (thinking or
   * visible). Normally the gap between this and `latencyMs` is the decode window
   * `tokensPerSecond` is measured over; when `throughputSource` is "escalated" the timing comes
   * from the second sample and does not pair with `latencyMs`. Absent when the response streamed
   * no generated content or the cache entry predates first-token timing. */
  firstTokenMs?: number;
  /** Estimated completion throughput (tokens/sec) over the decode window (first generated token
   * to completion), not end to end: delegation routing adds probe latency and then divides
   * expected output by this number, so thinking time must be counted exactly once. Falls back to
   * end-to-end latency when the window is too short to divide by (see `probeTokensPerSecond`). */
  tokensPerSecond?: number;
  /** How `tokensPerSecond` was measured, so routing diagnostics can tell estimates apart:
   * "decode-window" first generated token to completion; "end-to-end" the window was too thin to
   * divide by; "escalated" the window came from a second, longer-answer probe of this same model
   * (see the escalation prompt); "truncated" the sample hit the output ceiling without visible
   * text, so the rate is generated-tokens-per-second end to end and says nothing about answering. */
  throughputSource?: "decode-window" | "end-to-end" | "escalated" | "truncated";
  /** Resource source bucket matching Pi's reload resource list style. */
  source?: "auth" | "user";
}

interface ProbeContext {
  modelRegistry: {
    find: (provider: string, modelId: string) => unknown;
    getAvailable?: () => Array<{ provider?: unknown; id?: unknown; name?: unknown }>;
    getApiKeyAndHeaders: (model: unknown) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
  };
  /** Pi's effective session scope. An empty list means all registry models. */
  scopedModels?: readonly { model: Record<string, unknown> }[];
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
  /** Wall-clock ceiling for one model probe, covering every attempt for that model. */
  probeTimeoutMs?: number;
  /** Set false to publish conservative end-to-end rates instead of paying for one longer-answer
   * probe when a model's decode window is too thin to time (see the probe escalation). */
  probeEscalation?: boolean;
}

/** Resolved per-probe runtime knobs, threaded from `health.*` settings or caller overrides. */
interface ProbeRuntime {
  probeTimeoutMs: number;
  probeEscalation: boolean;
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
        source: "user",
        providerConfig: modelsFile.providers[providerId],
      });
    }
  }

  return models;
}

async function getEnabledModelsMetadata(ctx?: ProbeContext): Promise<ModelMetadata[]> {
  // Chat inventory comes from the active runtime, not configuration files. This
  // exactly follows /scoped-models: an empty scope means every available model.
  if (ctx?.modelRegistry?.getAvailable) {
    let modelsFile: ModelsFile = { providers: {} };
    let settingsFile: SettingsFile = {};
    try {
      const [modelsData, settings] = await Promise.all([readFile(MODELS_PATH, "utf8"), getSettings()]);
      modelsFile = JSON.parse(modelsData) as ModelsFile;
      settingsFile = settings;
    } catch { /* Runtime chat inventory remains authoritative. */ }

    const userProviders = new Set(Object.keys(modelsFile.providers || {}));
    const scoped = ctx.scopedModels ?? [];
    const runtime = scoped.length ? scoped.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
    const chat = runtime.flatMap((model) => {
      const provider = typeof model.provider === "string" ? model.provider : "";
      const id = typeof model.id === "string" ? model.id : "";
      if (!provider || !id) return [];
      return [{
        id: `${provider}/${id}`,
        name: typeof model.name === "string" ? model.name : id,
        service: "chat" as const,
        source: userProviders.has(provider) ? "user" as const : "auth" as const,
      }];
    });
    // Image-generation remains explicitly configured and is intentionally not
    // inferred from chat registry records.
    return [...chat, ...getConfiguredImageGenerationModels(settingsFile, modelsFile)];
  }
  try {
    const [modelsData, settingsFile] = await Promise.all([
      readFile(MODELS_PATH, "utf8"),
      getSettings(),
    ]);

    const modelsFile = JSON.parse(modelsData) as ModelsFile;
    const enabledModelIds = settingsFile.enabledModels || [];
    const configuredModels = new Map<string, ModelMetadata>();
    const allMetadata: ModelMetadata[] = [];

    for (const [providerId, provider] of Object.entries(modelsFile.providers)) {
      for (const model of provider.models || []) {
        const fullId = `${providerId}/${model.id}`;
        configuredModels.set(fullId, model);
      }
    }

    for (const enabledId of enabledModelIds) {
      const configuredModel = configuredModels.get(enabledId);
      if (configuredModel) {
        allMetadata.push({ ...configuredModel, id: enabledId, service: "chat", source: "user" });
        continue;
      }

      const parts = splitModelId(enabledId);
      if (!parts) continue;

      const configuredProvider = modelsFile.providers[parts.provider];
      if (configuredProvider) {
        // Legacy static providers with model arrays still use that array as their
        // exact scope. Dynamic catalog providers have no array, so enabledModels
        // remains their exact synchronized eligibility list.
        if (Array.isArray(configuredProvider.models)) continue;
        allMetadata.push({ id: enabledId, name: parts.modelId, service: "chat", source: "user" });
        continue;
      }

      allMetadata.push({ id: enabledId, name: parts.modelId, service: "chat", source: "auth" });
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
  options: { probeTimeoutMs?: number; probeEscalation?: boolean } = {},
): Promise<ModelHealthResult> {
  const allModels = await getEnabledModelsMetadata(ctx);
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
  const configured = await getModelHealthSettings();
  const result = await probeModel(metadata, ctx, {
    probeTimeoutMs: options.probeTimeoutMs ?? configured.probeTimeoutMs,
    probeEscalation: options.probeEscalation ?? configured.probeEscalation,
  });
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
  metrics?: { latencyMs?: number; firstTokenMs?: number; tokensPerSecond?: number; throughputSource?: ModelHealthResult["throughputSource"] },
): ModelHealthResult {
  return {
    id: metadata.id,
    status,
    ...(error ? { error } : {}),
    name: metadata.name,
    service: metadata.service || "chat",
    source: metadata.source,
    checkedAt: Date.now(),
    ...(metrics?.latencyMs !== undefined ? { latencyMs: metrics.latencyMs } : {}),
    ...(metrics?.firstTokenMs !== undefined ? { firstTokenMs: metrics.firstTokenMs } : {}),
    ...(metrics?.tokensPerSecond !== undefined ? { tokensPerSecond: metrics.tokensPerSecond } : {}),
    ...(metrics?.throughputSource !== undefined ? { throughputSource: metrics.throughputSource } : {}),
  };
}

/** Image generation is a different shape of request from a chat probe, so it keeps its own
 * ceiling instead of `health.probeTimeoutMs`. */
const PROBE_IMAGE_TIMEOUT_MS = 10_000;

/**
 * One-shot deadline for a probe. `AbortSignal.timeout` is deliberately avoided: its timer is
 * unref'd, so in a process with nothing else scheduled (a test runner, or an idle CLI between
 * handles) the ceiling never fires and the awaited probe stays pending forever instead of
 * aborting. A ref'd timer makes the ceiling an actual ceiling; the caller must run `cancel()` in a
 * finally so a completed probe never leaves a timer behind.
 */
function probeDeadline(timeoutMs: number): { signal: AbortSignal; cancel(): void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`health probe exceeded its ${timeoutMs}ms ceiling`)),
    timeoutMs,
  );
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

async function probeImageGenerationModel(metadata: ModelMetadata): Promise<ModelHealthResult> {
  let cancelDeadline: (() => void) | undefined;
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

    const deadline = probeDeadline(PROBE_IMAGE_TIMEOUT_MS);
    cancelDeadline = deadline.cancel;
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
      signal: deadline.signal,
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
  } finally {
    cancelDeadline?.();
  }
}

/** Output ceiling for a chat probe. The prompt is one short sentence, so this only bounds the
 * sample; it has to leave room for thinking tokens now that probes run with thinking on. */
const PROBE_MAX_TOKENS = 512;

/** Standard probe prompt. Kept short on purpose: probe latency is itself a routing input
 * (`turns × latency + expectedOutput ÷ throughput`), so a longer sample would inflate every
 * predicted task, not just the measurement. */
const PROBE_PROMPT = "Write exactly one short sentence about the sea.";

/** Escalation prompt, used once for a model whose standard sample answered but decoded too few
 * tokens to time. Three sentences roughly triple the visible tail, which is what the decode window
 * needs; only models that measure into that regime pay for it. */
const PROBE_ESCALATION_PROMPT = "Write exactly three short sentences about the sea.";

/** Thinking levels ordered cheapest first. Every reasoning-capable model is probed at the
 * cheapest level it declares, never with thinking switched off: delegation routing turns probe
 * latency and tokens/sec into task ETA and a latency gate, so a fleet where some models think and
 * others do not gets ranked on thinking policy instead of speed. Pinning the cheapest level keeps
 * the samples comparable and bounded. */
const PROBE_THINKING_LEVELS = ["minimal", "low", "medium"] as const;

interface ProbeAttempt {
  target: any;
  options: { reasoning?: (typeof PROBE_THINKING_LEVELS)[number] };
}

interface ProbeRun {
  response: any;
  latencyMs: number;
  firstTokenMs?: number;
}

/** Cheapest thinking level the model declares (levels mapped to `null` are unsupported). Models
 * that declare no map get the cheapest generic level; pi-ai clamps the request to whatever the
 * provider actually supports, and the plain attempt below covers endpoints that reject it. */
function cheapestProbeThinkingLevel(model: any): (typeof PROBE_THINKING_LEVELS)[number] | undefined {
  if (!model?.reasoning) return undefined;
  const declared = PROBE_THINKING_LEVELS.find((level) => typeof model.thinkingLevelMap?.[level] === "string");
  return declared ?? PROBE_THINKING_LEVELS[0];
}

/** Ordered probe attempts for a model: the cheapest thinking-on request first, then the
 * registered model unchanged, so an endpoint that rejects the reasoning override is still probed
 * exactly as Pi would call it. Non-reasoning models have nothing to pin and go straight in. */
function probeAttemptsForModel(model: any): ProbeAttempt[] {
  const plain: ProbeAttempt = { target: model, options: {} };
  const level = cheapestProbeThinkingLevel(model);
  return level ? [{ target: model, options: { reasoning: level } }, plain] : [plain];
}

/** Events that carry model-generated content. The first one to arrive opens the decode window;
 * everything before it is queueing, prompt processing, and thinking time. */
const GENERATED_CONTENT_EVENTS = new Set([
  "thinking_start",
  "thinking_delta",
  "text_start",
  "text_delta",
  "toolcall_start",
  "toolcall_delta",
]);

/** Absolute noise floor for a decode window. An endpoint that buffers its whole answer emits the
 * first and last token together, so the window is a few milliseconds of serialization, not
 * generation; dividing by it would report absurd speed. */
const MIN_DECODE_WINDOW_MS = 100;

/** A window must also cover this share of the round trip. It bounds how far a decode rate can
 * drift above the end-to-end rate (at most 1/this ratio), so a sample too small to time reliably —
 * or a response that only trickles out at the very end — keeps its conservative end-to-end number. */
const MIN_DECODE_WINDOW_RATIO = 0.05;

/** Estimated completion throughput for a probe sample.
 *
 * Delegation routing builds a task ETA as `turns × probeLatency + expectedTokens ÷ probeTokSec`,
 * so thinking time may be counted once: it stays inside `latencyMs` (end to end, probed with
 * thinking enabled) and out of this denominator, which starts at the first generated token. That
 * definition is self-consistent per provider — endpoints that bill thinking tokens report them in
 * `usage.output` and stream them inside the window, endpoints that do not bill them stream only
 * visible text inside the window — so every model is measured as "tokens generated per second while
 * generating" instead of a rate distorted by thinking policy. */
export function probeTokensPerSecond(
  outputTokens: number,
  timing: { firstTokenMs?: number; elapsedMs: number },
): number | undefined {
  if (!(outputTokens > 0)) return undefined;
  const decodeMs = timing.firstTokenMs === undefined ? 0 : timing.elapsedMs - timing.firstTokenMs;
  const reliable = decodeMs >= MIN_DECODE_WINDOW_MS && decodeMs >= timing.elapsedMs * MIN_DECODE_WINDOW_RATIO;
  const windowMs = reliable ? decodeMs : timing.elapsedMs;
  if (!(windowMs > 0)) return undefined;
  return outputTokens / (windowMs / 1000);
}

/** What a single probe sample supports.
 * - `measurable`: answered naturally with a decode window long enough to divide by.
 * - `unmeasurable-window`: answered, but the window is too thin to time (typically a long think
 *   followed by ~12 visible tokens). This is the only verdict worth escalating.
 * - `truncated`: hit the output ceiling without emitting visible text, i.e. the ceiling was eaten
 *   entirely by thinking. Escalating such a model only buys more thinking, never an answer.
 * - `failed`: the request errored or aborted (handled by the attempt loop before classification).
 * - `no-usage`: the endpoint returned no token counts, so no rate exists and a longer sample
 *   would not create one. */
export type ProbeSampleVerdict = "measurable" | "unmeasurable-window" | "truncated" | "failed" | "no-usage";

export interface ProbeSample {
  stopReason: string;
  /** Characters of visible answer text; zero means the model never answered within the ceiling. */
  visibleChars: number;
  outputTokens: number;
  firstTokenMs?: number;
  elapsedMs: number;
}

/** Read a sample: which verdict it earns, and the throughput plus `throughputSource` to publish. */
export function probeSampleMetrics(sample: ProbeSample): {
  verdict: ProbeSampleVerdict;
  tokensPerSecond?: number;
  throughputSource?: NonNullable<ModelHealthResult["throughputSource"]>;
} {
  if (sample.stopReason === "error" || sample.stopReason === "aborted") return { verdict: "failed" };
  if (!(sample.outputTokens > 0)) return { verdict: "no-usage" };
  // A silent, ceiling-bounded sample still reports how fast it generated tokens, and those tokens
  // are all thinking. Measure it end to end: the decode window here says nothing about answers,
  // and a window rate would flatter a model that never produced one.
  if (sample.stopReason === "length" && sample.visibleChars === 0) {
    return {
      verdict: "truncated",
      ...(sample.elapsedMs > 0 ? { tokensPerSecond: sample.outputTokens / (sample.elapsedMs / 1000), throughputSource: "truncated" as const } : {}),
    };
  }

  const decodeMs = sample.firstTokenMs === undefined ? 0 : sample.elapsedMs - sample.firstTokenMs;
  if (decodeMs < MIN_DECODE_WINDOW_MS || decodeMs < sample.elapsedMs * MIN_DECODE_WINDOW_RATIO) {
    return {
      verdict: "unmeasurable-window",
      ...(probeTokensPerSecond(sample.outputTokens, { elapsedMs: sample.elapsedMs }) !== undefined
        ? { tokensPerSecond: probeTokensPerSecond(sample.outputTokens, { elapsedMs: sample.elapsedMs }), throughputSource: "end-to-end" as const }
        : {}),
    };
  }
  return {
    verdict: "measurable",
    ...(probeTokensPerSecond(sample.outputTokens, { firstTokenMs: sample.firstTokenMs, elapsedMs: sample.elapsedMs }) !== undefined
      ? { tokensPerSecond: probeTokensPerSecond(sample.outputTokens, { firstTokenMs: sample.firstTokenMs, elapsedMs: sample.elapsedMs }), throughputSource: "decode-window" as const }
      : {}),
  };
}

function sampleFromRun(run: ProbeRun): ProbeSample {
  const blocks: any[] = Array.isArray(run.response?.content) ? run.response.content : [];
  const visibleChars = blocks.reduce((total, block) => total + (block?.type === "text" ? String(block.text ?? "").length : 0), 0);
  return {
    stopReason: String(run.response?.stopReason ?? "stop"),
    visibleChars,
    outputTokens: run.response?.usage?.output ?? 0,
    firstTokenMs: run.firstTokenMs,
    elapsedMs: run.latencyMs,
  };
}

async function probeModel(metadata: ModelMetadata, ctx: ProbeContext, runtime: ProbeRuntime): Promise<ModelHealthResult> {
  let cancelDeadline: (() => void) | undefined;
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

    const requestFor = (prompt: string) => ({ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] });
    // One deadline per model, shared by every attempt including any escalation: a rejected override
    // costs only the time it actually took, and a wedged endpoint cannot quietly spend the ceiling twice.
    const deadline = probeDeadline(runtime.probeTimeoutMs);
    cancelDeadline = deadline.cancel;
    const runProbe = async (attempt: ProbeAttempt, prompt: string): Promise<ProbeRun> => {
      const start = Date.now();
      // Streaming instead of a single completion call is what makes first-token timing visible; the
      // stream is drained and its final message carries usage and stopReason. Pi's own adapters
      // return the stream synchronously, so awaiting costs only a microtask.
      const stream = (await streamSimple(
        attempt.target as never,
        requestFor(prompt) as never,
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: PROBE_MAX_TOKENS,
          signal: deadline.signal,
          ...attempt.options,
        },
      )) as unknown as AsyncIterable<{ type?: string }> & { result(): Promise<any> };

      let firstTokenAt: number | undefined;
      for await (const event of stream) {
        if (firstTokenAt === undefined && event?.type && GENERATED_CONTENT_EVENTS.has(event.type)) {
          firstTokenAt = Date.now();
        }
      }
      const response = await stream.result();
      const latencyMs = Date.now() - start;
      return {
        response,
        latencyMs,
        firstTokenMs: firstTokenAt === undefined ? undefined : Math.max(0, firstTokenAt - start),
      };
    };

    // Provider adapters do not throw on model-level errors; a non-ok stopReason means the request
    // reached the API but the model answered badly. Only the last attempt's failure is reported,
    // so a reasoning override an endpoint rejects falls back to the plain request.
    let success: ProbeRun | undefined;
    let successAttempt: ProbeAttempt | undefined;
    let failure: { error: string; latencyMs?: number } | undefined;
    for (const attempt of probeAttemptsForModel(model)) {
      try {
        const run = await runProbe(attempt, PROBE_PROMPT);
        if (run.response.stopReason === "error" || run.response.stopReason === "aborted") {
          success = undefined;
          failure = { error: run.response.errorMessage || `model stopped: ${run.response.stopReason}`, latencyMs: run.latencyMs };
          continue;
        }
        success = run;
        successAttempt = attempt;
        failure = undefined;
        break;
      } catch (error) {
        success = undefined;
        failure = { error: formatProbeError(error) };
      }
    }

    if (!success) {
      const failed = failure ?? { error: "Probe did not complete" };
      return modelHealthResult(metadata, "error", failed.error, failed.latencyMs !== undefined ? { latencyMs: failed.latencyMs } : undefined);
    }
    const { latencyMs, firstTokenMs } = success;

    // The standard sample decides health and latency. When it answered but decoded too few tokens
    // to time — a long think followed by ~12 visible tokens is exactly that — one escalation probe
    // asks for a longer answer so the decode window becomes measurable. It runs at most once per
    // model probe, never for a truncated (thinking-only) sample, and can only improve the rate:
    // status, latency, and the standard sample's numbers stay published if it does not measure.
    // `health.probeEscalation: false` (or the probeEscalation option) skips it entirely, leaving
    // those models on their conservative end-to-end rate.
    const standard = probeSampleMetrics(sampleFromRun(success));
    let metrics = standard;
    let metricsFirstTokenMs = firstTokenMs;
    if (runtime.probeEscalation && standard.verdict === "unmeasurable-window" && successAttempt) {
      try {
        const escalationRun = await runProbe(successAttempt, PROBE_ESCALATION_PROMPT);
        const escalation = probeSampleMetrics(sampleFromRun(escalationRun));
        if (escalation.verdict === "measurable" && escalation.tokensPerSecond !== undefined) {
          metrics = { verdict: escalation.verdict, tokensPerSecond: escalation.tokensPerSecond, throughputSource: "escalated" };
          metricsFirstTokenMs = escalationRun.firstTokenMs;
        }
      } catch {
        // The escalation is a bonus; whatever the standard sample measured stands.
      }
    }

    return modelHealthResult(metadata, "ok", undefined, {
      latencyMs,
      ...(metricsFirstTokenMs !== undefined ? { firstTokenMs: metricsFirstTokenMs } : {}),
      ...(metrics.tokensPerSecond !== undefined ? { tokensPerSecond: metrics.tokensPerSecond } : {}),
      ...(metrics.throughputSource !== undefined ? { throughputSource: metrics.throughputSource } : {}),
    });
  } catch (error) {
    return modelHealthResult(metadata, "error", formatProbeError(error));
  } finally {
    cancelDeadline?.();
  }
}

function resultDisplayName(result: ModelHealthResult): string {
  if (result.service !== "imageGeneration") return result.id;
  const name = result.name?.trim();
  return name || splitModelId(result.id)?.modelId || result.id;
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
  const configured = await getModelHealthSettings();
  const cacheTtlMs = options.cacheTtlMs ?? configured.cacheTtlMs;
  const concurrencyLimit = options.concurrencyLimit ?? configured.concurrency;
  const runtime: ProbeRuntime = {
    probeTimeoutMs: options.probeTimeoutMs ?? configured.probeTimeoutMs,
    probeEscalation: options.probeEscalation ?? configured.probeEscalation,
  };

  const models = await getEnabledModelsMetadata(ctx);

  if (!options.forceRefresh) {
    const cached = await getFreshCachedResults(cacheTtlMs);
    if (cached) {
      const cachedIds = new Set(cached.map((result) => result.id));
      const hasAllCurrentModels = models.every((model) => cachedIds.has(model.id));
      if (hasAllCurrentModels) {
        const cachedById = new Map(cached.map((result) => [result.id, result]));
        const currentCached = models.map((metadata) => {
          const result = cachedById.get(metadata.id)!;
          return {
            ...result,
            name: result.name ?? metadata.name,
            service: result.service ?? metadata.service,
            // Source is current registry/configuration metadata, not probe data.
            // Reclassify old caches immediately after provider ownership changes.
            source: metadata.source ?? result.source,
          };
        });
        if (options.notify) notifyProbeSummary(currentCached, ctx, true);
        return currentCached;
      }
    }
  }

  const results = await mapWithConcurrency(models, concurrencyLimit, (model) => probeModel(model, ctx, runtime));
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
  const configured = await getModelHealthSettings();
  const cached = await getFreshCachedResults(options.cacheTtlMs ?? configured.cacheTtlMs);
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
const MODEL_HEALTH_WIDGET_KEY = "model-health";

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

  const NAME_W = 30;
  const truncate = (t: string) => (t.length > NAME_W ? `${t.slice(0, NAME_W - 1)}…` : t);
  const nameCol = (r: ModelHealthResult) => truncate(resultDisplayName(r)).padEnd(NAME_W);
  const tpsCol = (r: ModelHealthResult) =>
    (r.tokensPerSecond !== undefined ? r.tokensPerSecond.toFixed(1) : "—").padStart(10);
  const latCol = (r: ModelHealthResult) =>
    (r.latencyMs !== undefined ? `${(r.latencyMs / 1000).toFixed(2)}s` : "—").padStart(11);
  const header = `${"Model".padEnd(NAME_W)}  ${"Est. tok/s".padStart(10)}  ${"E2E latency".padStart(11)}`;
  const separator = `${"─".repeat(NAME_W)}  ${"─".repeat(10)}  ${"─".repeat(11)}`;

  const lines: string[] = [];
  lines.push(theme.fg("mdHeading", "[Models]"));

  for (const source of ["auth", "user"] as const) {
    const group = okChat.filter((r) => (r.source ?? "auth") === source);
    if (group.length === 0) continue;
    lines.push(`  ${theme.fg("accent", source)}`);
    lines.push(theme.fg("dim", `    ${header}`));
    lines.push(theme.fg("dim", `    ${separator}`));
    for (const r of group) {
      lines.push(theme.fg("dim", `    ${nameCol(r)}  ${tpsCol(r)}  ${latCol(r)}`));
    }
  }

  if (okImage.length > 0) {
    lines.push(
      theme.fg("dim",
        `  ${okImage.length} image generation model${okImage.length === 1 ? "" : "s"} (${okImage.map((r) => r.name || r.id).join(", ")})`,
      ),
    );
  }

  if (failing.length > 0) {
    lines.push(
      `  ${theme.fg("error",
        `Unavailable: ${failing.map((r) => `${r.id} (${r.error || r.status})`).join(", ")}`,
      )}`,
    );
  }

  if (healthy === 0 && failing.length === 0) {
    lines.push(theme.fg("muted", "  No enabled models found."));
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

/** Clear the transient model-health widget, if the current UI supports it. */
export function clearHealthWidget(ctx: ExtensionContext): boolean {
  const ui = ctx.ui as {
    setWidget?: (
      key: string,
      content: ((tui: unknown, theme: HealthTheme) => { render?: (width?: number) => string[] | string; invalidate?: () => void }) | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ) => void;
  };
  if (ctx.mode !== "tui" || typeof ui.setWidget !== "function") return false;
  ui.setWidget(MODEL_HEALTH_WIDGET_KEY, undefined, { placement: "aboveEditor" });
  return true;
}

/** Render the model-health table. In the TUI it uses a replaceable transient
 * widget, matching /reload's non-persistent lifecycle: the table remains until
 * the next agent turn starts, then it is cleared. In non-interactive modes it
 * falls back to a single multi-line notification. */
export async function renderHealthTable(
  results: ModelHealthResult[],
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  const ui = ctx.ui as {
    theme?: HealthTheme;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
  };
  if (renderHealthWidget(results, ctx)) return;

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

/** Render model health as a replaceable TUI widget. This avoids persistent chat
 * entries and repeated reloads simply replace the previous table. */
export function renderHealthWidget(results: ModelHealthResult[], ctx: ExtensionContext): boolean {
  const ui = ctx.ui as {
    setWidget?: (
      key: string,
      content: ((tui: unknown, theme: HealthTheme) => { render?: (width?: number) => string[] | string; invalidate?: () => void }) | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ) => void;
  };
  if (ctx.mode !== "tui" || typeof ui.setWidget !== "function") return false;
  ui.setWidget(
    MODEL_HEALTH_WIDGET_KEY,
    (_tui, theme) => {
      const container = new Container();
      for (const line of formatHealthTable(results, theme ?? PASSTHROUGH_HEALTH_THEME)) {
        container.addChild(new Text(line, 1, 0));
      }
      return container;
    },
    { placement: "aboveEditor" },
  );
  return true;
}

export default function modelHealthCheckExtension(pi: ExtensionAPI) {
  // Render /model-health results as a custom chat message (customMessageRenderer
  // appends a themed table to the chat scrollback). Registered once at load.
  pi.registerMessageRenderer?.("model-health", healthMessageRenderer as never);

  // Match /reload's lifecycle: transient resource-style output is cleared when
  // the next prompt starts generating content.
  pi.on("before_agent_start", async (_event, ctx) => {
    clearHealthWidget(ctx);
  });

  // Render the full health table on startup and on /reload (which re-emits
  // session_start with reason "reload"), so launch/reload match /model-health
  // instead of the legacy one-line toast. Skip "new"/"resume"/"fork" so
  // switching sessions does not re-render. Uses the fresh cache when available
  // and only re-probes when stale, so reload is instant unless the cache expired.
  // Pi emits session_start during /reload before it appends the
  // "Reloaded keybindings..." status line, so the reload table is scheduled
  // shortly after the event returns to keep the status line above the table.
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "reload") return;
    const render = async () => {
      const results = await checkModelHealth(ctx, { notify: false });
      await renderHealthTable(results, ctx, pi);
    };
    if (event.reason === "reload") {
      globalThis.setTimeout(() => {
        void render().catch((error) => {
          console.error(`model-health reload render failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, RELOAD_HEALTH_RENDER_DELAY_MS);
      return;
    }
    await render();
  });

  pi.registerCommand?.("model-health", {
    description: "Check availability of enabled models and update health cache",
    handler: async (_args, ctx) => {
      const results = await checkModelHealth(ctx, { notify: false, forceRefresh: true, cacheTtlMs: 3600_000 });
      await renderHealthTable(results, ctx, pi);
    },
  });
}
