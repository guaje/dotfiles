# HUD

The HUD is the sole status owner. Extensions publish semantic `HudItem`s through `api.ts`; they must not write ANSI or call Pi footer/status APIs directly. Items are process-global (`Symbol.for("pi.hud.registry.v1")`), owner-scoped, and safe to replace after `/reload`.

In TUI mode the HUD uses Pi's public `ctx.ui.setFooter` component API. It reconstructs the native footer from public `ExtensionContext` and `FooterData` only, then adds the HUD zones in this order:

1. `modeRight`, right-aligned on its own top row
2. CWD/git branch/session name with `workspaceRight` beside it
3. native-equivalent usage, cache-hit, cost, context, provider/model, and thinking stats
4. non-HUD extension statuses from `FooterData`
5. `extensionLine`

The renderer downgrades `full`, `compact`, then `icon`, and hides non-required items when necessary. RPC and non-TUI implementations fall back to the supported `setStatus` adapter.

The public extension API does not expose three private native-footer settings, so exact fidelity is impossible for subscription billing (`(sub)`), auto-compaction (`(auto)`), and experimental mode (`xp`). The custom footer intentionally omits those indicators; all publicly available native data and ANSI-safe layout behavior are preserved.
