import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LegacyStatusAdapter } from "./adapters/legacy-status.ts";
import { PiFooterAdapter } from "./adapters/pi-footer.ts";
import { onHudChange } from "./registry.ts";

export * from "./api.ts";

type HudUi = {
  requestRender?: () => void;
  setStatus?: (id: string, value?: string) => void;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
};

export default function hud(pi: ExtensionAPI) {
  const footer = new PiFooterAdapter();
  const legacy = new LegacyStatusAdapter();
  let usingLegacy = false;
  let stopRefresh: (() => void) | undefined;

  pi.on("session_start", async (_event: unknown, ctx: { ui?: HudUi }) => {
    stopRefresh?.();
    stopRefresh = undefined;
    usingLegacy = false;
    legacy.dispose();

    if (await footer.activate()) {
      stopRefresh = onHudChange(() => {
        if (ctx.ui?.requestRender) ctx.ui.requestRender();
        else ctx.ui?.setStatus?.("hud-refresh", undefined);
      });
      return;
    }

    usingLegacy = true;
    legacy.capture(ctx.ui);
    await legacy.activate();
  });

  pi.on("session_shutdown", () => {
    stopRefresh?.();
    stopRefresh = undefined;
    if (usingLegacy) legacy.dispose();
    usingLegacy = false;
  });
}
