import assert from "node:assert/strict";
import test from "node:test";
import { pullRemoteHistory } from "../pull.ts";
import { serializeSessionDocument } from "../session-merge.ts";

const entry = (id: string, parentId: string | null): any => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: id } });
const doc = (entries: any[]) => serializeSessionDocument({ type: "session", version: 3, id: "uuid", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" }, entries);
const shared = [entry("root", null), entry("a", "root"), entry("b", "a")];

function harness(remoteEntries: any[], localEntries: any[], answers: boolean[] = [], existing: string | null = null) {
  const notifications: Array<[string, string | undefined]> = [];
  const questions: string[] = [];
  const writes: Array<{ fileName: string; text: string }> = [];
  const switches: Array<{ destination: string }> = [];
  let asked = 0;
  const io = {
    localSessionFile: "/sessions/local.jsonl",
    snapshot: async () => Buffer.from(doc(remoteEntries)),
    localText: async () => doc(localEntries),
    findExisting: existing === null ? undefined : async () => existing,
    write: async (fileName: string, text: string) => { writes.push({ fileName, text }); return `/sessions/${fileName}`; },
    mergedContext: () => [{ type: "custom", customType: "handoff-context", data: { state: { syncState: "dirty" } } }],
    switchTo: async (destination: string) => { switches.push({ destination }); return true; },
    announce: (message: string, tone?: string) => { notifications.push([message, tone]); },
    ask: async (title: string, detail: string) => { questions.push(`${title} :: ${detail}`); return answers[asked++] ?? false; },
    notify: (message: string, tone?: string) => notifications.push([message, tone]),
    now: () => Date.parse("2026-02-02T02:02:02.002Z"),
  };
  return { io: io as any, notifications, questions, writes, switches };
}
const texts = (runs: ReturnType<typeof harness>) => runs.notifications.map(([message]) => message).join("\n");
/** True when the merged file's last entry descends from `entryId`, i.e. that is where the session lands. */
function endsOn(text: string, entryId: string) {
  const entries = text.trim().split("\n").slice(1).map((line) => JSON.parse(line));
  const last = entries.at(-1)!;
  const chain: string[] = [];
  for (let cursor: any = last; cursor; cursor = entries.find((item: any) => item.id === cursor.parentId)) chain.push(cursor.id);
  return chain.includes(entryId);
}

test("divergence is reported with counts and the checkpoint, then confirmed twice", async () => {
  const runs = harness([...shared, entry("r1", "b"), entry("r2", "b")], [...shared, entry("l1", "b")], [true, true]);
  const report = await pullRemoteHistory(runs.io, { alias: "gb200" });
  assert.equal(report.outcome, "imported");
  assert.match(texts(runs), /gb200 diverges from local by 2 turns from checkpoint b/);
  assert.match(texts(runs), /this session has 1 turn it does not/);
  assert.equal(runs.questions.length, 2);
  assert.match(runs.questions[0]!, /^Pull remote history\? :: Retrieve those 2 turns from gb200/);
  assert.match(runs.questions[1]!, /^Go to the pulled turns\?/);
  assert.match(runs.questions[1]!, /say no to stay where you are/i);
  assert.equal(runs.writes.length, 1);
  assert.equal(runs.switches.length, 1);
  assert.equal(endsOn(runs.writes[0]!.text, "r2"), true, "the file must end on the pulled branch");
  assert.equal(report.outcome === "imported" && report.position, "pulled");
  assert.match(texts(runs), /you are now at the end of the pulled turns/);
});

test("staying on the working branch still relocates so /tree can see the pulled turns", async () => {
  const runs = harness([...shared, entry("r1", "b")], [...shared, entry("l1", "b")], [true, false]);
  const report = await pullRemoteHistory(runs.io, { alias: "gb200" });
  assert.equal(report.outcome, "imported");
  assert.equal(runs.switches.length, 1);
  assert.equal(endsOn(runs.writes[0]!.text, "l1"), true, "staying local must keep this branch last");
  assert.equal(report.outcome === "imported" && report.position, "local");
  assert.match(texts(runs), /staying on your branch, and \/tree lists the pulled turns/);
});

test("a forked remote branch is entered at its newest end", async () => {
  // r1 has two children on the remote; the pulled branch ends at the newest of them.
  const runs = harness([...shared, entry("r1", "b"), entry("r2", "r1"), entry("r3", "r1")], [...shared, entry("l1", "b")], [true, true]);
  await pullRemoteHistory(runs.io, { alias: "gb200" });
  assert.equal(endsOn(runs.writes[0]!.text, "r3"), true);
});

test("a re-pull reuses the merged session instead of writing a duplicate", async () => {
  const runs = harness([...shared, entry("r1", "b")], [...shared, entry("l1", "b")], [true, true], "/sessions/merged-earlier.jsonl");
  const report = await pullRemoteHistory(runs.io, { alias: "gb200" });
  assert.equal(report.outcome, "imported");
  assert.deepEqual(runs.writes, []);
  assert.equal(runs.switches[0]!.destination, "/sessions/merged-earlier.jsonl");
  assert.equal(report.outcome === "imported" && report.reused, true);
  assert.match(texts(runs), /reused the merged session holding 1 turn from gb200/);
});

test("a remote that simply moved ahead is worded as ahead, not diverged", async () => {
  const runs = harness([...shared, entry("r1", "b")], shared, [true, true]);
  await pullRemoteHistory(runs.io, { alias: "gb200" });
  assert.match(texts(runs), /gb200 is 1 turn ahead of this session\./);
  assert.doesNotMatch(texts(runs), /diverges/);
});

test("declining the offer writes nothing and points at /ssh pull", async () => {
  const runs = harness([...shared, entry("r1", "b")], [...shared, entry("l1", "b")], [false]);
  const report = await pullRemoteHistory(runs.io, { alias: "gb200" });
  assert.equal(report.outcome, "declined");
  assert.deepEqual(runs.writes, []);
  assert.deepEqual(runs.switches, []);
  assert.match(texts(runs), /\/ssh pull to bring them in as a branch/);
  assert.match(texts(runs), /\/ssh sync to converge/);
});

test("a session the user cannot leave still reports where the merge went", async () => {
  const runs = harness([...shared, entry("r1", "b")], [...shared, entry("l1", "b")], [true, true]);
  runs.io.switchTo = async () => false;
  const report = await pullRemoteHistory(runs.io, { alias: "gb200" });
  assert.equal(report.outcome, "imported");
  assert.equal(report.outcome === "imported" && report.switched, false);
  assert.match(texts(runs), /could not be opened/);
  assert.equal(runs.notifications.at(-1)![1], "warning");
});

test("detection confirms a clean match, and can be told to stay quiet", async () => {
  const loud = harness(shared, [...shared, entry("l1", "b")]);
  assert.equal((await pullRemoteHistory(loud.io, { alias: "gb200" })).outcome, "clean");
  assert.equal(loud.notifications.length, 1);
  assert.match(texts(loud), /matches this session's history — no divergence found/);
  assert.equal(loud.questions.length, 0);

  const quiet = harness(shared, [...shared, entry("l1", "b")]);
  assert.equal((await pullRemoteHistory(quiet.io, { alias: "gb200", announceClean: false })).outcome, "clean");
  assert.deepEqual(quiet.notifications, []);
});

test("an explicit pull states what it found, then asks only where to land", async () => {
  const runs = harness([...shared, entry("r1", "b")], shared, [true]);
  const report = await pullRemoteHistory(runs.io, { alias: "gb200", assumeWanted: true });
  assert.equal(report.outcome, "imported");
  assert.equal(runs.questions.length, 1);
  assert.match(runs.questions[0]!, /^Go to the pulled turns\?/);
  assert.match(texts(runs), /gb200 is 1 turn ahead of this session\./);
  assert.match(texts(runs), /Handoff pull: imported 1 turn from gb200/);
});

test("unmergeable remotes and transport failures change nothing", async () => {
  const unrelated = harness([entry("x", null), entry("y", "x")], shared);
  assert.equal((await pullRemoteHistory(unrelated.io, { alias: "gb200" })).outcome, "refused");
  assert.match(texts(unrelated), /nothing was changed/);
  assert.deepEqual(unrelated.writes, []);

  const broken = harness(shared, shared);
  broken.io.snapshot = async () => { throw new Error("SSH operation timed out"); };
  assert.equal((await pullRemoteHistory(broken.io, { alias: "gb200" })).outcome, "failed");
  assert.match(texts(broken), /SSH operation timed out/);
  assert.deepEqual(broken.writes, []);

  const unwritable = harness([...shared, entry("r1", "b")], shared, [true, true]);
  unwritable.io.write = async () => { throw new Error("EACCES: permission denied"); };
  assert.equal((await pullRemoteHistory(unwritable.io, { alias: "gb200" })).outcome, "failed");
  assert.deepEqual(unwritable.switches, []);
  assert.match(texts(unwritable), /permission denied • nothing was changed/);
});

test("bookkeeping entries are stored in the merged document, not written after the move", async () => {
  const runs = harness([...shared, entry("r1", "b")], [...shared, entry("l1", "b")], [true, true]);
  await pullRemoteHistory(runs.io, { alias: "gb200" });
  const destination = runs.switches[0]!.destination;
  assert.ok(destination.includes(runs.writes[0]!.fileName));
  assert.match(runs.writes[0]!.text, /handoff-context/);
});

test("an unchanged remote head is settled by its fingerprint, without downloading", async () => {
  const runs = harness([...shared, entry("r1", "b")], shared, [true, true]);
  let downloads = 0;
  runs.io.snapshot = async () => { downloads += 1; return Buffer.from(doc(shared)); };
  runs.io.headUnchanged = async () => true;
  const report = await pullRemoteHistory(runs.io, { alias: "gb200" });
  assert.equal(report.outcome, "clean");
  assert.equal(report.outcome === "clean" && report.prechecked, true);
  assert.equal(downloads, 0, "a matching fingerprint proves there is nothing to retrieve");
  assert.equal(runs.questions.length, 0);
  assert.match(texts(runs), /still at the snapshot this session last synchronized — nothing to pull/);
});

test("a head this session never recorded falls back to the real comparison", async () => {
  const runs = harness([...shared, entry("r1", "b")], shared, [true, true]);
  let downloads = 0;
  const text = doc([...shared, entry("r1", "b")]);
  runs.io.snapshot = async () => { downloads += 1; return Buffer.from(text); };
  runs.io.headUnchanged = async () => false;
  assert.equal((await pullRemoteHistory(runs.io, { alias: "gb200" })).outcome, "imported");
  assert.equal(downloads, 1);
});

test("a sync-initiated merge states the divergence, asks only where to land, and lets the caller narrate", async () => {
  const runs = harness([...shared, entry("r1", "b"), entry("r2", "b")], [...shared, entry("l1", "b")], [true]);
  const report = await pullRemoteHistory(runs.io, { alias: "gb200", assumeWanted: true, prefix: "Handoff sync", silentResult: true });
  assert.equal(report.outcome, "imported");
  assert.equal(runs.questions.length, 1, "consent came from running sync; only the landing is a question");
  assert.match(runs.questions[0]!, /^Go to the pulled turns\?/);
  assert.match(texts(runs), /gb200 diverges from local by 2 turns from checkpoint b/);
  assert.equal(runs.writes.length, 1);
  assert.equal(runs.switches.length, 1);
  assert.equal(report.outcome === "imported" && report.position, "pulled");
  assert.equal(endsOn(runs.writes[0]!.text, "r2"), true, "the file ends on the chosen branch");
  assert.doesNotMatch(texts(runs), /Handoff (pull|sync):/, "the caller owns the result wording");
});

test("a sync-initiated merge stays on the working branch when told no, and stays quiet about it", async () => {
  const runs = harness([...shared, entry("r1", "b")], [...shared, entry("l1", "b")], [false]);
  const report = await pullRemoteHistory(runs.io, { alias: "gb200", assumeWanted: true, prefix: "Handoff sync", silentResult: true });
  assert.equal(report.outcome, "imported");
  assert.equal(report.outcome === "imported" && report.position, "local");
  assert.equal(endsOn(runs.writes[0]!.text, "l1"), true, "the working branch stays last");
  assert.match(runs.writes[0]!.text, /handoff-context/, "bookkeeping still rides in the file");
  assert.equal(runs.notifications.length, 1, "only the divergence summary is spoken");
});
