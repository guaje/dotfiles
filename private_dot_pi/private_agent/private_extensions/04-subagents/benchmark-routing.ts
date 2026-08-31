import {
	BENCHMARK_DIMENSIONS,
	type BenchmarkDimension,
	type BenchmarkRouteDiagnostics,
	type BenchmarkSnapshot,
	type BenchmarkThinkingLevel,
	type CandidateEvaluationDiagnostics,
	type QualityDiagnostics,
	type RoutingProfile,
	type ThinkingLevel,
} from "./benchmark-types.ts";
import { ROUTING_POLICY, validateRoutingPolicy } from "./benchmark-assets.ts";
import { aaModelIdForCanonical, canonicalIdForRuntime } from "./canonical-mappings.ts";

export interface RouteCandidate {
	id: string;
	canonicalId?: string;
	reasoning?: boolean;
	supportsReasoningEffort?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	contextWindow?: number;
	maxTokens?: number;
	input?: string[];
}
export interface LocalHealth {
	id: string;
	latencyMs?: number;
	tokensPerSecond?: number;
	status?: string;
	service?: string;
	checkedAt?: number;
}
/** A route is returned even when no candidate wins so callers can render deterministic diagnostics. */
export interface BenchmarkRoute {
	modelId?: string;
	diagnostics: BenchmarkRouteDiagnostics;
	thinkingLevel?: ThinkingLevel;
}
interface RankedCandidate {
	candidate: RouteCandidate;
	snapshot: BenchmarkSnapshot;
	health: LocalHealth;
	quality: QualityDiagnostics;
	predictedCompletionMs: number;
	outputTokensSource: "artificial-analysis" | "profile-default";
	childThinking?: ThinkingLevel;
}

const snapshotKey = (id: string, level: BenchmarkThinkingLevel) => `${id}\u0000${level ?? ""}`;
const codePointCompare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

const PI_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const AA_BENCHMARK_LEVELS = new Set<BenchmarkThinkingLevel>(["off", "low", "medium", "high", "xhigh", "max"]);

/** Match Pi's effort clamp: standard levels are implicit, xhigh/max require mappings. */
function clampPiThinking(candidate: RouteCandidate, requested: ThinkingLevel): ThinkingLevel {
	const supported = (level: ThinkingLevel) => level === "xhigh" || level === "max"
		? typeof candidate.thinkingLevelMap?.[level] === "string"
		: candidate.thinkingLevelMap?.[level] !== null;
	const at = PI_THINKING_LEVELS.indexOf(requested);
	for (const level of PI_THINKING_LEVELS.slice(at)) if (supported(level)) return level;
	for (const level of PI_THINKING_LEVELS.slice(0, at).reverse()) if (supported(level)) return level;
	return "off";
}

/** Provider wire values identify AA variants only when they are canonical AA levels. */
function benchmarkThinkingFor(candidate: RouteCandidate, clamped: ThinkingLevel): BenchmarkThinkingLevel {
	const mapped = candidate.thinkingLevelMap?.[clamped];
	if (typeof mapped === "string" && AA_BENCHMARK_LEVELS.has(mapped as BenchmarkThinkingLevel)) return mapped as BenchmarkThinkingLevel;
	return clamped === "minimal" ? "low" : clamped;
}

function predictedCompletion(
	snapshot: BenchmarkSnapshot,
	profile: RoutingProfile,
	health: LocalHealth,
): { milliseconds: number; source: "artificial-analysis" | "profile-default" } | null {
	if (!Number.isFinite(health.latencyMs) || !Number.isFinite(health.tokensPerSecond) || health.latencyMs! < 0 || health.tokensPerSecond! <= 0) return null;
	const policy = ROUTING_POLICY.profiles[profile];
	const aaOutput = snapshot.outputTokens[policy.outputTokensMetric];
	const outputTokens = typeof aaOutput === "number" && Number.isFinite(aaOutput) && aaOutput > 0 ? aaOutput : policy.expectedOutputTokens;
	return Number.isFinite(outputTokens) && outputTokens > 0
		? { milliseconds: health.latencyMs! + (1000 * outputTokens) / health.tokensPerSecond!, source: aaOutput === outputTokens ? "artificial-analysis" : "profile-default" }
		: null;
}

