import assert from "node:assert/strict";
import test from "node:test";
import { getBashBackend, getBashTargetLabel, setRemoteBashBackend } from "../backend-registry.ts";

test("backend-registry round-trips bash backend and label", () => {
  let opsCalled = false;
  const fakeOps = { exec: () => { opsCalled = true; return Promise.resolve({ exitCode: 0 }); } } as any;
  setRemoteBashBackend(() => fakeOps, () => "host:/repo");
  assert.equal(getBashTargetLabel(), "host:/repo");
  const backend = getBashBackend();
  assert.ok(backend);
  assert.equal(backend, fakeOps);
});

test("backend-registry returns undefined after reset", () => {
  setRemoteBashBackend(undefined);
  assert.equal(getBashBackend(), undefined);
  assert.equal(getBashTargetLabel(), undefined);
});

test("backend-registry delegates to mutable provider", () => {
  let current: any = undefined;
  setRemoteBashBackend(() => current, () => (current ? "active" : undefined));
  assert.equal(getBashBackend(), undefined);
  assert.equal(getBashTargetLabel(), undefined);
  current = { exec: async () => ({ exitCode: 0 }) };
  assert.equal(getBashBackend(), current);
  assert.equal(getBashTargetLabel(), "active");
});
