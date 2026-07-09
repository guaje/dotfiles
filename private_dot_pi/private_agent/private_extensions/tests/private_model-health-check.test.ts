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
const PI_TUI_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@earendil-works/pi-tui");

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

  mkdirSync(PI_TUI_PACKAGE_DIR, { recursive: true });
  writeFileSync(resolve(PI_TUI_PACKAGE_DIR, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-tui",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(PI_TUI_PACKAGE_DIR, "index.js"), [
    "export class Container {",
    "  constructor() { this.children = []; }",
    "  addChild(c) { this.children.push(c); return c; }",
    "  render() { return this.children.map((c) => (typeof c.text === 'string' ? c.text : '')).join(''); }",
    "  invalidate() {}",
    "}",
    "export class Text {",
    "  constructor(text) { this.text = text; }",
    "  render() { return this.text; }",
    "}",
  ].join("\n"));

  const moduleUrl = `${pathToFileURL(EXTENSION_PATH).href}?t=${Date.now()}`;
  return import(moduleUrl);
}

// Restore original settings + cache before every test so no test can pollute
// another by leaving a mutated SETTINGS_CONFIG_PATH / cache behind. The
// originals are captured once at load; tests that need a dirty state set it
// up themselves and this hook resets it before the next test runs.
test.beforeEach(() => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  if (ORIGINAL_CACHE === undefined) {
    rmSync(CACHE_PATH, { force: true });
  } else {
    writeFileSync(CACHE_PATH, ORIGINAL_CACHE);
  }
  delete (globalThis as any).__completeSimpleMock;
});

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
  assert.match(notifications[0]!.message, /Model health:/);

  delete (globalThis as any).__completeSimpleMock;
  notifications.length = 0;
  const cachedResults = await checkModelHealth(ctx, { notify: true, cacheTtlMs: 60_000 });
  assert.deepEqual(cachedResults, results);
  assert.match(notifications[0]!.message, /Model health \(cached\)/);
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
    `Model health (cached): 2 enabled models queryable. 1 chat model (${chatModel.name}), 1 image generation model (z-image-turbo)`,
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

test("formatHealthTable renders chat model table with throughput and latency", async () => {
  const mod = await loadExtension();
  const formatHealthTable = mod.formatHealthTable;

  const lines = formatHealthTable([
    { id: "p/a", status: "ok", name: "Alpha", service: "chat", latencyMs: 1930, tokensPerSecond: 4.2 },
    { id: "p/b", status: "ok", name: "Beta", service: "chat", source: "user", latencyMs: 500 },
    { id: "p/img", status: "ok", name: "img", service: "imageGeneration" },
    { id: "p/bad", status: "error", name: "bad", service: "chat", error: "offline" },
  ]);

  assert.match(lines[0]!, /\[Models\]/);
  const table = lines.join("\n");
  assert.match(table, /\n  auth\n/);
  assert.match(table, /\n  user\n/);
  assert.match(table, /Model\s+Est\. tok\/s\s+E2E latency/);
  assert.match(table, /Alpha\s+4\.2\s+1\.93s/);
  assert.match(table, /Beta\s+—\s+0\.50s/);
  assert.match(table, /1 image generation model \(img\)/);
  assert.match(table, /Unavailable: p\/bad \(offline\)/);
});

test("formatHealthTable omits the chat table when only image models are healthy", async () => {
  const mod = await loadExtension();
  const lines = mod.formatHealthTable([
    { id: "p/img", status: "ok", name: "img", service: "imageGeneration" },
  ]);
  const table = lines.join("\n");
  assert.match(lines[0]!, /\[Models\]/);
  assert.doesNotMatch(table, /Est\. tok\/s/);
  assert.match(table, /1 image generation model \(img\)/);
});

