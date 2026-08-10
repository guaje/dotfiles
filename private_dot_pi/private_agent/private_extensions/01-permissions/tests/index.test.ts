// Run with: npx -y tsx --test agent/extensions/01-permissions/tests/index.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { setRemoteBashBackend } from "../../02-handoff/backend-registry.ts";
import { setSessionManagingStyle } from "../management-settings.ts";
import { cacheHotkeys } from "../shortcuts.ts";
import { importPiModule } from "../../packages/pi-package.ts";
import { approvalFingerprint, findSessionApproval, listSessionApprovals, rememberSessionApproval, resetSessionApprovalsForTests } from "../session-command-approvals.ts";

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
writeFileSync(resolve(fakePiRoot, "dist/modes/interactive/interactive-mode.js"), "export class InteractiveMode { showSettingsSelector() {} setupExtensionShortcuts() {} handleHotkeysCommand() { return this.session.extensionRunner.getShortcuts(); } }\n");
process.env.PI_CODING_AGENT_PACKAGE_ROOT = fakePiRoot;

after(() => {
  setRemoteBashBackend(undefined);
  rmSync(packageDir, { recursive: true, force: true });
  rmSync(tuiDir, { recursive: true, force: true });
  rmSync(fakePiRoot, { recursive: true, force: true });
  if (originalPiRoot === undefined) delete process.env.PI_CODING_AGENT_PACKAGE_ROOT;
  else process.env.PI_CODING_AGENT_PACKAGE_ROOT = originalPiRoot;
});

function approvalRule(identity: ReturnType<typeof approvalFingerprint>, executable = "fixture") {
  return { ...identity, kind: "similar" as const, strength: "conservative" as const, contextLabel: "local", anchorCount: 1, slotCount: 0, slotTypes: [], label: `${executable} · conservative · no variable slots` };
}

function harness() {
  const handlers = new Map<string, Function>();
  const shortcuts = new Map<string, any>();
  const commands = new Map<string, any>();
  let bashTool: any;
  return {
    pi: {
      on(name: string, handler: Function) { handlers.set(name, handler); },
      registerShortcut(name: string, spec: any) { shortcuts.set(name, spec); },
      registerCommand(name: string, spec: any) { commands.set(name, spec); },
      registerTool(tool: any) { if (tool.name === "bash") bashTool = tool; },
    },
    handler(name: string) { const value = handlers.get(name); assert.ok(value, `missing ${name} handler`); return value!; },
    shortcuts,
    commands,
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
  assert.equal(isShiftCtrlSemicolonFallbackInput("ctrl+:"), false);
  assert.equal(isShiftCtrlSemicolonFallbackInput("shift+ctrl+:"), true);
});

test("/hotkeys combines the currently configured management-style bindings", async () => {
  const { patchBuiltInSettingsMenu } = await import("../settings-ui.ts");
  cacheHotkeys("ctrl+1", "shift+ctrl+2");
  await patchBuiltInSettingsMenu(() => "Micromanagement", async () => {});
  const { InteractiveMode } = await importPiModule("dist/modes/interactive/interactive-mode.js") as any;
  const mode = new InteractiveMode();
  mode.session = { extensionRunner: { getShortcuts: () => new Map([
    ["ctrl+1", { description: "forward" }],
    ["shift+ctrl+2", { description: "backward" }],
  ]) } };
  const shortcuts = mode.handleHotkeysCommand();
  assert.equal(shortcuts.has("ctrl+1"), false);
  assert.equal(shortcuts.has("shift+ctrl+2"), false);
  assert.equal(shortcuts.get("ctrl+1 / shift+ctrl+2").description, "Cycle management style");
});

test("entry registers one Bash owner and injects split guidance once", async () => {
  const extension = (await import("../index.ts")).default;
  const app = harness();
  await extension(app.pi as any);
  const tool = app.bashTool();
  assert.ok(tool);
  assert.ok(app.shortcuts.has("ctrl+;"));
  assert.ok(app.shortcuts.has("shift+ctrl+;"));
  assert.deepEqual(tool.promptGuidelines.slice(0, 1), ["original guideline"]);
  assert.match(tool.promptGuidelines.at(-1), /one Bash call per top-level side-effect class/);
  const first = await app.handler("before_agent_start")({ systemPrompt: "base" });
  const second = await app.handler("before_agent_start")({ systemPrompt: first.systemPrompt });
  assert.equal(second.systemPrompt, first.systemPrompt);
});

