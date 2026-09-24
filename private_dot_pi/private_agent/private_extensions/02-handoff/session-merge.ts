import { randomUUID } from "node:crypto";

export interface SessionEntryLike { type: string; id?: string; parentId?: string | null; [key: string]: unknown }
export interface ParsedSession { header: Record<string, unknown> | undefined; entries: SessionEntryLike[] }

export type MergePlan =
  | { kind: "refusal"; reason: string }
  | { kind: "up-to-date" }
  | { kind: "import"; mergeBase: string | null; entries: SessionEntryLike[]; branches: number; remoteOnly: number; localAhead: number };

/** Parse a session JSONL document. The first `session` line is metadata, the rest form the entry tree. */
export function parseSessionFile(text: string): ParsedSession {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  let header: Record<string, unknown> | undefined;
  const entries: SessionEntryLike[] = [];
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error("session document contains invalid JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session document contains a non-object line");
    const entry = value as SessionEntryLike;
    if (typeof entry.type !== "string") throw new Error("session entry is missing a type");
    if (entry.type === "session") { header ??= entry as Record<string, unknown>; continue; }
    if (typeof entry.id !== "string" || !entry.id) throw new Error("session entry is missing an id");
    entries.push(entry);
  }
  return { header, entries };
}

export function serializeSessionDocument(header: Record<string, unknown>, entries: SessionEntryLike[]): string {
  return [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function canonical(entry: SessionEntryLike): string { return JSON.stringify(entry); }

/**
 * Decide what a remote snapshot contributes to the local entry tree.
 *
 * Entry ids are unique per conversation, so the intersection of the two sides is the shared
 * lineage and each side's remainder is its own branch. Anything that cannot be grafted without
 * rewriting history is refused rather than guessed at.
 */
export function planMerge(localEntries: SessionEntryLike[], remoteEntries: SessionEntryLike[]): MergePlan {
  if (localEntries.length === 0 || remoteEntries.length === 0) return { kind: "refusal", reason: "one side has no conversation entries to merge" };
  const local = new Map(localEntries.map((entry) => [entry.id as string, entry]));
  const localIds = new Set(local.keys());
  const remoteIds = new Set(remoteEntries.map((entry) => entry.id as string));
  if (remoteIds.size !== remoteEntries.length) return { kind: "refusal", reason: "remote session repeats an entry id" };

  for (const entry of remoteEntries) {
    const id = entry.id as string;
    if (!localIds.has(id)) continue;
    if (canonical(local.get(id)!) !== canonical(entry)) return { kind: "refusal", reason: `entry id ${id} exists on both sides with different content` };
  }

  const imports = remoteEntries.filter((entry) => !localIds.has(entry.id as string));
  if (imports.length === 0) return { kind: "up-to-date" };

  const grafted = new Set(imports.map((entry) => entry.id as string));
  const graftPoints = new Set<string>();
  for (const entry of imports) {
    const parent = typeof entry.parentId === "string" ? entry.parentId : null;
    if (parent === null) continue;
    if (grafted.has(parent)) continue;
    if (!localIds.has(parent)) return { kind: "refusal", reason: `remote entry ${entry.id} descends from ${parent}, which this session does not contain` };
    graftPoints.add(parent);
  }
  const roots = imports.filter((entry) => typeof entry.parentId !== "string" || entry.parentId === null);
  if (roots.length > 0) return { kind: "refusal", reason: "remote session has orphan entries that cannot be attached to this session" };
  if (graftPoints.size === 0) return { kind: "refusal", reason: "no shared history was found between this session and the remote session" };
  const mergeBase = imports.find((entry) => typeof entry.parentId === "string" && localIds.has(entry.parentId))?.parentId as string | null;
  // Count turns this session has that the remote lacks, measured from the checkpoint along the live path.
  let localAhead = 0;
  let cursor = localEntries.at(-1);
  for (let steps = 0; cursor && steps <= localEntries.length; steps += 1) {
    if (!remoteIds.has(cursor.id as string)) localAhead += 1;
    const parent = typeof cursor.parentId === "string" ? cursor.parentId : null;
    if (parent === null || parent === mergeBase) break;
    cursor = local.get(parent);
  }
  return { kind: "import", mergeBase, entries: imports, branches: graftPoints.size, remoteOnly: imports.length, localAhead };
}

export function pluralTurns(count: number) { return `${count} ${count === 1 ? "turn" : "turns"}`; }

/** Human-facing summary of a divergence, used for both automatic detection and explicit pulls. */
export function describeDivergence(plan: Extract<MergePlan, { kind: "import" }>, alias: string): { summary: string; question: string } {
  const turns = pluralTurns(plan.remoteOnly);
  const summary = plan.localAhead === 0
    ? `Remote session on ${alias} is ${turns} ahead of this session.`
    : `Remote session on ${alias} diverges from local by ${turns} from checkpoint ${plan.mergeBase ?? "the shared history"}; this session has ${pluralTurns(plan.localAhead)} it does not.`;
  return { summary, question: `Retrieve those ${turns} from ${alias} into a new branch beside this session?` };
}

/**
 * Build the merged document. Imported entries are written first and the local entries keep their
 * original order, so the two branches sit side by side under their shared checkpoint.
 *
 * Pi takes the last entry in the file as the current position, which is how the landing spot is
 * encoded: context entries (handoff bookkeeping) are chained onto whichever branch the user chose to
 * end up on, and that chain ends the file. No post-switch navigation is needed, and the choice is
 * durable — reopening the file later lands in the same place.
 */
export function buildMergedDocument(options: {
  localHeader: Record<string, unknown> | undefined;
  localEntries: SessionEntryLike[];
  imported: SessionEntryLike[];
  localSessionFile: string;
  now: number;
  sessionId?: string;
  contextEntries?: Record<string, unknown>[];
  landOn?: "pulled" | "local";
}): { sessionId: string; fileName: string; text: string; leafId: string | undefined; pulledTipId: string | undefined } {
  const sessionId = options.sessionId ?? randomUUID();
  const timestamp = new Date(options.now).toISOString();
  const header: Record<string, unknown> = {
    type: "session",
    version: Number(options.localHeader?.version ?? 3),
    id: sessionId,
    timestamp,
    ...(options.localHeader?.cwd ? { cwd: options.localHeader.cwd } : {}),
    parentSession: options.localSessionFile,
  };
  const stamp = timestamp.replace(/[:.]/g, "-");
  // End of the pulled branch: the newest imported entry that no other imported entry descends from.
  const pulledTip = [...options.imported].reverse().find((entry) => entry.type === "message" && !options.imported.some((child) => child.parentId === entry.id));
  const pulledTipId = pulledTip?.id as string | undefined;
  // Pi assigns ids when appending to a live session; a file we write must carry its own ids and links.
  const chain = (parent: string | undefined) => (options.contextEntries ?? []).map((entry) => {
    const id = (entry.id as string | undefined) ?? randomUUID().replace(/-/g, "").slice(0, 8);
    const stamped = { ...entry, id, parentId: (entry.parentId as string | null | undefined) ?? parent ?? null, timestamp: entry.timestamp ?? timestamp };
    parent = id;
    return stamped;
  });
  const onLocal = chain(options.localEntries.at(-1)?.id as string | undefined);
  const onPulled = options.landOn === "pulled" && pulledTipId ? chain(pulledTipId) : [];
  // Where the session lands: the final entry of the file.
  const leafId = (onPulled.at(-1)?.id ?? onLocal.at(-1)?.id ?? options.localEntries.at(-1)?.id) as string | undefined;
  return {
    sessionId,
    fileName: `${stamp}_${sessionId}.jsonl`,
    text: serializeSessionDocument(header, [...options.imported, ...options.localEntries, ...onLocal, ...onPulled]),
    leafId,
    pulledTipId,
  };
}
