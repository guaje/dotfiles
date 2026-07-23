# HUD

The HUD is the sole footer-layout owner. Extensions publish semantic `HudItem`s through `api.ts`; they must not write ANSI or patch Pi footer/status APIs. Items are process-global (`Symbol.for("pi.hud.registry.v1")`), owner-scoped, and safe to replace after `/reload`.

Zones are `modeRight`, `workspaceRight`, and `extensionLine`. The renderer downgrades `full`, `compact`, then `icon`, and hides non-required items when necessary.