test("Empowerment allows read-only remote Bash, splits mixed calls, and gates mutations headlessly", async () => {
  const extension = (await import("../index.ts")).default;
  const app = harness();
  await extension(app.pi as any);
  await app.handler("session_start")({}, { cwd: process.cwd(), ui: {} });
  const call = app.handler("tool_call");
  assert.equal(await call({ toolName: "bash", input: { command: "ssh -o BatchMode=yes host 'git status'" } }, { cwd: process.cwd(), hasUI: false, ui: {} }), undefined);
  assert.equal(await call({ toolName: "bash", input: { command: "chezmoi status --verbose" } }, { cwd: process.cwd(), hasUI: false, ui: {} }), undefined);
  assert.equal(await call({ toolName: "bash", input: { command: "chezmoi diff -- install-pi-notification-icons.sh" } }, { cwd: process.cwd(), hasUI: false, ui: {} }), undefined);
  const mixed = await call({ toolName: "bash", input: { command: "git status && git add file" } }, { cwd: process.cwd(), hasUI: false, ui: {} });
  assert.match(mixed.reason, /Split read-only/);
  assert.equal(await call({ toolName: "bash", input: { command: "cat file | jq ." } }, { cwd: process.cwd(), hasUI: false, ui: {} }), undefined);
  for (const command of ["cat file | tee out", "glab issue create -d \"$(cat body)\""]) {
    const coupled = await call({ toolName: "bash", input: { command } }, { cwd: process.cwd(), hasUI: false, ui: {} });
    assert.match(coupled.reason, /no UI/, command);
    assert.doesNotMatch(coupled.reason, /Split read-only/, command);
  }
  const mutation = await call({ toolName: "bash", input: { command: "rm file" } }, { cwd: process.cwd(), hasUI: false, ui: {} });
  assert.match(mutation.reason, /no UI/);
  assert.equal(listSessionApprovals().length, 0);
  await app.handler("session_shutdown")();
});

