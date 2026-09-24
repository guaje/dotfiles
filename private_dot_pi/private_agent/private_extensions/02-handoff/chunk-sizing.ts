import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_CHUNK_BYTES, cacheRoot } from "./config.ts";

/**
 * Chunk sizes are chosen from measured transfer speed: each chunk aims to occupy the link for about
 * TARGET_CHUNK_SECONDS, so a fast network carries large chunks and a poor one stays conservative.
 * The bounds keep a single chunk inside the request envelope and the remote helper's own cap.
 */
export const CHUNK_MIN_BYTES = 256 * 1024;
export const CHUNK_MAX_BYTES = 4 * 1024 * 1024;
const TARGET_CHUNK_SECONDS = 0.5;

export interface TransferSample { bytes: number; ms: number; ok: boolean }
interface TargetRecord { chunkBytes: number; bytesPerMs?: number }
export type ChunkHistory = Record<string, TargetRecord>;

export function targetKey(target: { alias: string; user?: string; port?: number }) { return `${target.user ?? ""}@${target.alias}:${target.port ?? 22}`; }

function clamp(bytes: number, negotiated: number) { return Math.max(CHUNK_MIN_BYTES, Math.min(CHUNK_MAX_BYTES, negotiated, bytes)); }

/** Size for the next transfer: unknown links start at the mirrored default, known ones from their record. */
export function pickChunkBytes(target: { alias: string; user?: string; port?: number }, history: ChunkHistory, negotiated: number = MAX_CHUNK_BYTES) {
  const record = history[targetKey(target)];
  if (!record) return clamp(MAX_CHUNK_BYTES, negotiated);
  const bySpeed = record.bytesPerMs ? record.bytesPerMs * TARGET_CHUNK_SECONDS * 1000 : record.chunkBytes;
  return clamp(bySpeed, negotiated);
}

/** A finished transfer refines the estimate; a failed one halves the size so the next try is cheaper. */
export function recordTransfer(history: ChunkHistory, key: string, sample: TransferSample): ChunkHistory {
  const record = history[key] ?? { chunkBytes: MAX_CHUNK_BYTES };
  const next: TargetRecord = sample.ok
    ? { chunkBytes: clamp(sample.bytes / Math.max(sample.ms, 1) * TARGET_CHUNK_SECONDS * 1000), bytesPerMs: sample.bytes / Math.max(sample.ms, 1) }
    : { chunkBytes: Math.max(CHUNK_MIN_BYTES, Math.floor((record.bytesPerMs ? record.bytesPerMs * TARGET_CHUNK_SECONDS * 1000 : record.chunkBytes) / 2)) };
  return { ...history, [key]: next };
}

export interface ChunkSizer {
  pick: (target: { alias: string; user?: string; port?: number }, negotiated?: number) => number;
  record: (target: { alias: string; user?: string; port?: number }, sample: TransferSample) => void;
}

/** Loads the measured history once; samples are persisted best-effort, since they are advisory only. */
export async function createChunkSizer(historyPath = join(cacheRoot, "chunk-sizes.json")): Promise<ChunkSizer> {
  let history: ChunkHistory = {};
  try { history = JSON.parse(await readFile(historyPath, "utf8")) as ChunkHistory; } catch { /* no history yet */ }
  const save = async () => {
    try { await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 }); } catch { /* measurements are advisory */ }
  };
  return {
    pick: (target, negotiated) => pickChunkBytes(target, history, negotiated),
    record: (target, sample) => { history = recordTransfer(history, targetKey(target), sample); void save(); },
  };
}
