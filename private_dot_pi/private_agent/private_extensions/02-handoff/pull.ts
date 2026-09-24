import { buildMergedDocument, describeDivergence, parseSessionFile, planMerge, pluralTurns } from "./session-merge.ts";

export interface PullIo {
  /** Download the committed remote snapshot. */
  snapshot: () => Promise<Buffer>;
  /**
   * Cheap fingerprint check: true when the remote head is still the snapshot this session last
   * synchronized, which proves there is nothing to retrieve without downloading it.
   */
  headUnchanged?: () => Promise<boolean>;
  /** Read the JSONL of the session currently open. */
  localText: () => Promise<string>;
  /** Path of the session file currently open, recorded as the merged file's provenance. */
  localSessionFile: string;
  /** Return an identical merged session already on disk, so re-pulling does not create duplicates. */
  findExisting?: (text: string) => Promise<string | null>;
  /** Persist a merged document; returns its absolute path. */
  write: (fileName: string, text: string) => Promise<string>;
  /** Bookkeeping entries stored inside the merged file, e.g. handoff state that marks it pushable. */
  mergedContext?: (info: { imported: number; mergeBase: string | null }) => Record<string, unknown>[];
  /** Relocate this session onto `destination`. Returns false when declined or unsupported. */
  switchTo?: (destination: string) => Promise<boolean>;
  /** Speak after relocation, once the pre-switch context is stale. */
  announce?: (message: string, tone?: "info" | "warning") => Promise<void> | void;
  /** Yes/No prompt; false when no UI or the user declined. */
  ask: (title: string, detail: string) => Promise<boolean>;
  notify: (message: string, tone?: "info" | "warning" | "error") => void;
  now?: () => number;
}

export type PullReport =
  | { outcome: "clean"; prechecked?: boolean }
  | { outcome: "declined" | "refused" | "failed" }
  | {
      outcome: "imported";
      destination: string;
      imported: number;
      mergeBase: string | null;
      sessionId: string;
      reused: boolean;
      switched: boolean;
      position: "pulled" | "local";
    };

const SWITCH_QUESTION = "Go to the pulled turns? Both lines of work now live in one session and your own turns are untouched. Say yes to land at the end of the pulled turns; say no to stay where you are and reach them later with /tree.";

/**
 * Detect what the remote contributes and ask before retrieving it. Nothing is written until the user
 * agrees. Retrieval always lands in a merged session file that the live session then continues from —
 * a branch that is not in the current file cannot be reached with /tree — and where the user ends up
 * inside that file is a separate, explicit choice.
 */
export async function pullRemoteHistory(
  io: PullIo,
  options: { alias: string; assumeWanted?: boolean; announceClean?: boolean; prefix?: string; silentResult?: boolean } = { alias: "remote" },
): Promise<PullReport> {
  // "assumeWanted" skips only the consent question (explicit pull, or a push that met unread remote
  // turns and must merge before it may continue). "prefix" lets a caller label the flow honestly.
  const label = options.prefix ?? "Handoff pull";
  if (io.headUnchanged && await io.headUnchanged()) {
    if (options.announceClean !== false) io.notify(`Remote session on ${options.alias} is still at the snapshot this session last synchronized — nothing to pull`, "info");
    return { outcome: "clean", prechecked: true };
  }
  let plan: ReturnType<typeof planMerge>;
  let local: ReturnType<typeof parseSessionFile>;
  try {
    const [snapshot, text] = [await io.snapshot(), await io.localText()];
    local = parseSessionFile(text);
    plan = planMerge(local.entries, parseSessionFile(snapshot.toString("utf8")).entries);
  } catch (error) {
    io.notify(`Handoff pull failed: ${error instanceof Error ? error.message : String(error)} • nothing was changed`, "error");
    return { outcome: "failed" };
  }
  if (plan.kind === "refusal") {
    io.notify(`${label} refused: ${plan.reason} • nothing was changed`, "error");
    return { outcome: "refused" };
  }
  if (plan.kind === "up-to-date") {
    if (options.announceClean !== false) io.notify(`Remote session on ${options.alias} matches this session's history — no divergence found`, "info");
    return { outcome: "clean" };
  }

  // The divergence is always stated: consent needs it, and an assumed merge must not be silent.
  const words = describeDivergence(plan, options.alias);
  io.notify(words.summary, "info");
  if (!options.assumeWanted) {
    const wants = await io.ask("Pull remote history?", words.question);
    if (!wants) {
      io.notify(`Left the remote ${pluralTurns(plan.remoteOnly)} alone — run /ssh sync to converge, or /ssh pull to bring them in as a branch`, "info");
      return { outcome: "declined" };
    }
  }
  const goToPulled = await io.ask("Go to the pulled turns?", SWITCH_QUESTION);

  const merged = buildMergedDocument({
    localHeader: local.header,
    localEntries: local.entries,
    imported: plan.entries,
    localSessionFile: io.localSessionFile,
    now: (io.now ?? Date.now)(),
    contextEntries: io.mergedContext?.({ imported: plan.remoteOnly, mergeBase: plan.mergeBase }) ?? [],
    landOn: goToPulled ? "pulled" : "local",
  });

  let destination: string | null = null;
  let reused = false;
  try {
    destination = await io.findExisting?.(merged.text) ?? null;
    reused = Boolean(destination);
    if (!destination) destination = await io.write(merged.fileName, merged.text);
  } catch (error) {
    io.notify(`Handoff pull could not write the merged session: ${error instanceof Error ? error.message : String(error)} • nothing was changed`, "error");
    return { outcome: "failed" };
  }

  const switched = io.switchTo ? await io.switchTo(destination) : false;
  const done = reused
    ? `reused the merged session holding ${pluralTurns(plan.remoteOnly)} from ${options.alias}`
    : `imported ${pluralTurns(plan.remoteOnly)} from ${options.alias}`;
  if (options.silentResult) return { outcome: "imported", destination, imported: plan.remoteOnly, mergeBase: plan.mergeBase, sessionId: merged.sessionId, reused, switched, position: switched && goToPulled ? "pulled" : "local" };
  const message = !switched
    ? `${label}: ${done}, but the merged session could not be opened; it is at ${destination} — open it from /resume`
    : goToPulled
      ? `${label}: ${done} — you are now at the end of the pulled turns`
      : `${label}: ${done} — staying on your branch, and /tree lists the pulled turns beside it`;
  if (switched && io.announce) await io.announce(message, "info");
  else io.notify(message, switched ? "info" : "warning");
  return { outcome: "imported", destination, imported: plan.remoteOnly, mergeBase: plan.mergeBase, sessionId: merged.sessionId, reused, switched, position: switched && goToPulled ? "pulled" : "local" };
}
