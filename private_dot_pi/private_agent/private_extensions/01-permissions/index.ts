import { createBashTool, isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { clearHudOwner, registerHudItem, type HudItemHandle, type HudSegment } from "../00-hud/api.ts";
import { clearRemoteRouteForToolCall, consumeRemoteRouteForToolCall, getBashApprovalScope, getBashBackend, getBashLocalBoundary, getBashTargetLabel, getRemoteRoute, hasActiveRemoteRoute, requireRemoteRouteForToolCall, subscribeRemoteRoute } from "../02-handoff/backend-registry.ts";
import { importPiModule } from "../packages/pi-package.ts";
import { canAutoAllowHandoffFile, canAutoAllowLocalFile, invalidateAccessPolicyCache } from "./access-policy.ts";
import { chooseBashApproval, confirmFileMutation, editPreview, writePreview } from "./approval-ui.ts";
import { MANAGING_STYLE_LABELS, nextManagingStyle } from "./management-style.ts";
import { clearSessionManagingStyle, currentManagingStyle, empowermentDisposableRoots, permissionsSessionApprovalMaxRules, refreshManagingStyleCache, restoreManagingStyleAfterYolo, setManagingStyle, setSessionManagingStyle } from "./management-settings.ts";
import { injectPromptGuidance, BASH_PROMPT_GUIDANCE } from "./prompt-guidance.ts";
import { patchBuiltInSettingsMenu } from "./settings-ui.ts";
import { getCachedBackwardHotkey, getCachedForwardHotkey } from "./shortcuts.ts";
import { verifyAutoAllowIdentity } from "./shell/executable-identity.ts";
import { decideAnalysis, inspectBash } from "./shell/policy.ts";
import { approvalCandidate } from "./shell/session-approval-candidate.ts";
import { approvalFingerprint, bindSessionApprovalsToStyle, clearSessionApprovals, findSessionApproval, listSessionApprovals, rememberSessionApproval, revokeSessionApproval, withPendingApproval } from "./session-command-approvals.ts";
import { renderShell } from "./shell/render.ts";
import type { ManagingStyle, PersistedManagingStyle, ShellContext } from "./types.ts";

let hud: HudItemHandle | undefined;
let hudStyle: ManagingStyle = "Micromanagement";
function segments(style: ManagingStyle): { full: HudSegment[]; compact: HudSegment[]; icon: HudSegment[] } {
  const presentation = style === "Micromanagement"
    ? { icon: "■", tone: "error" as const }
    : style === "Empowerment"
      ? { icon: "▲", tone: "warning" as const }
      : { icon: "●", tone: "success" as const };
  return { full: [{ text: presentation.icon, tone: presentation.tone }, { text: ` ${MANAGING_STYLE_LABELS[style]}`, tone: "muted" }], compact: [{ text: presentation.icon, tone: presentation.tone }], icon: [{ text: presentation.icon, tone: presentation.tone }] };
}
export function getManagingStyleSegments(style: ManagingStyle) { return segments(style); }
function updateHud(style: ManagingStyle) { hudStyle = style; hud?.update({ variants: segments(style), visible: true }); }
function mergeSettings() { return new Promise<void>((resolvePromise, reject) => { const child = spawn("sh", [resolve(import.meta.dirname, "../../scripts/merge-settings.sh")], { stdio: "ignore" }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`settings merge exited ${code}`))); }); }
type NotifyUi = { notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void };
function bindRuntimeStyle(style: ManagingStyle) { clearSessionApprovals(); bindSessionApprovalsToStyle(style); updateHud(style); }
async function activeStyle(): Promise<ManagingStyle> {
  const style = await currentManagingStyle();
  if (style === "YOLO" && !hasActiveRemoteRoute()) {
    const restored = restoreManagingStyleAfterYolo();
    bindRuntimeStyle(restored);
    return restored;
  }
  return style;
}
async function selectStyle(style: ManagingStyle, ui?: NotifyUi) {
  if (style === "YOLO") {
    if (!hasActiveRemoteRoute()) return ui?.notify?.("YOLO requires an active Handoff remote tool route", "warning");
    setSessionManagingStyle("YOLO");
    bindRuntimeStyle("YOLO");
    return ui?.notify?.("Management style: YOLO (remote Handoff tools only; session only)", "info");
  }
  try {
    await setManagingStyle(style as PersistedManagingStyle, mergeSettings);
    bindRuntimeStyle(style);
    ui?.notify?.(`Management style saved: ${MANAGING_STYLE_LABELS[style]}`, "success");
  } catch (error) {
    updateHud(await activeStyle());
    ui?.notify?.(`Could not save management style: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}
async function cycleStyle(ctx: { ui?: NotifyUi }, direction: 1 | -1 = 1) {
  const next = nextManagingStyle(await activeStyle(), hasActiveRemoteRoute(), direction);
  setSessionManagingStyle(next);
  bindRuntimeStyle(next);
  ctx.ui?.notify?.(`Management style: ${MANAGING_STYLE_LABELS[next]} (session only)`, "info");
}
function hasBashUi(ctx: any) { return Boolean(ctx?.hasUI !== false && (ctx?.ui?.select || ctx?.ui?.confirm)); }
function hasConfirmUi(ctx: any) { return Boolean(ctx?.hasUI !== false && ctx?.ui?.confirm); }
function preservesApprovals(event: any) { return event?.reason === "reload"; }

/** The only extension that registers Bash. Backend selection happens at execution time. */
export default async function permissions(pi: ExtensionAPI) {
  await refreshManagingStyleCache();
  const shellEnvironment = await importPiModule("dist/utils/shell.js")
    .then((module) => typeof module.getShellEnv === "function" ? module.getShellEnv as () => NodeJS.ProcessEnv : undefined)
    .catch(() => undefined);
  void patchBuiltInSettingsMenu(() => hudStyle, (style) => selectStyle(style), (ui) => cycleStyle({ ui }, -1));
  let unsubscribeRemoteRoute: (() => void) | undefined;
  const watchRemoteRoute = () => {
    if (unsubscribeRemoteRoute) return;
    unsubscribeRemoteRoute = subscribeRemoteRoute((active) => {
      if (active) return;
      void activeStyle();
    });
  };
  watchRemoteRoute();
  pi.on("before_agent_start", (event: { systemPrompt?: string }) => ({ systemPrompt: injectPromptGuidance(event.systemPrompt) }));
  pi.on("session_start", async (event: any, ctx: any) => {
    watchRemoteRoute();
    if (!preservesApprovals(event)) clearSessionApprovals();
    clearSessionManagingStyle(); invalidateAccessPolicyCache(); clearHudOwner("confirm-before-actions"); clearHudOwner("permissions");
    const style = await refreshManagingStyleCache(); bindSessionApprovalsToStyle(style); hudStyle = style; hud?.dispose(); hud = registerHudItem({ owner: "permissions", id: "management-style", zone: "modeRight", order: 100, importance: "required", variants: segments(style) });
    void patchBuiltInSettingsMenu(() => hudStyle, (value) => selectStyle(value, ctx.ui), (ui) => cycleStyle({ ui: ui ?? ctx.ui }, -1));
  });
  pi.on("session_shutdown", (event: any) => { unsubscribeRemoteRoute?.(); unsubscribeRemoteRoute = undefined; hud?.dispose(); hud = undefined; if (!preservesApprovals(event)) clearSessionApprovals(); clearSessionManagingStyle(); invalidateAccessPolicyCache(); });
  const forward = getCachedForwardHotkey();
  const backward = getCachedBackwardHotkey();
  pi.registerShortcut?.(forward, { description: "Cycle management style for this session", handler: cycleStyle as any });
  pi.registerShortcut?.(backward, { description: "Cycle management style backward for this session", handler: ((ctx: any) => cycleStyle(ctx, -1)) as any });
  pi.registerCommand?.("session-approvals", {
    description: "Manage remembered command approvals for this session",
    handler: (async (_args: string, ctx: any) => {
      const rules = listSessionApprovals();
      if (!rules.length) return ctx.ui?.notify?.("No remembered Bash approvals for this session", "info");
      if (!ctx.ui?.select) return ctx.ui?.notify?.("Session approvals require an interactive UI", "warning");
      const clearAll = "Clear all session approvals";
      const close = "Close";
      const ruleChoices = rules.map((rule, index) => `${index + 1}) ${rule.label}`);
      const choice = await ctx.ui.select("Session approvals", [...ruleChoices, clearAll, close]);
      if (choice === clearAll) {
        clearSessionApprovals();
        return ctx.ui.notify?.("Cleared session approvals", "success");
      }
      if (!choice || choice === close) return;
      const selectedIndex = ruleChoices.indexOf(choice);
      if (selectedIndex < 0) return;
      const action = await ctx.ui.select("Selected session approval", ["Revoke approval", "Back"]);
      if (action === "Revoke approval" && revokeSessionApproval(rules[selectedIndex]!.id)) return ctx.ui.notify?.("Revoked session approval", "success");
    }) as any,
  });
  const originalBash = createBashTool(process.cwd());
  const originalGuidelines = Array.isArray((originalBash as any).promptGuidelines) ? (originalBash as any).promptGuidelines : [];
  pi.registerTool({ ...originalBash, promptGuidelines: [...originalGuidelines, BASH_PROMPT_GUIDANCE], async execute(toolCallId: any, params: any, signal: any, onUpdate: any, ctx: any) { const authorization = consumeRemoteRouteForToolCall(toolCallId); if (authorization.required && !authorization.route) throw new Error("Remote Handoff route changed after YOLO authorization"); const operations = authorization.route?.backend ?? getBashBackend(); return createBashTool(ctx.cwd, operations ? { operations } : undefined).execute(toolCallId, params, signal, onUpdate, ctx); }, renderCall(args: { command?: string }, theme: any) { return new Text(renderShell(args.command, theme), 0, 0); } });
  pi.on("tool_execution_end", (event: any) => { if (typeof event.toolCallId === "string") clearRemoteRouteForToolCall(event.toolCallId); });
  pi.on("tool_call", async (event: any, ctx: any) => {
    const style = await activeStyle(); updateHud(style);
    const remoteRoute = getRemoteRoute();
    // YOLO is a Handoff capability, not a local permission mode. This precedes parsing,
    // identity, access, session-approval, chooser, and confirmation checks.
    if (style === "YOLO" && remoteRoute && (isToolCallEventType("bash", event) || isToolCallEventType("write", event) || isToolCallEventType("edit", event))) {
      if (typeof event.toolCallId !== "string" || !requireRemoteRouteForToolCall(event.toolCallId, remoteRoute)) return { block: true, reason: "Remote Handoff route is unavailable for YOLO authorization" };
      return undefined;
    }
    if (isToolCallEventType("bash", event)) {
      const remoteLabel = getBashTargetLabel();
      const executionContext: ShellContext = remoteLabel
        ? { location: "remote", transport: "handoff", target: remoteLabel, usesNetwork: true }
        : { location: "local", usesNetwork: false };
      const inspection = inspectBash(event.input.command, executionContext);
      const decision = decideAnalysis(inspection.analysis, style as PersistedManagingStyle);
      const executionEnv = shellEnvironment?.();
      const hasLocalExecutable = inspection.analysis.identityRequirements.some((requirement) => requirement.context.location === "local");
      let approvalAnalysis = inspection.analysis;
      let identityVeto = false;
      if (decision.allow) {
        const identity = hasLocalExecutable && !executionEnv
          ? { ok: false as const, reason: "shell execution environment could not be verified" }
          : await verifyAutoAllowIdentity(inspection.analysis, ctx.cwd, executionEnv ? { env: executionEnv } : {});
        if (identity.ok) return undefined;
        identityVeto = true;
        approvalAnalysis = { ...inspection.analysis, reasons: [...new Set([...inspection.analysis.reasons, identity.reason])] };
      }
      // Structural authorization is final: identity checks can only veto; grants never override Micromanagement or split blocks.
      if (!identityVeto && !decision.needsApproval) return { block: true, reason: decision.reason };
      if (style !== "Empowerment") {
        if (!hasBashUi(ctx)) return { block: true, reason: "Bash command blocked (no UI available for confirmation)" };
        const choice = await chooseBashApproval(ctx, approvalAnalysis, undefined, remoteLabel);
        return choice === "once" ? undefined : { block: true, reason: "Bash command blocked by user" };
      }
      const candidate = identityVeto || (hasLocalExecutable && !executionEnv)
        ? undefined
        : await approvalCandidate(inspection, ctx.cwd, getBashApprovalScope(), executionEnv);
      if (candidate && findSessionApproval(candidate.rule)) return undefined;
      if (!hasBashUi(ctx)) return { block: true, reason: "Bash command blocked (no UI available for confirmation)" };
      const flowIdentity = candidate?.rule ?? approvalFingerprint("flow", inspection.analysis.source, executionContext.location, executionContext.transport ?? "");
      const outcome = await withPendingApproval(flowIdentity.fingerprint, async () => {
        if (candidate && findSessionApproval(candidate.rule)) return "approved" as const;
        const choice = await chooseBashApproval(
          ctx,
          approvalAnalysis,
          candidate ? { optionLabel: candidate.rememberLabel, ruleDescription: candidate.ruleDescription, strength: candidate.rule.strength, slotCount: candidate.rule.slotCount } : undefined,
          remoteLabel,
        );
        if (choice !== "remember" || !candidate) return choice;
        const remembered = rememberSessionApproval(candidate.rule, await permissionsSessionApprovalMaxRules());
        if (remembered.ok) return "approved" as const;
        const warning = remembered.reason === "limit-reached"
          ? "Session approval limit reached; allowed once without remembering"
          : remembered.reason === "epoch-mismatch"
            ? "Session approval expired; allowed once without remembering"
            : remembered.reason === "invalid-rule"
              ? "Session approval template is invalid; allowed once without remembering"
              : "Session approval limit configuration is invalid; allowed once without remembering";
        ctx.ui?.notify?.(warning, "warning");
        return "once" as const;
      });
      return outcome === "deny" ? { block: true, reason: "Bash command blocked by user" } : undefined;
    }
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const write = isToolCallEventType("write", event); const allowed = style === "Empowerment" && (getBashBackend() ? await canAutoAllowHandoffFile(event.input.path, ctx.cwd, getBashLocalBoundary()) : await canAutoAllowLocalFile(event.input.path, ctx.cwd, await empowermentDisposableRoots()));
      if (allowed) return undefined;
      const noun = write ? "write" : "edit"; if (!hasConfirmUi(ctx)) return { block: true, reason: `File ${noun} blocked (no UI available for confirmation)` };
      const edits = event.input.edits ?? [{ oldText: event.input.oldText ?? "", newText: event.input.newText ?? "" }];
      const ok = await confirmFileMutation(ctx, { title: `Allow file ${noun}?`, path: event.input.path, preview: write ? writePreview(event.input.content) : editPreview(edits), summary: write ? (event.input.content ? `\n\nNew content: ${event.input.content.split("\n").length} lines, ${event.input.content.length} chars` : "") : `\n\nChanges: ${edits.length} replacement${edits.length === 1 ? "" : "s"}` });
      return ok ? undefined : { block: true, reason: `File ${noun} blocked by user` };
    }
    return undefined;
  });
}
