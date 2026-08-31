import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AuthoritativeCatalog, loadAuthoritativeCatalog, loadReviewedCosts, normalizeCost, uniqueNormalizedAuthoritativeMatch } from "./cost-sources.ts";
import { loadCatalogSettings, loadEnabledModels, loadProviderSettings, resolveProviderApiKey } from "./provider-settings.ts";
import { loadCatalogState, saveCatalogState } from "./state.ts";
import type { CatalogModel, CatalogProvider, CatalogState, CostRates, ProviderSettings, ThinkingLevelMap, ThinkingLevelMapProvenance } from "./types.ts";

const REQUEST_TIMEOUT_MS = 10_000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const numeric = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};
const rounded = (value: number) => Math.round(value * 1e12) / 1e12;
const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const RECOGNIZED_REASONING_EFFORTS = new Set(["none", "off", ...REASONING_EFFORTS]);
const THINKING_LEVELS = new Set(["off", ...REASONING_EFFORTS]);

type AuthoritativeSource = AuthoritativeCatalog | null | Promise<AuthoritativeCatalog | null>;

function roots(raw: Record<string, unknown>, info?: Record<string, unknown>): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  const add = (value: unknown) => { if (record(value) && !values.includes(value)) values.push(value); };
  add(raw);
  add(raw.model_info);
  add(raw.litellm_model_info);
  add(raw._info);
  add(info);
  if (info) {
    add(info.data);
    add(info.model_info);
    add(info.litellm_model_info);
    if (record(info.data)) {
      add(info.data.model_info);
      add(info.data.litellm_model_info);
    }
  }
  return values;
}

