import { onHudChange } from "../registry.ts";
import { renderZone } from "../render.ts";
import type { HudAdapter } from "./types.ts";

const WARNED = Symbol.for("pi.hud.legacy-warning.v1");
type WarningGlobal = typeof globalThis & { [WARNED]?: boolean };

/** Last-resort compatibility for Pi versions without the private footer component. */
export class LegacyStatusAdapter implements HudAdapter {
  private ui: {
    setStatus?: (id: string, value?: string) => void;
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
  } | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly refresh = () => {
    const line = [renderZone("modeRight", 1000), renderZone("workspaceRight", 1000), renderZone("extensionLine", 1000)].filter(Boolean).join(" │ ");
    this.ui?.setStatus?.("hud", line || undefined);
  };

  capture(ui: typeof this.ui) { this.ui = ui; this.refresh(); }
  async activate(): Promise<boolean> {
    this.unsubscribe ??= onHudChange(this.refresh);
    const global = globalThis as WarningGlobal;
    if (!global[WARNED]) {
      global[WARNED] = true;
      const message = "HUD: footer integration unavailable; using legacy status line";
      if (this.ui?.notify) this.ui.notify(message, "warning");
      else console.warn(message);
    }
    this.refresh();
    return true;
  }
  dispose() { this.unsubscribe?.(); this.unsubscribe = undefined; this.ui?.setStatus?.("hud", undefined); this.ui = undefined; }
}
