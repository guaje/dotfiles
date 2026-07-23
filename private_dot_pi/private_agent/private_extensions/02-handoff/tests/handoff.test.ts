import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSshHosts, validateManualTarget } from "../ssh-config.ts";
import { handoffHudVariants, handoffStatus } from "../status.ts";
import { initialState, restoreState, toggleToolRoute } from "../state.ts";
import { remotePath } from "../operations.ts";
import { PathBoundaryError } from "../errors.ts";

test("SSH config parser follows quoted Include files and omits patterns", async () => {
  const root = await mkdtemp(join(tmpdir(), "handoff-ssh-")); await mkdir(join(root, "parts"));
  await writeFile(join(root, "config"), 'Host work # comment\n  HostName example\nHost * !skip\nInclude "parts/*.conf"\n');
  await writeFile(join(root, "parts/one.conf"), "Host=quoted\nHost other\n");
  assert.deepEqual((await discoverSshHosts(join(root, "config"))).map((host) => host.alias), ["other", "quoted", "work"]);
});
test("manual fields and remote paths reject escapes", () => {
  assert.throws(() => validateManualTarget("bad host")); assert.throws(() => validateManualTarget("host", "u", "70000"));
  const options = { workspace: "/srv/project", localCwd: "/local/project" } as any;
  assert.equal(remotePath(options, "/local/project/a.txt"), "/srv/project/a.txt");
  assert.throws(() => remotePath(options, "../secret"), PathBoundaryError);
});
test("toggle changes only tool route and status matrix stays literal", () => {
  const base = { ...initialState(), connection: "connected" as const, target: { alias: "host", workspace: "/repo" } };
  assert.deepEqual(toggleToolRoute(base), { ...base, toolRoute: "remote" });
  assert.equal(handoffStatus({ ...base, toolRoute: "remote" }), "⇄ tools→host:/repo • history local");
  assert.equal(handoffStatus({ ...base, sessionAuthority: "remote", toolRoute: "local" }), "⌂ tools→local • history→host");
  assert.deepEqual(restoreState({ connection: "bad" }), initialState());
});

test("HUD variants split the icon from muted detail and preserve the local label", () => {
  const local = handoffHudVariants(initialState());
  assert.deepEqual(local.full, [
    { text: "⌂", tone: "accent" },
    { text: " tools→local • history local", tone: "muted" },
  ]);
  assert.equal(local.full.map((segment) => segment.text).join(""), "⌂ tools→local • history local");
  const offline = handoffHudVariants({ ...initialState(), syncState: "offline" });
  assert.equal(offline.full[0]?.tone, "error");
});
