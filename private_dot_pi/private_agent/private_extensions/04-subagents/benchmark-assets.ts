import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import policyJson from "./assets/routing-policy.json" with { type: "json" };
import { extractAaVariants } from "./asset-composite.ts";
import { canonicalDigest, compareIdentity, validateBenchmarkHealth, validateManifest, validateSnapshot } from "../09-catalog/aa/schema.ts";
import { BENCHMARK_DIMENSIONS, type BenchmarkHealthState, type BenchmarkManifest, type BenchmarkSnapshot, type RoutingPolicy } from "./benchmark-types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SNAPSHOT_ROOT = path.join(__dirname, "assets");
export const ROUTING_POLICY = policyJson as RoutingPolicy;
export const ROUTING_POLICY_VERSION = "10";
const PROFILES = ["balanced", "coding", "agentic", "research", "planning", "review", "long-context"] as const;
const DEFAULT_ROUTING_POLICY_PATH = path.join(__dirname, "assets", "routing-policy.json");
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown, minimum = -Infinity, maximum = Infinity): value is number => typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join("|") === [...keys].sort().join("|");

export async function describePolicyGenerationMismatch(policyPath = process.env.PI_AA_ROUTING_POLICY || DEFAULT_ROUTING_POLICY_PATH): Promise<string | null> {
  try {
    const info = await lstat(policyPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return null;
    const value: unknown = JSON.parse(await readFile(policyPath, "utf8"));
    if (!isRecord(value) || typeof value.version !== "string" || value.version === ROUTING_POLICY_VERSION) return null;
    const seen = /^[A-Za-z0-9._-]{1,16}$/.test(value.version) ? value.version : "an unrecognized value";
    return `routing policy on disk is generation ${seen} but this code accepts ${ROUTING_POLICY_VERSION}; apply 04-subagents/assets/routing-policy.json together with the extension code`;
  } catch { return null; }
}

export function validateRoutingPolicy(policy: unknown): policy is RoutingPolicy {
  if (!isRecord(policy) || policy.version !== ROUTING_POLICY_VERSION || !isRecord(policy.methodology) || typeof policy.methodology.id !== "string" || typeof policy.methodology.version !== "string" || !isRecord(policy.history) || !isRecord(policy.anchors) || !isRecord(policy.profiles) || !isRecord(policy.interim)) return false;
  if (!sameKeys(policy.history, ["maxRankInfluence", "basis"]) || !finite(policy.history.maxRankInfluence, 0, 1) || typeof policy.history.basis !== "string") return false;
  if (!sameKeys(policy.anchors, BENCHMARK_DIMENSIONS) || !sameKeys(policy.profiles, PROFILES)) return false;
  if (!Array.isArray(policy.interim.stableDimensions) || !policy.interim.stableDimensions.length || policy.interim.stableDimensions.some((dimension) => !BENCHMARK_DIMENSIONS.includes(dimension as never)) || !finite(policy.interim.maxAssetAgeMs, 1, 31_536_000_000) || typeof policy.interim.basis !== "string") return false;
  for (const dimension of BENCHMARK_DIMENSIONS) {
    const anchor = policy.anchors[dimension];
    if (!isRecord(anchor) || !sameKeys(anchor, ["minimum", "maximum"]) || !finite(anchor.minimum) || !finite(anchor.maximum) || anchor.minimum >= anchor.maximum) return false;
  }
  for (const name of PROFILES) {
    const profile = policy.profiles[name];
    if (!isRecord(profile) || !sameKeys(profile, ["weights", "constraints", "outputTokensMetric", "expectedOutputTokens", "qualityTolerance", "defaultThinking"]) || !isRecord(profile.weights) || !sameKeys(profile.weights, BENCHMARK_DIMENSIONS) || !isRecord(profile.constraints)) return false;
    let total = 0;
    for (const dimension of BENCHMARK_DIMENSIONS) { const weight = profile.weights[dimension]; if (!finite(weight, 0, 1)) return false; total += weight; }
    if (Math.abs(total - 1) > 1e-9 || !sameKeys(profile.constraints, ["requiredInput", "minimumContextWindow", "minimumMaxTokens", "requiresTools"]) || profile.constraints.requiredInput !== "text" || !finite(profile.constraints.minimumContextWindow, 0) || !finite(profile.constraints.minimumMaxTokens, 0) || typeof profile.constraints.requiresTools !== "boolean") return false;
    if (!PROFILES.includes(profile.outputTokensMetric as never) || !finite(profile.expectedOutputTokens, Number.MIN_VALUE) || !finite(profile.qualityTolerance, 0, 100) || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(profile.defaultThinking))) return false;
  }
  return true;
}

