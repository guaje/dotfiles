import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import { runCli } from "../aa/cli.ts";
import { abortableDelay, extractCurrentModel, fetchCatalog, fetchPublicModel, readBoundedBody } from "../aa/client.ts";
import { baseConfig, canonicalIdentity, loadDiscoverConfig, loadRequiredMappings, loadRuntimeConfig, validateCatalogUrl } from "../aa/config.ts";
import { createAaService, suggestAaCandidates } from "../aa/service.ts";
import { canonicalDigest, extractStrictV3Mappings, validateBatchMappings, validateCanonicalMappings, validateManifest, validateSnapshot } from "../aa/schema.ts";
import { loadBenchmarkAssets, validManifest, validSnapshot } from "../../04-subagents/benchmark-assets.ts";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);
const TEMP_ROOTS = new Set<string>();
test.afterEach(async () => { for (const directory of TEMP_ROOTS) await rm(directory, { recursive: true, force: true }); TEMP_ROOTS.clear(); });
async function secureWrite(file: string, value: unknown): Promise<void> { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await chmod(file, 0o600); }
async function fixture(): Promise<{ directory: string; root: string; env: NodeJS.ProcessEnv }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-aa-test-")); TEMP_ROOTS.add(directory); const root = path.join(directory, "aa"); await mkdir(path.join(root, "models"), { recursive: true, mode: 0o700 }); await chmod(root, 0o700); await chmod(path.join(root, "models"), 0o700);
  const settings = path.join(directory, "settings.json"), models = path.join(directory, "models.json"); await secureWrite(settings, { enabledModels: ["runtime/model"] }); await secureWrite(models, { providers: { runtime: { compat: { supportsReasoningEffort: true } } } });
  return { directory, root, env: { PI_AA_SETTINGS_CONFIG: settings, PI_AA_MODELS_CONFIG: models, PI_AA_SNAPSHOT_ROOT: root, PI_AA_CANONICAL_MAPPINGS: path.join(root, "canonical-mappings.json"), PI_CATALOG_STATE: path.join(directory, "catalog-state.json"), PI_AA_PUBLIC_PAGE_DELAY: "0", AA_API_KEY: "unit-secret" } };
}
function catalog(id = ID1) { return { records: [{ id, name: "Synthetic Model", slug: "synthetic-model", openrouter_api_id: "model", evaluations: { artificial_analysis_intelligence_index: 72, artificial_analysis_coding_index: 75, artificial_analysis_agentic_index: 70, tau_banking: 0.8, gdpval_aa_normalized: 0.75, tau2_telecom: 0.7, hle: 0.6, gpqa_diamond: 0.8, critpt: 0.7, aa_lcr: 0.9, ifbench: 0.85, aa_omniscience_accuracy: 0.65, aa_omniscience_non_hallucination_rate: 0.8 } }], sourceUrl: "https://artificialanalysis.ai/api/v2/language/models/free" }; }
function publicPage(id = ID1) { return { record: { id, name: "Synthetic Model", slug: "synthetic-model", intelligenceIndex: 72, agenticIndex: 70, tauBanking: 0.8, gdpvalNormalized: 0.75, tau2: 0.7, hle: 0.6, gpqa: 0.8, critpt: 0.7, lcr: 0.9, ifbench: 0.85, omniscienceBreakdown: { accuracy: 0.65, hallucinationRate: 0.2 } }, provenance: { url: "https://artificialanalysis.ai/models/synthetic-model", retrievedAt: 1_700_000_000_000, contentSha256: HASH, recordSha256: HASH, extractorVersion: "aa-current-model-rsc-v1" as const, intelligenceIndexMethodologyVersion: "4.1.1" as const } }; }

test("CLI command matrix preserves usage status and offline missing behavior", { concurrency: false }, async () => {
  for (const args of [[], ["--check", "extra"], ["--missing", "extra"], ["--discover"], ["--add", "runtime/model"], ["--replace-batch"], ["--refresh"], ["--refresh-all", "extra"], ["--unknown"]]) {
    let out = "", err = ""; const status = await runCli(args, { stdout: (text) => { out += text; }, stderr: (text) => { err += text; }, env: {} }); assert.equal(status, 2); assert.equal(out, ""); assert.match(err, /^Usage: node agent\/extensions\/09-catalog\/aa\/cli\.ts /); assert.doesNotMatch(err, /\.sh\b/);
  }
  const item = await fixture(); let out = "", err = ""; const status = await runCli(["--missing"], { stdout: (text) => { out += text; }, stderr: (text) => { err += text; }, env: item.env }); assert.equal(status, 0); assert.equal(out, "runtime/model\n"); assert.equal(err, "");
});

test("discover preserves catalog order and TSV-escapes fields", { concurrency: false }, async () => {
  const item = await fixture(); const original = globalThis.fetch; let out = "", err = "";
  try {
    globalThis.fetch = async (input) => { assert.equal(new URL(String(input)).pathname, "/api/v2/language/models/free"); return new Response(JSON.stringify({ intelligence_index_version: 4.1, pagination: { has_more: false }, data: [{ id: ID1, name: "Model\\One", slug: "synthetic-model", openrouter_api_id: "model" }, { id: ID2, name: "Model Two", slug: "other", openrouter_api_id: "model" }] })); };
    const status = await runCli(["--discover", "runtime/model"], { stdout: (text) => { out += text; }, stderr: (text) => { err += text; }, env: item.env }); assert.equal(status, 0); assert.equal(err, ""); assert.equal(out, `${ID1}\tsynthetic-model\tModel\\\\One\n${ID2}\tother\tModel Two\n`);
  } finally { globalThis.fetch = original; }
});

test("network and configured identities reject terminal control characters", { concurrency: false }, async () => {
  const item = await fixture(); const original = globalThis.fetch; let out = "", err = "";
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ intelligence_index_version: 4.1, pagination: { has_more: false }, data: [{ id: ID1, name: "Model\u001b[31m", slug: "synthetic-model", openrouter_api_id: "model" }] }));
    assert.equal(await runCli(["--discover", "runtime/model"], { stdout: (text) => { out += text; }, stderr: (text) => { err += text; }, env: item.env }), 1);
    assert.equal(out, ""); assert.doesNotMatch(err, /\u001b/);
    for (const args of [["--discover", "runtime/bad\u001b"], ["--add", "runtime/bad\u0007", "--aa-model-id", ID1], ["--refresh", "runtime/bad\ninjected"], ["--replace-batch", path.join(item.directory, "bad\u001b.json")]]) {
      out = ""; err = ""; assert.equal(await runCli(args, { stdout: (text) => { out += text; }, stderr: (text) => { err += text; }, env: item.env }), 1); assert.equal(out, ""); assert.equal(err.endsWith("\n"), true); assert.doesNotMatch(err.slice(0, -1), /[\x00-\x1f\x7f]/);
    }
    await secureWrite(item.env.PI_AA_SETTINGS_CONFIG!, { enabledModels: ["runtime/model\u0007"] }); out = ""; err = "";
    assert.equal(await runCli(["--missing"], { stdout: (text) => { out += text; }, stderr: (text) => { err += text; }, env: item.env }), 1);
    assert.equal(out, ""); assert.doesNotMatch(err, /\u0007/);
  } finally { globalThis.fetch = original; }
});

