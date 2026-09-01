import path from "node:path";
import { createSettingsStore } from "../08-settings/store.ts";
import { loadBenchmarkAssets } from "../04-subagents/benchmark-assets.ts";
import { qualifyBenchmarkProfiles } from "../04-subagents/benchmark-qualification.ts";
import type { BenchmarkThinkingLevel } from "../04-subagents/benchmark-types.ts";
import { refreshCatalog } from "./catalog.ts";
import { loadAuthoritativeCatalog, loadOllamaCloudCatalog, loadReviewedCosts, normalizeCost, ollamaCloudModel, uniqueNormalizedAuthoritativeMatch } from "./cost-sources.ts";
import { loadProviderSettings } from "./provider-settings.ts";
import { loadCatalogState, saveCatalogState } from "./state.ts";
import type { CatalogModel, CatalogState, CostRates, ThinkingLevelMap } from "./types.ts";
import { baseConfig, loadRequiredMappings } from "./aa/config.ts";
import { aaService, validateReviewedVariants, type AaCandidate, type AaReviewCatalog, type ArtifactState, type CleanupResult, type PublicationOptions, type PublicationResult, type ReviewedVariant } from "./aa/service.ts";
import { UUID, codePointCompare, isRecord } from "./aa/schema.ts";

export interface SafeRuntimeModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  supportsReasoningEffort?: boolean;
  input?: unknown;
  contextWindow?: number;
  maxTokens?: number;
  cost?: unknown;
  thinkingLevelMap?: ThinkingLevelMap;
}

export interface AaVariantReport {
  thinkingLevel: BenchmarkThinkingLevel;
  aaModelId: string;
  qualifiedProfiles: string[];
}

export interface SyncedModelReport {
  id: string;
  source: "custom" | "login";
  canonicalId: string;
  cost?: CostRates;
  costProvenance: string;
  variantCapable: boolean;
  aaVariants: AaVariantReport[];
  aaMissing: boolean;
  available: boolean;
}

export interface CatalogSyncReport {
  state: CatalogState;
  models: SyncedModelReport[];
  unresolvedCosts: string[];
  missingAa: string[];
}

export type AaReviewThinkingLevelOption = Exclude<BenchmarkThinkingLevel, null> | "generic";
/** AA review choices are constrained by verified runtime effort capability. */
export function aaReviewThinkingLevelOptions(variantCapable: boolean): AaReviewThinkingLevelOption[] {
  return variantCapable ? ["off", "low", "medium", "high", "xhigh", "max"] : ["generic"];
}

interface SyncContext {
  signal?: AbortSignal;
  scopedModels?: readonly { model: Record<string, unknown> }[];
  modelRegistry: { getAvailable(): Array<Record<string, unknown>> };
}

interface SyncDependencies {
  reconcileSettings(): Promise<unknown>;
  refreshCatalog: typeof refreshCatalog;
  loadProviderSettings: typeof loadProviderSettings;
  loadCatalogState: typeof loadCatalogState;
  saveCatalogState: typeof saveCatalogState;
  loadAuthoritativeCatalog: typeof loadAuthoritativeCatalog;
  loadReviewedCosts: typeof loadReviewedCosts;
  loadOllamaCloudCatalog: typeof loadOllamaCloudCatalog;
  loadBenchmarkAssets: typeof loadBenchmarkAssets;
  loadAaConfig: typeof baseConfig;
  loadAaMappings: typeof loadRequiredMappings;
}

const defaults: SyncDependencies = {
  reconcileSettings: () => createSettingsStore().syncEnabledModelsFromGenerated(),
  refreshCatalog,
  loadProviderSettings,
  loadCatalogState,
  saveCatalogState,
  loadAuthoritativeCatalog,
  loadReviewedCosts,
  loadOllamaCloudCatalog,
  loadBenchmarkAssets,
  loadAaConfig: baseConfig,
  loadAaMappings: loadRequiredMappings,
};

