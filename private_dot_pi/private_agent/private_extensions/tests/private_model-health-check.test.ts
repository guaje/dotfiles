import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSION_PATH = resolve("agent/extensions/model-health-check.ts");
const SETTINGS_CONFIG_PATH = resolve("agent/settings.config.json");
const ORIGINAL_SETTINGS_CONFIG = readFileSync(SETTINGS_CONFIG_PATH, "utf8");
const CACHE_PATH = resolve("agent/model-health-cache.json");
const STUB_PACKAGE_DIR = resolve("agent/extensions/node_modules");
const PI_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@mariozechner/pi-coding-agent");
const PI_AI_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@mariozechner/pi-ai");

async function loadExtension() {
  mkdirSync(PI_PACKAGE_DIR, { recursive: true });
  writeFileSync(resolve(PI_PACKAGE_DIR, "package.json"), JSON.stringify({
    name: "@mariozechner/pi-coding-agent",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(PI_PACKAGE_DIR, "index.js"), "");

  mkdirSync(PI_AI_PACKAGE_DIR, { recursive: true });
  writeFileSync(resolve(PI_AI_PACKAGE_DIR, "package.json"), JSON.stringify({
    name: "@mariozechner/pi-ai",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(PI_AI_PACKAGE_DIR, "index.js"), [
    "export async function completeSimple(model, context, options) {",
    "  if (typeof globalThis.__completeSimpleMock === 'function') return globalThis.__completeSimpleMock(model, context, options);",
    "  return { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] };",
    "}",
  ].join("\n"));

  const moduleUrl = `${pathToFileURL(EXTENSION_PATH).href}?t=${Date.now()}`;
  return import(moduleUrl);
}

test("checks model health with a concurrency limit and caches results", async () => {
  const mod = await loadExtension();
  const checkModelHealth = mod.checkModelHealth;

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({
    enabledModels: [
      "openai-codex/gpt-5.4",
      "reallms/Qwen3-Coder-Next",
      "reallms/gpt-oss-120b",
    ],
  }, null, 2)}\n`);

  let active = 0;
  let maxActive = 0;
  const called: string[] = [];
  (globalThis as any).__completeSimpleMock = async (model: any) => {
    called.push(`${model.provider}/${model.id}`);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    if (model.id === "Qwen3-Coder-Next") throw new Error("offline");
    return { stopReason: "stop", content: [{ type: "text", text: "OK" }] };
  };

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    modelRegistry: {
      find(provider: string, modelId: string) {
        return { provider, id: modelId };
      },
      async getApiKeyAndHeaders(model: any) {
        return { ok: true, apiKey: `key-${model.id}` };
      },
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  const results = await checkModelHealth(ctx, { notify: true, concurrencyLimit: 2, forceRefresh: true, cacheTtlMs: 60_000 });

  assert.equal(maxActive, 2);
  assert.deepEqual([...called].sort(), [
    "openai-codex/gpt-5.4",
    "reallms/Qwen3-Coder-Next",
    "reallms/gpt-oss-120b",
  ]);
  assert.deepEqual(
    [...results].map((result: any) => [result.id, result.status]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ["openai-codex/gpt-5.4", "ok"],
      ["reallms/gpt-oss-120b", "ok"],
      ["reallms/Qwen3-Coder-Next", "error"],
    ],
  );
  assert.match(notifications[0]!.message, /checked model availability/);

  delete (globalThis as any).__completeSimpleMock;
  notifications.length = 0;
  const cachedResults = await checkModelHealth(ctx, { notify: true, cacheTtlMs: 60_000 });
  assert.deepEqual(cachedResults, results);
  assert.match(notifications[0]!.message, /Model health check used cached results/);
});

test("filters models to healthy cached entries when available", async () => {
  const mod = await loadExtension();
  const getHealthyEnabledModels = mod.getHealthyEnabledModels;

  writeFileSync(CACHE_PATH, `${JSON.stringify({
    checkedAt: Date.now(),
    results: [
      { id: "openai-codex/gpt-5.4", status: "ok" },
      { id: "reallms/Qwen3-Coder-Next", status: "error", error: "offline" },
    ],
  }, null, 2)}\n`);

  const models = [
    { id: "openai-codex/gpt-5.4", name: "gpt" },
    { id: "reallms/Qwen3-Coder-Next", name: "coder" },
  ];

  const filtered = await getHealthyEnabledModels(models, { cacheTtlMs: 60_000 });
  assert.deepEqual(filtered, [{ id: "openai-codex/gpt-5.4", name: "gpt" }]);
});

test("registers a model-health command", async () => {
  const mod = await loadExtension();
  const extension = mod.default;

  let registeredCommandName: string | undefined;
  let registeredCommand: any;
  const pi = {
    on() {},
    registerCommand(name: string, command: any) {
      registeredCommandName = name;
      registeredCommand = command;
    },
  };

  extension(pi as any);

  assert.equal(registeredCommandName, "model-health");
  assert.equal(registeredCommand.description, "Check availability of enabled models and update health cache");
});

test.after(() => {
  delete (globalThis as any).__completeSimpleMock;
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  rmSync(CACHE_PATH, { force: true });
  rmSync(PI_PACKAGE_DIR, { recursive: true, force: true });
  rmSync(PI_AI_PACKAGE_DIR, { recursive: true, force: true });
});