test("CLI add, replace, refresh, refresh-all, and check use the TypeScript service", { concurrency: false }, async () => {
  const item = await fixture(); const original = globalThis.fetch; let out = "", err = "";
  const apiRecord = catalog().records[0]!; const pageRecord = publicPage().record; const publicHtml = `<script>self.__next_f.push(${JSON.stringify([1, JSON.stringify({ methodology: "Intelligence Index v4.1.1", currentModel: pageRecord })])})</script>`;
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/api/")) { assert.equal(new Headers(init?.headers).get("x-api-key"), "unit-secret"); return new Response(JSON.stringify({ intelligence_index_version: 4.1, pagination: { has_more: false }, data: [apiRecord] })); }
      assert.equal(new Headers(init?.headers).has("x-api-key"), false); return new Response(publicHtml);
    };
    const io = { stdout: (text: string) => { out += text; }, stderr: (text: string) => { err += text; }, env: item.env };
    assert.equal(await runCli(["--add", "runtime/model", "--aa-model-id", ID1], io), 0);
    assert.equal(await runCli(["--refresh", "runtime/model"], io), 0);
    const batch = path.join(item.directory, "batch.json"); await secureWrite(batch, [{ provider: "runtime", model: "model", thinkingLevel: null, aaModelId: ID1 }]); await chmod(batch, 0o644);
    assert.equal(await runCli(["--replace-batch", batch], io), 0);
    assert.equal(await runCli(["--refresh-all"], io), 0);
    assert.equal(await runCli(["--check"], io), 0); assert.equal(out, "Artificial Analysis snapshot is valid\n"); assert.equal(err, "");
  } finally { globalThis.fetch = original; }
});

test("canonical endpoints and credential files fail closed without exposing secrets", { concurrency: false }, async () => {
  assert.equal(validateCatalogUrl("https://artificialanalysis.ai/api/v2/language/models/free").pathname.endsWith("free"), true);
  for (const url of ["http://artificialanalysis.ai/api/v2/language/models", "https://evil.test/api/v2/language/models", "https://artificialanalysis.ai:444/api/v2/language/models", "https://u:p@artificialanalysis.ai/api/v2/language/models", "https://artificialanalysis.ai/api/v2/language/models?q=1"]) assert.throws(() => validateCatalogUrl(url), /allowed canonical endpoint/);
  const item = await fixture(); delete item.env.AA_API_KEY; const target = path.join(item.directory, "credential-target.json"); await secureWrite(target, { artificialAnalysis: { apiKey: "do-not-print" } }); const link = path.join(item.directory, "credentials.json"); await symlink(target, link); item.env.PI_CREDENTIALS_CONFIG = link;
  await assert.rejects(loadDiscoverConfig(item.env), (error: Error) => /unsafe file type/.test(error.message) && !error.message.includes("do-not-print"));
  const mappings = item.env.PI_AA_CANONICAL_MAPPINGS!; await secureWrite(mappings, { version: 1, mappings: [] }); await chmod(mappings, 0o644); await assert.rejects(loadRequiredMappings(baseConfig(item.env)), /unsafe permissions/);
});

test("streaming reader rejects deceptive lengths, chunked excess, and aborts body reads", { concurrency: false }, async () => {
  await assert.rejects(readBoundedBody(new Response("small", { headers: { "content-length": "100" } }), 10), /Content-Length/);
  const chunked = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); controller.close(); } })); await assert.rejects(readBoundedBody(chunked, 10), /exceeded byte limit/);
  const controller = new AbortController(); const hanging = new Response(new ReadableStream<Uint8Array>({})); const pending = readBoundedBody(hanging, 100, controller.signal); controller.abort(new Error("operation aborted")); await assert.rejects(pending, /operation aborted/);
});

test("configured public delay is caller-abortable", async () => { const controller = new AbortController(); const pending = abortableDelay(60_000, controller.signal); controller.abort(); await assert.rejects(pending, /operation aborted/); });

test("catalog client rejects redirects, preserves pagination order, and sanitizes failures", { concurrency: false }, async () => {
  const original = globalThis.fetch; const calls: Array<{ url: string; init?: RequestInit }> = [];
  try {
    globalThis.fetch = async (input, init) => { calls.push({ url: String(input), init }); const page = new URL(String(input)).searchParams.get("page"); return new Response(JSON.stringify({ intelligence_index_version: 4.1, pagination: { has_more: page === "1" }, data: [{ id: page === "1" ? ID1 : ID2, name: `M${page}`, slug: `m-${page}` }] }), { status: 200 }); };
    const config = { ...baseConfig({}), apiKey: "never-log-this" }; const result = await fetchCatalog(config); assert.deepEqual(result.records.map((record) => record.id), [ID1, ID2]); assert.equal(calls.length, 2); assert.equal(calls[0]!.init?.redirect, "error"); assert.equal(new Headers(calls[0]!.init?.headers).get("x-api-key"), "never-log-this");
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }); await assert.rejects(fetchCatalog(config), (error: Error) => !error.message.includes("never-log-this") && /HTTP status 302/.test(error.message));
  } finally { globalThis.fetch = original; }
});

test("catalog pagination metadata is mandatory", { concurrency: false }, async () => {
  const original = globalThis.fetch;
  try { globalThis.fetch = async () => new Response(JSON.stringify({ intelligence_index_version: 4.1, data: [] })); const config = { ...baseConfig({}), apiKey: "secret" }; await assert.rejects(fetchCatalog(config), /pagination is invalid/); } finally { globalThis.fetch = original; }
});

