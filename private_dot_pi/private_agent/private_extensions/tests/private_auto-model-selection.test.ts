import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSION_PATH = resolve("agent/extensions/auto-model-selection.ts");
const SETTINGS_CONFIG_PATH = resolve("agent/settings.config.json");
const MODELS_PATH = resolve("agent/models.json");
const MODEL_HEALTH_CACHE_PATH = resolve("agent/model-health-cache.json");
const ORIGINAL_SETTINGS_CONFIG = readFileSync(SETTINGS_CONFIG_PATH, "utf8");
const STUB_PACKAGE_DIR = resolve("agent/extensions/node_modules");
const PI_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@mariozechner/pi-coding-agent");
const PI_AI_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@mariozechner/pi-ai");
const TYPEBOX_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@sinclair/typebox");
const PI_TUI_PACKAGE_DIR = resolve(STUB_PACKAGE_DIR, "@mariozechner/pi-tui");
const TEST_CWD = resolve(".");

interface AvailableTestModel {
  id: string;
  name: string;
  reasoning?: boolean;
}

function splitTestModelId(fullId: string): { provider: string; modelId: string } {
  const [provider, ...rest] = fullId.split("/");
  assert.ok(provider && rest.length > 0, `Expected provider/model id, got ${fullId}`);
  return { provider, modelId: rest.join("/") };
}

