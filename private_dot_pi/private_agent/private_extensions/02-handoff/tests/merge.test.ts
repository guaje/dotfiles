import assert from "node:assert/strict";
import test from "node:test";
import { buildMergedDocument, parseSessionFile, planMerge, serializeSessionDocument } from "../session-merge.ts";

type Shape = { id: string; parentId: string | null };
const entry = (id: string, parentId: string | null, text = id): any => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: text } });
const shared: Shape[] = [entry("root", null, "start"), entry("a", "root"), entry("b", "a")];
const doc = (entries: any[]) => serializeSessionDocument({ type: "session", version: 3, id: "uuid-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" }, entries);

test("session documents round-trip and reject malformed lines", () => {
  const parsed = parseSessionFile(doc(shared));
  assert.equal(parsed.header?.id, "uuid-1");
  assert.deepEqual(parsed.entries.map((item) => item.id), ["root", "a", "b"]);
  assert.throws(() => parseSessionFile('{"type":"session"}\nnot json\n'), /invalid JSON/);
  assert.throws(() => parseSessionFile('{"type":"message","timestamp":"x"}\n'), /missing an id/);
});

test("a remote that has not moved reports no divergence", () => {
  const plan = planMerge(shared, shared.slice(0, 2));
  assert.deepEqual(plan, { kind: "up-to-date" });
});

test("remote-only turns are grafted at the point the histories diverged", () => {
  const remote = [...shared, entry("r1", "b"), entry("r2", "r1")];
  const plan = planMerge(shared, remote);
  assert.equal(plan.kind, "import");
  assert.equal(plan.kind === "import" && plan.mergeBase, "b");
  assert.deepEqual(plan.kind === "import" && plan.entries.map((item) => item.id), ["r1", "r2"]);
});

test("both sides moving produces two branches, not an overwrite", () => {
  const local = [...shared, entry("l1", "b")];
  const remote = [...shared, entry("r1", "b")];
  const plan = planMerge(local, remote);
  assert.equal(plan.kind === "import" && plan.entries.map((item) => item.id).join(","), "r1");
  assert.equal(plan.kind === "import" && plan.mergeBase, "b");
});

test("importing the same remote lineage twice imports nothing", () => {
  const remote = [...shared, entry("r1", "b")];
  const first = planMerge(shared, remote);
  assert.equal(first.kind, "import");
  const afterMerge = [...shared, ...(first.kind === "import" ? first.entries : [])];
  assert.deepEqual(planMerge(afterMerge, remote), { kind: "up-to-date" });
});

test("unrelated, colliding, and orphaned remotes are refused", () => {
  const reasonOf = (plan: any) => String(plan.reason ?? "");
  assert.match(reasonOf(planMerge(shared, [entry("x", null), entry("y", "x")])), /no shared history|orphan/);
  const conflict = shared.map((item) => ({ ...item, message: { role: "user", content: "rewritten" } }));
  assert.match(reasonOf(planMerge(shared, conflict)), /different content/);
  assert.match(reasonOf(planMerge(shared, [...shared, entry("r1", "gone")])), /which this session does not contain/);
  assert.match(reasonOf(planMerge([], shared)), /no conversation entries/);
});

test("the merged document keeps the user on their own branch", () => {
  const local = [...shared, entry("l1", "b")];
  const remote = [...shared, entry("r1", "b")];
  const plan = planMerge(local, remote) as any;
  const merged = buildMergedDocument({
    localHeader: parseSessionFile(doc(local)).header,
    localEntries: local,
    imported: plan.entries,
    localSessionFile: "/sessions/old.jsonl",
    now: Date.parse("2026-02-02T02:02:02.002Z"),
    sessionId: "11111111-2222-3333-4444-555555555555",
  });
  const parsed = parseSessionFile(merged.text);
  // Pi adopts the last entry in file order as the current position.
  assert.equal(parsed.entries.at(-1)?.id, "l1");
  assert.equal(merged.leafId, "l1");
  assert.ok(parsed.entries.some((item) => item.id === "r1"));
  assert.equal(parsed.header?.parentSession, "/sessions/old.jsonl");
  assert.equal(parsed.header?.cwd, "/repo");
  assert.equal(parsed.header?.version, 3);
  assert.equal(merged.fileName, "2026-02-02T02-02-02-002Z_11111111-2222-3333-4444-555555555555.jsonl");
  // The imported lineage is attached, not duplicated, and every parent resolves inside the file.
  const ids = new Set(parsed.entries.map((item) => item.id));
  assert.equal(parsed.entries.filter((item) => item.id === "r1").length, 1);
  for (const item of parsed.entries) assert.ok(item.parentId === null || ids.has(item.parentId), item.id);
});

test("divergence counts are measured from the checkpoint along the live path", () => {
  const local = [...shared, entry("l1", "b"), entry("l2", "l1")];
  const remote = [...shared, entry("r1", "b")];
  const plan = planMerge(local, remote) as any;
  assert.equal(plan.mergeBase, "b");
  assert.equal(plan.remoteOnly, 1);
  assert.equal(plan.localAhead, 2);
});

test("context entries chain onto the branch being worked on when staying local", () => {
  const merged = buildMergedDocument({
    localHeader: { version: 3 },
    localEntries: [...shared, entry("l1", "b")],
    imported: [entry("r1", "b"), entry("r2", "r1")],
    localSessionFile: "/repo/local.jsonl",
    now: 0,
    contextEntries: [{ type: "custom", customType: "handoff-context", data: { state: { syncState: "dirty" } } }],
    landOn: "local",
  });
  assert.equal(merged.pulledTipId, "r2");
  const parsed = parseSessionFile(merged.text);
  assert.deepEqual(parsed.entries.slice(0, 6).map((item: any) => item.id), ["r1", "r2", "root", "a", "b", "l1"]);
  const last = parsed.entries.at(-1) as any;
  assert.equal(last.customType, "handoff-context");
  assert.equal(last.parentId, "l1");
  assert.equal(merged.leafId, last.id);
});

test("the chosen landing spot is written into the file, not applied after the move", () => {
  const merged = buildMergedDocument({
    localHeader: { version: 3 },
    localEntries: [...shared, entry("l1", "b")],
    imported: [entry("r1", "b"), entry("r2", "r1")],
    localSessionFile: "/repo/local.jsonl",
    now: 0,
    contextEntries: [{ type: "custom", customType: "handoff-context", data: { state: { syncState: "dirty" } } }],
    landOn: "pulled",
  });
  const parsed = parseSessionFile(merged.text);
  const last = parsed.entries.at(-1) as any;
  assert.equal(last.parentId, "r2", "the file must end on the pulled branch so switching lands there");
  assert.equal(merged.leafId, last.id);
  // The local branch keeps its own copy, so either branch restores handoff state.
  assert.equal((parsed.entries.find((item: any, index: number) => index > 5 && item.id !== last.id) as any).parentId, "l1");
});

test("the pulled tip is the newest imported entry with no imported child", () => {
  const merged = buildMergedDocument({
    localHeader: { version: 3 },
    localEntries: [...shared],
    imported: [entry("r1", "b"), entry("r2", "r1"), entry("r3", "b")],
    localSessionFile: "/repo/local.jsonl",
    now: 0,
  });
  assert.equal(merged.pulledTipId, "r3");
});
