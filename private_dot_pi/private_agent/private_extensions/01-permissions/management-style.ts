import type { ManagingStyle, PersistedManagingStyle } from "./types.ts";

/** These are the only settings values. YOLO is intentionally never configurable. */
export const MANAGING_STYLE_VALUES: PersistedManagingStyle[] = ["Micromanagement", "Empowerment"];
export const DEFAULT_MANAGING_STYLE: PersistedManagingStyle = "Micromanagement";
export const MANAGING_STYLE_LABELS: Record<ManagingStyle, string> = {
  Micromanagement: "Micromanaging",
  Empowerment: "Empowering",
  YOLO: "YOLO",
};

export function normalizeManagingStyle(value: unknown): PersistedManagingStyle {
  return value === "Micromanagement" || value === "Empowerment" ? value : DEFAULT_MANAGING_STYLE;
}

export function availableManagingStyles(remoteRouteActive: boolean): ManagingStyle[] {
  return remoteRouteActive ? [...MANAGING_STYLE_VALUES, "YOLO"] : [...MANAGING_STYLE_VALUES];
}

export function nextManagingStyle(style: ManagingStyle, remoteRouteActive = false, direction: 1 | -1 = 1): ManagingStyle {
  const values = availableManagingStyles(remoteRouteActive);
  // A stale runtime YOLO selection is never allowed to keep authorizing calls.
  const index = values.indexOf(style);
  return values[(index < 0 ? 0 : (index + direction + values.length) % values.length)]!;
}
