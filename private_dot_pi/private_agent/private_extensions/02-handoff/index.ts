import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { cacheRoot, DEFAULT_SHORTCUT } from "./config.ts";
import { setRemoteBashBackend } from "./backend-registry.ts";
import { createRemoteOperations } from "./operations.ts";
import { discoverSshHosts, validateManualTarget } from "./ssh-config.ts";
import { initialState, restoreState, toggleToolRoute } from "./state.ts";
import { handoffHudVariants, handoffStatus } from "./status.ts";
import { registerHudItem, type HudItemHandle } from "../00-hud/api.ts";
import { materializeSession } from "./session-materializer.ts";
import { sshExec, sshGetConfig } from "./transport.ts";
import { synchronize } from "./sync.ts";
import type { HandoffState, RemoteTarget } from "./types.ts";

function select<T>(ctx: any, title: string, items: Array<{ label: string; value: T }>): Promise<T | undefined> { return ctx.ui.select(title, items as any); }
function appendContext(pi: any, state: HandoffState) { pi.appendEntry?.({ type: "custom", customType: "handoff-context", data: { state } }); }
function restored(branch: any[]): HandoffState { for (let i = branch.length - 1; i >= 0; i--) { const entry = branch[i]; if (entry?.type === "custom" && entry.customType === "handoff-context") return restoreState(entry.data?.state); } return initialState(); }

