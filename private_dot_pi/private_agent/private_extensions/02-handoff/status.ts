import type { HudSegment, HudTone, HudVariants } from "../00-hud/api.ts";
import type { HandoffState, SyncProgress } from "./types.ts";

function statusTone(state: HandoffState): HudTone {
  if (["offline", "stale", "conflict"].includes(state.syncState)) return "error";
  if (["syncing", "locked"].includes(state.syncState)) return "warning";
  return "accent";
}

function semanticSegments(text: string, tone: HudTone): HudSegment[] {
  const match = /^(\S+)(.*)$/s.exec(text);
  if (!match) return [];
  return [
    { text: match[1] ?? "", tone },
    ...(match[2] ? [{ text: match[2], tone: "muted" as const }] : []),
  ];
}

function megabytes(bytes: number) { return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }

/** Kept as short as the rest of the HUD: an action, a count, and the size of what is moving. */
function handoffProgress(progress: SyncProgress): string {
  const action = progress.phase === "upload" ? "sending" : "reading";
  const value = progress.unit === "chunk" ? `${progress.done}/${progress.total}` : `${megabytes(progress.done)}/${megabytes(progress.total)}`;
  return `⇅ ${action} ${value}`;
}

export function handoffStatus(state: HandoffState, progress?: SyncProgress): string {
  if (state.syncState === "syncing") return progress ? handoffProgress(progress) : "⇅ synchronizing remote session";
  if (state.syncState === "offline") return "⚠ remote offline • changes retained";
  if (state.syncState === "stale") return "◌ remote state stale • sync blocked";
  if (state.syncState === "locked") return "🔒 remote session locked";
  if (state.syncState === "conflict") return "⚡ remote session conflict";
  const target = state.target ? `${state.target.alias}:${state.target.workspace}` : "host:path";
  if (state.sessionAuthority === "local" && state.toolRoute === "remote") return `⇄ tools→${target} • history local`;
  if (state.sessionAuthority === "remote" && state.toolRoute === "remote") return `⇄ tools→${target} • history→${state.target?.alias ?? "host"}`;
  if (state.sessionAuthority === "remote") return "⌂ tools→local • history→host";
  return "⌂ tools→local • history local";
}

/** Diagnostics view for /ssh status; appends the last synchronization failure without cluttering the HUD. */
export function handoffStatusDetail(state: HandoffState): string {
  const base = handoffStatus(state);
  if (["offline", "conflict"].includes(state.syncState) && state.syncReason) return `${base} — ${state.syncReason}`;
  return base;
}

export function handoffHudVariants(state: HandoffState, progress?: SyncProgress): HudVariants {
  const full = handoffStatus(state, progress);
  const icon = full.split(" ")[0] || "⌂";
  // While a transfer runs, the progress is more useful than the host name in the narrow HUD.
  const compact = progress || !(state.connection === "connected" && state.target) ? full : `${icon} ${state.target.alias}`;
  const tone = statusTone(state);
  return {
    full: semanticSegments(full, tone),
    compact: semanticSegments(compact, tone),
    icon: [{ text: icon, tone }],
  };
}
