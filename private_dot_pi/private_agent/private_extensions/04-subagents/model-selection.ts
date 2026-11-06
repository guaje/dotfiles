import { getFreshCachedModelResult, mergeModelResult, probeModelHealth } from "../06-health/index.ts";
import { getModelHealthSettings } from "../06-health/settings.ts";
import { DEFAULT_SNAPSHOT_ROOT, ROUTING_POLICY, loadBenchmarkAssets, loadBenchmarkHealth, validateRoutingPolicy } from "./benchmark-assets.ts";
import { loadRoutingBenchmarkAssets } from "./benchlm-assets.ts";
import { candidateHasCapabilities, evaluateBenchmarkGates, type BenchmarkGateMode } from "./benchmark-qualification.ts";
import { routeBenchmarkModel, type LocalHealth } from "./benchmark-routing.ts";
import { parseRoutingProfile } from "./task-profile.ts";
import type { BenchmarkRouteDiagnostics, RoutingProfile, ThinkingLevel } from "./benchmark-types.ts";
import { getSubagentExecutionSettings } from "./settings.ts";
import { normalizeModelMetadata, type ModelMetadata } from "./model-metadata.ts";
import { incrementExplorationCounter, loadOutcomeStore, summarizeOutcomes } from "./outcomes.ts";

export type { ThinkingLevel } from "./benchmark-types.ts";
export type { ModelMetadata } from "./model-metadata.ts";
export interface ModelSelectionResult { modelId?: string; thinkingLevel?: ThinkingLevel; selector?: "benchmark" | "interim"; benchmarkRoute?: BenchmarkRouteDiagnostics }
export interface SelectionDependencies { probe?: (modelId: string) => Promise<LocalHealth>; merge?: (result: LocalHealth) => Promise<void>; now?: () => number; }
export interface SelectionOptions { task?: string; routingProfile?: unknown; thinking?: ThinkingLevel; models?: ModelMetadata[]; snapshotRoot?: string; benchLmRoot?: string; snapshotMaxAgeMs?: number; probeContext?: unknown; dependencies?: SelectionDependencies; }

export function getEnabledModelsMetadata(scopedModels: readonly { model: Record<string, unknown> }[], availableModels: readonly Record<string, unknown>[], canonicalIds: ReadonlyMap<string, string> = new Map()): ModelMetadata[] {
  const source = scopedModels.length ? scopedModels.map((entry) => entry.model) : availableModels;
  return source.flatMap((model) => { const provider = typeof model.provider === "string" ? model.provider : "", runtimeId = provider && typeof model.id === "string" ? `${provider}/${model.id}` : ""; return provider ? [normalizeModelMetadata(provider, model, typeof (model.compat as Record<string, unknown> | undefined)?.supportsReasoningEffort === "boolean" ? (model.compat as Record<string, boolean>).supportsReasoningEffort : undefined, canonicalIds.get(runtimeId))].filter((value): value is ModelMetadata => !!value) : []; }).sort((a, b) => a.id.localeCompare(b.id));
}
const refreshFlights = new Map<unknown, Promise<Map<string, LocalHealth>>>();
async function refreshHealth(models: ModelMetadata[], profile: RoutingProfile, snapshots: any[], ttl: number, concurrency: number, budgetMs: number, dependencies: SelectionDependencies, probeContext?: unknown): Promise<Map<string, LocalHealth>> {
  const cached = new Map<string, LocalHealth>(); const stale: ModelMetadata[] = [];
  for (const model of models) { const entry = await getFreshCachedModelResult(model.id, ttl); if (entry) cached.set(model.id, entry as LocalHealth); else stale.push(model); }
  if (!stale.length) return cached;
  const flightKey = probeContext ?? dependencies.probe ?? "default";
  const existingFlight = refreshFlights.get(flightKey);
  if (existingFlight) { const shared = await existingFlight; return new Map([...cached, ...shared]); }
  const probe = dependencies.probe ?? (probeContext ? (id: string) => probeModelHealth(id, probeContext as never) as Promise<LocalHealth> : undefined);
  if (!probe) { for (const model of stale) cached.set(model.id, { id: model.id, status: "stale" }); return cached; }
  const refreshFlight = (async () => {
    const result = new Map<string, LocalHealth>(), deadline = (dependencies.now?.() ?? Date.now()) + budgetMs;
    const capable = stale.filter((model) => candidateHasCapabilities(model, profile));
    // Outside quality orders top-up work; models without evidence remain last rather than being silently removed.
    capable.sort((a, b) => {
      const snap = snapshots.find((entry: any) => `${entry.provider}/${entry.model}` === (a.canonicalId ?? a.id));
      const other = snapshots.find((entry: any) => `${entry.provider}/${entry.model}` === (b.canonicalId ?? b.id));
      return (other ? evaluateBenchmarkGates(other, profile).quality?.A ?? -1 : -1) - (snap ? evaluateBenchmarkGates(snap, profile).quality?.A ?? -1 : -1) || a.id.localeCompare(b.id);
    });
    let next = 0;
    const worker = async () => { while (next < capable.length) { if ((dependencies.now?.() ?? Date.now()) >= deadline) return; const model = capable[next++]!; try { const value = await probe(model.id); result.set(model.id, value); if (dependencies.merge) await dependencies.merge(value); else if (dependencies.probe) await mergeModelResult(value as never); } catch { result.set(model.id, { id: model.id, status: "error" }); } } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all(Array.from({ length: Math.min(concurrency, capable.length) }, worker)), new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); })]); }
    finally { if (timer) clearTimeout(timer); }
    for (const model of capable) if (!result.has(model.id)) result.set(model.id, { id: model.id, status: "unprobed-budget" });
    for (const model of stale) if (!capable.includes(model)) result.set(model.id, { id: model.id, status: "stale" });
    return result;
  })();
  refreshFlights.set(flightKey, refreshFlight);
  try { return new Map([...cached, ...(await refreshFlight)]); } finally { refreshFlights.delete(flightKey); }
}

