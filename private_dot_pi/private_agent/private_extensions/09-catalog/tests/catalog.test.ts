import assert from "node:assert/strict";
import test from "node:test";
import { loadOllamaCloudCatalog, parseAuthoritativeCatalog } from "../cost-sources.ts";
import { deriveReviewedThinkingLevelMap, discoverProvider, persistReviewedReasoning, providerModels, publishCatalog, refreshCatalog, restoreCatalog } from "../catalog.ts";
import { loadCatalogSettings, loadProviderSettings } from "../provider-settings.ts";
import { renderCatalogOverview, renderCatalogSync } from "../render.ts";
import { loadCatalogState, validateCatalogState } from "../state.ts";
import type { CatalogModel, CatalogState, NativeModelObservation } from "../types.ts";

const provider = { id: "test-provider", baseUrl: "https://catalog.test", api: "openai-completions" };
const emptySource = Promise.resolve(parseAuthoritativeCatalog({ data: [] }));

function catalogState(cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
  return {
    version: 1 as const,
    updatedAt: 1,
    providers: [{ ...provider, models: [{
      id: "enabled", name: "Enabled", canonicalId: "test-provider/enabled", reasoning: false,
      input: ["text"] as ("text" | "image")[], contextWindow: 128, maxTokens: 16, available: true, active: true,
      ...(cost ? { cost, costProvenance: "provider:/models" } : { costProvenance: "unknown" }),
    }] }],
  };
}

const knownCost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
function overviewModel(id: string, active = true, cost: typeof knownCost | null = knownCost): CatalogModel {
  return { id, name: id, canonicalId: `test-provider/${id}`, input: ["text"], available: true, active, ...(cost ? { cost } : {}) };
}
function overviewNative(id: string, cost: typeof knownCost | null = knownCost): NativeModelObservation {
  return { id, name: id, canonicalId: id, input: ["text"], observedAt: 1, available: true, active: true, ...(cost ? { cost } : {}) };
}
function overviewState(models: CatalogModel[], nativeModels: NativeModelObservation[] = []): CatalogState {
  return { version: 2, updatedAt: 1, providers: [{ ...provider, models }], nativeModels };
}

test("catalog overview is info when registrations and active costs are healthy", () => {
  const result = renderCatalogOverview(
    overviewState([overviewModel("alpha")], [overviewNative("native/alpha")]),
    ["test-provider/alpha"],
    ["test-provider/alpha"],
  );
  assert.equal(result.level, "info");
  assert.match(result.text, /^Catalog: 2 available models \(2 scoped\) across 1 provider; 0 costs unknown;/);
  assert.match(result.text, /all enabled catalog-managed custom models are registered and all active costs are known\.$/);
});

test("catalog overview warns about missing registrations in sorted order", () => {
  const result = renderCatalogOverview(
    overviewState([overviewModel("alpha")]),
    ["test-provider/zeta", "test-provider/alpha"],
    [],
  );
  assert.equal(result.level, "warning");
  assert.match(result.text, /missing registrations: test-provider\/alpha, test-provider\/zeta/);
});

test("catalog overview warns about sorted unknown active custom and native costs", () => {
  const result = renderCatalogOverview(
    overviewState([overviewModel("zeta", true, null)], [overviewNative("native/alpha", null)]),
    ["test-provider/zeta"],
    ["test-provider/zeta"],
  );
  assert.equal(result.level, "warning");
  assert.match(result.text, /unknown active costs: native\/alpha, test-provider\/zeta\.$/);
});

test("inactive unknown cost affects inventory summary but not catalog health", () => {
  const result = renderCatalogOverview(
    overviewState([overviewModel("active"), overviewModel("inactive", false, null)]),
    ["test-provider/active"],
    ["test-provider/active"],
  );
  assert.equal(result.level, "info");
  assert.match(result.text, /^Catalog: 2 available models \(1 scoped\) across 1 provider; 1 costs unknown;/);
  assert.match(result.text, /all enabled catalog-managed custom models are registered and all active costs are known\.$/);
});

