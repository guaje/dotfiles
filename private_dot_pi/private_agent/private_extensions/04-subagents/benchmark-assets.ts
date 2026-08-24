import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import policyJson from "./assets/routing-policy.json" with { type: "json" };
import { BENCHMARK_DIMENSIONS, type BenchmarkComponent, type BenchmarkManifest, type BenchmarkSnapshot, type BenchmarkThinkingLevel, type RoutingPolicy } from "./benchmark-types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SNAPSHOT_ROOT = path.join(__dirname, "assets", "aa");
export const ROUTING_POLICY = policyJson as RoutingPolicy;
const PROFILES = ["balanced", "coding", "agentic", "research", "planning", "review", "long-context"] as const;
const PROFILE_CONTRACT = {
	balanced: { requiredDimensions: ["intelligence", "coding"], minimumCoverage: 0.70 }, coding: { requiredDimensions: ["intelligence", "coding"], minimumCoverage: 0.70 }, agentic: { requiredDimensions: ["agentic", "toolUse"], minimumCoverage: 0.75 }, research: { requiredDimensions: ["intelligence", "scientificReasoning", "longContext", "knowledge", "faithfulness"], minimumCoverage: 0.70 }, planning: { requiredDimensions: ["scientificReasoning", "instructionFollowing"], minimumCoverage: 0.75 }, review: { requiredDimensions: ["instructionFollowing", "faithfulness"], minimumCoverage: 0.85 }, "long-context": { requiredDimensions: ["intelligence", "longContext"], minimumCoverage: 0.75 },
} as const;
const THINKING_LEVELS = new Set<BenchmarkThinkingLevel>([null, "off", "low", "medium", "high", "xhigh", "max"]);
const SHA256 = /^[a-f0-9]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isFiniteNumber = (value: unknown, minimum = -Infinity, maximum = Infinity): value is number => typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join("|") === [...keys].sort().join("|");
function canonicalize(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonicalize); if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])); return value; }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex"); }
function validThinking(value: unknown): value is BenchmarkThinkingLevel { return THINKING_LEVELS.has(value as BenchmarkThinkingLevel); }

