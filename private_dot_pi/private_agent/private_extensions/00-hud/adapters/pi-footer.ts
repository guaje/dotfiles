import { importPiModule } from "../../packages/pi-package.ts";
import { hudInnerWidth, layoutFooter } from "../layout.ts";
import { setHudStyler } from "../render.ts";
import type { HudTone } from "../types.ts";
import type { HudAdapter } from "./types.ts";

const PATCH = Symbol.for("pi.hud.footer.patch.v1");
const COMPOSITOR = Symbol.for("pi.hud.footer.compositor.v1");
const FOOTER_PATH = "dist/modes/interactive/components/footer.js";
const THEME_PATH = "dist/modes/interactive/theme/theme.js";

type CompositorGlobal = typeof globalThis & { [COMPOSITOR]?: typeof layoutFooter };

const toneToken: Record<HudTone, string> = {
  accent: "accent",
  success: "success",
  muted: "dim",
  warning: "warning",
  error: "error",
  text: "text",
};

export class PiFooterAdapter implements HudAdapter {
  async activate(): Promise<boolean> {
    try {
      (globalThis as CompositorGlobal)[COMPOSITOR] = layoutFooter;

      try {
        const themeModule = await importPiModule(THEME_PATH);
        const theme = themeModule?.theme as { fg?: (token: string, text: string) => string } | undefined;
        setHudStyler(theme?.fg ? (tone, text) => theme.fg!(toneToken[tone], text) : undefined);
      }
      catch {
        setHudStyler(undefined);
      }

      const module = await importPiModule(FOOTER_PATH);
      const prototype = module?.FooterComponent?.prototype as Record<PropertyKey, unknown> | undefined;
      if (!prototype || typeof prototype.render !== "function") return false;
      if (prototype[PATCH]) return true;

      const originalRender = prototype.render as (this: unknown, width: number) => string[];
      prototype[PATCH] = true;
      prototype.render = function hudRender(this: unknown, width: number) {
        try {
          const originalLines = originalRender.call(this, hudInnerWidth(width));
          const compositor = (globalThis as CompositorGlobal)[COMPOSITOR] ?? layoutFooter;
          return compositor(originalLines, width);
        }
        catch {
          return originalRender.call(this, width);
        }
      };
      return true;
    }
    catch {
      return false;
    }
  }

  dispose() {
    // The process-wide prototype patch intentionally survives /reload. Its
    // compositor and semantic theme renderer are replaced on activation.
  }
}