test("catalog overview warns when no validated state is available", () => {
  const result = renderCatalogOverview(null, ["test-provider/alpha"], ["test-provider/alpha"]);
  assert.equal(result.level, "warning");
  assert.match(result.text, /Run \/catalog refresh or \/catalog sync\./);
});

const emptySyncReport: any = { models: [], unresolvedCosts: [], missingAa: [] };

test("catalog sync renders exact grouped AA commands with POSIX quoting and deterministic order", () => {
  const rendered = renderCatalogSync(emptySyncReport, { changes: [
    { kind: "M", path: "manifest.json", targetPath: "/synthetic root/manifest.json" },
    { kind: "M", path: "/reviewed config/canonical-mappings.json", targetPath: "/reviewed config/canonical-mappings.json" },
    { kind: "A", path: "models/new'copy.json", targetPath: "/synthetic root/models/new'copy.json" },
    { kind: "D", path: "models/old snapshot.json", targetPath: "/synthetic root/models/old snapshot.json" },
  ], warnings: ["snapshot cleanup was incomplete after successful publication"] });
  assert.match(rendered, /AA artifact changes to track:\n  M manifest\.json\n  M \/reviewed config\/canonical-mappings\.json\n  A models\/new'copy\.json\n  D models\/old snapshot\.json\n  ! snapshot cleanup was incomplete after successful publication/);
  const commandBlock = [
    "chezmoi add -- \\",
    "  '/synthetic root/manifest.json' \\",
    "  '/reviewed config/canonical-mappings.json' \\",
    "  '/synthetic root/models/new'\"'\"'copy.json'",
    "",
    "chezmoi forget -- \\",
    "  '/synthetic root/models/old snapshot.json'",
    "",
    "rm -f -- \\",
    "  '/synthetic root/models/old snapshot.json'",
    "",
    "Review with: chezmoi status",
  ].join("\n");
  assert.equal(rendered.includes(commandBlock), true);
});

test("catalog sync omits grouped commands whose artifact category is empty", () => {
  const additionsOnly = renderCatalogSync(emptySyncReport, { changes: [{ kind: "A", path: "models/new.json", targetPath: "/synthetic/models/new.json" }], warnings: [] });
  assert.match(additionsOnly, /chezmoi add --/); assert.doesNotMatch(additionsOnly, /chezmoi forget --|rm -f --/);
  const deletionsOnly = renderCatalogSync(emptySyncReport, { changes: [{ kind: "D", path: "models/old.json", targetPath: "/synthetic/models/old.json" }], warnings: [] });
  assert.doesNotMatch(deletionsOnly, /chezmoi add --/); assert.match(deletionsOnly, /chezmoi forget --[\s\S]*rm -f --/);
  assert.match(deletionsOnly, /rm -f -- \\\n  '\/synthetic\/models\/old\.json'\n\nReview with: chezmoi status/);
});

test("catalog sync reports warnings without commands when there are no captured changes", () => {
  assert.doesNotMatch(renderCatalogSync(emptySyncReport), /AA artifact changes to track|chezmoi status|chezmoi add|chezmoi forget|rm -f/);
  const warningsOnly = renderCatalogSync(emptySyncReport, { changes: [], warnings: ["AA artifact state capture was unavailable"] });
  assert.match(warningsOnly, /AA artifact tracking warnings:\n  ! AA artifact state capture was unavailable/);
  assert.doesNotMatch(warningsOnly, /AA artifact changes to track|chezmoi status|chezmoi add|chezmoi forget|rm -f/);
});

test("catalog sync suppresses all exact commands when any target path is unsafe", () => {
  const rendered = renderCatalogSync(emptySyncReport, { changes: [
    { kind: "M", path: "manifest.json", targetPath: "/synthetic/manifest.json" },
    { kind: "M", path: "[unsafe path omitted]", targetPath: "/synthetic/bad\npath.json" },
  ], warnings: [] });
  assert.match(rendered, /Exact artifact commands omitted because a target path is unsafe or non-absolute\./);
  assert.doesNotMatch(rendered, /chezmoi add --|chezmoi forget --|rm -f --|bad\npath/);
  assert.match(rendered, /Review with: chezmoi status/);

  const nonabsolute = renderCatalogSync(emptySyncReport, { changes: [{ kind: "A", path: "models/new.json", targetPath: "relative/models/new.json" }], warnings: [] });
  assert.match(nonabsolute, /Exact artifact commands omitted because a target path is unsafe or non-absolute\./);
  assert.doesNotMatch(nonabsolute, /chezmoi add --|relative\/models\/new\.json/);
});

test("catalog publishes the full discovered chat inventory while retaining exact scope flags", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { id: "enabled", name: "Enabled", input: ["text"], pricing: { prompt: 1, completion: 2 }, context_length: 128, max_tokens: 16 },
    { id: "disabled", input: ["text"], context_length: 128, max_tokens: 16 },
    { id: "embedding", type: "embedding", input: ["text"] },
    { id: "embeddinggemma-300m", input: ["text"] },
    { id: "bge-large-en-v1.5", input: ["text"] },
    { id: "Qwen3-ASR-1.7B", input: ["text"] },
    { id: "z-image-turbo", input: ["text"] },
  ] }));
  try {
    const discovered = await discoverProvider(provider, new Set(["test-provider/enabled"]), undefined, emptySource);
    assert.deepEqual(discovered.models.map((model) => [model.id, model.available, model.active]), [["disabled", true, false], ["enabled", true, true]]);
    assert.deepEqual(providerModels(discovered).map((model) => model.id), ["disabled", "enabled"]);
    assert.deepEqual(providerModels({ ...discovered, models: discovered.models.map((model) => ({ ...model, available: false })) }).map((model) => model.id), ["enabled"]);
  } finally { globalThis.fetch = previous; }
});

