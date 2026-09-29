import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import policyJson from "./assets/routing-policy.json" with { type: "json" };
import { canonicalDigest, compareIdentity, METHODOLOGY, validateBenchmarkHealth, validateManifest, validateSnapshot } from "../09-catalog/aa/schema.ts";
import { BENCHMARK_DIMENSIONS, type BenchmarkHealthState, type BenchmarkManifest, type BenchmarkSnapshot, type RoutingPolicy } from "./benchmark-types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SNAPSHOT_ROOT = path.join(__dirname, "assets", "aa");
export const ROUTING_POLICY = policyJson as RoutingPolicy;
const PROFILES = ["balanced", "coding", "agentic", "research", "planning", "review", "long-context"] as const;
const PROFILE_CONTRACT = {
  balanced: { requiredDimensions: ["intelligence", "coding"], minimumCoverage: 0.70 }, coding: { requiredDimensions: ["intelligence", "coding"], minimumCoverage: 0.70 }, agentic: { requiredDimensions: ["agentic", "toolUse"], minimumCoverage: 0.75 }, research: { requiredDimensions: ["intelligence", "scientificReasoning", "longContext", "knowledge", "faithfulness"], minimumCoverage: 0.70 }, planning: { requiredDimensions: ["scientificReasoning", "instructionFollowing"], minimumCoverage: 0.75 }, review: { requiredDimensions: ["instructionFollowing", "faithfulness"], minimumCoverage: 0.85 }, "long-context": { requiredDimensions: ["intelligence", "longContext"], minimumCoverage: 0.75 },
} as const;
const SUB_BENCHMARK_FIELD_SET = new Set(["critpt", "gpqa", "hle", "ifbench"]);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isFiniteNumber = (value: unknown, minimum = -Infinity, maximum = Infinity): value is number => typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join("|") === [...keys].sort().join("|");