const runtimeId = (model: SafeRuntimeModel) => `${model.provider}/${model.id}`;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
function validThinkingLevelMap(value: unknown): value is ThinkingLevelMap {
  return isRecord(value) && Object.keys(value).length > 0 && Object.entries(value).every(([level, target]) => THINKING_LEVELS.has(level) && (target === null || typeof target === "string" && target.length <= 4096 && !/[\x00-\x1f\x7f]/.test(target)));
}
const safeRuntimeModel = (raw: Record<string, unknown>): SafeRuntimeModel | null => {
  if (typeof raw.provider !== "string" || typeof raw.id !== "string" || !raw.provider || !raw.id) return null;
  const thinkingLevelMap = validThinkingLevelMap(raw.thinkingLevelMap) ? { ...raw.thinkingLevelMap } : undefined;
  const compat = isRecord(raw.compat) ? raw.compat : undefined;
  const explicitSupportsReasoningEffort = typeof compat?.supportsReasoningEffort === "boolean" ? compat.supportsReasoningEffort : undefined;
  const supportsReasoningEffort = explicitSupportsReasoningEffort ?? (thinkingLevelMap ? true : undefined);
  return {
    provider: raw.provider,
    id: raw.id,
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    ...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(supportsReasoningEffort !== undefined ? { supportsReasoningEffort } : {}),
    ...(Array.isArray(raw.input) ? { input: raw.input } : {}),
    ...(typeof raw.contextWindow === "number" ? { contextWindow: raw.contextWindow } : {}),
    ...(typeof raw.maxTokens === "number" ? { maxTokens: raw.maxTokens } : {}),
    ...(raw.cost && typeof raw.cost === "object" ? { cost: raw.cost } : {}),
  };
};
function isOllamaCloudProvider(provider: string, settings: readonly { id: string; baseUrl: string }[]): boolean {
  if (provider === "ollama" || provider === "ollama-cloud") return true;
  return settings.some((setting) => setting.id === provider && (() => { try { return new URL(setting.baseUrl).hostname === "ollama.com"; } catch { return false; } })());
}

function exactAuthoritativeIds(id: string, canonicalId: string): string[] {
  const ids = new Set([canonicalId, id]);
  if (id.startsWith("openai-codex/")) ids.add(`openai/${id.slice("openai-codex/".length)}`);
  return [...ids];
}

function runtimeCost(model: SafeRuntimeModel): CostRates | undefined {
  return normalizeCost(model.cost);
}
function providerCatalogCost(model: CatalogModel | undefined): CostRates | undefined {
  if (!model?.cost || /^(?:authoritative:|ollama-cloud:|reviewed-override$)/.test(model.costProvenance ?? "")) return undefined;
  return model.cost;
}

function customModel(state: CatalogState, id: string): CatalogModel | undefined {
  const slash = id.indexOf("/");
  const provider = id.slice(0, slash);
  const model = id.slice(slash + 1);
  return state.providers.find((entry) => entry.id === provider)?.models.find((entry) => entry.id === model);
}

