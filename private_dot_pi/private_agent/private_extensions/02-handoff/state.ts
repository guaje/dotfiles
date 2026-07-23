import type { HandoffState } from "./types.ts";

export const initialState = (): HandoffState => ({ connection: "disconnected", sessionAuthority: "local", toolRoute: "local", syncState: "clean" });
export function restoreState(value: unknown): HandoffState {
  const state = value as Partial<HandoffState> | undefined;
  if (!state || !["disconnected", "connected"].includes(state.connection ?? "")) return initialState();
  return { ...initialState(), ...state } as HandoffState;
}
export function canSync(state: HandoffState) { return state.connection === "connected" && !["offline", "stale", "locked", "conflict"].includes(state.syncState); }
export function canRouteRemote(state: HandoffState) { return state.connection === "connected" && state.toolRoute === "remote" && !!state.target; }
export function toggleToolRoute(state: HandoffState): HandoffState { return state.connection === "connected" ? { ...state, toolRoute: state.toolRoute === "local" ? "remote" : "local" } : state; }
