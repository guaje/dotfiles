import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffGateError, fetchSnapshot, remoteManifest, synchronize } from "../sync.ts";
import { serializeSessionDocument } from "../session-merge.ts";
import { TransportError } from "../errors.ts";
import type { HandoffState } from "../types.ts";

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "handoff-sync-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, "session.jsonl");
  // A real session document, so the overwrite check can read both sides of the comparison.
  await writeFile(sessionFile, doc([entry("local-entry", null)]));
  const state: HandoffState = { connection: "connected", sessionAuthority: "remote", toolRoute: "remote", syncState: "dirty", sessionId: "sess", target: { alias: "test", workspace: "/srv" } };
  return { state, sessionFile };
}

const stores = { saveSnapshot: async () => {}, saveManifest: async () => {} } as const;
/** A remote head with no entries of its own, which any local session file already contains. */
const contained = { fetch: async () => Buffer.from('{"type":"session","version":3,"id":"remote","timestamp":"2026-01-01T00:00:00.000Z"}\n') } as const;

function requests(responses: Array<any | Error>) {
  const calls: string[] = [];
  const request = async (_target: any, command: string) => {
    calls.push(command);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return { request: request as any, calls };
}

test("synchronize stores clean state and releases the lock", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 0, hash: null } },
    { ok: true, manifest: { generation: 1, hash: "abc", snapshot: "1-abc.jsonl" } },
    { ok: true },
  ]);
  const result = await synchronize(state, sessionFile, { request: remote.request, ...stores });
  assert.equal(result.syncState, "clean");
  assert.equal(result.manifest!.hash, "abc");
  assert.deepEqual(remote.calls, ["acquire-lock", "fetch-manifest", "commit", "release-lock"]);
});

test("synchronize reports conflict only for a genuine generation or hash mismatch", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 0, hash: null } },
    new HandoffGateError({ ok: false, error: "generation or hash conflict" }),
    { ok: true, manifest: { generation: 1, hash: "old" } },
    { ok: true },
  ]);
  const result = await synchronize(state, sessionFile, { request: remote.request, ...stores });
  assert.equal(result.syncState, "conflict");
  assert.equal(result.manifest!.hash, "old");
  assert.match(result.syncReason!, /^remote snapshot advanced: /);
});

test("a remote rejection that is not a mismatch is a failure, never a conflict", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 1, hash: "old" } },
    new HandoffGateError({ ok: false, error: "snapshot exceeds limit" }),
    { ok: true },
  ]);
  const result = await synchronize(state, sessionFile, { request: remote.request, ...stores, ...contained });
  assert.equal(result.syncState, "offline");
  assert.equal(result.syncReason, "commit failed: snapshot exceeds limit");
});

test("refuses a session above the negotiated remote cap without touching the remote", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const remote = requests([]);
  const limits = (async () => ({ snapshotBytes: 8, chunkBytes: 4 })) as any;
  const result = await synchronize(state, sessionFile, { request: remote.request, limits, chunkThresholdBytes: 1, ...stores });
  assert.equal(result.syncState, "offline");
  assert.deepEqual(remote.calls, []);
  assert.match(result.syncReason!, /exceeds the .* remote snapshot limit/);
});

test("refuses chunked transfer when the installed helper cannot negotiate it", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const remote = requests([]);
  const limits = (async () => undefined) as any;
  const result = await synchronize(state, sessionFile, { request: remote.request, limits, chunkThresholdBytes: 1, ...stores });
  assert.equal(result.syncState, "offline");
  assert.deepEqual(remote.calls, []);
  assert.match(result.syncReason!, /needs chunked transfer; update the Handoff helper on test/);
});

test("reports a capability check failure truthfully instead of guessing", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const remote = requests([]);
  const limits = (async () => { throw new TransportError("SSH operation timed out"); }) as any;
  const result = await synchronize(state, sessionFile, { request: remote.request, limits, chunkThresholdBytes: 1, ...stores });
  assert.equal(result.syncState, "offline");
  assert.equal(result.syncReason, "remote capability check failed: SSH operation timed out");
});

