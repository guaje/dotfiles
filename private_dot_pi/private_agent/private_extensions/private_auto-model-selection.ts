import { execFile as execFileCallback } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getHealthyEnabledModels } from "./model-health-check.ts";
import { importPiModule } from "./packages/pi-package.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFile = promisify(execFileCallback);
const MODELS_PATH = path.resolve(__dirname, "../models.json");
const SETTINGS_CONFIG_PATH = path.resolve(__dirname, "../settings.config.json");
const SETTINGS_PATH = path.resolve(__dirname, "../settings.json");
const MERGE_SETTINGS_SCRIPT_PATH = path.resolve(__dirname, "../scripts/merge-settings.sh");
const PI_INTERACTIVE_MODE_RELATIVE_PATH = "dist/modes/interactive/interactive-mode.js";
const PI_SETTINGS_SELECTOR_RELATIVE_PATH = "dist/modes/interactive/components/settings-selector.js";
const PI_ASSISTANT_MESSAGE_RELATIVE_PATH = "dist/modes/interactive/components/assistant-message.js";
const PI_TOOL_EXECUTION_RELATIVE_PATH = "dist/modes/interactive/components/tool-execution.js";
const PI_THEME_RELATIVE_PATH = "dist/modes/interactive/theme/theme.js";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface ModelMetadata {
  id: string;
  name: string;
  reasoning?: boolean;
}

interface Provider {
  models: ModelMetadata[];
}

interface ModelsFile {
  providers: Record<string, Provider>;
}

interface SettingsFile {
  enabledModels?: string[];
  autoModelSelectionEnabled?: boolean;
}

interface SettingsListItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];
}

interface SettingsListLike {
  items: SettingsListItem[];
  filteredItems: SettingsListItem[];
  onChange: (id: string, newValue: string) => void;
  updateValue?: (id: string, newValue: string) => void;
}

async function readSettingsFile(filePath: string): Promise<SettingsFile | null> {
  try {
    const data = await readFile(filePath, "utf8");
    return JSON.parse(data) as SettingsFile;
  } catch {
    return null;
  }
}

async function getSettings(): Promise<SettingsFile> {
  return (await readSettingsFile(SETTINGS_CONFIG_PATH)) ||
         (await readSettingsFile(SETTINGS_PATH)) ||
         {};
}

export function isAutoModelSelectionEnabled(settings: SettingsFile): boolean {
  return settings.autoModelSelectionEnabled ?? true;
}

let autoModelSelectionEnabledCache: boolean | undefined;
let sessionAutoModelSelectionEnabled: boolean | undefined;
let autoModelSettingsWatcher: FSWatcher | undefined;
let autoModelSettingsWatchTimer: ReturnType<typeof setTimeout> | undefined;

async function refreshAutoModelSelectionEnabledCache(): Promise<boolean> {
  const settings = await getSettings();
  const enabled = isAutoModelSelectionEnabled(settings);
  autoModelSelectionEnabledCache = enabled;
  return enabled;
}

async function getCurrentSessionAutoModelSelectionEnabled(): Promise<boolean> {
  if (sessionAutoModelSelectionEnabled !== undefined) return sessionAutoModelSelectionEnabled;
  if (autoModelSelectionEnabledCache !== undefined) return autoModelSelectionEnabledCache;
  return refreshAutoModelSelectionEnabledCache();
}

function setCurrentSessionAutoModelSelectionEnabled(enabled: boolean): void {
  sessionAutoModelSelectionEnabled = enabled;
}

function renderAutoModelSessionStatus(theme: { fg: (color: string, text: string) => string }, enabled: boolean): string {
  const dot = theme.fg(enabled ? "success" : "warning", enabled ? "●" : "○");
  const label = theme.fg("dim", " Auto");
  return dot + label;
}

let requestAutoModelFooterRender: (() => void) | undefined;

