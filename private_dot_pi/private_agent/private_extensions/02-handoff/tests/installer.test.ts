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
