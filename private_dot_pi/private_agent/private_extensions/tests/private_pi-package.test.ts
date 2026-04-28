// Run with: npx -y tsx --test agent/extensions/tests/pi-package.test.ts
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getHomebrewPiPackageRootFromExecutable,
  getNpmGlobalPiPackageRoot,
  getPiPackageRoot,
  getPiPackageRootCandidatesFromExecutable,
} from "../packages/pi-package.ts";

const packagePathParts = ["@mariozechner", "pi-coding-agent"];

test("getNpmGlobalPiPackageRoot maps an npm global node_modules path to the pi package root", () => {
  const globalNodeModules = join(tmpdir(), "test-prefix", "lib", "node_modules");
  assert.equal(
    getNpmGlobalPiPackageRoot(globalNodeModules),
    join(globalNodeModules, ...packagePathParts),
  );
});

test("getPiPackageRootCandidatesFromExecutable maps a pi binary to portable package root candidates", () => {
  const installRoot = join(tmpdir(), "test-prefix");
  const executablePath = join(installRoot, "bin", "pi");
  assert.deepEqual(getPiPackageRootCandidatesFromExecutable(executablePath), [
    join(installRoot, "libexec", "lib", "node_modules", ...packagePathParts),
    join(installRoot, "lib", "node_modules", ...packagePathParts),
    join(installRoot, "node_modules", ...packagePathParts),
    join(installRoot, ...packagePathParts),
  ]);
});

test("getHomebrewPiPackageRootFromExecutable keeps backward-compatible Homebrew mapping", () => {
  const installRoot = join(tmpdir(), "test-prefix");
  assert.equal(
    getHomebrewPiPackageRootFromExecutable(join(installRoot, "bin", "pi")),
    join(installRoot, "libexec", "lib", "node_modules", ...packagePathParts),
  );
});

test("getPiPackageRoot resolves the installed pi package root in this environment", async () => {
  const packageRoot = await getPiPackageRoot();
  assert.match(packageRoot, /@mariozechner\/pi-coding-agent$/);
  assert.match(packageRoot, /pi-coding-agent/);
});