function installAutoModelFooter(
  ui: {
    setFooter?: (factory?: ((tui: { requestRender: () => void }, theme: {
      fg: (color: string, text: string) => string;
    }, footerData: {
      getGitBranch: () => string | null;
      getExtensionStatuses: () => ReadonlyMap<string, string>;
      getAvailableProviderCount: () => number;
      onBranchChange: (listener: () => void) => (() => void) | void;
    }) => {
      render: (width: number) => string[];
      invalidate: () => void;
      dispose?: () => void;
    })) => void;
    setStatus?: (id: string, status?: string) => void;
  } | undefined,
  ctx: {
    sessionManager: {
      getEntries: () => Array<any>;
      getCwd: () => string;
      getSessionName: () => string | undefined;
    };
    getContextUsage?: () => { contextWindow?: number; percent?: number | null } | undefined;
    model?: { id: string; provider: string; contextWindow?: number; reasoning?: boolean };
  },
  pi: ExtensionAPI,
): void {
  ui?.setStatus?.("auto-model-selection", undefined);
  ui?.setFooter?.((tui, theme, footerData) => {
    const requestRender = () => tui.requestRender();
    requestAutoModelFooterRender = requestRender;
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

    const formatTokens = (count: number): string => {
      if (count < 1000) return count.toString();
      if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
      if (count < 1000000) return `${Math.round(count / 1000)}k`;
      if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
      return `${Math.round(count / 1000000)}M`;
    };

    return {
      dispose: () => {
        if (requestAutoModelFooterRender === requestRender) {
          requestAutoModelFooterRender = undefined;
        }
        unsubscribe?.();
      },
      invalidate() {},
      render(width: number): string[] {
        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRead = 0;
        let totalCacheWrite = 0;
        let totalCost = 0;

        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            totalInput += entry.message.usage.input;
            totalOutput += entry.message.usage.output;
            totalCacheRead += entry.message.usage.cacheRead;
            totalCacheWrite += entry.message.usage.cacheWrite;
            totalCost += entry.message.usage.cost.total;
          }
        }

        const contextUsage = ctx.getContextUsage?.();
        const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

        let pwd = ctx.sessionManager.getCwd();
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && pwd.startsWith(home)) {
          pwd = `~${pwd.slice(home.length)}`;
        }

        const branch = footerData.getGitBranch();
        if (branch) {
          pwd = `${pwd} (${branch})`;
        }

        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) {
          pwd = `${pwd} • ${sessionName}`;
        }

        const statsParts = [];
        if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
        if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
        if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
        if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
        if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);

        const contextPercentDisplay =
          contextPercent === "?"
            ? `?/${formatTokens(contextWindow)}`
            : `${contextPercent}%/${formatTokens(contextWindow)}`;
        const contextPercentStr = contextPercentValue > 90
          ? theme.fg("error", contextPercentDisplay)
          : contextPercentValue > 70
            ? theme.fg("warning", contextPercentDisplay)
            : contextPercentDisplay;
        statsParts.push(contextPercentStr);

        const statsLeft = statsParts.join(" ");
        const autoEnabled = sessionAutoModelSelectionEnabled ?? autoModelSelectionEnabledCache ?? true;
        const autoStatus = renderAutoModelSessionStatus(theme, autoEnabled);
        const modelName = ctx.model?.id || "no-model";
        const thinkingText = pi.getThinkingLevel() === "off" ? "off" : pi.getThinkingLevel();
        const providerText = ctx.model ? `(${ctx.model.provider}) ` : "";
        const modelText = ctx.model?.reasoning
          ? `${providerText}${modelName} • ${thinkingText}`
          : `${providerText}${modelName}`;
        const rightSide = `${autoStatus}${theme.fg("dim", ` • ${modelText}`)}`;

        const statsLeftWidth = visibleWidth(statsLeft);
        const rightSideWidth = visibleWidth(rightSide);
        const minPadding = 2;
        const paddingWidth = Math.max(minPadding, width - statsLeftWidth - rightSideWidth);
        const statsLine = truncateToWidth(
          theme.fg("dim", statsLeft) + " ".repeat(paddingWidth) + rightSide,
          width,
          theme.fg("dim", "..."),
        );

        const lines = [
          truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
          statsLine,
        ];

        const extensionStatuses = Array.from(footerData.getExtensionStatuses().entries())
          .filter(([id]) => id !== "auto-model-selection")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
          .filter(Boolean);
        if (extensionStatuses.length > 0) {
          lines.push(truncateToWidth(extensionStatuses.join(" "), width, theme.fg("dim", "...")));
        }

        return lines;
      },
    };
  });
}

