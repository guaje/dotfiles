import { notifyPiWaitingForUser } from "../07-native-notify.ts";
import type { SessionApprovalTemplateStrength, ShellAnalysis, ShellEffect } from "./types.ts";
import type { RenderTheme } from "./shell/render.ts";

type ApprovalTheme = RenderTheme;
export type Ui = {
  confirm: (title: string, message: string, opts?: { signal?: AbortSignal }) => Promise<boolean>;
  select?: (title: string, items: string[]) => Promise<string | undefined>;
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
function formatApprovalReason(theme: ApprovalTheme, analysis: ShellAnalysis, reason: string) {
  const subjects = analysis.commands.flatMap((command) => [
    command.argv[0] ? `${command.name} ${command.argv[0]}` : "",
    command.name,
  ]).filter(Boolean).sort((left, right) => right.length - left.length);
  const canonicalSubject = /^((?:glab|gh)\s+\S+\s+\S+|git\s+\S+|chezmoi\s+\S+|sudo|doas|su)(?:\s|$)/.exec(reason)?.[1];
  const subject = canonicalSubject ?? subjects.find((candidate) => reason === candidate || reason.startsWith(`${candidate} `));
  if (!subject) return theme.fg(reasonTone(analysis.effect), reason);
  const detail = reason.slice(subject.length).trimStart();
  const tone = /^(?:git(?:\s|$)|sudo(?:\s|$)|doas(?:\s|$)|su(?:\s|$))/.test(subject) ? "warning" : reasonTone(analysis.effect);
  return `${theme.fg(tone, subject)}${detail ? ` ${theme.fg("muted", detail)}` : ""}`;
}

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
  return `${label(theme, "Path:")}\n\n${theme.fg("toolOutput", path)}${formattedSummary}`;
}

export function formatBashApproval(ui: Ui, analysis: ShellAnalysis, remoteLabel?: string) {
  const theme = themeFor(ui);
  const programs = analysis.commands.length
    ? analysis.commands.map((command, index) => `${theme.fg("mdCode", `${index + 1})`)} ${theme.fg("syntaxFunction", command.name)}`).join(", ")
    : theme.fg("muted", "No supported command detected.");
  const reasons = analysis.reasons.length
    ? `\n\n${label(theme, "Approval reasons:")} ${[...new Set(analysis.reasons)].map((reason) => formatApprovalReason(theme, analysis, reason)).join(theme.fg("dim", "; "))}`
    : "";
  const remote = remoteLabel ? `\n\n${label(theme, "Remote target:")} ${theme.fg("toolOutput", remoteLabel)}` : "";
  return `${label(theme, "Programs to run:")} ${programs}${reasons}${remote}`;
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

export type BashApprovalChoice = "deny" | "once" | "remember";
export type BashRememberOption = { optionLabel: string; ruleDescription: string; strength: SessionApprovalTemplateStrength; slotCount: number };

/** The Bash flow is intentionally one select dialog: deny, once, or a session rule. */
export async function chooseBashApproval(
  ctx: { ui: Ui },
  analysis: ShellAnalysis,
  remember: BashRememberOption | undefined,
  remoteLabel?: string,
  notify: Notify = notifyPiWaitingForUser,
): Promise<BashApprovalChoice> {
  await notify("Approval needed: bash command", ctx);
  const ui = ctx.ui;
  ui.setWorkingVisible?.(false);
  ui.setWorkingMessage?.("");
  ui.setWorkingIndicator?.({ frames: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const formatted = formatBashApproval(ui, analysis, remoteLabel);
    if (ui.select) {
      const rememberedScope = remember
        ? `\n\n${label(themeFor(ui), "Similarity rule:")} ${themeFor(ui).fg("toolOutput", remember.ruleDescription)}`
          + `\n${label(themeFor(ui), "Template:")} ${themeFor(ui).fg("muted", `${remember.strength} · ${remember.slotCount ? `${remember.slotCount} variable slot${remember.slotCount === 1 ? "" : "s"}` : "no variable slots"}`)}`
        : "";
      const prompt = `${title(themeFor(ui), "Allow Bash command?")}\n\n${formatted}${rememberedScope}`;
      const deny = "Deny";
      const once = "Allow once";
      const choices = remember ? [remember.optionLabel, once, deny] : [once, deny];
      const choice = await ui.select(prompt, choices);
      if (choice === once) return "once";
      if (remember && choice === remember.optionLabel) return "remember";
      return "deny";
    }
    // Compatibility for hosts without select: confirmation can grant this call once only.
    return await ui.confirm(title(themeFor(ui), "Allow Bash command?"), formatted) ? "once" : "deny";
  }
  catch {
    return "deny";
  }
  finally {
    ui.setWorkingMessage?.();
    ui.setWorkingIndicator?.();
    ui.setWorkingVisible?.(true);
  }
}

export async function confirmBash(ctx: { ui: Ui }, analysis: ShellAnalysis, remoteLabel?: string, notify: Notify = notifyPiWaitingForUser) {
  return (await chooseBashApproval(ctx, analysis, undefined, remoteLabel, notify)) === "once";
}
