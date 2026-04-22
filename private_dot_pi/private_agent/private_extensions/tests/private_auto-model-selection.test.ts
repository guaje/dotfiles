import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSION_PATH = resolve("agent/extensions/auto-model-selection.ts");
const SETTINGS_CONFIG_PATH = resolve("agent/settings.config.json");
const ORIGINAL_SETTINGS_CONFIG = readFileSync(SETTINGS_CONFIG_PATH, "utf8");
const STUB_PACKAGE_DIR = resolve("agent/extensions/node_modules");
const PI_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@mariozechner/pi-coding-agent");
const PI_AI_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@mariozechner/pi-ai");
const TYPEBOX_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@sinclair/typebox");

async function loadExtension() {
  mkdirSync(PI_PACKAGE_DIR, { recursive: true });
  writeFileSync(resolve(PI_PACKAGE_DIR, "package.json"), JSON.stringify({
    name: "@mariozechner/pi-coding-agent",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(PI_PACKAGE_DIR, "index.js"), "");

  mkdirSync(PI_AI_PACKAGE_DIR, { recursive: true });
  writeFileSync(resolve(PI_AI_PACKAGE_DIR, "package.json"), JSON.stringify({
    name: "@mariozechner/pi-ai",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(PI_AI_PACKAGE_DIR, "index.js"), [
    "export async function completeSimple(model, context, options) {",
    "  if (typeof globalThis.__completeSimpleMock === 'function') return globalThis.__completeSimpleMock(model, context, options);",
    "  return { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] };",
    "}",
  ].join("\n"));

  mkdirSync(TYPEBOX_PACKAGE_DIR, { recursive: true });
  writeFileSync(resolve(TYPEBOX_PACKAGE_DIR, "package.json"), JSON.stringify({
    name: "@sinclair/typebox",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(TYPEBOX_PACKAGE_DIR, "index.js"), [
    "export const Type = {",
    "  Object(properties) { return { type: 'object', properties }; },",
    "  String(options = {}) { return { type: 'string', ...options }; },",
    "};",
  ].join("\n"));

  const moduleUrl = `${pathToFileURL(EXTENSION_PATH).href}?t=${Date.now()}`;
  const mod = await import(moduleUrl);
  return mod;
}

test("selectModel logic", async () => {
  const mod = await loadExtension();
  const selectModel = mod.selectModel;
  const estimateReasoningEffort = mod.estimateReasoningEffort;

  const models = [
    { id: "google-antigravity/gemini-3-flash", name: "flash" },
    { id: "google-antigravity/gemini-3.1-pro-high", name: "pro-high" },
    { id: "google-antigravity/claude-opus-4-6-thinking", name: "opus", reasoning: true },
    { id: "reallms/Qwen3-Coder-Next", name: "coder" },
  ];

  assert.equal(selectModel("summarize this file", models), "google-antigravity/gemini-3-flash");
  assert.equal(selectModel("complex architectural reasoning", models), "google-antigravity/claude-opus-4-6-thinking");
  assert.equal(selectModel("refactor this typescript function", models), "reallms/Qwen3-Coder-Next");
  assert.equal(selectModel("general question", models), "google-antigravity/gemini-3.1-pro-high");

  assert.equal(estimateReasoningEffort("complex architectural reasoning"), "xhigh");
  assert.equal(estimateReasoningEffort("debug this difficult issue"), "high");
  assert.equal(estimateReasoningEffort("review this implementation plan"), "medium");
  assert.equal(estimateReasoningEffort("quick summary"), "low");
});

test("adds auto model setting to a settings list", async () => {
  const mod = await loadExtension();
  const addAutoModelSettingToSettingsList = mod.addAutoModelSettingToSettingsList;

  const changed: boolean[] = [];
  const settingsList = {
    items: [
      { id: "transport", label: "Transport", currentValue: "sse", values: ["sse", "auto"] },
      { id: "thinking", label: "Thinking", currentValue: "medium", values: ["off", "medium"] },
    ],
    filteredItems: [] as any[],
    onChange(id: string, newValue: string) {
      changed.push(id === "transport" && newValue === "auto");
    },
    updateValue(id: string, newValue: string) {
      const item = this.items.find((entry: any) => entry.id === id);
      if (item) item.currentValue = newValue;
    },
  };
  settingsList.filteredItems = settingsList.items;

  addAutoModelSettingToSettingsList(settingsList, true, (enabled: boolean) => changed.push(enabled));

  assert.equal(settingsList.items[2]?.id, "auto-model-selection");
  settingsList.onChange("auto-model-selection", "false");
  settingsList.onChange("transport", "auto");
  assert.deepEqual(changed, [false, true]);
});

test("before_agent_start auto-selects reasoning effort for reasoning models", async () => {
  const mod = await loadExtension();
  const extension = mod.default;

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({
    enabledModels: ["reallms/gpt-oss-120b", "reallms/Qwen3-Coder-Next"],
    autoModelSelectionEnabled: true,
  }, null, 2)}\n`);

  let setModelArg: any;
  let thinkingLevel: string | undefined;
  const handlers = new Map<string, Function>();
  const pi = {
    on(eventName: string, handler: Function) {
      handlers.set(eventName, handler);
    },
    registerTool() {},
    registerCommand() {},
    async setModel(model: any) {
      setModelArg = model;
      return true;
    },
    setThinkingLevel(level: string) {
      thinkingLevel = level;
    },
  };

  extension(pi as any);

  await handlers.get("before_agent_start")?.({ prompt: "complex architectural reasoning" }, {
    modelRegistry: {
      find(provider: string, modelId: string) {
        return { provider, id: modelId };
      },
    },
    model: undefined,
    ui: { notify() {} },
  });

  assert.deepEqual(setModelArg, { provider: "reallms", id: "gpt-oss-120b" });
  assert.equal(thinkingLevel, "xhigh");
});

test("registers tool, command, and auto-switch hook", async () => {
  const mod = await loadExtension();
  const extension = mod.default;

  let registeredTool: any;
  let registeredCommandName: string | undefined;
  let registeredCommand: any;
  const handlers = new Map<string, Function>();
  const pi = {
    on(eventName: string, handler: Function) {
      handlers.set(eventName, handler);
    },
    registerTool(tool: any) {
      registeredTool = tool;
    },
    registerCommand(name: string, command: any) {
      registeredCommandName = name;
      registeredCommand = command;
    },
    async setModel() {
      return true;
    },
  };

  extension(pi as any);

  assert.equal(typeof handlers.get("session_start"), "function");
  assert.equal(typeof handlers.get("session_shutdown"), "function");
  assert.equal(typeof handlers.get("before_agent_start"), "function");
  assert.equal(registeredTool.name, "select_best_model");
  assert.equal(registeredCommandName, "auto-model");
  assert.equal(registeredCommand.description, "Toggle automatic model selection on or off");
});

test("/auto-model toggles persisted state in settings.config.json", async () => {
  const mod = await loadExtension();
  const extension = mod.default;

  let registeredCommand: any;
  const notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    on() {},
    registerTool() {},
    registerCommand(_name: string, command: any) {
      registeredCommand = command;
    },
    async setModel() {
      return true;
    },
  };

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({ enabledModels: ["openai-codex/gpt-5.4"], autoModelSelectionEnabled: true }, null, 2)}\n`);
  extension(pi as any);

  await registeredCommand.handler("", {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  });

  let settings = JSON.parse(readFileSync(SETTINGS_CONFIG_PATH, "utf8"));
  assert.equal(settings.autoModelSelectionEnabled, false);
  assert.match(notifications[0]!.message, /disabled/);

  await registeredCommand.handler("on", {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  });

  settings = JSON.parse(readFileSync(SETTINGS_CONFIG_PATH, "utf8"));
  assert.equal(settings.autoModelSelectionEnabled, true);
  assert.match(notifications[1]!.message, /enabled/);
});

test("/auto-model status reflects manual settings.config.json edits", async () => {
  const mod = await loadExtension();
  const extension = mod.default;

  let registeredCommand: any;
  const notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    on() {},
    registerTool() {},
    registerCommand(_name: string, command: any) {
      registeredCommand = command;
    },
    async setModel() {
      return true;
    },
  };

  extension(pi as any);

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({ enabledModels: ["openai-codex/gpt-5.4"], autoModelSelectionEnabled: false }, null, 2)}\n`);
  await registeredCommand.handler("status", {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  });

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({ enabledModels: ["openai-codex/gpt-5.4"], autoModelSelectionEnabled: true }, null, 2)}\n`);
  await registeredCommand.handler("status", {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  });

  assert.match(notifications[0]!.message, /OFF/);
  assert.match(notifications[1]!.message, /ON/);
});

test.after(() => {
  delete (globalThis as any).__completeSimpleMock;
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  rmSync(PI_PACKAGE_DIR, { recursive: true, force: true });
  rmSync(PI_AI_PACKAGE_DIR, { recursive: true, force: true });
  rmSync(TYPEBOX_PACKAGE_DIR, { recursive: true, force: true });
});