function runtimeModelFromMetadata(model: AvailableTestModel) {
  const { provider, modelId } = splitTestModelId(model.id);
  return { provider, id: modelId, reasoning: model.reasoning === true };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readAvailableTestModels(): AvailableTestModel[] {
  const modelsFile = JSON.parse(readFileSync(MODELS_PATH, "utf8"));
  const settingsFile = JSON.parse(readFileSync(SETTINGS_CONFIG_PATH, "utf8"));
  const enabledIds: string[] = settingsFile.enabledModels || [];
  const metadata = new Map<string, AvailableTestModel>();

  for (const [providerId, provider] of Object.entries<any>(modelsFile.providers || {})) {
    for (const model of provider.models || []) {
      metadata.set(`${providerId}/${model.id}`, { ...model, id: `${providerId}/${model.id}` });
    }
  }

  const enabledModels = enabledIds.map((id) => metadata.get(id) || { id, name: splitTestModelId(id).modelId });
  let healthyIds: Set<string> | undefined;
  try {
    const cache = JSON.parse(readFileSync(MODEL_HEALTH_CACHE_PATH, "utf8"));
    healthyIds = new Set((cache.results || []).filter((result: any) => result.status === "ok").map((result: any) => result.id));
  } catch {
    healthyIds = undefined;
  }

  const healthyModels = healthyIds ? enabledModels.filter((model) => healthyIds!.has(model.id)) : enabledModels;
  const models = healthyModels.length > 0 ? healthyModels : enabledModels;
  assert.ok(models.length > 0, "Expected at least one enabled model for auto-model-selection tests");
  return models;
}

function chooseDelegateModel(models: AvailableTestModel[], selectorId: string): AvailableTestModel {
  const delegate = models.find((model) => model.id !== selectorId && !model.reasoning) ||
                   models.find((model) => model.id !== selectorId);
  assert.ok(delegate, "Expected at least two available models to test delegation");
  return delegate;
}

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

  mkdirSync(PI_TUI_PACKAGE_DIR, { recursive: true });
  writeFileSync(resolve(PI_TUI_PACKAGE_DIR, "package.json"), JSON.stringify({
    name: "@mariozechner/pi-tui",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(resolve(PI_TUI_PACKAGE_DIR, "index.js"), [
    "function strip(value) { return String(value).replace(/\\x1b\\[[0-9;]*m/g, '').replace(/<[^>]+>/g, ''); }",
    "export function visibleWidth(value) { return strip(value).length; }",
    "export function truncateToWidth(value, width, ellipsis = '...') {",
    "  const text = String(value);",
    "  return strip(text).length <= width ? text : strip(text).slice(0, Math.max(0, width - String(ellipsis).length)) + ellipsis;",
    "}",
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
    { id: "test-provider/test-flash", name: "flash" },
    { id: "test-provider/test-pro-high", name: "pro-high" },
    { id: "test-provider/test-opus-thinking", name: "opus", reasoning: true },
    { id: "test-provider/test-coder", name: "coder" },
  ];

  assert.equal(selectModel("summarize this file", models), "test-provider/test-flash");
  assert.equal(selectModel("complex architectural reasoning", models), "test-provider/test-opus-thinking");
  assert.equal(selectModel("refactor this typescript function", models), "test-provider/test-coder");
  assert.equal(selectModel("general question", models), "test-provider/test-pro-high");

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
  const availableModels = readAvailableTestModels();

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({
    enabledModels: availableModels.map((model) => model.id),
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
        const metadata = availableModels.find((candidate) => candidate.id === `${provider}/${modelId}`);
        return metadata ? runtimeModelFromMetadata(metadata) : { provider, id: modelId };
      },
    },
    model: undefined,
    ui: { notify() {} },
  });

  assert.equal(setModelArg?.reasoning, true);
  assert.equal(thinkingLevel, "xhigh");
});

test("before_agent_start starts with strongest thinking model at medium before delegating", async () => {
  const mod = await loadExtension();
  const extension = mod.default;
  const availableModels = readAvailableTestModels();
  const selectorId = mod.selectMostPowerfulThinkingModel(availableModels);
  const selectorMetadata = availableModels.find((model) => model.id === selectorId)!;
  const delegateMetadata = chooseDelegateModel(availableModels, selectorId);
  const selectorRuntimeModel = runtimeModelFromMetadata(selectorMetadata);
  const delegateRuntimeModel = runtimeModelFromMetadata(delegateMetadata);

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({
    enabledModels: availableModels.map((model) => model.id),
    autoModelSelectionEnabled: true,
  }, null, 2)}\n`);

  const setModelCalls: any[] = [];
  const thinkingLevels: string[] = [];
  const selectorCalls: any[] = [];
  (globalThis as any).__completeSimpleMock = async (model: any, context: any, options: any) => {
    selectorCalls.push({ model, context, options });
    return {
      stopReason: "stop",
      content: [{ type: "text", text: JSON.stringify({
        modelId: delegateMetadata.id,
        reason: "Delegate this task to another available model",
      }) }],
    };
  };

  const handlers = new Map<string, Function>();
  const pi = {
    on(eventName: string, handler: Function) {
      handlers.set(eventName, handler);
    },
    registerTool() {},
    registerCommand() {},
    async setModel(model: any) {
      setModelCalls.push(model);
      return true;
    },
    setThinkingLevel(level: string) {
      thinkingLevels.push(level);
    },
  };

  extension(pi as any);

  await handlers.get("before_agent_start")?.({ prompt: "implement a TypeScript feature" }, {
    modelRegistry: {
      find(provider: string, modelId: string) {
        const fullId = `${provider}/${modelId}`;
        const metadata = availableModels.find((candidate) => candidate.id === fullId);
        return metadata ? runtimeModelFromMetadata(metadata) : undefined;
      },
      async getApiKeyAndHeaders(model: any) {
        return { ok: true, apiKey: `key-for-${model.id}`, headers: { "x-model": model.id } };
      },
    },
    model: undefined,
    ui: { notify() {} },
  });

  assert.deepEqual(setModelCalls, [selectorRuntimeModel, delegateRuntimeModel]);
  assert.deepEqual(thinkingLevels, selectorMetadata.reasoning ? ["medium"] : []);
  assert.equal(selectorCalls.length, 1);
  assert.deepEqual(selectorCalls[0]!.model, selectorRuntimeModel);
  assert.equal(selectorCalls[0]!.options.reasoning, "medium");
  assert.equal(selectorCalls[0]!.options.apiKey, `key-for-${selectorRuntimeModel.id}`);
  assert.deepEqual(selectorCalls[0]!.options.headers, { "x-model": selectorRuntimeModel.id });
  assert.match(selectorCalls[0]!.context.messages[0].content[0].text, /implement a TypeScript feature/);
  assert.match(selectorCalls[0]!.context.messages[0].content[0].text, new RegExp(escapeRegExp(delegateMetadata.id)));
});

test("before_agent_start can delegate back to selector model with a different reasoning effort", async () => {
  const mod = await loadExtension();
  const extension = mod.default;
  const availableModels = readAvailableTestModels();
  const selectorId = mod.selectMostPowerfulThinkingModel(availableModels);
  const selectorMetadata = availableModels.find((model) => model.id === selectorId)!;
  const selectorRuntimeModel = runtimeModelFromMetadata(selectorMetadata);

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({
    enabledModels: availableModels.map((model) => model.id),
    autoModelSelectionEnabled: true,
  }, null, 2)}\n`);

  const setModelCalls: any[] = [];
  const thinkingLevels: string[] = [];
  (globalThis as any).__completeSimpleMock = async () => ({
    stopReason: "stop",
    content: [{ type: "text", text: "```json\n" + JSON.stringify({
      modelId: selectorId,
      reasoningEffort: "xhigh",
      reason: "Keep the strongest model and raise reasoning for architecture work",
    }) + "\n```" }],
  });

  const handlers = new Map<string, Function>();
  const pi = {
    on(eventName: string, handler: Function) {
      handlers.set(eventName, handler);
    },
    registerTool() {},
    registerCommand() {},
    async setModel(model: any) {
      setModelCalls.push(model);
      return true;
    },
    setThinkingLevel(level: string) {
      thinkingLevels.push(level);
    },
  };

  extension(pi as any);

  await handlers.get("before_agent_start")?.({ prompt: "write a complex migration architecture plan" }, {
    modelRegistry: {
      find(provider: string, modelId: string) {
        const fullId = `${provider}/${modelId}`;
        const metadata = availableModels.find((candidate) => candidate.id === fullId);
        return metadata ? runtimeModelFromMetadata(metadata) : undefined;
      },
    },
    model: undefined,
    ui: { notify() {} },
  });

  assert.deepEqual(setModelCalls, [selectorRuntimeModel, selectorRuntimeModel]);
  assert.deepEqual(thinkingLevels, selectorMetadata.reasoning ? ["medium", "xhigh"] : []);
});