function clearAutoModelFooter(ui: {
  setFooter?: (factory?: undefined) => void;
  setStatus?: (id: string, status?: string) => void;
} | undefined): void {
  requestAutoModelFooterRender = undefined;
  ui?.setStatus?.("auto-model-selection", undefined);
  ui?.setFooter?.(undefined);
}

function startAutoModelSettingsWatcher(): void {
  if (autoModelSettingsWatcher) return;

  autoModelSettingsWatcher = watch(SETTINGS_CONFIG_PATH, () => {
    if (autoModelSettingsWatchTimer) clearTimeout(autoModelSettingsWatchTimer);
    autoModelSettingsWatchTimer = setTimeout(() => {
      autoModelSettingsWatchTimer = undefined;
      void refreshAutoModelSelectionEnabledCache();
    }, 50);
  });
}

function stopAutoModelSettingsWatcher(): void {
  if (autoModelSettingsWatchTimer) {
    clearTimeout(autoModelSettingsWatchTimer);
    autoModelSettingsWatchTimer = undefined;
  }
  autoModelSettingsWatcher?.close();
  autoModelSettingsWatcher = undefined;
}

async function setAutoModelSelectionEnabled(enabled: boolean): Promise<void> {
  autoModelSelectionEnabledCache = enabled;
  const settings = await getSettings();
  settings.autoModelSelectionEnabled = enabled;
  await writeFile(SETTINGS_CONFIG_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  try {
    await execFile(MERGE_SETTINGS_SCRIPT_PATH);
  } catch (error) {
    console.error("Failed to merge settings after auto model update:", error);
  }
}

export function addAutoModelSettingToSettingsList(
  settingsList: SettingsListLike,
  enabled: boolean,
  onToggle: (enabled: boolean) => void | Promise<void>,
): void {
  const item: SettingsListItem = {
    id: "auto-model-selection",
    label: "Auto model selection",
    description: "Automatically switch models before each turn based on the current prompt",
    currentValue: enabled ? "true" : "false",
    values: ["true", "false"],
  };

  const existingIndex = settingsList.items.findIndex((entry) => entry.id === item.id);
  if (existingIndex !== -1) {
    settingsList.updateValue?.(item.id, item.currentValue);
    return;
  }

  const insertAt = (() => {
    const thinkingIndex = settingsList.items.findIndex((entry) => entry.id === "thinking");
    if (thinkingIndex !== -1) return thinkingIndex + 1;
    const transportIndex = settingsList.items.findIndex((entry) => entry.id === "transport");
    if (transportIndex !== -1) return transportIndex + 1;
    return settingsList.items.length;
  })();

  settingsList.items.splice(insertAt, 0, item);
  settingsList.filteredItems = settingsList.items;

  const originalOnChange = settingsList.onChange;
  settingsList.onChange = (id, newValue) => {
    if (id === item.id) {
      void onToggle(newValue === "true");
      return;
    }
    originalOnChange(id, newValue);
  };
}

let settingsMenuPatchPromise: Promise<void> | undefined;

function patchBuiltInSettingsMenu(): Promise<void> {
  if (!settingsMenuPatchPromise) {
    settingsMenuPatchPromise = (async () => {
      const [interactiveModeModule, settingsSelectorModule, assistantMessageModule, toolExecutionModule, themeModule] = await Promise.all([
        importPiModule(PI_INTERACTIVE_MODE_RELATIVE_PATH),
        importPiModule(PI_SETTINGS_SELECTOR_RELATIVE_PATH),
        importPiModule(PI_ASSISTANT_MESSAGE_RELATIVE_PATH),
        importPiModule(PI_TOOL_EXECUTION_RELATIVE_PATH),
        importPiModule(PI_THEME_RELATIVE_PATH),
      ]);

      const InteractiveMode = interactiveModeModule.InteractiveMode as {
        prototype: Record<string, unknown> & { showSettingsSelector?: () => void; __autoModelSettingsPatched?: boolean };
      };
      const SettingsSelectorComponent = settingsSelectorModule.SettingsSelectorComponent as new (config: Record<string, unknown>, callbacks: Record<string, unknown>) => { getSettingsList: () => SettingsListLike };
      const AssistantMessageComponent = assistantMessageModule.AssistantMessageComponent as new (...args: never[]) => object;
      const ToolExecutionComponent = toolExecutionModule.ToolExecutionComponent as new (...args: never[]) => object;
      const getAvailableThemes = themeModule.getAvailableThemes as () => string[];
      const setTheme = themeModule.setTheme as (themeName: string, preview?: boolean) => { success: boolean; error?: string };

      if (InteractiveMode.prototype.__autoModelSettingsPatched) return;
      InteractiveMode.prototype.__autoModelSettingsPatched = true;

      InteractiveMode.prototype.showSettingsSelector = function showSettingsSelector(this: any) {
        this.showSelector((done: () => void) => {
          const selector = new SettingsSelectorComponent({
            autoCompact: this.session.autoCompactionEnabled,
            showImages: this.settingsManager.getShowImages(),
            autoResizeImages: this.settingsManager.getImageAutoResize(),
            blockImages: this.settingsManager.getBlockImages(),
            enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
            steeringMode: this.session.steeringMode,
            followUpMode: this.session.followUpMode,
            transport: this.settingsManager.getTransport(),
            thinkingLevel: this.session.thinkingLevel,
            availableThinkingLevels: this.session.getAvailableThinkingLevels(),
            currentTheme: this.settingsManager.getTheme() || "dark",
            availableThemes: getAvailableThemes(),
            hideThinkingBlock: this.hideThinkingBlock,
            collapseChangelog: this.settingsManager.getCollapseChangelog(),
            enableInstallTelemetry: this.settingsManager.getEnableInstallTelemetry(),
            doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
            treeFilterMode: this.settingsManager.getTreeFilterMode(),
            showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
            editorPaddingX: this.settingsManager.getEditorPaddingX(),
            autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
            quietStartup: this.settingsManager.getQuietStartup(),
            clearOnShrink: this.settingsManager.getClearOnShrink(),
          }, {
            onAutoCompactChange: (enabled: boolean) => {
              this.session.setAutoCompactionEnabled(enabled);
              this.footer.setAutoCompactEnabled(enabled);
            },
            onShowImagesChange: (enabled: boolean) => {
              this.settingsManager.setShowImages(enabled);
              for (const child of this.chatContainer.children) {
                if (child instanceof ToolExecutionComponent) {
                  child.setShowImages(enabled);
                }
              }
            },
            onAutoResizeImagesChange: (enabled: boolean) => {
              this.settingsManager.setImageAutoResize(enabled);
            },
            onBlockImagesChange: (blocked: boolean) => {
              this.settingsManager.setBlockImages(blocked);
            },
            onEnableSkillCommandsChange: (enabled: boolean) => {
              this.settingsManager.setEnableSkillCommands(enabled);
              this.setupAutocomplete(this.fdPath);
            },
            onSteeringModeChange: (mode: "all" | "one-at-a-time") => {
              this.session.setSteeringMode(mode);
            },
            onFollowUpModeChange: (mode: "all" | "one-at-a-time") => {
              this.session.setFollowUpMode(mode);
            },
            onTransportChange: (transport: string) => {
              this.settingsManager.setTransport(transport);
              this.session.agent.transport = transport;
            },
            onThinkingLevelChange: (level: string) => {
              this.session.setThinkingLevel(level);
              this.footer.invalidate();
              this.updateEditorBorderColor();
            },
            onThemeChange: (themeName: string) => {
              const result = setTheme(themeName, true);
              this.settingsManager.setTheme(themeName);
              this.ui.invalidate();
              if (!result.success) {
                this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
              }
            },
            onThemePreview: (themeName: string) => {
              const result = setTheme(themeName, true);
              if (result.success) {
                this.ui.invalidate();
                this.ui.requestRender();
              }
            },
            onHideThinkingBlockChange: (hidden: boolean) => {
              this.hideThinkingBlock = hidden;
              this.settingsManager.setHideThinkingBlock(hidden);
              for (const child of this.chatContainer.children) {
                if (child instanceof AssistantMessageComponent) {
                  child.setHideThinkingBlock(hidden);
                }
              }
              this.chatContainer.clear();
              this.rebuildChatFromMessages();
            },
            onCollapseChangelogChange: (collapsed: boolean) => {
              this.settingsManager.setCollapseChangelog(collapsed);
            },
            onEnableInstallTelemetryChange: (enabled: boolean) => {
              this.settingsManager.setEnableInstallTelemetry(enabled);
            },
            onQuietStartupChange: (enabled: boolean) => {
              this.settingsManager.setQuietStartup(enabled);
            },
            onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => {
              this.settingsManager.setDoubleEscapeAction(action);
            },
            onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => {
              this.settingsManager.setTreeFilterMode(mode);
            },
            onShowHardwareCursorChange: (enabled: boolean) => {
              this.settingsManager.setShowHardwareCursor(enabled);
              this.ui.setShowHardwareCursor(enabled);
            },
            onEditorPaddingXChange: (padding: number) => {
              this.settingsManager.setEditorPaddingX(padding);
              this.defaultEditor.setPaddingX(padding);
              if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
                this.editor.setPaddingX(padding);
              }
            },
            onAutocompleteMaxVisibleChange: (maxVisible: number) => {
              this.settingsManager.setAutocompleteMaxVisible(maxVisible);
              this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
              if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
                this.editor.setAutocompleteMaxVisible(maxVisible);
              }
            },
            onClearOnShrinkChange: (enabled: boolean) => {
              this.settingsManager.setClearOnShrink(enabled);
              this.ui.setClearOnShrink(enabled);
            },
            onCancel: () => {
              done();
              this.ui.requestRender();
            },
          });

          addAutoModelSettingToSettingsList(
            selector.getSettingsList(),
            autoModelSelectionEnabledCache ??
              isAutoModelSelectionEnabled(this.settingsManager.settings ?? {}),
            async (enabled) => {
              autoModelSelectionEnabledCache = enabled;
              if (this.settingsManager.settings) {
                this.settingsManager.settings.autoModelSelectionEnabled = enabled;
              }
              await setAutoModelSelectionEnabled(enabled);
            },
          );

          return { component: selector, focus: selector.getSettingsList() };
        });
      };
    })().catch((error) => {
      console.error("Failed to patch pi settings menu for auto model selection:", error);
    });
  }

  return settingsMenuPatchPromise;
}

