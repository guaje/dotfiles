import { ROUTING_POLICY, validateRoutingPolicy } from "./benchmark-assets.ts";
import type {
	BenchmarkDimension, BenchmarkGateReason, BenchmarkHealth, BenchmarkSnapshot, QualityDiagnostics, RoutingProfile,
} from "./benchmark-types.ts";
import type { RouteCandidate } from "./benchmark-routing.ts";

export const ROUTING_PROFILES: readonly RoutingProfile[] = ["balanced", "coding", "agentic", "research", "planning", "review", "long-context"];

export interface ProfileSubstitution { dimension: BenchmarkDimension; source: string; value: number; }

export interface BenchmarkProfileQualification {
	profile: RoutingProfile;
	qualified: boolean;
	reason?: BenchmarkGateReason | "capability";
	/** Dimensions qualified through a reviewed fallback source because the primary benchmark is retired upstream. */
	substitutions?: ProfileSubstitution[];
}

type Candidate = Pick<RouteCandidate, "input" | "contextWindow" | "maxTokens">;

export interface BenchmarkGateEvaluation { quality?: QualityDiagnostics; gateReason?: BenchmarkGateReason; }

/**
 * Contractual benchmark gate shared by catalog qualification and runtime routing.
 * When a dimension's primary score is null, a reviewed fallback source may substitute it — but only when the
 * health artifact proves the primary upstream field is retired and the substituted average clears the source's
 * own reviewed floor. Substituted dimensions count toward coverage and quality; their primary mandatory floors
 * are replaced by the fallback source's floor. Unknown or missing health data never enables substitution.
 */
export function evaluateBenchmarkGates(snapshot: BenchmarkSnapshot, profile: RoutingProfile, health?: BenchmarkHealth): BenchmarkGateEvaluation {
	const policy = ROUTING_POLICY.profiles[profile];
	const substitutions: ProfileSubstitution[] = [];
	const substitutedDimensions = new Set<BenchmarkDimension>();
	const valueFor = (dimension: BenchmarkDimension): number | null => {
		const primary = snapshot.scores[dimension];
		if (primary !== null) return primary;
		const chain = policy.fallbackSources?.[dimension];
		if (!chain || !health) return null;
		for (const source of chain) {
			if (health[source.healthField]?.status !== "retired") continue;
			const values = source.fields.map((field) => snapshot.subBenchmarks?.[field] ?? null);
			if (values.some((value) => value === null)) continue;
			const mean = values.reduce((total, value) => total + (value as number), 0) / values.length;
			if (!Number.isFinite(mean) || mean < source.floor) continue;
			substitutedDimensions.add(dimension);
			const sourceName = `subBenchmark:${source.fields.join("+")}`;
			if (!substitutions.some((entry) => entry.dimension === dimension)) substitutions.push({ dimension, source: sourceName, value: mean });
			return mean;
		}
		return null;
	};

	let totalWeight = 0;
	let availableWeight = 0;
	let weighted = 0;
	let invalid = false;
	const availableWeightedDimensions: BenchmarkDimension[] = [];
	const missingWeightedDimensions: BenchmarkDimension[] = [];
	for (const dimension of Object.keys(policy.weights) as BenchmarkDimension[]) {
		const weight = policy.weights[dimension];
		if (weight <= 0) continue;
		totalWeight += weight;
		const value = valueFor(dimension);
		if (value === null) { missingWeightedDimensions.push(dimension); continue; }
		availableWeight += weight;
		availableWeightedDimensions.push(dimension);
		const anchor = ROUTING_POLICY.anchors[dimension];
		if (!Number.isFinite(value) || value < anchor.minimum || value > anchor.maximum) invalid = true;
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
		...(substitutions.length ? { substitutions } : {}),
	};

	// This order is contractual and is preserved in every no-winner diagnostic.
	for (const dimension of policy.requiredDimensions) if (valueFor(dimension) === null) return { quality, gateReason: "missingRequiredDimension" };
	for (const [dimension, floor] of Object.entries(policy.mandatoryFloors)) {
		if (substitutedDimensions.has(dimension as BenchmarkDimension)) continue;
		const score = valueFor(dimension as BenchmarkDimension);
		if (score === null || score < floor!) return { quality, gateReason: "mandatoryFloor" };
	}
	if (ROUTING_POLICY.faithfulnessPolicy.appliesTo.includes(profile as "research" | "review")) {
		const faithfulness = snapshot.scores.faithfulness;
		if (faithfulness === null || faithfulness < ROUTING_POLICY.faithfulnessPolicy.floor) return { quality, gateReason: "faithfulnessFloor" };
	}
	if (!(quality.C >= policy.minimumCoverage)) return { quality, gateReason: "minimumCoverage" };
	if (invalid) return { quality, gateReason: "invalidBenchmark" };
	return { quality };
}

/** Pure benchmark/capability gates. Health and local speed are intentionally evaluated later by runtime routing. */
export function qualifyBenchmarkProfiles(candidate: Candidate, snapshot: BenchmarkSnapshot, health?: BenchmarkHealth): BenchmarkProfileQualification[] {
	if (!validateRoutingPolicy(ROUTING_POLICY)) return ROUTING_PROFILES.map((profile) => ({ profile, qualified: false, reason: "invalidBenchmark" }));
	return ROUTING_PROFILES.map((profile) => {
		const policy = ROUTING_POLICY.profiles[profile];
		const constraints = policy.constraints;
		const capable = !!candidate.input?.includes(constraints.requiredInput)
			&& (constraints.minimumContextWindow === 0 || (Number.isFinite(candidate.contextWindow) && candidate.contextWindow! >= constraints.minimumContextWindow))
			&& (constraints.minimumMaxTokens === 0 || (Number.isFinite(candidate.maxTokens) && candidate.maxTokens! >= constraints.minimumMaxTokens));
		if (!capable) return { profile, qualified: false, reason: "capability" };
		const evaluated = evaluateBenchmarkGates(snapshot, profile, health);
		const substitutions = evaluated.quality?.substitutions;
		return {
			profile,
			qualified: !evaluated.gateReason,
			...(evaluated.gateReason ? { reason: evaluated.gateReason } : {}),
			...(substitutions?.length ? { substitutions } : {}),
		};
	});
}
