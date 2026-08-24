import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionContext,
  ExtensionUIContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { layoutFooter } from "../layout.ts";
import { onHudChange } from "../registry.ts";
import { setHudStyler } from "../render.ts";
import type { HudTone } from "../types.ts";
import type { HudAdapter } from "./types.ts";

const toneToken: Record<HudTone, "accent" | "success" | "dim" | "warning" | "error" | "text"> = {
  accent: "accent",
  success: "success",
  muted: "dim",
  warning: "warning",
  error: "error",
  text: "text",
};

type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

function addUsage(totals: UsageTotals, usage: UsageLike | undefined): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
}

/** Match Pi's compact token formatting without importing its private footer. */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/** Match Pi's home-relative CWD display using only public session data. */
export function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome = relativeToHome === ""
    || (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** Reconstruct the public-data equivalent of Pi's native footer rows. */
export function nativeFooterLines(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  theme: Theme,
  width: number,
): string[] {
  const safeWidth = Math.max(0, width);
  if (safeWidth === 0) return [];

  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let latestCacheHitRate: number | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const usage = entry.message.usage as UsageLike;
      addUsage(totals, usage);
      const latestPromptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      latestCacheHitRate = latestPromptTokens > 0 ? ((usage.cacheRead ?? 0) / latestPromptTokens) * 100 : undefined;
    } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
      addUsage(totals, entry.message.usage as UsageLike);
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      addUsage(totals, entry.usage as UsageLike);
    }
  }

  const contextUsage = ctx.getContextUsage();
  const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const contextPercentValue = contextUsage?.percent ?? 0;
  const contextPercent = contextUsage?.percent === null ? "?" : contextPercentValue.toFixed(1);

  let pwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
  const branch = footerData.getGitBranch();
  if (branch) pwd = `${pwd} (${branch})`;
  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) pwd = `${pwd} • ${sessionName}`;

  const statsParts: string[] = [];
  if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
  if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
  if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
  if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
    statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
  }
  if (totals.cost) statsParts.push(`$${totals.cost.toFixed(3)}`);

  const contextDisplay = contextPercent === "?"
    ? `?/${formatTokens(contextWindow)}`
    : `${contextPercent}%/${formatTokens(contextWindow)}`;
  if (contextPercentValue > 90) statsParts.push(theme.fg("error", contextDisplay));
  else if (contextPercentValue > 70) statsParts.push(theme.fg("warning", contextDisplay));
  else statsParts.push(contextDisplay);

  let statsLeft = statsParts.join(" ");
  let statsLeftWidth = visibleWidth(statsLeft);
  if (statsLeftWidth > safeWidth) {
    statsLeft = truncateToWidth(statsLeft, safeWidth, "...");
    statsLeftWidth = visibleWidth(statsLeft);
  }

  const modelName = ctx.model?.id || "no-model";
  let rightSideWithoutProvider = modelName;
  if (ctx.model?.reasoning) {
    const thinkingLevel = ctx.thinkingLevel || "off";
    rightSideWithoutProvider = thinkingLevel === "off"
      ? `${modelName} • thinking off`
      : `${modelName} • ${thinkingLevel}`;
  }

  const minPadding = 2;
  let rightSide = rightSideWithoutProvider;
  if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
    rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
    if (statsLeftWidth + minPadding + visibleWidth(rightSide) > safeWidth) rightSide = rightSideWithoutProvider;
  }

  const rightSideWidth = visibleWidth(rightSide);
  let statsLine: string;
  if (statsLeftWidth + minPadding + rightSideWidth <= safeWidth) {
    statsLine = statsLeft + " ".repeat(safeWidth - statsLeftWidth - rightSideWidth) + rightSide;
  } else {
    const availableForRight = safeWidth - statsLeftWidth - minPadding;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
      statsLine = statsLeft
        + " ".repeat(Math.max(0, safeWidth - statsLeftWidth - visibleWidth(truncatedRight)))
        + truncatedRight;
    } else {
      statsLine = statsLeft;
    }
  }

  const dimStatsLeft = theme.fg("dim", statsLeft);
  const dimRemainder = theme.fg("dim", statsLine.slice(statsLeft.length));
  const pwdLine = truncateToWidth(theme.fg("dim", pwd), safeWidth, theme.fg("dim", "..."));
  const lines = [pwdLine, dimStatsLeft + dimRemainder];

  const statuses = Array.from(footerData.getExtensionStatuses().entries())
    .filter(([key]) => key !== "hud")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeStatusText(text));
  if (statuses.length > 0) {
    lines.push(truncateToWidth(statuses.join(" "), safeWidth, theme.fg("dim", "...")));
  }

  return lines;
}

class HudFooterComponent implements Component {
  private disposed = false;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly footerData: ReadonlyFooterDataProvider,
  ) {
    setHudStyler((tone, text) => this.theme.fg(toneToken[tone], text));
    const requestRender = () => {
      if (!this.disposed) {
        try { this.tui.requestRender(); } catch { /* stale TUI during session replacement */ }
      }
    };
    const unsubscribeHud = onHudChange(requestRender);
    this.unsubscribers.push(unsubscribeHud);
    try {
      this.unsubscribers.push(this.footerData.onBranchChange(requestRender));
    } catch (error) {
      unsubscribeHud();
      this.unsubscribers.length = 0;
      setHudStyler(undefined);
      throw error;
    }
  }

  render(width: number): string[] {
    try {
      return layoutFooter(nativeFooterLines(this.ctx, this.footerData, this.theme, width), width);
    } catch {
      // Session-bound ExtensionContext objects become stale briefly while Pi
      // replaces sessions. A footer render must never break that transition.
      return [];
    }
  }

  invalidate(): void {
    if (!this.disposed) setHudStyler((tone, text) => this.theme.fg(toneToken[tone], text));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try { unsubscribe(); } catch { /* best-effort cleanup */ }
    }
    setHudStyler(undefined);
  }
}

type FooterUi = Pick<ExtensionUIContext, "setFooter">;

/** Install the HUD through Pi's public custom-footer API in TUI mode. */
export class PublicFooterAdapter implements HudAdapter {
  private ui: FooterUi | undefined;
  private ctx: ExtensionContext | undefined;
  private component: HudFooterComponent | undefined;
  private installed = false;

  capture(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.ui = ctx.ui;
  }

  async activate(): Promise<boolean> {
    if (this.ctx?.mode !== "tui" || typeof this.ui?.setFooter !== "function") return false;
    const ctx = this.ctx;
    const ui = this.ui;
    try {
      ui.setFooter((tui, theme, footerData) => {
        this.component?.dispose();
        return this.component = new HudFooterComponent(ctx, tui, theme, footerData);
      });
      this.installed = true;
      return true;
    } catch {
      this.component?.dispose();
      this.component = undefined;
      try { ui.setFooter(undefined); } catch { /* best-effort restore */ }
      return false;
    }
  }

  dispose(): void {
    const ui = this.ui;
    const component = this.component;
    const installed = this.installed;
    this.ui = undefined;
    this.ctx = undefined;
    this.component = undefined;
    this.installed = false;
    if (installed) {
      try { ui?.setFooter(undefined); } catch { /* stale UI during session replacement */ }
    }
    component?.dispose();
    setHudStyler(undefined);
  }
}
