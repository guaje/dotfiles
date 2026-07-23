import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { synchronize } from "../sync.ts";
import type { HandoffState } from "../types.ts";

class Child extends EventEmitter { stdout = new EventEmitter(); stderr = new EventEmitter(); killed: string[] = []; kill(signal?: string) { this.killed.push(signal ?? ""); return true; } }

function fakeSpawn(responses: { stdout?: any; code?: number }[]) {
  let index = 0;
  return () => {
    const child = new Child();
    const resp = responses[index] ?? { code: 0 };
    index += 1;
    queueMicrotask(() => {
      if (resp.stdout !== undefined) child.stdout.emit("data", Buffer.from(JSON.stringify(resp.stdout)));
      child.emit("close", resp.code ?? 0);
    });
    return child as any;
  };
}

test("synchronize stores clean state and manifest on success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-sync-"));
  const sessionFile = join(dir, "session.jsonl");
  await writeFile(sessionFile, '{"e":"test"}\n');
  const target = { alias: "test", workspace: "/srv", spawn: fakeSpawn([
    { stdout: { ok: true, nonce: "n1", token: "t1" } }, // acquire-lock
    { stdout: { ok: true, manifest: { generation: 0, hash: null, snapshot: null } } }, // fetch-manifest
    { stdout: { ok: true, manifest: { generation: 1, hash: "abc", snapshot: "1-abc.jsonl" } } }, // commit
    { stdout: { ok: true } }, // release-lock
  ]) as any };
  const state: HandoffState = { connection: "connected", sessionAuthority: "remote", toolRoute: "remote", syncState: "dirty", sessionId: "sess", target };
  const result = await synchronize(state, sessionFile);
  assert.equal(result.syncState, "clean");
  assert.equal(result.manifest!.hash, "abc");
});

test("synchronize enters conflict state on commit failure when remote manifest differs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-sync-"));
  const sessionFile = join(dir, "session.jsonl");
  await writeFile(sessionFile, '{"e":"test"}\n');
  const target = { alias: "test", workspace: "/srv", spawn: fakeSpawn([
    { stdout: { ok: true, nonce: "n1", token: "t1" } }, // acquire-lock
    { stdout: { ok: true, manifest: { generation: 0, hash: null, snapshot: null } } }, // fetch-manifest (pre-commit)
    { code: 1 }, // commit fails
    { stdout: { ok: true, manifest: { generation: 1, hash: "old", snapshot: "1-old.jsonl" } } }, // conflict fetch-manifest
    { stdout: { ok: true } }, // release-lock
  ]) as any };
  const state: HandoffState = { connection: "connected", sessionAuthority: "remote", toolRoute: "remote", syncState: "dirty", sessionId: "sess", target };
  const result = await synchronize(state, sessionFile);
  assert.equal(result.syncState, "conflict");
  assert.equal(result.manifest!.hash, "old");
});

test("synchronize enters offline state when both fetch and commit fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handoff-sync-"));
  const sessionFile = join(dir, "session.jsonl");
  await writeFile(sessionFile, '{"e":"test"}\n');
  const target = { alias: "test", workspace: "/srv", spawn: fakeSpawn([
    { stdout: { ok: true, nonce: "n1", token: "t1" } }, // acquire-lock
    { code: 1 }, // fetch-manifest fails (pre-commit)
    { code: 1 }, // commit fails
    { code: 1 }, // conflict fetch-manifest fails
    { stdout: { ok: true } }, // release-lock
  ]) as any };
  const state: HandoffState = { connection: "connected", sessionAuthority: "remote", toolRoute: "remote", syncState: "dirty", sessionId: "sess", target };
  const result = await synchronize(state, sessionFile);
  assert.equal(result.syncState, "offline");
});