test("custom footer shows compact auto-model state immediately before the selected model", async () => {
  const mod = await loadExtension();
  const extension = mod.default;

  const handlers = new Map<string, Function>();
  let footerFactory: any;
  const pi = {
    on(eventName: string, handler: Function) {
      handlers.set(eventName, handler);
    },
    registerTool() {},
    registerCommand() {},
    async setModel() {
      return true;
    },
    getThinkingLevel() {
      return "medium";
    },
  };

  const availableModels = readAvailableTestModels();
  const footerModel = runtimeModelFromMetadata(availableModels[0]!);
  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({ enabledModels: availableModels.map((model) => model.id), autoModelSelectionEnabled: true }, null, 2)}\n`);
  extension(pi as any);

  const ctx = {
    sessionManager: {
      getEntries() {
        return [];
      },
      getCwd() {
        return TEST_CWD;
      },
      getSessionName() {
        return undefined;
      },
    },
    getContextUsage() {
      return { contextWindow: 128000, percent: 12.5 };
    },
    model: { ...footerModel, contextWindow: 128000, reasoning: true },
    ui: {
      setStatus() {},
      setFooter(factory: any) {
        footerFactory = factory;
      },
    },
  };

  await handlers.get("session_start")?.({}, ctx as any);
  assert.equal(typeof footerFactory, "function");

  const footer = footerFactory(
    { requestRender() {} },
    {
      fg(color: string, text: string) {
        return `<${color}>${text}</${color}>`;
      },
    },
    {
      getGitBranch() {
        return null;
      },
      getExtensionStatuses() {
        return new Map();
      },
      getAvailableProviderCount() {
        return 1;
      },
      onBranchChange() {
        return () => {};
      },
    },
  );

  const footerLine = footer.render(1000)[1] ?? "";
  assert.match(footerLine, /●/);
  assert.match(footerLine, /Auto/);
  assert.match(footerLine, new RegExp(`Auto.*\\(${escapeRegExp(footerModel.provider)}\\) ${escapeRegExp(footerModel.id)} • medium`));
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

test("/auto-model only toggles the current session", async () => {
  const mod = await loadExtension();
  const extension = mod.default;

  let registeredCommand: any;
  const handlers = new Map<string, Function>();
  const notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    on(eventName: string, handler: Function) {
      handlers.set(eventName, handler);
    },
    registerTool() {},
    registerCommand(_name: string, command: any) {
      registeredCommand = command;
    },
    async setModel() {
      return true;
    },
  };

  const availableModels = readAvailableTestModels();
  const currentModel = runtimeModelFromMetadata(availableModels[0]!);
  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({ enabledModels: availableModels.map((model) => model.id), autoModelSelectionEnabled: true }, null, 2)}\n`);
  extension(pi as any);
  await handlers.get("session_start")?.({}, {
    sessionManager: {
      getEntries() { return []; },
      getCwd() { return TEST_CWD; },
      getSessionName() { return undefined; },
    },
    getContextUsage() { return { contextWindow: 128000, percent: 0 }; },
    model: { ...currentModel, contextWindow: 128000, reasoning: false },
    ui: { setFooter() {}, setStatus() {} },
  });

  await registeredCommand.handler("", {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  });

  let settings = JSON.parse(readFileSync(SETTINGS_CONFIG_PATH, "utf8"));
  assert.equal(settings.autoModelSelectionEnabled, true);
  assert.match(notifications[0]!.message, /disabled/);
  assert.match(notifications[0]!.message, /this session only/);

  await registeredCommand.handler("status", {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  });

  assert.match(notifications[1]!.message, /OFF for this session/);
  assert.match(notifications[1]!.message, /default for new sessions: ON/);

  handlers.get("session_shutdown")?.({}, {});
});