test("request timeout remains active while reading a response body and during public throttling", { concurrency: false }, async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({})); const config = { ...baseConfig({ PI_AA_REQUEST_TIMEOUT_MS: "5" }), apiKey: "secret" }; await assert.rejects(fetchCatalog(config), /request timed out/);
    const payload = JSON.stringify({ methodology: "Intelligence Index v4.1.1", currentModel: { id: ID1, slug: "synthetic-model", name: "Synthetic Model" } }); const html = `<script>self.__next_f.push(${JSON.stringify([1, payload])})</script>`;
    globalThis.fetch = async () => new Response(html); const publicConfig = baseConfig({ PI_AA_REQUEST_TIMEOUT_MS: "5", PI_AA_PUBLIC_PAGE_DELAY: "0.02" }); await assert.rejects(fetchPublicModel(publicConfig, "synthetic-model"), /request timed out/);
  } finally { globalThis.fetch = original; }
});

test("public client sends no API header and rejects unsafe redirect hops", { concurrency: false }, async () => {
  const original = globalThis.fetch; const config = { ...baseConfig({ PI_AA_PUBLIC_PAGE_DELAY: "0" }), apiKey: "must-not-cross-boundary" };
  try {
    globalThis.fetch = async (_input, init) => { const headers = new Headers(init?.headers); assert.equal(headers.has("x-api-key"), false); return new Response(null, { status: 302, headers: { location: "https://evil.test/models/synthetic-model" } }); };
    await assert.rejects(fetchPublicModel(config, "synthetic-model"), (error: Error) => /unsafe/.test(error.message) && !error.message.includes("must-not-cross-boundary"));
  } finally { globalThis.fetch = original; }
});

test("RSC extractor accepts only one exact recognized frame and rejects decoys", () => {
  const payload = JSON.stringify({ methodology: "Intelligence Index v4.1.1", currentModel: { id: ID1, slug: "synthetic-model", name: "Synthetic Model", nested: { brace: "}" } } }); const frame = JSON.stringify([1, payload]);
  const html = `<script>{"currentModel":{"id":"html-decoy"}}</script><script>self.__next_f.push(${frame})</script>`; assert.equal(extractCurrentModel(html).id, ID1);
  const noisyPayload = `d:["invalid\\x"],"methodology":"Intelligence Index v4.1.1","currentModel":${JSON.stringify({ id: ID1, slug: "synthetic-model", name: "Synthetic Model" })}`;
  assert.equal(extractCurrentModel(`<script>self.__next_f.push(${JSON.stringify([1, noisyPayload])})</script>`).id, ID1);
  assert.throws(() => extractCurrentModel(`<script>const x=${JSON.stringify(payload)}</script>`), /exactly one/);
  assert.throws(() => extractCurrentModel(`<script>self.__next_f.push([1,"{\\\"currentModel\\\":{"])</script>`), /malformed/);
  assert.throws(() => extractCurrentModel(`${html}<script>self.__next_f.push(${frame})</script>`), /exactly one/);
});

test("public methodology is authenticated to the currentModel frame", { concurrency: false }, async () => {
  const original = globalThis.fetch; const config = baseConfig({ PI_AA_PUBLIC_PAGE_DELAY: "0" });
  const frame = (version: string, withModel = true, decoy?: string) => `<script>self.__next_f.push(${JSON.stringify([1, JSON.stringify({ ...(decoy ? { unrelatedLabel: `Intelligence Index v${decoy}` } : {}), methodology: `Intelligence Index v${version}`, ...(withModel ? { currentModel: { id: ID1, slug: "synthetic-model", name: "Synthetic Model" } } : {}) })])})</script>`;
  try {
    globalThis.fetch = async () => new Response(`<div>Intelligence Index v4.1.1</div>${frame("4.2.0")}`); await assert.rejects(fetchPublicModel(config, "synthetic-model"), /unsupported public Intelligence Index methodology/);
    globalThis.fetch = async () => new Response(frame("4.2.0", true, "4.1.1")); await assert.rejects(fetchPublicModel(config, "synthetic-model"), /unsupported public Intelligence Index methodology/);
    globalThis.fetch = async () => new Response(`${frame("4.1.1", false)}${frame("4.2.0")}`); await assert.rejects(fetchPublicModel(config, "synthetic-model"), /unsupported public Intelligence Index methodology/);
    globalThis.fetch = async () => new Response(`${frame("4.2.0", false)}${frame("4.1.1")}`); assert.equal((await fetchPublicModel(config, "synthetic-model")).record.id, ID1);
    const split = `<script>self.__next_f.push(${JSON.stringify([1, JSON.stringify({ currentModel: { id: ID1, slug: "synthetic-model", name: "Synthetic Model" } })])})</script>`;
    globalThis.fetch = async () => new Response(`<span>Artificial Analysis Intelligence Index v4.1.1 incorporates 9 evaluations</span>${split}`); assert.equal((await fetchPublicModel(config, "synthetic-model")).record.id, ID1);
    globalThis.fetch = async () => new Response(`<span>Intelligence Index v4.1.1</span>${split}`); await assert.rejects(fetchPublicModel(config, "synthetic-model"), /unsupported public Intelligence Index methodology/);
  } finally { globalThis.fetch = original; }
});

test("strict shared mappings, v3 extraction, and producer/consumer validators have parity", () => {
  const mappings = [{ provider: "runtime", model: "model", thinkingLevel: null, aaModelId: ID1 }]; assert.equal(validateBatchMappings(mappings), true); assert.equal(validateBatchMappings([{ ...mappings[0], extra: true }]), false);
  const alias = { provider: "alias", model: "model", canonicalId: "canonical/model", thinkingLevel: null, aaModelId: ID1 };
  assert.equal(validateCanonicalMappings({ version: 1, mappings: [{ ...mappings[0], canonicalId: "canonical/model" }, alias] }), true);
  assert.equal(validateCanonicalMappings({ version: 1, mappings: [{ ...mappings[0], canonicalId: "canonical/model" }, { ...alias, aaModelId: ID2 }] }), false);
  assert.equal(validateCanonicalMappings({ version: 1, mappings: [{ ...mappings[0], canonicalId: "canonical/model" }, { ...alias, thinkingLevel: "high" }] }), false);
  assert.equal(validateCanonicalMappings({ version: 1, mappings: [{ ...mappings[0], canonicalId: "canonical/model", extra: true }] }), false);
  const v3 = { version: 3, models: [{ ...mappings[0], file: "legacy.json", capturedAt: 1, contentDigest: HASH }] }; assert.deepEqual(extractStrictV3Mappings(v3), mappings); assert.equal(extractStrictV3Mappings({ ...v3, scores: {} }), null);
  const invalidManifest = { version: 4, generatedAt: 1, digest: HASH, methodology: { id: "artificial-analysis-intelligence-index", version: "4.1" }, models: [], extra: true }; assert.equal(validateManifest(invalidManifest), false); assert.equal(validManifest(invalidManifest), false);
  const opaqueManifest = { version: 4, generatedAt: 1, digest: HASH, methodology: { id: "artificial-analysis-intelligence-index", version: "4.1" }, models: [{ provider: "p", model: "m", thinkingLevel: null, modelId: "opaque", file: "x.json", capturedAt: 1, contentDigest: HASH }] }; assert.equal(validateManifest(opaqueManifest), false); assert.equal(validManifest(opaqueManifest), false); assert.equal(validateSnapshot({}), validSnapshot({}));
});