function splitModelId(fullId: string): { provider: string; modelId: string } | null {
  const [provider, ...rest] = fullId.split("/");
  const modelId = rest.join("/");
  if (!provider || !modelId) return null;
  return { provider, modelId };
}

async function switchToModel(
  pi: ExtensionAPI,
  ctx: {
    model?: { provider: string; id: string };
    modelRegistry: { find: (provider: string, modelId: string) => unknown };
    ui?: { notify: (message: string, level: "info" | "warning" | "error" | "success") => void };
  },
  selectedId: string,
  options?: { notifyOnSwitch?: boolean; notifyOnFailure?: boolean },
): Promise<{ switched: boolean; success: boolean }> {
  const parts = splitModelId(selectedId);
  if (!parts) return { switched: false, success: false };

  if (ctx.model?.provider === parts.provider && ctx.model?.id === parts.modelId) {
    return { switched: false, success: true };
  }

  const model = ctx.modelRegistry.find(parts.provider, parts.modelId);
  if (!model) {
    if (options?.notifyOnFailure && ctx.ui) {
      ctx.ui.notify(`Auto model selection: model not found: ${selectedId}`, "warning");
    }
    return { switched: false, success: false };
  }

  const success = await pi.setModel(model as never);
  if (!success) {
    if (options?.notifyOnFailure && ctx.ui) {
      ctx.ui.notify(`Auto model selection: no API key for ${selectedId}`, "warning");
    }
    return { switched: false, success: false };
  }

  if (options?.notifyOnSwitch && ctx.ui) {
    ctx.ui.notify(`Auto-switched model to ${selectedId}`, "info");
  }

  return { switched: true, success: true };
}

