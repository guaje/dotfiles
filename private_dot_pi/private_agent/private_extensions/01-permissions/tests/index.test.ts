// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/index.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { setRemoteBashBackend } from "../../02-handoff/backend-registry.ts";
import { setSessionManagingStyle } from "../management-settings.ts";

const packageDir = resolve("agent/extensions/node_modules/@earendil-works/pi-coding-agent");
const tuiDir = resolve("agent/extensions/node_modules/@earendil-works/pi-tui");
mkdirSync(packageDir, { recursive: true });
mkdirSync(tuiDir, { recursive: true });
writeFileSync(resolve(packageDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", exports: "./index.js" }));
writeFileSync(resolve(packageDir, "index.js"), `
export function isToolCallEventType(name, event) { return event?.toolName === name; }
export function createBashTool(cwd, options) {
  return {
    name: "bash", label: "bash", description: "stub bash", parameters: { type: "object" }, promptGuidelines: ["original guideline"],
    async execute(_id, params) { return { content: [{ type: "text", text: params.command }], details: { cwd, remote: Boolean(options?.operations) } }; },
  };
}
`);
writeFileSync(resolve(tuiDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", type: "module", exports: "./index.js" }));
writeFileSync(resolve(tuiDir, "index.js"), `
export class Text { constructor(text) { this.text = text; } }
export class Container { constructor() { this.children = []; } addChild(value) { this.children.push(value); } }
export class Spacer { constructor(size) { this.size = size; } }
export class SelectList { constructor(options) { this.options = options; } setSelectedIndex(index) { this.selectedIndex = index; } }
export function matchesKey(data, key) { return key === "ctrl+:" ? data === "ctrl+:" : key === "shift+ctrl+:" && data === "shift+ctrl+:"; }
`);

const originalPiRoot = process.env.PI_CODING_AGENT_PACKAGE_ROOT;
const fakePiRoot = mkdtempSync(join(tmpdir(), "permissions-pi-"));
for (const path of ["dist/modes/interactive/components", "dist/modes/interactive/theme", "dist/modes/interactive"]) mkdirSync(resolve(fakePiRoot, path), { recursive: true });
writeFileSync(resolve(fakePiRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }));
writeFileSync(resolve(fakePiRoot, "dist/modes/interactive/components/settings-selector.js"), "export class SettingsSelectorComponent { getSettingsList() { return { items: [], filteredItems: [], onChange() {} }; } }\n");
writeFileSync(resolve(fakePiRoot, "dist/modes/interactive/theme/theme.js"), "export const theme = { fg: (_c, t) => t, bold: t => t }; export const getSelectListTheme = () => ({});\n");
writeFileSync(resolve(fakePiRoot, "dist/modes/interactive/interactive-mode.js"), "export class InteractiveMode { showSettingsSelector() {} setupExtensionShortcuts() {} handleHotkeysCommand() {} }\n");
process.env.PI_CODING_AGENT_PACKAGE_ROOT = fakePiRoot;

after(() => {
  setRemoteBashBackend(undefined);
  rmSync(resolve("agent/extensions/node_modules"), { recursive: true, force: true });
  rmSync(fakePiRoot, { recursive: true, force: true });
  if (originalPiRoot === undefined) delete process.env.PI_CODING_AGENT_PACKAGE_ROOT;
  else process.env.PI_CODING_AGENT_PACKAGE_ROOT = originalPiRoot;
});

function harness() {
  const handlers = new Map<string, Function>();
  const shortcuts = new Map<string, any>();
  let bashTool: any;
  return {
    pi: {
      on(name: string, handler: Function) { handlers.set(name, handler); },
      registerShortcut(name: string, spec: any) { shortcuts.set(name, spec); },
      registerTool(tool: any) { if (tool.name === "bash") bashTool = tool; },
    },
    handler(name: string) { const value = handlers.get(name); assert.ok(value, `missing ${name} handler`); return value!; },
    shortcuts,
    bashTool: () => bashTool,
  };
}

test("settings decoration exposes two modes and migrates legacy Guidance", async () => {
  const { decorateSettingsList, isShiftCtrlSemicolonFallbackInput } = await import("../settings-ui.ts");
  const saved: string[] = [];
  const list: any = { items: [{ id: "thinking" }], filteredItems: [], onChange() {} };
  const theme: any = { theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getSelectListTheme: () => ({}) };
  decorateSettingsList(list, "Empowerment", async (style) => { saved.push(style); }, theme);
  assert.equal(list.items[1].currentValue, "Empowering");
  const menu = list.items[1].submenu("Empowering", () => {});
  const select = menu.children.find((child: any) => Array.isArray(child.options));
  assert.deepEqual(select.options.map((choice: any) => choice.value), ["Micromanagement", "Empowerment"]);
  list.onChange("managing-style", "Guidance");
  await Promise.resolve();
  assert.deepEqual(saved, ["Empowerment"]);
  assert.equal(isShiftCtrlSemicolonFallbackInput("ctrl+:"), true);
});

test("entry registers one Bash owner and injects split guidance once", async () => {
  const extension = (await import("../index.ts")).default;
  const app = harness();
  extension(app.pi as any);
  const tool = app.bashTool();
  assert.ok(tool);
  assert.deepEqual(tool.promptGuidelines.slice(0, 1), ["original guideline"]);
  assert.match(tool.promptGuidelines.at(-1), /one Bash call per side-effect class/);
  const first = await app.handler("before_agent_start")({ systemPrompt: "base" });
  const second = await app.handler("before_agent_start")({ systemPrompt: first.systemPrompt });
  assert.equal(second.systemPrompt, first.systemPrompt);
});

test("Empowerment allows read-only remote Bash, splits mixed calls, and gates mutations headlessly", async () => {
  const extension = (await import("../index.ts")).default;
  const app = harness();
  extension(app.pi as any);
  await app.handler("session_start")({}, { cwd: process.cwd(), ui: {} });
  const call = app.handler("tool_call");
  assert.equal(await call({ toolName: "bash", input: { command: "ssh -o BatchMode=yes host 'git status'" } }, { cwd: process.cwd(), hasUI: false, ui: {} }), undefined);
  const mixed = await call({ toolName: "bash", input: { command: "git status && git add file" } }, { cwd: process.cwd(), hasUI: false, ui: {} });
  assert.match(mixed.reason, /Split read-only/);
  const mutation = await call({ toolName: "bash", input: { command: "rm file" } }, { cwd: process.cwd(), hasUI: false, ui: {} });
  assert.match(mutation.reason, /no UI/);
  await app.handler("session_shutdown")();
});

test("Micromanagement gates every Bash call and current-directory writes are allowed only in Empowerment", async () => {
  const extension = (await import("../index.ts")).default;
  const app = harness();
  extension(app.pi as any);
  const cwd = mkdtempSync(join(tmpdir(), "permissions-index-"));
  try {
    await app.handler("session_start")({}, { cwd, ui: {} });
    const call = app.handler("tool_call");
    setSessionManagingStyle("Micromanagement");
    const read = await call({ toolName: "bash", input: { command: "ls" } }, { cwd, hasUI: false, ui: {} });
    assert.match(read.reason, /no UI/);
    setSessionManagingStyle("Empowerment");
    assert.equal(await call({ toolName: "write", input: { path: "file.txt", content: "ok" } }, { cwd, hasUI: false, ui: {} }), undefined);
    const outside = await call({ toolName: "edit", input: { path: "../outside.txt", oldText: "a", newText: "b" } }, { cwd, hasUI: false, ui: {} });
    assert.match(outside.reason, /no UI/);
    await app.handler("session_shutdown")();
  }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("Bash execution chooses the Handoff backend at execution time", async () => {
  const extension = (await import("../index.ts")).default;
  const app = harness();
  extension(app.pi as any);
  const tool = app.bashTool();
  const local = await tool.execute("id", { command: "pwd" }, undefined, undefined, { cwd: "/local" });
  assert.equal(local.details.remote, false);
  setRemoteBashBackend(() => ({ exec: async () => ({ stdout: Buffer.from(""), stderr: Buffer.from(""), code: 0 }) } as any), () => "test-host:/repo", () => "/local");
  const remote = await tool.execute("id", { command: "pwd" }, undefined, undefined, { cwd: "/local" });
  assert.equal(remote.details.remote, true);
});
