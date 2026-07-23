import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// HUD publishers provide semantic text, never terminal escape sequences.
export function sanitizeHudText(value: unknown): string {
  return String(value ?? "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/ +/g, " ");
}

export function fitHudText(text: string, width: number): string {
  return truncateToWidth(sanitizeHudText(text), Math.max(0, width), "");
}

export function hudWidth(text: string): number {
  return visibleWidth(sanitizeHudText(text));
}
