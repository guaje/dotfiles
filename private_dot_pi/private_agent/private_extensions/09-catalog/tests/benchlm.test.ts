import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BenchLmClient } from "../benchlm/client.ts";
import { parseDetails, parseLeaderboard } from "../benchlm/schema.ts";
import { automaticBenchLmSlugCandidates, syncBenchLm } from "../benchlm/service.ts";

/* Fixtures are trimmed from live benchlm.ai responses captured on 2026-10-29: the leaderboard nests rows
 * under `models`, the per-model detail payload nests them under `benchmarks` and carries no
 * `sourceSnapshotId`. Inventing an envelope here is how the client shipped unable to read the real API. */
const METHODOLOGY = "bench-align-v5.8-2026-09-30";
const leaderboard = (models: unknown[] = [
  { rank: 3, model: "GPT-6 Astra", creator: "OpenAI", overallScore: 86.07, categoryScores: { agentic: 75.97, coding: 74.71, reasoning: 93.3, knowledge: 85.76, math: 97.3, multimodalGrounded: 88.2, multilingual: null, instructionFollowing: null }, categoryRanks: { coding: 5 }, categoryEvidence: { coding: "supported" }, evidenceStatus: "supported", interval90: null, inputPrice: 5, outputPrice: 30, sourceType: "api", methodologyVersion: METHODOLOGY },
  { rank: 9, model: "Kimi K2.6", creator: "Moonshot AI", overallScore: 71.4, categoryScores: { agentic: 60.1, coding: 58.9, reasoning: 70, knowledge: 66, math: null, multilingual: null, multimodalGrounded: null, instructionFollowing: null }, categoryEvidence: {}, evidenceStatus: "estimated", methodologyVersion: METHODOLOGY },
]) => ({ lastUpdated: "2026-10-29", mode: "public", methodologyVersion: METHODOLOGY, orderingMeaning: "point estimate", uncertaintyPolicy: { futureTruthValidated: false }, sourceSnapshotId: "2026-10-29-598e80f34326e96c", approvedSnapshotId: null, license: "CC BY-NC 4.0", licenseUrl: "https://creativecommons.org/licenses/by-nc/4.0/", termsUrl: "https://benchlm.ai/terms", commercialUse: { allowed: false }, attribution: "Data from BenchLM.ai", models });

const details = (overrides: Record<string, unknown> = {}) => ({
  page: "https://benchlm.ai/models/gpt-6-astra", lastUpdated: "2026-10-29", methodologyVersion: METHODOLOGY,
  license: "CC BY-NC 4.0", licenseUrl: "https://creativecommons.org/licenses/by-nc/4.0/", termsUrl: "https://benchlm.ai/terms",
  commercialUse: { allowed: false }, attribution: "Data from BenchLM.ai", sourceAttributions: [],
  model: { model: "GPT-6 Astra", slug: "gpt-6-astra", creator: "OpenAI", publicScore: 86.07, publicRank: 3, publicRankTotal: 216, evidenceStatus: "supported" },
  categories: [
    { key: "agentic", label: "Agentic", score: 76, rank: 7, total: 135 },
    { key: "coding", label: "Coding", score: 74.7, rank: 5, total: 156 },
    { key: "reasoning", label: "Reasoning", score: 93.3, rank: 1, total: 26 },
    { key: "instructionFollowing", label: "Instruction Following", score: null, rank: null, total: 40 },
  ],
  benchmarks: [
    { category: "agentic", categoryLabel: "Agentic", key: "browseComp", name: "BrowseComp", value: 91.5, formatted: "91.5%", verificationStatus: "provider_exact", verificationLabel: "Provider exact", source: { label: "OpenAI: GPT-6 Astra", url: "https://openai.com/index/gpt-6-astra/", retrievedAt: null } },
    { category: "instructionFollowing", categoryLabel: "Instruction Following", key: "ifbench", name: "IFBench", value: 62, formatted: "62.0%", verificationStatus: "benchmark_exact", verificationLabel: "Independently run", source: { label: "BenchLM run", url: null, retrievedAt: null } },
    { category: "instructionFollowing", categoryLabel: "Instruction Following", key: "airend", name: "Vendor self-report", value: 99, formatted: "99.0%", verificationStatus: "provider_exact", verificationLabel: "Provider exact", source: { label: "Vendor", url: null, retrievedAt: null } },
  ],
  sourceResultTables: [],
  ...overrides,
});