async function getEnabledModelsMetadata(): Promise<ModelMetadata[]> {
  try {
    const [modelsData, settingsFile] = await Promise.all([
      readFile(MODELS_PATH, "utf8"),
      getSettings(),
    ]);

    const modelsFile = JSON.parse(modelsData) as ModelsFile;

    const enabledModelIds = settingsFile.enabledModels || [];
    const allMetadata: ModelMetadata[] = [];

    for (const [providerId, provider] of Object.entries(modelsFile.providers)) {
      for (const model of provider.models) {
        const fullId = `${providerId}/${model.id}`;
        if (enabledModelIds.includes(fullId)) {
          allMetadata.push({ ...model, id: fullId });
        }
      }
    }

    // Add models that might be enabled but not in models.json (e.g. built-ins)
    for (const enabledId of enabledModelIds) {
      if (!allMetadata.find((m) => m.id === enabledId)) {
        allMetadata.push({ id: enabledId, name: enabledId.split("/")[1] || enabledId });
      }
    }

    return allMetadata;
  } catch (error) {
    console.error("Error reading models or settings:", error);
    return [];
  }
}

export function estimateReasoningEffort(task: string): ThinkingLevel {
  const taskLower = task.toLowerCase();

  if (/architecture|architectural|design doc|migration plan|deep analysis|root cause|formal proof|multi-step|system design|tradeoff/i.test(taskLower)) {
    return "xhigh";
  }

  if (/complex|reasoning|difficult|deep|think|analyze|debug|investigate|compare|evaluate/i.test(taskLower)) {
    return "high";
  }

  if (/implement|plan|review|refactor|test strategy|explain why|walk through/i.test(taskLower)) {
    return "medium";
  }

  if (/quick|simple|brief|summarize|short/i.test(taskLower)) {
    return "low";
  }

  return "medium";
}

