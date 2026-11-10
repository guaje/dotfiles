import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TEST_ROOT = mkdtempSync(resolve(tmpdir(), "pi-health-fixture-"));
const TEST_AGENT = resolve(TEST_ROOT, "agent");
const TEST_EXTENSIONS = resolve(TEST_AGENT, "extensions");
mkdirSync(TEST_EXTENSIONS, { recursive: true });
cpSync(resolve("agent/extensions/06-health"), resolve(TEST_EXTENSIONS, "06-health"), { recursive: true });
cpSync(resolve("agent/extensions/08-settings"), resolve(TEST_EXTENSIONS, "08-settings"), { recursive: true });
writeFileSync(resolve(TEST_AGENT, "models.json"), JSON.stringify({ providers: {
  reallms: { baseUrl: "https://models.test", apiKey: "test-api-key-fixture", models: [{ id: "test-scoped", name: "Scoped", reasoning: true }] },
  "openai-codex": { models: [{ id: "test-built-in", name: "Built In", reasoning: true }] },
  "test-provider": { models: [{ id: "fast-model", name: "Fast", reasoning: false }] },
  "reallms-dev": { baseUrl: "https://images.test", apiKey: "test-api-key-fixture", models: [] },
} }));
const fixtureSettings = { enabledModels: ["reallms/test-scoped", "openai-codex/test-built-in", "test-provider/fast-model"], imageGenerationProviders: { "reallms-dev": { models: [{ id: "z-image-turbo", name: "z-image-turbo" }] } } };
writeFileSync(resolve(TEST_AGENT, "settings.config.json"), JSON.stringify(fixtureSettings));
writeFileSync(resolve(TEST_AGENT, "settings.json"), JSON.stringify(fixtureSettings));
const EXTENSION_PATH = resolve(TEST_EXTENSIONS, "06-health/index.ts");
const SETTINGS_CONFIG_PATH = resolve(TEST_AGENT, "settings.config.json");
const SETTINGS_PATH = resolve(TEST_AGENT, "settings.json");
const MODELS_PATH = resolve(TEST_AGENT, "models.json");
const ORIGINAL_SETTINGS_CONFIG = readFileSync(SETTINGS_CONFIG_PATH, "utf8");
const ORIGINAL_SETTINGS = readFileSync(SETTINGS_PATH, "utf8");
const CACHE_PATH = resolve(TEST_AGENT, "model-health-cache.json");
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CACHE = (() => {
  try {
    return readFileSync(CACHE_PATH, "utf8");
  } catch {
    return undefined;
  }
})();
const STUB_PACKAGE_DIR = resolve(TEST_EXTENSIONS, "node_modules");
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
    "const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
    "function streamFromMessage(message, timing) {",
    "  const t = timing || {};",
    "  const firstTokenDelayMs = t.firstTokenDelayMs ?? 30;",
    "  const totalDelayMs = t.totalDelayMs ?? 190;",
    "  const events = [{ type: 'start', partial: message }];",
    "  if ((message.content || []).some((c) => c && c.type === 'text')) {",
    "    events.push({ type: 'text_start', contentIndex: 0 }, { type: 'text_delta', contentIndex: 0, delta: 'OK' }, { type: 'text_end', contentIndex: 0, content: 'OK' });",
    "  }",
    "  const stopped = message.stopReason === 'error' || message.stopReason === 'aborted';",
    "  events.push(stopped",
    "    ? { type: 'error', reason: message.stopReason, error: message }",
    "    : { type: 'done', reason: message.stopReason || 'stop', message });",
    "  const startedAt = Date.now();",
    "  let index = 0;",
    "  return {",
    "    [Symbol.asyncIterator]() {",
    "      return {",
    "        async next() {",
    "          if (index >= events.length) return { value: undefined, done: true };",
    "          const event = events[index];",
    "          // Deliver a realistic first-token gap so default samples measure a decode window",
    "          // instead of every probe looking buffered and paying for an escalation.",
    "          const targetMs = index === 0 ? 0 : (index === events.length - 1 ? totalDelayMs : firstTokenDelayMs);",
    "          const remaining = targetMs - (Date.now() - startedAt);",
    "          if (remaining > 0) await wait(remaining);",
    "          index += 1;",
    "          return { value: event, done: false };",
    "        },",
    "      };",
    "    },",
    "    async result() { return message; },",
    "  };",
    "}",
    "export async function completeSimple(model, context, options) {",
    "  if (typeof globalThis.__completeSimpleMock === 'function') return globalThis.__completeSimpleMock(model, context, options);",
    "  return { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] };",
    "}",
    "export async function streamSimple(model, context, options) {",
    "  if (typeof globalThis.__streamSimpleMock === 'function') return globalThis.__streamSimpleMock(model, context, options);",
    "  const message = typeof globalThis.__completeSimpleMock === 'function'",
    "    ? await globalThis.__completeSimpleMock(model, context, options)",
    "    : { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }], usage: { output: 12 } };",
    "  return streamFromMessage(message, globalThis.__probeStreamTiming);",
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

