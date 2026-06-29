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
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CACHE = (() => {
  try {
    return readFileSync(CACHE_PATH, "utf8");
  } catch {
    return undefined;
  }
})();
const STUB_PACKAGE_DIR = resolve("agent/extensions/node_modules");
const PI_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@earendil-works/pi-coding-agent");
const PI_AI_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@earendil-works/pi-ai");

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
    name: "@earendil-works/pi-coding-agent",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(PI_PACKAGE_DIR, "index.js"), "");

  mkdirSync(PI_AI_PACKAGE_DIR, { recursive: true });
  writeFileSync(resolve(PI_AI_PACKAGE_DIR, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-ai",
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
    imageGenerationProviders: {},
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

test("checks image generation models from settings.config before settings", async () => {
  const mod = await loadExtension();
  const checkModelHealth = mod.checkModelHealth;

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({
    enabledModels: [],
    imageGenerationProviders: {
      "reallms-dev": {
        models: [{ id: "z-image-turbo", name: "z-image-turbo" }],
      },
    },
  }, null, 2)}\n`);
  writeFileSync(SETTINGS_PATH, `${JSON.stringify({
    enabledModels: [],
    imageGenerationProviders: {
      "reallms-dev": {
        models: [{ id: "generated-only-image-model", name: "generated-only-image-model" }],
      },
    },
  }, null, 2)}\n`);

  const fetchCalls: Array<{ url: string; body?: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), body: String(init?.body || "") });
    return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }] }), { status: 200 });
  }) as typeof fetch;

  const results = await checkModelHealth({
    modelRegistry: {
      find() {
        throw new Error("image generation checks should not use the chat model registry");
      },
      async getApiKeyAndHeaders() {
        throw new Error("image generation checks should not use chat auth");
      },
    },
  }, { forceRefresh: true });

  assert.deepEqual(results.map((r) => ({ id: r.id, status: r.status, name: r.name, service: r.service })), [{
    id: "reallms-dev/z-image-turbo",
    status: "ok",
    name: "z-image-turbo",
    service: "imageGeneration",
  }]);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0]!.url, /\/images\/generations$/);
  const imageRequest = JSON.parse(fetchCalls[0]!.body || "{}");
  assert.equal(imageRequest.model, "z-image-turbo");
  assert.equal(imageRequest.size, "16x16");
});

test("falls back to settings image generation models when settings.config has none", async () => {
  const mod = await loadExtension();
  const checkModelHealth = mod.checkModelHealth;

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({
    enabledModels: [],
  }, null, 2)}\n`);
  writeFileSync(SETTINGS_PATH, `${JSON.stringify({
    enabledModels: [],
    imageGenerationProviders: {
      "reallms-dev": {
        models: [{ id: "settings-image-model", name: "settings-image-model" }],
      },
    },
  }, null, 2)}\n`);

  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: "model not found" }), { status: 404 });
  }) as typeof fetch;

  const results = await checkModelHealth({
    modelRegistry: {
      find() {
        throw new Error("image generation checks should not use the chat model registry");
      },
      async getApiKeyAndHeaders() {
        throw new Error("image generation checks should not use chat auth");
      },
    },
  }, { forceRefresh: true });

  assert.deepEqual(results.map((r) => ({ id: r.id, status: r.status, error: r.error, name: r.name, service: r.service })), [{
    id: "reallms-dev/settings-image-model",
    status: "not-found",
    error: "Image generation request failed (404): {\"error\":\"model not found\"}",
    name: "settings-image-model",
    service: "imageGeneration",
  }]);
});

