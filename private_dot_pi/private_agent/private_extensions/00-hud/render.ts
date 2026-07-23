import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { hudItems } from "./registry.ts";
import { sanitizeHudText } from "./sanitize.ts";
import type { HudItem, HudSegment, HudTone, HudVariant, HudZone } from "./types.ts";

const separator = " │ ";
const variants: HudVariant[] = ["full", "compact", "icon"];
const HUD_STYLER_SYMBOL = Symbol.for("pi.hud.styler.v1");

type HudStyler = (tone: HudTone, text: string) => string;
type HudStylerGlobal = typeof globalThis & { [HUD_STYLER_SYMBOL]?: HudStyler };

export function setHudStyler(styler: HudStyler | undefined): void {
  const global = globalThis as HudStylerGlobal;
  if (styler) global[HUD_STYLER_SYMBOL] = styler;
  else delete global[HUD_STYLER_SYMBOL];
}

export function segmentsText(segments: HudSegment[] | undefined): string {
  return (segments ?? []).map((segment) => sanitizeHudText(segment.text)).join("");
}

export function renderSegments(segments: HudSegment[] | undefined): string {
  const styler = (globalThis as HudStylerGlobal)[HUD_STYLER_SYMBOL];
  return (segments ?? []).map((segment) => {
    const text = sanitizeHudText(segment.text);
    return text && segment.tone && styler ? styler(segment.tone, text) : text;
  }).join("");
}

function variantText(item: HudItem, variant: HudVariant): string {
  const segments = item.variants[variant] ?? item.variants.full;
  return renderSegments(segments);
}

function nextVariant(item: HudItem, variant: HudVariant): HudVariant | undefined {
  const index = variants.indexOf(variant);
  return variants.slice(index + 1).find((candidate) => item.variants[candidate] !== undefined);
}

function importanceRank(item: HudItem): number {
  return ({ optional: 0, normal: 1, required: 2 })[item.importance];
}

export function renderZone(zone: HudZone, width: number): string {
  const safeWidth = Math.max(0, width);
  const entries = hudItems().filter((item) => item.zone === zone);
  const states = entries.map((item) => ({ item, variant: "full" as HudVariant, hidden: false }));
  const text = () => states
    .filter((state) => !state.hidden)
    .map((state) => variantText(state.item, state.variant))
    .filter(Boolean)
    .join(separator);

  while (visibleWidth(text()) > safeWidth) {
    const candidate = states
      .filter((state) => !state.hidden)
      .sort((a, b) => importanceRank(a.item) - importanceRank(b.item)
        || (b.item.order ?? 0) - (a.item.order ?? 0)
        || `${b.item.owner}:${b.item.id}`.localeCompare(`${a.item.owner}:${a.item.id}`))
      .find((state) => nextVariant(state.item, state.variant) !== undefined || state.item.importance !== "required");
    if (!candidate) break;
    const next = nextVariant(candidate.item, candidate.variant);
    if (next) candidate.variant = next;
    else candidate.hidden = true;
  }

  return truncateToWidth(text(), safeWidth, "");
}
