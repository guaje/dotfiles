import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { saveManifest, saveSnapshot } from "./session-store.ts";
import { shellLiteral, sshExec } from "./transport.ts";
import type { HandoffState } from "./types.ts";

const helper = "${HOME}/.local/libexec/pi-handoff-gate.py";
function hash(data: Buffer) { return createHash("sha256").update(data).digest("hex"); }
async function gate(state: HandoffState, args: string, stdin?: Buffer) {
  if (!state.target || !state.sessionId) throw new Error("No remote session selected");
  const command = stdin ? `printf %s ${shellLiteral(stdin.toString("base64"))} | base64 -d | python3 ${helper} ${args}` : `python3 ${helper} ${args}`;
  const output = await sshExec(state.target, command); const value = JSON.parse(output.stdout.toString()) as { ok: boolean; error?: string; [key: string]: any };
  if (!value.ok) throw new Error(value.error || "remote handoff helper failed"); return value;
}
/** Lock/CAS synchronization. Any transport ambiguity leaves the dirty cache untouched. */
export async function synchronize(state: HandoffState, localSessionFile: string): Promise<HandoffState> {
  if (!state.target || !state.sessionId) throw new Error("No remote session selected");
  const lock = await gate(state, `acquire-lock ${shellLiteral(state.sessionId)} --owner ${shellLiteral(process.env.USER || "pi")}`);
  try {
    const current = await gate(state, `fetch-manifest ${shellLiteral(state.sessionId)}`).catch(() => undefined);
    const local = await readFile(localSessionFile); const digest = hash(local);
    const expected = current?.manifest ?? { generation: 0, hash: null };
    const committed = await gate(state, `commit ${shellLiteral(state.sessionId)} --nonce ${shellLiteral(lock.nonce)} --token ${shellLiteral(lock.token)} --generation ${expected.generation} --expected-hash ${shellLiteral(expected.hash ?? "")} --hash ${shellLiteral(digest)}`, local);
    await saveSnapshot(state.sessionId, local); await saveManifest(state.sessionId, committed.manifest);
    return { ...state, syncState: "clean", manifest: committed.manifest, lock: undefined };
  } catch (error) {
    // Reread after any ambiguous failure. A changed manifest is a conflict, never a local fallback.
    try { const latest = await gate(state, `fetch-manifest ${shellLiteral(state.sessionId)}`); return { ...state, syncState: "conflict", manifest: latest.manifest }; } catch { return { ...state, syncState: "offline" }; }
  } finally { if (lock?.nonce && lock?.token) await gate(state, `release-lock ${shellLiteral(state.sessionId)} --nonce ${shellLiteral(lock.nonce)} --token ${shellLiteral(lock.token)}`).catch(() => undefined); }
}