test("/auto-model session toggle affects auto-switching without changing defaults", async () => {
  const mod = await loadExtension();
  const extension = mod.default;

  let registeredCommand: any;
  const handlers = new Map<string, Function>();
  let setModelCalls = 0;
  const pi = {
    on(eventName: string, handler: Function) {
      handlers.set(eventName, handler);
    },
    registerTool() {},
    registerCommand(_name: string, command: any) {
      registeredCommand = command;
    },
    async setModel() {
      setModelCalls += 1;
      return true;
    },
    setThinkingLevel() {},
  };

  const availableModels = readAvailableTestModels();
  const currentModel = runtimeModelFromMetadata(availableModels[0]!);
  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({
    enabledModels: availableModels.map((model) => model.id),
    autoModelSelectionEnabled: true,
  }, null, 2)}\n`);

  extension(pi as any);
  await handlers.get("session_start")?.({}, {
    sessionManager: {
      getEntries() { return []; },
      getCwd() { return TEST_CWD; },
      getSessionName() { return undefined; },
    },
    getContextUsage() { return { contextWindow: 128000, percent: 0 }; },
    model: { ...currentModel, contextWindow: 128000, reasoning: currentModel.reasoning },
    ui: { setFooter() {}, setStatus() {} },
  });

  await registeredCommand.handler("off", {
    ui: { notify() {} },
  });

  await handlers.get("before_agent_start")?.({ prompt: "complex reasoning" }, {
    modelRegistry: {
      find(provider: string, modelId: string) {
        return { provider, id: modelId };
      },
    },
    model: undefined,
    ui: { notify() {} },
  });

  assert.equal(setModelCalls, 0);
  const settings = JSON.parse(readFileSync(SETTINGS_CONFIG_PATH, "utf8"));
  assert.equal(settings.autoModelSelectionEnabled, true);

  handlers.get("session_shutdown")?.({}, {});
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

  const availableModels = readAvailableTestModels();
  const enabledModels = availableModels.map((model) => model.id);
  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({ enabledModels, autoModelSelectionEnabled: false }, null, 2)}\n`);
  await registeredCommand.handler("status", {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  });

  writeFileSync(SETTINGS_CONFIG_PATH, `${JSON.stringify({ enabledModels, autoModelSelectionEnabled: true }, null, 2)}\n`);
  await registeredCommand.handler("status", {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  });

  assert.match(notifications[0]!.message, /OFF for this session/);
  assert.match(notifications[0]!.message, /default for new sessions: OFF/);
  assert.match(notifications[1]!.message, /ON for this session/);
  assert.match(notifications[1]!.message, /default for new sessions: ON/);
});

test.after(() => {
  delete (globalThis as any).__completeSimpleMock;
  writeFileSync(SETTINGS_CONFIG_PATH, ORIGINAL_SETTINGS_CONFIG);
  rmSync(PI_PACKAGE_DIR, { recursive: true, force: true });
  rmSync(PI_AI_PACKAGE_DIR, { recursive: true, force: true });
  rmSync(TYPEBOX_PACKAGE_DIR, { recursive: true, force: true });
  rmSync(PI_TUI_PACKAGE_DIR, { recursive: true, force: true });
});