export function selectModel(task: string, models: ModelMetadata[]): string {
  const taskLower = task.toLowerCase();

  const isComplex = /reasoning|complex|architecture|design|debug|difficult|deep|think|analyze/i.test(taskLower);
  const isCoding = /code|refactor|implement|fix|test|script|function|class|method/i.test(taskLower);
  const isLightweight = /summarize|list|read|check|status|short|quick|simple|hello|ping/i.test(taskLower);

  // 1. If complex/reasoning, look for models with reasoning: true or known high-end models
  if (isComplex) {
    const reasoningModel = models.find((m) => m.reasoning) ||
                           models.find((m) => m.id.includes("opus") || m.id.includes("gpt-5") || m.id.includes("120b"));
    if (reasoningModel) return reasoningModel.id;
  }

  // 2. If coding, look for coder-specific models
  if (isCoding) {
    const coderModel = models.find((m) => m.id.toLowerCase().includes("coder")) ||
                       models.find((m) => m.id.includes("sonnet") || m.id.includes("gpt-5"));
    if (coderModel) return coderModel.id;
  }

  // 3. If lightweight, look for flash or small models
  if (isLightweight) {
    const flashModel = models.find((m) => m.id.includes("flash")) ||
                       models.find((m) => m.id.includes("gemma") || m.id.includes("haiku"));
    if (flashModel) return flashModel.id;
  }

  // 4. Default/Balanced: Prefer Pro or high-tier general models
  const balancedModel = models.find((m) => m.id.includes("pro-high")) ||
                        models.find((m) => m.id.includes("sonnet")) ||
                        models[0];

  return balancedModel?.id || models[0]?.id || "unknown";
}