test("enabled models omitted from /models are recovered without per-model configuration", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).includes("/model/info?")
    ? new Response(JSON.stringify({ model_info: {
      display_name: "Configured", supports_reasoning: true, input_modalities: ["text", "image"],
      context_window: 42, max_output_tokens: 7,
    } }))
    : new Response(JSON.stringify({ data: [{ id: "other" }] }));
  try {
    const discovered = await discoverProvider(provider, new Set(["test-provider/configured"]), undefined, Promise.resolve(null));
    assert.deepEqual(providerModels(discovered).map((model) => model.id), ["configured", "other"]);
    assert.deepEqual(discovered.models.find((model) => model.id === "configured"), {
      id: "configured", name: "Configured", canonicalId: "test-provider/configured", reasoning: true,
      input: ["text", "image"], contextWindow: 42, maxTokens: 7,
      costProvenance: "unknown", available: true, active: true,
    });
  } finally { globalThis.fetch = previous; }
});

test("catalog enriches missing pricing and limits from the authoritative exact-ID source", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "private-name", openrouter_id: "vendor/known-model", input: ["text"] }] }));
  const source = Promise.resolve(parseAuthoritativeCatalog({ data: [{
    id: "vendor/known-model", name: "Reviewed model", context_length: 321,
    top_provider: { max_completion_tokens: 45 }, architecture: { input_modalities: ["text", "image"] },
    pricing: { prompt: "0.000002", completion: "0.000006", input_cache_read: "0.0000002" },
  }] }));
  try {
    const discovered = await discoverProvider(provider, new Set(["test-provider/private-name"]), undefined, source);
    assert.deepEqual(discovered.models[0], {
      id: "private-name", name: "Reviewed model", canonicalId: "vendor/known-model",
      input: ["text"], contextWindow: 321, maxTokens: 45,
      cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
      costProvenance: "authoritative:openrouter:/api/v1/models", available: true, active: true,
    });
  } finally { globalThis.fetch = previous; }
});

