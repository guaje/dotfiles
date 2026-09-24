import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MAX_CHUNK_BYTES, MAX_PROTOCOL_BYTES, MAX_SNAPSHOT_BYTES, DIRECT_COMMIT_BYTES, HANDOFF_PROTOCOL_VERSION, helperRemotePath } from "./config.ts";
import { assertRemoteHelperReady, remoteLimits, type RemoteLimits } from "./installer.ts";
import { decodeGateResponse, encodeGateRequest, type GateResponse } from "./protocol.ts";
import { parseSessionFile } from "./session-merge.ts";
import { saveManifest, saveSnapshot } from "./session-store.ts";
import { getHandoffSettings } from "./settings.ts";
import { shellLiteral, sshExec } from "./transport.ts";
import type { TransferSample } from "./chunk-sizing.ts";
import type { HandoffState, RemoteTarget, SyncProgress } from "./types.ts";

function hash(data: Buffer) { return createHash("sha256").update(data).digest("hex"); }

export class HandoffGateError extends Error {
  constructor(readonly response: GateResponse) { super(response.error || "remote Handoff helper failed"); }
}

export async function requestGate(target: Pick<RemoteTarget, "alias" | "user" | "port">, command: string, args: string[] = [], data?: Buffer) {
  await assertRemoteHelperReady(target);
  const request = encodeGateRequest({ version: HANDOFF_PROTOCOL_VERSION, command, args, ...(data ? { dataBase64: data.toString("base64") } : {}) });
  const settings = await getHandoffSettings();
  const output = await sshExec(
    { ...target, stdin: request, maxOutputBytes: MAX_PROTOCOL_BYTES, acceptedExitCodes: [0, 2] },
    `PI_HANDOFF_ROOT=${shellLiteral(settings.handoffRemoteRoot)} python3 ${helperRemotePath} --stdio`,
  );
  const value = decodeGateResponse(output.stdout);
  if (!value.ok) throw new HandoffGateError(value);
  return value;
}

export interface SynchronizeDependencies {
  request?: typeof requestGate;
  limits?: typeof remoteLimits;
  confirmRecovery?: (message: string) => Promise<boolean>;
  saveSnapshot?: typeof saveSnapshot;
  saveManifest?: typeof saveManifest;
  /** Reports transfer progress so the HUD can show where a large session is. */
  onProgress?: (update: SyncProgress) => void;
  /** Chooses the chunk size from measured link quality; the negotiated helper cap is always respected. */
  pickChunkBytes?: (target: Pick<RemoteTarget, "alias" | "user" | "port">, negotiated: number) => number;
  /** Receives one sample per staged upload so later transfers start from measured reality. */
  onTransferSample?: (sample: TransferSample) => void;
  /** Test seam for reading the remote head during the overwrite check. */
  fetch?: typeof fetchSnapshot;
  /** Test seam: payload size above which staged chunked upload is used. */
  chunkThresholdBytes?: number;
  now?: () => number;
  leaseRenewMs?: number;
}

const MAX_OFFLINE_REASON = 200;
/** The only remote rejection that genuinely means the remote moved. Every other rejection is a failure, not a conflict. */
const CAS_CONFLICT = "generation or hash conflict";

