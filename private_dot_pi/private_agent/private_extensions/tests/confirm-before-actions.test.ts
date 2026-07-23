// Run with: npx -y tsx --test agent/extensions/tests/confirm-before-actions.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

class StubText {
  constructor(public text: string) {}
  setText(text: string) {
    this.text = text;
  }
}
import { pathToFileURL } from "node:url";

const EXTENSION_PATH = resolve("agent/extensions/01-confirm-before-actions.ts");
const SETTINGS_CONFIG_PATH = resolve("agent/settings.config.json");
const STUB_PACKAGE_DIR = resolve("agent/extensions/node_modules/@earendil-works/pi-coding-agent");
const STUB_TUI_PACKAGE_DIR = resolve("agent/extensions/node_modules/@earendil-works/pi-tui");
const STUB_HANDOFF_PACKAGE_DIR = resolve("agent/extensions/node_modules/@local/handoff-stub");

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

let extensionImportCounter = 0;
const nativeNotifyCalls: string[] = [];
(globalThis as any).__nativeNotifyMock = (body: string) => {
  nativeNotifyCalls.push(body);
};

async function loadExtensionModule() {
  mkdirSync(STUB_PACKAGE_DIR, { recursive: true });
  mkdirSync(STUB_TUI_PACKAGE_DIR, { recursive: true });
  mkdirSync(STUB_HANDOFF_PACKAGE_DIR, { recursive: true });
  writeFileSync(resolve(STUB_HANDOFF_PACKAGE_DIR, "package.json"), JSON.stringify({
    name: "@local/handoff-stub",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(STUB_HANDOFF_PACKAGE_DIR, "index.js"), [
    "export function setRemoteBashBackend() {}",
    "export function getBashBackend() { return undefined; }",
    "export function getBashTargetLabel() { return undefined; }",
  ].join("\n"));
  writeFileSync(resolve(STUB_PACKAGE_DIR, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(STUB_PACKAGE_DIR, "index.js"), [
    "export class CustomEditor {}",
    "export function highlightCode(code, _lang, _theme) {",
    "  return `<<${code}>>`;",
    "}",
    "export function createBashTool(_cwd) {",
    "  return {",
    "    name: 'bash',",
    "    label: 'bash',",
    "    description: 'stub bash tool',",
    "    parameters: { type: 'object' },",
    "    async execute(_toolCallId, params) {",
    "      return { content: [{ type: 'text', text: params.command }], details: { stub: true } };",
    "    },",
    "  };",
    "}",
    "export function isToolCallEventType(name, event) {",
    "  return event?.toolName === name;",
    "}",
  ].join("\n"));
  writeFileSync(resolve(STUB_TUI_PACKAGE_DIR, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-tui",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(STUB_TUI_PACKAGE_DIR, "index.js"), [
    "export class Container {",
    "  constructor() { this.children = []; }",
    "  addChild(child) { this.children.push(child); return child; }",
    "}",
    "export class SelectList {",
    "  constructor(options) { this.options = options; this.selectedIndex = 0; }",
    "  setSelectedIndex(index) { this.selectedIndex = index; }",
    "  handleInput() {}",
    "}",
    "export class Spacer {",
    "  constructor(size) { this.size = size; }",
    "}",
    "export function matchesKey(data, keyId) {",
    "  if (keyId === 'ctrl+:') return data === '\\x1b[58;5u';",
    "  if (keyId === 'shift+ctrl+:') return data === '\\x1b[58;6u';",
    "  return false;",
    "}",
    "export class Text {",
    "  constructor(text) { this.text = text; }",
    "  setText(text) { this.text = text; }",
    "}",
    "export function visibleWidth(text) { return String(text).replace(/\\x1b\\[[0-9;]*m/g, '').length; }",
    "export function truncateToWidth(text, width, ellipsis = '') {",
    "  const cleanLength = visibleWidth(text);",
    "  if (cleanLength <= width) return text;",
    "  return String(text).replace(/\\x1b\\[[0-9;]*m/g, '').slice(0, Math.max(0, width - visibleWidth(ellipsis))) + ellipsis;",
    "}",
  ].join("\n"));

  const patchedExtensionPath = resolve("agent/extensions/.confirm-before-actions.testable.ts");
  const source = readFileSync(EXTENSION_PATH, "utf8")
    .replace('import { notifyPiWaitingForUser } from "./07-native-notify.ts";', 'const notifyPiWaitingForUser = (globalThis as any).__nativeNotifyMock;')
    .replaceAll(
      "import.meta.dirname",
      JSON.stringify(dirname(EXTENSION_PATH)),
    );
  writeFileSync(patchedExtensionPath, source);

  const moduleUrl = `${pathToFileURL(patchedExtensionPath).href}?t=${Date.now()}-${extensionImportCounter++}`;
  return import(moduleUrl);
}

async function loadExtension() {
  const mod = await loadExtensionModule();
  return mod.default as (pi: { on: (event: string, handler: Function) => void }) => void;
}

function createPiHarness() {
  const handlers = new Map<string, Function>();
  const tools: Array<Record<string, unknown>> = [];
  const shortcuts = new Map<string, any>();
  return {
    shortcuts,
    pi: {
      on(event: string, handler: Function) {
        handlers.set(event, handler);
      },
      registerTool(tool: Record<string, unknown>) {
        tools.push(tool);
      },
      registerShortcut(shortcut: string, spec: any) {
        shortcuts.set(shortcut, spec);
      },
    },
    getHandler(event: string) {
      const handler = handlers.get(event);
      assert.ok(handler, `Expected handler for ${event}`);
      return handler as (event: any, ctx: any) => Promise<any>;
    },
    getTool(name: string) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `Expected tool ${name}`);
      return tool;
    },
  };
}

function createUiHarness(confirmResult = true) {
  let editorText = "original editor text";
  const confirmCalls: Array<{ title: string; body: string }> = [];
  const setEditorTextCalls: string[] = [];
  const setWidgetCalls: Array<{ id: string; lines: string[] | undefined }> = [];
  const setStatusCalls: Array<{ id: string; status: string | undefined }> = [];

  return {
    ui: {
      async confirm(title: string, body: string, _opts?: { signal?: AbortSignal }) {
        confirmCalls.push({ title, body });
        return confirmResult;
      },
      getEditorText() {
        return editorText;
      },
      setEditorText(text: string) {
        editorText = text;
        setEditorTextCalls.push(text);
      },
      setWidget(id: string, lines: string[] | undefined) {
        setWidgetCalls.push({ id, lines });
      },
      setStatus(id: string, status: string | undefined) {
        setStatusCalls.push({ id, status });
      },
    },
    get editorText() {
      return editorText;
    },
    confirmCalls,
    setEditorTextCalls,
    setWidgetCalls,
    setStatusCalls,
  };
}

test("write confirmation loads the full file preview into the editor and restores previous editor text", async () => {
  nativeNotifyCalls.length = 0;
  const extension = await loadExtension();
  const { pi, getHandler } = createPiHarness();
  extension(pi as any);
  const handler = getHandler("tool_call");

  const uiHarness = createUiHarness(true);
  const ctx = { hasUI: true, ui: uiHarness.ui };
  const event = {
    toolName: "write",
    input: {
      path: "notes.txt",
      content: "first line\nsecond line\nthird line",
    },
  };

  const result = await handler(event, ctx);

  assert.equal(result, undefined);
  assert.deepEqual(uiHarness.setWidgetCalls, []);
  assert.equal(
    uiHarness.setEditorTextCalls[0],
    [
      "1 │ first line",
      "2 │ second line",
      "3 │ third line",
    ].join("\n"),
  );
  assert.equal(uiHarness.editorText, "original editor text");
  assert.equal(uiHarness.setEditorTextCalls.at(-1), "original editor text");
  assert.equal(uiHarness.confirmCalls.length, 1);
  assert.deepEqual(nativeNotifyCalls, ["Approval needed: Allow file write"]);
  assert.match(stripAnsi(uiHarness.confirmCalls[0]!.title), /Allow file write\?/);
  assert.match(stripAnsi(uiHarness.confirmCalls[0]!.body), /Path:/);
  assert.match(stripAnsi(uiHarness.confirmCalls[0]!.body), /notes\.txt/);
  assert.match(stripAnsi(uiHarness.confirmCalls[0]!.body), /New content: 3 lines, 33 chars/);
});

test("edit confirmation loads full diff with numbered lines into the editor and restores previous editor text", async () => {
  const extension = await loadExtension();
  const { pi, getHandler } = createPiHarness();
  extension(pi as any);
  const handler = getHandler("tool_call");

  const uiHarness = createUiHarness(true);
  const ctx = { hasUI: true, ui: uiHarness.ui };
  const event = {
    toolName: "edit",
    input: {
      path: "notes.txt",
      edits: [
        {
          oldText: "alpha\nbeta",
          newText: "ALPHA\nBETA",
        },
        {
          oldText: "",
          newText: "gamma",
        },
      ],
    },
  };

  const result = await handler(event, ctx);

  assert.equal(result, undefined);
  assert.equal(
    uiHarness.setEditorTextCalls[0],
    [
      "@@ edit 1 @@",
      "- 1 │ alpha",
      "- 2 │ beta",
      "+ 1 │ ALPHA",
      "+ 2 │ BETA",
      "",
      "@@ edit 2 @@",
      "- 1 │ <empty>",
      "+ 1 │ gamma",
    ].join("\n"),
  );
  assert.equal(uiHarness.editorText, "original editor text");
  assert.equal(uiHarness.setEditorTextCalls.at(-1), "original editor text");
  assert.deepEqual(uiHarness.setWidgetCalls, []);

  assert.equal(uiHarness.confirmCalls.length, 1);
  assert.match(stripAnsi(uiHarness.confirmCalls[0]!.title), /Allow file edit\?/);
  assert.match(stripAnsi(uiHarness.confirmCalls[0]!.body), /Changes: 2 replacements/);
});

test("rejected write confirmation blocks the tool and still restores previous editor text", async () => {
  const extension = await loadExtension();
  const { pi, getHandler } = createPiHarness();
  extension(pi as any);
  const handler = getHandler("tool_call");

  const uiHarness = createUiHarness(false);
  const result = await handler(
    {
      toolName: "write",
      input: { path: "notes.txt", content: "hello" },
    },
    {
      hasUI: true,
      ui: uiHarness.ui,
    },
  );

  assert.deepEqual(result, {
    block: true,
    reason: "File write blocked by user",
  });
  assert.equal(uiHarness.setEditorTextCalls[0], "1 │ hello");
  assert.equal(uiHarness.setEditorTextCalls.at(-1), "original editor text");
  assert.equal(uiHarness.editorText, "original editor text");
});

test("rejected edit confirmation blocks the tool and restores previous editor text", async () => {
  const extension = await loadExtension();
  const { pi, getHandler } = createPiHarness();
  extension(pi as any);
  const handler = getHandler("tool_call");

  const uiHarness = createUiHarness(false);
  const result = await handler(
    {
      toolName: "edit",
      input: {
        path: "notes.txt",
        edits: [{ oldText: "before", newText: "after" }],
      },
    },
    {
      hasUI: true,
      ui: uiHarness.ui,
    },
  );

  assert.deepEqual(result, {
    block: true,
    reason: "File edit blocked by user",
  });
  assert.deepEqual(uiHarness.setWidgetCalls, []);
  assert.equal(uiHarness.setEditorTextCalls.at(-1), "original editor text");
});

test("bash confirmation leaves the editor unchanged and includes command summary", async () => {
  nativeNotifyCalls.length = 0;
  const extension = await loadExtension();
  const { pi, getHandler, getTool } = createPiHarness();
  extension(pi as any);
  const handler = getHandler("tool_call");

  const uiHarness = createUiHarness(true);
  const result = await handler(
    {
      toolName: "bash",
      input: {
        command: "sudo rm -rf tmp && echo done",
      },
    },
    {
      hasUI: true,
      ui: uiHarness.ui,
    },
  );

  assert.equal(result, undefined);
  assert.equal(uiHarness.confirmCalls.length, 1);
  assert.deepEqual(nativeNotifyCalls, ["Approval needed: bash command"]);
  assert.deepEqual(uiHarness.setEditorTextCalls, []);
  assert.equal(uiHarness.editorText, "original editor text");
  assert.deepEqual(uiHarness.setWidgetCalls, []);

  const bashTool = getTool("bash") as { renderCall: (args: { command: string }, theme: { fg: (color: string, text: string) => string; bold: (text: string) => string; }, context: unknown) => StubText };
  const renderCall = bashTool.renderCall(
    { command: "FOO=bar echo \"$FOO\" && python3 script.py" },
    {
      fg: (color, text) => `<${color}>${text}</${color}>`,
      bold: (text) => `<b>${text}</b>`,
    },
    {},
  );
  assert.equal(
    renderCall.text,
    [
      "<muted>1</muted> <dim>│</dim> <mdLink>FOO</mdLink><accent>=</accent><text>bar</text> <warning><b>echo</b></warning> <syntaxString>\"$FOO\"</syntaxString> <accent>&&</accent> <warning><b>python3</b></warning> <text>script.py</text>",
    ].join("\n"),
  );

  const pythonRenderCall = bashTool.renderCall(
    { command: "python3 - <<'PY'\nfrom pathlib import Path\nprint(123)\nPY" },
    {
      fg: (color, text) => `<${color}>${text}</${color}>`,
      bold: (text) => `<b>${text}</b>`,
    },
    {},
  );
  assert.equal(
    pythonRenderCall.text,
    [
      "<muted>1</muted> <dim>│</dim> <warning><b>python3</b></warning> <text>-</text> <accent><<</accent><syntaxString>'PY'</syntaxString>",
      "<muted>2</muted> <dim>│</dim> <thinkingHigh>from</thinkingHigh> <mdCode>pathlib</mdCode> <thinkingHigh>import</thinkingHigh> <mdCode>Path</mdCode>",
      "<muted>3</muted> <dim>│</dim> <mdLink>print</mdLink><toolTitle>(</toolTitle><syntaxNumber>123</syntaxNumber><toolTitle>)</toolTitle>",
      "<muted>4</muted> <dim>│</dim> <bashMode>PY</bashMode>",
    ].join("\n"),
  );

  const title = stripAnsi(uiHarness.confirmCalls[0]!.title);
  const body = stripAnsi(uiHarness.confirmCalls[0]!.body);
  assert.match(title, /Allow bash command\?/);
  assert.doesNotMatch(body, /Command:/);
  assert.doesNotMatch(body, /sudo rm -rf tmp && echo done/);
  assert.match(body, /Programs to run:/);
  assert.match(body, /1\) rm, 2\) echo/);
  assert.match(body, /Warning: sudo runs with elevated privileges/);
  assert.match(body, /Warning: rm -rf can recursively and forcibly delete files/);
});

