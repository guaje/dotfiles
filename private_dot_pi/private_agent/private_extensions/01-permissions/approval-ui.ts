import { notifyPiWaitingForUser } from "../07-native-notify.ts";
import type { ShellAnalysis, ShellEffect } from "./types.ts";
import { renderShell, type RenderTheme } from "./shell/render.ts";

type ApprovalTheme = RenderTheme;
export type Ui = {
  confirm: (title: string, message: string, opts?: { signal?: AbortSignal }) => Promise<boolean>;
  theme?: ApprovalTheme;
  getEditorText?: () => string;
  setEditorText?: (text: string) => void;
  setWorkingVisible?: (visible: boolean) => void;
  setWorkingMessage?: (message?: string) => void;
  setWorkingIndicator?: (options?: { frames?: string[]; intervalMs?: number }) => void;
};
type Notify = (body: string, ctx: unknown) => Promise<unknown> | unknown;

const PLAIN_THEME: ApprovalTheme = { fg: (_color, text) => text, bold: (text) => text };
function themeFor(ui: Ui) { return ui.theme ?? PLAIN_THEME; }
function title(theme: ApprovalTheme, text: string) { return theme.fg("warning", theme.bold(text)); }
function label(theme: ApprovalTheme, text: string) { return theme.fg("toolTitle", theme.bold(text)); }
function reasonTone(effect: ShellEffect) { return effect === "mutating" ? "error" : effect === "unknown" ? "warning" : "muted"; }

export function writePreview(content: string | undefined) {
  if (content === undefined) return "";
  if (!content) return "<empty file>";
  const lines = content.split("\n"), width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width)} │ ${line}`).join("\n");
}

export function editPreview(edits: Array<{ oldText: string; newText: string }> | undefined) {
  if (!edits?.length) return "<no diff available>";
  return edits.flatMap((edit, index) => {
    const oldLines = edit.oldText ? edit.oldText.split("\n") : ["<empty>"];
    const newLines = edit.newText ? edit.newText.split("\n") : ["<empty>"];
    return [`${index ? "\n" : ""}@@ edit ${index + 1} @@`, ...oldLines.map((line, i) => `- ${i + 1} │ ${line}`), ...newLines.map((line, i) => `+ ${i + 1} │ ${line}`)];
  }).join("\n");
}

export function formatFileApproval(ui: Ui, path: string, summary: string) {
  const theme = themeFor(ui);
  let formattedSummary = summary;
  const match = /^\n\n([^:\n]+:)(?:\s*)(.*)$/s.exec(summary);
  if (match) formattedSummary = `\n\n${label(theme, match[1]!)} ${theme.fg("muted", match[2]!)}`;
  return `${label(theme, "Path:")}\n\n${theme.fg("mdCode", path)}${formattedSummary}`;
}

export function formatBashApproval(ui: Ui, analysis: ShellAnalysis, remoteLabel?: string) {
  const theme = themeFor(ui);
  const programs = analysis.commands.length
    ? analysis.commands.map((command, index) => `${theme.fg("syntaxNumber", `${index + 1})`)} ${theme.fg("warning", theme.bold(command.name))}`).join(", ")
    : theme.fg("muted", "No supported command detected.");
  const reasons = analysis.reasons.length
    ? `\n\n${label(theme, "Approval reasons:")} ${theme.fg(reasonTone(analysis.effect), [...new Set(analysis.reasons)].join("; "))}`
    : "";
  const remote = remoteLabel ? `\n\n${label(theme, "Remote target:")} ${theme.fg("mdCode", remoteLabel)}` : "";
  return `${label(theme, "Command:")}\n${renderShell(analysis.source, theme)}\n\n${label(theme, "Programs to run:")} ${programs}${reasons}${remote}`;
}

async function hiddenConfirm(ui: Ui, dialogTitle: string, message: string) {
  ui.setWorkingVisible?.(false);
  ui.setWorkingMessage?.("");
  ui.setWorkingIndicator?.({ frames: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  try { return await ui.confirm(dialogTitle, message); }
  finally {
    ui.setWorkingMessage?.();
    ui.setWorkingIndicator?.();
    ui.setWorkingVisible?.(true);
  }
}

export async function confirmFileMutation(ctx: { ui: Ui }, options: { title: string; path: string; preview: string; summary: string }, notify: Notify = notifyPiWaitingForUser) {
  const previous = ctx.ui.getEditorText?.() ?? "";
  await notify(`Approval needed: ${options.title.replace(/\?$/, "")}`, ctx);
  ctx.ui.setEditorText?.(options.preview);
  try { return await hiddenConfirm(ctx.ui, title(themeFor(ctx.ui), options.title), formatFileApproval(ctx.ui, options.path, options.summary)); }
  finally { ctx.ui.setEditorText?.(previous); }
}

export async function confirmBash(ctx: { ui: Ui }, analysis: ShellAnalysis, remoteLabel?: string, notify: Notify = notifyPiWaitingForUser) {
  await notify("Approval needed: bash command", ctx);
  return hiddenConfirm(ctx.ui, title(themeFor(ctx.ui), "Allow bash command?"), formatBashApproval(ctx.ui, analysis, remoteLabel));
}