test("catalog persists and registers provider-supplied thinking maps", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "enabled", reasoning: true, thinking_level_map: { off: null, high: "deep" } }] }));
  const registrations: any[] = [];
  try {
    const discovered = await discoverProvider(provider, new Set(["test-provider/enabled"]), undefined, Promise.resolve(null));
    assert.deepEqual(discovered.models[0]?.thinkingLevelMap, { off: null, high: "deep" });
    publishCatalog({ registerProvider: (_id: string, config: unknown) => registrations.push(config) } as any, { version: 2, updatedAt: 1, providers: [discovered], nativeModels: [] });
    assert.deepEqual(registrations[0]?.models[0]?.thinkingLevelMap, { off: null, high: "deep" });
  } finally { globalThis.fetch = previous; }
});

test("nested LiteLLM reasoning efforts derive and register the complete Pi thinking map", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "effort-model", model_info: { supports_reasoning: true, supported_reasoning_efforts: ["low", "medium", "xhigh"] } }] }));
  const registrations: any[] = [];
  try {
    const discovered = await discoverProvider(provider, new Set(), undefined, Promise.resolve(null));
    const expected = { off: null, minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: "xhigh" };
    assert.equal(discovered.models[0]?.reasoning, true);
    assert.deepEqual(discovered.models[0]?.thinkingLevelMap, expected);
    assert.equal(discovered.models[0]?.thinkingLevelMapProvenance, "provider");
    publishCatalog({ registerProvider: (_id: string, config: unknown) => registrations.push(config) } as any, { version: 2, updatedAt: 1, providers: [discovered], nativeModels: [] });
    assert.deepEqual(registrations[0]?.models[0]?.thinkingLevelMap, expected);
    assert.equal(registrations[0]?.models[0]?.reasoning, true);
  } finally { globalThis.fetch = previous; }
});

test("LiteLLM per-effort flags derive a conservative Pi thinking map", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "flag-model", model_info: { supports_reasoning: true, supports_low_reasoning_effort: true, supports_xhigh_reasoning_effort: true } }] }));
  try {
    const discovered = await discoverProvider(provider, new Set(), undefined, Promise.resolve(null));
    assert.deepEqual(discovered.models[0]?.thinkingLevelMap, { off: null, minimal: "low", low: "low", medium: "xhigh", high: "xhigh", xhigh: "xhigh", max: "xhigh" });
    assert.equal(discovered.models[0]?.thinkingLevelMapProvenance, "provider-inferred");
    assert.equal(discovered.models[0]?.reasoning, true);
  } finally { globalThis.fetch = previous; }
});

test("explicit Pi thinking maps take precedence over LiteLLM reasoning effort lists and flags", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "precedence-model", supportedReasoningEfforts: ["none", "low", "max"], supports_xhigh_reasoning_effort: true, model_info: { thinking_level_map: { off: "disabled", high: "deep" } } }] }));
  try {
    const discovered = await discoverProvider(provider, new Set(), undefined, Promise.resolve(null));
    assert.deepEqual(discovered.models[0]?.thinkingLevelMap, { off: "disabled", high: "deep" });
    assert.equal(discovered.models[0]?.thinkingLevelMapProvenance, "provider");
    assert.equal(discovered.models[0]?.reasoning, true);
  } finally { globalThis.fetch = previous; }
});

test("malformed and unknown LiteLLM reasoning effort lists are ignored", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { id: "malformed-model", supported_reasoning_efforts: ["low", "low"] },
    { id: "unknown-model", supportedReasoningEfforts: ["low", "turbo"] },
  ] }));
  try {
    const discovered = await discoverProvider(provider, new Set(), undefined, Promise.resolve(null));
    for (const model of discovered.models) {
      assert.equal(model.thinkingLevelMap, undefined);
      assert.equal(model.reasoning, undefined);
    }
  } finally { globalThis.fetch = previous; }
});