export default function autoModelSelectionExtension(pi: ExtensionAPI) {
  void patchBuiltInSettingsMenu();

  pi.on("session_start", async (_event, ctx) => {
    sessionAutoModelSelectionEnabled = undefined;
    await refreshAutoModelSelectionEnabledCache();
    installAutoModelFooter(ctx.ui, ctx, pi);
    startAutoModelSettingsWatcher();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearAutoModelFooter(ctx.ui);
    sessionAutoModelSelectionEnabled = undefined;
    stopAutoModelSettingsWatcher();
  });

  pi.on("model_select", () => {
    requestAutoModelFooterRender?.();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!await getCurrentSessionAutoModelSelectionEnabled()) return;

    const models = await getHealthyEnabledModels(await getEnabledModelsMetadata());
    if (models.length === 0) return;

    const task = event.prompt || "general task";
    const selectedId = selectModel(task, models);
    const selectedModel = models.find((model) => model.id === selectedId);
    await switchToModel(pi, ctx, selectedId, {
      notifyOnSwitch: true,
      notifyOnFailure: true,
    });

    if (selectedModel?.reasoning) {
      pi.setThinkingLevel(estimateReasoningEffort(task));
    }
  });

  pi.registerTool({
    name: "select_best_model",
    label: "Auto Model",
    description: "Automatically selects the best model from the available scoped models for a given task description.",
    parameters: Type.Object({
      task_description: Type.String({
        description: "A description of the task to be performed."
      })
    }),
    async execute(_toolCallId, params: { task_description: string }) {
      const models = await getEnabledModelsMetadata();
      if (models.length === 0) {
        throw new Error("No enabled models found in settings.");
      }

      const selectedId = selectModel(params.task_description, models);
      const modelInfo = models.find(m => m.id === selectedId);
      const reasoningEffort = modelInfo?.reasoning ? estimateReasoningEffort(params.task_description) : undefined;

      return {
        content: [{
          type: "text",
          text: `Recommended model for this task: **${selectedId}**${modelInfo?.reasoning ? ` (Reasoning: ${reasoningEffort})` : ""}`
        }],
        details: {
          task: params.task_description,
          modelId: selectedId,
          reasoning: modelInfo?.reasoning || false,
          reasoningEffort,
        }
      };
    }
  });

  pi.registerCommand?.("auto-model", {
    description: "Toggle automatic model selection on or off",
    handler: async (args, ctx) => {
      const action = (args || "toggle").trim().toLowerCase();
      const defaultEnabled = await refreshAutoModelSelectionEnabledCache();
      const currentEnabled = sessionAutoModelSelectionEnabled ?? defaultEnabled;

      if (action === "status") {
        ctx.ui.notify(
          `Auto model selection is ${currentEnabled ? "ON" : "OFF"} for this session (default for new sessions: ${defaultEnabled ? "ON" : "OFF"})`,
          "info",
        );
        return;
      }

      let nextEnabled: boolean;
      if (action === "toggle") {
        nextEnabled = !currentEnabled;
      } else if (action === "on") {
        nextEnabled = true;
      } else if (action === "off") {
        nextEnabled = false;
      } else {
        ctx.ui.notify("Usage: /auto-model [on|off|status]", "warning");
        return;
      }

      setCurrentSessionAutoModelSelectionEnabled(nextEnabled);
      requestAutoModelFooterRender?.();
      ctx.ui.notify(
        `Auto model selection ${nextEnabled ? "enabled" : "disabled"} for this session only`,
        "info",
      );
    }
  });
}