export default function (pi: ExtensionAPI) {
  let state = initialState(); let activeCtx: any; let hud: HudItemHandle | undefined;
  const setState = (next: HandoffState, persist = true) => { state = next; hud?.update({ variants: handoffHudVariants(state), visible: true }); if (persist) appendContext(pi, state); };
  const remote = () => state.target && state.connection === "connected" ? createRemoteOperations({ alias: state.target.alias, user: state.target.user, port: state.target.port, workspace: state.target.workspace, localCwd: activeCtx?.cwd ?? process.cwd() }) : undefined;
  const chooseWorkspace = async (ctx: any, target: Omit<RemoteTarget, "workspace">) => {
    const home = (await sshExec(target, "printf %s \"$HOME\"")).stdout.toString().trim();
    const choice = await select(ctx, "Remote workspace", [{ label: home, value: home }, { label: "Enter a path…", value: "__manual__" }]);
    if (!choice) return undefined; const workspace = choice === "__manual__" ? await ctx.ui.input("Remote workspace", home) : choice;
    if (!workspace || !workspace.startsWith("/") || workspace.includes("\0")) return undefined;
    await sshExec(target, `test -d -- '${workspace.replace(/'/g, "'\\''")}'`); return { ...target, workspace };
  };
  const connect = async (ctx: any) => {
    const hosts = await discoverSshHosts(); const pick = await select(ctx, "SSH host", [...hosts.map((host) => ({ label: host.alias, value: host.alias })), { label: "Enter host…", value: "__manual__" }]);
    if (!pick) return;
    let target: Omit<RemoteTarget, "workspace">;
    if (pick === "__manual__") { const host = await ctx.ui.input("SSH host"); if (!host) return; const user = await ctx.ui.input("SSH user (optional)"); const port = await ctx.ui.input("SSH port (optional)"); target = { alias: validateManualTarget(host, user, port).host, user: user || undefined, port: port ? Number(port) : undefined }; }
    else { // ssh -G happens only after the user explicitly selected the alias; retain alias for execution.
      const resolved = await sshGetConfig(pick); target = { alias: pick, user: resolved.user, port: resolved.port ? Number(resolved.port) : undefined };
    }
    const selected = await chooseWorkspace(ctx, target); if (!selected) return;
    setState({ ...state, connection: "connected", target: selected, syncState: "clean" });
    const action = await select(ctx, "SSH session", [
      { label: "Resume remote session", value: "resume" }, { label: "Start new remote session", value: "new" }, { label: "Move current session to remote workspace", value: "move" }, { label: "Connect tools only", value: "tools" }, { label: "Cancel", value: "cancel" },
    ]);
    if (action === "cancel" || !action) return;
    if (action === "tools") { setState({ ...state, toolRoute: "remote" }); return; }
    if (action === "move") {
      const candidate = { ...state, sessionId: ctx.sessionManager.getSessionId?.(), sessionAuthority: "remote" as const, toolRoute: "remote" as const, syncState: "dirty" as const };
      const file = ctx.sessionManager.getSessionFile?.();
      if (!file) return;
      setState({ ...candidate, syncState: "syncing" });
      const materialized = await materializeSession(file, cacheRoot).catch(() => file);
      const synced = await synchronize(candidate, materialized);
      setState(synced.syncState === "clean" ? synced : { ...state, syncState: synced.syncState });
      return;
    }
    if (action === "resume") {
      try {
        const sessionsOutput = await sshExec(state.target!, `python3 \${HOME}/.local/libexec/pi-handoff-gate.py list-sessions`);
        const sessionsResult = JSON.parse(sessionsOutput.stdout.toString()) as { ok: boolean; sessions?: string[]; error?: string };
        if (sessionsResult.ok && sessionsResult.sessions && sessionsResult.sessions.length > 0) {
          const sessionChoice = await select(ctx, "Resume session", sessionsResult.sessions.map((sid) => ({ label: sid, value: sid })));
          if (sessionChoice) {
            setState({ ...state, sessionId: sessionChoice, sessionAuthority: "remote", toolRoute: "remote", syncState: "clean" });
            return;
          }
        }
      } catch { /* fall through to new session */ }
    }
    setState({ ...state, sessionId: ctx.sessionManager.getSessionId?.() ?? `remote-${Date.now()}`, sessionAuthority: "remote", toolRoute: "remote", syncState: "clean" });
  };
  const command = async (args: string, ctx: any) => {
    activeCtx = ctx;
    const sub = args.trim();
    if (sub === "status") return ctx.ui.notify(handoffStatus(state), "info");
    if (sub === "disconnect") { setRemoteBashBackend(undefined); setState(initialState()); return; }
    if (sub === "sync") { if (state.connection !== "connected") return ctx.ui.notify("Not connected", "warning"); if (state.sessionAuthority !== "remote" || !state.sessionId || !ctx.sessionManager.getSessionFile?.()) return ctx.ui.notify("Tools are connected; no remote session to synchronize", "info"); setState({ ...state, syncState: "syncing" }); setState(await synchronize(state, ctx.sessionManager.getSessionFile())); return; }
    if (sub === "toggle") { await ctx.waitForIdle?.(); setState(toggleToolRoute(state)); return; }
    if (state.connection === "disconnected") return connect(ctx);
    const action = await select(ctx, "SSH connection", [{ label: "Show current connection", value: "status" }, { label: "Resume another remote session", value: "resume" }, { label: "Start new session in this workspace", value: "new" }, { label: "Change workspace", value: "workspace" }, { label: "Synchronize now", value: "sync" }, { label: "Disconnect", value: "disconnect" }]);
    if (action) await command(action === "workspace" ? "" : action, ctx);
  };
  pi.registerCommand("ssh", { description: "Connect, synchronize, or route tools through SSH", handler: command as any });
  pi.registerShortcut?.(DEFAULT_SHORTCUT, { description: "Toggle SSH tool routing", handler: async (ctx: any) => command("toggle", ctx) });
  pi.on("session_start", (_event: any, ctx: any) => { activeCtx = ctx; state = restored(ctx.sessionManager.getBranch?.() ?? []); hud?.dispose(); hud = registerHudItem({ owner: "handoff", id: "route", zone: "workspaceRight", order: 100, importance: "normal", variants: handoffHudVariants(state) }); setRemoteBashBackend(() => remote()?.bash, () => state.target ? `${state.target.alias}:${state.target.workspace}` : undefined); });
  pi.on("session_shutdown", () => { hud?.dispose(); hud = undefined; });
  pi.on("agent_settled", async (_event: any, ctx: any) => { if (state.sessionAuthority === "remote" && state.syncState === "dirty" && ctx.isIdle?.()) await command("sync", ctx); });
  pi.on("user_bash", (_event: any) => { const backend = remote()?.bash; return backend ? { operations: backend } : undefined; });
  for (const [factory, name] of [[createReadTool, "read"], [createWriteTool, "write"], [createEditTool, "edit"], [createGrepTool, "grep"], [createFindTool, "find"], [createLsTool, "ls"]] as const) {
    const local: any = factory(process.cwd());
    pi.registerTool({
      ...local,
      async execute(id: any, params: any, signal: AbortSignal, update: any, ctx: any) {
        activeCtx = ctx;
        const ops: any = remote();
        const opKey: Record<string, string> = { read: "read", write: "write", edit: "edit", grep: "grep", find: "find", ls: "ls" };
        const tool: any = ops ? factory(ctx.cwd, { operations: ops[opKey[name] ?? name] }) : factory(ctx.cwd);
        return tool.execute(id, params, signal, update, ctx);
      },
    });
  }
}
