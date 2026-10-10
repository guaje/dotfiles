// Run with: npx -y tsx --test agent/extensions/tests/pi-package.test.ts
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  getPiPackageRoot,
  getPiPackageRootCandidatesFromExecutable,
} from "../packages/pi-package.ts";

const packagePathParts = ["@earendil-works", "pi-coding-agent"];
const PACKAGE_NAME = packagePathParts.join("/");
const MODULE_URL = new URL("../packages/pi-package.ts", import.meta.url);
const ENV_KEYS = ["PI_PACKAGE_DIR", "PI_CODING_AGENT_PACKAGE_ROOT", "npm_config_prefix"] as const;

type PiPackageModule = typeof import("../packages/pi-package.ts");

/** The module memoizes its resolution promise, so each env-driven case needs a fresh instance. */
async function freshModule(path = MODULE_URL): Promise<PiPackageModule> {
  return import(`${path.href}?t=${Date.now()}-${Math.random()}`) as Promise<PiPackageModule>;
}

async function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, run: () => Promise<void>): Promise<void> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of ENV_KEYS) {
      const next = values[key];
      if (next === undefined) delete process.env[key];
      else process.env[key] = next;
    }
    await run();
  } finally {
    for (const [key, previous] of saved) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
}

function writePackageRoot(root: string, body: Record<string, unknown>): string {
  const dir = join(root, ...packagePathParts);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(body));
  return dir;
}

test("getPiPackageRootCandidatesFromExecutable maps a pi binary to portable package root candidates", () => {
  const installRoot = join(tmpdir(), "test-prefix");
  const executablePath = join(installRoot, "bin", "pi");
  assert.deepEqual(getPiPackageRootCandidatesFromExecutable(executablePath), [
    join(installRoot, "libexec", "lib", "node_modules", ...packagePathParts),
    join(installRoot, "lib", "node_modules", ...packagePathParts),
    join(installRoot, "node_modules", ...packagePathParts),
    join(installRoot, ...packagePathParts),
    installRoot,
  ]);
});

test("getPiPackageRootCandidatesFromExecutable includes the package root for a resolved dist CLI path", () => {
  const packageRoot = join(tmpdir(), "test-prefix", "libexec", "lib", "node_modules", ...packagePathParts);
  const executablePath = join(packageRoot, "dist", "cli.js");
  assert.ok(getPiPackageRootCandidatesFromExecutable(executablePath).includes(packageRoot));
});

test("getPiPackageRoot resolves the installed pi package root in this environment", async () => {
  const packageRoot = await getPiPackageRoot();
  assert.match(packageRoot, /@earendil-works\/pi-coding-agent$/);
  assert.match(packageRoot, /pi-coding-agent/);
});

test("PI_CODING_AGENT_PACKAGE_ROOT resolves an explicit package root ahead of installed candidates", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-package-explicit-"));
  const packageRoot = writePackageRoot(root, { name: PACKAGE_NAME, version: "0.0.0-test" });
  try {
    const mod = await freshModule();
    await withEnv({ PI_PACKAGE_DIR: undefined, PI_CODING_AGENT_PACKAGE_ROOT: packageRoot }, async () => {
      assert.equal(await mod.getPiPackageRoot(), packageRoot);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PI_PACKAGE_DIR wins over the later package root candidates", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-package-ordering-"));
  const packageDir = writePackageRoot(join(root, "package-dir"), { name: PACKAGE_NAME, version: "0.0.0-test" });
  const codingAgentRoot = writePackageRoot(join(root, "coding-agent-dir"), { name: PACKAGE_NAME, version: "0.0.0-test" });
  try {
    const mod = await freshModule();
    await withEnv({ PI_PACKAGE_DIR: packageDir, PI_CODING_AGENT_PACKAGE_ROOT: codingAgentRoot }, async () => {
      assert.equal(await mod.getPiPackageRoot(), packageDir);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a versionless test stub found through module resolution falls through to the real install", async () => {
  const scenario = await resolutionScenario({ stubVersion: undefined });
  try {
    await withEnv({ PI_PACKAGE_DIR: undefined, PI_CODING_AGENT_PACKAGE_ROOT: undefined, npm_config_prefix: scenario.prefixRoot }, async () => {
      assert.equal(await scenario.module.getPiPackageRoot(), scenario.installRoot);
    });
  } finally {
    rmSync(scenario.root, { recursive: true, force: true });
  }
});

test("a versioned package discovered through module resolution wins over the npm prefix candidate", async () => {
  const scenario = await resolutionScenario({ stubVersion: "1.2.3-test" });
  try {
    await withEnv({ PI_PACKAGE_DIR: undefined, PI_CODING_AGENT_PACKAGE_ROOT: undefined, npm_config_prefix: scenario.prefixRoot }, async () => {
      assert.equal(await scenario.module.getPiPackageRoot(), scenario.discoveredRoot);
    });
  } finally {
    rmSync(scenario.root, { recursive: true, force: true });
  }
});

/**
 * A copy of the resolver plus a discoverable package in the same temp tree, so the
 * require.resolve candidate is fully under test control. `discoveredRoot` is what
 * `require.resolve("@earendil-works/pi-coding-agent/package.json")` finds from the copy;
 * `installRoot` is the npm-prefix candidate it should fall through to when the discovered
 * package is a versionless test stub.
 */
async function resolutionScenario(options: { stubVersion?: string }): Promise<{
  root: string;
  module: PiPackageModule;
  discoveredRoot: string;
  installRoot: string;
  prefixRoot: string;
}> {
  // realpath: require.resolve reports the resolved path, so a symlinked tmp root
  // (macOS /var -> /private/var) would otherwise compare unequal to the fixture path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-package-stub-")));
  const moduleDir = join(root, "packages");
  mkdirSync(moduleDir, { recursive: true });
  copyFileSync(fileURLToPath(MODULE_URL), join(moduleDir, "pi-package.ts"));
  const discoveredRoot = writePackageRoot(join(root, "node_modules"), {
    name: PACKAGE_NAME,
    type: "module",
    exports: { ".": "./index.js", "./package.json": "./package.json" },
    ...(options.stubVersion ? { version: options.stubVersion } : {}),
  });
  writeFileSync(join(discoveredRoot, "index.js"), "export const stub = true;\n");
  const prefixRoot = join(root, "prefix");
  const installRoot = writePackageRoot(join(prefixRoot, "lib", "node_modules"), { name: PACKAGE_NAME, version: "9.9.9-test" });
  return { root, module: await freshModule(pathToFileURL(join(moduleDir, "pi-package.ts"))), discoveredRoot, installRoot, prefixRoot };
}
