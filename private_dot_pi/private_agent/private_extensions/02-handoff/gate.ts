import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { HANDOFF_PROTOCOL_VERSION, helperSource } from "./config.ts";

export interface HelperArtifact { bytes: Buffer; checksum: string; version: number }

export async function loadHelperArtifact(path = helperSource): Promise<HelperArtifact> {
  const bytes = await readFile(path);
  return { bytes, checksum: createHash("sha256").update(bytes).digest("hex"), version: HANDOFF_PROTOCOL_VERSION };
}

export async function helperChecksum(path = helperSource) { return (await loadHelperArtifact(path)).checksum; }

export function verifyHelperPreflight(result: { version?: number; checksum?: string }, checksum: string) {
  return result.version === HANDOFF_PROTOCOL_VERSION && result.checksum === checksum;
}