test("notify summary groups healthy chat and image generation models", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);

  const mod = await loadExtension();
  const checkModelHealth = mod.checkModelHealth;
  const [chatModel] = readAvailableTestModels(1);

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({
    enabledModels: [chatModel.id],
    imageGenerationProviders: {
      "reallms-dev": {
        models: [{ id: "z-image-turbo", name: "z-image-turbo" }],
      },
    },
  }, null, 2)}\n`);
  writeFileSync(CACHE_PATH, `${JSON.stringify({
    checkedAt: Date.now(),
    results: [
      { id: chatModel.id, status: "ok", name: chatModel.name, service: "chat" },
      { id: "reallms-dev/z-image-turbo", status: "ok", name: "z-image-turbo", service: "imageGeneration" },
    ],
  }, null, 2)}\n`);

  const notifications: Array<{ message: string; level: string }> = [];
  await checkModelHealth({
    modelRegistry: {
      find() {
        throw new Error("cache should be used without registry lookup");
      },
      async getApiKeyAndHeaders() {
        throw new Error("cache should be used without auth lookup");
      },
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  }, { notify: true, cacheTtlMs: 60_000 });

  assert.equal(notifications[0]?.level, "info");
  assert.equal(
    notifications[0]?.message,
    `Model health check used cached results: 2 enabled models queryable. 1 chat model (${chatModel.name}), 1 image generation model (z-image-turbo)`,
  );
});

test("filters stale entries out of cached health check results", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  const checkModelHealth = mod.checkModelHealth;

  const [currentModel] = readAvailableTestModels(1);
  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({
    enabledModels: [currentModel.id, "reallms/not-in-current-scope"],
    imageGenerationProviders: {},
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

  assert.deepEqual(results.map((r) => ({ id: r.id, status: r.status })), [{ id: currentModel.id, status: "ok" }]);
});

test("filters models to healthy cached entries when available", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
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

test("getHealthyEnabledModels returns [] when the cache is missing", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  const getHealthyEnabledModels = mod.getHealthyEnabledModels;

  const [model] = readAvailableTestModels(1);
  // No cache file written -> getFreshCachedResults returns null.
  try { rmSync(CACHE_PATH, { force: true }); } catch { /* may not exist */ }

  const filtered = await getHealthyEnabledModels(
    [{ id: model.id, name: model.name }],
    { cacheTtlMs: 60_000 },
  );
  assert.deepEqual(filtered, [], "missing cache must not promote models to healthy");
});

test("getHealthyEnabledModels returns [] when the cache is stale", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  const getHealthyEnabledModels = mod.getHealthyEnabledModels;

  const [model] = readAvailableTestModels(1);
  writeFileSync(CACHE_PATH, `${JSON.stringify({
    checkedAt: Date.now() - 60_000, // older than the 1s TTL below
    results: [{ id: model.id, status: "ok" }],
  }, null, 2)}\n`);

  const filtered = await getHealthyEnabledModels(
    [{ id: model.id, name: model.name }],
    { cacheTtlMs: 1_000 },
  );
  assert.deepEqual(filtered, [], "stale cache must not promote models to healthy");
});

test("getHealthyEnabledModels returns [] when every cached model is unhealthy", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  const getHealthyEnabledModels = mod.getHealthyEnabledModels;

  const [model] = readAvailableTestModels(1);
  writeFileSync(CACHE_PATH, `${JSON.stringify({
    checkedAt: Date.now(),
    results: [{ id: model.id, status: "error", error: "offline" }],
  }, null, 2)}\n`);

  const filtered = await getHealthyEnabledModels(
    [{ id: model.id, name: model.name }],
    { cacheTtlMs: 60_000 },
  );
  assert.deepEqual(filtered, [], "zero healthy must not fall back to all models");
});

test("getFreshCachedModelResult returns a fresh per-model entry and null when stale", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  const getFreshCachedModelResult = mod.getFreshCachedModelResult;

  const [model] = readAvailableTestModels(1);
  writeFileSync(CACHE_PATH, `${JSON.stringify({
    checkedAt: Date.now(),
    results: [{ id: model.id, status: "ok", checkedAt: Date.now() }],
  }, null, 2)}\n`);

  const fresh = await getFreshCachedModelResult(model.id, 60_000);
  assert.equal(fresh?.id, model.id);
  assert.equal(fresh?.status, "ok");

  // Stale per-entry checkedAt -> null even if batch checkedAt is fresh.
  writeFileSync(CACHE_PATH, `${JSON.stringify({
    checkedAt: Date.now(),
    results: [{ id: model.id, status: "ok", checkedAt: Date.now() - 60_000 }],
  }, null, 2)}\n`);
  const stale = await getFreshCachedModelResult(model.id, 1_000);
  assert.equal(stale, null);
});

test("mergeModelResult updates one entry without touching the batch checkedAt or other entries", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  const mergeModelResult = mod.mergeModelResult;

  const batchCheckedAt = Date.now();
  writeFileSync(CACHE_PATH, `${JSON.stringify({
    checkedAt: batchCheckedAt,
    results: [
      { id: "prov-a/other", status: "ok", checkedAt: batchCheckedAt },
    ],
  }, null, 2)}\n`);

  await mergeModelResult({
    id: "prov-a/refreshed",
    status: "ok",
    service: "imageGeneration",
    checkedAt: Date.now(),
  });

  const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  assert.equal(cache.checkedAt, batchCheckedAt, "batch checkedAt must be unchanged");
  const other = cache.results.find((r) => r.id === "prov-a/other");
  assert.equal(other.checkedAt, batchCheckedAt, "other entry must be unchanged");
  const refreshed = cache.results.find((r) => r.id === "prov-a/refreshed");
  assert.equal(refreshed.status, "ok");
});

test("probeModelHealth probes one image model and merges only its entry", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({
    enabledModels: [],
    imageGenerationProviders: {
      "reallms-dev": { models: [{ id: "z-image-turbo", name: "z-image-turbo" }] },
    },
  }, null, 2)}\n`);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  const probeModelHealth = mod.probeModelHealth;

  const batchCheckedAt = Date.now() - 1000;
  writeFileSync(CACHE_PATH, `${JSON.stringify({
    checkedAt: batchCheckedAt,
    results: [{ id: "other/model", status: "ok", checkedAt: batchCheckedAt }],
  }, null, 2)}\n`);

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }] }), { status: 200 })
  ) as typeof fetch;

  const result = await probeModelHealth("reallms-dev/z-image-turbo", {
    modelRegistry: {
      find() { throw new Error("image probe must not use chat registry"); },
      async getApiKeyAndHeaders() { throw new Error("image probe must not use chat auth"); },
    },
  });
  assert.equal(result.status, "ok");
  assert.equal(result.service, "imageGeneration");
  assert.ok(result.checkedAt, "probed result must have a checkedAt");

  // Batch checkedAt and the other entry are untouched.
  const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  assert.equal(cache.checkedAt, batchCheckedAt);
  const other = cache.results.find((r) => r.id === "other/model");
  assert.equal(other.checkedAt, batchCheckedAt);
  const probed = cache.results.find((r) => r.id === "reallms-dev/z-image-turbo");
  assert.equal(probed.status, "ok");
});

test("probeModelHealth returns not-found for an unknown model", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  const probeModelHealth = mod.probeModelHealth;
  rmSync(CACHE_PATH, { force: true });

  const result = await probeModelHealth("prov/does-not-exist", {
    modelRegistry: { find() { return undefined; }, async getApiKeyAndHeaders() { return { ok: false, error: "x" }; } },
  });
  assert.equal(result.status, "not-found");
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
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_CACHE === undefined) {
    rmSync(CACHE_PATH, { force: true });
  } else {
    writeFileSync(CACHE_PATH, ORIGINAL_CACHE);
  }
  rmSync(PI_PACKAGE_DIR, { recursive: true, force: true });
  rmSync(PI_AI_PACKAGE_DIR, { recursive: true, force: true });
});
