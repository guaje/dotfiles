import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSION_PATH = resolve("agent/extensions/model-health-check.ts");
const SETTINGS_CONFIG_PATH = resolve("agent/settings.config.json");
const SETTINGS_PATH = resolve("agent/settings.json");
const MODELS_PATH = resolve("agent/models.json");
const ORIGINAL_SETTINGS_CONFIG = readFileSync(SETTINGS_CONFIG_PATH, "utf8");
const ORIGINAL_SETTINGS = readFileSync(SETTINGS_PATH, "utf8");
const CACHE_PATH = resolve("agent/model-health-cache.json");
const ORIGINAL_CACHE = (() => {
  try {
    return readFileSync(CACHE_PATH, "utf8");
  } catch {
    return undefined;
  }
})();
const STUB_PACKAGE_DIR = resolve("agent/extensions/node_modules");
const PI_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@mariozechner/pi-coding-agent");
const PI_AI_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@mariozechner/pi-ai");

interface AvailableTestModel {
  id: string;
  name: string;
  reasoning?: boolean;
}

function splitTestModelId(fullId: string): { provider: string; modelId: string } {
  const [provider, ...rest] = fullId.split("/");
  assert.ok(provider && rest.length > 0, `Expected provider/model id, got ${fullId}`);
  return { provider, modelId: rest.join("/") };
}

function readAvailableTestModels(minCount: number): AvailableTestModel[] {
  const modelsFile = JSON.parse(readFileSync(MODELS_PATH, "utf8"));
  const settingsFile = JSON.parse(readFileSync(SETTINGS_CONFIG_PATH, "utf8"));
  const enabledIds: string[] = settingsFile.enabledModels || [];
  const metadata = new Map<string, AvailableTestModel>();

  for (const [providerId, provider] of Object.entries<any>(modelsFile.providers || {})) {
    for (const model of provider.models || []) {
      metadata.set(`${providerId}/${model.id}`, { ...model, id: `${providerId}/${model.id}` });
    }
  }

  const enabledModels = enabledIds.map((id) => metadata.get(id) || { id, name: splitTestModelId(id).modelId });
  assert.ok(enabledModels.length >= minCount, `Expected at least ${minCount} enabled models for model-health-check tests`);
  return enabledModels;
}

function runtimeModelFromId(fullId: string): { provider: string; id: string } {
  const { provider, modelId } = splitTestModelId(fullId);
  return { provider, id: modelId };
}

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

  const selectedModels = readAvailableTestModels(3).slice(0, 3);
  const selectedIds = selectedModels.map((model) => model.id);
  const failingId = selectedIds[1]!;
  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({
    enabledModels: selectedIds,
  }, null, 2)}\n`);

  let active = 0;
  let maxActive = 0;
  const called: string[] = [];
  (globalThis as any).__completeSimpleMock = async (model: any) => {
    const fullId = `${model.provider}/${model.id}`;
    called.push(fullId);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    if (fullId === failingId) throw new Error("offline");
    return { stopReason: "stop", content: [{ type: "text", text: "OK" }] };
  };

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    modelRegistry: {
      find(provider: string, modelId: string) {
        const fullId = `${provider}/${modelId}`;
        return selectedIds.includes(fullId) ? runtimeModelFromId(fullId) : undefined;
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
  assert.deepEqual([...called].sort(), [...selectedIds].sort());
  const expectedStatuses = selectedIds
    .map((id) => [id, id === failingId ? "error" : "ok"])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(
    [...results].map((result: any) => [result.id, result.status]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    expectedStatuses,
  );
  assert.match(notifications[0]!.message, /checked model availability/);

  delete (globalThis as any).__completeSimpleMock;
  notifications.length = 0;
  const cachedResults = await checkModelHealth(ctx, { notify: true, cacheTtlMs: 60_000 });
  assert.deepEqual(cachedResults, results);
  assert.match(notifications[0]!.message, /Model health check used cached results/);
});

test("uses settings.config enabled models and skips stale scoped-provider models", async () => {
  const mod = await loadExtension();
  const checkModelHealth = mod.checkModelHealth;

  const scopedModel = readAvailableTestModels(1).find((model) => model.id.startsWith("reallms/"))!;
  const staleScopedModel = "reallms/not-in-current-scope";
  const generatedOnlyModel = "openai-codex/generated-only-model";
  const builtInModel = "openai-codex/test-built-in";

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({
    enabledModels: [scopedModel.id, staleScopedModel, builtInModel],
  }, null, 2)}\n`);
  writeFileSync(SETTINGS_PATH, `${JSON.stringify({
    enabledModels: [generatedOnlyModel],
  }, null, 2)}\n`);

  const called: string[] = [];
  (globalThis as any).__completeSimpleMock = async (model: any) => {
    called.push(`${model.provider}/${model.id}`);
    return { stopReason: "stop", content: [{ type: "text", text: "OK" }] };
  };

  const ctx = {
    modelRegistry: {
      find(provider: string, modelId: string) {
        return { provider, id: modelId };
      },
      async getApiKeyAndHeaders(model: any) {
        return { ok: true, apiKey: `key-${model.id}` };
      },
    },
  };

  await checkModelHealth(ctx, { forceRefresh: true, cacheTtlMs: 60_000 });

  assert.deepEqual([...called].sort(), [builtInModel, scopedModel.id].sort());
});

test("filters stale entries out of cached health check results", async () => {
  const mod = await loadExtension();
  const checkModelHealth = mod.checkModelHealth;

  const [currentModel] = readAvailableTestModels(1);
  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({
    enabledModels: [currentModel.id, "reallms/not-in-current-scope"],
  }, null, 2)}\n`);
  writeFileSync(CACHE_PATH, `${JSON.stringify({
    checkedAt: Date.now(),
    results: [
      { id: currentModel.id, status: "ok" },
      { id: "reallms/not-in-current-scope", status: "error", error: "stale" },
    ],
  }, null, 2)}\n`);

  (globalThis as any).__completeSimpleMock = async () => {
    throw new Error("cache should be used without probing");
  };

  const results = await checkModelHealth({
    modelRegistry: {
      find() {
        throw new Error("cache should be used without registry lookup");
      },
      async getApiKeyAndHeaders() {
        throw new Error("cache should be used without auth lookup");
      },
    },
  }, { cacheTtlMs: 60_000 });

  assert.deepEqual(results, [{ id: currentModel.id, status: "ok" }]);
});

test("filters models to healthy cached entries when available", async () => {
  const mod = await loadExtension();
  const getHealthyEnabledModels = mod.getHealthyEnabledModels;

  const [healthyModel, unhealthyModel] = readAvailableTestModels(2);
  writeFileSync(CACHE_PATH, `${JSON.stringify({
    checkedAt: Date.now(),
    results: [
      { id: healthyModel.id, status: "ok" },
      { id: unhealthyModel.id, status: "error", error: "offline" },
    ],
  }, null, 2)}\n`);

  const models = [
    { id: healthyModel.id, name: healthyModel.name },
    { id: unhealthyModel.id, name: unhealthyModel.name },
  ];

  const filtered = await getHealthyEnabledModels(models, { cacheTtlMs: 60_000 });
  assert.deepEqual(filtered, [{ id: healthyModel.id, name: healthyModel.name }]);
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
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  if (ORIGINAL_CACHE === undefined) {
    rmSync(CACHE_PATH, { force: true });
  } else {
    writeFileSync(CACHE_PATH, ORIGINAL_CACHE);
  }
  rmSync(PI_PACKAGE_DIR, { recursive: true, force: true });
  rmSync(PI_AI_PACKAGE_DIR, { recursive: true, force: true });
});