test("uploads oversized payloads in chunks and promotes them atomically", async (t) => {
  const { state, sessionFile } = await fixture(t);
  await writeFile(sessionFile, "0123456789ab"); // 12 bytes -> three 4 byte chunks
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 0, hash: null } },
    { ok: true, upload: { id: "u1", chunkBytes: 4, totalBytes: 12 } },
    { ok: true, nextIndex: 1 },
    { ok: true, nextIndex: 2 },
    { ok: true, nextIndex: 3 },
    { ok: true, manifest: { generation: 1, hash: "abc", snapshot: "1-abc.jsonl" } },
    { ok: true },
  ]);
  const limits = (async () => ({ snapshotBytes: 1024 * 1024, chunkBytes: 4 })) as any;
  const result = await synchronize(state, sessionFile, { request: remote.request, limits, chunkThresholdBytes: 1, ...stores });
  assert.equal(result.syncState, "clean");
  assert.equal(result.manifest!.generation, 1);
  assert.deepEqual(remote.calls, ["acquire-lock", "fetch-manifest", "begin-upload", "put-chunk", "put-chunk", "put-chunk", "finish-upload", "release-lock"]);
});

test("a rejected chunk aborts the staged upload so nothing can be committed", async (t) => {
  const { state, sessionFile } = await fixture(t);
  await writeFile(sessionFile, "0123456789ab");
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 0, hash: null } },
    { ok: true, upload: { id: "u1", chunkBytes: 4, totalBytes: 12 } },
    { ok: true, nextIndex: 1 },
    new HandoffGateError({ ok: false, error: "chunk hash mismatch" }),
    { ok: true },
    { ok: true },
  ]);
  const limits = (async () => ({ snapshotBytes: 1024 * 1024, chunkBytes: 4 })) as any;
  const result = await synchronize(state, sessionFile, { request: remote.request, limits, chunkThresholdBytes: 1, ...stores });
  assert.equal(result.syncState, "offline");
  assert.equal(result.syncReason, "upload failed: chunk hash mismatch");
  assert.ok(remote.calls.includes("abort-upload"), remote.calls.join(","));
  assert.ok(!remote.calls.includes("finish-upload"), remote.calls.join(","));
});

test("a long chunked upload renews the lock lease", async (t) => {
  const { state, sessionFile } = await fixture(t);
  await writeFile(sessionFile, "0123456789ab");
  let clock = 0;
  const ok = { ok: true, nonce: "n1", token: "t1", upload: { id: "u1", chunkBytes: 4 }, manifest: { generation: 1, hash: "abc" }, nextIndex: 1 };
  const remote = requests(Array.from({ length: 12 }, () => ({ ...ok })));
  const limits = (async () => ({ snapshotBytes: 1024 * 1024, chunkBytes: 4 })) as any;
  // The remote head here is one this session already pushed, so the overwrite check needs no re-read.
  const synced = { ...state, manifest: { generation: 1, hash: "abc", snapshot: "1-abc.jsonl" } };
  const result = await synchronize(synced, sessionFile, { request: remote.request, limits, chunkThresholdBytes: 1, leaseRenewMs: 5, now: () => (clock += 5), ...stores, ...contained });
  assert.equal(result.syncState, "clean");
  assert.ok(remote.calls.includes("renew-lock"), remote.calls.join(","));
});

test("synchronize remains offline when transport state is ambiguous", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    new Error("fetch failed"),
    new Error("commit failed"),
    { ok: true },
  ]);
  const result = await synchronize(state, sessionFile, { request: remote.request, ...stores });
  assert.equal(result.syncState, "offline");
  assert.equal(result.syncReason, "commit failed: commit failed");
});

test("expired-lock recovery requires explicit confirmation and retries acquisition", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const remote = requests([
    new HandoffGateError({ ok: false, error: "expired", recoveryRequired: true, recoveryToken: "stale" }),
    { ok: true },
    { ok: true, nonce: "n2", token: "t2" },
    { ok: true, manifest: { generation: 0, hash: null } },
    { ok: true, manifest: { generation: 1, hash: "new" } },
    { ok: true },
  ]);
  const result = await synchronize(state, sessionFile, { request: remote.request, confirmRecovery: async () => true, ...stores });
  assert.equal(result.syncState, "clean");
  assert.deepEqual(remote.calls.slice(0, 3), ["acquire-lock", "recover-lock", "acquire-lock"]);
});

