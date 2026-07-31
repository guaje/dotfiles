import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MAX_PROTOCOL_BYTES, HANDOFF_PROTOCOL_VERSION, helperRemotePath } from "./config.ts";
import { assertRemoteHelperReady } from "./installer.ts";
import { decodeGateResponse, encodeGateRequest, type GateResponse } from "./protocol.ts";
import { saveManifest, saveSnapshot } from "./session-store.ts";
import { getHandoffSettings } from "./settings.ts";
import { shellLiteral, sshExec } from "./transport.ts";
import type { HandoffState, RemoteTarget } from "./types.ts";

function hash(data: Buffer) { return createHash("sha256").update(data).digest("hex"); }

export class HandoffGateError extends Error {
  constructor(readonly response: GateResponse) { super(response.error || "remote Handoff helper failed"); }
}

export async function requestGate(target: Pick<RemoteTarget, "alias" | "user" | "port">, command: string, args: string[] = [], data?: Buffer) {
  await assertRemoteHelperReady(target);
  const request = encodeGateRequest({ version: HANDOFF_PROTOCOL_VERSION, command, args, ...(data ? { dataBase64: data.toString("base64") } : {}) });
  const settings = await getHandoffSettings();
  const output = await sshExec(
    { ...target, stdin: request, maxOutputBytes: MAX_PROTOCOL_BYTES },
    `PI_HANDOFF_ROOT=${shellLiteral(settings.handoffRemoteRoot)} python3 ${helperRemotePath} --stdio`,
  );
  const value = decodeGateResponse(output.stdout);
  if (!value.ok) throw new HandoffGateError(value);
  return value;
}

export interface SynchronizeDependencies {
  request?: typeof requestGate;
  confirmRecovery?: (message: string) => Promise<boolean>;
  saveSnapshot?: typeof saveSnapshot;
  saveManifest?: typeof saveManifest;
}

/** Lock/CAS synchronization. Any transport ambiguity leaves the dirty cache untouched. */
export async function synchronize(state: HandoffState, localSessionFile: string, dependencies: SynchronizeDependencies = {}): Promise<HandoffState> {
  if (!state.target || !state.sessionId) throw new Error("No remote session selected");
  const request = dependencies.request ?? requestGate;
  let lock: any;
  try {
    lock = await request(state.target, "acquire-lock", [state.sessionId, "--owner", process.env.USER || "pi"]);
  } catch (error) {
    const response = error instanceof HandoffGateError ? error.response : undefined;
    const recoveryToken = response?.recoveryToken;
    if (!response?.recoveryRequired || typeof recoveryToken !== "string" || !dependencies.confirmRecovery || !await dependencies.confirmRecovery(`Recover the expired lock for session ${state.sessionId}?`)) {
      return { ...state, syncState: "offline" };
    }
    await request(state.target, "recover-lock", [state.sessionId, "--token", recoveryToken]);
    lock = await request(state.target, "acquire-lock", [state.sessionId, "--owner", process.env.USER || "pi"]);
  }
  try {
    const current = await request(state.target, "fetch-manifest", [state.sessionId]).catch(() => undefined);
    const local = await readFile(localSessionFile);
    const digest = hash(local);
    const expected: any = current?.manifest ?? { generation: 0, hash: null };
    const committed: any = await request(state.target, "commit", [state.sessionId, "--nonce", lock.nonce, "--token", lock.token, "--generation", String(expected.generation), "--expected-hash", expected.hash ?? "", "--hash", digest], local);
    await (dependencies.saveSnapshot ?? saveSnapshot)(state.sessionId, local);
    await (dependencies.saveManifest ?? saveManifest)(state.sessionId, committed.manifest);
    return { ...state, syncState: "clean", manifest: committed.manifest, lock: undefined };
  } catch {
    try {
      const latest: any = await request(state.target, "fetch-manifest", [state.sessionId]);
      return { ...state, syncState: "conflict", manifest: latest.manifest };
    } catch { return { ...state, syncState: "offline" }; }
  } finally {
    if (lock?.nonce && lock?.token) await request(state.target, "release-lock", [state.sessionId, "--nonce", lock.nonce, "--token", lock.token]).catch(() => undefined);
  }
}
