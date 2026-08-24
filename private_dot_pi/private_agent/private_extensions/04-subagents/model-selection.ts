import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFreshCachedResults } from "../06-health/index.ts";
import { getModelHealthSettings } from "../06-health/settings.ts";
import { loadBenchmarkAssets, DEFAULT_SNAPSHOT_ROOT } from "./benchmark-assets.ts";
import { routeBenchmarkModel, type LocalHealth } from "./benchmark-routing.ts";
import { parseRoutingProfile } from "./task-profile.ts";
import type { BenchmarkRouteDiagnostics, RoutingProfile, ThinkingLevel } from "./benchmark-types.ts";
import { getSubagentExecutionSettings } from "./settings.ts";
import { normalizeModelMetadata, type ModelMetadata } from "./model-metadata.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_PATH = path.resolve(__dirname, "../../models.json");
const MODELS_STORE_PATH = path.resolve(__dirname, "../../models-store.json");
const SETTINGS_CONFIG_PATH = path.resolve(__dirname, "../../settings.config.json");
const SETTINGS_PATH = path.resolve(__dirname, "../../settings.json");
export type { ThinkingLevel } from "./benchmark-types.ts";
export type { ModelMetadata } from "./model-metadata.ts";
type ProviderModels = Record<string, { models?: Array<Record<string, unknown>>; compat?: { supportsReasoningEffort?: unknown } }>;
interface SettingsFile { enabledModels?: string[] }
export interface ModelSelectionResult { modelId?: string; thinkingLevel?: ThinkingLevel; selector?: "benchmark"; benchmarkRoute?: BenchmarkRouteDiagnostics }

async function readJson(file: string): Promise<unknown | null> { try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; } }
function providers(value: unknown): ProviderModels {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const root = value as Record<string, unknown>; return (root.providers && typeof root.providers === "object" && !Array.isArray(root.providers) ? root.providers : root) as ProviderModels;
}
export async function getEnabledModelsMetadata(): Promise<ModelMetadata[]> {
	try {
		const [builtins, configured, config] = await Promise.all([readJson(MODELS_STORE_PATH), readJson(MODELS_PATH), readJson(SETTINGS_CONFIG_PATH)]);
		const settings = (config as SettingsFile | null) ?? (await readJson(SETTINGS_PATH) as SettingsFile | null) ?? {};
		const enabled = new Set(settings.enabledModels ?? []); const available = new Map<string, ModelMetadata>();
		for (const source of [providers(builtins), providers(configured)]) for (const [provider, value] of Object.entries(source)) for (const model of value.models ?? []) { const entry = normalizeModelMetadata(provider, model, typeof value.compat?.supportsReasoningEffort === "boolean" ? value.compat.supportsReasoningEffort : undefined); if (entry) available.set(entry.id, entry); }
		return [...enabled].map((id) => available.get(id) ?? { id }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	} catch { return []; }
}

/** Deterministic local-only selection. Absent, stale, or malformed assets fail closed. */
export async function selectModelForSubagent(options: { task?: string; routingProfile?: unknown; thinking?: ThinkingLevel; models?: ModelMetadata[]; snapshotRoot?: string; snapshotMaxAgeMs?: number } = {}): Promise<ModelSelectionResult> {
	try {
		const profile: RoutingProfile = parseRoutingProfile(options.routingProfile); const models = options.models ?? await getEnabledModelsMetadata();
		const [healthSettings, subagentSettings] = await Promise.all([getModelHealthSettings(), getSubagentExecutionSettings()]);
		const assets = await loadBenchmarkAssets(options.snapshotRoot ?? DEFAULT_SNAPSHOT_ROOT, options.snapshotMaxAgeMs ?? subagentSettings.benchmarkSnapshotMaxAgeMs);
		if (!assets || !models.length) return {};
		const cached = await getFreshCachedResults(healthSettings.cacheTtlMs); if (!cached) return {};
		const route = routeBenchmarkModel(profile, models, assets.snapshots, cached as LocalHealth[], assets.manifest.digest, options.thinking);
		return route.modelId ? { modelId: route.modelId, thinkingLevel: route.thinkingLevel, selector: "benchmark", benchmarkRoute: route.diagnostics } : { benchmarkRoute: route.diagnostics };
	} catch { return {}; }
}