test("catalog enriches selected models from provider /model/info", async () => {
  const previous = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("/model/info?")) return new Response(JSON.stringify({ model_info: {
      display_name: "Provider Detail", supports_reasoning: true, input_modalities: ["text", "image"],
      context_window: 262144, max_output_tokens: 32768,
      input_cost_per_token: 0.000001, output_cost_per_token: 0.000002,
    } }));
    return new Response(JSON.stringify({ data: [{ id: "enabled" }, { id: "disabled" }] }));
  };
  try {
    const discovered = await discoverProvider(provider, new Set(["test-provider/enabled"]), undefined, Promise.resolve(null));
    assert.equal(seen.filter((url) => url.includes("/model/info?")).length, 1, "only selected models need detailed metadata");
    assert.deepEqual(discovered.models.find((model) => model.id === "enabled"), {
      id: "enabled", name: "Provider Detail", canonicalId: "test-provider/enabled", reasoning: true,
      input: ["text", "image"], contextWindow: 262144, maxTokens: 32768,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      costProvenance: "provider:/model/info", available: true, active: true,
    });
  } finally { globalThis.fetch = previous; }
});

test("a failed authoritative fallback retains explicit unknown pricing and Pi's zero schema placeholder", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "unknown", input: ["text"], context_length: 12, max_tokens: 4 }] }));
  try {
    const discovered = await discoverProvider(provider, new Set(["test-provider/unknown"]), undefined, Promise.reject(new Error("offline fallback")));
    assert.equal(discovered.models[0]?.cost, undefined);
    assert.equal(discovered.models[0]?.costProvenance, "unknown");
    assert.deepEqual(providerModels(discovered)[0]?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  } finally { globalThis.fetch = previous; }
});

test("environment credential values are used only for the discovery request and never catalog state or registration", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.CATALOG_TEST_KEY;
  process.env.CATALOG_TEST_KEY = "resolved-test-secret";
  let authorization = "";
  globalThis.fetch = async (_url, init) => {
    authorization = new Headers(init?.headers).get("authorization") || "";
    return new Response(JSON.stringify({ data: [{ id: "enabled", input: ["text"], context_length: 1, max_tokens: 1 }] }));
  };
  const registered: unknown[] = [];
  try {
    const discovered = await discoverProvider({ ...provider, apiKey: "$CATALOG_TEST_KEY" }, new Set(["test-provider/enabled"]), undefined, Promise.resolve(null));
    const state = { version: 1 as const, updatedAt: 1, providers: [discovered] };
    publishCatalog({ registerProvider: (_id: string, config: unknown) => registered.push(config) } as any, state, [{ ...provider, apiKey: "$CATALOG_TEST_KEY" }]);
    assert.equal(authorization, "Bearer resolved-test-secret");
    assert.doesNotMatch(JSON.stringify(state), /resolved-test-secret/);
    assert.doesNotMatch(JSON.stringify(registered), /resolved-test-secret/);
    assert.match(JSON.stringify(registered), /\$CATALOG_TEST_KEY/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.CATALOG_TEST_KEY; else process.env.CATALOG_TEST_KEY = previousKey;
  }
});

