import assert from "node:assert/strict";
import test from "node:test";
import { HANDOFF_PROTOCOL_VERSION } from "../config.ts";
import { ensureRemoteHelper } from "../installer.ts";

const artifact = { bytes: Buffer.from("helper"), checksum: "fixture-sha", version: HANDOFF_PROTOCOL_VERSION };
const result = (value: unknown) => ({ stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0), code: 0 });

test("a matching helper requires no confirmation or install", async () => {
  let confirms = 0;
  let calls = 0;
  await ensureRemoteHelper({ alias: "fixture" }, true, async () => { confirms++; return true; }, {
    loadArtifact: async () => artifact,
    exec: (async () => { calls++; return result({ ok: true, version: HANDOFF_PROTOCOL_VERSION, checksum: artifact.checksum }); }) as any,
  });
  assert.equal(confirms, 0);
  assert.equal(calls, 1);
});

test("headless mode refuses a missing or mismatched helper", async () => {
  await assert.rejects(ensureRemoteHelper({ alias: "fixture" }, false, async () => true, {
    loadArtifact: async () => artifact,
    exec: (async () => { throw new Error("missing"); }) as any,
  }), /not approved/);
});

test("confirmed install stages, verifies, atomically moves, and rechecks", async () => {
  const scripts: string[] = [];
  let call = 0;
  await ensureRemoteHelper({ alias: "fixture" }, true, async () => true, {
    loadArtifact: async () => artifact,
    exec: (async (options: any, script: string) => {
      scripts.push(script);
      call++;
      if (call === 1) throw new Error("missing");
      if (script.includes("cat >") || script.startsWith("mv ")) return result({});
      return result({ ok: true, version: HANDOFF_PROTOCOL_VERSION, checksum: artifact.checksum });
    }) as any,
  });
  assert.ok(scripts.some((script) => script.includes("cat >")));
  assert.ok(scripts.some((script) => script.startsWith("mv -f")));
  assert.ok(scripts.filter((script) => script.startsWith("python3")).length >= 3);
});

test("a verified helper is trusted only for a window, per host and checksum", async () => {
  let calls = 0;
  let clock = 1_000;
  const deps = {
    loadArtifact: async () => artifact,
    exec: (async () => { calls++; return result({ ok: true, version: HANDOFF_PROTOCOL_VERSION, checksum: artifact.checksum }); }) as any,
    now: () => clock,
    readyTtlMs: 1_000,
  };
  await (await import("../installer.ts")).assertRemoteHelperReady({ alias: "window-a" }, deps as any);
  await (await import("../installer.ts")).assertRemoteHelperReady({ alias: "window-a" }, deps as any);
  assert.equal(calls, 1, "the window must not repeat the version handshake for every request");
  clock += 1_001;
  await (await import("../installer.ts")).assertRemoteHelperReady({ alias: "window-a" }, deps as any);
  assert.equal(calls, 2, "an expired window re-verifies");
  await (await import("../installer.ts")).assertRemoteHelperReady({ alias: "window-b" }, deps as any);
  assert.equal(calls, 3, "one host's window never covers another host");
});

test("a helper that does not match the artifact is never trusted", async () => {
  let calls = 0;
  const deps = {
    loadArtifact: async () => artifact,
    exec: (async () => { calls++; return result({ ok: true, version: HANDOFF_PROTOCOL_VERSION, checksum: "someone-elses-build" }); }) as any,
    now: () => 1,
    readyTtlMs: 1_000,
  };
  const { assertRemoteHelperReady } = await import("../installer.ts");
  await assert.rejects(assertRemoteHelperReady({ alias: "window-c" }, deps as any), /checksum mismatch/);
  await assert.rejects(assertRemoteHelperReady({ alias: "window-c" }, deps as any), /checksum mismatch/);
  assert.equal(calls, 2, "failures are never cached");
});