export async function selectModelForSubagent(options: SelectionOptions = {}): Promise<ModelSelectionResult> {
  try {
    const profile = parseRoutingProfile(options.routingProfile), models = options.models ?? [];
    const [healthSettings, subagentSettings] = await Promise.all([getModelHealthSettings(), getSubagentExecutionSettings()]);
    const root = options.snapshotRoot ?? DEFAULT_SNAPSHOT_ROOT, maxAgeMs = options.snapshotMaxAgeMs ?? subagentSettings.benchmarkSnapshotMaxAgeMs;
    const routingAssets = await loadRoutingBenchmarkAssets(root, options.benchLmRoot, maxAgeMs);
    let mode: BenchmarkGateMode = routingAssets?.benchLm ? "strict" : "interim";
    let assets: { manifest: any; snapshots: any[] } | null = routingAssets;
    if (!assets && validateRoutingPolicy(ROUTING_POLICY)) { const frozen = await loadBenchmarkAssets(root, Math.max(maxAgeMs, ROUTING_POLICY.interim.maxAssetAgeMs)); if (frozen) { assets = frozen; mode = "interim"; } }
    if (!assets || !models.length) return {};
    const benchmarkHealth = await loadBenchmarkHealth(root, maxAgeMs);
    const health = await refreshHealth(models, profile, assets.snapshots, healthSettings.cacheTtlMs, healthSettings.concurrency, subagentSettings.healthProbeBudgetMs, options.dependencies ?? {}, options.probeContext);
    const store = await loadOutcomeStore();
    const summaries = summarizeOutcomes(store.rows, { warmupRows: subagentSettings.driftWarmupRows, alarmMinPoints: subagentSettings.driftAlarmMinPoints });
    const explorationCounter = await incrementExplorationCounter(profile);
    const route = routeBenchmarkModel(profile, models, assets.snapshots, [...health.values()], assets.manifest.digest, options.thinking, benchmarkHealth?.fields, mode, { maxProbeLatencyMs: subagentSettings.maxProbeLatencyMs, researchMinimumContextWindow: subagentSettings.researchMinimumContextWindow, taskChars: options.task?.length ?? 0, outcomeSummaries: summaries, outcomeInfluenceFullAt: subagentSettings.outcomeInfluenceFullAt, measuredSpeedMinimumRuns: subagentSettings.measuredSpeedMinimumRuns, explorationCounter });
    return route.modelId ? { modelId: route.modelId, thinkingLevel: route.thinkingLevel, selector: mode === "interim" ? "interim" : "benchmark", benchmarkRoute: route.diagnostics } : { benchmarkRoute: route.diagnostics };
  } catch { return {}; }
}
