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

const EXTENSION_PATH = resolve("agent/extensions/confirm-before-actions.ts");
const STUB_PACKAGE_DIR = resolve("agent/extensions/node_modules/@mariozechner/pi-coding-agent");
const STUB_TUI_PACKAGE_DIR = resolve("agent/extensions/node_modules/@mariozechner/pi-tui");

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

async function loadExtension() {
  mkdirSync(STUB_PACKAGE_DIR, { recursive: true });
  mkdirSync(STUB_TUI_PACKAGE_DIR, { recursive: true });
  writeFileSync(resolve(STUB_PACKAGE_DIR, "package.json"), JSON.stringify({
    name: "@mariozechner/pi-coding-agent",
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
    name: "@mariozechner/pi-tui",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(STUB_TUI_PACKAGE_DIR, "index.js"), [
    "export class Text {",
    "  constructor(text) { this.text = text; }",
    "  setText(text) { this.text = text; }",
    "}",
  ].join("\n"));

  const patchedExtensionPath = resolve("agent/extensions/.confirm-before-actions.testable.ts");
  const source = readFileSync(EXTENSION_PATH, "utf8").replaceAll(
    "import.meta.dirname",
    JSON.stringify(dirname(EXTENSION_PATH)),
  );
  writeFileSync(patchedExtensionPath, source);

  const moduleUrl = `${pathToFileURL(patchedExtensionPath).href}?t=${Date.now()}`;
  const mod = await import(moduleUrl);
  return mod.default as (pi: { on: (event: string, handler: Function) => void }) => void;
}

function createPiHarness() {
  const handlers = new Map<string, Function>();
  const tools: Array<Record<string, unknown>> = [];
  return {
    pi: {
      on(event: string, handler: Function) {
        handlers.set(event, handler);
      },
      registerTool(tool: Record<string, unknown>) {
        tools.push(tool);
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

  return {
    ui: {
      async confirm(title: string, body: string) {
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
    },
    get editorText() {
      return editorText;
    },
    confirmCalls,
    setEditorTextCalls,
    setWidgetCalls,
  };
}

test("write confirmation loads the full file preview into the editor and restores previous editor text", async () => {
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

test("bash programs list excludes heredoc script fragments", async () => {
  const extension = await loadExtension();
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
        command: "cd ~/.local/share/chezmoi && git add \\\n  private_dot_pi/private_agent/settings.config.json \\\n  private_dot_pi/private_agent/private_extensions/reload-merged-settings.ts \\\n  private_dot_pi/private_agent/private_extensions/tests/reload-merged-settings.test.ts && \\\n git commit -m \"Split pi settings config\"",
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
  rmSync(resolve("agent/extensions/node_modules"), { recursive: true, force: true });
  rmSync(resolve("agent/extensions/.confirm-before-actions.testable.ts"), { force: true });
});