/** Synchronize metadata/prices for the current resolved scope. Raw auth/provider objects are projected before use. */
export async function syncEnabledModels(pi: any, ctx: SyncContext, dependencies: Partial<SyncDependencies> = {}): Promise<CatalogSyncReport> {
  const deps = { ...defaults, ...dependencies };
  await deps.reconcileSettings();
  const settings = await deps.loadProviderSettings();
  const configured = new Set(settings.map((provider) => provider.id));
  const availableBefore = ctx.modelRegistry.getAvailable().map(safeRuntimeModel).filter((model): model is SafeRuntimeModel => !!model);
  const nativeProviders = new Set(availableBefore.map((model) => model.provider).filter((provider) => !configured.has(provider)));
  for (const provider of configured) if (nativeProviders.has(provider)) throw new Error(`custom/native provider collision: ${provider}`);

  await deps.refreshCatalog(pi, ctx.signal);
  const state = await deps.loadCatalogState();
  if (!state) throw new Error("catalog state unavailable after refresh");

  const scopedRaw = ctx.scopedModels?.length ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
  const scoped = scopedRaw.map(safeRuntimeModel).filter((model): model is SafeRuntimeModel => !!model);
  const authoritative = await deps.loadAuthoritativeCatalog(ctx.signal).catch(() => null);
  let ollama: Awaited<ReturnType<typeof loadOllamaCloudCatalog>> | null | undefined;
  const loadOllamaOnce = async () => {
    if (ollama === undefined) ollama = await deps.loadOllamaCloudCatalog(ctx.signal).catch(() => null);
    return ollama;
  };
  const reviewed = await deps.loadReviewedCosts();
  const aaConfig = deps.loadAaConfig(process.env);
  const mappings = await deps.loadAaMappings(aaConfig).catch(() => { throw new Error("canonical AA mappings are unavailable or invalid"); });
  const assets = await deps.loadBenchmarkAssets(aaConfig.paths.snapshotRoot, aaConfig.limits.maxAgeMs).catch(() => null);
  const snapshotsByUuid = new Map((assets?.snapshots ?? []).map((snapshot) => [snapshot.modelId, snapshot]));
  const previousNative = new Map(state.nativeModels.map((model) => [model.id, { ...model, active: false }]));
  const reports: SyncedModelReport[] = [];

  for (const model of scoped.sort((a, b) => codePointCompare(runtimeId(a), runtimeId(b)))) {
    const id = runtimeId(model);
    const source = configured.has(model.provider) ? "custom" as const : "login" as const;
    const catalogModel = source === "custom" ? customModel(state, id) : undefined;
    const prior = previousNative.get(id);
    const reviewedAlias = mappings.find((entry) => `${entry.provider}/${entry.model}` === id);
    const canonicalId = reviewedAlias?.canonicalId ?? catalogModel?.canonicalId ?? prior?.canonicalId ?? id;
    const ollamaCloud = isOllamaCloudProvider(model.provider, settings);
    let ollamaModel: ReturnType<typeof ollamaCloudModel> | undefined;
    let cost = providerCatalogCost(catalogModel) ?? runtimeCost(model);
    let costProvenance = providerCatalogCost(catalogModel) ? catalogModel?.costProvenance ?? "provider-catalog" : (cost ? "runtime-registry" : "unknown");
    if (!cost && authoritative) {
      for (const exactId of exactAuthoritativeIds(id, canonicalId)) {
        const found = authoritative.models.get(exactId)?.cost;
        if (found) { cost = found; costProvenance = authoritative.provenance; break; }
      }
      if (!cost) {
        const matched = uniqueNormalizedAuthoritativeMatch(id, authoritative);
        if (matched?.cost) { cost = matched.cost; costProvenance = `${authoritative.provenance}:normalized-suffix:${matched.id}`; }
      }
    }
    if (!cost) {
      const ollamaCatalog = await loadOllamaOnce();
      ollamaModel = ollamaCatalog ? ollamaCloudModel(id, ollamaCatalog) : undefined;
      if (ollamaModel?.cost) { cost = ollamaModel.cost; costProvenance = `${ollamaCatalog!.provenance}:explicit-numeric-price`; }
    }
    if (!cost) {
      const fallback = reviewed.get(id);
      if (fallback) { cost = fallback; costProvenance = "reviewed-override"; }
      else if (ollamaModel?.available) costProvenance = "ollama-cloud:price-unpublished";
    }
    if (ollamaCloud && ollama === undefined) {
      const ollamaCatalog = await loadOllamaOnce();
      ollamaModel = ollamaCatalog ? ollamaCloudModel(id, ollamaCatalog) : undefined;
    }

    if (source === "login") {
      const input: ("text" | "image")[] = Array.isArray(model.input) && model.input.every((entry) => entry === "text" || entry === "image") ? model.input as ("text" | "image")[] : ["text"];
      previousNative.set(id, {
        id, canonicalId, name: model.name ?? model.id,
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap, thinkingLevelMapProvenance: "provider" as const } : {}),
        ...(model.supportsReasoningEffort !== undefined ? { supportsReasoningEffort: model.supportsReasoningEffort } : {}),
        input,
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
        ...(cost ? { cost } : {}), costProvenance, observedAt: Date.now(), ...(ollamaCloud && ollama ? { available: !!ollamaModel } : {}), active: true,
      });
    }

    const aaEntries = mappings.filter((entry) => `${entry.provider}/${entry.model}` === id || entry.canonicalId === canonicalId);
    const directSnapshots = (assets?.snapshots ?? []).filter((snapshot) => [`${snapshot.provider}/${snapshot.model}`].some((snapshotId) => snapshotId === id || snapshotId === canonicalId));
    const variants: AaVariantReport[] = [];
    for (const entry of aaEntries) {
      const snapshot = snapshotsByUuid.get(entry.aaModelId);
      if (!snapshot) continue;
      const qualifiedProfiles = qualifyBenchmarkProfiles({ input: Array.isArray(model.input) ? model.input as string[] : ["text"], contextWindow: model.contextWindow, maxTokens: model.maxTokens }, snapshot)
        .filter((qualification) => qualification.qualified).map((qualification) => qualification.profile);
      variants.push({ thinkingLevel: entry.thinkingLevel, aaModelId: entry.aaModelId, qualifiedProfiles });
    }
    for (const snapshot of directSnapshots) {
      if (variants.some((variant) => variant.aaModelId === snapshot.modelId)) continue;
      const qualifiedProfiles = qualifyBenchmarkProfiles({ input: Array.isArray(model.input) ? model.input as string[] : ["text"], contextWindow: model.contextWindow, maxTokens: model.maxTokens }, snapshot)
        .filter((qualification) => qualification.qualified).map((qualification) => qualification.profile);
      variants.push({ thinkingLevel: snapshot.thinkingLevel, aaModelId: snapshot.modelId, qualifiedProfiles });
    }
    variants.sort((a, b) => codePointCompare(`${a.thinkingLevel ?? ""}/${a.aaModelId}`, `${b.thinkingLevel ?? ""}/${b.aaModelId}`));
    const providerSettings = settings.find((provider) => provider.id === model.provider);
    const supportsReasoningEffort = source === "custom" ? providerSettings?.compat?.supportsReasoningEffort === true : model.supportsReasoningEffort;
    const variantCapable = supportsReasoningEffort === true && (model.reasoning === true || source === "custom");
    reports.push({ id, source, canonicalId, ...(cost ? { cost } : {}), costProvenance, variantCapable, aaVariants: variants, aaMissing: variants.length === 0, available: ollamaCloud && ollama ? !!ollamaModel : catalogModel?.available ?? true });
  }

  const nextState: CatalogState = { ...state, nativeModels: [...previousNative.values()].sort((a, b) => codePointCompare(a.id, b.id)) };
  await deps.saveCatalogState(nextState);
  return {
    state: nextState,
    models: reports,
    unresolvedCosts: reports.filter((model) => !model.cost).map((model) => model.id),
    missingAa: reports.filter((model) => model.aaMissing).map((model) => model.id),
  };
}