/** Strictly validate code-owned routing policy before every route or asset load. */
export function validateRoutingPolicy(policy: unknown): policy is RoutingPolicy {
  if (!isRecord(policy) || policy.version !== "5" || !isRecord(policy.methodology) || policy.methodology.id !== METHODOLOGY.id || policy.methodology.version !== METHODOLOGY.version || !isRecord(policy.anchors) || !isRecord(policy.profiles) || !isRecord(policy.faithfulnessPolicy)) return false;
  if (!sameKeys(policy.anchors, BENCHMARK_DIMENSIONS) || !sameKeys(policy.profiles, PROFILES)) return false;
  for (const dimension of BENCHMARK_DIMENSIONS) { const anchor = policy.anchors[dimension]; if (!isRecord(anchor) || !sameKeys(anchor, ["minimum", "maximum"]) || !isFiniteNumber(anchor.minimum) || !isFiniteNumber(anchor.maximum) || anchor.minimum >= anchor.maximum) return false; }
  const faith = policy.faithfulnessPolicy;
  if (!sameKeys(faith, ["metric", "floor", "appliesTo", "exemptions"]) || faith.metric !== "AA Omniscience non-hallucination rate × 100" || faith.floor !== 7.5 || !Array.isArray(faith.appliesTo) || faith.appliesTo.length !== 2 || faith.appliesTo[0] !== "research" || faith.appliesTo[1] !== "review" || !Array.isArray(faith.exemptions) || faith.exemptions.length !== 0) return false;
  for (const profileName of PROFILES) {
    const profile = policy.profiles[profileName];
    const profileKeys = ["weights", "requiredDimensions", "minimumCoverage", "mandatoryFloors", "constraints", "outputTokensMetric", "expectedOutputTokens", "qualityTolerance", "defaultThinking"];
    if (!isRecord(profile) || !(sameKeys(profile, profileKeys) || sameKeys(profile, [...profileKeys, "fallbackSources"])) || !isRecord(profile.weights) || !sameKeys(profile.weights, BENCHMARK_DIMENSIONS) || !Array.isArray(profile.requiredDimensions) || !isRecord(profile.mandatoryFloors) || !isRecord(profile.constraints)) return false;
    let total = 0; for (const dimension of BENCHMARK_DIMENSIONS) { const weight = profile.weights[dimension]; if (!isFiniteNumber(weight, 0)) return false; total += weight; }
    if (!(total > 0) || !isFiniteNumber(profile.minimumCoverage, 0, 1) || new Set(profile.requiredDimensions).size !== profile.requiredDimensions.length || profile.minimumCoverage !== PROFILE_CONTRACT[profileName].minimumCoverage || profile.requiredDimensions.join("\0") !== PROFILE_CONTRACT[profileName].requiredDimensions.join("\0")) return false;
    for (const required of profile.requiredDimensions) if (!BENCHMARK_DIMENSIONS.includes(required as never) || profile.weights[required as string] === 0) return false;
    for (const [dimension, floor] of Object.entries(profile.mandatoryFloors)) if (!BENCHMARK_DIMENSIONS.includes(dimension as never) || dimension === "faithfulness" || !isFiniteNumber(floor, 0, 100)) return false;
    if (!sameKeys(profile.constraints, ["requiredInput", "minimumContextWindow", "minimumMaxTokens"]) || profile.constraints.requiredInput !== "text" || !isFiniteNumber(profile.constraints.minimumContextWindow, 0) || !isFiniteNumber(profile.constraints.minimumMaxTokens, 0) || !PROFILES.includes(profile.outputTokensMetric as never) || !isFiniteNumber(profile.expectedOutputTokens, Number.MIN_VALUE) || !isFiniteNumber(profile.qualityTolerance, 0) || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(profile.defaultThinking as string)) return false;
    if (profile.fallbackSources !== undefined) {
      if (!isRecord(profile.fallbackSources)) return false;
      for (const [dimension, chain] of Object.entries(profile.fallbackSources)) {
        if (dimension === "faithfulness" || !BENCHMARK_DIMENSIONS.includes(dimension as never) || !(profile.requiredDimensions as string[]).includes(dimension)) return false;
        if (!Array.isArray(chain) || chain.length < 1 || chain.length > 2) return false;
        for (const source of chain) {
          if (!isRecord(source) || !sameKeys(source, ["fields", "floor", "healthField"]) || !Array.isArray(source.fields) || source.fields.length < 1 || source.fields.length > 3 || new Set(source.fields).size !== source.fields.length || !source.fields.every((field) => typeof field === "string" && SUB_BENCHMARK_FIELD_SET.has(field))) return false;
          if (!isFiniteNumber(source.floor, 0, 100) || typeof source.healthField !== "string" || !SUB_BENCHMARK_FIELD_SET.has(source.healthField)) return false;
        }
      }
    }
  }
  return true;
}
export interface LoadedBenchmarkAssets { manifest: BenchmarkManifest; snapshots: BenchmarkSnapshot[]; }
export interface BenchmarkAssetHooks { beforeSnapshotRead?(file: string): void | Promise<void>; }
class MissingReferencedSnapshot extends Error { constructor(readonly manifestText: string) { super("missing referenced benchmark snapshot"); } }
async function secureInfo(target: string, directory: boolean): Promise<void> { const info = await lstat(target); const expected = directory ? 0o700 : 0o600; if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (info.mode & 0o777) !== expected) throw new Error("unsafe benchmark artifact"); }
async function loadBenchmarkAssetsOnce(root: string, maxAgeMs: number, now: number, hooks: BenchmarkAssetHooks): Promise<{ assets: LoadedBenchmarkAssets; manifestText: string }> {
  const manifestPath = path.join(root, "manifest.json"), modelsPath = path.join(root, "models"); await Promise.all([secureInfo(root, true), secureInfo(modelsPath, true), secureInfo(manifestPath, false)]);
  const manifestText = await readFile(manifestPath, "utf8"); const manifestValue = JSON.parse(manifestText); if (!validateManifest(manifestValue) || now - manifestValue.generatedAt > maxAgeMs || manifestValue.generatedAt > now + 60_000) throw new Error("invalid benchmark manifest");
  const sortedModels = [...manifestValue.models].sort(compareIdentity); if (canonicalDigest(sortedModels) !== manifestValue.digest) throw new Error("invalid benchmark manifest");
  const snapshots = await Promise.all(sortedModels.map(async (entry) => {
    const snapshotPath = path.join(modelsPath, entry.file); let snapshot: unknown;
    try { await secureInfo(snapshotPath, false); await hooks.beforeSnapshotRead?.(entry.file); snapshot = JSON.parse(await readFile(snapshotPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingReferencedSnapshot(manifestText); throw error; }
    if (!validateSnapshot(snapshot) || !isRecord(snapshot) || canonicalDigest(snapshot) !== entry.contentDigest || snapshot.provider !== entry.provider || snapshot.model !== entry.model || snapshot.thinkingLevel !== entry.thinkingLevel || snapshot.modelId !== entry.modelId || snapshot.capturedAt !== entry.capturedAt || manifestValue.generatedAt < entry.capturedAt || now - entry.capturedAt > maxAgeMs || snapshot.capturedAt > now + 60_000) throw new Error("invalid benchmark snapshot"); return snapshot as unknown as BenchmarkSnapshot;
  }));
  return { assets: { manifest: manifestValue as BenchmarkManifest, snapshots }, manifestText };
}
/** Read only complete, exact, current v4 local snapshots. Invalid input is unavailable. */
export async function loadBenchmarkAssets(root = DEFAULT_SNAPSHOT_ROOT, maxAgeMs = 2_592_000_000, now = Date.now(), hooks: BenchmarkAssetHooks = {}): Promise<LoadedBenchmarkAssets | null> {
  try {
    if (!validateRoutingPolicy(ROUTING_POLICY) || !isFiniteNumber(maxAgeMs, 1, 31_536_000_000)) return null;
    try { return (await loadBenchmarkAssetsOnce(root, maxAgeMs, now, hooks)).assets; }
    catch (error) {
      if (!(error instanceof MissingReferencedSnapshot)) throw error;
      const manifestPath = path.join(root, "manifest.json"); await secureInfo(manifestPath, false); const nextManifestText = await readFile(manifestPath, "utf8");
      // A retry is safe only for an atomic switch to a demonstrably different manifest.
      if (nextManifestText === error.manifestText) throw error;
      return (await loadBenchmarkAssetsOnce(root, maxAgeMs, now, hooks)).assets;
    }
  } catch { return null; }
}
export { validateManifest as validManifest, validateSnapshot as validSnapshot };

/** Strictly read the generated benchmark-health artifact; anything missing, stale, future-dated, or invalid yields null (no substitutions). */
export async function loadBenchmarkHealth(root = DEFAULT_SNAPSHOT_ROOT, maxAgeMs = 2_592_000_000, now = Date.now()): Promise<BenchmarkHealthState | null> {
  try {
    if (!isFiniteNumber(maxAgeMs, 1, 31_536_000_000)) return null;
    const file = path.join(root, "benchmark-health.json");
    await secureInfo(file, false);
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!validateBenchmarkHealth(value) || now - value.generatedAt > maxAgeMs || value.generatedAt > now + 60_000) return null;
    return { generatedAt: value.generatedAt, fields: value.fields };
  } catch { return null; }
}
