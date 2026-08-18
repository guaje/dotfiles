import { applyRemoteSessionAction } from "./state.ts";
import type { HandoffState, RemoteTarget } from "./types.ts";

interface ConnectedActionContext {
  sessionManager: { getSessionId?: () => string | undefined };
  ui?: { notify?: (message: string, tone?: "info" | "warning" | "error") => void };
}

export interface ConnectedActionDependencies {
  resumeRemoteSession(ctx: ConnectedActionContext, target: RemoteTarget): Promise<void>;
  chooseWorkspace(ctx: ConnectedActionContext, target: Omit<RemoteTarget, "workspace">): Promise<RemoteTarget | undefined>;
  setState(state: HandoffState): void;
  now?: () => number;
}

/** Dispatch actions from the already-connected /ssh management menu without reopening that menu. */
export async function dispatchConnectedAction(
  action: string,
  ctx: ConnectedActionContext,
  state: HandoffState,
  dependencies: ConnectedActionDependencies,
): Promise<boolean> {
  if (!(["resume", "new", "workspace"] as const).includes(action as "resume" | "new" | "workspace")) return false;
  if (!state.target) {
    ctx.ui?.notify?.("The Handoff connection has no remote target", "warning");
    return true;
  }

  if (action === "resume") {
    await dependencies.resumeRemoteSession(ctx, state.target);
    return true;
  }

  if (action === "new") {
    const sessionId = ctx.sessionManager.getSessionId?.() ?? `remote-${(dependencies.now ?? Date.now)()}`;
    dependencies.setState(applyRemoteSessionAction(state, "new", sessionId));
    return true;
  }

  const { alias, host, user, port } = state.target;
  const selected = await dependencies.chooseWorkspace(ctx, { alias, host, user, port });
  if (selected) dependencies.setState({ ...state, target: selected, toolRoute: "remote", syncState: "clean" });
  return true;
}
