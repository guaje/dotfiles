import type { HudSegment, HudTone, HudVariants } from "../00-hud/api.ts";
import type { HandoffState } from "./types.ts";

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

export function handoffStatus(state: HandoffState): string {
  if (state.syncState === "syncing") return "⇅ synchronizing remote session";
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

export function handoffHudVariants(state: HandoffState): HudVariants {
  const full = handoffStatus(state);
  const icon = full.split(" ")[0] || "⌂";
  const compact = state.connection === "connected" && state.target ? `${icon} ${state.target.alias}` : full;
  const tone = statusTone(state);
  return {
    full: semanticSegments(full, tone),
    compact: semanticSegments(compact, tone),
    icon: [{ text: icon, tone }],
  };
}
