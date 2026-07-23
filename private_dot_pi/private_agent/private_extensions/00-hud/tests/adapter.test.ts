// Run with: npx -y tsx --test agent/extensions/00-hud/tests/adapter.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

const originalPiPackageRoot = process.env.PI_CODING_AGENT_PACKAGE_ROOT;
const fakePiPackageRoot = mkdtempSync(join(tmpdir(), "hud-pi-package-"));
const fakeThemeDir = resolve(fakePiPackageRoot, "dist/modes/interactive/theme");
const fakeComponentDir = resolve(fakePiPackageRoot, "dist/modes/interactive/components");
mkdirSync(fakeThemeDir, { recursive: true });
mkdirSync(fakeComponentDir, { recursive: true });
writeFileSync(resolve(fakePiPackageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }));
writeFileSync(resolve(fakeThemeDir, "theme.js"), `
export const theme = {
  fg(tone, text) {
    const code = tone === "success" ? 32 : tone === "warning" ? 33 : tone === "error" ? 31 : tone === "dim" ? 2 : 36;
    return "\\x1b[" + code + "m" + text + "\\x1b[0m";
  },
};
export function initTheme() {}
`);
writeFileSync(resolve(fakeComponentDir, "footer.js"), `
export class FooterComponent {
  constructor(session, footerData) { this.session = session; this.footerData = footerData; }
  render(_width) {
    const lines = [this.session.sessionManager.getCwd(), "10.0%/1.0k test-model • high"];
    const statuses = [...this.footerData.getExtensionStatuses().entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value);
    if (statuses.length) lines.push(statuses.join(" "));
    return lines;
  }
}
`);
process.env.PI_CODING_AGENT_PACKAGE_ROOT = fakePiPackageRoot;

const stubDir = resolve("agent/extensions/node_modules/@earendil-works/pi-tui");
mkdirSync(stubDir, { recursive: true });
writeFileSync(resolve(stubDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", type: "module", exports: "./index.js" }));
writeFileSync(resolve(stubDir, "index.js"), `
const strip = (value) => String(value).replace(/\\x1b\\[[0-?]*[ -\\/]*[@-~]/g, "");
export function visibleWidth(value) { return [...strip(value)].length; }
export function truncateToWidth(value, width, marker = "") {
  if (visibleWidth(value) <= width) return String(value);
  return [...strip(value)].slice(0, Math.max(0, width - visibleWidth(marker))).join("") + marker;
}
`);

after(() => {
  rmSync(resolve("agent/extensions/node_modules"), { recursive: true, force: true });
  rmSync(fakePiPackageRoot, { recursive: true, force: true });
  if (originalPiPackageRoot === undefined) delete process.env.PI_CODING_AGENT_PACKAGE_ROOT;
  else process.env.PI_CODING_AGENT_PACKAGE_ROOT = originalPiPackageRoot;
});

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("Pi adapter patches once, composes semantic rows, and preserves metrics bytes without a gutter", async () => {
  const [{ importPiModule }, { PiFooterAdapter }, registry] = await Promise.all([
    import("../../packages/pi-package.ts"),
    import("../adapters/pi-footer.ts"),
    import("../registry.ts"),
  ]);
  const themeModule = await importPiModule("dist/modes/interactive/theme/theme.js");
  themeModule.initTheme("dark");
  const footerModule = await importPiModule("dist/modes/interactive/components/footer.js");
  const FooterComponent = footerModule.FooterComponent as new (session: any, footerData: any) => { render(width: number): string[] };
  const session = {
    state: {
      model: { id: "test-model", provider: "test-provider", contextWindow: 1000, reasoning: true },
      thinkingLevel: "high",
    },
    sessionManager: {
      getEntries: () => [],
      getCwd: () => "/tmp/project",
      getSessionName: () => undefined,
    },
    modelRegistry: { isUsingOAuth: () => false },
    getContextUsage: () => ({ contextWindow: 1000, percent: 10 }),
  };
  const footerData = {
    getGitBranch: () => undefined,
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => new Map([["legacy", "legacy ready"]]),
  };
  const footer = new FooterComponent(session, footerData);
  const originalInner = footer.render(80);

  const mode = registry.registerHudItem({ owner: "adapter-test", id: "mode", zone: "modeRight", importance: "required", variants: { full: [{ text: "▲", tone: "success" }, { text: " Empowering", tone: "muted" }] } });
  const route = registry.registerHudItem({ owner: "adapter-test", id: "route", zone: "workspaceRight", importance: "normal", variants: { full: [{ text: "⌂", tone: "accent" }, { text: " tools→local • history local", tone: "muted" }] } });
  const extension = registry.registerHudItem({ owner: "adapter-test", id: "extension", zone: "extensionLine", importance: "optional", variants: { full: [{ text: "background ready", tone: "muted" }] } });

  const adapter = new PiFooterAdapter();
  assert.equal(await adapter.activate(), true);
  const patchedRender = (FooterComponent as any).prototype.render;
  assert.equal(await adapter.activate(), true);
  assert.equal((FooterComponent as any).prototype.render, patchedRender);

  const lines = footer.render(80);
  assert.equal(stripAnsi(lines[0] ?? "").endsWith("▲ Empowering"), true);
  assert.equal(stripAnsi(lines[1] ?? "").startsWith("/tmp/project"), true);
  assert.equal(stripAnsi(lines[1] ?? "").endsWith("⌂ tools→local • history local"), true);
  assert.equal(lines[2], originalInner[1]);
  assert.equal(stripAnsi(lines[3] ?? ""), "legacy ready");
  assert.equal(stripAnsi(lines[4] ?? ""), "background ready");

  mode.dispose();
  route.dispose();
  extension.dispose();
});

test("legacy adapter captures UI, refreshes one status, warns once, and clears on dispose", async () => {
  const [{ LegacyStatusAdapter }, registry] = await Promise.all([
    import("../adapters/legacy-status.ts"),
    import("../registry.ts"),
  ]);
  const statuses: Array<string | undefined> = [];
  const warnings: string[] = [];
  const adapter = new LegacyStatusAdapter();
  adapter.capture({
    setStatus: (_id, value) => statuses.push(value),
    notify: (message) => warnings.push(message),
  });
  await adapter.activate();
  const handle = registry.registerHudItem({ owner: "legacy-test", id: "item", zone: "modeRight", importance: "required", variants: { full: [{ text: "▲ Empowering", tone: "success" }] } });
  assert.equal(stripAnsi(statuses.at(-1) ?? ""), "▲ Empowering");
  assert.equal(warnings.length <= 1, true);
  adapter.dispose();
  assert.equal(statuses.at(-1), undefined);
  handle.dispose();
});
