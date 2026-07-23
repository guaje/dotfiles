import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheRoot } from "./config.ts";

export function cacheDirectory(sessionId: string) { if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === "." || sessionId === "..") throw new Error("Invalid remote session id"); return join(cacheRoot, sessionId); }
export async function saveSnapshot(sessionId: string, content: Buffer) { const dir = cacheDirectory(sessionId); await mkdir(dir, { recursive: true, mode: 0o700 }); const path = join(dir, "session.jsonl"); await writeFile(path, content, { mode: 0o600 }); return path; }
export async function loadSnapshot(sessionId: string) { return readFile(join(cacheDirectory(sessionId), "session.jsonl")); }
export async function saveManifest(sessionId: string, manifest: unknown) { const dir = cacheDirectory(sessionId); await mkdir(dir, { recursive: true, mode: 0o700 }); await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 }); }