test("catalog settings accept bounded refresh and request timeouts", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "pi-catalog-settings-"));
  try {
    const path = join(root, "settings.json");
    await writeFile(path, JSON.stringify({ catalog: { refreshTtlMs: 2000, requestTimeoutMs: 3000 } }));
    assert.deepEqual(await loadCatalogSettings(path), { refreshTtlMs: 2000, requestTimeoutMs: 3000 });
    await writeFile(path, JSON.stringify({ catalog: { refreshTtlMs: -1, requestTimeoutMs: "bad" } }));
    assert.deepEqual(await loadCatalogSettings(path), { refreshTtlMs: 14_400_000, requestTimeoutMs: 10_000 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("literal provider credentials remain provider configuration but are never catalog state", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "pi-catalog-"));
  try {
    const path = join(root, "models.json");
    await writeFile(path, JSON.stringify({ providers: {
      literal: { baseUrl: "https://literal.test", api: "openai-completions", apiKey: "leaked-secret" },
      reference: { baseUrl: "https://reference.test", api: "openai-completions", apiKey: "$SAFE_KEY" },
    } }));
    assert.deepEqual(await loadProviderSettings(path), [
      { id: "literal", baseUrl: "https://literal.test", api: "openai-completions", apiKey: "leaked-secret" },
      { id: "reference", baseUrl: "https://reference.test", api: "openai-completions", apiKey: "$SAFE_KEY" },
    ]);
    assert.doesNotMatch(JSON.stringify(catalogState()), /leaked-secret/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refresh publishes and saves only a complete successful catalog; restore republishes last known good state", async () => {
  const previous = globalThis.fetch;
  const registrations: unknown[] = [];
  const saved: unknown[] = [];
  const fakePi = { registerProvider: (_id: string, config: unknown) => registrations.push(config) } as any;
  const dependencies = {
    loadProviderSettings: async () => [provider],
    loadEnabledModels: async () => new Set(["test-provider/enabled"]),
    loadAuthoritativeCatalog: async () => parseAuthoritativeCatalog({ data: [] }),
    loadCatalogState: async () => null,
    saveCatalogState: async (state: unknown) => { saved.push(state); },
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "enabled", input: ["text"], context_length: 1, max_tokens: 1 }] }));
  try {
    const refreshed = await refreshCatalog(fakePi, undefined, dependencies);
    assert.equal(saved[0], refreshed);
    assert.equal(registrations.length, 1);
    assert.doesNotMatch(JSON.stringify(saved), /secret/i);

    registrations.length = 0;
    const restored = await restoreCatalog(fakePi, {
      loadCatalogState: async () => catalogState(),
      loadProviderSettings: async () => [{ ...provider, apiKey: "$CATALOG_TEST_KEY" }],
      loadEnabledModels: async () => new Set(["test-provider/enabled"]),
    });
    assert.deepEqual(restored, catalogState());
    assert.equal(registrations.length, 1);
    assert.match(JSON.stringify(registrations), /\$CATALOG_TEST_KEY/);
  } finally { globalThis.fetch = previous; }
});

test("refresh retains reviewed maps over inferred flags but accepts explicit maps and effort lists", async () => {
  const reviewed = { off: null, minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: "xhigh" };
  const priorModel = (id: string) => ({
    ...catalogState().providers[0].models[0], id, canonicalId: `test-provider/${id}`, reasoning: true,
    thinkingLevelMap: reviewed, thinkingLevelMapProvenance: "reviewed" as const,
  });
  const previousState: any = { version: 2, updatedAt: 1, providers: [{ ...provider, models: [priorModel("inferred"), priorModel("explicit-map"), priorModel("effort-list")] }], nativeModels: [] };
  let saved: any;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { id: "inferred", supports_reasoning: true, supports_low_reasoning_effort: true, supports_xhigh_reasoning_effort: true },
    { id: "explicit-map", reasoning: true, thinking_level_map: { off: "explicit-off", high: "explicit-high" } },
    { id: "effort-list", supports_reasoning: true, supported_reasoning_efforts: ["none", "low", "max"] },
  ] }));
  try {
    const refreshed = await refreshCatalog({ registerProvider: () => {} } as any, undefined, {
      loadProviderSettings: async () => [provider], loadEnabledModels: async () => new Set(),
      loadCatalogSettings: async () => ({ refreshTtlMs: 1, requestTimeoutMs: 1 }),
      loadAuthoritativeCatalog: async () => parseAuthoritativeCatalog({ data: [] }),
      loadCatalogState: async () => previousState, loadReviewedCosts: async () => new Map(),
      saveCatalogState: async (state: any) => { saved = state; },
    });
    assert.equal(saved, refreshed);
    const models = new Map(refreshed.providers[0]!.models.map((model) => [model.id, model]));
    assert.deepEqual(models.get("inferred")?.thinkingLevelMap, reviewed);
    assert.equal(models.get("inferred")?.thinkingLevelMapProvenance, "reviewed");
    assert.equal(models.get("inferred")?.reasoning, true);
    assert.deepEqual(models.get("explicit-map")?.thinkingLevelMap, { off: "explicit-off", high: "explicit-high" });
    assert.equal(models.get("explicit-map")?.thinkingLevelMapProvenance, "provider");
    assert.deepEqual(models.get("effort-list")?.thinkingLevelMap, { off: "none", minimal: "low", low: "low", medium: "max", high: "max", xhigh: "max", max: "max" });
    assert.equal(models.get("effort-list")?.thinkingLevelMapProvenance, "provider");
  } finally { globalThis.fetch = previousFetch; }
});

