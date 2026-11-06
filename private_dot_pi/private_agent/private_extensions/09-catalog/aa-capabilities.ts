import { loadBenchmarkAssets } from "../04-subagents/benchmark-assets.ts";
import type { BenchmarkSnapshot } from "../04-subagents/benchmark-types.ts";
import { baseConfig } from "./aa/config.ts";

/** Capability evidence a reviewed Artificial Analysis snapshot captured for one runtime model. */
export interface ReviewedModelCapabilities {
  input?: ("text" | "image")[];
  reasoning?: boolean;
}

interface Accumulated {
  inputs: Set<string>;
  reasonings: Set<boolean>;
}

/** Modality sets compare order-insensitively but are emitted in pi's canonical text-first order. */
function decode(modalities: string): ("text" | "image")[] {
  const present = new Set(modalities.split(","));
  return (["text", "image"] as const).filter((modality) => present.has(modality));
}

/** Fold one capture per runtime identity, dropping any field the captures disagree on. */
export function accumulateCapabilities(snapshots: readonly Pick<BenchmarkSnapshot, "provider" | "model" | "capabilities">[]): ReadonlyMap<string, ReviewedModelCapabilities> {
  const accumulated = new Map<string, Accumulated>();
  for (const snapshot of snapshots) {
    const capabilities = snapshot.capabilities;
    if (!capabilities || (!capabilities.input && capabilities.reasoning === undefined)) continue;
    const id = `${snapshot.provider}/${snapshot.model}`;
    const entry = accumulated.get(id) ?? { inputs: new Set<string>(), reasonings: new Set<boolean>() };
    if (capabilities.input) entry.inputs.add([...capabilities.input].sort().join(","));
    if (capabilities.reasoning !== undefined) entry.reasonings.add(capabilities.reasoning);
    accumulated.set(id, entry);
  }
  const reviewed = new Map<string, ReviewedModelCapabilities>();
  for (const [id, entry] of accumulated) {
    const capabilities: ReviewedModelCapabilities = {};
    if (entry.inputs.size === 1) capabilities.input = decode([...entry.inputs][0]!);
    if (entry.reasonings.size === 1) capabilities.reasoning = [...entry.reasonings][0]!;
    if (capabilities.input || capabilities.reasoning !== undefined) reviewed.set(id, capabilities);
  }
  return reviewed;
}

export async function loadReviewedCapabilities(): Promise<ReadonlyMap<string, ReviewedModelCapabilities>> {
  try {
    const config = baseConfig();
    const assets = await loadBenchmarkAssets(config.paths.snapshotRoot, config.limits.maxAgeMs);
    if (!assets) return new Map();
    return accumulateCapabilities(assets.snapshots);
  } catch {
    return new Map();
  }
}