test("bash confirmation shows remote target label when backend is remote", async () => {
  const extension = await loadExtension();
  const { pi, getHandler } = createPiHarness();
  extension(pi as any);
  const handler = getHandler("tool_call");

  const uiHarness = createUiHarness(true);
  const backendMod = await import("../02-handoff/backend-registry.ts");
  backendMod.setRemoteBashBackend(() => ({ exec: async () => ({ exitCode: 0 }) } as any), () => "work:/repo");
  try {
    const result = await handler(
      { toolName: "bash", input: { command: "sudo echo hello" } },
      { hasUI: true, ui: uiHarness.ui },
    );
    assert.equal(result, undefined);
    assert.equal(uiHarness.confirmCalls.length, 1);
    const body = stripAnsi(uiHarness.confirmCalls[0]!.body);
    assert.match(body, /Remote target:/);
    assert.match(body, /work:\/repo/);
  } finally {
    backendMod.setRemoteBashBackend(undefined);
  }
});

test("bash programs list excludes heredoc script fragments", async () => {
  const originalSettings = readFileSync(SETTINGS_CONFIG_PATH, "utf8");
  try {
    const settings = JSON.parse(originalSettings);
    settings.managingStyle = "Micromanagement";
    writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify(settings, null, 2)}\n`);

    const mod = await loadExtensionModule();
    await mod.refreshManagingStyleCache();
    const extension = mod.default as (pi: { on: (event: string, handler: Function) => void }) => void;
    const { pi, getHandler } = createPiHarness();
    extension(pi as any);
    const handler = getHandler("tool_call");

    const uiHarness = createUiHarness(true);
    const result = await handler(
    {
      toolName: "bash",
      input: {
        command: "printf 'prepare\\n' >/dev/null && python3 - <<'PY'\nfrom pathlib import Path\nprint('hello')\nPY\nprintf 'cleanup\\n' >/dev/null",
      },
    },
    {
      hasUI: true,
      ui: uiHarness.ui,
    },
  );

    assert.equal(result, undefined);
    const body = stripAnsi(uiHarness.confirmCalls[0]!.body);
    assert.match(body, /Programs to run:/);
    assert.match(body, /1\) printf, 2\) python3, 3\) printf/);
    assert.doesNotMatch(body, /pathlib/);
    assert.doesNotMatch(body, /print\('/);
  }
  finally {
    writeFileSync(SETTINGS_CONFIG_PATH, originalSettings);
  }
});

test("bash programs list includes commands after quoted command substitution", async () => {
  const extension = await loadExtension();
  const { pi, getHandler } = createPiHarness();
  extension(pi as any);
  const handler = getHandler("tool_call");

  const uiHarness = createUiHarness(true);
  const result = await handler(
    {
      toolName: "bash",
      input: {
        command: "cd \"$(chezmoi source-path)\" && git status --short && git add private_dot_pi/private_agent/scripts/executable_list-provider-models.sh private_dot_pi/private_agent/scripts/tests/executable_list-provider-models.test.sh && git status --short && git commit -m \"List provider service models\"",
      },
    },
    {
      hasUI: true,
      ui: uiHarness.ui,
    },
  );

  assert.equal(result, undefined);
  const body = stripAnsi(uiHarness.confirmCalls[0]!.body);
  assert.match(body, /Programs to run:/);
  assert.match(body, /1\) cd, 2\) chezmoi, 3\) git, 4\) git, 5\) git, 6\) git/);
  assert.doesNotMatch(body, /executable_list-provider-models/);
  assert.doesNotMatch(body, /List provider service models/);
});

test("bash programs list ignores line-continuation paths and only includes actual commands", async () => {
  const extension = await loadExtension();
  const { pi, getHandler } = createPiHarness();
  extension(pi as any);
  const handler = getHandler("tool_call");

  const uiHarness = createUiHarness(true);
  const result = await handler(
    {
      toolName: "bash",
      input: {
        command: "cd ~/.local/share/chezmoi && git add \\\n  private_dot_pi/private_agent/settings.config.json \\\n  private_dot_pi/private_agent/private_extensions/08-reload-merged-settings.ts \\\n  private_dot_pi/private_agent/private_extensions/tests/reload-merged-settings.test.ts && \\\n git commit -m \"Split pi settings config\"",
      },
    },
    {
      hasUI: true,
      ui: uiHarness.ui,
    },
  );

  assert.equal(result, undefined);
  const body = stripAnsi(uiHarness.confirmCalls[0]!.body);
  assert.match(body, /Programs to run:/);
  assert.match(body, /1\) cd, 2\) git, 3\) git/);
  assert.doesNotMatch(body, /reload-merged-settings/);
  assert.doesNotMatch(body, /settings\.config\.json/);
});

test("empty file write shows empty file preview in editor and confirms with path only summary", async () => {
  const extension = await loadExtension();
  const { pi, getHandler } = createPiHarness();
  extension(pi as any);
  const handler = getHandler("tool_call");

  const uiHarness = createUiHarness(true);
  const result = await handler(
    {
      toolName: "write",
      input: { path: "empty.txt", content: "" },
    },
    {
      hasUI: true,
      ui: uiHarness.ui,
    },
  );

  assert.equal(result, undefined);
  assert.equal(uiHarness.setEditorTextCalls[0], "<empty file>");
  const body = stripAnsi(uiHarness.confirmCalls[0]!.body);
  assert.match(body, /Path:/);
  assert.match(body, /empty\.txt/);
  assert.doesNotMatch(body, /New content:/);
});

test("edit preview handles empty old and new text blocks", async () => {
  const extension = await loadExtension();
  const { pi, getHandler } = createPiHarness();
  extension(pi as any);
  const handler = getHandler("tool_call");

  const uiHarness = createUiHarness(true);
  const result = await handler(
    {
      toolName: "edit",
      input: {
        path: "notes.txt",
        edits: [{ oldText: "", newText: "" }],
      },
    },
    {
      hasUI: true,
      ui: uiHarness.ui,
    },
  );

  assert.equal(result, undefined);
  assert.equal(
    uiHarness.setEditorTextCalls[0],
    [
      "@@ edit 1 @@",
      "- 1 │ <empty>",
      "+ 1 │ <empty>",
    ].join("\n"),
  );
  assert.deepEqual(uiHarness.setWidgetCalls, []);
});

test("empowerment allows writes and edits in the current directory without confirmation", async () => {
  const originalSettings = readFileSync(SETTINGS_CONFIG_PATH, "utf8");
  try {
    const settings = JSON.parse(originalSettings);
    settings.managingStyle = "Empowerment";
    writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify(settings, null, 2)}\n`);

    const mod = await loadExtensionModule();
    await mod.refreshManagingStyleCache();
    const extension = mod.default as (pi: { on: (event: string, handler: Function) => void }) => void;
    const { pi, getHandler } = createPiHarness();
    extension(pi as any);
    const handler = getHandler("tool_call");

    const uiHarness = createUiHarness(true);
    const cwd = resolve("agent");

    assert.equal(
      await handler(
        { toolName: "write", input: { path: "notes.txt", content: "hello" } },
        { cwd, hasUI: false, ui: uiHarness.ui },
      ),
      undefined,
    );
    assert.equal(
      await handler(
        { toolName: "edit", input: { path: resolve(cwd, "subdir/notes.txt"), edits: [{ oldText: "a", newText: "b" }] } },
        { cwd, hasUI: false, ui: uiHarness.ui },
      ),
      undefined,
    );
    assert.deepEqual(uiHarness.confirmCalls, []);
    assert.deepEqual(uiHarness.setEditorTextCalls, []);
  }
  finally {
    writeFileSync(SETTINGS_CONFIG_PATH, originalSettings);
  }
});