test("failed refresh does not publish or save over the last known good catalog", async () => {
  const previous = globalThis.fetch;
  const registrations: unknown[] = [];
  const saved = [catalogState()];
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  try {
    await assert.rejects(refreshCatalog({ registerProvider: (_id: string, config: unknown) => registrations.push(config) } as any, undefined, {
      loadProviderSettings: async () => [provider],
      loadEnabledModels: async () => new Set(["test-provider/enabled"]),
      loadAuthoritativeCatalog: async () => parseAuthoritativeCatalog({ data: [] }),
      loadCatalogState: async () => null,
      saveCatalogState: async (state: any) => { saved.push(state); },
    }), /test-provider \/models returned 503/);
    assert.equal(registrations.length, 0);
    assert.deepEqual(saved, [catalogState()]);
  } finally { globalThis.fetch = previous; }
});

test("legacy state refreshes inventory availability without publishing inactive history", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "pi-catalog-state-"));
  try {
    const legacy: any = catalogState();
    delete legacy.providers[0].models[0].available;
    legacy.providers[0].models.push({ ...legacy.providers[0].models[0], id: "historical", canonicalId: "test-provider/historical", active: false });
    const path = join(root, "catalog-state.json");
    await writeFile(path, JSON.stringify(legacy));
    const migrated = await loadCatalogState(path);
    assert.equal(migrated?.updatedAt, 0);
    assert.deepEqual(migrated?.providers[0]?.models.map((model) => [model.id, model.available]), [["enabled", true], ["historical", false]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("complete reviewed variants replace incomplete inferred reasoning maps", async () => {
  let saved: any;
  const current: any = { version: 2, updatedAt: 1, providers: [{ ...provider, compat: { supportsReasoningEffort: true }, models: [{
    ...catalogState().providers[0].models[0], reasoning: true,
    thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "xhigh", high: "xhigh", xhigh: "xhigh", max: "xhigh" },
    thinkingLevelMapProvenance: "provider-inferred",
  }] }], nativeModels: [] };
  assert.equal(await persistReviewedReasoning("test-provider/enabled", ["off", "low", "medium", "xhigh"], {
    loadProviderSettings: async () => [{ ...provider, compat: { supportsReasoningEffort: true } }], loadCatalogState: async () => current, saveCatalogState: async (state: any) => { saved = state; },
  }), true);
  assert.deepEqual(saved.providers[0].models[0].thinkingLevelMap, { off: null, minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: "xhigh" });
  assert.equal(saved.providers[0].models[0].thinkingLevelMapProvenance, "reviewed");
  assert.deepEqual(deriveReviewedThinkingLevelMap(["off", "low", "medium", "xhigh"]), { off: null, minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: "xhigh" });
  assert.equal(deriveReviewedThinkingLevelMap(["off"]), undefined);
  assert.equal(await persistReviewedReasoning("test-provider/enabled", ["high", null], {
    loadProviderSettings: async () => [{ ...provider, compat: { supportsReasoningEffort: true } }], loadCatalogState: async () => current, saveCatalogState: async () => { throw new Error("must not save"); },
  }), false);
});

test("provider thinking maps win over reviewed derivation", async () => {
  let saved: any;
  const current: any = { version: 2, updatedAt: 1, providers: [{ ...provider, compat: { supportsReasoningEffort: true }, models: [{ ...catalogState().providers[0].models[0], thinkingLevelMap: { high: "provider-high" }, thinkingLevelMapProvenance: "provider" }] }], nativeModels: [] };
  assert.equal(await persistReviewedReasoning("test-provider/enabled", ["low", "medium", "xhigh"], {
    loadProviderSettings: async () => [{ ...provider, compat: { supportsReasoningEffort: true } }], loadCatalogState: async () => current, saveCatalogState: async (state: any) => { saved = state; },
  }), true);
  assert.equal(saved.providers[0].models[0].reasoning, true);
  assert.deepEqual(saved.providers[0].models[0].thinkingLevelMap, { high: "provider-high" });
  assert.equal(saved.providers[0].models[0].thinkingLevelMapProvenance, "provider");
});

test("legacy provider thinking maps still win over reviewed derivation", async () => {
  let saves = 0;
  const current: any = { version: 2, updatedAt: 1, providers: [{ ...provider, compat: { supportsReasoningEffort: true }, models: [{ ...catalogState().providers[0].models[0], reasoning: true, thinkingLevelMap: { high: "legacy-high" } }] }], nativeModels: [] };
  assert.equal(await persistReviewedReasoning("test-provider/enabled", ["low", "medium", "xhigh"], {
    loadProviderSettings: async () => [{ ...provider, compat: { supportsReasoningEffort: true } }], loadCatalogState: async () => current, saveCatalogState: async () => { saves++; },
  }), true);
  assert.equal(saves, 0);
  assert.deepEqual(current.providers[0].models[0].thinkingLevelMap, { high: "legacy-high" });
  assert.equal(current.providers[0].models[0].thinkingLevelMapProvenance, undefined);
});

test("Ollama Cloud accepts bounded clearly-keyed numeric prices but rejects 0/0", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ models: [
    { name: "priced-string", pricing: { input_cost_per_token: "0.000001", output_cost_per_token: "0.000002" } },
    { name: "priced", pricing: { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 } },
    { name: "zero", pricing: { input_per_million: "0", output_per_million: "0" } },
  ] }));
  try {
    const catalog = await loadOllamaCloudCatalog();
    assert.deepEqual(catalog.models.get("priced-string")?.cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(catalog.models.get("priced")?.cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
    assert.equal(catalog.models.get("zero")?.cost, undefined);
  } finally { globalThis.fetch = previous; }
});