const mappingRow = { version: 1, methodologyVersion: METHODOLOGY, mappings: [{ runtimeId: "test-provider/test-model", canonicalId: "openai/gpt-6-astra", model: "GPT-6 Astra", creator: "OpenAI", slug: "gpt-6-astra" }] };
const expectedIdentity = { methodologyVersion: METHODOLOGY, model: "GPT-6 Astra", creator: "OpenAI", slug: "gpt-6-astra" };
const tmp = async () => { const dir = await mkdtemp(join(tmpdir(), "benchlm-")); return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }; };

test("the leaderboard reader accepts the published envelope and rejects an invented one", () => {
  assert.equal(parseLeaderboard(leaderboard()).rows.length, 2);
  assert.equal(parseLeaderboard(leaderboard()).envelope.sourceSnapshotId, "2026-10-29-598e80f34326e96c");
  // The client once assumed a `data` key that the service never returned; that shape must stay rejected.
  assert.throws(() => parseLeaderboard({ lastUpdated: "2026-10-29", methodologyVersion: METHODOLOGY, sourceSnapshotId: "snap", license: "CC BY-NC 4.0", data: leaderboard().models }), /envelope is invalid/);
});

test("a leaderboard row from another methodology stops the whole batch", () => {
  const rows = leaderboard([{ model: "GPT-6 Astra", creator: "OpenAI", overallScore: 86.07, categoryScores: {}, methodologyVersion: "bench-align-v9.9-2027-01-01" }]);
  assert.throws(() => parseLeaderboard(rows), /partial or malformed/);
});

test("a detail payload is accepted without a snapshot id but must be the model requested", () => {
  const parsed = parseDetails(details(), expectedIdentity);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.categories.find((entry) => entry.key === "coding")?.score, 74.7);
  assert.throws(() => parseDetails(details({ model: { model: "Someone Else", slug: "gpt-6-astra", creator: "OpenAI" } }), expectedIdentity), /different model than requested/);
  assert.throws(() => parseDetails(details({ methodologyVersion: "bench-align-v9.9-2027-01-01" }), expectedIdentity), /detail envelope is invalid/);
});

test("a published category figure is never replaced by our own average of its rows", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const mappingsFile = join(dir, "mappings.json"), root = join(dir, "assets");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(mappingsFile, JSON.stringify(mappingRow));
    const client = { leaderboard: async () => leaderboard(), details: async () => details() };
    const result = await syncBenchLm({ client: client as never, mappingsFile, root, enabledModels: ["test-provider/test-model"] });
    const manifest = result.manifest!;
    assert.equal(result.published, true);
    const raw = JSON.parse(await readFile(join(root, "models", manifest.models[0]!.file), "utf8")) as { benchlm?: Record<string, unknown> };
    const snapshot = raw.benchlm ?? raw;
    assert.equal(snapshot.categoryScores.coding, 74.71, "BenchLM's published coding figure survives untouched");
    assert.equal(snapshot.categoryProvenance.coding, "leaderboard");
    assert.equal(snapshot.categoryScores.agentic, 75.97);
    // They publish no instruction-following figure for this model, so we must publish none either. Deriving
    // one from its rows (an independently run 62 and a vendor self-reported 99) would invent a metric on a
    // scale BenchLM never scored, which is how a model ends up ranked on a number nobody published.
    assert.equal("instructionFollowing" in snapshot.categoryScores, false);
    assert.deepEqual(snapshot.categoryEvidence.instructionFollowing, { rows: 2, independentlyVerified: 1 }, "the missing figure is recorded as thin evidence, not filled in");
    assert.equal(snapshot.attribution, "Data from BenchLM.ai");
    assert.equal(snapshot.license, "CC BY-NC 4.0");
    assert.equal(snapshot.sourceSnapshotId, "2026-10-29-598e80f34326e96c");
  } finally { await cleanup(); }
});

test("publication stops without writing when the methodology version moves", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const mappingsFile = join(dir, "mappings.json"), root = join(dir, "assets");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(mappingsFile, JSON.stringify(mappingRow));
    const moved = { ...leaderboard(), methodologyVersion: "bench-align-v9.9-2027-01-01", models: leaderboard().models.map((row: any) => ({ ...row, methodologyVersion: "bench-align-v9.9-2027-01-01" })) };
    const client = { leaderboard: async () => moved, details: async () => { throw new Error("must not fetch details"); } };
    await assert.rejects(syncBenchLm({ client: client as never, mappingsFile, root, enabledModels: ["test-provider/test-model"] }), /methodology changed|partial or malformed/);
    assert.equal(existsSync(join(root, "benchlm-manifest.json")), false);
  } finally { await cleanup(); }
});