function benchmarkQuality(snapshot: BenchmarkSnapshot, profile: RoutingProfile): { quality?: QualityDiagnostics; gateReason?: CandidateEvaluationDiagnostics["gateReason"] } {
	const policy = ROUTING_POLICY.profiles[profile];
	let invalid = false;
	for (const dimension of BENCHMARK_DIMENSIONS) {
		const value = snapshot.scores[dimension];
		const anchor = ROUTING_POLICY.anchors[dimension];
		if (value !== null && (!Number.isFinite(value) || value < anchor.minimum || value > anchor.maximum)) invalid = true;
	}

	let totalWeight = 0;
	let availableWeight = 0;
	let weighted = 0;
	const availableWeightedDimensions: BenchmarkDimension[] = [];
	const missingWeightedDimensions: BenchmarkDimension[] = [];
	for (const dimension of BENCHMARK_DIMENSIONS) {
		const weight = policy.weights[dimension];
		if (weight <= 0) continue;
		totalWeight += weight;
		const value = snapshot.scores[dimension];
		if (value === null) {
			missingWeightedDimensions.push(dimension);
			continue;
		}
		availableWeight += weight;
		availableWeightedDimensions.push(dimension);
		const anchor = ROUTING_POLICY.anchors[dimension];
		weighted += weight * Math.max(0, Math.min(1, (value - anchor.minimum) / (anchor.maximum - anchor.minimum)));
	}
	if (!(totalWeight > 0)) return { gateReason: "invalidBenchmark" };
	const quality: QualityDiagnostics = {
		A: availableWeight ? weighted / availableWeight : 0,
		C: availableWeight / totalWeight,
		Q: weighted / totalWeight,
		totalWeight,
		availableWeight,
		availableWeightedDimensions,
		missingWeightedDimensions,
	};

	// This order is contractual and is preserved in every no-winner diagnostic.
	for (const dimension of policy.requiredDimensions) if (snapshot.scores[dimension] === null) return { quality, gateReason: "missingRequiredDimension" };
	for (const [dimension, floor] of Object.entries(policy.mandatoryFloors)) {
		const score = snapshot.scores[dimension as BenchmarkDimension];
		if (score === null || score < floor!) return { quality, gateReason: "mandatoryFloor" };
	}
	if (ROUTING_POLICY.faithfulnessPolicy.appliesTo.includes(profile as "research" | "review")) {
		const faithfulness = snapshot.scores.faithfulness;
		if (faithfulness === null || faithfulness < ROUTING_POLICY.faithfulnessPolicy.floor) return { quality, gateReason: "faithfulnessFloor" };
	}
	if (quality.C < policy.minimumCoverage) return { quality, gateReason: "minimumCoverage" };
	if (invalid) return { quality, gateReason: "invalidBenchmark" };
	return { quality };
}

function dominates(a: RankedCandidate, b: RankedCandidate): boolean {
	return a.quality.Q >= b.quality.Q
		&& a.predictedCompletionMs <= b.predictedCompletionMs
		&& (a.quality.Q > b.quality.Q || a.predictedCompletionMs < b.predictedCompletionMs);
}

