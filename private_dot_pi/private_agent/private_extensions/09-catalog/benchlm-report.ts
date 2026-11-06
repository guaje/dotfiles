import path from "node:path";
import { DEFAULT_SNAPSHOT_ROOT } from "../04-subagents/benchmark-assets.ts";
import { evaluateBenchmarkGates, ROUTING_PROFILES } from "../04-subagents/benchmark-qualification.ts";
import type { BenchmarkDimension, BenchmarkSnapshot, RoutingProfile } from "../04-subagents/benchmark-types.ts";
import { loadBenchLmAssets, loadRoutingBenchmarkAssets } from "../04-subagents/benchlm-assets.ts";
import { DEFAULT_BENCHLM_ROOT, loadBenchLmMappings } from "./benchlm/service.ts";

export interface BenchLmCategorySummary { key: string; score: number; provenance: string; rows: number; independentlyVerified: number; }
export interface BenchLmModelSummary { runtimeId: string; modelAliases: string[]; model: string; creator: string; sourceUrl: string | null; detailRows: number; categories: BenchLmCategorySummary[]; unusedCategories: number; profiles: RoutingProfile[]; }
export interface BenchLmSyncSummary { methodologyVersion: string; sourceSnapshotId: string; lastUpdated: string; license: string; generatedAt: number; models: BenchLmModelSummary[]; }

/**
 * What the reviewed BenchLM generation actually says about each enabled model, read back from disk after
 * publication so the report describes the generation routing will use rather than what was fetched.
 * Profile names here are evidence-only: they answer "would this model pass the benchmark gates for that
 * job type", and deliberately exclude the capability limits (context window, tool calling) that only the
 * live model registry can supply.
 */
export async function collectBenchLmSummary(now = Date.now(), aaRoot = DEFAULT_SNAPSHOT_ROOT, benchRoot = DEFAULT_BENCHLM_ROOT): Promise<BenchLmSyncSummary | null> {
  try {
    const [reviewed, merged, mappings] = await Promise.all([
      loadBenchLmAssets(benchRoot, undefined, now),
      loadRoutingBenchmarkAssets(aaRoot, benchRoot, undefined, now),
      loadBenchLmMappings(path.join(benchRoot, "benchlm-mappings.json")).catch(() => []),
    ]);
    if (!reviewed || !merged?.benchLm) return null;
    // The profile URL comes from the reviewed slug, not the runtime identifier: a renamed endpoint must
    // never grow a plausible-looking BenchLM link.
    const profileUrlByRuntime = new Map<string, string>();
    for (const entry of mappings) { const sourceUrl = `https://benchlm.ai/models/${entry.slug}`; profileUrlByRuntime.set(entry.runtimeId, sourceUrl); profileUrlByRuntime.set(entry.canonicalId, sourceUrl); }
    const mergedByRuntime = new Map<string, BenchmarkSnapshot>();
    for (const snapshot of merged.snapshots) {
      const id = `${snapshot.provider}/${snapshot.model}`;
      if (!mergedByRuntime.has(id) || snapshot.thinkingLevel === null) mergedByRuntime.set(id, snapshot);
    }
    const routed = new Set<string>(BENCHLM_ROUTED_COLUMNS);
    const models = reviewed.snapshots.map((snapshot): BenchLmModelSummary => {
      const categories: BenchLmCategorySummary[] = [];
      let unused = 0;
      for (const [key, value] of Object.entries(snapshot.categoryScores)) {
        if (typeof value !== "number") continue;
        if (!routed.has(key)) { unused++; continue; }
        categories.push({ key, score: value, provenance: snapshot.categoryProvenance?.[key as keyof typeof snapshot.categoryProvenance] ?? "published", rows: snapshot.categoryEvidence?.[key as keyof typeof snapshot.categoryEvidence]?.rows ?? 0, independentlyVerified: snapshot.categoryEvidence?.[key as keyof typeof snapshot.categoryEvidence]?.independentlyVerified ?? 0 });
      }
      const combined = mergedByRuntime.get(snapshot.runtimeId);
      const profiles = combined
        ? ROUTING_PROFILES.filter((profile) => !evaluateBenchmarkGates(combined, profile, undefined, "strict").gateReason)
        : [];
      return { runtimeId: snapshot.runtimeId, modelAliases: snapshot.modelAliases ?? [snapshot.runtimeId], model: snapshot.model, creator: snapshot.creator, sourceUrl: profileUrlByRuntime.get(snapshot.runtimeId) ?? null, detailRows: snapshot.details?.length ?? 0, categories, unusedCategories: unused, profiles };
    }).sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
    return { methodologyVersion: reviewed.manifest.methodologyVersion, sourceSnapshotId: reviewed.manifest.sourceSnapshotId, lastUpdated: models.length ? reviewed.snapshots[0]!.lastUpdated : "", license: reviewed.snapshots[0]?.license ?? "CC BY-NC 4.0", generatedAt: reviewed.manifest.generatedAt, models };
  } catch { return null; }
}

/** The columns BenchLM owns under the published routing policy; its multilingual and multimodal figures
 * are archived but never routed on, so they are counted rather than listed. */
export const BENCHLM_ROUTED_COLUMNS: readonly BenchmarkDimension[] = ["coding", "agentic", "instructionFollowing", "knowledge", "reasoning", "math"];