test("Micromanagement gates every Bash call and current-directory writes are allowed only in Empowerment", async () => {
  const extension = (await import("../index.ts")).default;
  const app = harness();
  await extension(app.pi as any);
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

test("session-approvals command revokes safe remembered rules and lifecycle preserves only reloads", async () => {
  const extension = (await import("../index.ts")).default;
  const app = harness(); await extension(app.pi as any);
  const identity = approvalFingerprint("command-rule");
  const rule = approvalRule(identity, "command");
  rememberSessionApproval(rule, 2);
  assert.equal(listSessionApprovals().length, 1);
  const notifications: string[] = [];
  let selections = 0;
  await app.commands.get("session-approvals").handler("", { ui: {
    select: async (_title: string, items: string[]) => {
      selections++;
      if (selections === 1) { assert.match(items[0]!, /command · conservative/); return items[0]; }
      return "Revoke approval";
    },
    notify: (message: string) => { notifications.push(message); },
  } });
  assert.equal(findSessionApproval(identity), undefined);
  assert.deepEqual(notifications, ["Revoked session approval"]);

  rememberSessionApproval(rule, 2);
  await app.commands.get("session-approvals").handler("", { ui: {
    select: async (_title: string, items: string[]) => items.find((item) => item === "Clear all session approvals"),
    notify: (message: string) => { notifications.push(message); },
  } });
  assert.equal(findSessionApproval(identity), undefined);
  assert.deepEqual(notifications, ["Revoked session approval", "Cleared session approvals"]);

  const reloadIdentity = approvalFingerprint("reload-rule");
  const reloadRule = approvalRule(reloadIdentity, "command");
  rememberSessionApproval(reloadRule, 2);
  await app.handler("session_shutdown")({ reason: "reload" });
  await app.handler("session_start")({ reason: "reload" }, { cwd: process.cwd(), ui: {} });
  assert.ok(findSessionApproval(reloadIdentity));
  await app.handler("session_start")({ reason: "startup" }, { cwd: process.cwd(), ui: {} });
  assert.equal(findSessionApproval(reloadIdentity), undefined);

  for (const reason of ["new", "resume", "fork"]) {
    const seeded = approvalFingerprint(`start-${reason}`);
    rememberSessionApproval(approvalRule(seeded), 2);
    await app.handler("session_start")({ reason }, { cwd: process.cwd(), ui: {} });
    assert.equal(findSessionApproval(seeded), undefined, reason);
  }
  for (const reason of ["quit", "new", "resume", "fork"]) {
    const seeded = approvalFingerprint(`shutdown-${reason}`);
    rememberSessionApproval(approvalRule(seeded), 2);
    await app.handler("session_shutdown")({ reason });
    assert.equal(findSessionApproval(seeded), undefined, reason);
  }
  resetSessionApprovalsForTests();
});

test("Empowerment remembers a semantic git-add rule while Micromanagement still prompts", async () => {
  resetSessionApprovalsForTests();
  const extension = (await import("../index.ts")).default;
  const app = harness(); await extension(app.pi as any);
  const cwd = mkdtempSync(join(tmpdir(), "permissions-remember-"));
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q", cwd]);
    await app.handler("session_start")({ reason: "startup" }, { cwd, ui: {} });
    const call = app.handler("tool_call");
    let prompts = 0;
    const ctx = { cwd, hasUI: true, ui: {
      confirm: async () => true,
      select: async () => { prompts++; return "Allow similar commands for this session"; },
      notify() {},
    } };
    assert.equal(await call({ toolName: "bash", input: { command: "git add file1.txt" } }, ctx), undefined);
    assert.equal(await call({ toolName: "bash", input: { command: "git add file2.md" } }, ctx), undefined);
    assert.equal(prompts, 1);

    setSessionManagingStyle("Micromanagement");
    ctx.ui.select = async () => { prompts++; return "Allow once"; };
    assert.equal(await call({ toolName: "bash", input: { command: "git add file2.md" } }, ctx), undefined);
    assert.equal(prompts, 2);
    await app.shortcuts.get("ctrl+;").handler({ ui: { notify() {} } });
    assert.equal(await call({ toolName: "bash", input: { command: "git add file2.md" } }, ctx), undefined);
    assert.equal(prompts, 3);
    await app.handler("session_shutdown")({ reason: "quit" });
  }
  finally {
    rmSync(cwd, { recursive: true, force: true });
    resetSessionApprovalsForTests();
  }
});

test("Empowerment remembers similar npx tsx workspace test commands", async () => {
  resetSessionApprovalsForTests();
  const extension = (await import("../index.ts")).default;
  const app = harness(); await extension(app.pi as any);
  const cwd = mkdtempSync(join(tmpdir(), "permissions-npx-template-"));
  try {
    mkdirSync(join(cwd, "tests"));
    writeFileSync(join(cwd, "tests", "one.test.ts"), "export {};\n");
    writeFileSync(join(cwd, "tests", "two.test.ts"), "export {};\n");
    await app.handler("session_start")({ reason: "startup" }, { cwd, ui: {} });
    const call = app.handler("tool_call");
    let prompts = 0;
    const ctx = { cwd, hasUI: true, ui: {
      confirm: async () => true,
      select: async () => { prompts++; return "Allow similar commands for this session"; },
      notify() {},
    } };
    assert.equal(await call({ toolName: "bash", input: { command: "npx -y tsx --test --test-concurrency=1 tests/one.test.ts tests/two.test.ts" } }, ctx), undefined);
    assert.equal(await call({ toolName: "bash", input: { command: "npx -y tsx --test --test-concurrency=1 tests/*.test.ts" } }, ctx), undefined);
    assert.equal(prompts, 1);
    await app.handler("session_shutdown")({ reason: "quit" });
  }
  finally {
    rmSync(cwd, { recursive: true, force: true });
    resetSessionApprovalsForTests();
  }
});

test("Empowerment remembers conservative unknown and context-isolated remote commands", async () => {
  resetSessionApprovalsForTests();
  const extension = (await import("../index.ts")).default;
  const app = harness(); await extension(app.pi as any);
  const cwd = mkdtempSync(join(tmpdir(), "permissions-conservative-"));
  try {
    await app.handler("session_start")({ reason: "startup" }, { cwd, ui: {} });
    const call = app.handler("tool_call");
    let prompts = 0;
    const ctx = { cwd, hasUI: true, ui: {
      confirm: async () => true,
      select: async () => { prompts++; return "Allow similar commands for this session"; },
      notify() {},
    } };
    assert.equal(await call({ toolName: "bash", input: { command: "git frobnicate task.js" } }, ctx), undefined);
    assert.equal(await call({ toolName: "bash", input: { command: "git frobnicate other.js" } }, ctx), undefined);
    assert.equal(prompts, 1);

    assert.equal(await call({ toolName: "bash", input: { command: "ssh -p 22 host 'rm file'" } }, ctx), undefined);
    assert.equal(await call({ toolName: "bash", input: { command: "ssh -p 22 host 'rm file'" } }, ctx), undefined);
    assert.equal(prompts, 2);

    setRemoteBashBackend(
      () => ({ exec: async () => ({ stdout: Buffer.from(""), stderr: Buffer.from(""), code: 0 }) } as any),
      () => "host:/repo",
      () => cwd,
      () => ["host", "user", "22", "/repo"].join("\0"),
    );
    assert.equal(await call({ toolName: "bash", input: { command: "rm file" } }, ctx), undefined);
    assert.equal(await call({ toolName: "bash", input: { command: "rm file" } }, ctx), undefined);
    assert.equal(prompts, 3);
    setRemoteBashBackend(
      () => ({ exec: async () => ({ stdout: Buffer.from(""), stderr: Buffer.from(""), code: 0 }) } as any),
      () => "host:/other",
      () => cwd,
      () => ["host", "user", "22", "/other"].join("\0"),
    );
    ctx.ui.select = async () => { prompts++; return "Allow once"; };
    assert.equal(await call({ toolName: "bash", input: { command: "rm file" } }, ctx), undefined);
    assert.equal(prompts, 4);
    await app.handler("session_shutdown")({ reason: "quit" });
  }
  finally {
    setRemoteBashBackend(undefined);
    rmSync(cwd, { recursive: true, force: true });
    resetSessionApprovalsForTests();
  }
});

test("a full configured store keeps existing rules and degrades a new remember choice to allow once", async () => {
  resetSessionApprovalsForTests();
  const extension = (await import("../index.ts")).default;
  const app = harness(); await extension(app.pi as any);
  const cwd = mkdtempSync(join(tmpdir(), "permissions-cap-"));
  try {
    await app.handler("session_start")({ reason: "startup" }, { cwd, ui: {} });
    let firstIdentity: ReturnType<typeof approvalFingerprint> | undefined;
    for (let index = 0; index < 100; index++) {
      const identity = approvalFingerprint("fixture", String(index));
      firstIdentity ??= identity;
      assert.equal(rememberSessionApproval(approvalRule(identity, `fixture-${index}`), 100), true);
    }
    const notifications: string[] = [];
    const result = await app.handler("tool_call")(
      { toolName: "bash", input: { command: "git frobnicate new-task.js" } },
      { cwd, hasUI: true, ui: {
        confirm: async () => true,
        select: async () => "Allow similar commands for this session",
        notify: (message: string) => { notifications.push(message); },
      } },
    );
    assert.equal(result, undefined);
    assert.equal(listSessionApprovals().length, 100);
    assert.ok(findSessionApproval(firstIdentity!));
    assert.deepEqual(notifications, ["Session approval limit reached; allowed once without remembering"]);
    await app.handler("session_shutdown")({ reason: "quit" });
  }
  finally {
    rmSync(cwd, { recursive: true, force: true });
    resetSessionApprovalsForTests();
  }
});

test("Bash execution chooses the Handoff backend at execution time", async () => {
  const extension = (await import("../index.ts")).default;
  const app = harness();
  await extension(app.pi as any);
  const tool = app.bashTool();
  const local = await tool.execute("id", { command: "pwd" }, undefined, undefined, { cwd: "/local" });
  assert.equal(local.details.remote, false);
  setRemoteBashBackend(() => ({ exec: async () => ({ stdout: Buffer.from(""), stderr: Buffer.from(""), code: 0 }) } as any), () => "test-host:/repo", () => "/local");
  const remote = await tool.execute("id", { command: "pwd" }, undefined, undefined, { cwd: "/local" });
  assert.equal(remote.details.remote, true);
});
