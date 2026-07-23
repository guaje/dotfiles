// Run with: npx -y tsx --test agent/extensions/00-hud/tests/hud.test.ts
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { after } from "node:test";

const stubDir = resolve("agent/extensions/node_modules/@earendil-works/pi-tui");
mkdirSync(stubDir, { recursive: true });
writeFileSync(resolve(stubDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", type: "module", exports: "./index.js" }));
writeFileSync(resolve(stubDir, "index.js"), `
export function visibleWidth(value) { return [...String(value).replace(/\\x1b\\[[0-?]*[ -\\/]*[@-~]/g, "")].length; }
export function truncateToWidth(value, width) { return [...String(value)].slice(0, Math.max(0, width)).join(""); }
`);

let modules: Promise<{
  registry: typeof import("../registry.ts");
  layoutFooter: typeof import("../layout.ts")["layoutFooter"];
  sanitizeHudText: typeof import("../sanitize.ts")["sanitizeHudText"];
  render: typeof import("../render.ts");
}> | undefined;
function load() {
  return modules ??= Promise.all([import("../registry.ts"), import("../layout.ts"), import("../sanitize.ts"), import("../render.ts")])
    .then(([registry, layout, sanitize, render]) => ({ registry, layoutFooter: layout.layoutFooter, sanitizeHudText: sanitize.sanitizeHudText, render }));
}

after(() => rmSync(resolve("agent/extensions/node_modules"), { recursive: true, force: true }));

const variants = (text: string) => ({ full: [{ text }], compact: [{ text: text.slice(0, 4) }], icon: [{ text: text.slice(0, 1) }] });

test("owner:id registration is idempotent and lifecycle leaves no ghosts", async () => {
  const { registry } = await load();
  const first = registry.registerHudItem({ owner: "test", id: "item", zone: "modeRight", importance: "required", variants: variants("first") });
  const replacement = registry.registerHudItem({ owner: "test", id: "item", zone: "modeRight", importance: "required", variants: variants("second") });
  assert.equal(registry.hudItems().filter((item: any) => item.owner === "test").length, 1);
  first.update({ variants: variants("stale") });
  assert.equal(registry.hudItems().find((item: any) => item.owner === "test")?.variants.full[0].text, "second");
  replacement.dispose();
  assert.equal(registry.hudItems().some((item: any) => item.owner === "test"), false);
});

test("layout emits required three and two row forms without a gutter and stays bounded", async () => {
  const { registry, layoutFooter } = await load();
  const mode = registry.registerHudItem({ owner: "test", id: "mode", zone: "modeRight", order: 100, importance: "required", variants: variants("▲ Empowering") });
  const route = registry.registerHudItem({ owner: "test", id: "route", zone: "workspaceRight", order: 100, importance: "normal", variants: variants("⌂ tools→local • history local") });
  const metrics = "↑…                                          (provider) model • thinking";
  const wide = layoutFooter(["~/.pi", metrics], 80);
  assert.equal(wide.length, 3);
  assert.equal(wide[1].startsWith("~/.pi"), true);
  assert.equal(wide[2], metrics);
  assert.equal(wide[0], `${" ".repeat(80 - "▲ Empowering".length)}▲ Empowering`);
  assert.equal(wide[1], `~/.pi${" ".repeat(80 - "~/.pi".length - "⌂ tools→local • history local".length)}⌂ tools→local • history local`);
  mode.hide();
  const two = layoutFooter(["~/.pi", metrics], 80);
  assert.equal(two.length, 2);
  for (const width of [1, 2, 20, 40, 80, 188, 234]) for (const line of layoutFooter(["CJK 世界 e\u0301 👩‍💻", metrics], width)) assert.ok([...line].length <= width);
  mode.dispose(); route.dispose();
});

test("sanitization removes terminal controls while preserving Unicode joiners", async () => {
  const { sanitizeHudText } = await load();
  assert.equal(sanitizeHudText("\u001b[31mA\u001b[0m\n世\u200d界\u0000"), "A 世‍界");
});

test("semantic tones are applied centrally after publisher ANSI is removed", async () => {
  const { registry, render } = await load();
  render.setHudStyler((tone, text) => `\u001b[${tone === "success" ? "32" : "2"}m${text}\u001b[0m`);
  const handle = registry.registerHudItem({
    owner: "theme-test",
    id: "mode",
    zone: "modeRight",
    importance: "required",
    variants: { full: [{ text: "\u001b[31m▲\u001b[0m", tone: "success" }, { text: " Empowering", tone: "muted" }] },
  });
  const rendered = render.renderZone("modeRight", 80);
  assert.equal(rendered.includes("\u001b[31m"), false);
  assert.equal(rendered.includes("\u001b[32m▲\u001b[0m"), true);
  assert.equal(render.segmentsText([{ text: "👩‍💻", tone: "accent" }]), "👩‍💻");
  handle.dispose();
  render.setHudStyler(undefined);
});
