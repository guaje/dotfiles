import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import test, { afterEach } from "node:test";
import { consumeRemoteRouteForToolCall, getBashApprovalScope, getBashBackend, getBashLocalBoundary, getBashTargetLabel, hasActiveRemoteRoute, notifyRemoteRouteChanged, requireRemoteRouteForToolCall, resetBackendRegistryForTests, setRemoteBashBackend, subscribeRemoteRoute } from "../backend-registry.ts";

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

test("registry state is shared across isolated extension module instances", async () => {
  type RegistryModule = typeof import("../backend-registry.ts");
  const writerUrl = new URL("../.backend-registry.writer.testable.ts", import.meta.url);
  const readerUrl = new URL("../.backend-registry.reader.testable.ts", import.meta.url);
  const source = await readFile(new URL("../backend-registry.ts", import.meta.url), "utf8");
  const loadCopy = async (url: URL): Promise<RegistryModule> => {
    let candidate: any = await import(url.href);
    for (let depth = 0; depth < 4; depth++) {
      if (typeof candidate?.resetBackendRegistryForTests === "function") return candidate as RegistryModule;
      candidate = candidate?.default;
    }
    throw new Error(`Could not unwrap backend-registry module at ${url.pathname}`);
  };

  await Promise.all([writeFile(writerUrl, source), writeFile(readerUrl, source)]);
  try {
    const writer = await loadCopy(writerUrl);
    const reader = await loadCopy(readerUrl);
    writer.resetBackendRegistryForTests();

    const availability: boolean[] = [];
    const unsubscribe = reader.subscribeRemoteRoute((active) => availability.push(active));
    const backend = { exec: async () => ({ exitCode: 0 }) } as any;
    writer.setRemoteBashBackend(() => backend, () => "host:/repo", () => "/local/repo", () => "host\0/repo");

    assert.equal(reader.hasActiveRemoteRoute(), true);
    assert.equal(reader.getBashBackend(), backend);
    assert.equal(reader.getBashTargetLabel(), "host:/repo");
    assert.deepEqual(availability, [false, true]);

    writer.setRemoteBashBackend(undefined);
    assert.deepEqual(availability, [false, true, false]);
    unsubscribe();
  } finally {
    await Promise.all([rm(writerUrl, { force: true }), rm(readerUrl, { force: true })]);
  }
});

test("every successful SSH session action exposes an active remote tool route", () => {
  const backend = { exec: async () => ({ exitCode: 0 }) } as any;
  const target = { alias: "host", host: "example.test", workspace: "/repo" };
  let state: any = { connection: "connected", sessionAuthority: "local", toolRoute: "local", syncState: "clean", target };
  const routed = () => state.connection === "connected" && state.toolRoute === "remote" && state.target;
  setRemoteBashBackend(
    () => routed() ? backend : undefined,
    () => routed() ? `${state.target.alias}:${state.target.workspace}` : undefined,
  );

  const finalStates = [
    ["Resume remote session", { sessionAuthority: "remote", sessionId: "resumed" }],
    ["Start new remote session", { sessionAuthority: "remote", sessionId: "new" }],
    ["Move current session to remote workspace", { sessionAuthority: "remote", sessionId: "moved" }],
    ["Connect tools only", { sessionAuthority: "local" }],
  ] as const;

  for (const [action, changes] of finalStates) {
    state = { ...state, toolRoute: "local" };
    notifyRemoteRouteChanged();
    state = { ...state, ...changes, toolRoute: "remote" };
    notifyRemoteRouteChanged();
    assert.equal(hasActiveRemoteRoute(), true, action);
    assert.equal(getBashBackend(), backend, action);
  }
});

test("an older registration disposer cannot clear a newer backend", () => {
  const first = { exec: async () => ({ exitCode: 0 }) } as any;
  const second = { exec: async () => ({ exitCode: 0 }) } as any;
  const disposeFirst = setRemoteBashBackend(() => first, () => "first:/repo");
  const disposeSecond = setRemoteBashBackend(() => second, () => "second:/repo");

  disposeFirst();
  assert.equal(getBashBackend(), second);
  assert.equal(getBashTargetLabel(), "second:/repo");

  disposeSecond();
  assert.equal(hasActiveRemoteRoute(), false);
});

test("YOLO route requirements fail closed on route loss or target changes", () => {
  const backend = { exec: async () => ({ exitCode: 0 }) } as any;
  setRemoteBashBackend(() => backend, () => "first:/repo", undefined, () => "first\0/repo");

  assert.equal(requireRemoteRouteForToolCall("lost"), true);
  setRemoteBashBackend(undefined);
  assert.deepEqual(consumeRemoteRouteForToolCall("lost"), { required: true });

  setRemoteBashBackend(() => backend, () => "first:/repo", undefined, () => "first\0/repo");
  assert.equal(requireRemoteRouteForToolCall("changed"), true);
  setRemoteBashBackend(() => backend, () => "second:/repo", undefined, () => "second\0/repo");
  assert.deepEqual(consumeRemoteRouteForToolCall("changed"), { required: true });

  assert.equal(requireRemoteRouteForToolCall("stable"), true);
  const stable = consumeRemoteRouteForToolCall("stable");
  assert.equal(stable.required, true);
  assert.equal(stable.route?.backend, backend);
  assert.equal(consumeRemoteRouteForToolCall("stable").required, false);
});

test("test reset notifies and detaches global subscribers", () => {
  const availability: boolean[] = [];
  subscribeRemoteRoute((active) => availability.push(active));
  setRemoteBashBackend(() => ({}) as any, () => "host:/repo");
  resetBackendRegistryForTests();
  setRemoteBashBackend(() => ({}) as any, () => "other:/repo");
  assert.deepEqual(availability, [false, true, false]);
});