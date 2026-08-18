import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { cacheRoot } from "./config.ts";
import { getHandoffSettings, registerHandoffShortcut } from "./settings.ts";
import { notifyRemoteRouteChanged, setRemoteBashBackend } from "./backend-registry.ts";
import { createRemoteOperations } from "./operations.ts";
import { discoverSshHosts, validateManualTarget } from "./ssh-config.ts";
import { applyRemoteSessionAction, initialState, restoreState, toggleToolRoute } from "./state.ts";
import { handoffHudVariants, handoffStatus } from "./status.ts";
import { registerHudItem, type HudItemHandle } from "../00-hud/api.ts";
import { materializeSession } from "./session-materializer.ts";
import { ensureRemoteHelper } from "./installer.ts";
import { shellLiteral, shellTest, sshExec, sshGetConfig } from "./transport.ts";
import { requestGate, synchronize } from "./sync.ts";
import type { HandoffState, RemoteTarget } from "./types.ts";
import { selectLabeledOption as select } from "./ui.ts";
import { chooseWorkspace } from "./choose-workspace.ts";
import { authorizedRemoteOperations } from "./remote-authorization.ts";
import { dispatchConnectedAction } from "./connection-actions.ts";

function appendContext(pi: any, state: HandoffState) { pi.appendEntry?.({ type: "custom", customType: "handoff-context", data: { state } }); }
function restored(branch: any[]): HandoffState { for (let i = branch.length - 1; i >= 0; i--) { const entry = branch[i]; if (entry?.type === "custom" && entry.customType === "handoff-context") return restoreState(entry.data?.state); } return initialState(); }

export default async function handoff(pi: ExtensionAPI) {
  const settings = await getHandoffSettings();
  let state = initialState(); let activeCtx: any; let hud: HudItemHandle | undefined; let disposeBackend: (() => void) | undefined;
  const setState = (next: HandoffState, persist = true) => { state = next; notifyRemoteRouteChanged(); hud?.update({ variants: handoffHudVariants(state), visible: true }); if (persist) appendContext(pi, state); };
  const remote = () => state.target && state.connection === "connected" && state.toolRoute === "remote" ? createRemoteOperations({ alias: state.target.alias, user: state.target.user, port: state.target.port, workspace: state.target.workspace, localCwd: activeCtx?.cwd ?? process.cwd() }) : undefined;
  const chooseWorkspaceDeps = { sshExec, selectLabeledOption: select, shellLiteral, shellTest };
  const resumeRemoteSession = async (ctx: any, target: RemoteTarget) => {
    try {
      const sessionsResult = await requestGate(target, "list-sessions") as { ok: boolean; sessions?: string[]; error?: string };
      if (sessionsResult.ok && sessionsResult.sessions && sessionsResult.sessions.length > 0) {
        const sessionChoice = await select(ctx, "Resume session", sessionsResult.sessions.map((sid) => ({ label: sid, value: sid })));
        if (sessionChoice) setState(applyRemoteSessionAction({ ...state, connection: "connected", target }, "resume", sessionChoice));
        // Cancellation is not consent to create a new remote session.
        return;
      }
    } catch { return ctx.ui?.notify?.("Could not list remote sessions", "warning"); }
    return ctx.ui?.notify?.("No remote sessions available to resume", "info");
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
      const synced = await synchronize(candidate, materialized, { confirmRecovery: (message) => ctx.ui.confirm("Recover stale Handoff lock?", message) });
      setState(synced.syncState === "clean" ? synced : { ...state, syncState: synced.syncState });
      return;
    }
    if (action === "resume") return resumeRemoteSession(ctx, selected);
    setState(applyRemoteSessionAction(state, "new", ctx.sessionManager.getSessionId?.() ?? `remote-${Date.now()}`));
  };
  const command = async (args: string, ctx: any) => {
    activeCtx = ctx;
    const sub = args.trim();
    if (sub === "status") return ctx.ui.notify(handoffStatus(state), "info");
    if (sub === "disconnect") { setState(initialState()); return; }
    if (sub === "sync") { if (state.connection !== "connected") return ctx.ui.notify("Not connected", "warning"); if (state.sessionAuthority !== "remote" || !state.sessionId || !ctx.sessionManager.getSessionFile?.()) return ctx.ui.notify("Tools are connected; no remote session to synchronize", "info"); setState({ ...state, syncState: "syncing" }); setState(await synchronize(state, ctx.sessionManager.getSessionFile(), { confirmRecovery: (message) => ctx.ui.confirm("Recover stale Handoff lock?", message) })); return; }
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