test("empowerment allows local read-only checks and still asks before mutating or external actions", async () => {
  const originalSettings = readFileSync(SETTINGS_CONFIG_PATH, "utf8");
  try {
    const settings = JSON.parse(originalSettings);
    settings.managingStyle = "Empowerment";
    writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify(settings, null, 2)}\n`);

    const mod = await loadExtensionModule();
    await mod.refreshManagingStyleCache();
    const extension = mod.default as (pi: { on: (event: string, handler: Function) => void }) => void;
    const { pi, getHandler } = createPiHarness();
    extension(pi as any);
    const handler = getHandler("tool_call");

    const safeUiHarness = createUiHarness(true);
    assert.equal(
      await handler(
        { toolName: "bash", input: { command: "git status --short && npm test && npx tsc --noEmit" } },
        { cwd: resolve("agent"), hasUI: false, ui: safeUiHarness.ui },
      ),
      undefined,
    );
    assert.deepEqual(safeUiHarness.confirmCalls, []);

    const mutationUiHarness = createUiHarness(true);
    assert.equal(
      await handler(
        { toolName: "bash", input: { command: "mkdir reports && mv draft.txt reports/draft.txt" } },
        { cwd: resolve("agent"), hasUI: true, ui: mutationUiHarness.ui },
      ),
      undefined,
    );
    assert.equal(mutationUiHarness.confirmCalls.length, 1);

    const riskyUiHarness = createUiHarness(true);
    assert.equal(
      await handler(
        { toolName: "bash", input: { command: "git add file.txt && curl https://example.com" } },
        { cwd: resolve("agent"), hasUI: true, ui: riskyUiHarness.ui },
      ),
      undefined,
    );
    assert.equal(riskyUiHarness.confirmCalls.length, 1);
    assert.match(stripAnsi(riskyUiHarness.confirmCalls[0]!.body), /Programs to run:/);

    const externalUiHarness = createUiHarness(true);
    assert.equal(
      await handler(
        { toolName: "write", input: { path: "../outside.txt", content: "hello" } },
        { cwd: resolve("agent"), hasUI: true, ui: externalUiHarness.ui },
      ),
      undefined,
    );
    assert.equal(externalUiHarness.confirmCalls.length, 1);
    assert.match(stripAnsi(externalUiHarness.confirmCalls[0]!.title), /Allow file write\?/);
  }
  finally {
    writeFileSync(SETTINGS_CONFIG_PATH, originalSettings);
  }
});

test("guidance allows local read-only bash but still confirms file mutations", async () => {
  const originalSettings = readFileSync(SETTINGS_CONFIG_PATH, "utf8");
  try {
    const settings = JSON.parse(originalSettings);
    settings.managingStyle = "Guidance";
    writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify(settings, null, 2)}\n`);

    const mod = await loadExtensionModule();
    await mod.refreshManagingStyleCache();
    const extension = mod.default as (pi: { on: (event: string, handler: Function) => void }) => void;
    const { pi, getHandler } = createPiHarness();
    extension(pi as any);
    const handler = getHandler("tool_call");

    const safeBashUiHarness = createUiHarness(true);
    assert.equal(
      await handler(
        { toolName: "bash", input: { command: "git status --short && npm test && npx tsc --noEmit" } },
        { cwd: resolve("agent"), hasUI: false, ui: safeBashUiHarness.ui },
      ),
      undefined,
    );
    assert.deepEqual(safeBashUiHarness.confirmCalls, []);

    assert.deepEqual(
      await handler(
        { toolName: "write", input: { path: "notes.txt", content: "hello" } },
        { cwd: resolve("agent"), hasUI: false, ui: createUiHarness(true).ui },
      ),
      { block: true, reason: "File write blocked (no UI available for confirmation)" },
    );

    const editUiHarness = createUiHarness(true);
    assert.equal(
      await handler(
        { toolName: "edit", input: { path: "notes.txt", edits: [{ oldText: "a", newText: "b" }] } },
        { cwd: resolve("agent"), hasUI: true, ui: editUiHarness.ui },
      ),
      undefined,
    );
    assert.equal(editUiHarness.confirmCalls.length, 1);
    assert.match(stripAnsi(editUiHarness.confirmCalls[0]!.title), /Allow file edit\?/);
  }
  finally {
    writeFileSync(SETTINGS_CONFIG_PATH, originalSettings);
  }
});