function firstNumber(sources: Record<string, unknown>[], keys: string[]): number | undefined {
  for (const source of sources) for (const key of keys) {
    const value = numeric(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstString(sources: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const source of sources) for (const key of keys) {
    if (typeof source[key] === "string" && source[key]) return source[key] as string;
  }
  return undefined;
}

function firstBoolean(sources: Record<string, unknown>[], keys: string[]): boolean | undefined {
  for (const source of sources) for (const key of keys) {
    if (typeof source[key] === "boolean") return source[key] as boolean;
  }
  return undefined;
}

/** Accept only the documented Pi shape; provider metadata remains untrusted input. */
function explicitThinkingLevelMapFrom(sources: Record<string, unknown>[]): ThinkingLevelMap | undefined {
  for (const source of sources) {
    const value = source.thinkingLevelMap ?? source.thinking_level_map;
    if (!record(value) || !Object.keys(value).length) continue;
    if (Object.entries(value).every(([level, target]) => THINKING_LEVELS.has(level) && (target === null || typeof target === "string" && target.length <= 4096 && !/[\x00-\x1f\x7f]/.test(target)))) return value as ThinkingLevelMap;
  }
  return undefined;
}

function derivedThinkingLevelMap(efforts: string[]): ThinkingLevelMap | undefined {
  const supported = new Set(efforts);
  const reasoning = REASONING_EFFORTS.filter((effort) => supported.has(effort));
  if (!reasoning.length) return undefined;
  const off = efforts.find((effort) => effort === "none" || effort === "off") ?? null;
  const map: ThinkingLevelMap = { off };
  for (const requested of REASONING_EFFORTS) {
    const requestedAt = REASONING_EFFORTS.indexOf(requested);
    map[requested] = supported.has(requested) ? requested : reasoning.find((effort) => REASONING_EFFORTS.indexOf(effort) >= requestedAt) ?? reasoning.at(-1)!;
  }
  return map;
}

function supportedReasoningEffortsMapFrom(sources: Record<string, unknown>[]): ThinkingLevelMap | undefined {
  for (const source of sources) {
    const key = Object.hasOwn(source, "supported_reasoning_efforts") ? "supported_reasoning_efforts"
      : Object.hasOwn(source, "supportedReasoningEfforts") ? "supportedReasoningEfforts"
      : undefined;
    if (!key) continue;
    const value = source[key];
    if (!Array.isArray(value) || !value.length || value.some((effort) => typeof effort !== "string" || !RECOGNIZED_REASONING_EFFORTS.has(effort)) || new Set(value).size !== value.length) continue;
    const map = derivedThinkingLevelMap(value as string[]);
    if (map) return map;
  }
  return undefined;
}

function supportedReasoningEffortFlagsMapFrom(sources: Record<string, unknown>[]): ThinkingLevelMap | undefined {
  for (const source of sources) {
    const flags = ["none", "off", ...REASONING_EFFORTS].map((effort) => [effort, source[`supports_${effort}_reasoning_effort`]] as const);
    const declared = flags.filter(([, value]) => value !== undefined);
    if (!declared.length || declared.some(([, value]) => typeof value !== "boolean")) continue;
    const map = derivedThinkingLevelMap(flags.filter(([, value]) => value === true).map(([effort]) => effort));
    if (map) return map;
  }
  return undefined;
}

interface ExtractedThinkingLevelMap {
  map: ThinkingLevelMap;
  provenance: Extract<ThinkingLevelMapProvenance, "provider" | "provider-inferred">;
}

function thinkingLevelMapFrom(sources: Record<string, unknown>[]): ExtractedThinkingLevelMap | undefined {
  const explicit = explicitThinkingLevelMapFrom(sources);
  if (explicit) return { map: explicit, provenance: "provider" };
  const efforts = supportedReasoningEffortsMapFrom(sources);
  if (efforts) return { map: efforts, provenance: "provider" };
  const flags = supportedReasoningEffortFlagsMapFrom(sources);
  return flags ? { map: flags, provenance: "provider-inferred" } : undefined;
}

function inputFrom(sources: Record<string, unknown>[]): ("text" | "image")[] {
  for (const source of sources) {
    const value = Array.isArray(source.input) ? source.input
      : Array.isArray(source.input_modalities) ? source.input_modalities
      : Array.isArray(source.modalities) ? source.modalities
      : undefined;
    if (value) {
      const input = value.filter((item): item is "text" | "image" => item === "text" || item === "image");
      if (input.length) return input;
    }
    if (record(source.capabilities) && source.capabilities.vision === true) return ["text", "image"];
    if (source.supports_vision === true) return ["text", "image"];
  }
  return ["text"];
}

function providerCost(sources: Record<string, unknown>[]): { cost?: CostRates; provenance?: string } {
  for (const source of sources) {
    const direct = normalizeCost(source.cost ?? source.pricing);
    if (direct) return { cost: direct, provenance: "provider:metadata" };
    const input = firstNumber([source], ["input_cost_per_token"]);
    const output = firstNumber([source], ["output_cost_per_token"]);
    if (input !== undefined && output !== undefined && (input > 0 || output > 0)) {
      return {
        cost: {
          input: rounded(input * 1_000_000),
          output: rounded(output * 1_000_000),
          cacheRead: rounded((firstNumber([source], ["cache_read_input_token_cost"]) ?? 0) * 1_000_000),
          cacheWrite: rounded((firstNumber([source], ["cache_creation_input_token_cost"]) ?? 0) * 1_000_000),
        },
        provenance: "provider:/model/info",
      };
    }
  }
  return {};
}

function serviceIsChat(id: string, sources: Record<string, unknown>[]): boolean {
  const explicit = firstString(sources, ["service", "service_type", "type", "mode"]);
  if (explicit && /embed|rerank|image|speech|audio|moderation|transcri/i.test(explicit)) return false;
  if (/^(embedding|bge-)/i.test(id)) return false;
  return !/(^|[-_.])(embed(?:ding|dings)?|rerank(?:er)?|whisper|tts|asr|image|moderation)([-_.]|$)/i.test(id);
}

function authoritativeIdentity(sources: Record<string, unknown>[]): string | undefined {
  return firstString(sources, ["catalog_id", "catalogId", "canonical_id", "canonicalId", "openrouter_api_id", "openrouter_id", "openrouterId"]);
}

function infoObject(body: unknown, modelId: string): Record<string, unknown> | undefined {
  if (!record(body)) return undefined;
  if (Array.isArray(body.data)) {
    const match = body.data.find((entry) => record(entry) && [entry.model_name, entry.model, entry.id].includes(modelId));
    return record(match) ? match : body;
  }
  return body;
}

function modelInfoUrls(baseUrl: string, modelId: string): string[] {
  const base = baseUrl.replace(/\/$/, "");
  const encoded = encodeURIComponent(modelId);
  const urls = base.endsWith("/v1")
    ? [`${base}/model/info?model=${encoded}`, `${base.slice(0, -3)}/model/info?model=${encoded}`]
    : [`${base}/v1/model/info?model=${encoded}`, `${base}/model/info?model=${encoded}`];
  return [...new Set(urls)];
}

async function fetchModelInfo(provider: ProviderSettings, modelId: string, headers: Record<string, string> | undefined, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
  for (const url of modelInfoUrls(provider.baseUrl, modelId)) {
    try {
      const response = await fetch(url, { headers, signal });
      if (!response.ok) continue;
      const parsed = infoObject(await response.json(), modelId);
      if (parsed) return parsed;
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  return undefined;
}

function modelFromApi(
  raw: Record<string, unknown>,
  info: Record<string, unknown> | undefined,
  provider: string,
  enabled: Set<string>,
  authoritative: AuthoritativeCatalog | null,
): CatalogModel | null {
  if (typeof raw.id !== "string" || !raw.id) return null;
  const id = raw.id;
  const sources = roots(raw, info);
  if (!serviceIsChat(id, sources)) return null;

  const externalId = authoritativeIdentity(sources);
  const exactFallback = authoritative?.models.get(externalId ?? id);
  const normalizedFallback = !exactFallback && !externalId && authoritative ? uniqueNormalizedAuthoritativeMatch(id, authoritative) : undefined;
  const fallback = exactFallback ?? normalizedFallback;
  const authoritativeProvenance = normalizedFallback ? `${authoritative?.provenance}:normalized-suffix:${normalizedFallback.id}` : authoritative?.provenance;
  const foundCost = providerCost(sources);
  const cost = foundCost.cost ?? fallback?.cost;
  const contextWindow = firstNumber(sources, ["contextWindow", "context_window", "context_length", "max_context_length", "max_input_tokens", "max_model_len", "max_sequence_length", "max_seq_len"])
    ?? fallback?.contextWindow;
  const maxTokens = firstNumber(sources, ["maxTokens", "max_tokens", "max_output_tokens", "max_completion_tokens"])
    ?? fallback?.maxTokens;
  const name = firstString(sources, ["name", "display_name", "label"]) ?? fallback?.name ?? id;
  const inferredReasoning = sources.some((source) => record(source.capabilities) && (source.capabilities.reasoning === true || source.capabilities.thinking === true));
  const thinking = thinkingLevelMapFrom(sources);
  const reasoning = firstBoolean(sources, ["reasoning", "supports_reasoning"]) ?? (inferredReasoning || (thinking ? true : undefined));
  const input = inputFrom(sources);

  return {
    id,
    name,
    canonicalId: externalId ?? fallback?.id ?? `${provider}/${id}`,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(thinking ? { thinkingLevelMap: thinking.map, thinkingLevelMapProvenance: thinking.provenance } : {}),
    input: input.length ? input : fallback?.input ?? ["text"],
    ...(contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : {}),
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    ...(cost ? { cost, costProvenance: foundCost.cost ? foundCost.provenance : authoritativeProvenance } : { costProvenance: "unknown" }),
    available: true,
    active: enabled.has(`${provider}/${id}`),
  };
}

async function resolveAuthoritativeCatalog(source: AuthoritativeSource | undefined, signal?: AbortSignal): Promise<AuthoritativeCatalog | null> {
  try {
    return source !== undefined ? await source : await loadAuthoritativeCatalog(signal);
  } catch {
    return null;
  }
}

export async function discoverProvider(provider: ProviderSettings, enabled: Set<string>, signal?: AbortSignal, source?: AuthoritativeSource, requestTimeoutMs = REQUEST_TIMEOUT_MS): Promise<CatalogProvider> {
  const apiKey = await resolveProviderApiKey(provider.apiKey);
  const headers = apiKey ? { authorization: `Bearer ${apiKey}`, accept: "application/json" } : { accept: "application/json" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models`, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`${provider.id} /models returned ${response.status}`);
    const body: unknown = await response.json();
    const inventory = Array.isArray(body) ? body : record(body) && Array.isArray(body.data) ? body.data : null;
    if (!inventory) throw new Error(`${provider.id} /models response has no data array`);
    const records = inventory.filter((value): value is Record<string, unknown> => record(value) && typeof value.id === "string");
    const authoritative = await resolveAuthoritativeCatalog(source, controller.signal);
    const discovered = (await Promise.all(records.map(async (raw) => {
      const runtimeId = `${provider.id}/${raw.id as string}`;
      const info = enabled.has(runtimeId) ? await fetchModelInfo(provider, raw.id as string, headers, controller.signal) : undefined;
      return modelFromApi(raw, info, provider.id, enabled, authoritative);
    }))).filter((model): model is CatalogModel => !!model);
    const byId = new Map(discovered.map((model) => [model.id, model]));
    const enabledPrefix = `${provider.id}/`;
    for (const fullId of enabled) {
      if (!fullId.startsWith(enabledPrefix)) continue;
      const id = fullId.slice(enabledPrefix.length);
      if (!id || byId.has(id)) continue;

      // enabledModels is the exact synchronized eligibility list. If /models
      // temporarily omits an enabled ID, query its detail endpoint and finally
      // synthesize safe baseline metadata; no per-model settings are required.
      const raw = { id };
      const info = await fetchModelInfo(provider, id, headers, controller.signal);
      const model = modelFromApi(raw, info, provider.id, enabled, authoritative);
      if (model) byId.set(id, model);
    }
    return {
      id: provider.id,
      baseUrl: provider.baseUrl,
      api: provider.api,
      ...(provider.compat ? { compat: provider.compat } : {}),
      models: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function mergeLastKnownGood(current: CatalogProvider[], previous: CatalogState | null, enabled: Set<string>): CatalogProvider[] {
  const oldProviders = new Map((previous?.providers ?? []).map((provider) => [provider.id, provider]));
  return current.map((provider) => {
    const old = new Map((oldProviders.get(provider.id)?.models ?? []).map((model) => [model.id, model]));
    const seen = new Set(provider.models.map((model) => model.id));
    const models = provider.models.map((model) => {
      const prior = old.get(model.id);
      const reviewedPrior = model.thinkingLevelMapProvenance === "provider-inferred" && prior?.thinkingLevelMapProvenance === "reviewed" && prior.thinkingLevelMap ? prior : undefined;
      return {
        ...model,
        ...(reviewedPrior?.reasoning !== undefined ? { reasoning: reviewedPrior.reasoning } : model.reasoning === undefined && prior?.reasoning !== undefined ? { reasoning: prior.reasoning } : {}),
        ...(reviewedPrior ? { thinkingLevelMap: reviewedPrior.thinkingLevelMap, thinkingLevelMapProvenance: "reviewed" as const } : !model.thinkingLevelMap && prior?.thinkingLevelMap ? { thinkingLevelMap: prior.thinkingLevelMap, ...(prior.thinkingLevelMapProvenance ? { thinkingLevelMapProvenance: prior.thinkingLevelMapProvenance } : {}) } : {}),
        ...(!model.contextWindow && prior?.contextWindow ? { contextWindow: prior.contextWindow } : {}),
        ...(!model.maxTokens && prior?.maxTokens ? { maxTokens: prior.maxTokens } : {}),
        ...(!model.cost && prior?.cost ? { cost: prior.cost, costProvenance: prior.costProvenance } : {}),
        available: true,
        active: enabled.has(`${provider.id}/${model.id}`),
      };
    });
    for (const prior of old.values()) {
      if (!seen.has(prior.id)) models.push({ ...prior, available: false, active: enabled.has(`${provider.id}/${prior.id}`) });
    }
    return { ...provider, models: models.sort((a, b) => a.id.localeCompare(b.id)) };
  });
}

function applyReviewedCosts(providers: CatalogProvider[], reviewed: ReadonlyMap<string, CostRates>): CatalogProvider[] {
  return providers.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => {
      if (model.cost) return model;
      const cost = reviewed.get(`${provider.id}/${model.id}`);
      return cost ? { ...model, cost, costProvenance: "reviewed-override" } : model;
    }),
  }));
}

function reconcileEnabled(state: CatalogState, enabled: Set<string>): CatalogState {
  return {
    ...state,
    providers: state.providers.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({ ...model, active: enabled.has(`${provider.id}/${model.id}`) })),
    })),
  };
}

export function providerModels(provider: CatalogProvider) {
  return provider.models.filter((model) => (model.available ?? model.active) || model.active).map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning ?? false,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: model.input,
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 16_384,
    // Pi requires a cost object. Catalog state preserves unknown provenance and
    // stats removes this request-only placeholder before calculating totals.
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
}

export function publishCatalog(pi: ExtensionAPI, state: CatalogState, settings: ProviderSettings[] = []): void {
  const byId = new Map(settings.map((setting) => [setting.id, setting]));
  for (const provider of state.providers) {
    const configured = byId.get(provider.id);
    pi.registerProvider(provider.id, {
      baseUrl: provider.baseUrl,
      api: provider.api as never,
      ...(configured?.apiKey ? { apiKey: configured.apiKey } : {}),
      ...(provider.compat ? { compat: provider.compat as never } : {}),
      models: providerModels(provider) as never,
    });
  }
}

export interface CatalogDependencies {
  loadProviderSettings: typeof loadProviderSettings;
  loadEnabledModels: typeof loadEnabledModels;
  loadCatalogSettings: typeof loadCatalogSettings;
  loadCatalogState: typeof loadCatalogState;
  saveCatalogState: typeof saveCatalogState;
  loadAuthoritativeCatalog: typeof loadAuthoritativeCatalog;
  loadReviewedCosts: typeof loadReviewedCosts;
}

const defaultDependencies: CatalogDependencies = { loadProviderSettings, loadEnabledModels, loadCatalogSettings, loadCatalogState, saveCatalogState, loadAuthoritativeCatalog, loadReviewedCosts };

/** Failure leaves the in-memory and persisted last-known-good catalog untouched. */
export async function refreshCatalog(pi: ExtensionAPI, signal?: AbortSignal, dependencies: Partial<CatalogDependencies> = {}): Promise<CatalogState> {
  const deps = { ...defaultDependencies, ...dependencies };
  const [settings, enabled, catalogSettings, previous, reviewed] = await Promise.all([deps.loadProviderSettings(), deps.loadEnabledModels(), deps.loadCatalogSettings(), deps.loadCatalogState(), deps.loadReviewedCosts()]);
  const source = deps.loadAuthoritativeCatalog(signal).catch(() => null);
  const discovered = await Promise.all(settings.map((provider) => discoverProvider(provider, enabled, signal, source, catalogSettings.requestTimeoutMs)));
  const providers = applyReviewedCosts(mergeLastKnownGood(discovered, previous, enabled), reviewed);
  const state: CatalogState = { version: 2, updatedAt: Date.now(), providers, nativeModels: previous?.nativeModels ?? [] };
  await deps.saveCatalogState(state);
  publishCatalog(pi, state, settings);
  return state;
}

const REVIEWABLE_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type ReviewedReasoningLevel = typeof REVIEWABLE_REASONING_LEVELS[number];

/** Derive Pi's requested efforts from the exact AA efforts that were reviewed. */
export function deriveReviewedThinkingLevelMap(levels: readonly ("off" | "low" | "medium" | "high" | "xhigh" | "max")[]): ThinkingLevelMap | undefined {
  const reviewed = REVIEWABLE_REASONING_LEVELS.filter((level) => levels.includes(level));
  // An AA off variant establishes no provider wire value. It is meaningful only
  // alongside reviewed reasoning variants, where Pi can safely clamp off itself.
  if (!reviewed.length) return undefined;
  const map: ThinkingLevelMap = { ...(levels.includes("off") ? { off: null } : {}), minimal: reviewed[0]! };
  for (const requested of REVIEWABLE_REASONING_LEVELS) {
    const exact = reviewed.includes(requested);
    const next = reviewed.find((level) => REVIEWABLE_REASONING_LEVELS.indexOf(level) >= REVIEWABLE_REASONING_LEVELS.indexOf(requested));
    map[requested] = exact ? requested : next ?? reviewed.at(-1)!;
  }
  return map;
}

/** Persist a reviewed complete specific set as Pi reasoning support for custom models only. */
export async function persistReviewedReasoning(runtimeId: string, levels: readonly ("off" | "low" | "medium" | "high" | "xhigh" | "max" | null)[], dependencies: Pick<CatalogDependencies, "loadProviderSettings" | "loadCatalogState" | "saveCatalogState"> = defaultDependencies): Promise<boolean> {
  if (!levels.length || levels.some((level) => level === null) || new Set(levels).size !== levels.length) return false;
  const slash = runtimeId.indexOf("/"); if (slash <= 0 || slash === runtimeId.length - 1) return false;
  const providerId = runtimeId.slice(0, slash); const modelId = runtimeId.slice(slash + 1);
  const [settings, state] = await Promise.all([dependencies.loadProviderSettings(), dependencies.loadCatalogState()]);
  if (!state || settings.find((provider) => provider.id === providerId)?.compat?.supportsReasoningEffort !== true) return false;
  const providerIndex = state.providers.findIndex((provider) => provider.id === providerId);
  const modelIndex = state.providers[providerIndex]?.models.findIndex((model) => model.id === modelId) ?? -1;
  if (providerIndex < 0 || modelIndex < 0) return false;
  const model = state.providers[providerIndex]!.models[modelIndex]!;
  const providerMap = model.thinkingLevelMap && (model.thinkingLevelMapProvenance === "provider" || model.thinkingLevelMapProvenance === undefined);
  if (providerMap && model.reasoning === true) return true;
  const thinkingLevelMap = providerMap ? model.thinkingLevelMap : deriveReviewedThinkingLevelMap(levels as ReviewedReasoningLevel[]);
  if (!thinkingLevelMap) return false;
  const providers = state.providers.map((provider, index) => index !== providerIndex ? provider : {
    ...provider, models: provider.models.map((entry, modelAt) => modelAt === modelIndex ? { ...entry, reasoning: true, thinkingLevelMap, ...(providerMap ? {} : { thinkingLevelMapProvenance: "reviewed" as const }) } : entry),
  });
  await dependencies.saveCatalogState({ ...state, providers });
  return true;
}

export async function restoreCatalog(pi: ExtensionAPI, dependencies: Partial<CatalogDependencies> = {}): Promise<CatalogState | null> {
  const deps = { ...defaultDependencies, ...dependencies };
  const [stored, settings, enabled] = await Promise.all([deps.loadCatalogState(), deps.loadProviderSettings(), deps.loadEnabledModels()]);
  if (!stored) return null;
  const state = reconcileEnabled(stored, enabled);
  publishCatalog(pi, state, settings);
  return state;
}
