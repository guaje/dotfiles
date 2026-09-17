import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffGateError, synchronize } from "../sync.ts";
import { TransportError } from "../errors.ts";
import type { HandoffState } from "../types.ts";

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "handoff-sync-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, "session.jsonl");
  await writeFile(sessionFile, '{"e":"test"}\n');
  const state: HandoffState = { connection: "connected", sessionAuthority: "remote", toolRoute: "remote", syncState: "dirty", sessionId: "sess", target: { alias: "test", workspace: "/srv" } };
  return { state, sessionFile };
}

const stores = { saveSnapshot: async () => {}, saveManifest: async () => {} } as const;

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

test("synchronize reports conflict when the remote manifest advanced", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 0, hash: null } },
    new Error("commit failed"),
    { ok: true, manifest: { generation: 1, hash: "old" } },
    { ok: true },
  ]);
  const result = await synchronize(state, sessionFile, { request: remote.request, ...stores });
  assert.equal(result.syncState, "conflict");
  assert.equal(result.manifest!.hash, "old");
});

test("synchronize remains offline when transport state is ambiguous", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    new Error("fetch failed"),
    new Error("commit failed"),
    new Error("conflict fetch failed"),
    { ok: true },
  ]);
  assert.equal((await synchronize(state, sessionFile, { request: remote.request, ...stores })).syncState, "offline");
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
  assert.equal(result.offlineReason, "commit failed: SSH failed (1): OSError: [Errno 28] No space left on device");
});

test("lock acquisition failures surface the remote reason without prompting recovery", async (t) => {
  const { state, sessionFile } = await fixture(t);
  let prompted = false;
  const remote = requests([new HandoffGateError({ ok: false, error: "session is locked" })]);
  const result = await synchronize(state, sessionFile, { request: remote.request, confirmRecovery: async () => { prompted = true; return true; }, ...stores });
  assert.equal(result.syncState, "offline");
  assert.equal(result.offlineReason, "lock acquisition failed: session is locked");
  assert.equal(prompted, false);
  assert.deepEqual(remote.calls, ["acquire-lock"]);
});

test("declined recovery reports why synchronization went offline", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const remote = requests([new HandoffGateError({ ok: false, error: "expired", recoveryRequired: true, recoveryToken: "stale" })]);
  const result = await synchronize(state, sessionFile, { request: remote.request, confirmRecovery: async () => false, ...stores });
  assert.equal(result.syncState, "offline");
  assert.equal(result.offlineReason, "stale lock recovery was declined");
  assert.deepEqual(remote.calls, ["acquire-lock"]);
});

test("offline reasons truncate long remote tracebacks but keep the actionable tail", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const traceback = `Traceback (most recent call last): ${'File "/home/exouser/.local/libexec/pi-handoff-gate.py", line 218, in commit '.repeat(8)}OSError: [Errno 28] No space left on device`;
  const remote = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 0, hash: null } },
    new Error(traceback),
    new Error("fetch failed"),
    { ok: true },
  ]);
  const result = await synchronize(state, sessionFile, { request: remote.request, ...stores });
  assert.equal(result.syncState, "offline");
  assert.ok(result.offlineReason!.length <= 200, result.offlineReason);
  assert.ok(result.offlineReason!.startsWith("commit failed: …"), result.offlineReason);
  assert.ok(result.offlineReason!.endsWith("OSError: [Errno 28] No space left on device"), result.offlineReason);
});

test("a successful sync clears a previous offline reason", async (t) => {
  const { state, sessionFile } = await fixture(t);
  const failing = requests([
    { ok: true, nonce: "n1", token: "t1" },
    { ok: true, manifest: { generation: 0, hash: null } },
    new Error("disk full"),
    new Error("fetch failed"),
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
  assert.equal(result.offlineReason, undefined);
});