test("catalog state schema retains only verified native effort capability", () => {
  const native = { id: "login/model", canonicalId: "canonical/model", name: "Model", reasoning: true, supportsReasoningEffort: false, input: ["text"], observedAt: 1, active: true };
  assert.equal(validateCatalogState({ version: 2, updatedAt: 1, providers: [], nativeModels: [native] }), true);
  assert.equal(validateCatalogState({ version: 2, updatedAt: 1, providers: [], nativeModels: [{ ...native, thinkingLevelMap: { low: "low" }, thinkingLevelMapProvenance: "provider-inferred" }] }), true);
  assert.equal(validateCatalogState({ version: 2, updatedAt: 1, providers: [], nativeModels: [{ ...native, supportsReasoningEffort: "false" }] }), false);
  assert.equal(validateCatalogState({ version: 2, updatedAt: 1, providers: [], nativeModels: [{ ...native, thinkingLevelMapProvenance: "inferred" }] }), false);
});

test("catalog state schema rejects secrets and malformed inactive records", () => {
  assert.equal(validateCatalogState({ version: 1, updatedAt: 1, providers: [{ id: "p", baseUrl: "https://x", api: "openai-completions", apiKey: "resolved-secret", models: [] }] }), false);
  assert.equal(validateCatalogState({ version: 2, updatedAt: 1, nativeModels: [], providers: [{ id: "p", baseUrl: "https://user:secret@x.test", api: "openai-completions", models: [] }] }), false);
  assert.equal(validateCatalogState({ version: 2, updatedAt: 1, nativeModels: [], providers: [{ id: "p", baseUrl: "https://x.test/v1?token=secret", api: "openai-completions", models: [] }] }), false);
  assert.equal(validateCatalogState({ version: 1, updatedAt: 1, providers: [{ id: "p", baseUrl: "https://x", api: "x", models: [{ id: "m" }] }] }), false);
  assert.equal(validateCatalogState({ version: 1, updatedAt: 1, providers: [{ id: "p", baseUrl: "https://x", api: "x", models: [{ ...catalogState().providers[0].models[0], apiKey: "resolved-secret" }] }] }), false);
});
