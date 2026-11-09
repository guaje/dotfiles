import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalDigest, record, type BenchLmSnapshot } from "../09-catalog/benchlm/schema.ts";
import { loadBenchmarkAssets, type LoadedBenchmarkAssets } from "./benchmark-assets.ts";
import type { BenchmarkDimension, BenchmarkSnapshot } from "./benchmark-types.ts";
const DEFAULT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");
interface Manifest { version: 1; generatedAt: number; methodologyVersion: string; sourceSnapshotId: string; digest: string; models: Array<{ runtimeId: string; canonicalId: string; file: string; contentDigest: string }>; }
async function safeFile(file: string): Promise<void> { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error("unsafe BenchLM asset"); }
export async function loadBenchLmAssets(root = DEFAULT_ROOT, maxAgeMs = 2_592_000_000, now = Date.now()): Promise<{ manifest: Manifest; snapshots: BenchLmSnapshot[] } | null> {
  try {
    const file = path.join(root, "benchlm-manifest.json"); await safeFile(file); const manifest: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!record(manifest) || manifest.version !== 1 || typeof manifest.generatedAt !== "number" || now - manifest.generatedAt > maxAgeMs || !Array.isArray(manifest.models) || typeof manifest.digest !== "string" || canonicalDigest(manifest.models) !== manifest.digest) return null;
    const loaded = await Promise.all(manifest.models.map(async (entry: any) => {
      if (!record(entry) || !/^[A-Za-z0-9._-]+\.json$/.test(String(entry.file)) || String(entry.file).includes("..")) throw new Error("invalid BenchLM manifest");
      const snapshotFile = path.join(root, "models", entry.file); await safeFile(snapshotFile);
      const raw: unknown = JSON.parse(await readFile(snapshotFile, "utf8"));
      const value: unknown = (raw && typeof raw === "object" && "benchlm" in (raw as object)) ? ((raw as { benchlm?: unknown }).benchlm ?? {}) : raw;
      const aliases = record(value) && Array.isArray(value.modelAliases) ? value.modelAliases : [];
      const coversEntry = record(value) && (value.runtimeId === entry.runtimeId || aliases.includes(entry.runtimeId));
      if (!record(value) || typeof value.methodologyVersion !== "string" || typeof value.details === "undefined" || canonicalDigest(value) !== entry.contentDigest || !coversEntry || value.canonicalId !== entry.canonicalId) throw new Error("invalid BenchLM snapshot");
      return { file: String(entry.file), snapshot: value as unknown as BenchLmSnapshot };
    }));
    // Endpoints of one model share one composite: emit its snapshot once, with modelAliases carrying every
    // endpoint that may route on it.
    const snapshots = [...new Map(loaded.map((entry) => [entry.file, entry.snapshot])).values()];
    return { manifest: manifest as unknown as Manifest, snapshots };
  } catch { return null; }
}
const sourceMap: Partial<Record<keyof BenchLmSnapshot["categoryScores"], BenchmarkDimension>> = { coding: "coding", agentic: "agentic", instructionFollowing: "instructionFollowing", knowledge: "knowledge", reasoning: "reasoning", math: "math" };
function mergeSnapshot(bench: BenchLmSnapshot, aa?: BenchmarkSnapshot): BenchmarkSnapshot {
  const slash = bench.runtimeId.indexOf("/"), provider = bench.runtimeId.slice(0, slash), model = bench.runtimeId.slice(slash + 1);
  const scores: BenchmarkSnapshot["scores"] = { coding: null, agentic: null, toolUse: aa?.scores.toolUse ?? null, reasoning: null, math: null, longContext: aa?.scores.longContext ?? null, instructionFollowing: null, knowledge: null, faithfulness: aa?.scores.faithfulness ?? null };
  const scoreSources: BenchmarkSnapshot["scoreSources"] = {};
  for (const [source, dimension] of Object.entries(sourceMap)) { const value = bench.categoryScores[source as keyof typeof bench.categoryScores]; if (typeof value === "number") { scores[dimension!] = value; scoreSources[dimension!] = "benchlm"; } }
  for (const dimension of ["toolUse", "longContext", "faithfulness"] as BenchmarkDimension[]) if (scores[dimension] != null) scoreSources[dimension] = "artificial-analysis";
  const evidenceDensity = Object.values(bench.categoryScores).filter((value) => typeof value === "number").length;
  return { ...(aa ?? { version: 1, thinkingLevel: null, modelId: `benchlm:${bench.canonicalId}`, mapping: { status: "mapped", matchBasis: "manual", reviewedAt: bench.capturedAt, thinkingLevel: null }, source: { name: bench.model, slug: "benchlm", openrouterApiId: null }, toolUse: { components: { tau3Banking: null, gdpvalAaNormalized: null, tau2Telecom: null }, derivation: { version: "v1", rule: "unavailable", score: null } }, outputTokens: {}, taskTimeMs: {}, coverage: 0 }), provider, model, capturedAt: bench.capturedAt, methodology: { id: "benchlm", version: bench.methodologyVersion }, scores, scoreSources, evidenceDensity, coverage: evidenceDensity / 8 } as BenchmarkSnapshot;
}
export async function loadRoutingBenchmarkAssets(aaRoot: string, benchRoot = DEFAULT_ROOT, maxAgeMs = 2_592_000_000, now = Date.now()): Promise<(LoadedBenchmarkAssets & { benchLm: boolean }) | null> {
  const [aa, bench] = await Promise.all([loadBenchmarkAssets(aaRoot, maxAgeMs, now), loadBenchLmAssets(benchRoot, maxAgeMs, now)]);
  if (!bench) return aa ? { ...aa, benchLm: false } : null;
  const matched = new Set<string>();
  const merged = bench.snapshots.flatMap((entry) => {
    const aliases = new Set([entry.runtimeId, entry.canonicalId, ...(entry.modelAliases ?? [])]);
    const matches = (aa?.snapshots ?? []).filter((snapshot) => aliases.has(`${snapshot.provider}/${snapshot.model}`));
    for (const snapshot of matches) matched.add(`${snapshot.provider}/${snapshot.model}\0${snapshot.thinkingLevel ?? ""}`);
    // BenchLM scores the model, not a thinking level, while Artificial Analysis publishes per-level variants.
    // Keep a level-agnostic view beside those variants, otherwise a model whose AA variants sit at other
    // levels is dropped for wanting an exact level match even though its report card is right there.
    const levelAgnostic = matches.some((snapshot) => snapshot.thinkingLevel === null) ? [] : [mergeSnapshot(entry, undefined)];
    return [...matches.map((snapshot) => mergeSnapshot(entry, snapshot)), ...levelAgnostic];
  });
  // A model BenchLM no longer lists keeps ranking on Artificial Analysis evidence alone. Losing one
  // publisher must never shrink the fleet: a model that vanishes from the feed loses those columns
  // (weights renormalise over what is left), it does not become unroutable.
  const unmatched = (aa?.snapshots ?? []).filter((snapshot) => !matched.has(`${snapshot.provider}/${snapshot.model}\0${snapshot.thinkingLevel ?? ""}`));
  const snapshots = [...merged, ...unmatched];
  return { manifest: { ...(aa?.manifest ?? { version: 4, generatedAt: bench.manifest.generatedAt, methodology: { id: "benchlm", version: bench.manifest.methodologyVersion }, models: [] }), digest: canonicalDigest([aa?.manifest.digest ?? "", bench.manifest.digest]) }, snapshots, benchLm: true } as LoadedBenchmarkAssets & { benchLm: boolean };
}