export interface LoadedBenchmarkAssets { manifest: BenchmarkManifest; snapshots: BenchmarkSnapshot[]; }
export interface BenchmarkAssetHooks { beforeSnapshotRead?(file: string): void | Promise<void>; }
class MissingReferencedSnapshot extends Error { constructor(readonly manifestText: string) { super("missing referenced benchmark snapshot"); } }
async function secureInfo(target: string, directory: boolean): Promise<void> { const info = await lstat(target); const expected = directory ? 0o700 : 0o600; if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (info.mode & 0o777) !== expected) throw new Error("unsafe benchmark artifact"); }
function runtimeSnapshot(snapshot: any): BenchmarkSnapshot {
  const scores = { ...snapshot.scores, reasoning: snapshot.scores.reasoning ?? snapshot.scores.scientificReasoning ?? null, math: snapshot.scores.math ?? null };
  const evidenceDensity = BENCHMARK_DIMENSIONS.filter((dimension) => scores[dimension] !== null && scores[dimension] !== undefined).length;
  return { ...snapshot, scores, evidenceDensity, scoreSources: Object.fromEntries(BENCHMARK_DIMENSIONS.filter((dimension) => scores[dimension] != null).map((dimension) => [dimension, "artificial-analysis"])) } as BenchmarkSnapshot;
}
async function loadOnce(root: string, maxAgeMs: number, now: number, hooks: BenchmarkAssetHooks): Promise<{ assets: LoadedBenchmarkAssets; manifestText: string }> {
  const manifestPath = path.join(root, "aa-manifest.json"), modelsPath = path.join(root, "models");
  await Promise.all([secureInfo(root, true), secureInfo(modelsPath, true), secureInfo(manifestPath, false)]);
  const manifestText = await readFile(manifestPath, "utf8"); const manifestValue = JSON.parse(manifestText);
  if (!validateManifest(manifestValue) || now - manifestValue.generatedAt > maxAgeMs || manifestValue.generatedAt > now + 60_000) throw new Error("invalid benchmark manifest");
  const sortedModels = [...manifestValue.models].sort(compareIdentity);
  if (canonicalDigest(sortedModels) !== manifestValue.digest) throw new Error("invalid benchmark manifest");
  const snapshots = await Promise.all(sortedModels.map(async (entry) => {
    const snapshotPath = path.join(modelsPath, entry.file); let parsed: unknown;
    try { await secureInfo(snapshotPath, false); await hooks.beforeSnapshotRead?.(entry.file); parsed = JSON.parse(await readFile(snapshotPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingReferencedSnapshot(manifestText); throw error; }
    const variants = extractAaVariants(parsed);
    const snapshot = variants.find((variant) => isRecord(variant) && variant.modelId === entry.modelId && canonicalDigest(variant) === entry.contentDigest)
      ?? (variants.length === 1 && !("aa" in (parsed as object)) ? variants[0] : undefined);
    if (snapshot === undefined) throw new MissingReferencedSnapshot(manifestText);
    if (!validateSnapshot(snapshot) || !isRecord(snapshot) || canonicalDigest(snapshot) !== entry.contentDigest || snapshot.provider !== entry.provider || snapshot.model !== entry.model || snapshot.thinkingLevel !== entry.thinkingLevel || snapshot.modelId !== entry.modelId || manifestValue.generatedAt < entry.capturedAt || now - entry.capturedAt > maxAgeMs || snapshot.capturedAt > now + 60_000) throw new Error("invalid benchmark snapshot");
    return runtimeSnapshot(snapshot);
  }));
  return { assets: { manifest: manifestValue as BenchmarkManifest, snapshots }, manifestText };
}
export async function loadBenchmarkAssets(root = DEFAULT_SNAPSHOT_ROOT, maxAgeMs = 2_592_000_000, now = Date.now(), hooks: BenchmarkAssetHooks = {}): Promise<LoadedBenchmarkAssets | null> {
  try {
    if (!validateRoutingPolicy(ROUTING_POLICY) || !finite(maxAgeMs, 1, 31_536_000_000)) return null;
    try { return (await loadOnce(root, maxAgeMs, now, hooks)).assets; }
    catch (error) {
      if (!(error instanceof MissingReferencedSnapshot)) throw error;
      const manifestPath = path.join(root, "aa-manifest.json"); await secureInfo(manifestPath, false); const next = await readFile(manifestPath, "utf8");
      if (next === error.manifestText) throw error;
      return (await loadOnce(root, maxAgeMs, now, hooks)).assets;
    }
  } catch { return null; }
}
export { validateManifest as validManifest, validateSnapshot as validSnapshot };
export async function loadBenchmarkHealth(root = DEFAULT_SNAPSHOT_ROOT, maxAgeMs = 2_592_000_000, now = Date.now()): Promise<BenchmarkHealthState | null> {
  try {
    if (!finite(maxAgeMs, 1, 31_536_000_000)) return null;
    const file = path.join(root, "benchmark-health.json"); await secureInfo(file, false);
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!validateBenchmarkHealth(value) || now - value.generatedAt > maxAgeMs || value.generatedAt > now + 60_000) return null;
    return { generatedAt: value.generatedAt, fields: value.fields };
  } catch { return null; }
}
