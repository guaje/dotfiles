export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type BenchmarkThinkingLevel = Exclude<ThinkingLevel, "minimal"> | null;

export const BENCHMARK_DIMENSIONS = [
	"intelligence", "coding", "agentic", "toolUse", "scientificReasoning", "longContext", "instructionFollowing", "knowledge", "faithfulness",
] as const;
export type BenchmarkDimension = (typeof BENCHMARK_DIMENSIONS)[number];
export type RoutingProfile = "balanced" | "coding" | "agentic" | "research" | "planning" | "review" | "long-context";

export interface BenchmarkMethodology { id: string; version: string; }
export interface PublicPageProvenance {
	url: string; retrievedAt: number; contentSha256: string; recordSha256: string;
	extractorVersion: "aa-current-model-rsc-v1"; intelligenceIndexMethodologyVersion: "4.1.1";
}
export interface BenchmarkComponent {
	normalizedScore: number;
	sourceKind: "api" | "public-page";
	fieldPath: string;
	benchmark: { id: "tau3-banking" | "gdpval-aa" | "tau2-telecom"; version: string; status: string };
	retrievedAt: number;
	sourceUrl: string;
	sourceRecordDigest: string;
}
export interface ToolUseDerivation {
	version: "v1";
	rule: "tau3-banking+gdpval-aa" | "tau2-telecom-fallback" | "unavailable";
	score: number | null;
}
export interface ToolUseProvenance {
	components: { tau3Banking: BenchmarkComponent | null; gdpvalAaNormalized: BenchmarkComponent | null; tau2Telecom: BenchmarkComponent | null };
	derivation: ToolUseDerivation;
}
export interface BenchmarkSnapshot {
	version: 4; provider: string; model: string; thinkingLevel: BenchmarkThinkingLevel; modelId: string; capturedAt: number;
	methodology: BenchmarkMethodology;
	mapping: { status: "mapped"; matchBasis: "manual"; reviewedAt: number; thinkingLevel: BenchmarkThinkingLevel; };
	source: { name: string; slug: string; openrouterApiId: string | null };
	publicPage: PublicPageProvenance;
	scores: Record<BenchmarkDimension, number | null>;
	toolUse: ToolUseProvenance;
	outputTokens: Partial<Record<RoutingProfile, number | null>>;
	taskTimeMs: Partial<Record<RoutingProfile, number | null>>;
	coverage: number;
}
export interface BenchmarkManifestEntry { provider: string; model: string; thinkingLevel: BenchmarkThinkingLevel; modelId: string; file: string; capturedAt: number; contentDigest: string; }
export interface BenchmarkManifest { version: 4; generatedAt: number; digest: string; methodology: BenchmarkMethodology; models: BenchmarkManifestEntry[]; }
export interface RoutingProfilePolicy {
	weights: Record<BenchmarkDimension, number>;
	requiredDimensions: BenchmarkDimension[];
	minimumCoverage: number;
	mandatoryFloors: Partial<Record<Exclude<BenchmarkDimension, "faithfulness">, number>>;
	constraints: { requiredInput: "text"; minimumContextWindow: number; minimumMaxTokens: number };
	outputTokensMetric: RoutingProfile; expectedOutputTokens: number; qualityTolerance: number; defaultThinking: ThinkingLevel;
}
export interface FaithfulnessPolicy { metric: "AA Omniscience non-hallucination rate × 100"; floor: number; appliesTo: Array<"research" | "review">; exemptions: []; }
export interface RoutingPolicy {
	version: string; methodology: BenchmarkMethodology;
	anchors: Record<BenchmarkDimension, { minimum: number; maximum: number }>;
	faithfulnessPolicy: FaithfulnessPolicy;
	profiles: Record<RoutingProfile, RoutingProfilePolicy>;
}
export interface QualityDiagnostics {
	A: number; C: number; Q: number; totalWeight: number; availableWeight: number;
	availableWeightedDimensions: BenchmarkDimension[]; missingWeightedDimensions: BenchmarkDimension[];
}
export type BenchmarkGateReason = "missingRequiredDimension" | "mandatoryFloor" | "faithfulnessFloor" | "minimumCoverage" | "invalidBenchmark";
export type BenchmarkRejectionReason = "noSnapshot" | "unhealthy" | "capability" | BenchmarkGateReason | "speed";
export interface CandidateEvaluationDiagnostics {
	modelId: string;
	benchmarkThinkingLevel?: BenchmarkThinkingLevel;
	eligible: boolean;
	/** The first applicable benchmark gate, retained for concise callers. */
	gateReason?: BenchmarkGateReason;
	/** Applicable rejections in fixed diagnostic order, including operational gates. */
	rejectionReasons: BenchmarkRejectionReason[];
	quality?: QualityDiagnostics;
}
export interface BenchmarkRouteDiagnostics {
	policyVersion: string; routingProfile: RoutingProfile; snapshotDigest: string; benchmarkThinkingLevel: BenchmarkThinkingLevel;
	qualityScore: number; predictedCompletionMs: number; outputTokensSource: "artificial-analysis" | "profile-default";
	candidateCount: number; exclusions: Record<string, number>; candidates: CandidateEvaluationDiagnostics[];
}