test("declined recovery never deletes or reacquires", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const remote = requests([new HandoffGateError({ ok: false, error: "expired", recoveryRequired: true, recoveryToken: "stale" })]);
  const result = await synchronize(state, sessionFile, { request: remote.request, confirmRecovery: async () => false, ...stores });
  assert.equal(result.syncState, "offline");
  assert.deepEqual(remote.calls, ["acquire-lock"]);
});

test("offline results carry the underlying failure reason", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 0, hash: null } },
    new TransportError("SSH failed (1): OSError: [Errno 28] No space left on device"),
    new Error("manifest fetch failed"),
    { ok: true },
  ]);
  const result = await synchronize(state, sessionFile, { request: remote.request, ...stores });
  assert.equal(result.syncState, "offline");
  assert.equal(result.syncReason, "commit failed: SSH failed (1): OSError: [Errno 28] No space left on device");
});

test("lock acquisition failures surface the remote reason without prompting recovery", async (t) => {
  const { state, sessionFile } = await fixture(t);
  let prompted = false;
  const remote = requests([new HandoffGateError({ ok: false, error: "session is locked" })]);
  const result = await synchronize(state, sessionFile, { request: remote.request, confirmRecovery: async () => { prompted = true; return true; }, ...stores });
  assert.equal(result.syncState, "offline");
  assert.equal(result.syncReason, "lock acquisition failed: session is locked");
  assert.equal(prompted, false);
  assert.deepEqual(remote.calls, ["acquire-lock"]);
});

test("declined recovery reports why synchronization went offline", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const remote = requests([new HandoffGateError({ ok: false, error: "expired", recoveryRequired: true, recoveryToken: "stale" })]);
  const result = await synchronize(state, sessionFile, { request: remote.request, confirmRecovery: async () => false, ...stores });
  assert.equal(result.syncState, "offline");
  assert.equal(result.syncReason, "stale lock recovery was declined");
  assert.deepEqual(remote.calls, ["acquire-lock"]);
});

test("offline reasons truncate long remote tracebacks but keep the actionable tail", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const traceback = `Traceback (most recent call last): ${'File "/home/exouser/.local/libexec/pi-handoff-gate.py", line 218, in commit '.repeat(8)}OSError: [Errno 28] No space left on device`;
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 0, hash: null } },
    new Error(traceback),
    { ok: true },
  ]);
  const result = await synchronize(state, sessionFile, { request: remote.request, ...stores });
  assert.equal(result.syncState, "offline");
  assert.ok(result.syncReason!.length <= 200, result.syncReason);
  assert.ok(result.syncReason!.startsWith("commit failed: …"), result.syncReason);
  assert.ok(result.syncReason!.endsWith("OSError: [Errno 28] No space left on device"), result.syncReason);
});

test("a successful sync clears a previous offline reason", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const failing = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 0, hash: null } },
    new Error("disk full"),
    { ok: true },
  ]);
  const offlineState = await synchronize(state, sessionFile, { request: failing.request, ...stores });
  assert.equal(offlineState.syncState, "offline");
  const succeeding = requests([
    { ok: true, nonce: "n2", token: "t2" },
    { ok: true, manifest: { generation: 0, hash: null } },
    { ok: true, manifest: { generation: 1, hash: "abc", snapshot: "1-abc.jsonl" } },
    { ok: true },
  ]);
  const result = await synchronize(offlineState, sessionFile, { request: succeeding.request, ...stores });
  assert.equal(result.syncState, "clean");
  assert.equal(result.syncReason, undefined);
});

test("downloads a remote snapshot in chunks and verifies the whole payload", async () => {
  const payload = Buffer.from("0123456789abcdef");
  const digest = createHash("sha256").update(payload).digest("hex");
  const pages: number[] = [];
  const request = (async (_target: any, _command: string, args: string[]) => {
    const offset = Number(args[args.indexOf("--offset") + 1]);
    const length = Number(args[args.indexOf("--length") + 1]);
    pages.push(offset);
    return { ok: true, manifest: { hash: digest }, total: payload.length, offset, base64: payload.subarray(offset, offset + length).toString("base64") };
  }) as any;
  const data = await fetchSnapshot({ alias: "test" }, "sess", request, 6);
  assert.equal(data.toString("utf8"), "0123456789abcdef");
  assert.deepEqual(pages, [0, 6, 12]);
});

