import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderZone } from "./render.ts";

export function hudGutterWidth(_width: number): number {
  return 0;
}

export function hudInnerWidth(width: number): number {
  return Math.max(0, width - hudGutterWidth(width));
}

function withGutter(line: string, width: number): string {
  const gutterWidth = hudGutterWidth(width);
  const innerWidth = hudInnerWidth(width);
  return `${" ".repeat(gutterWidth)}${truncateToWidth(line, innerWidth, "")}`;
}

function rightAligned(left: string, right: string, width: number): string {
  if (!right) return truncateToWidth(left, width, "");
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, "");
  const minimumGap = left ? 2 : 0;
  const leftWidth = Math.max(0, width - rightWidth - minimumGap);
  const fittedLeft = truncateToWidth(left, leftWidth, "");
  const padding = Math.max(minimumGap, width - visibleWidth(fittedLeft) - rightWidth);
  return `${fittedLeft}${" ".repeat(padding)}${right}`;
}

/** Compose HUD rows around Pi's original footer output. */
export function layoutFooter(originalLines: string[], width: number): string[] {
  const safeWidth = Math.max(0, width);
  if (safeWidth === 0) return [];

  const innerWidth = hudInnerWidth(safeWidth);
  const workspace = originalLines[0] ?? "";
  const metrics = originalLines[1] ?? "";
  const legacy = originalLines.slice(2);

  const mode = renderZone("modeRight", safeWidth);
  // Downgrade or hide workspace indicators against the complete CWD first;
  // rightAligned truncates the CWD only after that choice has been made.
  const workspaceBudget = Math.max(0, innerWidth - visibleWidth(workspace) - 2);
  const workspaceRight = renderZone("workspaceRight", workspaceBudget);
  const workspaceLine = withGutter(rightAligned(workspace, workspaceRight, innerWidth), safeWidth);
  const metricsLine = withGutter(metrics, safeWidth);
  const legacyLines = legacy.map((line) => withGutter(line, safeWidth));
  const extension = renderZone("extensionLine", innerWidth);
  const extensionLine = extension ? withGutter(extension, safeWidth) : undefined;

  return [
    ...(mode ? [rightAligned("", mode, safeWidth)] : []),
    workspaceLine,
    metricsLine,
    ...legacyLines,
    ...(extensionLine ? [extensionLine] : []),
  ];
}
