import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { getBashApprovalScope, getBashBackend, getBashLocalBoundary, getBashTargetLabel, hasActiveRemoteRoute, notifyRemoteRouteChanged, resetBackendRegistryForTests, setRemoteBashBackend, subscribeRemoteRoute } from "../backend-registry.ts";

afterEach(() => resetBackendRegistryForTests());

test("backend-registry round-trips bash backend and label", () => {
  let opsCalled = false;
  const fakeOps = { exec: () => { opsCalled = true; return Promise.resolve({ exitCode: 0 }); } } as any;
  setRemoteBashBackend(() => fakeOps, () => "host:/repo", () => "/local/repo", () => "host\0/repo");
  assert.equal(hasActiveRemoteRoute(), true);
  assert.equal(getBashTargetLabel(), "host:/repo");
  assert.equal(getBashApprovalScope(), "host\0/repo");
  assert.equal(getBashLocalBoundary(), "/local/repo");
  const backend = getBashBackend();
  assert.ok(backend);
  assert.equal(backend, fakeOps);
});

test("backend-registry returns undefined after reset", () => {
  setRemoteBashBackend(undefined);
  assert.equal(hasActiveRemoteRoute(), false);
  assert.equal(getBashBackend(), undefined);
  assert.equal(getBashTargetLabel(), undefined);
  assert.equal(getBashLocalBoundary(), undefined);
  assert.equal(getBashApprovalScope(), undefined);
});

test("authoritative availability subscription follows mutable Handoff routing", () => {
  let current: any = undefined;
  const availability: boolean[] = [];
  const unsubscribe = subscribeRemoteRoute((active) => availability.push(active));
  setRemoteBashBackend(() => current, () => current ? "active" : undefined);
  assert.equal(hasActiveRemoteRoute(), false);
  current = { exec: async () => ({ exitCode: 0 }) };
  // Handoff publishes after its state mutation when a provider closes over mutable state.
  notifyRemoteRouteChanged();
  assert.equal(getBashBackend(), current);
  assert.equal(getBashTargetLabel(), "active");
  current = undefined;
  notifyRemoteRouteChanged();
  assert.deepEqual(availability, [false, true, false]);
  unsubscribe();
});