function describe(error: unknown): string {
  if (error instanceof HandoffGateError) return error.response.error || "remote Handoff helper failed";
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function megabytes(bytes: number): string { return `${(bytes / (1024 * 1024)).toFixed(2)} MB`; }

/** Bounded reason that always starts with its stage; long details keep their tail, preserving the actionable line of remote helper tracebacks (e.g. ENOSPC). */
function bounded(stage: string, detail?: string): string {
  const tail = (detail ?? "").replace(/\s+/g, " ").trim();
  if (!tail) return stage;
  const budget = MAX_OFFLINE_REASON - stage.length - 4;
  const body = tail.length > budget ? (budget > 0 ? `…${tail.slice(-budget)}` : "…") : tail;
  return `${stage}: ${body}`;
}

function offline(state: HandoffState, stage: string, detail?: string): HandoffState {
  return { ...state, syncState: "offline", syncReason: bounded(stage, detail) };
}

/** Remote head (generation and content hash) for a session, or undefined when it has none or cannot be read. */
export async function remoteManifest(target: Pick<RemoteTarget, "alias" | "user" | "port">, sessionId: string, request: typeof requestGate = requestGate): Promise<{ generation: number; hash: string | null } | undefined> {
  const value = await request(target, "fetch-manifest", [sessionId]).catch(() => undefined);
  return (value as any)?.manifest;
}

/** Download the committed remote snapshot in envelope-sized pieces and verify it against the manifest hash. */
export async function fetchSnapshot(target: Pick<RemoteTarget, "alias" | "user" | "port">, sessionId: string, request: typeof requestGate = requestGate, chunkBytes = MAX_CHUNK_BYTES, options: { observe?: (manifest: any) => void; onProgress?: (done: number, total: number) => void } = {}): Promise<Buffer> {
  const pieces: Buffer[] = [];
  let offset = 0;
  let total: number | undefined;
  let expected: string | undefined;
  for (;;) {
    const page: any = await request(target, "fetch-chunk", [sessionId, "--offset", String(offset), "--length", String(chunkBytes)]);
    if (typeof page?.total !== "number" || typeof page?.base64 !== "string") throw new Error("remote helper returned an invalid snapshot chunk");
    total ??= page.total;
    if (total > MAX_SNAPSHOT_BYTES) throw new Error(`remote declared ${total} bytes, above the ${MAX_SNAPSHOT_BYTES} byte session limit`);
    if (typeof page.manifest?.hash === "string") { expected = page.manifest.hash; options.observe?.(page.manifest); }
    const piece = Buffer.from(page.base64, "base64");
    if (piece.length === 0) break;
    pieces.push(piece);
    offset += piece.length;
    options.onProgress?.(offset, total);
    if (offset >= total) break;
  }
  const data = Buffer.concat(pieces);
  if (total !== undefined && data.length !== total) throw new Error(`snapshot download stopped at ${data.length} of ${total} bytes`);
  if (expected && hash(data) !== expected) throw new Error("snapshot download failed its hash check");
  return data;
}

/** Staged upload: the remote assembles and verifies chunks, then promotes once under the same CAS as a single-shot commit. */
async function uploadChunked(request: typeof requestGate, state: HandoffState, lock: any, local: Buffer, expected: any, chunkBytes: number, dependencies: SynchronizeDependencies) {
  const pieces = Math.ceil(local.length / chunkBytes);
  dependencies.onProgress?.({ phase: "upload", unit: "chunk", done: 0, total: pieces });
  const target = state.target!;
  const sessionId = state.sessionId!;
  const digest = hash(local);
  const started: any = await request(target, "begin-upload", [sessionId, "--nonce", lock.nonce, "--token", lock.token, "--total-bytes", String(local.length), "--chunk-bytes", String(chunkBytes), "--sha256", digest]);
  const upload = started?.upload;
  if (!upload || typeof upload.id !== "string") throw new Error("remote helper returned no upload handle");
  const now = dependencies.now ?? Date.now;
  const lease = dependencies.leaseRenewMs ?? 30_000;
  let renewAt = now() + lease;
  try {
    for (let offset = 0, index = 0; offset < local.length; offset += chunkBytes, index += 1) {
      if (now() >= renewAt) {
        await request(target, "renew-lock", [sessionId, "--nonce", lock.nonce, "--token", lock.token]);
        renewAt = now() + lease;
      }
      const chunk = local.subarray(offset, Math.min(offset + chunkBytes, local.length));
      await request(target, "put-chunk", [sessionId, "--upload", upload.id, "--index", String(index), "--nonce", lock.nonce, "--token", lock.token, "--sha256", hash(chunk)], chunk);
      dependencies.onProgress?.({ phase: "upload", unit: "chunk", done: index + 1, total: pieces });
    }
    return await request(target, "finish-upload", [sessionId, "--upload", upload.id, "--nonce", lock.nonce, "--token", lock.token, "--generation", String(expected.generation), "--expected-hash", expected.hash ?? "", "--hash", digest]);
  } catch (error) {
    await request(target, "abort-upload", [sessionId, "--upload", upload.id, "--nonce", lock.nonce, "--token", lock.token]).catch(() => undefined);
    throw error;
  }
}

/** True when every entry of the remote snapshot also exists locally, i.e. pushing loses nothing. */
function remoteTurnsPreserved(local: Buffer, remote: Buffer): boolean {
  try {
    const ids = new Set(parseSessionFile(local.toString("utf8")).entries.map((entry) => entry.id));
    return parseSessionFile(remote.toString("utf8")).entries.every((entry) => ids.has(entry.id));
  } catch { return false; }
}

/** Lock/CAS synchronization. Any transport ambiguity leaves the dirty cache untouched. */
export async function synchronize(state: HandoffState, localSessionFile: string, dependencies: SynchronizeDependencies = {}): Promise<HandoffState> {
  if (!state.target || !state.sessionId) throw new Error("No remote session selected");
  const request = dependencies.request ?? requestGate;
  const local = await readFile(localSessionFile);
  const threshold = dependencies.chunkThresholdBytes ?? DIRECT_COMMIT_BYTES;
  let limits: RemoteLimits | undefined;
  if (local.length > threshold) {
    try { limits = await (dependencies.limits ?? remoteLimits)(state.target); }
    catch (error) { return offline(state, "remote capability check failed", describe(error)); }
    const cap = limits?.snapshotBytes ?? MAX_SNAPSHOT_BYTES;
    if (local.length > cap) {
      return offline(state, "commit refused", `session ${megabytes(local.length)} exceeds the ${megabytes(cap)} remote snapshot limit`);
    }
    if (!limits?.chunkBytes) {
      return offline(state, "commit refused", `a ${megabytes(local.length)} session needs chunked transfer; update the Handoff helper on ${state.target.alias}`);
    }
  }
  let lock: any;
  try {
    lock = await request(state.target, "acquire-lock", [state.sessionId, "--owner", process.env.USER || "pi"]);
  } catch (error) {
    const response = error instanceof HandoffGateError ? error.response : undefined;
    const recoveryToken = response?.recoveryToken;
    if (!response?.recoveryRequired || typeof recoveryToken !== "string") {
      return offline(state, "lock acquisition failed", describe(error));
    }
    if (!dependencies.confirmRecovery || !await dependencies.confirmRecovery(`Recover the expired lock for session ${state.sessionId}?`)) {
      return offline(state, "stale lock recovery was declined");
    }
    try {
      await request(state.target, "recover-lock", [state.sessionId, "--token", recoveryToken]);
      lock = await request(state.target, "acquire-lock", [state.sessionId, "--owner", process.env.USER || "pi"]);
    } catch (recoveryError) {
      return offline(state, "lock recovery failed", describe(recoveryError));
    }
  }
  let stage = "commit failed";
  try {
    const current = await request(state.target, "fetch-manifest", [state.sessionId]).catch(() => undefined);
    const digest = hash(local);
    const expected: any = current?.manifest ?? { generation: 0, hash: null };
    // A push may only replace a remote head this session acknowledged, or one whose turns the local
    // file already contains. Compare-and-set cannot catch this: the expectation is read moments before
    // the commit, so it always matches, and a stale local copy would silently delete remote turns.
    const acknowledged = state.manifest?.hash;
    if (expected.hash && acknowledged !== expected.hash && expected.hash !== digest) {
      stage = "remote change check failed";
      const remoteData = await (dependencies.fetch ?? fetchSnapshot)(state.target, state.sessionId);
      if (!remoteTurnsPreserved(local, remoteData)) {
        return { ...state, syncState: "conflict", manifest: expected, syncReason: bounded("remote snapshot advanced", "the remote holds turns this session has never read; run /ssh pull to bring them in as a branch before syncing") };
      }
    }
    // The check above relabels the stage only while it runs; a later rejection is a commit failure.
    stage = "commit failed";
    let committed: any;
    if (limits?.chunkBytes) {
      stage = "upload failed";
      const negotiated = limits.chunkBytes;
      const chunkBytes = dependencies.pickChunkBytes?.(state.target, negotiated) ?? Math.min(MAX_CHUNK_BYTES, negotiated);
      const started = (dependencies.now ?? Date.now)();
      try {
        committed = await uploadChunked(request, state, lock, local, expected, chunkBytes, dependencies);
        dependencies.onTransferSample?.({ bytes: local.length, ms: (dependencies.now ?? Date.now)() - started, ok: true });
      } catch (error) {
        dependencies.onTransferSample?.({ bytes: local.length, ms: (dependencies.now ?? Date.now)() - started, ok: false });
        throw error;
      }
    } else {
      committed = await request(state.target, "commit", [state.sessionId, "--nonce", lock.nonce, "--token", lock.token, "--generation", String(expected.generation), "--expected-hash", expected.hash ?? "", "--hash", digest], local);
    }
    await (dependencies.saveSnapshot ?? saveSnapshot)(state.sessionId, local);
    await (dependencies.saveManifest ?? saveManifest)(state.sessionId, committed.manifest);
    return { ...state, syncState: "clean", manifest: committed.manifest, lock: undefined, syncReason: undefined };
  } catch (error) {
    if (error instanceof HandoffGateError && (error.response.error ?? "").includes(CAS_CONFLICT)) {
      const latest: any = await request(state.target, "fetch-manifest", [state.sessionId]).catch(() => undefined);
      return { ...state, syncState: "conflict", manifest: latest?.manifest, syncReason: bounded("remote snapshot advanced", "the remote session moved since it was last read; run /ssh pull to bring its turns in as a branch") };
    }
    return offline(state, stage, describe(error));
  } finally {
    if (lock?.nonce && lock?.token) await request(state.target, "release-lock", [state.sessionId, "--nonce", lock.nonce, "--token", lock.token]).catch(() => undefined);
  }
}
