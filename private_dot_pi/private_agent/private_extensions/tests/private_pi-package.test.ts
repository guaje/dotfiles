import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODULE_PATH = resolve("agent/extensions/packages/pi-package.ts");
const ORIGINAL_PACKAGE_ROOT = process.env.PI_CODING_AGENT_PACKAGE_ROOT;
const ORIGINAL_NPM_PREFIX = process.env.npm_config_prefix;

async function loadModule() {
  const moduleUrl = `${pathToFileURL(MODULE_PATH).href}?t=${Date.now()}`;
  return import(moduleUrl);
}

test("resolves pi package paths from PI_CODING_AGENT_PACKAGE_ROOT", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-package-"));
  const packageRoot = join(root, "fake-pi-package");
  const bundledDependencyRoot = join(packageRoot, "node_modules", "example-dep");

  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  mkdirSync(bundledDependencyRoot, { recursive: true });

  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "@mariozechner/pi-coding-agent",
    type: "module",
  }));
  writeFileSync(join(packageRoot, "dist", "example.js"), "export const value = 42;\n");
  writeFileSync(join(bundledDependencyRoot, "helper.js"), "export const helper = true;\n");

  process.env.PI_CODING_AGENT_PACKAGE_ROOT = packageRoot;
  delete process.env.npm_config_prefix;

  try {
    const mod = await loadModule();

    const resolvedRoot = await mod.getPiPackageRoot();
    const resolvedPackagePath = await mod.resolvePiPackagePath("dist/example.js");
    const resolvedBundledDependencyPath = await mod.resolvePiBundledDependencyPath("example-dep", "helper.js");
    const imported = await mod.importPiModule("dist/example.js");

    assert.equal(resolvedRoot, packageRoot);
    assert.equal(resolvedPackagePath, join(packageRoot, "dist", "example.js"));
    assert.equal(resolvedBundledDependencyPath, join(packageRoot, "node_modules", "example-dep", "helper.js"));
    assert.equal(imported.value, 42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.after(() => {
  if (ORIGINAL_PACKAGE_ROOT === undefined) delete process.env.PI_CODING_AGENT_PACKAGE_ROOT;
  else process.env.PI_CODING_AGENT_PACKAGE_ROOT = ORIGINAL_PACKAGE_ROOT;

  if (ORIGINAL_NPM_PREFIX === undefined) delete process.env.npm_config_prefix;
  else process.env.npm_config_prefix = ORIGINAL_NPM_PREFIX;
});
