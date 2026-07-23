import { copyFile, mkdir, rename, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

/** Copy through a same-directory temporary file so SessionManager always sees a local JSONL path, even across devices. */
export async function materializeSession(source: string, sessionsDir: string): Promise<string> {
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  const destination = resolve(sessionsDir, basename(source));
  if (!destination.startsWith(resolve(sessionsDir) + "/")) throw new Error("Invalid session filename");
  const temporary = `${destination}.handoff-${process.pid}-${Date.now()}.tmp`;
  await copyFile(source, temporary); await stat(temporary); await rename(temporary, destination); return destination;
}
