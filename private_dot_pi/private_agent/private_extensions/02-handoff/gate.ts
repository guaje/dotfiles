import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { HANDOFF_PROTOCOL_VERSION, helperSource } from "./config.ts";

export async function helperChecksum(path = helperSource) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
/** Installation is deliberately explicit: callers must obtain UI confirmation first. */
export async function installHelper(destination = resolve(process.env.HOME ?? "", ".local/libexec/pi-handoff-gate.py")) { await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await copyFile(helperSource, destination); await chmod(destination, 0o700); return { destination, checksum: await helperChecksum(destination), version: HANDOFF_PROTOCOL_VERSION }; }
export function verifyHelperPreflight(result: { version?: number; checksum?: string }, checksum: string) { return result.version === HANDOFF_PROTOCOL_VERSION && result.checksum === checksum; }
