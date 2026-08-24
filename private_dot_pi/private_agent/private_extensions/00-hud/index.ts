import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LegacyStatusAdapter } from "./adapters/legacy-status.ts";
import { PublicFooterAdapter } from "./adapters/public-footer.ts";

export * from "./api.ts";

export default function hud(pi: ExtensionAPI) {
  const footer = new PublicFooterAdapter();
  const status = new LegacyStatusAdapter();

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    footer.dispose();
    status.dispose();

    footer.capture(ctx);
    if (await footer.activate()) return;

    // RPC and older/non-TUI UI implementations retain the supported status
    // path; only interactive TUI sessions replace the footer component.
    status.capture(ctx.ui);
    await status.activate();
  });

  pi.on("session_shutdown", () => {
    footer.dispose();
    status.dispose();
  });
}