test("managing style setting updates stale settings list values", async () => {
  const mod = await loadExtensionModule();
  const settingsList = {
    items: [{
      id: "managing-style",
      label: "Managing Style",
      description: "Old description",
      currentValue: "Micromanagement",
      values: ["Micromanagement", "Empowerment"],
    }],
    filteredItems: [] as any[],
    updated: [] as Array<{ id: string; value: string }>,
    onChange() {},
    updateValue(id: string, value: string) {
      this.updated.push({ id, value });
    },
  };

  const submenuFactory = () => ({ kind: "submenu" });
  mod.addManagingStyleSettingToSettingsList(settingsList, "Guidance", () => {}, submenuFactory);

  assert.equal(settingsList.items.length, 1);
  assert.equal(settingsList.items[0]!.label, "Management style");
  assert.equal(settingsList.items[0]!.description, "Choose how much approval Pi needs before acting");
  assert.equal(settingsList.items[0]!.currentValue, "Guidance");
  assert.equal(settingsList.items[0]!.values, undefined);
  assert.equal(settingsList.items[0]!.submenu, submenuFactory);
  assert.deepEqual(settingsList.updated, [{ id: "managing-style", value: "Guidance" }]);
  assert.equal(settingsList.filteredItems, settingsList.items);
});

test("management style HUD variants remain semantic and ANSI-free", async () => {
  const mod = await loadExtensionModule();
  const variants = mod.getManagingStyleSegments("Guidance");
  assert.equal(variants.full.map((segment: { text: string }) => segment.text).join(""), "◆ Guiding");
  assert.equal(variants.icon[0].text, "◆");
  assert.equal(variants.icon[0].tone, "warning");
  assert.equal(mod.getManagingStyleSegments("Micromanagement").icon[0].tone, "error");
  assert.equal(mod.getManagingStyleSegments("Empowerment").icon[0].tone, "success");
});