test("writer builds exact v4 scores, remains a semantic no-op, and uses owner-only files", { concurrency: false }, async () => {
  const item = await fixture(); let now = 1_700_000_001_000; const service = createAaService({ now: () => now, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() });
  const first = await service.add("runtime/model", ID1, null, undefined, item.env); assert.equal(first.changed, true); const manifestBefore = await readFile(path.join(item.root, "manifest.json"), "utf8"); const manifest = JSON.parse(manifestBefore); assert.equal(validateManifest(manifest), true); const snapshot = JSON.parse(await readFile(path.join(item.root, "models", manifest.models[0].file), "utf8")); assert.equal(validateSnapshot(snapshot), true); assert.equal(snapshot.scores.coding, 75); assert.equal(snapshot.scores.toolUse, 77.5); assert.equal(snapshot.scores.scientificReasoning, 70); assert.deepEqual(snapshot.outputTokens, {}); assert.equal((await lstat(path.join(item.root, "manifest.json"))).mode & 0o777, 0o600);
  now += 10_000; const second = await service.refresh("runtime/model", undefined, item.env); assert.equal(second.changed, false); assert.equal(await readFile(path.join(item.root, "manifest.json"), "utf8"), manifestBefore);
});

test("artifact capture records resolved roots and exact custom metadata targets", { concurrency: false }, async () => {
  const item = await fixture();
  const mappingsPath = path.join(item.directory, "reviewed mappings.json");
  item.env.PI_AA_CANONICAL_MAPPINGS = mappingsPath;
  const service = createAaService({ now: () => 1_700_000_001_000, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() });
  await service.add("runtime/model", ID1, null, undefined, item.env);
  await secureWrite(mappingsPath, { version: 1, mappings: [{ provider: "runtime", model: "model", canonicalId: "runtime/model", thinkingLevel: null, aaModelId: ID1 }] });

  const captured = await service.captureArtifactState(item.env);
  assert.equal(captured.snapshotRoot, path.resolve(item.root));
  assert.equal(captured.manifest?.path, "manifest.json");
  assert.equal(captured.manifest?.targetPath, path.join(item.root, "manifest.json"));
  assert.equal(captured.canonicalMappings?.path, mappingsPath);
  assert.equal(captured.canonicalMappings?.targetPath, mappingsPath);
});