test("healthMessageRenderer builds a themed Container from message.details", async () => {
  const mod = await loadExtension();
  // Register the renderer via the extension factory with a capturing fake pi.
  let renderer: any;
  const pi: any = {
    on() {},
    registerCommand() {},
    registerMessageRenderer(_type: string, r: any) { renderer = r; },
  };
  mod.default(pi);
  assert.ok(typeof renderer === "function", "renderer was registered");

  const results = [
    { id: "p/a", status: "ok", name: "Alpha", service: "chat", latencyMs: 1000, tokensPerSecond: 8 },
    { id: "p/img", status: "ok", name: "img", service: "imageGeneration" },
  ];
  const comp = renderer({ details: results }, { expanded: false }, { fg: (_c: string, t: string) => t, bold: (t: string) => t });
  // Flatten the Container's Text children back to lines.
  const table = comp.children.map((c: any) => c.text ?? "").join("\n");
  assert.match(table, /\[Models\]/);
  assert.match(table, /Alpha/);
  assert.match(table, /1 image generation model \(img\)/);
});

test("formatHealthTable applies theme color tokens per cell", async () => {
  const mod = await loadExtension();
  const fgCalls: { color: string; text: string }[] = [];
  const boldCalls: string[] = [];
  const recTheme = {
    fg: (color: string, text: string) => { fgCalls.push({ color, text }); return text; },
    bold: (text: string) => { boldCalls.push(text); return text; },
  };
  mod.formatHealthTable([
    { id: "p/a", status: "ok", name: "Alpha", service: "chat", latencyMs: 1000, tokensPerSecond: 8 },
    { id: "p/img", status: "ok", name: "img", service: "imageGeneration" },
    { id: "p/bad", status: "error", name: "bad", service: "chat", error: "offline" },
  ], recTheme);
  const colors = new Set(fgCalls.map((c) => c.color));
  assert.ok(colors.has("mdHeading"), "resource heading uses the same color as /reload sections");
  assert.ok(colors.has("accent"), "source groups use the same color as /reload scopes");
  assert.ok(colors.has("dim"), "table headers, rows, and image line use the same dim color as /reload entries");
  assert.ok(colors.has("error"), "unavailable line uses error");
  assert.ok(!colors.has("text"), "model rows should not use chat-table text color");
  assert.ok(!colors.has("toolOutput"), "model rows should not use chat-table output color");
  assert.ok(!colors.has("muted"), "image line should follow /reload dim entry color");
  assert.ok(!boldCalls.some((t) => /\[Models\]/.test(t)), "resource heading matches /reload and is not bolded");
});

test("renderHealthTable notifies joined lines in non-tui mode", async () => {
  const mod = await loadExtension();
  const notifications: string[] = [];
  await mod.renderHealthTable(
    [{ id: "p/a", status: "ok", name: "Alpha", service: "chat", latencyMs: 1000, tokensPerSecond: 8 }],
    { mode: "print", ui: { notify: (m: string) => notifications.push(m) } } as any,
    {} as any,
  );
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!, /\[Models\]/);
  assert.match(notifications[0]!, /\n/);
  assert.match(notifications[0]!, /Alpha/);
});

test("renderHealthTable uses a transient widget in tui mode", async () => {
  const mod = await loadExtension();
  const results = [{ id: "p/a", status: "ok", name: "Alpha", service: "chat", latencyMs: 1000, tokensPerSecond: 8 }];
  let widget: { key: string; factory: any; options: any } | undefined;
  const pi = {
    sendMessage: async () => { throw new Error("sendMessage should not be used when widgets are available"); },
  };
  await mod.renderHealthTable(
    results,
    {
      mode: "tui",
      ui: {
        notify: () => { throw new Error("notify should not be used in tui mode"); },
        setWidget: (key: string, factory: any, options: any) => { widget = { key, factory, options }; },
      },
    } as any,
    pi as any,
  );
  assert.ok(widget, "setWidget was called");
  assert.equal(widget!.key, "model-health");
  assert.equal(widget!.options?.placement, "aboveEditor");
  const rendered = widget!.factory({}, { fg: (_c: string, t: string) => t, bold: (t: string) => t }).render();
  assert.match(rendered, /\[Models\]/);
  assert.match(rendered, /Alpha/);
});

