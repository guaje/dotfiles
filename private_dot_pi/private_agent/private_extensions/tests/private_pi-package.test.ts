// Run with: npx -y tsx --test agent/extensions/tests/pi-package.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  getHomebrewPiPackageRootFromExecutable,
  getNpmGlobalPiPackageRoot,
  getPiPackageRoot,
} from "../packages/pi-package.ts";

test("getNpmGlobalPiPackageRoot maps an npm global node_modules path to the pi package root", () => {
  assert.equal(
    getNpmGlobalPiPackageRoot("/data/data/com.termux/files/usr/lib/node_modules"),
    "/data/data/com.termux/files/usr/lib/node_modules/@mariozechner/pi-coding-agent",
  );
});

test("getHomebrewPiPackageRootFromExecutable maps the Homebrew pi binary to the package root", () => {
  assert.equal(
    getHomebrewPiPackageRootFromExecutable("/opt/homebrew/Cellar/pi-coding-agent/0.67.68/bin/pi"),
    "/opt/homebrew/Cellar/pi-coding-agent/0.67.68/libexec/lib/node_modules/@mariozechner/pi-coding-agent",
  );
});

test("getPiPackageRoot resolves the installed pi package root in this environment", async () => {
  const packageRoot = await getPiPackageRoot();
  assert.match(packageRoot, /@mariozechner\/pi-coding-agent$/);
  assert.match(packageRoot, /pi-coding-agent/);
});
