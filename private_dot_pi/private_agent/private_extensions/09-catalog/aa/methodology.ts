/**
 * Methodology drift observability.
 *
 * Publication pins the Artificial Analysis Intelligence Index methodology, so an upstream change fails closed
 * rather than silently re-scoring models against a different scale. That is the right safety property, but it
 * left the operator learning about the change from a routing outage. These probes answer the two questions that
 * actually matter when AA moves: *what version is upstream on now*, and *which of the metrics we route on
 * survived the move*. The second answer is what lets 04-subagents rank conservatively while the pins and floors
 * are re-reviewed. Nothing here publishes, maps, or rewrites an artifact: the probes are observation only.
 */
import { fetchCatalog, probePublicModel, type CatalogRecord } from "./client.ts";
import { baseConfig, loadDiscoverConfig, readOptionalSecureJson, type BaseConfig } from "./config.ts";
import { DIMENSIONS, METHODOLOGY, PUBLIC_METHODOLOGY_VERSION, isRecord, validateManifest, validateSnapshot } from "./schema.ts";

export interface MethodologyDrift {
	pinned: { api: string; public: string };
	upstream: { api: string | null; public: string | null };
	changed: boolean;
	warnings: string[];
}

export type StabilityClass = "stable" | "drifted" | "indeterminate" | "gone";

export interface DimensionStability {
	dimension: string;
	paired: number;
	published: number;
	meanAbsDelta: number | null;
	maxAbsDelta: number | null;
	rankCorrelation: number | null;
	classification: StabilityClass;
}

/** Reviewed thresholds for calling a metric stable across a methodology move. */
export const STABILITY_THRESHOLDS = { minPairs: 4, maxMeanAbsDelta: 5, minRankCorrelation: 0.9 };

const percent = (value: unknown): number | null => {
	if (value === null || value === undefined) return null;
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return value >= 0 && value <= 1 ? value * 100 : value;
};
const first = (...values: (number | null)[]): number | null => values.find((value) => value !== null) ?? null;
const mean = (values: (number | null)[]): number | null => values.every((value) => value !== null) ? (values as number[]).reduce((total, value) => total + value, 0) / values.length : null;

/**
 * Mirror of `buildSnapshot`'s dimension formulas, made total instead of strict: conflicts between the API and
 * the page are resolved API-first rather than raised, because a probe must never fail on a data disagreement it
 * is only reporting on. `tests/aa.test.ts` proves this stays in lockstep with the publishing formulas.
 */
export function deriveDimensions(evaluations: Record<string, unknown>, page: Record<string, unknown>): Record<string, number | null> {
	const tau3 = first(percent(evaluations.tau_banking), percent(page.tauBanking), percent(page.tau3Banking));
	const gdp = first(percent(evaluations.gdpval_aa_normalized), percent(page.gdpvalNormalized));
	const tau2 = first(percent(evaluations.tau2_telecom), percent(page.tau2));
	const hallucination = percent(page.omniscienceHallucinationRate);
	return {
		intelligence: first(percent(evaluations.artificial_analysis_intelligence_index), percent(page.intelligenceIndex)),
		coding: percent(evaluations.artificial_analysis_coding_index),
		agentic: first(percent(evaluations.artificial_analysis_agentic_index), percent(page.agenticIndex)),
		toolUse: tau3 !== null && gdp !== null ? (tau3 + gdp) / 2 : tau3 !== null && tau2 !== null ? (tau3 + tau2) / 2 : tau3 ?? tau2,
		scientificReasoning: mean([percent(evaluations.hle ?? page.hle), percent(evaluations.gpqa_diamond ?? page.gpqa), percent(evaluations.critpt ?? page.critpt)]),
		longContext: first(percent(evaluations.aa_lcr), percent(page.lcr)),
		instructionFollowing: first(percent(evaluations.ifbench), percent(page.ifbench)),
		knowledge: first(percent(evaluations.aa_omniscience_accuracy), percent(page.omniscienceAccuracy)),
		faithfulness: first(percent(evaluations.aa_omniscience_non_hallucination_rate), hallucination === null ? null : 100 - hallucination),
	};
}