test("a snapshot download that fails its hash check is rejected", async () => {
  const request = (async () => ({ ok: true, manifest: { hash: "0".repeat(64) }, total: 4, base64: Buffer.from("junk").toString("base64") })) as any;
  await assert.rejects(() => fetchSnapshot({ alias: "test" }, "sess", request, 8), /hash check/);
});

test("a snapshot download that stops early is rejected", async () => {
  let pages = 0;
  const request = (async () => {
    pages += 1;
    return { ok: true, manifest: { hash: createHash("sha256").update("abcd").digest("hex") }, total: 99, base64: pages === 1 ? Buffer.from("abcd").toString("base64") : "" };
  }) as any;
  await assert.rejects(() => fetchSnapshot({ alias: "test" }, "sess", request, 8), /stopped at 4 of 99/);
});

test("a remote declaring more data than the session limit is refused", async () => {
  const request = (async () => ({ ok: true, manifest: { hash: "0".repeat(64) }, total: 1024 * 1024 * 1024 * 4, base64: Buffer.from("abcd").toString("base64") })) as any;
  await assert.rejects(() => fetchSnapshot({ alias: "test" }, "sess", request, 8), /above the .* session limit/);
});

const entry = (id: string, parentId: string | null): any => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: id } });
const doc = (entries: any[]) => serializeSessionDocument({ type: "session", version: 3, id: "local", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" }, entries);

test("a push that would delete remote turns this session never read is refused", async (t) => {
  const { state, sessionFile } = await fixture(t);
  await writeFile(sessionFile, doc([entry("a", null), entry("b", "a")]));
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 5, hash: "remote-hash" } },
    { ok: true },
  ]);
  const result = await synchronize(state, sessionFile, {
    request: remote.request,
    ...stores,
    fetch: async () => Buffer.from(doc([entry("a", null), entry("b", "a"), entry("peer-work", "b")])),
  });
  assert.equal(result.syncState, "conflict");
  assert.match(result.syncReason!, /^remote snapshot advanced: /);
  assert.match(result.syncReason!, /\/ssh pull/);
  assert.deepEqual(remote.calls, ["acquire-lock", "fetch-manifest", "release-lock"], "no commit may even be attempted");
});

test("a remote head the local file already contains is pushed without complaint", async (t) => {
  const { state, sessionFile } = await fixture(t);
  await writeFile(sessionFile, doc([entry("a", null), entry("b", "a"), entry("c", "b")]));
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 5, hash: "remote-hash" } },
    { ok: true, manifest: { generation: 6, hash: "abc", snapshot: "6-abc.jsonl" } },
    { ok: true },
  ]);
  const result = await synchronize(state, sessionFile, {
    request: remote.request,
    ...stores,
    fetch: async () => Buffer.from(doc([entry("a", null), entry("b", "a")])),
  });
  assert.equal(result.syncState, "clean");
  assert.ok(remote.calls.includes("commit"), remote.calls.join(","));
});

test("an acknowledged remote head costs no extra download before pushing", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const seen = { ...state, manifest: { generation: 5, hash: "remote-hash", snapshot: "5-remote-hash.jsonl" } };
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 5, hash: "remote-hash" } },
    { ok: true, manifest: { generation: 6, hash: "abc", snapshot: "6-abc.jsonl" } },
    { ok: true },
  ]);
  const result = await synchronize(seen, sessionFile, { request: remote.request, ...stores, fetch: async () => { throw new Error("must not download"); } });
  assert.equal(result.syncState, "clean");
});

test("chunked upload reports progress once per chunk", async (t) => {
  const { state, sessionFile } = await fixture(t);
  await writeFile(sessionFile, "0123456789ab"); // 12 bytes -> three 4 byte chunks
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 0, hash: null } },
    { ok: true, upload: { id: "u1", chunkBytes: 4, totalBytes: 12 } },
    { ok: true }, { ok: true }, { ok: true },
    { ok: true, manifest: { generation: 1, hash: "abc", snapshot: "1-abc.jsonl" } },
    { ok: true },
  ]);
  const updates: any[] = [];
  const limits = (async () => ({ snapshotBytes: 1024 * 1024, chunkBytes: 4 })) as any;
  const result = await synchronize(state, sessionFile, { request: remote.request, limits, chunkThresholdBytes: 1, onProgress: (update) => updates.push(update), ...stores });
  assert.equal(result.syncState, "clean");
  assert.deepEqual(updates, [
    { phase: "upload", unit: "chunk", done: 0, total: 3 },
    { phase: "upload", unit: "chunk", done: 1, total: 3 },
    { phase: "upload", unit: "chunk", done: 2, total: 3 },
    { phase: "upload", unit: "chunk", done: 3, total: 3 },
  ]);
});

