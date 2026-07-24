import { createBashTool, isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { clearHudOwner, registerHudItem, type HudItemHandle, type HudSegment } from "../00-hud/api.ts";
import { getBashBackend, getBashLocalBoundary, getBashTargetLabel } from "../02-handoff/backend-registry.ts";
import { canAutoAllowHandoffFile, canAutoAllowLocalFile, invalidateAccessPolicyCache } from "./access-policy.ts";
import { confirmBash, confirmFileMutation, editPreview, writePreview } from "./approval-ui.ts";
import { MANAGING_STYLE_LABELS, nextManagingStyle } from "./management-style.ts";
import { clearSessionManagingStyle, currentManagingStyle, empowermentDisposableRoots, refreshManagingStyleCache, setManagingStyle, setSessionManagingStyle } from "./management-settings.ts";
import { injectPromptGuidance, BASH_PROMPT_GUIDANCE } from "./prompt-guidance.ts";
import { patchBuiltInSettingsMenu } from "./settings-ui.ts";
import { decideBash } from "./shell/policy.ts";
import { renderShell } from "./shell/render.ts";
import type { ManagingStyle, ShellContext } from "./types.ts";

export const MANAGEMENT_STYLE_CYCLE_SHORTCUT = "ctrl+;";
export const MANAGEMENT_STYLE_CYCLE_BACKWARD_SHORTCUT = "shift+ctrl+;";
let hud: HudItemHandle | undefined;
let hudStyle: ManagingStyle = "Micromanagement";
function segments(style: ManagingStyle): { full: HudSegment[]; compact: HudSegment[]; icon: HudSegment[] } {
  const empowering = style === "Empowerment"; const icon = empowering ? "▲" : "●"; const tone = empowering ? "success" : "error";
  return { full: [{ text: icon, tone }, { text: ` ${MANAGING_STYLE_LABELS[style]}`, tone: "muted" }], compact: [{ text: icon, tone }], icon: [{ text: icon, tone }] };
}
export function getManagingStyleSegments(style: ManagingStyle) { return segments(style); }
function updateHud(style: ManagingStyle) { hudStyle = style; hud?.update({ variants: segments(style), visible: true }); }
function mergeSettings() { return new Promise<void>((resolvePromise, reject) => { const child = spawn("sh", [resolve(import.meta.dirname, "../../scripts/merge-settings.sh")], { stdio: "ignore" }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`settings merge exited ${code}`))); }); }
async function saveStyle(style: ManagingStyle, ui?: { notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void }) { try { await setManagingStyle(style, mergeSettings); updateHud(style); ui?.notify?.(`Management style saved: ${MANAGING_STYLE_LABELS[style]}`, "success"); } catch (error) { updateHud(await currentManagingStyle()); ui?.notify?.(`Could not save management style: ${error instanceof Error ? error.message : String(error)}`, "error"); } }
async function cycleStyle(ctx: { ui?: { notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void } }) { const next = nextManagingStyle(await currentManagingStyle()); setSessionManagingStyle(next); updateHud(next); ctx.ui?.notify?.(`Management style: ${MANAGING_STYLE_LABELS[next]} (session only)`, "info"); }
function hasUi(ctx: any) { return Boolean(ctx?.hasUI !== false && ctx?.ui?.confirm); }

/** The only extension that registers Bash. Backend selection happens at execution time. */
export default function permissions(pi: ExtensionAPI) {
  void refreshManagingStyleCache();
  void patchBuiltInSettingsMenu(() => hudStyle, (style) => saveStyle(style), (ui) => cycleStyle({ ui }));
  pi.on("before_agent_start", (event: { systemPrompt?: string }) => ({ systemPrompt: injectPromptGuidance(event.systemPrompt) }));
  pi.on("session_start", async (_event, ctx: any) => {
    clearSessionManagingStyle(); invalidateAccessPolicyCache(); clearHudOwner("confirm-before-actions"); clearHudOwner("permissions");
    const style = await refreshManagingStyleCache(); hudStyle = style; hud?.dispose(); hud = registerHudItem({ owner: "permissions", id: "management-style", zone: "modeRight", order: 100, importance: "required", variants: segments(style) });
    void patchBuiltInSettingsMenu(() => hudStyle, (value) => saveStyle(value, ctx.ui), (ui) => cycleStyle({ ui: ui ?? ctx.ui }));
  });
  pi.on("session_shutdown", () => { hud?.dispose(); hud = undefined; clearSessionManagingStyle(); invalidateAccessPolicyCache(); });
  pi.registerShortcut?.(MANAGEMENT_STYLE_CYCLE_SHORTCUT, { description: "Cycle management style for this session", handler: cycleStyle as any });
  pi.registerShortcut?.(MANAGEMENT_STYLE_CYCLE_BACKWARD_SHORTCUT, { description: "Cycle management style backward for this session", handler: cycleStyle as any });
  const originalBash = createBashTool(process.cwd());
  const originalGuidelines = Array.isArray((originalBash as any).promptGuidelines) ? (originalBash as any).promptGuidelines : [];
  pi.registerTool({ ...originalBash, promptGuidelines: [...originalGuidelines, BASH_PROMPT_GUIDANCE], async execute(toolCallId: any, params: any, signal: any, onUpdate: any, ctx: any) { const operations = getBashBackend(); return createBashTool(ctx.cwd, operations ? { operations } : undefined).execute(toolCallId, params, signal, onUpdate, ctx); }, renderCall(args: { command?: string }, theme: any) { return new Text(renderShell(args.command, theme), 0, 0); } });
  pi.on("tool_call", async (event: any, ctx: any) => {
    const style = await currentManagingStyle(); updateHud(style);
    if (isToolCallEventType("bash", event)) {
      const remoteLabel = getBashTargetLabel();
      const executionContext: ShellContext = remoteLabel
        ? { location: "remote", transport: "handoff", target: remoteLabel, usesNetwork: true }
        : { location: "local", usesNetwork: false };
      const decision = decideBash(event.input.command, style, executionContext);
      if (decision.allow) return undefined;
      if (!decision.needsApproval) return { block: true, reason: decision.reason };
      if (!hasUi(ctx)) return { block: true, reason: "Bash command blocked (no UI available for confirmation)" };
      const ok = await confirmBash(ctx, decision.analysis!, remoteLabel);
      return ok ? undefined : { block: true, reason: "Bash command blocked by user" };
    }
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const write = isToolCallEventType("write", event); const allowed = style === "Empowerment" && (getBashBackend() ? await canAutoAllowHandoffFile(event.input.path, ctx.cwd, getBashLocalBoundary()) : await canAutoAllowLocalFile(event.input.path, ctx.cwd, await empowermentDisposableRoots()));
      if (allowed) return undefined;
      const noun = write ? "write" : "edit"; if (!hasUi(ctx)) return { block: true, reason: `File ${noun} blocked (no UI available for confirmation)` };
      const edits = event.input.edits ?? [{ oldText: event.input.oldText ?? "", newText: event.input.newText ?? "" }];
      const ok = await confirmFileMutation(ctx, { title: `Allow file ${noun}?`, path: event.input.path, preview: write ? writePreview(event.input.content) : editPreview(edits), summary: write ? (event.input.content ? `\n\nNew content: ${event.input.content.split("\n").length} lines, ${event.input.content.length} chars` : "") : `\n\nChanges: ${edits.length} replacement${edits.length === 1 ? "" : "s"}` });
      return ok ? undefined : { block: true, reason: `File ${noun} blocked by user` };
    }
    return undefined;
  });
}
