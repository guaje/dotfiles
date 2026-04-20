// Run with: npx -y tsx --test agent/extensions/tests/reload-merged-settings.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSION_PATH = resolve("agent/extensions/reload-merged-settings.ts");
const STUB_PACKAGE_DIR = resolve("agent/extensions/node_modules");
const CHILD_PROCESS_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "node:child_process");
const FS_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "node:fs");
const UTIL_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "node:util");

async function loadExtension() {
  mkdirSync(CHILD_PROCESS_PACKAGE_DIR, { recursive: true });
  writeFileSync(resolve(CHILD_PROCESS_PACKAGE_DIR, "index.js"), [
    "export function execFile(...args) {",
    "  return globalThis.__execFileCallbackMock(...args);",
    "}",
  ].join("\n"));

  mkdirSync(FS_PACKAGE_DIR, { recursive: true });
  writeFileSync(resolve(FS_PACKAGE_DIR, "index.js"), [
    "export function watch(...args) {",
    "  return globalThis.__watchMock(...args);",
    "}",
  ].join("\n"));

  mkdirSync(UTIL_PACKAGE_DIR, { recursive: true });
  writeFileSync(resolve(UTIL_PACKAGE_DIR, "index.js"), [
    "export function promisify(fn) {",
    "  return (...args) => globalThis.__execFileMock(fn, ...args);",
    "}",
  ].join("\n"));

  const patchedExtensionPath = resolve("agent/extensions/.reload-merged-settings.testable.ts");
  let source = readFileSync(EXTENSION_PATH, "utf8");
  source = source.replace(
    'from "node:child_process"',
    'from "./node_modules/node:child_process/index.js"',
  );
  source = source.replace(
    'from "node:fs"',
    'from "./node_modules/node:fs/index.js"',
  );
  source = source.replace(
    'from "node:util"',
    'from "./node_modules/node:util/index.js"',
  );
  writeFileSync(patchedExtensionPath, source);

  const moduleUrl = `${pathToFileURL(patchedExtensionPath).href}?t=${Date.now()}`;
  const mod = await import(moduleUrl);
  return mod.default as (pi: { on: (event: string, handler: any) => void }) => void;
}

test.after(() => {
  rmSync(resolve("agent/extensions/.reload-merged-settings.testable.ts"), { force: true });
  rmSync(CHILD_PROCESS_PACKAGE_DIR, { recursive: true, force: true });
  rmSync(FS_PACKAGE_DIR, { recursive: true, force: true });
  rmSync(UTIL_PACKAGE_DIR, { recursive: true, force: true });
  delete (globalThis as any).__execFileMock;
  delete (globalThis as any).__execFileCallbackMock;
  delete (globalThis as any).__watchMock;
});

function createHarness() {
  const handlers = new Map<string, any>();
  const notifications: Array<{ message: string; level: string }> = [];

  return {
    pi: {
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
    },
    getHandler(name: string) {
      assert.ok(handlers.has(name), `Expected handler for ${name}`);
      return handlers.get(name);
    },
    ctx: {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    },
    notifications,
  };
}

test("merges on session start and watches settings.config.json for changes", async () => {
  const extension = await loadExtension();
  const harness = createHarness();
  const execCalls: any[] = [];
  const watchCalls: any[] = [];
  let watchListener: (() => void) | undefined;
  let closeCount = 0;

  (globalThis as any).__execFileCallbackMock = (...args: any[]) => args;
  (globalThis as any).__execFileMock = async (_fn: any, ...args: any[]) => {
    execCalls.push(args);
    return { stdout: "", stderr: "" };
  };
  (globalThis as any).__watchMock = (path: string, listener: () => void) => {
    watchCalls.push(path);
    watchListener = listener;
    return {
      close() {
        closeCount += 1;
      },
    };
  };

  extension(harness.pi as any);

  await harness.getHandler("session_start")({}, harness.ctx as any);
  assert.equal(execCalls.length, 1);
  assert.match(String(execCalls[0][0]), /agent\/scripts\/merge-settings\.sh$/);
  assert.equal(watchCalls.length, 1);
  assert.match(String(watchCalls[0]), /agent\/settings\.config\.json$/);

  watchListener?.();
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(execCalls.length, 2);

  harness.getHandler("session_shutdown")({}, harness.ctx as any);
  assert.equal(closeCount, 1);
  assert.deepEqual(harness.notifications, []);
});

test("shows an error notification when merging fails", async () => {
  const extension = await loadExtension();
  const harness = createHarness();

  (globalThis as any).__execFileCallbackMock = (...args: any[]) => args;
  (globalThis as any).__execFileMock = async () => {
    throw new Error("boom");
  };
  (globalThis as any).__watchMock = () => ({ close() {} });

  extension(harness.pi as any);
  await harness.getHandler("session_start")({}, harness.ctx as any);

  assert.deepEqual(harness.notifications, [
    { message: "Failed to merge settings: boom", level: "error" },
  ]);
});