test("management style no longer patches footer or status APIs", () => {
  const source = readFileSync(EXTENSION_PATH, "utf8");
  assert.equal(source.includes("FooterComponent"), false);
  assert.equal(source.includes("setFooter"), false);
  assert.equal(source.includes("getActiveHandoffStatus"), false);
});

test("management style shortcut cycles session style without changing settings", async () => {
  const originalSettings = readFileSync(SETTINGS_CONFIG_PATH, "utf8");
  try {
    const settings = JSON.parse(originalSettings);
    settings.managingStyle = "Micromanagement";
    writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify(settings, null, 2)}\n`);

    const mod = await loadExtensionModule();
    const extension = mod.default as (pi: { on: (event: string, handler: Function) => void; registerTool: Function; registerShortcut: Function }) => void;
    const { pi, getHandler, shortcuts } = createPiHarness();
    extension(pi as any);

    const uiHarness = createUiHarness(true);
    const notifications: Array<{ message: string; level?: string }> = [];
    const ui = {
      ...uiHarness.ui,
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    };
    await getHandler("session_start")({}, { ui });

    const shortcut = shortcuts.get(mod.MANAGEMENT_STYLE_CYCLE_SHORTCUT);
    const backwardShortcut = shortcuts.get(mod.MANAGEMENT_STYLE_CYCLE_BACKWARD_SHORTCUT);
    assert.ok(shortcut, "Expected management style cycle shortcut to be registered");
    assert.ok(backwardShortcut, "Expected management style backward cycle shortcut to be registered");
    assert.equal(mod.MANAGEMENT_STYLE_CYCLE_SHORTCUT, "ctrl+;");
    assert.equal(mod.MANAGEMENT_STYLE_CYCLE_BACKWARD_SHORTCUT, "shift+ctrl+;");
    assert.equal(mod.MANAGEMENT_STYLE_CYCLE_HOTKEY_DISPLAY, "ctrl+; / shift+ctrl+;");
    assert.equal(shortcut.description, "Cycle management style for this session");
    assert.equal(backwardShortcut.description, "Cycle management style backward for this session");

    await shortcut.handler({ ui });
    assert.equal(uiHarness.setStatusCalls.length, 0);
    await shortcut.handler({ ui });
    assert.equal(uiHarness.setStatusCalls.length, 0);
    await backwardShortcut.handler({ ui });
    assert.equal(uiHarness.setStatusCalls.length, 0);
    await shortcut.handler({ ui });
    assert.equal(uiHarness.setStatusCalls.length, 0);
    assert.deepEqual(notifications.map((entry) => entry.message), [
      "Management style: Guiding (session only)",
      "Management style: Empowering (session only)",
      "Management style: Guiding (session only)",
      "Management style: Empowering (session only)",
    ]);
    assert.equal(JSON.parse(readFileSync(SETTINGS_CONFIG_PATH, "utf8")).managingStyle, "Micromanagement");

    assert.equal(
      await getHandler("tool_call")(
        { toolName: "write", input: { path: "notes.txt", content: "hello" } },
        { cwd: resolve("agent"), hasUI: false, ui },
      ),
      undefined,
    );
  }
  finally {
    writeFileSync(SETTINGS_CONFIG_PATH, originalSettings);
  }
});

test("management style backward shortcut handles terminal ctrl-colon fallback", async () => {
  const mod = await loadExtensionModule();

  assert.equal(mod.MANAGEMENT_STYLE_CYCLE_BACKWARD_SHORTCUT, "shift+ctrl+;");
  assert.equal(mod.isShiftCtrlSemicolonFallbackInput("\x1b[58;5u"), true);
  assert.equal(mod.isShiftCtrlSemicolonFallbackInput("\x1b[58;6u"), true);
  assert.equal(mod.isShiftCtrlSemicolonFallbackInput("\x1b[59;6u"), false);
});

test("management style session lifecycle publishes through the HUD registry", async () => {
  const extension = await loadExtension();
  const registry = await import("../00-hud/registry.ts");
  const { pi, getHandler } = createPiHarness();
  extension(pi as any);
  await getHandler("session_start")({}, { ui: createUiHarness().ui });
  assert.equal(registry.hudItems().some((item) => item.owner === "confirm-before-actions" && item.id === "management-style"), true);
  await getHandler("session_shutdown")({}, { ui: createUiHarness().ui });
  assert.equal(registry.hudItems().some((item) => item.owner === "confirm-before-actions" && item.id === "management-style"), false);
});

test("management style submenu lists modes with descriptions and selects a value", async () => {
  const mod = await loadExtensionModule();
  const selected: string[] = [];
  const doneValues: Array<string | undefined> = [];
  const themeModule = {
    theme: {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
    getSelectListTheme: () => ({}),
  };
  let resolveChange: (() => void) | undefined;
  const changePromise = new Promise<void>((resolve) => {
    resolveChange = resolve;
  });
  const submenuFactory = mod.createManagingStyleSubmenuFactory(themeModule, async (style: string) => {
    await changePromise;
    selected.push(style);
  });
  const submenu = submenuFactory("Guidance", (value?: string) => {
    doneValues.push(value);
  });
  const selectList = submenu.children.find((child: any) => Array.isArray(child.options));

  assert.ok(selectList, "Expected submenu to include a select list");
  assert.equal(selectList.selectedIndex, 1);
  assert.deepEqual(
    selectList.options.map((option: any) => [option.value, option.label, option.description]),
    [
      ["Micromanagement", "Micromanagement", "Ask before every bash command, write, and edit"],
      ["Guidance", "Guidance", "Allow local read-only checks; ask before file changes and risky commands"],
      ["Empowerment", "Empowerment", "Allow in-folder writes/edits and checks; ask before risky commands"],
    ],
  );

  selectList.onSelect({ value: "Empowerment" });
  assert.deepEqual(doneValues, ["Empowerment"]);
  assert.deepEqual(selected, []);
  resolveChange?.();
  await changePromise;
  await Promise.resolve();
  assert.deepEqual(selected, ["Empowerment"]);
});

test("managing style setting is added to settings list and forwards changes", async () => {
  const mod = await loadExtensionModule();
  const changes: Array<{ id: string; value: string }> = [];
  const settingsList = {
    items: [{ id: "thinking", label: "Thinking", currentValue: "medium" }],
    filteredItems: [] as any[],
    onChange(id: string, value: string) {
      changes.push({ id, value });
    },
  };
  const selected: string[] = [];

  mod.addManagingStyleSettingToSettingsList(settingsList, "Empowerment", (style: string) => {
    selected.push(style);
  });

  assert.equal(settingsList.items[1]!.id, "managing-style");
  assert.equal(settingsList.items[1]!.label, "Management style");
  assert.equal(settingsList.items[1]!.currentValue, "Empowerment");
  assert.equal(settingsList.items[1]!.values, undefined);
  assert.equal(settingsList.items[1]!.submenu, undefined);

  settingsList.onChange("managing-style", "Guidance");
  settingsList.onChange("thinking", "high");

  assert.deepEqual(selected, ["Guidance"]);
  assert.deepEqual(changes, [{ id: "thinking", value: "high" }]);
});

test("write tool blocks immediately when no UI is available", async () => {
  const extension = await loadExtension();
  const { pi, getHandler } = createPiHarness();
  extension(pi as any);
  const handler = getHandler("tool_call");

  const result = await handler(
    {
      toolName: "write",
      input: { path: "notes.txt", content: "hello" },
    },
    {
      hasUI: false,
      ui: createUiHarness(true).ui,
    },
  );

  assert.deepEqual(result, {
    block: true,
    reason: "File write blocked (no UI available for confirmation)",
  });
});

test.after(() => {
  delete (globalThis as any).__nativeNotifyMock;
  rmSync(resolve("agent/extensions/node_modules"), { recursive: true, force: true });
  rmSync(resolve("agent/extensions/.confirm-before-actions.testable.ts"), { force: true });
  rmSync(STUB_HANDOFF_PACKAGE_DIR, { recursive: true, force: true });
});