// Restore original settings + cache + fetch before every test so no test can
// pollute another by leaving a mutated SETTINGS_CONFIG_PATH / cache / fetch
// mock behind. The originals are captured once at load; tests that need a
// dirty state set it up themselves and this hook resets it before the next
// test runs.
test.beforeEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  if (ORIGINAL_CACHE === undefined) {
    rmSync(CACHE_PATH, { force: true });
  } else {
    writeFileSync(CACHE_PATH, ORIGINAL_CACHE);
  }
  delete (globalThis as any).__completeSimpleMock;
  delete (globalThis as any).__streamSimpleMock;
  delete (globalThis as any).__probeStreamTiming;
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

test("health probes the same scoped runtime models visible to /scoped-models", async () => {
  const mod = await loadExtension();
  const called: string[] = [];
  (globalThis as any).__completeSimpleMock = async (model: any) => {
    called.push(`${model.provider}/${model.id}`);
    return { stopReason: "stop", content: [{ type: "text", text: "OK" }] };
  };
  const scoped = { provider: "reallms", id: "scoped", name: "Scoped" };
  const results = await mod.checkModelHealth({
    scopedModels: [{ model: scoped }],
    modelRegistry: {
      getAvailable: () => [scoped, { provider: "catalog", id: "outside-scope", name: "Outside" }],
      find: (provider: string, id: string) => ({ provider, id }),
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "test-key" }; },
    },
  }, { forceRefresh: true });
  assert.deepEqual(called, ["reallms/scoped"]);
  assert.equal(results[0]?.source, "user");
});

