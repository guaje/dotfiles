import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheRoot } from "./config.ts";
import { createChunkSizer, type ChunkSizer } from "./chunk-sizing.ts";
import { getHandoffSettings, registerHandoffShortcut } from "./settings.ts";
import { notifyRemoteRouteChanged, setRemoteBashBackend } from "./backend-registry.ts";
import { createRemoteOperations } from "./operations.ts";
import { discoverSshHosts, validateManualTarget } from "./ssh-config.ts";
import { applyRemoteSessionAction, initialState, restoreState, toggleToolRoute } from "./state.ts";
import { handoffHudVariants, handoffStatusDetail } from "./status.ts";
import { registerHudItem, type HudItemHandle } from "../00-hud/api.ts";
import { materializeSession } from "./session-materializer.ts";
import { ensureRemoteHelper } from "./installer.ts";
import { shellLiteral, shellTest, sshExec, sshGetConfig } from "./transport.ts";
import { requestGate, fetchSnapshot, remoteManifest, synchronize } from "./sync.ts";
import { pullRemoteHistory, type PullIo } from "./pull.ts";
import type { HandoffState, RemoteTarget, SyncProgress } from "./types.ts";
import { selectLabeledOption as select } from "./ui.ts";
import { chooseWorkspace } from "./choose-workspace.ts";
import { authorizedRemoteOperations } from "./remote-authorization.ts";
import { dispatchConnectedAction } from "./connection-actions.ts";

function appendContext(pi: any, state: HandoffState) { pi.appendEntry?.({ type: "custom", customType: "handoff-context", data: { state } }); }
function syncFailureNotice(syncState: string, reason?: string): string {
  const lead = syncState === "conflict" ? "Handoff sync conflict" : "Handoff sync failed";
  return `${lead}: ${reason || "remote could not be reached"} • changes retained locally`;
}
function restored(branch: any[]): HandoffState { for (let i = branch.length - 1; i >= 0; i--) { const entry = branch[i]; if (entry?.type === "custom" && entry.customType === "handoff-context") return restoreState(entry.data?.state); } return initialState(); }

