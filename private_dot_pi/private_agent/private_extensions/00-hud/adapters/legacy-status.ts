import { onHudChange } from "../registry.ts";
import { renderZone, setHudStyler } from "../render.ts";
import type { HudTone } from "../types.ts";
import type { HudAdapter } from "./types.ts";

type HudThemeToken = "accent" | "success" | "dim" | "warning" | "error" | "text";

export type HudUi = {
  setStatus?: (id: string, value?: string) => void;
  theme?: { fg?: (token: HudThemeToken, text: string) => string };
};

const toneToken: Record<HudTone, HudThemeToken> = {
  accent: "accent",
  success: "success",
  muted: "dim",
  warning: "warning",
  error: "error",
  text: "text",
};

/** Render the semantic HUD registry through Pi's supported status API. */
export class LegacyStatusAdapter implements HudAdapter {
  private ui: HudUi | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly refresh = () => {
    const line = [renderZone("modeRight", 1000), renderZone("workspaceRight", 1000), renderZone("extensionLine", 1000)]
      .filter(Boolean)
      .join(" │ ");
    this.ui?.setStatus?.("hud", line || undefined);
  };

  capture(ui: HudUi | undefined) {
    this.ui = ui;
    const theme = ui?.theme;
    setHudStyler(theme?.fg ? (tone, text) => theme.fg!(toneToken[tone], text) : undefined);
    this.refresh();
  }

  async activate(): Promise<boolean> {
    if (!this.ui?.setStatus) return false;
    this.unsubscribe ??= onHudChange(this.refresh);
    this.refresh();
    return true;
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.ui?.setStatus?.("hud", undefined);
    this.ui = undefined;
    setHudStyler(undefined);
  }
}