test("orders healthy user chat models by enabledModels order", async () => {
  const mod = await loadExtension();
  const checkModelHealth = mod.checkModelHealth;
  const authModel = "test-auth/auth-model";
  const userModelIds = ["test-provider/fast-model", "openai-codex/test-built-in", "reallms/test-scoped"];
  const enabledModels = [authModel, ...userModelIds];

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({
    enabledModels,
    imageGenerationProviders: {},
  }, null, 2)}\n`);

  (globalThis as any).__completeSimpleMock = async () => {
    return { stopReason: "stop", content: [{ type: "text", text: "OK" }] };
  };

  const results = await checkModelHealth({
    modelRegistry: {
      find(provider: string, modelId: string) {
        return { provider, id: modelId };
      },
      async getApiKeyAndHeaders(model: any) {
        return { ok: true, apiKey: `key-${model.id}` };
      },
    },
  }, { forceRefresh: true });

  assert.deepEqual(results.map((result: any) => result.id), enabledModels);
  assert.deepEqual(
    results.filter((result: any) => result.source === "user").map((result: any) => result.id),
    userModelIds,
  );

  const table = mod.formatHealthTable(results).join("\n");
  assert.ok(table.indexOf("  auth") < table.indexOf("  user"));
  assert.ok(table.indexOf("test-provider/fast-model") < table.indexOf("openai-codex/test-built-in"));
  assert.ok(table.indexOf("openai-codex/test-built-in") < table.indexOf("reallms/test-scoped"));
});

test("orders cached user chat models by current enabledModels order", async () => {
  const mod = await loadExtension();
  const checkModelHealth = mod.checkModelHealth;
  const initialOrder = ["reallms/test-scoped", "openai-codex/test-built-in", "test-provider/fast-model"];
  const reorderedModels = [...initialOrder].reverse();

  (globalThis as any).__completeSimpleMock = async () => {
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

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({ enabledModels: initialOrder, imageGenerationProviders: {} }, null, 2)}\n`);
  await checkModelHealth(ctx, { forceRefresh: true, cacheTtlMs: 60_000 });
  const staleSourceCache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  staleSourceCache.results = staleSourceCache.results.map((result: any) => ({ ...result, source: "auth" }));
  writeFileSync(CACHE_PATH, JSON.stringify(staleSourceCache));

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({ enabledModels: reorderedModels, imageGenerationProviders: {} }, null, 2)}\n`);
  const cachedResults = await checkModelHealth(ctx, { cacheTtlMs: 60_000 });

  assert.deepEqual(cachedResults.map((result: any) => result.id), reorderedModels);
  assert.ok(cachedResults.every((result: any) => result.source === "user"));
  const table = mod.formatHealthTable(cachedResults).join("\n");
  assert.ok(table.indexOf("test-provider/fast-model") < table.indexOf("openai-codex/test-built-in"));
  assert.ok(table.indexOf("openai-codex/test-built-in") < table.indexOf("reallms/test-scoped"));
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
    `Model health (cached): 2 enabled models queryable. 1 chat model (${chatModel.id}), 1 image generation model (z-image-turbo)`,
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

test("every reasoning model is probed with thinking on at its cheapest thinking level", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  rmSync(CACHE_PATH, { force: true });

  const apis = ["openai-completions", "openai-responses", "openai-codex-responses"];
  for (const api of apis) {
    const seen: Array<{ model: any; options: any }> = [];
    (globalThis as any).__completeSimpleMock = async (model: any, _context: any, options: any) => {
      seen.push({ model, options });
      return { stopReason: "stop", usage: { output: 10 }, content: [{ type: "text", text: "OK" }] };
    };
    try {
      const registered = { provider: "test-provider", id: "fast-model", api, reasoning: true, compat: { supportsReasoningEffort: true } };
      const result = await mod.probeModelHealth("test-provider/fast-model", {
        modelRegistry: {
          find: () => registered,
          async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
        },
      });
      assert.equal(result.status, "ok", api);
      assert.equal(seen.length, 1, `${api}: a supported thinking level must not need a retry`);
      assert.equal(seen[0].model, registered, `${api}: probes use the registered model unchanged`);
      assert.equal(seen[0].options.reasoning, "minimal", `${api}: thinking on at the cheapest level keeps metrics comparable`);
      assert.ok(seen[0].options.maxTokens > 128, `${api}: the sample ceiling has to leave room for thinking tokens`);
    } finally {
      delete (globalThis as any).__completeSimpleMock;
    }
  }
});

test("probes at the cheapest thinking level the model actually declares", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  rmSync(CACHE_PATH, { force: true });

  const seen: Array<{ model: any; options: any }> = [];
  // This mock resolves only when the abort event fires, so keep the event loop open explicitly.
  // Without it Node can exit with the probe still pending ("promise resolution is still pending but
  // the event loop has already resolved"), which cancels every later test in the file.
  const keepAlive = setTimeout(() => {}, 30_000);
  (globalThis as any).__completeSimpleMock = async (model: any, _context: any, options: any) => {
    seen.push({ model, options });
    return { stopReason: "stop", usage: { output: 10 }, content: [{ type: "text", text: "OK" }] };
  };
  try {
    const result = await mod.probeModelHealth("openai-codex/test-built-in", {
      modelRegistry: {
        find: () => ({
          provider: "openai-codex",
          id: "test-built-in",
          api: "openai-codex-responses",
          reasoning: true,
          thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium" },
        }),
        async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
      },
    });
    assert.equal(result.status, "ok");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].options.reasoning, "low", "levels mapped to null are unsupported and skipped");
  } finally {
    delete (globalThis as any).__completeSimpleMock;
  }
});

test("models that could omit reasoning are still probed with thinking on", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  rmSync(CACHE_PATH, { force: true });

  const seen: Array<{ model: any; options: any }> = [];
  // This mock resolves only when the abort event fires, so keep the event loop open explicitly.
  // Without it Node can exit with the probe still pending ("promise resolution is still pending but
  // the event loop has already resolved"), which cancels every later test in the file.
  const keepAlive = setTimeout(() => {}, 30_000);
  (globalThis as any).__completeSimpleMock = async (model: any, _context: any, options: any) => {
    seen.push({ model, options });
    return { stopReason: "stop", usage: { output: 10 }, content: [{ type: "text", text: "OK" }] };
  };
  try {
    const result = await mod.probeModelHealth("openai-codex/test-built-in", {
      modelRegistry: {
        find: () => ({
          provider: "openai-codex",
          id: "test-built-in",
          api: "openai-codex-responses",
          reasoning: true,
          thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high" },
        }),
        async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
      },
    });
    assert.equal(result.status, "ok");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].options.reasoning, "minimal", "routing ETA needs every model measured with thinking on");
  } finally {
    delete (globalThis as any).__completeSimpleMock;
  }
});

test("falls back to the plain model when the endpoint rejects the thinking override", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  rmSync(CACHE_PATH, { force: true });

  const seen: Array<{ model: any; options: any }> = [];
  // This mock resolves only when the abort event fires, so keep the event loop open explicitly.
  // Without it Node can exit with the probe still pending ("promise resolution is still pending but
  // the event loop has already resolved"), which cancels every later test in the file.
  const keepAlive = setTimeout(() => {}, 30_000);
  (globalThis as any).__completeSimpleMock = async (model: any, _context: any, options: any) => {
    seen.push({ model, options });
    if (seen.length === 1) return { stopReason: "error", errorMessage: "This reasoning level isn't available for the selected model in your workspace." };
    return { stopReason: "stop", usage: { output: 10 }, content: [{ type: "text", text: "OK" }] };
  };
  try {
    const registered = { provider: "openai-codex", id: "test-built-in", api: "openai-codex-responses", reasoning: true, thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high" } };
    const result = await mod.probeModelHealth("openai-codex/test-built-in", {
      modelRegistry: {
        find: () => registered,
        async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
      },
    });
    assert.equal(result.status, "ok", "a rejected thinking level must not report the model as unhealthy");
    assert.equal(seen.length, 2);
    assert.equal(seen[0].options.reasoning, "minimal");
    assert.equal(seen[1].options.reasoning, undefined, "fallback probe uses plain options");
    assert.equal(seen[1].model, registered, "fallback probe uses the registered model unchanged");
  } finally {
    delete (globalThis as any).__completeSimpleMock;
  }
});

test("reports the last attempt's failure when thinking and plain probes both fail", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  rmSync(CACHE_PATH, { force: true });

  const seen: Array<{ model: any; options: any }> = [];
  // This mock resolves only when the abort event fires, so keep the event loop open explicitly.
  // Without it Node can exit with the probe still pending ("promise resolution is still pending but
  // the event loop has already resolved"), which cancels every later test in the file.
  const keepAlive = setTimeout(() => {}, 30_000);
  (globalThis as any).__completeSimpleMock = async (model: any, _context: any, options: any) => {
    seen.push({ model, options });
    return { stopReason: "error", errorMessage: `rejected reasoning=${options?.reasoning ?? "default"}` };
  };
  try {
    const result = await mod.probeModelHealth("test-provider/fast-model", {
      modelRegistry: {
        find: () => ({ provider: "test-provider", id: "fast-model", api: "openai-completions", reasoning: true }),
        async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
      },
    });
    assert.equal(result.status, "error");
    assert.equal(seen.length, 2);
    assert.match(result.error || "", /rejected reasoning=default$/, "reports the plain probe failure, not the override failure");
  } finally {
    delete (globalThis as any).__completeSimpleMock;
  }
});

test("one probe deadline covers every attempt for a model", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  rmSync(CACHE_PATH, { force: true });

  const seen: Array<{ model: any; options: any }> = [];
  // This mock resolves only when the abort event fires, so keep the event loop open explicitly.
  // Without it Node can exit with the probe still pending ("promise resolution is still pending but
  // the event loop has already resolved"), which cancels every later test in the file.
  const keepAlive = setTimeout(() => {}, 30_000);
  (globalThis as any).__completeSimpleMock = async (model: any, _context: any, options: any) => {
    seen.push({ model, options });
    if (seen.length === 1) {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) return resolve();
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { stopReason: "aborted", errorMessage: "probe deadline exceeded" };
    }
    throw new Error(`second attempt saw aborted=${options.signal?.aborted}`);
  };
  try {
    const startedAt = Date.now();
    const result = await mod.probeModelHealth("test-provider/fast-model", {
      modelRegistry: {
        find: () => ({ provider: "test-provider", id: "fast-model", api: "openai-completions", reasoning: true }),
        async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
      },
    }, { probeTimeoutMs: 200 });
    const elapsed = Date.now() - startedAt;

    assert.equal(seen.length, 2);
    assert.equal(seen[0].options.signal, seen[1].options.signal, "attempts share one deadline instead of getting a fresh ceiling each");
    assert.ok(elapsed < 5_000, `the configured ceiling bounds the whole model probe (took ${elapsed}ms)`);
    assert.equal(result.status, "error");
    assert.equal(result.error, "second attempt saw aborted=true", "an exhausted deadline is not re-armed for the fallback attempt");
  } finally {
    clearTimeout(keepAlive);
    delete (globalThis as any).__completeSimpleMock;
  }
});

test("non-reasoning models are probed without a thinking override", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  rmSync(CACHE_PATH, { force: true });

  const registered = { provider: "test-provider", id: "fast-model", api: "openai-completions", reasoning: false };
  const seen: Array<{ model: any; options: any }> = [];
  // This mock resolves only when the abort event fires, so keep the event loop open explicitly.
  // Without it Node can exit with the probe still pending ("promise resolution is still pending but
  // the event loop has already resolved"), which cancels every later test in the file.
  const keepAlive = setTimeout(() => {}, 30_000);
  (globalThis as any).__completeSimpleMock = async (model: any, _context: any, options: any) => {
    seen.push({ model, options });
    return { stopReason: "stop", usage: { output: 2 }, content: [{ type: "text", text: "OK" }] };
  };
  try {
    const result = await mod.probeModelHealth("test-provider/fast-model", {
      modelRegistry: {
        find: () => registered,
        async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
      },
    });
    assert.equal(result.status, "ok");
    assert.equal(seen.length, 1, "a model that cannot think has nothing to pin");
    assert.equal(seen[0].model, registered);
    assert.equal(seen[0].options.reasoning, undefined);
  } finally {
    delete (globalThis as any).__completeSimpleMock;
  }
});

test("probe throughput divides by the decode window, not end-to-end latency", async () => {
  const mod = await loadExtension();

  // Four seconds of thinking, then 60 tokens decoded in one second.
  assert.equal(mod.probeTokensPerSecond(60, { firstTokenMs: 4_000, elapsedMs: 5_000 }), 60);
  // A short but genuinely streamed tail: 12 visible tokens in 216ms of a 3.678s round trip.
  assert.ok(Math.abs(mod.probeTokensPerSecond(12, { firstTokenMs: 3_462, elapsedMs: 3_678 })! - 55.6) < 0.5,
    "a thin but genuine 216ms tail is still a decode window (got " + mod.probeTokensPerSecond(12, { firstTokenMs: 3_462, elapsedMs: 3_678 }) + ")");
  // A buffered endpoint delivers everything at once: the window is noise, so fall back to E2E.
  assert.equal(mod.probeTokensPerSecond(20, { firstTokenMs: 990, elapsedMs: 1_000 }), 20);
  // A window under 5% of the round trip is too thin to trust however many ms it is.
  assert.equal(mod.probeTokensPerSecond(10, { firstTokenMs: 3_850, elapsedMs: 4_000 }), 2.5);
  assert.equal(mod.probeTokensPerSecond(20, { elapsedMs: 1_000 }), 20, "no first-token timing falls back to E2E");
  assert.equal(mod.probeTokensPerSecond(0, { firstTokenMs: 100, elapsedMs: 1_000 }), undefined, "no sample, no rate");
  assert.equal(mod.probeTokensPerSecond(5, { elapsedMs: 0 }), undefined, "no time elapsed, no rate");
});

test("records first-token timing and measures a streamed probe over its decode window", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  rmSync(CACHE_PATH, { force: true });

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const seen: Array<{ model: any; options: any }> = [];
  (globalThis as any).__streamSimpleMock = async (model: any, _context: any, options: any) => {
    seen.push({ model, options });
    const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "The sea shimmers." }], usage: { output: 40 } };
    const events = [
      { type: "start", partial: message },
      { type: "thinking_delta", contentIndex: 0, delta: "hm", partial: message },
      { type: "text_delta", contentIndex: 0, delta: "The sea shimmers.", partial: message },
      { type: "done", reason: "stop", message },
    ];
    const scheduleMs = [0, 300, 600, 900];
    const startedAt = Date.now();
    let index = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (index >= events.length) return { value: undefined, done: true };
            const event = events[index]!;
            const waitMs = scheduleMs[index]! - (Date.now() - startedAt);
            if (waitMs > 0) await wait(waitMs);
            index += 1;
            return { value: event, done: false };
          },
        };
      },
      async result() { return message; },
    };
  };
  try {
    const registered = { provider: "test-provider", id: "fast-model", api: "openai-completions", reasoning: true };
    const result = await mod.probeModelHealth("test-provider/fast-model", {
      modelRegistry: {
        find: () => registered,
        async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
      },
    });

    assert.equal(result.status, "ok");
    assert.equal(seen.length, 1, "a streamed probe is still one request");
    assert.ok((result.firstTokenMs ?? 0) >= 200 && (result.firstTokenMs ?? 0) <= 800,
      `first token arrives when thinking starts, not when the answer does (got ${result.firstTokenMs}ms)`);
    assert.ok((result.latencyMs ?? 0) >= 850, `latency stays end to end (got ${result.latencyMs}ms)`);
    assert.ok((result.tokensPerSecond ?? 0) > 50 && (result.tokensPerSecond ?? 0) < 110,
      `throughput divides by the ~600ms decode window, not the ~900ms round trip (got ${result.tokensPerSecond})`);
  } finally {
    delete (globalThis as any).__streamSimpleMock;
  }
});

function scriptedStream(message: any, timing: { firstTokenMs: number; totalMs: number }) {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (message.content || []).filter((c: any) => c && c.type === "text").map((c: any) => c.text).join("");
  const events: any[] = [{ type: "start", partial: message }];
  if (text) {
    events.push({ type: "text_start", contentIndex: 0 }, { type: "text_delta", contentIndex: 0, delta: text, partial: message });
  }
  const stopped = message.stopReason === "error" || message.stopReason === "aborted";
  events.push(stopped
    ? { type: "error", reason: message.stopReason, error: message }
    : { type: "done", reason: message.stopReason || "stop", message });
  const startedAt = Date.now();
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= events.length) return { value: undefined, done: true };
          const event = events[index]!;
          const targetMs = index === 0 ? 0 : (index === events.length - 1 ? timing.totalMs : timing.firstTokenMs);
          const remaining = targetMs - (Date.now() - startedAt);
          if (remaining > 0) await wait(remaining);
          index += 1;
          return { value: event, done: false };
        },
      };
    },
    async result() { return message; },
  };
}

function thinWindowMessage() {
  // A long think followed by ~13 visible tokens: healthy, but the window is 40ms of a 1s call.
  return { message: { stopReason: "stop", content: [{ type: "text", text: "The sea shimmers." }], usage: { output: 13 } }, timing: { firstTokenMs: 960, totalMs: 1000 } };
}

test("classifies probe samples by what they can support", async () => {
  const mod = await loadExtension();

  assert.deepEqual(mod.probeSampleMetrics({ stopReason: "stop", visibleChars: 40, outputTokens: 60, firstTokenMs: 4_000, elapsedMs: 5_000 }),
    { verdict: "measurable", tokensPerSecond: 60, throughputSource: "decode-window" });
  assert.deepEqual(mod.probeSampleMetrics({ stopReason: "stop", visibleChars: 12, outputTokens: 13, firstTokenMs: 960, elapsedMs: 1_000 }),
    { verdict: "unmeasurable-window", tokensPerSecond: 13, throughputSource: "end-to-end" },
    "a thin window keeps its conservative end-to-end rate");
  assert.deepEqual(mod.probeSampleMetrics({ stopReason: "length", visibleChars: 0, outputTokens: 512, firstTokenMs: 10, elapsedMs: 5_120 }),
    { verdict: "truncated", tokensPerSecond: 100, throughputSource: "truncated" },
    "a thinking-only sample is measured end to end, never as decode speed");
  assert.deepEqual(mod.probeSampleMetrics({ stopReason: "error", visibleChars: 0, outputTokens: 0, elapsedMs: 100 }), { verdict: "failed" });
  assert.deepEqual(mod.probeSampleMetrics({ stopReason: "stop", visibleChars: 40, outputTokens: 0, firstTokenMs: 10, elapsedMs: 500 }), { verdict: "no-usage" });
});

test("escalates a model whose standard sample answered but decoded too little to time", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  rmSync(CACHE_PATH, { force: true });

  const thin = thinWindowMessage();
  const prompts: string[] = [];
  let call = 0;
  (globalThis as any).__streamSimpleMock = async (_model: any, context: any, _options: any) => {
    prompts.push(context.messages[0].content as string);
    call += 1;
    if (call === 1) return scriptedStream(thin.message, thin.timing);
    return scriptedStream(
      { stopReason: "stop", content: [{ type: "text", text: "The sea is calm. Waves roll in. Salt hangs in the air." }], usage: { output: 32 } },
      { firstTokenMs: 1_000, totalMs: 1_500 },
    );
  };
  try {
    const result = await mod.probeModelHealth("test-provider/fast-model", {
      modelRegistry: {
        find: () => ({ provider: "test-provider", id: "fast-model", api: "openai-completions", reasoning: true }),
        async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
      },
    });

    assert.equal(result.status, "ok");
    assert.equal(prompts.length, 2, "one escalation request for the model that needs it");
    assert.match(prompts[1]!, /three short sentences/, "the escalation asks for a longer answer, not a different model or level");
    assert.equal(result.throughputSource, "escalated");
    assert.ok((result.tokensPerSecond ?? 0) > 50 && (result.tokensPerSecond ?? 0) < 80,
      `throughput comes from the escalated 500ms window, not 13 tokens over 1s (got ${result.tokensPerSecond})`);
    assert.ok((result.latencyMs ?? 0) < 1_400, `latency stays the standard sample (got ${result.latencyMs}ms)`);
    assert.ok((result.firstTokenMs ?? 0) >= 900 && (result.firstTokenMs ?? 0) < 1_400,
      `first-token timing pairs with the published window (got ${result.firstTokenMs}ms)`);
  } finally {
    delete (globalThis as any).__streamSimpleMock;
  }
});

test("health.probeEscalation false keeps the conservative rate", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  rmSync(CACHE_PATH, { force: true });

  const thin = thinWindowMessage();
  const registry = {
    modelRegistry: {
      find: () => ({ provider: "test-provider", id: "fast-model", api: "openai-completions", reasoning: true }),
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
    },
  };
  const probe = () => mod.probeModelHealth("test-provider/fast-model", registry);
  try {
    let calls = 0;
    (globalThis as any).__streamSimpleMock = async () => {
      calls += 1;
      return scriptedStream(thin.message, thin.timing);
    };
    const disabled = await mod.probeModelHealth("test-provider/fast-model", registry, { probeEscalation: false });

    assert.equal(disabled.status, "ok");
    assert.equal(calls, 1, "the switch must not spend a second request");
    assert.equal(disabled.throughputSource, "end-to-end");
    assert.ok(Math.abs((disabled.tokensPerSecond ?? 0) - 13) < 2, `conservative end-to-end rate (got ${disabled.tokensPerSecond})`);

    // Same model, switch left at its policy default: the escalation runs and lifts the rate.
    rmSync(CACHE_PATH, { force: true });
    calls = 0;
    (globalThis as any).__streamSimpleMock = async () => {
      calls += 1;
      if (calls === 1) return scriptedStream(thin.message, thin.timing);
      return scriptedStream(
        { stopReason: "stop", content: [{ type: "text", text: "The sea is calm. Waves roll in. Salt hangs in the air." }], usage: { output: 32 } },
        { firstTokenMs: 1_000, totalMs: 1_500 },
      );
    };
    const enabled = await probe();
    assert.equal(calls, 2, "policy default still escalates");
    assert.equal(enabled.throughputSource, "escalated");
    assert.ok((enabled.tokensPerSecond ?? 0) > 50, `escalated decode window (got ${enabled.tokensPerSecond})`);
  } finally {
    delete (globalThis as any).__streamSimpleMock;
  }
});

test("does not escalate a thinking-only sample and reports it as truncated", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  rmSync(CACHE_PATH, { force: true });

  const prompts: string[] = [];
  (globalThis as any).__streamSimpleMock = async (_model: any, context: any, _options: any) => {
    prompts.push(context.messages[0].content as string);
    // The output ceiling eaten by thinking: 512 tokens, no answer. A longer prompt would only buy
    // more thinking, so this verdict must not escalate.
    return scriptedStream({ stopReason: "length", content: [], usage: { output: 512 } }, { firstTokenMs: 100, totalMs: 1_000 });
  };
  try {
    const result = await mod.probeModelHealth("test-provider/fast-model", {
      modelRegistry: {
        find: () => ({ provider: "test-provider", id: "fast-model", api: "openai-completions", reasoning: true }),
        async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
      },
    });

    assert.equal(result.status, "ok", "the endpoint is reachable, so health is not in question");
    assert.equal(prompts.length, 1, "escalating a truncated sample spends quota on more thinking");
    assert.equal(result.throughputSource, "truncated");
    assert.ok((result.tokensPerSecond ?? 0) > 400 && (result.tokensPerSecond ?? 0) < 650,
      `512 generated tokens over the whole round trip (got ${result.tokensPerSecond})`);
  } finally {
    delete (globalThis as any).__streamSimpleMock;
  }
});

test("keeps the standard numbers when the escalation request fails", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  rmSync(CACHE_PATH, { force: true });

  const thin = thinWindowMessage();
  let call = 0;
  (globalThis as any).__streamSimpleMock = async () => {
    call += 1;
    if (call === 1) return scriptedStream(thin.message, thin.timing);
    throw new Error("deadline shared with the model probe expired");
  };
  try {
    const result = await mod.probeModelHealth("test-provider/fast-model", {
      modelRegistry: {
        find: () => ({ provider: "test-provider", id: "fast-model", api: "openai-completions", reasoning: true }),
        async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
      },
    });
    assert.equal(result.status, "ok", "a failed bonus probe cannot make a healthy model unhealthy");
    assert.equal(result.throughputSource, "end-to-end");
    assert.ok(Math.abs((result.tokensPerSecond ?? 0) - 13) < 2);
  } finally {
    delete (globalThis as any).__streamSimpleMock;
  }
});

test("keeps the standard numbers when the escalation cannot measure either", async () => {
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  writeFileSync(SETTINGS_PATH, ORIGINAL_SETTINGS);
  const mod = await loadExtension();
  rmSync(CACHE_PATH, { force: true });

  const thin = thinWindowMessage();
  let call = 0;
  (globalThis as any).__streamSimpleMock = async () => {
    call += 1;
    if (call === 1) return scriptedStream(thin.message, thin.timing);
    return scriptedStream(
      { stopReason: "stop", content: [{ type: "text", text: "The sea is calm. Waves roll in. Salt hangs." }], usage: { output: 24 } },
      { firstTokenMs: 1_490, totalMs: 1_500 },
    );
  };
  try {
    const result = await mod.probeModelHealth("test-provider/fast-model", {
      modelRegistry: {
        find: () => ({ provider: "test-provider", id: "fast-model", api: "openai-completions", reasoning: true }),
        async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture-key" }; },
      },
    });

    assert.equal(result.status, "ok");
    assert.equal(call, 2);
    assert.equal(result.throughputSource, "end-to-end", "an escalation that fails to measure leaves the conservative rate alone");
    assert.ok(Math.abs((result.tokensPerSecond ?? 0) - 13) < 2, `the standard sample's rate stands (got ${result.tokensPerSecond})`);
    assert.ok((result.latencyMs ?? 0) < 1_400);
  } finally {
    delete (globalThis as any).__streamSimpleMock;
  }
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
  assert.match(table, /p\/a\s+4\.2\s+1\.93s/);
  assert.match(table, /p\/b\s+—\s+0\.50s/);
  assert.match(table, /1 image generation model \(img\)/);
  assert.match(table, /Unavailable: p\/bad \(offline\)/);
});

test("formatHealthTable always renders registered provider/model identities for chat", async () => {
  const mod = await loadExtension();
  const table = mod.formatHealthTable([
    { id: "test-provider/mapped", status: "ok", name: "Synthetic Lab: Mapped", service: "chat" },
    { id: "test-provider/team/unmapped", status: "ok", name: "team/unmapped", service: "chat" },
    { id: "other-provider/plain", status: "ok", service: "chat" },
  ]).join("\n");

  assert.match(table, /test-provider\/mapped/);
  assert.match(table, /test-provider\/team\/unmapped/);
  assert.match(table, /other-provider\/plain/);
  assert.doesNotMatch(table, /Synthetic Lab: Mapped/);
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
  assert.match(table, /p\/a/);
  assert.doesNotMatch(table, /Alpha/);
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
  assert.match(notifications[0]!, /p\/a/);
  assert.doesNotMatch(notifications[0]!, /Alpha/);
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
  assert.match(rendered, /p\/a/);
  assert.doesNotMatch(rendered, /Alpha/);
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
  rmSync(TEST_ROOT, { recursive: true, force: true });
});
