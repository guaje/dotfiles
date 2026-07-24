import type { ManagingStyle } from "./types.ts";
export const MANAGING_STYLE_VALUES: ManagingStyle[] = ["Micromanagement", "Empowerment"];
export const DEFAULT_MANAGING_STYLE: ManagingStyle = "Micromanagement";
export const MANAGING_STYLE_LABELS: Record<ManagingStyle, string> = { Micromanagement: "Micromanaging", Empowerment: "Empowering" };
/** Guidance was the former name for Empowerment. Do not rewrite it until an explicit save. */
export function normalizeManagingStyle(value: unknown): ManagingStyle { return value === "Empowerment" || value === "Empowering" || value === "Guidance" ? "Empowerment" : DEFAULT_MANAGING_STYLE; }
export function nextManagingStyle(style: ManagingStyle): ManagingStyle { return style === "Micromanagement" ? "Empowerment" : "Micromanagement"; }