export type { AaCandidate };
export interface ReviewedAaVariant extends AaCandidate { thinkingLevel: BenchmarkThinkingLevel; }
export interface AaOperations {
  discover(modelId: string, signal?: AbortSignal): Promise<AaCandidate[]>;
  discoverMany?(modelIds: readonly string[], signal?: AbortSignal): Promise<Map<string, AaCandidate[]>>;
  discoverCatalog?(modelIds: readonly string[], signal?: AbortSignal): Promise<AaReviewCatalog>;
  replaceReviewedVariants(runtimeModelId: string, canonicalId: string, variants: ReviewedVariant[], signal?: AbortSignal, env?: NodeJS.ProcessEnv, reviewedCatalog?: AaReviewCatalog["catalog"], options?: PublicationOptions): Promise<PublicationResult>;
  captureArtifactState?(env?: NodeJS.ProcessEnv): Promise<ArtifactState>;
  cleanupObsoleteSnapshots?(signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<CleanupResult>;
}
export interface AaArtifactChange { kind: "M" | "A" | "D"; path: string; targetPath: string; }
export interface AaArtifactChangeSummary { changes: AaArtifactChange[]; warnings: string[]; }
export function netAaArtifactChanges(before: ArtifactState, after: ArtifactState, warnings: Iterable<string> = []): AaArtifactChangeSummary {
  const changes: AaArtifactChange[] = [];
  const changedMetadata = (prior: ArtifactState["manifest"], current: ArtifactState["manifest"]): void => {
    if (prior?.fingerprint === current?.fingerprint) return;
    const artifact = current ?? prior;
    if (artifact) changes.push({ kind: "M", path: artifact.path, targetPath: artifact.targetPath });
  };
  changedMetadata(before.manifest, after.manifest);
  changedMetadata(before.canonicalMappings, after.canonicalMappings);
  const beforeReferences = new Set(before.manifestSnapshotFiles), afterReferences = new Set(after.manifestSnapshotFiles);
  for (const file of [...afterReferences].sort(codePointCompare)) if (!beforeReferences.has(file)) changes.push({ kind: "A", path: `models/${file}`, targetPath: path.resolve(after.snapshotRoot, "models", file) });
  const afterGenerated = new Set(after.generatedSnapshotFiles);
  for (const file of [...new Set(before.generatedSnapshotFiles)].sort(codePointCompare)) if (!afterGenerated.has(file)) changes.push({ kind: "D", path: `models/${file}`, targetPath: path.resolve(before.snapshotRoot, "models", file) });
  return { changes, warnings: [...new Set(warnings)].sort(codePointCompare) };
}
export async function captureAaArtifactState(operations: AaOperations = aaService): Promise<ArtifactState> {
  if (!operations.captureArtifactState) throw new Error("AA artifact state capture is unavailable");
  return operations.captureArtifactState();
}
export async function cleanupAaObsoleteSnapshots(signal?: AbortSignal, operations: AaOperations = aaService): Promise<CleanupResult> {
  if (!operations.cleanupObsoleteSnapshots) throw new Error("AA snapshot cleanup is unavailable");
  return operations.cleanupObsoleteSnapshots(signal);
}
/** Finalize interactive AA work only after the sync's decisive catalog reconciliation. */
export async function finalizeAaSync<Report>(
  report: Report,
  publishedAaSucceeded: boolean,
  changedAaGeneration: boolean,
  initialArtifactState: ArtifactState | null,
  warnings: string[],
  signal: AbortSignal | undefined,
  finalReconcile: () => Promise<Report>,
  operations: AaOperations = aaService,
): Promise<{ report: Report; aaArtifacts?: AaArtifactChangeSummary }> {
  if (!publishedAaSucceeded) return { report };
  const finalReport = await finalReconcile();
  if (!changedAaGeneration) return { report: finalReport };

  try { warnings.push(...(await cleanupAaObsoleteSnapshots(signal, operations)).warnings); }
  catch { warnings.push("AA snapshot cleanup was unavailable"); }
  let after: ArtifactState | null = null;
  try { after = await captureAaArtifactState(operations); }
  catch { warnings.push("AA artifact state capture was unavailable"); }
  const normalizedWarnings = [...new Set(warnings)].sort(codePointCompare);
  return {
    report: finalReport,
    aaArtifacts: initialArtifactState && after
      ? netAaArtifactChanges(initialArtifactState, after, normalizedWarnings)
      : { changes: [], warnings: normalizedWarnings },
  };
}

function safeAaCandidates(candidates: AaCandidate[]): AaCandidate[] {
  return candidates.filter((candidate) => UUID.test(candidate.aaModelId) && !/[\x00-\x1f\x7f]/.test(`${candidate.slug}${candidate.name}`));
}
export async function discoverAaCandidates(modelId: string, signal?: AbortSignal, operations: AaOperations = aaService): Promise<AaCandidate[]> {
  return safeAaCandidates(await operations.discover(modelId, signal));
}
/** One free-catalog fetch produces advisory candidates for the full interactive sync. */
export async function discoverAaCandidatesForModels(modelIds: readonly string[], signal?: AbortSignal, operations: AaOperations = aaService): Promise<Map<string, AaCandidate[]>> {
  if (!operations.discoverMany) return new Map(await Promise.all(modelIds.map(async (id) => [id, await discoverAaCandidates(id, signal, operations)] as const)));
  const suggestions = await operations.discoverMany(modelIds, signal);
  return new Map(modelIds.map((id) => [id, safeAaCandidates(suggestions.get(id) ?? [])]));
}
/** Keep the exact free-catalog response available for every confirmed publication in one TUI sync. */
export async function prepareAaCandidateReview(modelIds: readonly string[], signal?: AbortSignal, operations: AaOperations = aaService): Promise<{ suggestions: Map<string, AaCandidate[]>; catalog?: AaReviewCatalog["catalog"] }> {
  if (!operations.discoverCatalog) return { suggestions: await discoverAaCandidatesForModels(modelIds, signal, operations) };
  const review = await operations.discoverCatalog(modelIds, signal);
  return { catalog: review.catalog, suggestions: new Map(modelIds.map((id) => [id, safeAaCandidates(review.candidates.get(id) ?? [])])) };
}
export function validateReviewedAaVariants(variants: ReviewedAaVariant[]): void { validateReviewedVariants(variants as ReviewedVariant[]); }
/** A TUI review may publish only after every displayed advisory candidate was assigned a level. */
export function isCompleteAaCandidateReview(candidates: readonly AaCandidate[], reviewed: readonly AaCandidate[]): boolean {
  const reviewedIds = new Set(reviewed.map((candidate) => candidate.aaModelId));
  return candidates.every((candidate) => reviewedIds.has(candidate.aaModelId));
}
/** Detect a generic mapping in an existing reviewed AA variant batch. */
export function hasGenericAaMapping(variants: readonly Pick<AaVariantReport, "thinkingLevel">[]): boolean {
  return variants.some((variant) => variant.thinkingLevel === null);
}
/** Publish a complete reviewed set in-process while baseline selection and publication share one writer lock. */
export async function publishReviewedAaVariants(runtimeModelId: string, canonicalId: string, variants: ReviewedAaVariant[], signal?: AbortSignal, operations: AaOperations = aaService, reviewedCatalog?: AaReviewCatalog["catalog"]): Promise<PublicationResult> {
  validateReviewedAaVariants(variants); return operations.replaceReviewedVariants(runtimeModelId, canonicalId, variants as ReviewedVariant[], signal, undefined, reviewedCatalog, { prune: false });
}
