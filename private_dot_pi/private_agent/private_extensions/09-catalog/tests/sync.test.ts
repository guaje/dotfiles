import assert from "node:assert/strict";
import test from "node:test";
import { parseAuthoritativeCatalog } from "../cost-sources.ts";
import { aaReviewThinkingLevelOptions, discoverAaCandidates, discoverAaCandidatesForModels, finalizeAaSync, hasGenericAaMapping, isCompleteAaCandidateReview, netAaArtifactChanges, publishReviewedAaVariants, syncEnabledModels, validateReviewedAaVariants } from "../sync.ts";

const customModel = { id: "custom", name: "Custom", canonicalId: "custom-provider/custom", input: ["text"] as ("text" | "image")[], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, costProvenance: "provider:/model/info", available: true, active: true };
const state = {
  version: 2 as const,
  updatedAt: 1,
  providers: [{ id: "custom-provider", baseUrl: "https://custom.test", api: "openai-completions", models: [customModel] }],
  nativeModels: [],
};
const aaConfig = (snapshotRoot = "/synthetic-aa-root") => ({ paths: { snapshotRoot }, limits: { maxAgeMs: 123_456 } });

test("sync reconciles enabled custom and login models with exact pricing and safe native persistence", async () => {
  let reconciled = 0;
  let saved: any; let loadedRoot: string | undefined; let loadedMaxAge: number | undefined;
  const custom = { provider: "custom-provider", id: "custom", name: "Custom", input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
  const login = { provider: "openai-codex", id: "native", name: "Native", reasoning: true, compat: { supportsReasoningEffort: false }, input: ["text", "image"], contextWindow: 1000, maxTokens: 100, headers: { authorization: "secret" } };
  const report = await syncEnabledModels({} as any, {
    scopedModels: [{ model: custom }, { model: login }],
    modelRegistry: { getAvailable: () => [custom, login] },
  }, {
    reconcileSettings: async () => { reconciled++; },
    refreshCatalog: async () => state,
    loadProviderSettings: async () => [{ id: "custom-provider", baseUrl: "https://custom.test", api: "openai-completions" }],
    loadCatalogState: async () => state,
    saveCatalogState: async (value: any) => { saved = value; },
    loadAuthoritativeCatalog: async () => parseAuthoritativeCatalog({ data: [{ id: "openai/native", pricing: { prompt: "0.000003", completion: "0.000009" } }] }),
    loadReviewedCosts: async () => new Map(),
    loadBenchmarkAssets: async (root: string, maxAge: number) => { loadedRoot = root; loadedMaxAge = maxAge; return null; },
    loadAaConfig: () => aaConfig("/configured-aa-root"), loadAaMappings: async () => [],
  } as any);
  assert.equal(reconciled, 1); assert.equal(loadedRoot, "/configured-aa-root"); assert.equal(loadedMaxAge, 123_456);
  assert.deepEqual(report.models.map((model) => [model.id, model.source]), [["custom-provider/custom", "custom"], ["openai-codex/native", "login"]]);
  assert.deepEqual(report.models[1]?.cost, { input: 3, output: 9, cacheRead: 0, cacheWrite: 0 });
  assert.equal(report.models[1]?.costProvenance, "authoritative:openrouter:/api/v1/models");
  assert.equal(saved.nativeModels[0].id, "openai-codex/native");
  assert.equal(saved.nativeModels[0].supportsReasoningEffort, false); assert.equal(report.models[1]?.variantCapable, false);
  assert.doesNotMatch(JSON.stringify(saved), /authorization|secret/i);
  assert.deepEqual(report.missingAa, ["custom-provider/custom", "openai-codex/native"]);
});

test("unique normalized authoritative suffix prices a synthetic model with matched-ID provenance", async () => {
  let saved: any;
  const catalogState: any = { version: 2, updatedAt: 1, providers: [{ id: "test-provider", baseUrl: "https://provider.test", api: "openai-completions", models: [{ id: "nova.4-27b", name: "Nova", canonicalId: "test-provider/nova.4-27b", input: ["text"], available: true, active: true, costProvenance: "unknown" }] }], nativeModels: [] };
  const report = await syncEnabledModels({} as any, { scopedModels: [{ model: { provider: "test-provider", id: "nova.4-27b", input: ["text"] } }], modelRegistry: { getAvailable: () => [] } }, {
    reconcileSettings: async () => {}, refreshCatalog: async () => catalogState, loadProviderSettings: async () => [{ id: "test-provider", baseUrl: "https://provider.test", api: "openai-completions" }], loadCatalogState: async () => catalogState, saveCatalogState: async (state: any) => { saved = state; },
    loadAuthoritativeCatalog: async () => parseAuthoritativeCatalog({ data: [{ id: "test-vendor/nova-4-27b", pricing: { prompt: "0.000001", completion: "0.000002" } }] }), loadReviewedCosts: async () => new Map(), loadBenchmarkAssets: async () => null, loadAaConfig: () => aaConfig(), loadAaMappings: async () => [],
  } as any);
  assert.deepEqual(report.models[0]?.cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  assert.equal(report.models[0]?.costProvenance, "authoritative:openrouter:/api/v1/models:normalized-suffix:test-vendor/nova-4-27b");
  assert.equal(saved.providers[0].models[0].cost, undefined, "sync reporting must not invent catalog pricing");
});

test("pricing resolves provider, OpenRouter, lazy Ollama, then reviewed overrides in order", async () => {
  let ollamaCalls = 0;
  const pricedState: any = { version: 2, updatedAt: 1, providers: [{ id: "custom-provider", baseUrl: "https://custom.test", api: "openai-completions", models: [
    { id: "provider-priced", name: "Provider", canonicalId: "custom-provider/provider-priced", input: ["text"], cost: { input: 7, output: 8, cacheRead: 0, cacheWrite: 0 }, costProvenance: "provider", active: true, available: true },
    { id: "ollama-priced", name: "Ollama", canonicalId: "custom-provider/ollama-priced", input: ["text"], active: true, available: true },
    { id: "reviewed", name: "Reviewed", canonicalId: "custom-provider/reviewed", input: ["text"], active: true, available: true },
  ] }], nativeModels: [] };
  const models = ["provider-priced", "ollama-priced", "reviewed"].map((id) => ({ provider: "custom-provider", id, input: ["text"] }));
  const report = await syncEnabledModels({} as any, { scopedModels: models.map((model) => ({ model })), modelRegistry: { getAvailable: () => models } }, {
    reconcileSettings: async () => {}, refreshCatalog: async () => pricedState, loadProviderSettings: async () => [{ id: "custom-provider", baseUrl: "https://custom.test", api: "openai-completions" }], loadCatalogState: async () => pricedState, saveCatalogState: async () => {},
    loadAuthoritativeCatalog: async () => parseAuthoritativeCatalog({ data: [] }),
    loadOllamaCloudCatalog: async () => { ollamaCalls++; return { provenance: "ollama-cloud:/api/tags", models: new Map([["ollama-priced", { id: "ollama-priced", available: true, cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 } }], ["reviewed", { id: "reviewed", available: true }]]) }; },
    loadReviewedCosts: async () => new Map([["custom-provider/reviewed", { input: 5, output: 6, cacheRead: 0, cacheWrite: 0 }]]), loadBenchmarkAssets: async () => null, loadAaConfig: () => aaConfig(), loadAaMappings: async () => [],
  } as any);
  assert.equal(ollamaCalls, 1);
  assert.deepEqual(report.models.map((model) => model.cost), [{ input: 3, output: 4, cacheRead: 0, cacheWrite: 0 }, { input: 7, output: 8, cacheRead: 0, cacheWrite: 0 }, { input: 5, output: 6, cacheRead: 0, cacheWrite: 0 }]);
  assert.deepEqual(report.models.map((model) => model.costProvenance), ["ollama-cloud:/api/tags:explicit-numeric-price", "provider", "reviewed-override"]);
});

test("custom provider effort support permits specific AA review without reasoning metadata", async () => {
  const report = await syncEnabledModels({} as any, { scopedModels: [{ model: { provider: "custom-provider", id: "custom", input: ["text"] } }], modelRegistry: { getAvailable: () => [] } }, {
    reconcileSettings: async () => {}, refreshCatalog: async () => state, loadProviderSettings: async () => [{ id: "custom-provider", baseUrl: "https://custom.test", api: "openai-completions", compat: { supportsReasoningEffort: true } }], loadCatalogState: async () => state, saveCatalogState: async () => {},
    loadAuthoritativeCatalog: async () => parseAuthoritativeCatalog({ data: [] }), loadOllamaCloudCatalog: async () => ({ provenance: "ollama-cloud:/api/tags", models: new Map() }), loadReviewedCosts: async () => new Map(), loadBenchmarkAssets: async () => null, loadAaConfig: () => aaConfig(), loadAaMappings: async () => [],
  } as any);
  assert.equal(report.models[0]?.variantCapable, true);
});

test("native thinking maps persist inferred effort support while explicit false wins", async () => {
  let saved: any;
  const mapped = { provider: "native-provider", id: "mapped", name: "Mapped", reasoning: true, thinkingLevelMap: { off: null, low: "provider-low", high: "provider-high" }, input: ["text"] };
  const fixed = { provider: "native-provider", id: "fixed", name: "Fixed", reasoning: true, thinkingLevelMap: { low: "provider-low", high: "provider-high" }, compat: { supportsReasoningEffort: false }, input: ["text"] };
  const nativeState = { version: 2 as const, updatedAt: 1, providers: [], nativeModels: [] };
  const report = await syncEnabledModels({} as any, { scopedModels: [{ model: mapped }, { model: fixed }], modelRegistry: { getAvailable: () => [mapped, fixed] } }, {
    reconcileSettings: async () => {}, refreshCatalog: async () => nativeState, loadProviderSettings: async () => [], loadCatalogState: async () => nativeState, saveCatalogState: async (value: any) => { saved = value; },
    loadAuthoritativeCatalog: async () => parseAuthoritativeCatalog({ data: [] }), loadOllamaCloudCatalog: async () => ({ provenance: "ollama-cloud:/api/tags", models: new Map() }), loadReviewedCosts: async () => new Map(), loadBenchmarkAssets: async () => null, loadAaConfig: () => aaConfig(), loadAaMappings: async () => [],
  } as any);
  const persisted = new Map(saved.nativeModels.map((model: any) => [model.id, model] as const)); const reports = new Map(report.models.map((model) => [model.id, model] as const));
  assert.equal((persisted.get("native-provider/mapped") as any)?.supportsReasoningEffort, true); assert.equal(reports.get("native-provider/mapped")?.variantCapable, true);
  assert.equal((persisted.get("native-provider/fixed") as any)?.supportsReasoningEffort, false); assert.equal(reports.get("native-provider/fixed")?.variantCapable, false);
});

test("Ollama Cloud availability never implies free pricing", async () => {
  let saved: any;
  const ollamaState: any = { version: 2, updatedAt: 1, providers: [], nativeModels: [] };
  const report = await syncEnabledModels({} as any, { scopedModels: [{ model: { provider: "ollama", id: "cloud-model", input: ["text"] } }], modelRegistry: { getAvailable: () => [{ provider: "ollama", id: "cloud-model" }] } }, {
    reconcileSettings: async () => {}, refreshCatalog: async () => ollamaState, loadProviderSettings: async () => [], loadCatalogState: async () => ollamaState, saveCatalogState: async (state: any) => { saved = state; },
    loadAuthoritativeCatalog: async () => parseAuthoritativeCatalog({ data: [] }), loadOllamaCloudCatalog: async () => ({ provenance: "ollama-cloud:/api/tags", models: new Map([["cloud-model", { id: "cloud-model", available: true }]]) }), loadReviewedCosts: async () => new Map(), loadBenchmarkAssets: async () => null, loadAaConfig: () => aaConfig(), loadAaMappings: async () => [],
  } as any);
  assert.equal(report.models[0]?.cost, undefined); assert.equal(report.models[0]?.costProvenance, "ollama-cloud:price-unpublished");
  assert.equal(report.models[0]?.available, true); assert.equal(saved.nativeModels[0]?.available, true);
});

test("in-process AA operations propagate cancellation, return publication state, defer prune, and reject unsafe UI labels", async () => {
  const controller = new AbortController(); let discoveredSignal: AbortSignal | undefined; let publishedSignal: AbortSignal | undefined; let publicationOptions: unknown;
  const operations = {
    discover: async (_id: string, signal?: AbortSignal) => { discoveredSignal = signal; return [
      { aaModelId: "11111111-1111-4111-8111-111111111111", slug: "safe", name: "Safe" },
      { aaModelId: "22222222-2222-4222-8222-222222222222", slug: "unsafe", name: "Bad\nLabel" },
      { aaModelId: "not-a-uuid", slug: "safe", name: "Bad ID" },
    ]; },
    replaceReviewedVariants: async (_runtime: string, _canonical: string, _variants: unknown[], signal?: AbortSignal, _env?: unknown, _catalog?: unknown, options?: unknown) => { publishedSignal = signal; publicationOptions = options; return { changed: true, warnings: [] }; },
  };
  const candidates = await discoverAaCandidates("runtime/model", controller.signal, operations as any); assert.deepEqual(candidates.map((entry) => entry.name), ["Safe"]); assert.equal(discoveredSignal, controller.signal);
  const publication = await publishReviewedAaVariants("runtime/model", "canonical/model", [{ ...candidates[0]!, thinkingLevel: null }], controller.signal, operations as any); assert.equal(publishedSignal, controller.signal); assert.deepEqual(publication, { changed: true, warnings: [] }); assert.deepEqual(publicationOptions, { prune: false });
});

test("one AA free-catalog operation produces normalized suggestions without publication", async () => {
  let calls = 0;
  const operations = {
    discover: async () => { throw new Error("must not use per-model discovery"); },
    discoverMany: async (ids: readonly string[]) => { calls++; return new Map(ids.map((id) => [id, [{ aaModelId: "11111111-1111-4111-8111-111111111111", slug: "nova4-2-27b", name: "Synthetic Nova 27B" }]])); },
    replaceReviewedVariants: async () => { throw new Error("must not publish suggestions"); },
  };
  const suggestions = await discoverAaCandidatesForModels(["test-provider/nova4.2-27b", "other-provider/nova4.2-27b"], undefined, operations as any);
  assert.equal(calls, 1); assert.equal(suggestions.size, 2); assert.equal(suggestions.get("test-provider/nova4.2-27b")?.[0]?.name, "Synthetic Nova 27B");
});

test("AA review options allow specific levels only for variable-effort models", () => {
  assert.deepEqual(aaReviewThinkingLevelOptions(true), ["off", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(aaReviewThinkingLevelOptions(false), ["generic"]);
});

test("generic AA mapping detection checks existing variant thinking levels", () => {
  assert.equal(hasGenericAaMapping([{ thinkingLevel: null }]), true);
  assert.equal(hasGenericAaMapping([{ thinkingLevel: "low" }, { thinkingLevel: "high" }]), false);
});

test("reviewed AA batches require complete non-conflicting exact variants", () => {
  const candidate = { aaModelId: "11111111-1111-4111-8111-111111111111", slug: "model", name: "Model" };
  const other = { aaModelId: "22222222-2222-4222-8222-222222222222", slug: "other", name: "Other" };
  assert.equal(isCompleteAaCandidateReview([candidate, other], [{ ...candidate, thinkingLevel: "low" }]), false);
  assert.equal(isCompleteAaCandidateReview([candidate, other], [{ ...candidate, thinkingLevel: "low" }, { ...other, thinkingLevel: "high" }]), true);
  assert.doesNotThrow(() => validateReviewedAaVariants([{ ...candidate, thinkingLevel: "high" }, { ...candidate, aaModelId: "22222222-2222-4222-8222-222222222222", thinkingLevel: "max" }]));
  assert.throws(() => validateReviewedAaVariants([{ ...candidate, thinkingLevel: null }, { ...candidate, aaModelId: "22222222-2222-4222-8222-222222222222", thinkingLevel: "high" }]), /cannot coexist/);
  assert.throws(() => validateReviewedAaVariants([{ ...candidate, thinkingLevel: "high" }, { ...candidate, aaModelId: "22222222-2222-4222-8222-222222222222", thinkingLevel: "high" }]), /duplicate AA thinking level/);
});

test("sync fails closed on a malformed reviewed mapping file", async () => {
  await assert.rejects(syncEnabledModels({} as any, { scopedModels: [{ model: { provider: "custom-provider", id: "custom", input: ["text"] } }], modelRegistry: { getAvailable: () => [] } }, {
    reconcileSettings: async () => {}, refreshCatalog: async () => state,
    loadProviderSettings: async () => [{ id: "custom-provider", baseUrl: "https://custom.test", api: "openai-completions" }],
    loadCatalogState: async () => state, saveCatalogState: async () => {},
    loadAuthoritativeCatalog: async () => parseAuthoritativeCatalog({ data: [] }), loadReviewedCosts: async () => new Map(), loadBenchmarkAssets: async () => null,
    loadAaConfig: () => aaConfig(), loadAaMappings: async () => { throw new Error("invalid canonical mappings"); },
  } as any), /canonical AA mappings are unavailable or invalid/);
});

test("sync propagates the caller abort signal to catalog and authoritative discovery", async () => {
  const controller = new AbortController(); let catalogSignal: AbortSignal | undefined; let authoritativeSignal: AbortSignal | undefined;
  await syncEnabledModels({} as any, { signal: controller.signal, scopedModels: [{ model: { provider: "custom-provider", id: "custom", input: ["text"] } }], modelRegistry: { getAvailable: () => [] } }, {
    reconcileSettings: async () => {}, refreshCatalog: async (_pi: unknown, signal?: AbortSignal) => { catalogSignal = signal; return state; },
    loadProviderSettings: async () => [{ id: "custom-provider", baseUrl: "https://custom.test", api: "openai-completions" }],
    loadCatalogState: async () => state, saveCatalogState: async () => {},
    loadAuthoritativeCatalog: async (signal?: AbortSignal) => { authoritativeSignal = signal; return parseAuthoritativeCatalog({ data: [] }); }, loadReviewedCosts: async () => new Map(), loadBenchmarkAssets: async () => null,
    loadAaConfig: () => aaConfig(), loadAaMappings: async () => [],
  } as any);
  assert.equal(catalogSignal, controller.signal); assert.equal(authoritativeSignal, controller.signal);
});

test("AA net artifact changes coalesce metadata, propagate an external mapping target, additions, deletions, and warnings", () => {
  const before = {
    snapshotRoot: "/synthetic-before",
    manifest: { path: "manifest.json", targetPath: "/synthetic-before/manifest.json", fingerprint: "before" },
    canonicalMappings: { path: "/reviewed config/canonical-mappings.json", targetPath: "/reviewed config/canonical-mappings.json", fingerprint: "same" },
    manifestSnapshotFiles: ["old.json"], generatedSnapshotFiles: ["old.json", "orphan.json"],
  };
  const after = {
    snapshotRoot: "/synthetic-after",
    manifest: { path: "manifest.json", targetPath: "/synthetic-after/manifest.json", fingerprint: "after" },
    canonicalMappings: { path: "/reviewed config/canonical-mappings.json", targetPath: "/reviewed config/canonical-mappings.json", fingerprint: "changed-map" },
    manifestSnapshotFiles: ["new.json"], generatedSnapshotFiles: ["new.json"],
  };
  assert.deepEqual(netAaArtifactChanges(before, after, ["z warning", "a warning", "z warning"]), {
    changes: [
      { kind: "M", path: "manifest.json", targetPath: "/synthetic-after/manifest.json" },
      { kind: "M", path: "/reviewed config/canonical-mappings.json", targetPath: "/reviewed config/canonical-mappings.json" },
      { kind: "A", path: "models/new.json", targetPath: "/synthetic-after/models/new.json" },
      { kind: "D", path: "models/old.json", targetPath: "/synthetic-before/models/old.json" },
      { kind: "D", path: "models/orphan.json", targetPath: "/synthetic-before/models/orphan.json" },
    ],
    warnings: ["a warning", "z warning"],
  });
});

test("AA net artifact changes handle absent metadata defensively", () => {
  const state = { snapshotRoot: "/synthetic", manifest: null, canonicalMappings: null, manifestSnapshotFiles: [], generatedSnapshotFiles: [] };
  assert.deepEqual(netAaArtifactChanges(state, state), { changes: [], warnings: [] });
});

test("interactive AA finalization reconciles before changed-publication cleanup and capture", async () => {
  const before = { snapshotRoot: "/synthetic-aa", manifest: { path: "manifest.json", targetPath: "/synthetic-aa/manifest.json", fingerprint: "old" }, canonicalMappings: { path: "canonical-mappings.json", targetPath: "/synthetic-aa/canonical-mappings.json", fingerprint: "old-map" }, manifestSnapshotFiles: ["old.json"], generatedSnapshotFiles: ["old.json"] };
  const after = { snapshotRoot: "/synthetic-aa", manifest: { path: "manifest.json", targetPath: "/synthetic-aa/manifest.json", fingerprint: "new" }, canonicalMappings: { path: "canonical-mappings.json", targetPath: "/synthetic-aa/canonical-mappings.json", fingerprint: "new-map" }, manifestSnapshotFiles: ["new.json"], generatedSnapshotFiles: ["new.json"] };
  const calls: string[] = []; const warnings = ["publication warning"];
  const result = await finalizeAaSync("initial", true, true, before, warnings, undefined, async () => { calls.push("reconcile"); return "reconciled"; }, {
    discover: async () => [],
    cleanupObsoleteSnapshots: async () => { calls.push("cleanup"); return { deleted: ["models/old.json"], warnings: ["cleanup warning"] }; },
    captureArtifactState: async () => { calls.push("capture"); return after; },
  } as any);
  assert.deepEqual(calls, ["reconcile", "cleanup", "capture"]);
  assert.equal(result.report, "reconciled");
  assert.deepEqual(result.aaArtifacts, { changes: [
    { kind: "M", path: "manifest.json", targetPath: "/synthetic-aa/manifest.json" },
    { kind: "M", path: "canonical-mappings.json", targetPath: "/synthetic-aa/canonical-mappings.json" },
    { kind: "A", path: "models/new.json", targetPath: "/synthetic-aa/models/new.json" },
    { kind: "D", path: "models/old.json", targetPath: "/synthetic-aa/models/old.json" },
  ], warnings: ["cleanup warning", "publication warning"] });
});

test("interactive AA finalization skips cleanup and capture for a successful semantic no-op", async () => {
  let reconciled = 0; let cleaned = 0; let captured = 0;
  const result = await finalizeAaSync("initial", true, false, null, [], undefined, async () => { reconciled++; return "reconciled"; }, {
    discover: async () => [],
    cleanupObsoleteSnapshots: async () => { cleaned++; return { deleted: [], warnings: [] }; },
    captureArtifactState: async () => { captured++; throw new Error("must not capture"); },
  } as any);
  assert.equal(result.report, "reconciled"); assert.equal(result.aaArtifacts, undefined);
  assert.deepEqual([reconciled, cleaned, captured], [1, 0, 0]);
});

test("interactive AA finalization requires a successful publication before reconciliation or cleanup", async () => {
  let reconciled = 0; let cleaned = 0; let captured = 0;
  const result = await finalizeAaSync("initial", false, true, null, [], undefined, async () => { reconciled++; return "unexpected"; }, {
    discover: async () => [],
    cleanupObsoleteSnapshots: async () => { cleaned++; return { deleted: [], warnings: [] }; },
    captureArtifactState: async () => { captured++; throw new Error("must not capture"); },
  } as any);
  assert.deepEqual(result, { report: "initial" });
  assert.deepEqual([reconciled, cleaned, captured], [0, 0, 0]);
});

test("interactive AA finalization skips cleanup when final reconciliation fails", async () => {
  let cleaned = 0; let captured = 0;
  await assert.rejects(finalizeAaSync("initial", true, true, null, [], undefined, async () => { throw new Error("reconciliation failed"); }, {
    discover: async () => [],
    cleanupObsoleteSnapshots: async () => { cleaned++; return { deleted: [], warnings: [] }; },
    captureArtifactState: async () => { captured++; throw new Error("must not capture"); },
  } as any), /reconciliation failed/);
  assert.deepEqual([cleaned, captured], [0, 0]);
});

test("sync preserves historical native observations while marking them inactive", async () => {
  let saved: any;
  const historical = { id: "login/old", canonicalId: "login/old", name: "Old", input: ["text"] as ("text" | "image")[], observedAt: 1, active: true };
  const withHistory = { ...state, nativeModels: [historical] };
  await syncEnabledModels({} as any, { scopedModels: [{ model: { provider: "custom-provider", id: "custom", input: ["text"] } }], modelRegistry: { getAvailable: () => [] } }, {
    reconcileSettings: async () => {}, refreshCatalog: async () => withHistory,
    loadProviderSettings: async () => [{ id: "custom-provider", baseUrl: "https://custom.test", api: "openai-completions" }],
    loadCatalogState: async () => withHistory, saveCatalogState: async (value: any) => { saved = value; },
    loadAuthoritativeCatalog: async () => parseAuthoritativeCatalog({ data: [] }), loadReviewedCosts: async () => new Map(), loadBenchmarkAssets: async () => null,
    loadAaConfig: () => aaConfig(), loadAaMappings: async () => [],
  } as any);
  assert.equal(saved.nativeModels[0].active, false);
});