test("shared writes preserve an exact pinned disabled baseline but reject disabled mapping changes", { concurrency: false }, async () => {
  const item = await fixture();
  await secureWrite(item.env.PI_AA_SETTINGS_CONFIG!, { enabledModels: ["legacy/model"] });
  await secureWrite(item.env.PI_AA_MODELS_CONFIG!, { providers: { legacy: { compat: { supportsReasoningEffort: true } }, runtime: { compat: { supportsReasoningEffort: true } } } });
  const now = 1_700_000_001_000;
  const initial = createAaService({ now: () => now, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() });
  await initial.add("legacy/model", ID1, null, undefined, item.env);
  await secureWrite(item.env.PI_AA_CANONICAL_MAPPINGS!, { version: 1, mappings: [{ provider: "legacy", model: "model", canonicalId: "legacy/model", thinkingLevel: null, aaModelId: ID1 }] });
  await secureWrite(item.env.PI_AA_SETTINGS_CONFIG!, { enabledModels: ["runtime/model"] });

  const targetRecord = { ...catalog(ID2).records[0]!, name: "Target Model", slug: "target-model" };
  const service = createAaService({
    now: () => now,
    fetchCatalog: async () => ({ ...catalog(), records: [catalog().records[0]!, targetRecord] }),
    fetchPublicModel: async (_config, slug) => {
      const target = slug === targetRecord.slug; const page = publicPage(target ? ID2 : ID1);
      page.record.name = target ? targetRecord.name : "Synthetic Model"; page.record.slug = slug; page.provenance.url = `https://artificialanalysis.ai/models/${slug}`;
      return page;
    },
  });
  assert.equal((await service.replaceBatch([
    { provider: "legacy", model: "model", thinkingLevel: null, aaModelId: ID1 },
    { provider: "runtime", model: "model", thinkingLevel: null, aaModelId: ID2 },
  ], undefined, item.env)).changed, true);
  const manifest = JSON.parse(await readFile(path.join(item.root, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.models.map((entry: any) => [entry.provider, entry.model, entry.thinkingLevel, entry.modelId]), [
    ["legacy", "model", null, ID1], ["runtime", "model", null, ID2],
  ]);
  await service.check(item.env);

  const target = { provider: "runtime", model: "model", thinkingLevel: null, aaModelId: ID2 } as const;
  for (const changed of [
    { provider: "legacy", model: "model", thinkingLevel: null, aaModelId: ID3 },
    { provider: "legacy", model: "model", thinkingLevel: "high", aaModelId: ID1 },
    { provider: "legacy", model: "changed", thinkingLevel: null, aaModelId: ID1 },
  ] as const) {
    await assert.rejects(service.replaceBatch([changed, target], undefined, item.env), /canonical model is not enabled: legacy\//);
  }
});

test("separator-normalized advisory matching returns every exact synthetic reasoning prefix variant", () => {
  const records = [
    [ID1, "nova4-2-27b"], [ID2, "nova4-2-27b-non-reasoning"],
    ["33333333-3333-4333-8333-333333333333", "nova4-2-27b-low"], ["44444444-4444-4444-8444-444444444444", "nova4-2-27b-medium"],
    ["55555555-5555-4555-8555-555555555555", "nova4-2-27b-xhigh"], ["66666666-6666-4666-8666-666666666666", "nova4-2-27b-unrelated"],
  ].map(([id, slug]) => ({ id, slug, name: slug, openrouter_api_id: `test-vendor/${slug}` }));
  assert.deepEqual(suggestAaCandidates("test-provider/nova4.2-27b", { records, sourceUrl: "https://artificialanalysis.ai/api/v2/language/models/free" }).map((candidate) => candidate.slug), ["nova4-2-27b", "nova4-2-27b-non-reasoning", "nova4-2-27b-low", "nova4-2-27b-medium", "nova4-2-27b-xhigh"]);
});

test("reviewed publications reuse one free catalog and supplement its null metrics from public pages", { concurrency: false }, async () => {
  const item = await fixture(); let calls = 0; const first = structuredClone(catalog().records[0]!); const second = { ...structuredClone(first), id: ID2, name: "Synthetic Model Two", slug: "synthetic-model-two" };
  (first.evaluations as any).tau_banking = null; (second.evaluations as any).tau_banking = null;
  const service = createAaService({ now: () => 1_700_000_001_000, fetchCatalog: async (config) => { calls++; assert.equal(config.apiUrl.pathname, "/api/v2/language/models/free"); return { records: [first, second], sourceUrl: config.apiUrl.href }; }, fetchPublicModel: async (_config, slug) => {
    const page = publicPage(slug === second.slug ? ID2 : ID1); page.record.name = slug === second.slug ? second.name : first.name; page.record.slug = slug; page.provenance.url = `https://artificialanalysis.ai/models/${slug}`; return page;
  } });
  const review = await service.discoverCatalog(["runtime/model"], undefined, item.env);
  await service.replaceReviewedVariants("runtime/model", "runtime/model", [
    { aaModelId: ID1, slug: first.slug, name: first.name, thinkingLevel: "low" },
    { aaModelId: ID2, slug: second.slug, name: second.name, thinkingLevel: "xhigh" },
  ], undefined, item.env, review.catalog);
  assert.equal(calls, 1);
  const manifest = JSON.parse(await readFile(path.join(item.root, "manifest.json"), "utf8"));
  for (const entry of manifest.models) {
    const snapshot = JSON.parse(await readFile(path.join(item.root, "models", entry.file), "utf8"));
    assert.equal(snapshot.toolUse.components.tau3Banking.sourceKind, "public-page");
  }
});

test("public values only supplement API nulls and conflicts abort before publication", { concurrency: false }, async () => {
  const item = await fixture(); const api = structuredClone(catalog()); (api.records[0]!.evaluations as any).tau_banking = null;
  const service = createAaService({ now: () => 1_700_000_001_000, fetchCatalog: async () => api, fetchPublicModel: async () => publicPage() }); await service.add("runtime/model", ID1, null, undefined, item.env);
  const manifest = JSON.parse(await readFile(path.join(item.root, "manifest.json"), "utf8")); const snapshot = JSON.parse(await readFile(path.join(item.root, "models", manifest.models[0].file), "utf8")); assert.equal(snapshot.toolUse.components.tau3Banking.sourceKind, "public-page");
  const conflictItem = await fixture(); const conflictPage = publicPage(); conflictPage.record.tauBanking = 0.6; const conflicting = createAaService({ now: () => 1_700_000_001_000, fetchCatalog: async () => catalog(), fetchPublicModel: async () => conflictPage }); await assert.rejects(conflicting.add("runtime/model", ID1, null, undefined, conflictItem.env), /API\/public metric conflict/); await assert.rejects(readFile(path.join(conflictItem.root, "manifest.json")), /ENOENT/);
});

test("refresh-all performs only a strict mapping-only v3 migration and preserves its disabled baseline", { concurrency: false }, async () => {
  const item = await fixture();
  await secureWrite(item.env.PI_AA_CANONICAL_MAPPINGS!, { version: 1, mappings: [{ provider: "legacy", model: "model", canonicalId: "legacy/model", thinkingLevel: null, aaModelId: ID1 }] });
  await secureWrite(path.join(item.root, "manifest.json"), { version: 3, models: [{ provider: "legacy", model: "model", thinkingLevel: null, aaModelId: ID1, file: "legacy.json", capturedAt: 1, contentDigest: HASH }] });
  const service = createAaService({ now: () => 1_700_000_001_000, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() }); const result = await service.refreshAll(undefined, item.env); assert.equal(result.changed, true);
  const manifest = JSON.parse(await readFile(path.join(item.root, "manifest.json"), "utf8")); assert.equal(manifest.version, 4); assert.equal(manifest.models[0].provider, "legacy"); assert.equal(manifest.models[0].modelId, ID1); await service.check(item.env);
  await secureWrite(path.join(item.root, "manifest.json"), { version: 3, models: [], extra: true }); await assert.rejects(service.refreshAll(undefined, item.env), /invalid or unsupported manifest/);
});

test("missing treats only secure, current, digest-verified complete artifacts as present", { concurrency: false }, async () => {
  const item = await fixture(); const now = 1_700_000_001_000; const service = createAaService({ now: () => now, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() }); await service.add("runtime/model", ID1, null, undefined, item.env); assert.deepEqual(await service.missing(item.env), []);
  const manifestPath = path.join(item.root, "manifest.json"); const manifest = JSON.parse(await readFile(manifestPath, "utf8")); const snapshotPath = path.join(item.root, "models", manifest.models[0].file); const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  await secureWrite(manifestPath, { ...manifest, digest: "b".repeat(64) }); assert.deepEqual(await service.missing(item.env), ["runtime/model"]); await secureWrite(manifestPath, manifest);
  await secureWrite(snapshotPath, { ...snapshot, scores: { ...snapshot.scores, coding: 74 } }); assert.equal(validateSnapshot(JSON.parse(await readFile(snapshotPath, "utf8"))), true); assert.deepEqual(await service.missing(item.env), ["runtime/model"]); await secureWrite(snapshotPath, snapshot);
  await chmod(manifestPath, 0o644); assert.deepEqual(await service.missing(item.env), ["runtime/model"]); await chmod(manifestPath, 0o600);
  await secureWrite(path.join(item.root, "models", "orphan.json"), { orphan: true }); assert.deepEqual(await service.missing(item.env), []); await service.check(item.env); await rm(path.join(item.root, "models", "orphan.json"));
  await secureWrite(manifestPath, { ...manifest, generatedAt: now - 2_592_000_001 }); assert.deepEqual(await service.missing(item.env), ["runtime/model"]);
});

test("simultaneous writers serialize at the real lock boundary", { concurrency: false }, async () => {
  const item = await fixture(); let release!: () => void; let started!: () => void; const entered = new Promise<void>((resolve) => { started = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = createAaService({ now: () => 1_700_000_001_000, fetchCatalog: async () => { started(); await gate; return catalog(); }, fetchPublicModel: async () => publicPage() }); const first = service.add("runtime/model", ID1, null, undefined, item.env); await entered; try { await assert.rejects(service.add("runtime/model", ID1, null, undefined, item.env), /lock is held/); } finally { release(); } await first;
});

test("readers keep the prior manifest generation while new immutable snapshots are staged", { concurrency: false }, async () => {
  const item = await fixture(); let now = 1_700_000_001_000; const initial = createAaService({ now: () => now++, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() }); await initial.add("runtime/model", ID1, null, undefined, item.env); const priorManifest = JSON.parse(await readFile(path.join(item.root, "manifest.json"), "utf8")); const priorSnapshotPath = path.join(item.root, "models", priorManifest.models[0].file);
  let release!: () => void; let started!: () => void; const entered = new Promise<void>((resolve) => { started = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
  const update = createAaService({ now: () => now++, fetchCatalog: async () => catalog(ID2), fetchPublicModel: async () => publicPage(ID2), fsHooks: { async beforeManifestRename() { started(); await gate; } } }); const pending = update.add("runtime/model", ID2, null, undefined, item.env); await entered;
  try { const active = await loadBenchmarkAssets(item.root, 2_592_000_000, now); assert.equal(active?.snapshots[0]?.modelId, ID1); } finally { release(); }
  await pending; const current = await loadBenchmarkAssets(item.root, 2_592_000_000, now); assert.equal(current?.snapshots[0]?.modelId, ID2); assert.equal(validateSnapshot(JSON.parse(await readFile(priorSnapshotPath, "utf8"))), true);
});

test("service readers retry only after a missing snapshot and a changed manifest", { concurrency: false }, async () => {
  const item = await fixture(); let now = 1_700_000_001_000;
  const initial = createAaService({ now: () => now++, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() });
  await initial.add("runtime/model", ID1, null, undefined, item.env);
  const manifestPath = path.join(item.root, "manifest.json"); const oldManifest = await readFile(manifestPath, "utf8"); const oldFile = JSON.parse(oldManifest).models[0].file;
  const updated = createAaService({ now: () => now++, fetchCatalog: async () => catalog(ID2), fetchPublicModel: async () => publicPage(ID2) });
  await updated.add("runtime/model", ID2, null, undefined, item.env);
  const nextManifest = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, oldManifest, { mode: 0o600 }); await chmod(manifestPath, 0o600);
  let switched = false; let snapshotReads = 0;
  const reader = createAaService({ now: () => now, fsHooks: { async beforeSnapshotRead() {
    snapshotReads++;
    if (switched) return;
    switched = true;
    const staged = path.join(item.root, "next-manifest.json"); await writeFile(staged, nextManifest, { mode: 0o600 }); await chmod(staged, 0o600);
    await rename(staged, manifestPath); await rm(path.join(item.root, "models", oldFile));
  } } });
  await reader.check(item.env);
  assert.equal(switched, true); assert.equal(snapshotReads, 2); assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).models[0].modelId, ID2);

  const unchanged = await fixture(); const unchangedService = createAaService({ now: () => 1_700_000_001_000, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() });
  await unchangedService.add("runtime/model", ID1, null, undefined, unchanged.env);
  const unchangedManifest = JSON.parse(await readFile(path.join(unchanged.root, "manifest.json"), "utf8")); await rm(path.join(unchanged.root, "models", unchangedManifest.models[0].file));
  await assert.rejects(unchangedService.check(unchanged.env), /missing required file/);
});

test("service snapshot-read hooks do not recover malformed or unsafe artifacts", { concurrency: false }, async () => {
  const malformed = await fixture(); const normal = createAaService({ now: () => 1_700_000_001_000, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() });
  await normal.add("runtime/model", ID1, null, undefined, malformed.env); await writeFile(path.join(malformed.root, "manifest.json"), "{", { mode: 0o600 });
  let malformedReads = 0; const malformedReader = createAaService({ now: () => 1_700_000_001_000, fsHooks: { beforeSnapshotRead() { malformedReads++; } } });
  await assert.rejects(malformedReader.check(malformed.env), /invalid JSON/); assert.equal(malformedReads, 0);

  const unsafe = await fixture(); await normal.add("runtime/model", ID1, null, undefined, unsafe.env);
  const unsafeManifest = JSON.parse(await readFile(path.join(unsafe.root, "manifest.json"), "utf8")); await chmod(path.join(unsafe.root, "models", unsafeManifest.models[0].file), 0o644);
  let unsafeReads = 0; const unsafeReader = createAaService({ now: () => 1_700_000_001_000, fsHooks: { beforeSnapshotRead() { unsafeReads++; } } });
  await assert.rejects(unsafeReader.check(unsafe.env), /unsafe permissions/); assert.equal(unsafeReads, 0);
});

test("writers reject manifest entries that disagree with their referenced snapshots", { concurrency: false }, async () => {
  const item = await fixture(); const service = createAaService({ now: () => 1_700_000_001_000, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() }); await service.add("runtime/model", ID1, null, undefined, item.env);
  const manifestPath = path.join(item.root, "manifest.json"); const manifest = JSON.parse(await readFile(manifestPath, "utf8")); manifest.models[0].provider = "other"; manifest.digest = canonicalDigest(manifest.models); await secureWrite(manifestPath, manifest);
  await assert.rejects(service.add("runtime/model", ID1, null, undefined, item.env), /invalid snapshot/);
});

test("canonical mappings must match snapshot identity, UUID, and thinking level", { concurrency: false }, async () => {
  const item = await fixture(); const service = createAaService({ now: () => 1_700_000_001_000, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() }); await service.add("runtime/model", ID1, null, undefined, item.env);
  const mappingsPath = path.join(item.root, "canonical-mappings.json");
  await secureWrite(mappingsPath, { version: 1, mappings: [{ provider: "alias", model: "model", canonicalId: "canonical/model", thinkingLevel: null, aaModelId: ID1 }] }); await assert.rejects(service.check(item.env), /mismatched AA snapshot/); await assert.rejects(service.add("runtime/model", ID1, null, undefined, item.env), /mismatched AA snapshot/);
  await secureWrite(mappingsPath, { version: 1, mappings: [{ provider: "runtime", model: "model", canonicalId: "runtime/model", thinkingLevel: "high", aaModelId: ID1 }] }); await assert.rejects(service.check(item.env), /mismatched AA snapshot/);
});

test("alias-aware reviewed publication has one manifest commit point and preserves static mappings", { concurrency: false }, async () => {
  const item = await fixture(); let now = 1_700_000_001_000; const normal = createAaService({ now: () => now++, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() }); await normal.add("runtime/model", ID1, null, undefined, item.env);
  await secureWrite(path.join(item.root, "canonical-mappings.json"), { version: 1, mappings: [{ provider: "runtime", model: "model", canonicalId: "canonical/model", thinkingLevel: null, aaModelId: ID1 }] }); const before = await readFile(path.join(item.root, "manifest.json"), "utf8"); const mappingsBefore = await readFile(path.join(item.root, "canonical-mappings.json"), "utf8");
  const failing = createAaService({ now: () => now++, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage(), fsHooks: { beforeManifestRename() { throw new Error("injected manifest failure"); } } }); await assert.rejects(failing.replaceReviewedVariants("runtime/model", "canonical/model", [{ aaModelId: ID1, slug: "synthetic-model", name: "Synthetic Model", thinkingLevel: null }], undefined, item.env), /injected manifest failure/); assert.equal(await readFile(path.join(item.root, "manifest.json"), "utf8"), before); assert.equal(await readFile(path.join(item.root, "canonical-mappings.json"), "utf8"), mappingsBefore); assert.equal((await readdir(path.join(item.root, "models"))).filter((file) => file.endsWith(".json")).length, 1);
  const replaced = createAaService({ now: () => now++, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() }); await replaced.replaceReviewedVariants("runtime/model", "canonical/model", [{ aaModelId: ID1, slug: "synthetic-model", name: "Synthetic Model", thinkingLevel: null }], undefined, item.env); const manifest = JSON.parse(await readFile(path.join(item.root, "manifest.json"), "utf8")); assert.deepEqual(manifest.models.map((entry: any) => `${entry.provider}/${entry.model}`), ["canonical/model"]); assert.equal(manifest.models[0].modelId, ID1);
  assert.equal(await readFile(path.join(item.root, "canonical-mappings.json"), "utf8"), mappingsBefore); await replaced.check(item.env); const runtimeConfig = await loadRuntimeConfig(item.env); assert.equal(canonicalIdentity(runtimeConfig, "runtime/model"), "canonical/model");
  const unsafeReplacement = createAaService({ now: () => now++, fetchCatalog: async () => catalog(ID2), fetchPublicModel: async () => publicPage(ID2) }); await assert.rejects(unsafeReplacement.replaceReviewedVariants("runtime/model", "canonical/model", [{ aaModelId: ID2, slug: "synthetic-model", name: "Synthetic Model", thinkingLevel: null }], undefined, item.env), /canonical mapping references a mismatched AA snapshot/); assert.equal(await readFile(path.join(item.root, "canonical-mappings.json"), "utf8"), mappingsBefore);
});

test("an existing filename collision is never overwritten", { concurrency: false }, async () => {
  const item = await fixture(); const service = createAaService({ now: () => 1_700_000_001_000, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage(), fsHooks: { async beforeInstall(file) { await secureWrite(path.join(item.root, "models", file), { collision: true }); } } }); await assert.rejects(service.add("runtime/model", ID1, null, undefined, item.env), /snapshot filename collision|invalid JSON/); await assert.rejects(readFile(path.join(item.root, "manifest.json")), /ENOENT/); const files = (await readdir(path.join(item.root, "models"))).filter((file) => file.endsWith(".json")); assert.equal(files.length, 1); assert.deepEqual(JSON.parse(await readFile(path.join(item.root, "models", files[0]!), "utf8")), { collision: true });
});

test("snapshot installation injection fails before commit without leaving artifacts", { concurrency: false }, async () => {
  const item = await fixture(); const service = createAaService({ now: () => 1_700_000_001_000, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage(), fsHooks: { beforeInstall() { throw new Error("injected install failure"); } } }); await assert.rejects(service.add("runtime/model", ID1, null, undefined, item.env), /injected install failure/); assert.deepEqual((await readdir(path.join(item.root, "models"))).filter((file) => file.endsWith(".json")), []); await assert.rejects(readFile(path.join(item.root, "manifest.json")), /ENOENT/);
});

test("post-commit pruning failures are warnings and never undo publication", { concurrency: false }, async () => {
  const item = await fixture(); let now = 1_700_000_001_000; const normal = createAaService({ now: () => now++, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() }); await normal.add("runtime/model", ID1, null, undefined, item.env); await secureWrite(path.join(item.root, "models", "orphan.json"), { orphan: true }); await utimes(path.join(item.root, "models", "orphan.json"), new Date(0), new Date(0));
  const cleanupFailure = createAaService({ now: () => now++, fetchCatalog: async () => catalog(ID2), fetchPublicModel: async () => publicPage(ID2), fsHooks: { beforePrune() { throw new Error("injected cleanup failure"); } } }); const result = await cleanupFailure.add("runtime/model", ID2, null, undefined, item.env); assert.equal(result.changed, true); assert.deepEqual(result.warnings, ["snapshot cleanup was incomplete after successful publication"]); const manifest = JSON.parse(await readFile(path.join(item.root, "manifest.json"), "utf8")); assert.equal(manifest.models[0].modelId, ID2); assert.equal((await lstat(path.join(item.root, "models", "orphan.json"))).isFile(), true);
});

test("lock contention and verified native effort capability gate specific variants", { concurrency: false }, async () => {
  const item = await fixture(); await mkdir(path.join(item.root, ".refresh.lock"), { mode: 0o700 }); const service = createAaService({ fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() }); await assert.rejects(service.add("runtime/model", ID1, null, undefined, item.env), /lock is held/);
  await rm(path.join(item.root, ".refresh.lock"), { recursive: true }); await secureWrite(item.env.PI_AA_MODELS_CONFIG!, { providers: { runtime: { compat: { supportsReasoningEffort: false } } } }); await assert.rejects(service.add("runtime/model", ID1, "high", undefined, item.env), /does not support selectable/);
  await secureWrite(item.env.PI_AA_SETTINGS_CONFIG!, { enabledModels: ["native/model"] }); await secureWrite(item.env.PI_AA_MODELS_CONFIG!, { providers: {} }); await secureWrite(item.env.PI_CATALOG_STATE!, { version: 2, updatedAt: 1, providers: [], nativeModels: [{ id: "native/model", canonicalId: "canonical/model", supportsReasoningEffort: false }] }); await assert.rejects(service.add("native/model", ID1, "high", undefined, item.env), /does not support selectable/);
  await secureWrite(item.env.PI_CATALOG_STATE!, { version: 2, updatedAt: 1, providers: [], nativeModels: [{ id: "native/model", canonicalId: "canonical/model", supportsReasoningEffort: true }] }); assert.equal((await service.add("native/model", ID1, "high", undefined, item.env)).changed, true);
});

test("interactive publications defer pruning and final cleanup reports only secure generated deletions", { concurrency: false }, async () => {
  const item = await fixture(); let now = 1_700_000_001_000;
  const initial = createAaService({ now: () => now++, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() });
  await initial.add("runtime/model", ID1, null, undefined, item.env);
  const before = await initial.captureArtifactState(item.env); const old = before.manifestSnapshotFiles[0]!;
  const orphan = "aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb.json"; await secureWrite(path.join(item.root, "models", orphan), { orphan: true }); await utimes(path.join(item.root, "models", orphan), new Date(0), new Date(0));
  const updated = createAaService({ now: () => now++, fetchCatalog: async () => catalog(ID2), fetchPublicModel: async () => publicPage(ID2) });
  const publication = await updated.replaceReviewedVariants("runtime/model", "runtime/model", [{ aaModelId: ID2, slug: "synthetic-model", name: "Synthetic Model", thinkingLevel: null }], undefined, item.env, undefined, { prune: false });
  assert.equal(publication.changed, true); assert.equal((await readdir(path.join(item.root, "models"))).includes(old), true); assert.equal((await readdir(path.join(item.root, "models"))).includes(orphan), true);
  await secureWrite(path.join(item.root, "models", "unexpected.json"), { preserved: true });
  const cleanup = await updated.cleanupObsoleteSnapshots(undefined, item.env);
  assert.deepEqual(cleanup.deleted, [`models/${old}`, `models/${orphan}`].sort()); assert.deepEqual(cleanup.warnings, ["snapshot cleanup skipped an unexpected file"]);
  assert.equal((await readdir(path.join(item.root, "models"))).includes(old), false);
  const after = await updated.captureArtifactState(item.env);
  assert.equal(after.snapshotRoot, path.resolve(item.root));
  assert.equal(after.manifest?.path, "manifest.json");
  assert.equal(after.manifest?.targetPath, path.join(item.root, "manifest.json"));
  assert.equal(after.generatedSnapshotFiles.length, 1);
});

test("standalone final cleanup warns on deletion failure without changing the current manifest", { concurrency: false }, async () => {
  const item = await fixture(); let now = 1_700_000_001_000;
  const initial = createAaService({ now: () => now++, fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() });
  await initial.add("runtime/model", ID1, null, undefined, item.env);
  const old = JSON.parse(await readFile(path.join(item.root, "manifest.json"), "utf8")).models[0].file;
  const updated = createAaService({ now: () => now++, fetchCatalog: async () => catalog(ID2), fetchPublicModel: async () => publicPage(ID2) });
  await updated.add("runtime/model", ID2, null, undefined, item.env);
  const failingCleanup = createAaService({ fsHooks: { beforePrune() { throw new Error("injected cleanup failure"); } } });
  const cleanup = await failingCleanup.cleanupObsoleteSnapshots(undefined, item.env);
  assert.deepEqual(cleanup, { deleted: [], warnings: ["snapshot cleanup was incomplete after successful publication"] });
  assert.equal((await lstat(path.join(item.root, "models", old))).isFile(), true);
  assert.equal(JSON.parse(await readFile(path.join(item.root, "manifest.json"), "utf8")).models[0].modelId, ID2);
});

test("native thinking maps infer effort support only when valid and not explicitly overridden", { concurrency: false }, async () => {
  const item = await fixture(); await secureWrite(item.env.PI_AA_SETTINGS_CONFIG!, { enabledModels: ["native/model"] }); await secureWrite(item.env.PI_AA_MODELS_CONFIG!, { providers: {} });
  const cases: Array<{ model: Record<string, unknown>; expected: boolean | undefined }> = [
    { model: { thinkingLevelMap: { off: null, low: "provider-low", high: "provider-high" } }, expected: true },
    { model: { thinkingLevelMap: { high: "provider-high" }, supportsReasoningEffort: false }, expected: false },
    { model: { supportsReasoningEffort: true }, expected: true },
    { model: {}, expected: undefined },
    { model: { thinkingLevelMap: {} }, expected: undefined },
    { model: { thinkingLevelMap: { turbo: "provider-turbo" } }, expected: undefined },
    { model: { thinkingLevelMap: { high: 1 } }, expected: undefined },
    { model: { thinkingLevelMap: { high: "x".repeat(4097) } }, expected: undefined },
    { model: { thinkingLevelMap: { high: "provider\nhigh" } }, expected: undefined },
  ];
  for (const entry of cases) {
    await secureWrite(item.env.PI_CATALOG_STATE!, { version: 2, updatedAt: 1, providers: [], nativeModels: [{ id: "native/model", canonicalId: "synthetic/model", ...entry.model }] });
    assert.equal((await loadRuntimeConfig(item.env)).stateSupportsReasoningEffort.get("native/model"), entry.expected);
  }
});

test("an existing specific native mapping with a provider thinking map does not block unrelated publication", { concurrency: false }, async () => {
  const item = await fixture(); await secureWrite(item.env.PI_AA_SETTINGS_CONFIG!, { enabledModels: ["native/existing"] }); await secureWrite(item.env.PI_AA_MODELS_CONFIG!, { providers: {} });
  await secureWrite(item.env.PI_CATALOG_STATE!, { version: 2, updatedAt: 1, providers: [], nativeModels: [{ id: "native/existing", canonicalId: "native/existing", supportsReasoningEffort: true }] });
  const initial = createAaService({ fetchCatalog: async () => catalog(), fetchPublicModel: async () => publicPage() }); await initial.add("native/existing", ID1, "high", undefined, item.env);

  await secureWrite(item.env.PI_AA_SETTINGS_CONFIG!, { enabledModels: ["native/existing", "runtime/model"] }); await secureWrite(item.env.PI_AA_MODELS_CONFIG!, { providers: { runtime: { compat: { supportsReasoningEffort: true } } } });
  const nativeModel = { id: "native/existing", canonicalId: "native/existing", thinkingLevelMap: { low: "provider-low", high: "provider-high" }, thinkingLevelMapProvenance: "provider" };
  await secureWrite(item.env.PI_CATALOG_STATE!, { version: 2, updatedAt: 1, providers: [], nativeModels: [nativeModel] });
  const otherRecord = { ...catalog(ID2).records[0]!, name: "Other Synthetic Model", slug: "other-synthetic-model" };
  const combined = { ...catalog(), records: [catalog().records[0]!, otherRecord] };
  const service = createAaService({ fetchCatalog: async () => combined, fetchPublicModel: async (_config, slug) => {
    const other = slug === otherRecord.slug; const page = publicPage(other ? ID2 : ID1); page.record.name = other ? otherRecord.name : "Synthetic Model"; page.record.slug = slug; page.provenance.url = `https://artificialanalysis.ai/models/${slug}`; return page;
  } });
  assert.equal((await service.add("runtime/model", ID2, null, undefined, item.env)).changed, true);

  await secureWrite(item.env.PI_CATALOG_STATE!, { version: 2, updatedAt: 1, providers: [], nativeModels: [{ ...nativeModel, supportsReasoningEffort: false }] });
  await assert.rejects(service.add("runtime/model", ID2, null, undefined, item.env), /does not support selectable/);
});
