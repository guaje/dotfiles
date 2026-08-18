import type { HandoffState } from "./types.ts";

export type RemoteSessionAction = "resume" | "new" | "move" | "tools";

export const initialState = (): HandoffState => ({ connection: "disconnected", sessionAuthority: "local", toolRoute: "local", syncState: "clean" });
export function restoreState(value: unknown): HandoffState {
  const state = value as Partial<HandoffState> | undefined;
  if (!state || !["disconnected", "connected"].includes(state.connection ?? "")) return initialState();
  return { ...initialState(), ...state } as HandoffState;
}
export function canSync(state: HandoffState) { return state.connection === "connected" && !["offline", "stale", "locked", "conflict"].includes(state.syncState); }
export function canRouteRemote(state: HandoffState) { return state.connection === "connected" && state.toolRoute === "remote" && !!state.target; }
export function toggleToolRoute(state: HandoffState): HandoffState { return state.connection === "connected" ? { ...state, toolRoute: state.toolRoute === "local" ? "remote" : "local" } : state; }

/** Every successful SSH session action routes tools remotely; session authority changes only when history is remote. */
export function applyRemoteSessionAction(state: HandoffState, action: RemoteSessionAction, sessionId?: string): HandoffState {
  if (action === "tools") return { ...state, toolRoute: "remote" };
  return {
    ...state,
    sessionId,
    sessionAuthority: "remote",
    toolRoute: "remote",
    syncState: action === "move" ? "dirty" : "clean",
  };
}