test("remoteManifest reads only the remote head, and treats any failure as unknown", async () => {
  const calls: string[] = [];
  const good = (async (_target: any, command: string) => { calls.push(command); return { ok: true, manifest: { generation: 3, hash: "h3" } }; }) as any;
  assert.deepEqual(await remoteManifest({ alias: "test" }, "sess", good), { generation: 3, hash: "h3" });
  assert.equal(await remoteManifest({ alias: "test" }, "sess", (async () => { throw new Error("offline"); }) as any), undefined);
  assert.deepEqual(calls, ["fetch-manifest"]);
});

test("download progress and the remote head are reported as pages arrive", async () => {
  const payload = Buffer.from("0123456789");
  const digest = createHash("sha256").update(payload).digest("hex");
  const request = (async (_target: any, _command: string, args: string[]) => {
    const offset = Number(args[args.indexOf("--offset") + 1]);
    const length = Number(args[args.indexOf("--length") + 1]);
    return { ok: true, manifest: { generation: 2, hash: digest }, total: payload.length, offset, base64: payload.subarray(offset, offset + length).toString("base64") };
  }) as any;
  const seen: Array<[number, number]> = [];
  let observed: any;
  const data = await fetchSnapshot({ alias: "test" }, "sess", request, 4, { onProgress: (done, total) => seen.push([done, total]), observe: (manifest) => { observed = manifest; } });
  assert.equal(data.length, 10);
  assert.deepEqual(seen, [[4, 10], [8, 10], [10, 10]]);
  assert.equal(observed.hash, digest);
  assert.equal(observed.generation, 2);
});

test("the staged upload sizes its chunks from the measured link and reports one sample", async (t) => {
  const { state, sessionFile } = await fixture(t);
  await writeFile(sessionFile, "0123456789ab"); // 12 bytes -> two chunks of 6
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 0, hash: null } },
    { ok: true, upload: { id: "u1", chunkBytes: 6, totalBytes: 12 } },
    { ok: true }, { ok: true },
    { ok: true, manifest: { generation: 1, hash: "abc", snapshot: "1-abc.jsonl" } },
    { ok: true },
  ]);
  const negotiated: number[] = [];
  const samples: any[] = [];
  const limits = (async () => ({ snapshotBytes: 1024 * 1024, chunkBytes: 4096 })) as any;
  const result = await synchronize(state, sessionFile, {
    request: remote.request,
    limits,
    chunkThresholdBytes: 1,
    pickChunkBytes: (_target, cap) => { negotiated.push(cap); return 6; },
    onTransferSample: (sample) => samples.push(sample),
    ...stores,
  });
  assert.equal(result.syncState, "clean");
  assert.deepEqual(negotiated, [4096], "the helper's cap is what the sizer must respect");
  assert.equal(remote.calls.filter((call) => call === "put-chunk").length, 2);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].ok, true);
  assert.equal(samples[0].bytes, 12);
});

test("a failed staged upload reports a failed sample so the next try shrinks", async (t) => {
  const { state, sessionFile } = await fixture(t);
  await writeFile(sessionFile, "0123456789ab");
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 0, hash: null } },
    { ok: true, upload: { id: "u1", chunkBytes: 6, totalBytes: 12 } },
    new HandoffGateError({ ok: false, error: "chunk hash mismatch" }),
    { ok: true },
    { ok: true },
  ]);
  const samples: any[] = [];
  const limits = (async () => ({ snapshotBytes: 1024 * 1024, chunkBytes: 4096 })) as any;
  const result = await synchronize(state, sessionFile, {
    request: remote.request,
    limits,
    chunkThresholdBytes: 1,
    pickChunkBytes: () => 6,
    onTransferSample: (sample) => samples.push(sample),
    ...stores,
  });
  assert.equal(result.syncState, "offline");
  assert.equal(samples.length, 1);
  assert.equal(samples[0].ok, false);
});