function rankCorrelation(pairs: Array<[number, number]>): number | null {
	if (pairs.length < STABILITY_THRESHOLDS.minPairs) return null;
	const ranks = (values: number[]): number[] => {
		const order = values.map((value, index) => [value, index] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		const result = new Array<number>(values.length).fill(0);
		for (let index = 0; index < order.length;) {
			let last = index; while (last + 1 < order.length && order[last + 1]![0] === order[index]![0]) last++;
			const average = (index + last + 2) / 2;
			for (let walk = index; walk <= last; walk++) result[order[walk]![1]] = average;
			index = last + 1;
		}
		return result;
	};
	const before = ranks(pairs.map((pair) => pair[0]));
	const after = ranks(pairs.map((pair) => pair[1]));
	const meanBefore = before.reduce((total, value) => total + value, 0) / before.length;
	const meanAfter = after.reduce((total, value) => total + value, 0) / after.length;
	let covariance = 0; let varianceBefore = 0; let varianceAfter = 0;
	for (let index = 0; index < before.length; index++) {
		covariance += (before[index]! - meanBefore) * (after[index]! - meanAfter);
		varianceBefore += (before[index]! - meanBefore) ** 2;
		varianceAfter += (after[index]! - meanAfter) ** 2;
	}
	return varianceBefore > 0 && varianceAfter > 0 ? covariance / Math.sqrt(varianceBefore * varianceAfter) : null;
}

/** Reviewed classifier: a metric survives a methodology move only if ordering and scale both held. */
export function classifyDimensionStability(pairs: Array<[number, number]>): Omit<DimensionStability, "dimension" | "published"> {
	const deltas = pairs.map((pair) => Math.abs(pair[0] - pair[1]));
	const rho = rankCorrelation(pairs);
	const meanAbsDelta = deltas.length ? deltas.reduce((total, value) => total + value, 0) / deltas.length : null;
	let classification: StabilityClass = "drifted";
	if (!pairs.length) classification = "gone";
	else if (pairs.length < STABILITY_THRESHOLDS.minPairs || rho === null) classification = "indeterminate";
	else if (rho >= STABILITY_THRESHOLDS.minRankCorrelation && meanAbsDelta !== null && meanAbsDelta <= STABILITY_THRESHOLDS.maxMeanAbsDelta) classification = "stable";
	return { paired: pairs.length, meanAbsDelta, maxAbsDelta: deltas.length ? Math.max(...deltas) : null, rankCorrelation: rho, classification };
}

/** Published snapshots, read tolerantly: an unreadable or incomplete generation simply yields nothing to compare. */
async function publishedSnapshots(config: BaseConfig): Promise<Record<string, unknown>[]> {
	try {
		const manifest = await readOptionalSecureJson(config.paths.manifest);
		if (!validateManifest(manifest)) return [];
		const snapshots: Record<string, unknown>[] = [];
		for (const entry of manifest.models) {
			const snapshot = await readOptionalSecureJson(`${config.paths.snapshotRoot}/models/${entry.file}`);
			if (validateSnapshot(snapshot)) snapshots.push(snapshot as unknown as Record<string, unknown>);
		}
		return snapshots;
	} catch { return []; }
}

export interface MethodologyAudit {
	drift: MethodologyDrift;
	dimensions: DimensionStability[];
	stableDimensions: string[];
	warnings: string[];
}

/**
 * Compare every published dimension against what AA publishes today for the same models, and classify each
 * metric as stable, drifted, gone, or indeterminate for that pair of generations. Sampling is bounded to the
 * reviewed generation, one page per model, at the ordinary page rate.
 */
export async function auditMethodology(signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<MethodologyAudit> {
	const config = baseConfig(env);
	const discover = await loadDiscoverConfig(env);
	const warnings: string[] = [];
	const catalog = await fetchCatalog({ ...config, apiUrl: new URL("https://artificialanalysis.ai/api/v2/language/models/free"), apiKey: discover.apiKey }, signal, { reportOnly: true });
	const drift: MethodologyDrift = { pinned: { api: METHODOLOGY.version, public: PUBLIC_METHODOLOGY_VERSION }, upstream: { api: catalog.methodologyVersion || null, public: null }, changed: false, warnings: [] };

	const snapshots = await publishedSnapshots(config);
	const byModelId = new Map<string, Record<string, unknown>>();
	for (const snapshot of snapshots) if (!byModelId.has(snapshot.modelId as string)) byModelId.set(snapshot.modelId as string, snapshot);
	const records = new Map<string, CatalogRecord>();
	for (const record of catalog.records) if (byModelId.has(record.id) && typeof record.slug === "string" && !records.has(record.id)) records.set(record.id, record);

	const upstream: Array<{ modelId: string; dimensions: Record<string, number | null> }> = [];
	for (const [modelId, record] of records) {
		if (upstream.length >= 12) { warnings.push("methodology audit capped at 12 model pages"); break; }
		try {
			const page = await probePublicModel(config, record.slug!, signal, { id: record.id, slug: record.slug!, name: typeof record.name === "string" ? record.name : record.slug! });
			drift.upstream.public ??= page.methodologyVersion;
			upstream.push({ modelId, dimensions: deriveDimensions(isRecord(record.evaluations) ? record.evaluations : {}, page.record) });
		} catch (error) { warnings.push(`methodology audit skipped an unreadable model page: ${(error as Error).message.slice(0, 60)}`); }
	}
	drift.changed = (drift.upstream.api !== null && drift.upstream.api !== METHODOLOGY.version)
		|| (drift.upstream.public !== null && drift.upstream.public !== PUBLIC_METHODOLOGY_VERSION);
	drift.warnings = warnings;

	const dimensions: DimensionStability[] = DIMENSIONS.map((dimension) => {
		const pairs: Array<[number, number]> = [];
		let published = 0;
		for (const entry of upstream) {
			const snapshot = byModelId.get(entry.modelId);
			const before = isRecord(snapshot?.scores) ? (snapshot.scores as Record<string, unknown>)[dimension] : null;
			if (typeof before !== "number") continue;
			published++;
			const after = entry.dimensions[dimension];
			if (typeof after === "number") pairs.push([before, after]);
		}
		return { dimension, published, ...classifyDimensionStability(pairs) };
	});
	const stableDimensions = dimensions.filter((entry) => entry.classification === "stable").map((entry) => entry.dimension);
	return { drift, dimensions, stableDimensions, warnings };
}

/** One-line operator-facing summary used by `/catalog refresh`. Observation never changes routing state. */
export function describeMethodologyDrift(drift: MethodologyDrift): { text: string; level: "info" | "warning" } {
	// Silence is not agreement: an unreadable or version-less API response must never render as an all-clear.
	if (drift.upstream.api === null) return { text: `Artificial Analysis methodology check unavailable${drift.warnings.length ? `: ${drift.warnings[0]}` : ": the catalog published no methodology version"}`, level: "info" };
	if (!drift.changed) return { text: `Artificial Analysis methodology unchanged (pinned public ${drift.pinned.public}, catalog API ${drift.pinned.api})`, level: "info" };
	const moved = [
		drift.upstream.api !== null && drift.upstream.api !== drift.pinned.api ? `API index ${drift.pinned.api} → ${drift.upstream.api}` : null,
		drift.upstream.public !== null && drift.upstream.public !== drift.pinned.public ? `public page ${drift.pinned.public} → ${drift.upstream.public}` : null,
	].filter(Boolean).join("; ");
	return { text: `Artificial Analysis methodology moved (${moved}). Benchmark snapshots are frozen at ${drift.pinned.api}; routing runs on interim ranking until you re-review. Next: run node agent/extensions/09-catalog/aa/cli.ts --methodology-diff, then bump the pins in 09-catalog/aa/schema.ts and recalibrate 04-subagents/assets/routing-policy.json.`, level: "warning" };
}
