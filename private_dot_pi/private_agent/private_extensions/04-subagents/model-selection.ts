import { getFreshCachedResults } from "../06-health/index.ts";
import { getModelHealthSettings } from "../06-health/settings.ts";
import { loadBenchmarkAssets, DEFAULT_SNAPSHOT_ROOT } from "./benchmark-assets.ts";
import { routeBenchmarkModel, type LocalHealth } from "./benchmark-routing.ts";
import { parseRoutingProfile } from "./task-profile.ts";
import type { BenchmarkRouteDiagnostics, RoutingProfile, ThinkingLevel } from "./benchmark-types.ts";
import { getSubagentExecutionSettings } from "./settings.ts";
import { normalizeModelMetadata, type ModelMetadata } from "./model-metadata.ts";

export type { ThinkingLevel } from "./benchmark-types.ts";
export type { ModelMetadata } from "./model-metadata.ts";
export interface ModelSelectionResult { modelId?: string; thinkingLevel?: ThinkingLevel; selector?: "benchmark"; benchmarkRoute?: BenchmarkRouteDiagnostics }

/** Convert the immutable runtime scope into routing metadata. No disk registry is consulted. */
export function getEnabledModelsMetadata(
	scopedModels: readonly { model: Record<string, unknown> }[],
	availableModels: readonly Record<string, unknown>[],
	canonicalIds: ReadonlyMap<string, string> = new Map(),
): ModelMetadata[] {
	const source = scopedModels.length ? scopedModels.map((entry) => entry.model) : availableModels;
	return source.flatMap((model) => {
		const provider = typeof model.provider === "string" ? model.provider : "";
		const runtimeId = provider && typeof model.id === "string" ? `${provider}/${model.id}` : "";
		return provider ? [normalizeModelMetadata(
			provider,
			model,
			typeof (model.compat as Record<string, unknown> | undefined)?.supportsReasoningEffort === "boolean" ? (model.compat as Record<string, boolean>).supportsReasoningEffort : undefined,
			canonicalIds.get(runtimeId),
		)].filter((value): value is ModelMetadata => !!value) : [];
	}).sort((a, b) => a.id.localeCompare(b.id));
}

/** Deterministic local-only selection. Absent, stale, or malformed assets fail closed. */
export async function selectModelForSubagent(options: { task?: string; routingProfile?: unknown; thinking?: ThinkingLevel; models?: ModelMetadata[]; snapshotRoot?: string; snapshotMaxAgeMs?: number } = {}): Promise<ModelSelectionResult> {
	try {
		const profile: RoutingProfile = parseRoutingProfile(options.routingProfile); const models = options.models ?? [];
		const [healthSettings, subagentSettings] = await Promise.all([getModelHealthSettings(), getSubagentExecutionSettings()]);
		const assets = await loadBenchmarkAssets(options.snapshotRoot ?? DEFAULT_SNAPSHOT_ROOT, options.snapshotMaxAgeMs ?? subagentSettings.benchmarkSnapshotMaxAgeMs);
		if (!assets || !models.length) return {};
		const cached = await getFreshCachedResults(healthSettings.cacheTtlMs); if (!cached) return {};
		const route = routeBenchmarkModel(profile, models, assets.snapshots, cached as LocalHealth[], assets.manifest.digest, options.thinking);
		return route.modelId ? { modelId: route.modelId, thinkingLevel: route.thinkingLevel, selector: "benchmark", benchmarkRoute: route.diagnostics } : { benchmarkRoute: route.diagnostics };
	} catch { return {}; }
}
