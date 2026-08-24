// Run with: npx -y tsx --test agent/extensions/00-hud/tests/adapter.test.ts
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { after } from "node:test";

const stubDir = resolve("agent/extensions/node_modules/@earendil-works/pi-tui");
mkdirSync(stubDir, { recursive: true });
writeFileSync(resolve(stubDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", type: "module", exports: "./index.js" }));
writeFileSync(resolve(stubDir, "index.js"), `
const strip = (value) => String(value).replace(/\\x1b\\[[0-?]*[ -\\/]*[@-~]/g, "");
export function visibleWidth(value) { return [...strip(value)].length; }
export function truncateToWidth(value, width, marker = "") {
  const text = String(value);
  if (visibleWidth(text) <= width) return text;
  return [...strip(text)].slice(0, Math.max(0, width - visibleWidth(marker))).join("") + marker;
}
`);

after(() => rmSync(stubDir, { recursive: true, force: true }));

const variants = (text: string) => ({ full: [{ text }] });

test("status adapter remains the semantic fallback and clears cleanly", async () => {
  const [{ LegacyStatusAdapter }, registry] = await Promise.all([
    import("../adapters/legacy-status.ts"),
    import("../registry.ts"),
  ]);
  const statuses: Array<{ id: string; value: string | undefined }> = [];
  const adapter = new LegacyStatusAdapter();
  adapter.capture({
    setStatus: (id, value) => statuses.push({ id, value }),
    theme: { fg: (tone, text) => `<${tone}>${text}</${tone}>` },
  });
  assert.equal(await adapter.activate(), true);
  assert.equal(await adapter.activate(), true);

  const mode = registry.registerHudItem({ owner: "status-test", id: "mode", zone: "modeRight", importance: "required", variants: { full: [{ text: "▲", tone: "success" }, { text: " Empowering", tone: "muted" }] } });
  const route = registry.registerHudItem({ owner: "status-test", id: "route", zone: "workspaceRight", importance: "normal", variants: { full: [{ text: "⌂", tone: "accent" }, { text: " local", tone: "muted" }] } });
  const extension = registry.registerHudItem({ owner: "status-test", id: "extension", zone: "extensionLine", importance: "optional", variants: { full: [{ text: "!", tone: "warning" }] } });

  assert.deepEqual(statuses.at(-1), {
    id: "hud",
    value: "<success>▲</success><dim> Empowering</dim> │ <accent>⌂</accent><dim> local</dim> │ <warning>!</warning>",
  });

  const beforeUpdate = statuses.length;
  mode.update({ variants: { full: [{ text: "■", tone: "error" }] } });
  assert.equal(statuses.length, beforeUpdate + 1);
  assert.match(statuses.at(-1)?.value ?? "", /<error>■<\/error>/);

  adapter.dispose();
  assert.deepEqual(statuses.at(-1), { id: "hud", value: undefined });
  const afterDispose = statuses.length;
  route.update({ visible: false });
  assert.equal(statuses.length, afterDispose);

  mode.dispose();
  route.dispose();
  extension.dispose();
});

test("TUI entrypoint registers a public footer with native rows and exact HUD placement", async () => {
  const [{ default: hud }, registry, render] = await Promise.all([
    import("../index.ts"),
    import("../registry.ts"),
    import("../render.ts"),
  ]);
  type Handler = (event: unknown, ctx: any) => unknown;
  const handlers = new Map<string, Handler>();
  hud({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as any);

  const mode = registry.registerHudItem({ owner: "footer-test", id: "mode", zone: "modeRight", importance: "required", variants: variants("▲ Empowering") });
  const workspace = registry.registerHudItem({ owner: "footer-test", id: "workspace", zone: "workspaceRight", importance: "normal", variants: variants("⌂ local") });
  const extension = registry.registerHudItem({ owner: "footer-test", id: "extension", zone: "extensionLine", importance: "optional", variants: variants("logs ready") });

  let branchCallback: (() => void) | undefined;
  let renderRequests = 0;
  let component: any;
  const footerCalls: unknown[] = [];
  const footerData = {
    getGitBranch: () => "main",
    getAvailableProviderCount: () => 2,
    getExtensionStatuses: () => new Map([
      ["z-status", "z\nstatus"],
      ["hud", "must not be duplicated"],
      ["alpha", "alpha"],
    ]),
    onBranchChange: (callback: () => void) => {
      branchCallback = callback;
      return () => { if (branchCallback === callback) branchCallback = undefined; };
    },
  };
  const tui = { requestRender: () => { renderRequests++; } };
  let ansiStyling = false;
  const theme = { fg: (_tone: string, text: string) => ansiStyling ? `\u001b[32m${text}\u001b[0m` : text };
  const ui = {
    setFooter(factory: any) {
      footerCalls.push(factory);
      if (factory === undefined) {
        component?.dispose?.();
        component = undefined;
      } else {
        component = factory(tui, theme, footerData);
      }
    },
    setStatus() { assert.fail("TUI HUD must not use setStatus"); },
  };
  const ctx = {
    mode: "tui",
    ui,
    sessionManager: {
      getCwd: () => resolve(process.env.HOME ?? "/tmp", "project"),
      getSessionName: () => "demo",
      getEntries: () => [
        { type: "message", message: { role: "assistant", usage: { input: 1200, output: 345, cacheRead: 800, cacheWrite: 200, cost: { total: 0.01234 } } } },
        { type: "message", message: { role: "toolResult", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } } },
        { type: "compaction", usage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0004 } } },
      ],
    },
    getContextUsage: () => ({ tokens: 100000, contextWindow: 200000, percent: 50 }),
    model: { id: "test-model", provider: "test-provider", reasoning: true, contextWindow: 200000 },
    thinkingLevel: "high",
  };

  await handlers.get("session_start")?.({}, ctx);
  assert.equal(typeof footerCalls.at(-1), "function");
  assert.ok(component, "setFooter factory should create a real TUI component");

  const width = 100;
  const statsLeft = "↑1.2k ↓370 R800 W200 CH36.4% $0.014 50.0%/200k";
  const statsRight = "(test-provider) test-model • high";
  assert.deepEqual(component.render(width), [
    `${" ".repeat(width - "▲ Empowering".length)}▲ Empowering`,
    `~/project (main) • demo${" ".repeat(width - "~/project (main) • demo".length - "⌂ local".length)}⌂ local`,
    `${statsLeft}${" ".repeat(width - statsLeft.length - statsRight.length)}${statsRight}`,
    "alpha z status",
    "logs ready",
  ]);

  const beforeHudChange = renderRequests;
  ansiStyling = true;
  component.invalidate();
  mode.update({ variants: { full: [{ text: "■ Reviewing", tone: "success" }] } });
  assert.equal(renderRequests, beforeHudChange + 1);
  assert.match(render.renderZone("modeRight", width), /\u001b\[32m■ Reviewing\u001b\[0m/);
  branchCallback?.();
  assert.equal(renderRequests, beforeHudChange + 2);

  handlers.get("session_shutdown")?.({}, ctx);
  assert.equal(footerCalls.at(-1), undefined);
  assert.equal(render.renderZone("modeRight", width), "■ Reviewing");
  const afterShutdown = renderRequests;
  workspace.update({ variants: variants("stale") });
  branchCallback?.();
  assert.equal(renderRequests, afterShutdown);

  mode.dispose();
  workspace.dispose();
  extension.dispose();
});

test("footer lifecycle re-registers per session and stale contexts render safely", async () => {
  const { default: hud } = await import("../index.ts");
  type Handler = (event: unknown, ctx: any) => unknown;
  const handlers = new Map<string, Handler>();
  hud({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as any);

  const registrations: unknown[] = [];
  const components: any[] = [];
  const makeCtx = (stale = false) => ({
    mode: "tui",
    ui: {
      setFooter(factory: any) {
        registrations.push(factory);
        if (factory) components.push(factory(
          { requestRender() {} },
          { fg: (_tone: string, text: string) => text },
          {
            getGitBranch: () => null,
            getAvailableProviderCount: () => 1,
            getExtensionStatuses: () => new Map(),
            onBranchChange: () => () => {},
          },
        ));
      },
      setStatus() {},
    },
    sessionManager: {
      getEntries: () => { if (stale) throw new Error("stale session"); return []; },
      getCwd: () => "/tmp",
      getSessionName: () => undefined,
    },
    getContextUsage: () => undefined,
    model: undefined,
  });

  const firstCtx = makeCtx();
  const staleCtx = makeCtx(true);
  await handlers.get("session_start")?.({}, firstCtx);
  await handlers.get("session_start")?.({}, staleCtx);
  assert.equal(registrations.filter((value) => typeof value === "function").length, 2);
  assert.ok(registrations.includes(undefined), "replacement should restore the prior default footer first");
  assert.deepEqual(components.at(-1).render(80), []);

  handlers.get("session_shutdown")?.({}, staleCtx);
  assert.equal(registrations.at(-1), undefined);
});

test("RPC and unavailable-TUI footer paths use LegacyStatusAdapter fallback", async () => {
  const [{ default: hud }, registry] = await Promise.all([import("../index.ts"), import("../registry.ts")]);
  type Handler = (event: unknown, ctx: any) => unknown;
  const handlers = new Map<string, Handler>();
  hud({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as any);

  const item = registry.registerHudItem({ owner: "fallback-test", id: "mode", zone: "modeRight", importance: "required", variants: variants("fallback") });
  const statuses: Array<{ id: string; value: string | undefined }> = [];
  const makeCtx = (mode: string) => ({
    mode,
    ui: {
      setStatus: (id: string, value?: string) => statuses.push({ id, value }),
      theme: { fg: (_tone: string, text: string) => text },
    },
  });

  await handlers.get("session_start")?.({}, makeCtx("rpc"));
  assert.deepEqual(statuses.at(-1), { id: "hud", value: "fallback" });
  handlers.get("session_shutdown")?.({}, makeCtx("rpc"));
  assert.deepEqual(statuses.at(-1), { id: "hud", value: undefined });

  await handlers.get("session_start")?.({}, makeCtx("tui"));
  assert.deepEqual(statuses.at(-1), { id: "hud", value: "fallback" });
  handlers.get("session_shutdown")?.({}, makeCtx("tui"));
  item.dispose();
});