test("an enabled model with no reviewed row reports while the reviewed subset still publishes", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const mappingsFile = join(dir, "mappings.json"), root = join(dir, "assets");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(mappingsFile, JSON.stringify(mappingRow));
    const client = { leaderboard: async () => leaderboard(), details: async () => details() };
    // First publish to have a generation on disk that routing serves.
    const first = await syncBenchLm({ client: client as never, mappingsFile, root, enabledModels: ["test-provider/test-model"] });
    assert.equal(first.published, true);
    // An endpoint with no reviewed mapping must not withhold the whole BenchLM generation: the reviewed
    // subset publishes, the unmapped endpoint is reported for review, and it routes on Artificial Analysis.
    const second = await syncBenchLm({ client: client as never, mappingsFile, root, enabledModels: ["test-provider/test-model", "test-provider/unmapped-model"] });
    assert.equal(second.published, true);
    assert.deepEqual(second.unmapped, ["test-provider/unmapped-model"]);
    assert.deepEqual(second.manifest?.models.map((entry) => entry.runtimeId), ["test-provider/test-model"]);
    assert.match(second.warnings.join("\n"), /no reviewed row/);
    const served = JSON.parse(await readFile(join(root, "benchlm-manifest.json"), "utf8"));
    assert.deepEqual(served.models.map((entry: any) => entry.runtimeId), ["test-provider/test-model"], "the reviewed subset keeps routing on BenchLM");
  } finally { await cleanup(); }
});

test("a detail fetch failure leaves no partial generation behind", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const mappingsFile = join(dir, "mappings.json"), root = join(dir, "assets");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(mappingsFile, JSON.stringify(mappingRow));
    const client = { leaderboard: async () => leaderboard(), details: async () => { throw new Error("upstream 503"); } };
    await assert.rejects(syncBenchLm({ client: client as never, mappingsFile, root, enabledModels: ["test-provider/test-model"] }), /upstream 503/);
    assert.equal(existsSync(root), false, "nothing is published when a fetch fails");
  } finally { await cleanup(); }
});

test("the client retries a server failure over HTTPS and refuses oversized bodies", async () => {
  const seen: string[] = [];
  let calls = 0;
  const client = new BenchLmClient({ attempts: 2, backoffMs: 0, fetch: (async (input: RequestInfo | URL) => { seen.push(String(input)); calls++; return calls === 1 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify(leaderboard()), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch });
  const body = await client.leaderboard();
  assert.equal(calls, 2);
  assert.ok(seen.every((url) => url.startsWith("https://benchlm.ai/")));
  assert.ok(parseLeaderboard(body).rows.length === 2);
  const tooBig = new BenchLmClient({ attempts: 1, maxBytes: 8, fetch: (async () => new Response("0123456789", { status: 200 })) as typeof fetch });
  await assert.rejects(tooBig.leaderboard(), /byte limit/);
  const notFound = new BenchLmClient({ attempts: 2, backoffMs: 0, fetch: (async () => new Response("nope", { status: 404 })) as typeof fetch });
  await assert.rejects(notFound.leaderboard(), /HTTP status 404/);
});

test("a model slug that is not a safe path segment is refused before any request", async () => {
  const client = new BenchLmClient({ attempts: 1, fetch: (async () => { throw new Error("must not fetch"); }) as typeof fetch });
  await assert.rejects(client.details("../../etc/passwd"), /unsafe BenchLM model identity/);
});

test("a model missing from the capped leaderboard page still publishes from its own page", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const mappingsFile = join(dir, "mappings.json"), root = join(dir, "assets");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(mappingsFile, JSON.stringify(mappingRow));
    // The published leaderboard lists only its top slice; long-tail models we enable are simply not on it.
    // A page that is not empty, simply does not list our model: it ranks below the published cut.
    const client = { leaderboard: async () => leaderboard(leaderboard().models.slice(1)), details: async () => details() };
    const result = await syncBenchLm({ client: client as never, mappingsFile, root, enabledModels: ["test-provider/test-model"] });
    const manifest = result.manifest!;
    assert.equal(result.published, true);
    const raw = JSON.parse(await readFile(join(root, "models", manifest.models[0]!.file), "utf8")) as { benchlm?: Record<string, unknown> };
    const snapshot = raw.benchlm ?? raw;
    assert.equal(snapshot.categoryScores.coding, 74.7, "the figure from the model's own page is used");
    assert.equal(snapshot.categoryProvenance.coding, "published-category");
    assert.equal(snapshot.sourceSnapshotId, "2026-10-29-598e80f34326e96c", "fleet provenance still comes from the leaderboard envelope");
  } finally { await cleanup(); }
});