test("session_start renders startup immediately and reload after Pi's reload status", async () => {
  const mod = await loadExtension();
  const [chatModel] = readAvailableTestModels(1);
  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({ enabledModels: [chatModel.id] }, null, 2)}\n`);
  writeFileSync(SETTINGS_PATH, `${JSON.stringify({ enabledModels: [chatModel.id] }, null, 2)}\n`);
  writeFileSync(CACHE_PATH, `${JSON.stringify({
    checkedAt: Date.now(),
    results: [{ id: chatModel.id, status: "ok", name: chatModel.name, service: "chat" }],
  }, null, 2)}\n`);

  let sessionHandler: ((event: any, ctx: any) => Promise<void>) | undefined;
  let widgetCount = 0;
  let clearCount = 0;
  let sentCount = 0;
  const widgetKeys: string[] = [];
  const reloadCallbacks: Array<() => void> = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void, _delay?: number) => {
    reloadCallbacks.push(callback);
    return 0 as any;
  }) as any;
  const ctx = {
    mode: "tui",
    ui: {
      setWidget: (key: string, factory: any, options: any) => {
        assert.equal(key, "model-health");
        assert.equal(options?.placement, "aboveEditor");
        if (factory === undefined) {
          clearCount++;
          return;
        }
        widgetCount++;
        widgetKeys.push(key);
        const rendered = factory({}, { fg: (_c: string, t: string) => t, bold: (t: string) => t }).render();
        assert.match(rendered, /\[Models\]/);
      },
    },
  } as any;
  let beforeAgentStartHandler: ((event: any, ctx: any) => Promise<void>) | undefined;
  const pi: any = {
    on(event: string, handler: any) {
      if (event === "session_start") sessionHandler = handler;
      if (event === "before_agent_start") beforeAgentStartHandler = handler;
    },
    registerCommand() {},
    registerMessageRenderer() {},
    sendMessage: async () => { sentCount++; },
  };
  try {
    mod.default(pi);
    assert.ok(typeof sessionHandler === "function", "session_start handler was registered");
    assert.ok(typeof beforeAgentStartHandler === "function", "before_agent_start handler was registered");

    // "new"/"resume"/"fork" must early-return without rendering (no probing, no I/O).
    await sessionHandler!({ type: "session_start", reason: "new" }, ctx);
    await sessionHandler!({ type: "session_start", reason: "resume" }, ctx);
    await sessionHandler!({ type: "session_start", reason: "fork" }, ctx);
    assert.equal(widgetCount, 0, "new/resume/fork must not render the health table");
    assert.equal(sentCount, 0, "automatic health should not append chat messages");

    await sessionHandler!({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(widgetCount, 1, "startup should render before the handler resolves");
    assert.equal(sentCount, 0, "startup should use a replaceable widget, not a chat message");

    await sessionHandler!({ type: "session_start", reason: "reload" }, ctx);
    assert.equal(widgetCount, 1, "reload should defer rendering until after Pi prints its reload status");
    assert.equal(reloadCallbacks.length, 1, "only the reload render delay should be scheduled");
    reloadCallbacks[0]!();
    for (let i = 0; i < 20 && widgetCount < 2; i++) {
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
    }
    assert.equal(widgetCount, 2, "reload should replace the health widget after the delay");
    assert.equal(sentCount, 0, "reload should not leave persistent chat tables behind");
    assert.deepEqual(widgetKeys, ["model-health", "model-health"]);
    assert.equal(clearCount, 0, "widget should remain visible until the next agent turn starts");
    await beforeAgentStartHandler!({ type: "before_agent_start" }, ctx);
    assert.equal(clearCount, 1, "model-health widget should clear when new content starts generating");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
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
  rmSync(PI_TUI_PACKAGE_DIR, { recursive: true, force: true });
});