/** Exact snapshot + fresh local-health router. It intentionally has no name, size, quant, or network signals. */
export function routeBenchmarkModel(
	profile: RoutingProfile,
	candidates: RouteCandidate[],
	snapshots: BenchmarkSnapshot[],
	health: LocalHealth[],
	snapshotDigest: string,
	requestedThinking?: ThinkingLevel,
): BenchmarkRoute {
	const exclusions: Record<string, number> = {
		noSnapshot: 0,
		unhealthy: 0,
		capability: 0,
		missingRequiredDimension: 0,
		mandatoryFloor: 0,
		faithfulnessFloor: 0,
		minimumCoverage: 0,
		invalidBenchmark: 0,
		speed: 0,
		pareto: 0,
		qualityBand: 0,
	};
	const evaluations: CandidateEvaluationDiagnostics[] = [];
	const empty = (): BenchmarkRoute => ({
		diagnostics: {
			policyVersion: ROUTING_POLICY.version,
			routingProfile: profile,
			snapshotDigest,
			benchmarkThinkingLevel: null,
			qualityScore: 0,
			predictedCompletionMs: 0,
			outputTokensSource: "profile-default",
			candidateCount: 0,
			exclusions,
			candidates: evaluations,
		},
	});
	if (!validateRoutingPolicy(ROUTING_POLICY)) return empty();

	const bySnapshot = new Map(snapshots.map((snapshot) => [snapshotKey(`${snapshot.provider}/${snapshot.model}`, snapshot.thinkingLevel), snapshot]));
	const byAaModelId = new Map(snapshots.map((snapshot) => [snapshot.modelId, snapshot]));
	const variantsByModel = new Map<string, Set<BenchmarkThinkingLevel>>();
	for (const snapshot of snapshots) {
		const id = `${snapshot.provider}/${snapshot.model}`;
		const levels = variantsByModel.get(id) ?? new Set<BenchmarkThinkingLevel>();
		levels.add(snapshot.thinkingLevel);
		variantsByModel.set(id, levels);
	}

	const byHealth = new Map(health.map((entry) => [entry.id, entry]));
	const pool: RankedCandidate[] = [];
	for (const candidate of candidates) {
		const requestedLevel = requestedThinking ?? ROUTING_POLICY.profiles[profile].defaultThinking;
		const childThinking: ThinkingLevel | undefined = candidate.supportsReasoningEffort === false ? undefined : (candidate.reasoning ? requestedLevel : "off");
		const benchmarkThinking = benchmarkThinkingFor(candidate, clampPiThinking(candidate, childThinking ?? requestedLevel));
		const canonicalId = canonicalIdForRuntime(candidate.id, candidate.canonicalId);
		const reviewedAaModelId = aaModelIdForCanonical(canonicalId, benchmarkThinking);
		const directSnapshotId = variantsByModel.has(canonicalId) ? canonicalId : candidate.id;
		const variants = variantsByModel.get(directSnapshotId);
		const hasSpecificVariants = !!variants && [...variants].some((level) => level !== null);
		// Canonical mappings resolve to immutable AA UUIDs. Unmapped native models
		// retain the exact v4 provider/model lookup for backward compatibility.
		const snapshot = reviewedAaModelId !== undefined
			? byAaModelId.get(reviewedAaModelId)
			: hasSpecificVariants
				? bySnapshot.get(snapshotKey(directSnapshotId, benchmarkThinking))
				: bySnapshot.get(snapshotKey(directSnapshotId, null));
		if (!snapshot) {
			exclusions.noSnapshot++;
			evaluations.push({ modelId: candidate.id, eligible: false, rejectionReasons: ["noSnapshot"] });
			continue;
		}

		const reasons: CandidateEvaluationDiagnostics["rejectionReasons"] = [];
		const local = byHealth.get(candidate.id);
		const healthy = !!local && local.status === "ok" && (local.service ?? "chat") === "chat";
		if (!healthy) reasons.push("unhealthy");
		const constraints = ROUTING_POLICY.profiles[profile].constraints;
		const capable = !!candidate.input?.includes(constraints.requiredInput)
			&& (constraints.minimumContextWindow === 0 || (Number.isFinite(candidate.contextWindow) && candidate.contextWindow! >= constraints.minimumContextWindow))
			&& (constraints.minimumMaxTokens === 0 || (Number.isFinite(candidate.maxTokens) && candidate.maxTokens! >= constraints.minimumMaxTokens));
		if (!capable) reasons.push("capability");

		const evaluated = benchmarkQuality(snapshot, profile);
		if (evaluated.gateReason) reasons.push(evaluated.gateReason);
		const completion = healthy && capable && !evaluated.gateReason ? predictedCompletion(snapshot, profile, local!) : null;
		if (healthy && capable && !evaluated.gateReason && !completion) reasons.push("speed");
		const evaluation: CandidateEvaluationDiagnostics = {
			modelId: candidate.id,
			benchmarkThinkingLevel: snapshot.thinkingLevel,
			eligible: reasons.length === 0,
			rejectionReasons: reasons,
			...(evaluated.gateReason ? { gateReason: evaluated.gateReason } : {}),
			...(evaluated.quality ? { quality: evaluated.quality } : {}),
		};
		evaluations.push(evaluation);
		if (reasons.length) {
			exclusions[reasons[0]]++;
			continue;
		}
		pool.push({ candidate, snapshot, health: local!, quality: evaluated.quality!, predictedCompletionMs: completion!.milliseconds, outputTokensSource: completion!.source, childThinking });
	}

	const pareto = pool.filter((entry) => !pool.some((other) => other !== entry && dominates(other, entry)));
	exclusions.pareto = pool.length - pareto.length;
	if (!pareto.length) return empty();
	const bestQuality = Math.max(...pareto.map((entry) => entry.quality.Q));
	const tolerance = ROUTING_POLICY.profiles[profile].qualityTolerance;
	const band = pareto.filter((entry) => entry.quality.Q >= bestQuality - tolerance);
	exclusions.qualityBand = pareto.length - band.length;
	band.sort((a, b) => a.predictedCompletionMs - b.predictedCompletionMs
		|| (b.health.checkedAt ?? 0) - (a.health.checkedAt ?? 0)
		|| b.quality.C - a.quality.C
		|| (a.snapshot.taskTimeMs[profile] ?? Infinity) - (b.snapshot.taskTimeMs[profile] ?? Infinity)
		|| codePointCompare(a.candidate.id, b.candidate.id));
	const winner = band[0]!;
	return {
		modelId: winner.candidate.id,
		thinkingLevel: winner.childThinking,
		diagnostics: {
			policyVersion: ROUTING_POLICY.version,
			routingProfile: profile,
			snapshotDigest,
			benchmarkThinkingLevel: winner.snapshot.thinkingLevel,
			qualityScore: winner.quality.Q,
			predictedCompletionMs: winner.predictedCompletionMs,
			outputTokensSource: winner.outputTokensSource,
			candidateCount: pool.length,
			exclusions,
			candidates: evaluations,
		},
	};
}