/** Strictly validate code-owned routing policy before every route or asset load. */
export function validateRoutingPolicy(policy: unknown): policy is RoutingPolicy {
	if (!isRecord(policy) || policy.version !== "4" || !isRecord(policy.methodology) || policy.methodology.id !== "artificial-analysis-intelligence-index" || policy.methodology.version !== "4.1" || !isRecord(policy.anchors) || !isRecord(policy.profiles) || !isRecord(policy.faithfulnessPolicy)) return false;
	if (!sameKeys(policy.anchors, BENCHMARK_DIMENSIONS) || !sameKeys(policy.profiles, PROFILES)) return false;
	for (const dimension of BENCHMARK_DIMENSIONS) { const anchor = policy.anchors[dimension]; if (!isRecord(anchor) || !sameKeys(anchor, ["minimum", "maximum"]) || !isFiniteNumber(anchor.minimum) || !isFiniteNumber(anchor.maximum) || anchor.minimum >= anchor.maximum) return false; }
	const faith = policy.faithfulnessPolicy;
	if (!sameKeys(faith, ["metric", "floor", "appliesTo", "exemptions"]) || faith.metric !== "AA Omniscience non-hallucination rate × 100" || faith.floor !== 7.5 || !Array.isArray(faith.appliesTo) || faith.appliesTo.length !== 2 || faith.appliesTo[0] !== "research" || faith.appliesTo[1] !== "review" || !Array.isArray(faith.exemptions) || faith.exemptions.length !== 0) return false;
	for (const profileName of PROFILES) {
		const profile = policy.profiles[profileName];
		if (!isRecord(profile) || !sameKeys(profile, ["weights", "requiredDimensions", "minimumCoverage", "mandatoryFloors", "constraints", "outputTokensMetric", "expectedOutputTokens", "qualityTolerance", "defaultThinking"]) || !isRecord(profile.weights) || !sameKeys(profile.weights, BENCHMARK_DIMENSIONS) || !Array.isArray(profile.requiredDimensions) || !isRecord(profile.mandatoryFloors) || !isRecord(profile.constraints)) return false;
		let total = 0;
		for (const dimension of BENCHMARK_DIMENSIONS) { const weight = profile.weights[dimension]; if (!isFiniteNumber(weight, 0)) return false; total += weight; }
		if (!(total > 0) || !isFiniteNumber(profile.minimumCoverage, 0, 1) || new Set(profile.requiredDimensions).size !== profile.requiredDimensions.length || profile.minimumCoverage !== PROFILE_CONTRACT[profileName].minimumCoverage || profile.requiredDimensions.join("\u0000") !== PROFILE_CONTRACT[profileName].requiredDimensions.join("\u0000")) return false;
		for (const required of profile.requiredDimensions) if (!BENCHMARK_DIMENSIONS.includes(required as never) || profile.weights[required as string] === 0) return false;
		for (const [dimension, floor] of Object.entries(profile.mandatoryFloors)) if (!BENCHMARK_DIMENSIONS.includes(dimension as never) || dimension === "faithfulness" || !isFiniteNumber(floor, 0, 100)) return false;
		if (!sameKeys(profile.constraints, ["requiredInput", "minimumContextWindow", "minimumMaxTokens"]) || profile.constraints.requiredInput !== "text" || !isFiniteNumber(profile.constraints.minimumContextWindow, 0) || !isFiniteNumber(profile.constraints.minimumMaxTokens, 0) || !PROFILES.includes(profile.outputTokensMetric as never) || !isFiniteNumber(profile.expectedOutputTokens, Number.MIN_VALUE) || !isFiniteNumber(profile.qualityTolerance, 0) || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(profile.defaultThinking as string)) return false;
	}
	return true;
}
const validMethodology = (value: unknown): boolean => isRecord(value) && value.id === ROUTING_POLICY.methodology.id && value.version === ROUTING_POLICY.methodology.version;
function validProfileMetrics(value: unknown): boolean { return isRecord(value) && Object.entries(value).every(([key, metric]) => PROFILES.includes(key as never) && (metric === null || isFiniteNumber(metric, 0))); }
function validComponent(value: unknown, id: BenchmarkComponent["benchmark"]["id"]): boolean {
	if (!isRecord(value) || !sameKeys(value, ["normalizedScore", "sourceKind", "fieldPath", "benchmark", "retrievedAt", "sourceUrl", "sourceRecordDigest"]) || !isFiniteNumber(value.normalizedScore, 0, 100) || (value.sourceKind !== "api" && value.sourceKind !== "public-page") || typeof value.fieldPath !== "string" || !value.fieldPath || !isRecord(value.benchmark) || !sameKeys(value.benchmark, ["id", "version", "status"]) || value.benchmark.id !== id || typeof value.benchmark.version !== "string" || !value.benchmark.version || typeof value.benchmark.status !== "string" || !value.benchmark.status || !isFiniteNumber(value.retrievedAt, 1) || typeof value.sourceUrl !== "string" || !/^https:\/\//.test(value.sourceUrl) || typeof value.sourceRecordDigest !== "string" || !SHA256.test(value.sourceRecordDigest)) return false;
	return value.sourceKind === "public-page" ? value.sourceUrl.startsWith("https://artificialanalysis.ai/models/") : value.sourceUrl.includes("/api/");
}
function validToolUse(value: unknown, score: unknown, capturedAt: number, publicPage: Record<string, unknown>): boolean {
	if (!isRecord(value) || !sameKeys(value, ["components", "derivation"]) || !isRecord(value.components) || !sameKeys(value.components, ["tau3Banking", "gdpvalAaNormalized", "tau2Telecom"]) || !isRecord(value.derivation) || !sameKeys(value.derivation, ["version", "rule", "score"]) || value.derivation.version !== "v1") return false;
	const c = value.components;
	for (const [key, id] of [["tau3Banking", "tau3-banking"], ["gdpvalAaNormalized", "gdpval-aa"], ["tau2Telecom", "tau2-telecom"]] as const) {
		if (c[key] !== null && !validComponent(c[key], id)) return false;
		if (c[key] && (c[key] as Record<string, unknown>).retrievedAt! > capturedAt) return false;
		if (c[key] && (c[key] as Record<string, unknown>).sourceKind === "public-page" && ((c[key] as Record<string, unknown>).sourceRecordDigest !== publicPage.recordSha256 || (c[key] as Record<string, unknown>).sourceUrl !== publicPage.url)) return false;
	}
	const primary = c.tau3Banking && c.gdpvalAaNormalized ? ((c.tau3Banking as BenchmarkComponent).normalizedScore + (c.gdpvalAaNormalized as BenchmarkComponent).normalizedScore) / 2 : null;
	const expected = primary !== null ? { rule: "tau3-banking+gdpval-aa", score: primary } : c.tau2Telecom ? { rule: "tau2-telecom-fallback", score: (c.tau2Telecom as BenchmarkComponent).normalizedScore } : { rule: "unavailable", score: null };
	return value.derivation.rule === expected.rule && value.derivation.score === expected.score && score === expected.score;
}
function validSnapshot(value: unknown): value is BenchmarkSnapshot {
	if (!isRecord(value) || !sameKeys(value, ["version", "provider", "model", "thinkingLevel", "modelId", "capturedAt", "methodology", "mapping", "source", "publicPage", "scores", "toolUse", "outputTokens", "taskTimeMs", "coverage"]) || value.version !== 4 || typeof value.provider !== "string" || !value.provider || typeof value.model !== "string" || !value.model || !validThinking(value.thinkingLevel) || typeof value.modelId !== "string" || !value.modelId || !isFiniteNumber(value.capturedAt, 1) || !validMethodology(value.methodology) || !isFiniteNumber(value.coverage, 0, 1)) return false;
	if (!isRecord(value.mapping) || !sameKeys(value.mapping, ["status", "matchBasis", "reviewedAt", "thinkingLevel"]) || value.mapping.status !== "mapped" || value.mapping.matchBasis !== "manual" || !isFiniteNumber(value.mapping.reviewedAt, 1) || value.mapping.thinkingLevel !== value.thinkingLevel) return false;
	if (!isRecord(value.source) || !sameKeys(value.source, ["name", "slug", "openrouterApiId"]) || typeof value.source.name !== "string" || !value.source.name || typeof value.source.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.source.slug) || (value.source.openrouterApiId !== null && typeof value.source.openrouterApiId !== "string")) return false;
	if (!isRecord(value.publicPage) || !sameKeys(value.publicPage, ["url", "retrievedAt", "contentSha256", "recordSha256", "extractorVersion", "intelligenceIndexMethodologyVersion"]) || value.publicPage.url !== `https://artificialanalysis.ai/models/${value.source.slug}` || !isFiniteNumber(value.publicPage.retrievedAt, 1) || value.publicPage.retrievedAt > value.capturedAt || typeof value.publicPage.contentSha256 !== "string" || !SHA256.test(value.publicPage.contentSha256) || typeof value.publicPage.recordSha256 !== "string" || !SHA256.test(value.publicPage.recordSha256) || value.publicPage.extractorVersion !== "aa-current-model-rsc-v1" || value.publicPage.intelligenceIndexMethodologyVersion !== "4.1.1") return false;
	if (!isRecord(value.scores) || !sameKeys(value.scores, BENCHMARK_DIMENSIONS)) return false;
	let present = 0; for (const dimension of BENCHMARK_DIMENSIONS) { const score = value.scores[dimension]; if (score !== null && !isFiniteNumber(score, 0, 100)) return false; if (score !== null) present++; }
	return validToolUse(value.toolUse, value.scores.toolUse, value.capturedAt, value.publicPage) && Math.abs(value.coverage - present / BENCHMARK_DIMENSIONS.length) <= 1e-9 && validProfileMetrics(value.outputTokens) && validProfileMetrics(value.taskTimeMs);
}
const identityKey = (entry: { provider: string; model: string; thinkingLevel: BenchmarkThinkingLevel }) => `${entry.provider}\u0000${entry.model}\u0000${entry.thinkingLevel ?? ""}`;
export const compareIdentity = (a: { provider: string; model: string; thinkingLevel: BenchmarkThinkingLevel }, b: { provider: string; model: string; thinkingLevel: BenchmarkThinkingLevel }) => { for (const [left, right] of [[a.provider, b.provider], [a.model, b.model], [a.thinkingLevel ?? "", b.thinkingLevel ?? ""]] as const) { if (left < right) return -1; if (left > right) return 1; } return 0; };
function validManifest(value: unknown): value is BenchmarkManifest {
	if (!isRecord(value) || !sameKeys(value, ["version", "generatedAt", "digest", "methodology", "models"]) || value.version !== 4 || !isFiniteNumber(value.generatedAt, 1) || typeof value.digest !== "string" || !SHA256.test(value.digest) || !validMethodology(value.methodology) || !Array.isArray(value.models)) return false;
	const identities = new Set<string>(), files = new Set<string>(), variants = new Map<string, Set<BenchmarkThinkingLevel>>(), modelIds = new Map<string, Set<string>>();
	return value.models.every((entry) => { if (!isRecord(entry) || !sameKeys(entry, ["provider", "model", "thinkingLevel", "modelId", "file", "capturedAt", "contentDigest"]) || typeof entry.provider !== "string" || !entry.provider || typeof entry.model !== "string" || !entry.model || !validThinking(entry.thinkingLevel) || typeof entry.modelId !== "string" || !entry.modelId || typeof entry.file !== "string" || !/^[A-Za-z0-9_-]+\.json$/.test(entry.file) || !isFiniteNumber(entry.capturedAt, 1) || typeof entry.contentDigest !== "string" || !SHA256.test(entry.contentDigest)) return false; const identity = identityKey(entry as BenchmarkManifestEntry); const modelKey = `${entry.provider}/${entry.model}`; if (identities.has(identity) || files.has(entry.file)) return false; const levels = variants.get(modelKey) ?? new Set<BenchmarkThinkingLevel>(); levels.add(entry.thinkingLevel as BenchmarkThinkingLevel); variants.set(modelKey, levels); const ids = modelIds.get(modelKey) ?? new Set<string>(); if (ids.has(entry.modelId)) return false; ids.add(entry.modelId); modelIds.set(modelKey, ids); if (levels.size > 1 && levels.has(null)) return false; identities.add(identity); files.add(entry.file); return true; });
}
export interface LoadedBenchmarkAssets { manifest: BenchmarkManifest; snapshots: BenchmarkSnapshot[]; }
/** Read only complete, exact, current v4 local snapshots. Invalid input is unavailable. */
export async function loadBenchmarkAssets(root = DEFAULT_SNAPSHOT_ROOT, maxAgeMs = 2_592_000_000, now = Date.now()): Promise<LoadedBenchmarkAssets | null> {
	try { if (!validateRoutingPolicy(ROUTING_POLICY) || !isFiniteNumber(maxAgeMs, 1, 31_536_000_000)) return null; const manifestPath = path.join(root, "manifest.json"), modelsPath = path.join(root, "models"); const [rootInfo, modelsInfo, manifestInfo] = await Promise.all([stat(root), stat(modelsPath), stat(manifestPath)]); if (!rootInfo.isDirectory() || !modelsInfo.isDirectory() || !manifestInfo.isFile() || (rootInfo.mode & 0o077) !== 0 || (modelsInfo.mode & 0o077) !== 0 || (manifestInfo.mode & 0o077) !== 0) return null; const manifest = JSON.parse(await readFile(manifestPath, "utf8")); if (!validManifest(manifest) || now - manifest.generatedAt > maxAgeMs || manifest.generatedAt > now + 60_000) return null; const sortedModels = [...manifest.models].sort(compareIdentity); if (digest(sortedModels) !== manifest.digest) return null; const snapshots = await Promise.all(sortedModels.map(async (entry) => { const snapshotPath = path.join(modelsPath, entry.file), info = await stat(snapshotPath); if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error(); const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")); if (!validSnapshot(snapshot) || digest(snapshot) !== entry.contentDigest || snapshot.provider !== entry.provider || snapshot.model !== entry.model || snapshot.thinkingLevel !== entry.thinkingLevel || snapshot.modelId !== entry.modelId || snapshot.capturedAt !== entry.capturedAt || manifest.generatedAt < snapshot.capturedAt || now - snapshot.capturedAt > maxAgeMs || snapshot.capturedAt > now + 60_000) throw new Error(); return snapshot; })); return { manifest, snapshots }; } catch { return null; }
}
export { validManifest, validSnapshot };