export default async function handoff(pi: ExtensionAPI) {
  const settings = await getHandoffSettings();
  let state = initialState(); let activeCtx: any; let hud: HudItemHandle | undefined; let disposeBackend: (() => void) | undefined;
  const setState = (next: HandoffState, persist = true) => { state = next; notifyRemoteRouteChanged(); hud?.update({ variants: handoffHudVariants(state), visible: true }); if (persist) appendContext(pi, state); };
  const remote = () => state.target && state.connection === "connected" && state.toolRoute === "remote" ? createRemoteOperations({ alias: state.target.alias, user: state.target.user, port: state.target.port, workspace: state.target.workspace, localCwd: activeCtx?.cwd ?? process.cwd() }) : undefined;
  const chooseWorkspaceDeps = { sshExec, selectLabeledOption: select, shellLiteral, shellTest };
  /** Measured link quality, kept per host under the Handoff cache; advisory only. */
  let sizerPromise: Promise<ChunkSizer> | undefined;
  const sizer = () => (sizerPromise ??= createChunkSizer());
  /** Set while a push found unread remote turns: the relocation finishes the push in the replacement context. */
  let pushAfterMerge = false;
  /** HUD-scale progress; chunk counts while sending, bytes while reading. */
  const reportProgress = (update: SyncProgress) => hud?.update({ variants: handoffHudVariants(state, update), visible: true });
  const resumeRemoteSession = async (ctx: any, target: RemoteTarget) => {
    try {
      const sessionsResult = await requestGate(target, "list-sessions") as { ok: boolean; sessions?: string[]; error?: string };
      if (sessionsResult.ok && sessionsResult.sessions && sessionsResult.sessions.length > 0) {
        const sessionChoice = await select(ctx, "Resume session", sessionsResult.sessions.map((sid) => ({ label: sid, value: sid })));
        if (sessionChoice) {
          setState(applyRemoteSessionAction({ ...state, connection: "connected", target }, "resume", sessionChoice));
          // A foreign lineage is now attached to this session: detect and offer before work continues.
          await pull(ctx, { assumeWanted: false });
        }
        // Cancellation is not consent to create a new remote session.
        return;
      }
    } catch { return ctx.ui?.notify?.("Could not list remote sessions", "warning"); }
    return ctx.ui?.notify?.("No remote sessions available to resume", "info");
  };
  /**
   * Adapter from the extension's command context to the UI-free pull pipeline. Once the session has
   * been relocated the pre-switch `ctx` and `pi` are stale, so anything the merge must persist travels
   * inside the merged file and anything it must say goes through the replacement-session context.
   */
  const pullIo = (ctx: any): PullIo => {
    const localFile = ctx.sessionManager.getSessionFile?.() as string | undefined;
    const sessionDir = () => ctx.sessionManager.getSessionDir?.() ?? join(localFile ?? ".", "..");
    let replacement: any;
    // The snapshot's manifest is observed while downloading so the merged session can record the remote
    // head it now contains; that record is what authorizes the next push.
    let head: { generation: number; hash: string } | undefined;
    let mergedTurns = 0;
    return {
      localSessionFile: localFile ?? "",
      snapshot: async () => {
        const measured = await sizer();
        const started = Date.now();
        const data = await fetchSnapshot(state.target!, state.sessionId!, requestGate, measured.pick(state.target!), { observe: (manifest) => { head = manifest; } });
        measured.record(state.target!, { bytes: data.length, ms: Date.now() - started, ok: true });
        return data;
      },
      headUnchanged: async () => {
        const seen = state.manifest?.hash;
        if (!seen) return false; // never synchronized from a recorded head: do the real comparison
        return (await remoteManifest(state.target!, state.sessionId!))?.hash === seen;
      },
      localText: () => readFile(localFile as string, "utf8"),
      findExisting: async (text) => {
        for (const name of await readdir(sessionDir())) {
          const candidate = join(sessionDir(), name);
          if (!name.endsWith(".jsonl") || candidate === localFile) continue;
          if (await readFile(candidate, "utf8").catch(() => "") === text) return candidate;
        }
        return null;
      },
      write: async (fileName, text) => {
        const destination = join(sessionDir(), fileName);
        await writeFile(destination, text, { flag: "wx", mode: 0o600 });
        return destination;
      },
      // The merged session carries the remote turns, so it must be pushed back. This rides along as a
      // session entry because the current context cannot write to the session after a relocation.
      mergedContext: ({ imported, mergeBase }) => {
        mergedTurns = imported;
        return [
        { type: "custom", customType: "handoff-context", data: { state: { ...state, syncState: "dirty", syncReason: undefined, ...(head ? { manifest: head } : {}) } } },
        { type: "custom", customType: "handoff-merge", data: { remoteSessionId: state.sessionId, alias: state.target?.alias, imported, mergeBase } },
        ];
      },
      // The merged file already ends on the chosen branch, so switching alone lands the session there.
      switchTo: async (destination) => {
        const result = await ctx.switchSession?.(destination, {
          withSession: async (next: any) => {
            replacement = next;
            if (!pushAfterMerge) return;
            pushAfterMerge = false;
            // A push that met unread remote turns merges them in and finishes here, where the context is live.
            const merged: HandoffState = { ...state, syncState: "syncing", syncReason: undefined, manifest: head ?? state.manifest };
            const measured = await sizer();
            const pushed = await synchronize(merged, destination, {
              confirmRecovery: (message) => next.ui.confirm("Recover stale Handoff lock?", message),
              pickChunkBytes: (target, negotiated) => measured.pick(target, negotiated),
              onTransferSample: (sample) => measured.record(state.target!, sample),
            });
            const words = pushed.syncState === "clean"
              ? `Handoff sync: merged ${mergedTurns} remote ${mergedTurns === 1 ? "turn" : "turns"} in as a branch and pushed the combined session to ${state.target?.alias}`
              : syncFailureNotice(pushed.syncState, pushed.syncReason);
            next.ui?.notify?.(words, pushed.syncState === "clean" ? "info" : "error");
          },
        });
        return !result?.cancelled;
      },
      announce: (message, tone) => (replacement?.ui ?? ctx.ui)?.notify?.(message, tone ?? "info"),
      ask: async (title, detail) => Boolean(ctx.ui?.confirm && await ctx.ui.confirm(title, detail)),
      notify: (message, tone) => ctx.ui?.notify?.(message, tone ?? "info"),
    };
  };

  /** Import the remote lineage beside this session's turns; all bookkeeping lives in the merged file. */
  const pull = async (ctx: any, options: { assumeWanted?: boolean; announceClean?: boolean; prefix?: string; silentResult?: boolean } = {}) => {
    const target = state.target;
    if (state.connection !== "connected" || !target || !state.sessionId) { ctx.ui?.notify?.("Handoff pull needs a connected remote session", "warning"); return { outcome: "needs-connection" as const }; }
    if (!ctx.sessionManager.getSessionFile?.()) { ctx.ui?.notify?.("This session is not saved to a file, so remote history cannot be merged into it", "warning"); return { outcome: "needs-file" as const }; }
    return pullRemoteHistory(pullIo(ctx), { alias: target.alias, ...options });
  };

  /** True when a conflict result means the remote holds turns this session never read. */
  const unreadRemoteTurns = (result: HandoffState) => result.syncState === "conflict" && (result.syncReason ?? "").startsWith("remote snapshot advanced");

  /**
   * Push a session file. When the remote has moved beyond what this session has read, the push first
   * merges those turns in as a branch and finishes from the relocated session — never over them.
   * Returns undefined once the session has been relocated: the caller's context is stale after that.
   */
  const push = async (ctx: any, current: HandoffState, file: string): Promise<HandoffState | undefined> => {
    const measured = await sizer();
    const result = await synchronize(current, file, {
      confirmRecovery: (message) => ctx.ui.confirm("Recover stale Handoff lock?", message),
      onProgress: reportProgress,
      pickChunkBytes: (target, negotiated) => measured.pick(target, negotiated),
      onTransferSample: (sample) => measured.record(state.target!, sample),
      fetch: async (target, sessionId) => {
        const started = Date.now();
        const data = await fetchSnapshot(target, sessionId, requestGate, measured.pick(target));
        measured.record(target, { bytes: data.length, ms: Date.now() - started, ok: true });
        return data;
      },
    });
    // Relocation is a command-context capability: the idle auto-sync reports and stops instead.
    if (unreadRemoteTurns(result) && ctx.switchSession) {
      pushAfterMerge = true;
      const merged = await pull(ctx, { assumeWanted: true, prefix: "Handoff sync", silentResult: true });
      // Only a relocation hands the push to the replacement context; a refused merge keeps the conflict.
      if (merged.outcome === "imported" && merged.switched) return undefined;
      pushAfterMerge = false;
    }
    return result;
  };
  const connect = async (ctx: any) => {
    const hosts = await discoverSshHosts(); const pick = await select(ctx, "SSH host", [...hosts.map((host) => ({ label: host.alias, value: host.alias })), { label: "Enter host…", value: "__manual__" }]);
    if (!pick) return;
    let target: Omit<RemoteTarget, "workspace">;
    if (pick === "__manual__") { const host = await ctx.ui.input("SSH host"); if (!host) return; const user = await ctx.ui.input("SSH user (optional)"); const port = await ctx.ui.input("SSH port (optional)"); const validated = validateManualTarget(host, user, port); target = { alias: validated.host, host: validated.host, user: validated.user, port: validated.port }; }
    else { // ssh -G happens only after the user explicitly selected the alias; retain alias for execution.
      const resolved = await sshGetConfig(pick); target = { alias: pick, host: resolved.hostname ?? pick, user: resolved.user, port: resolved.port ? Number(resolved.port) : undefined };
    }
    try {
      await ensureRemoteHelper(target, ctx.hasUI !== false && Boolean(ctx.ui?.confirm), (message) => ctx.ui.confirm("Install Handoff helper?", message));
    } catch (error) {
      ctx.ui?.notify?.(`Handoff helper is not ready: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    const selected = await chooseWorkspace(ctx, target, chooseWorkspaceDeps); if (!selected) return;
    setState({ ...state, connection: "connected", target: selected, syncState: "clean" });
    const action = await select(ctx, "SSH session", [
      { label: "Resume remote session", value: "resume" }, { label: "Start new remote session", value: "new" }, { label: "Move current session to remote workspace", value: "move" }, { label: "Connect tools only", value: "tools" }, { label: "Cancel", value: "cancel" },
    ]);
    if (action === "cancel" || !action) return;
    if (action === "tools") { setState(applyRemoteSessionAction(state, "tools")); return; }
    if (action === "move") {
      const candidate = applyRemoteSessionAction(state, "move", ctx.sessionManager.getSessionId?.());
      const file = ctx.sessionManager.getSessionFile?.();
      if (!file) return;
      setState({ ...candidate, syncState: "syncing" });
      const materialized = await materializeSession(file, cacheRoot).catch(() => file);
      const synced = await push(ctx, candidate, materialized);
      if (!synced) return; // merged into a new session file that is already pushed; this context is stale
      setState(synced.syncState === "clean" ? synced : { ...state, syncState: synced.syncState, syncReason: synced.syncReason });
      if (["offline", "conflict"].includes(synced.syncState)) ctx.ui?.notify?.(syncFailureNotice(synced.syncState, synced.syncReason), "error");
      return;
    }
    if (action === "resume") return resumeRemoteSession(ctx, selected);
    setState(applyRemoteSessionAction(state, "new", ctx.sessionManager.getSessionId?.() ?? `remote-${Date.now()}`));
  };
  const command = async (args: string, ctx: any) => {
    activeCtx = ctx;
    const sub = args.trim();
    if (sub === "pull") return pull(ctx, { assumeWanted: true, announceClean: true });
    if (sub === "status") return ctx.ui.notify(handoffStatusDetail(state), "info");
    if (sub === "disconnect") { setState(initialState()); return; }
    if (sub === "sync") { if (state.connection !== "connected") return ctx.ui.notify("Not connected", "warning"); if (state.sessionAuthority !== "remote" || !state.sessionId || !ctx.sessionManager.getSessionFile?.()) return ctx.ui.notify("Tools are connected; no remote session to synchronize", "info"); setState({ ...state, syncState: "syncing" }); const result = await push(ctx, state, ctx.sessionManager.getSessionFile()); if (!result) return; setState(result); if (["offline", "conflict"].includes(result.syncState)) ctx.ui?.notify?.(syncFailureNotice(result.syncState, result.syncReason), "error"); return; }
    if (sub === "toggle") { await ctx.waitForIdle?.(); setState(toggleToolRoute(state)); return; }
    if (await dispatchConnectedAction(sub, ctx, state, {
      resumeRemoteSession,
      chooseWorkspace: (actionCtx, target) => chooseWorkspace(actionCtx, target, chooseWorkspaceDeps),
      setState,
    })) return;
    if (state.connection === "disconnected") return connect(ctx);
    const action = await select(ctx, "SSH connection", [{ label: "Show current connection", value: "status" }, { label: "Resume another remote session", value: "resume" }, { label: "Start new session in this workspace", value: "new" }, { label: "Change workspace", value: "workspace" }, { label: "Synchronize now", value: "sync" }, { label: "Disconnect", value: "disconnect" }]);
    if (action) await command(action, ctx);
  };
  pi.registerCommand("ssh", { description: "Connect, synchronize, or route tools through SSH", handler: command as any });
  registerHandoffShortcut(pi, settings, async (ctx: any) => command("toggle", ctx));
  pi.on("session_start", (_event: any, ctx: any) => { activeCtx = ctx; state = restored(ctx.sessionManager.getBranch?.() ?? []); hud?.dispose(); hud = registerHudItem({ owner: "handoff", id: "route", zone: "workspaceRight", order: 100, importance: "normal", variants: handoffHudVariants(state) }); disposeBackend?.(); disposeBackend = setRemoteBashBackend(() => remote()?.bash, () => state.target && state.connection === "connected" && state.toolRoute === "remote" ? `${state.target.alias}:${state.target.workspace}` : undefined, () => state.target && state.connection === "connected" && state.toolRoute === "remote" ? activeCtx?.cwd : undefined, () => state.target && state.connection === "connected" && state.toolRoute === "remote" ? `${state.target.alias}\0${state.target.host ?? state.target.alias}\0${state.target.user ?? ""}\0${state.target.port ?? ""}\0${state.target.workspace}` : undefined); });
  pi.on("session_shutdown", () => { hud?.dispose(); hud = undefined; disposeBackend?.(); disposeBackend = undefined; });
  pi.on("agent_settled", async (_event: any, ctx: any) => { if (state.sessionAuthority === "remote" && state.syncState === "dirty" && ctx.isIdle?.()) await command("sync", ctx); });
  pi.on("user_bash", (_event: any) => { const backend = remote()?.bash; return backend ? { operations: backend } : undefined; });
  for (const [factory, name] of [[createReadTool, "read"], [createWriteTool, "write"], [createEditTool, "edit"], [createGrepTool, "grep"], [createFindTool, "find"], [createLsTool, "ls"]] as const) {
    const local: any = factory(process.cwd());
    pi.registerTool({
      ...local,
      async execute(id: any, params: any, signal: AbortSignal, update: any, ctx: any) {
        activeCtx = ctx;
        const ops: any = authorizedRemoteOperations(id, remote);
        const opKey: Record<string, string> = { read: "read", write: "write", edit: "edit", grep: "grep", find: "find", ls: "ls" };
        const tool: any = ops ? factory(ctx.cwd, { operations: ops[opKey[name] ?? name] }) : factory(ctx.cwd);
        return tool.execute(id, params, signal, update, ctx);
      },
    });
  }
}