test("endpoint name variants resolve to the same exact BenchLM profile", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const mappingsFile = join(dir, "mappings.json"), root = join(dir, "assets");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(mappingsFile, JSON.stringify({ version: 1, methodologyVersion: METHODOLOGY, mappings: [] }));
    const profile = details({ model: { model: "Model Alpha", slug: "model3-8-beta", creator: "Test Provider", publicScore: 50, publicRank: 90, publicRankTotal: 216, evidenceStatus: "supported" } });
    const requested: string[] = [];
    const client = { leaderboard: async () => leaderboard(), details: async (slug: string) => { requested.push(slug); if (slug !== "model3-8-beta") throw new Error("BenchLM HTTP status 404"); return profile; } };
    const result = await syncBenchLm({ client: client as never, mappingsFile, root, enabledModels: ["test-provider/model-3.8-beta"] });
    assert.equal(result.published, true);
    assert.deepEqual(requested, ["model-3-8-beta", "model3-8-beta"], "a presentation-only separator variant tries the exact published slug once");
    assert.deepEqual(JSON.parse(await readFile(mappingsFile, "utf8")).mappings.map((entry: { slug: string; matchBasis: string }) => [entry.slug, entry.matchBasis]), [["model3-8-beta", "automatic-exact-slug"]]);
  } finally { await cleanup(); }
});

test("a hardware deployment suffix resolves to the model's own profile", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const mappingsFile = join(dir, "mappings.json"), root = join(dir, "assets");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(mappingsFile, JSON.stringify({ version: 1, methodologyVersion: METHODOLOGY, mappings: [] }));
    const profile = details({ model: { model: "Model Alpha", slug: "model3-8-beta", creator: "Test Provider" } });
    const client = { leaderboard: async () => leaderboard(), details: async (slug: string) => { if (slug !== "model3-8-beta") throw new Error("BenchLM HTTP status 404"); return profile; } };
    const result = await syncBenchLm({ client: client as never, mappingsFile, root, enabledModels: ["test-provider/model-3.8-beta-h100"] });
    assert.equal(result.published, true);
    assert.deepEqual(JSON.parse(await readFile(mappingsFile, "utf8")).mappings.map((entry: { runtimeId: string; slug: string }) => [entry.runtimeId, entry.slug]), [["test-provider/model-3.8-beta-h100", "model3-8-beta"]]);
  } finally { await cleanup(); }
});

test("a quantized deployment never borrows another artifact's evidence", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const mappingsFile = join(dir, "mappings.json"), root = join(dir, "assets");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(mappingsFile, JSON.stringify({ version: 1, methodologyVersion: METHODOLOGY, mappings: [] }));
    let requested = 0;
    const client = { leaderboard: async () => leaderboard(), details: async () => { requested++; return details(); } };
    const result = await syncBenchLm({ client: client as never, mappingsFile, root, enabledModels: ["test-provider/model-3.8-beta-fp8"] });
    assert.equal(result.published, false);
    assert.deepEqual(result.unmapped, ["test-provider/model-3.8-beta-fp8"]);
    assert.equal(requested, 0, "no other artifact is fetched as a substitute");
  } finally { await cleanup(); }
});

test("automatic matching stays unmapped when no candidate page names the requested slug", async () => {
  const { dir, cleanup } = await tmp();
  try {
    const mappingsFile = join(dir, "mappings.json"), root = join(dir, "assets");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(mappingsFile, JSON.stringify({ version: 1, methodologyVersion: METHODOLOGY, mappings: [] }));
    const wrongSlug = details({ model: { model: "Model Alpha", slug: "other-model", creator: "Test Provider" } });
    const client = { leaderboard: async () => leaderboard(), details: async () => wrongSlug };
    const result = await syncBenchLm({ client: client as never, mappingsFile, root, enabledModels: ["test-provider/model-3.8-beta"] });
    assert.equal(result.published, false);
    assert.deepEqual(result.unmapped, ["test-provider/model-3.8-beta"]);
  } finally { await cleanup(); }
});

test("automatic candidates are exact, safe, and refuse quantized model artifacts", () => {
  assert.deepEqual(automaticBenchLmSlugCandidates("test-provider/model-3.8-beta"), ["model-3-8-beta", "model3-8-beta"]);
  assert.deepEqual(automaticBenchLmSlugCandidates("test-provider/model-3.8-beta-h100"), ["model-3-8-beta", "model3-8-beta"]);
  assert.deepEqual(automaticBenchLmSlugCandidates("test-provider/model-3.8-beta-fp8"), []);
  assert.deepEqual(automaticBenchLmSlugCandidates("test-provider/not_a_slug"), []);
});
