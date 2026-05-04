import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Container, matchesKey, SelectList, Spacer, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { importPiModule } from "./packages/pi-package.ts";
import { notifyPiWaitingForUser } from "./native-notify.ts";

const MAX_PROGRAMS_TO_SHOW = 12;
const SETTINGS_CONFIG_PATH = resolve(import.meta.dirname, "../settings.config.json");
const SETTINGS_PATH = resolve(import.meta.dirname, "../settings.json");
const MERGE_SETTINGS_SCRIPT_PATH = resolve(import.meta.dirname, "../scripts/merge-settings.sh");
const PI_INTERACTIVE_MODE_RELATIVE_PATH = "dist/modes/interactive/interactive-mode.js";
const PI_FOOTER_COMPONENT_RELATIVE_PATH = "dist/modes/interactive/components/footer.js";
const PI_SETTINGS_SELECTOR_RELATIVE_PATH = "dist/modes/interactive/components/settings-selector.js";
const PI_THEME_RELATIVE_PATH = "dist/modes/interactive/theme/theme.js";
const execFile = promisify(execFileCallback);

type ManagingStyle = "Micromanagement" | "Guidance" | "Empowerment";

interface SettingsFile {
  managingStyle?: ManagingStyle;
  [key: string]: unknown;
}

interface SettingsListItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];
  submenu?: (currentValue: string, done: (newValue?: string) => void) => unknown;
}

interface SettingsListLike {
  items: SettingsListItem[];
  filteredItems: SettingsListItem[];
  onChange: (id: string, newValue: string) => void;
  updateValue?: (id: string, newValue: string) => void;
}

const MANAGING_STYLE_VALUES: ManagingStyle[] = ["Micromanagement", "Guidance", "Empowerment"];
const DEFAULT_MANAGING_STYLE: ManagingStyle = "Micromanagement";
const MANAGING_STYLE_DESCRIPTIONS: Record<ManagingStyle, string> = {
  Micromanagement: "Ask before every bash command, write, and edit",
  Guidance: "Allow local read-only checks; ask before file changes and risky commands",
  Empowerment: "Allow in-folder writes/edits and checks; ask before risky commands",
};
const MANAGING_STYLE_STATUS_LABELS: Record<ManagingStyle, string> = {
  Micromanagement: "Micromanaging",
  Guidance: "Guiding",
  Empowerment: "Empowering",
};
const MANAGING_STYLE_STATUS_ICONS: Record<ManagingStyle, string> = {
  Micromanagement: "●",
  Guidance: "◆",
  Empowerment: "▲",
};
const MANAGING_STYLE_STATUS_ID = "management-style";

function isManagingStyle(value: unknown): value is ManagingStyle {
  return typeof value === "string" && MANAGING_STYLE_VALUES.includes(value as ManagingStyle);
}

function normalizeManagingStyle(value: unknown): ManagingStyle {
  return isManagingStyle(value) ? value : DEFAULT_MANAGING_STYLE;
}

async function readSettingsFile(filePath: string): Promise<SettingsFile | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as SettingsFile;
  }
  catch {
    return null;
  }
}

async function getSettings(): Promise<SettingsFile> {
  return (await readSettingsFile(SETTINGS_CONFIG_PATH))
    || (await readSettingsFile(SETTINGS_PATH))
    || {};
}

let managingStyleCache: ManagingStyle | undefined;
let sessionManagingStyle: ManagingStyle | undefined;

export async function refreshManagingStyleCache(): Promise<ManagingStyle> {
  const settings = await getSettings();
  const style = normalizeManagingStyle(settings.managingStyle);
  managingStyleCache = style;
  return style;
}

async function getCurrentManagingStyle(): Promise<ManagingStyle> {
  if (sessionManagingStyle !== undefined) return sessionManagingStyle;
  return refreshManagingStyleCache();
}

function getNextManagingStyle(style: ManagingStyle): ManagingStyle {
  const currentIndex = MANAGING_STYLE_VALUES.indexOf(style);
  return MANAGING_STYLE_VALUES[(currentIndex + 1) % MANAGING_STYLE_VALUES.length] ?? DEFAULT_MANAGING_STYLE;
}

function getPreviousManagingStyle(style: ManagingStyle): ManagingStyle {
  const currentIndex = MANAGING_STYLE_VALUES.indexOf(style);
  return MANAGING_STYLE_VALUES[(currentIndex - 1 + MANAGING_STYLE_VALUES.length) % MANAGING_STYLE_VALUES.length] ?? DEFAULT_MANAGING_STYLE;
}

function setSessionManagingStyle(style: ManagingStyle) {
  sessionManagingStyle = style;
  updateManagingStyleStatus(activeManagingStyleUi, style);
}

export function isShiftCtrlSemicolonFallbackInput(data: string) {
  // Some terminals report physical Shift+Ctrl+; as Ctrl+: because Shift+; is ':'.
  return matchesKey(data, "ctrl+:") || matchesKey(data, "shift+ctrl+:");
}

async function cycleSessionManagingStyle(
  direction: "forward" | "backward",
  ctx: { ui?: { notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void; setStatus?: (id: string, status?: string) => void } },
) {
  activeManagingStyleUi = ctx.ui;
  const currentStyle = await getCurrentManagingStyle();
  const nextStyle = direction === "forward" ? getNextManagingStyle(currentStyle) : getPreviousManagingStyle(currentStyle);
  setSessionManagingStyle(nextStyle);
  ctx.ui?.notify?.(`Management style: ${MANAGING_STYLE_STATUS_LABELS[nextStyle]} (session only)`, "info");
}

function getManagingStyleStatusColor(style: ManagingStyle) {
  if (style === "Micromanagement") return UI_PALETTE.danger;
  if (style === "Guidance") return UI_PALETTE.warning;
  return UI_PALETTE.primaryAction;
}

function formatManagingStyleStatus(style: ManagingStyle) {
  return `${colorize(MANAGING_STYLE_STATUS_ICONS[style], getManagingStyleStatusColor(style))}${colorize(` ${MANAGING_STYLE_STATUS_LABELS[style]}`, UI_PALETTE.hint)}`;
}

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function rightAlignManagingStyleStatus(line: string, width: number, fallback: string) {
  if (!activeManagingStyleDisplay) return line;

  const gap = 2;
  const statusWidth = visibleWidth(activeManagingStyleDisplay);
  const availableLineWidth = Math.max(0, width - statusWidth - gap);
  const left = truncateToWidth(line, availableLineWidth, fallback);
  const padding = Math.max(gap, width - visibleWidth(left) - statusWidth);
  return `${left}${" ".repeat(padding)}${activeManagingStyleDisplay}`;
}

function removeManagingStyleStatusLine(lines: string[]) {
  if (!activeManagingStyleDisplay) return lines;

  const activePlain = stripAnsi(activeManagingStyleDisplay).trim();
  return lines.flatMap((line, index) => {
    if (index < 2) return [line];

    const plainLine = stripAnsi(line);
    if (!plainLine.includes(activePlain)) return [line];

    const cleaned = plainLine.replace(activePlain, "").replace(/\s+/g, " ").trim();
    return cleaned ? [cleaned] : [];
  });
}

function updateManagingStyleStatus(ui: { setStatus?: (id: string, status?: string) => void } | undefined, style: ManagingStyle) {
  activeManagingStyleDisplay = formatManagingStyleStatus(style);
  ui?.setStatus?.(MANAGING_STYLE_STATUS_ID, activeManagingStyleDisplay);
  requestManagingStyleFooterRender?.();
}

function clearManagingStyleStatus(ui: { setStatus?: (id: string, status?: string) => void } | undefined) {
  activeManagingStyleDisplay = "";
  ui?.setStatus?.(MANAGING_STYLE_STATUS_ID, undefined);
  requestManagingStyleFooterRender?.();
}

function wrapManagingStyleFooterComponent(footer: { render?: (width: number) => string[]; [PATCHED_FOOTER_COMPONENT]?: boolean } | undefined) {
  if (!footer?.render || footer[PATCHED_FOOTER_COMPONENT]) return;

  const originalRender = footer.render.bind(footer);
  footer[PATCHED_FOOTER_COMPONENT] = true;
  footer.render = (width: number) => {
    const lines = removeManagingStyleStatusLine(originalRender(width));
    if (lines[0] !== undefined) {
      lines[0] = rightAlignManagingStyleStatus(lines[0], width, colorize("...", UI_PALETTE.hint));
    }
    return lines;
  };
}

function wrapExistingUiFooter(ui: ({ children?: unknown[] } & Record<string, unknown>) | undefined) {
  const children = ui?.children;
  if (!Array.isArray(children)) return;

  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index] as { render?: (width: number) => string[]; [PATCHED_FOOTER_COMPONENT]?: boolean } | undefined;
    if (typeof child?.render === "function") {
      wrapManagingStyleFooterComponent(child);
      return;
    }
  }
}

function wrapInteractiveModeFooter(instance: unknown) {
  const candidate = instance as {
    customFooter?: { render?: (width: number) => string[]; [PATCHED_FOOTER_COMPONENT]?: boolean };
    footer?: { render?: (width: number) => string[]; [PATCHED_FOOTER_COMPONENT]?: boolean };
    ui?: { children?: unknown[] } & Record<string, unknown>;
  };

  wrapManagingStyleFooterComponent(candidate.customFooter ?? candidate.footer);
  wrapExistingUiFooter(candidate.ui);
}

function wrapManagingStyleFooterFactory(factory: unknown) {
  if (typeof factory !== "function") return factory;

  return (tui: { requestRender: () => void }, theme: { fg: (color: string, text: string) => string }, footerData: unknown) => {
    const requestRender = () => tui.requestRender();
    requestManagingStyleFooterRender = requestRender;
    const wrappedFooterData = typeof footerData === "object" && footerData !== null && "getExtensionStatuses" in footerData
      ? new Proxy(footerData as object, {
          get(target, property, receiver) {
            if (property === "getExtensionStatuses") {
              return () => {
                const statuses = (target as { getExtensionStatuses: () => ReadonlyMap<string, string> }).getExtensionStatuses();
                const filtered = new Map(statuses);
                filtered.delete(MANAGING_STYLE_STATUS_ID);
                return filtered;
              };
            }

            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : footerData;
    const footer = (factory as (tui: unknown, theme: unknown, footerData: unknown) => { render: (width: number) => string[]; dispose?: () => void; [key: string]: unknown })(tui, theme, wrappedFooterData);
    return {
      ...footer,
      dispose() {
        if (requestManagingStyleFooterRender === requestRender) requestManagingStyleFooterRender = undefined;
        footer.dispose?.();
      },
      render(width: number) {
        const lines = removeManagingStyleStatusLine(footer.render(width));
        if (lines[0] !== undefined) {
          lines[0] = rightAlignManagingStyleStatus(lines[0], width, theme.fg("dim", "..."));
        }
        return lines;
      },
    };
  };
}

function patchUiFooter(ui: ({ setFooter?: (factory?: unknown) => void; [PATCHED_UI_FOOTER]?: boolean } & Record<string, unknown>) | undefined) {
  if (!ui?.setFooter || ui[PATCHED_UI_FOOTER]) return;

  const originalSetFooter = ui.setFooter.bind(ui);
  ui[PATCHED_UI_FOOTER] = true;
  ui.setFooter = (factory?: unknown) => {
    if (typeof factory !== "function") requestManagingStyleFooterRender = undefined;
    originalSetFooter(wrapManagingStyleFooterFactory(factory));
    wrapExistingUiFooter(ui);
  };

  wrapExistingUiFooter(ui);
}

async function setManagingStyle(style: ManagingStyle): Promise<void> {
  managingStyleCache = style;
  const settings = await getSettings();
  settings.managingStyle = style;
  await writeFile(SETTINGS_CONFIG_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  try {
    await execFile(MERGE_SETTINGS_SCRIPT_PATH);
  }
  catch (error) {
    console.error("Failed to merge settings after managing style update:", error);
  }
}

type SettingsThemeModule = {
  theme: {
    fg: (color: string, text: string) => string;
    bold: (text: string) => string;
  };
  getSelectListTheme: () => unknown;
};

const MANAGEMENT_STYLE_SUBMENU_SELECT_LIST_LAYOUT = {
  minPrimaryColumnWidth: 16,
  maxPrimaryColumnWidth: 24,
};

let activeManagingStyleUi: { setStatus?: (id: string, status?: string) => void } | undefined;
let activeManagingStyleDisplay = "";
let requestManagingStyleFooterRender: (() => void) | undefined;
const PATCHED_UI_FOOTER = Symbol("managementStyleUiFooterPatched");
const PATCHED_FOOTER_COMPONENT = Symbol("managementStyleFooterComponentPatched");

class ManagingStyleSubmenu extends Container {
  private selectList: { handleInput: (data: Buffer) => void; onSelect?: (item: { value: ManagingStyle }) => void; onCancel?: () => void; setSelectedIndex?: (index: number) => void };

  constructor(
    themeModule: SettingsThemeModule,
    currentValue: string,
    onSelect: (style: ManagingStyle) => void | Promise<void>,
    onCancel: () => void,
  ) {
    super();

    const { theme } = themeModule;
    this.addChild(new Text(theme.bold(theme.fg("accent", "Management style")), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("muted", "Select how much approval Pi needs before acting"), 0, 0));
    this.addChild(new Spacer(1));

    const options = MANAGING_STYLE_VALUES.map((style) => ({
      value: style,
      label: style,
      description: MANAGING_STYLE_DESCRIPTIONS[style],
    }));
    this.selectList = new SelectList(
      options,
      Math.min(options.length, 10),
      themeModule.getSelectListTheme(),
      MANAGEMENT_STYLE_SUBMENU_SELECT_LIST_LAYOUT,
    ) as typeof this.selectList;

    const currentIndex = options.findIndex((option) => option.value === normalizeManagingStyle(currentValue));
    if (currentIndex !== -1) this.selectList.setSelectedIndex?.(currentIndex);

    this.selectList.onSelect = (item) => {
      void onSelect(item.value);
    };
    this.selectList.onCancel = onCancel;

    this.addChild(this.selectList as unknown as Container);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
  }

  handleInput(data: Buffer) {
    this.selectList.handleInput(data);
  }
}

export const MANAGEMENT_STYLE_CYCLE_SHORTCUT = "ctrl+;";
export const MANAGEMENT_STYLE_CYCLE_BACKWARD_SHORTCUT = "shift+ctrl+;";
export const MANAGEMENT_STYLE_CYCLE_HOTKEY_DISPLAY = `${MANAGEMENT_STYLE_CYCLE_SHORTCUT} / ${MANAGEMENT_STYLE_CYCLE_BACKWARD_SHORTCUT}`;

export function createManagingStyleSubmenuFactory(
  themeModule: SettingsThemeModule,
  onChange: (style: ManagingStyle) => void | Promise<void>,
) {
  return (currentValue: string, done: (newValue?: string) => void) => new ManagingStyleSubmenu(
    themeModule,
    currentValue,
    (style) => {
      void onChange(style);
      done(style);
    },
    () => done(),
  );
}

export function addManagingStyleSettingToSettingsList(
  settingsList: SettingsListLike,
  style: ManagingStyle,
  onChange: (style: ManagingStyle) => void | Promise<void>,
  submenuFactory?: (currentValue: string, done: (newValue?: string) => void) => unknown,
): void {
  const item: SettingsListItem = {
    id: "managing-style",
    label: "Management style",
    description: "Choose how much approval Pi needs before acting",
    currentValue: style,
    submenu: submenuFactory,
  };

  const existingIndex = settingsList.items.findIndex((entry) => entry.id === item.id);
  if (existingIndex !== -1) {
    const existingItem = settingsList.items[existingIndex]!;
    existingItem.label = item.label;
    existingItem.description = item.description;
    existingItem.currentValue = item.currentValue;
    existingItem.values = item.values;
    existingItem.submenu = item.submenu;
    settingsList.updateValue?.(item.id, item.currentValue);
    settingsList.filteredItems = settingsList.items;
    return;
  }

  const insertAt = (() => {
    const autoModelIndex = settingsList.items.findIndex((entry) => entry.id === "auto-model-selection");
    if (autoModelIndex !== -1) return autoModelIndex + 1;
    const thinkingIndex = settingsList.items.findIndex((entry) => entry.id === "thinking");
    if (thinkingIndex !== -1) return thinkingIndex + 1;
    return settingsList.items.length;
  })();

  settingsList.items.splice(insertAt, 0, item);
  settingsList.filteredItems = settingsList.items;

  const originalOnChange = settingsList.onChange;
  settingsList.onChange = (id, newValue) => {
    if (id === item.id) {
      const nextStyle = normalizeManagingStyle(newValue);
      updateManagingStyleStatus(activeManagingStyleUi, nextStyle);
      void onChange(nextStyle);
      return;
    }
    originalOnChange(id, newValue);
  };
}

let settingsSelectorPatchPromise: Promise<void> | undefined;

function patchBuiltInSettingsMenu(): Promise<void> {
  if (!settingsSelectorPatchPromise) {
    settingsSelectorPatchPromise = (async () => {
      const [interactiveModeModule, footerModule, settingsSelectorModule, themeModule] = await Promise.all([
        importPiModule(PI_INTERACTIVE_MODE_RELATIVE_PATH),
        importPiModule(PI_FOOTER_COMPONENT_RELATIVE_PATH),
        importPiModule(PI_SETTINGS_SELECTOR_RELATIVE_PATH),
        importPiModule(PI_THEME_RELATIVE_PATH),
      ]);
      const InteractiveMode = interactiveModeModule.InteractiveMode as {
        prototype: {
          showSettingsSelector?: (...args: unknown[]) => unknown;
          setExtensionFooter?: (factory?: unknown) => unknown;
          setExtensionStatus?: (key: string, text?: string) => unknown;
          setupExtensionShortcuts?: (...args: unknown[]) => unknown;
          handleHotkeysCommand?: (...args: unknown[]) => unknown;
          __managingStyleUiPatched?: boolean;
          __managingStyleFooterPatched?: boolean;
          __managingStyleStatusPatched?: boolean;
          __managingStyleShortcutPatched?: boolean;
          __managingStyleHotkeysPatched?: boolean;
        };
      };
      const FooterComponent = footerModule.FooterComponent as {
        prototype: { render?: (width: number) => string[]; __managingStyleRenderPatched?: boolean };
      };
      const SettingsSelectorComponent = settingsSelectorModule.SettingsSelectorComponent as {
        prototype: { getSettingsList?: () => SettingsListLike; __managingStyleSettingsPatched?: boolean };
      };

      if (!InteractiveMode.prototype.__managingStyleUiPatched && InteractiveMode.prototype.showSettingsSelector) {
        const originalShowSettingsSelector = InteractiveMode.prototype.showSettingsSelector;
        InteractiveMode.prototype.__managingStyleUiPatched = true;
        InteractiveMode.prototype.showSettingsSelector = function showSettingsSelector(this: { ui?: { setStatus?: (id: string, status?: string) => void } }, ...args: unknown[]) {
          activeManagingStyleUi = this.ui;
          return originalShowSettingsSelector.apply(this, args);
        };
      }

      if (!InteractiveMode.prototype.__managingStyleFooterPatched && InteractiveMode.prototype.setExtensionFooter) {
        const originalSetExtensionFooter = InteractiveMode.prototype.setExtensionFooter;
        InteractiveMode.prototype.__managingStyleFooterPatched = true;
        InteractiveMode.prototype.setExtensionFooter = function setExtensionFooter(this: unknown, factory?: unknown) {
          const result = originalSetExtensionFooter.call(this, wrapManagingStyleFooterFactory(factory));
          wrapInteractiveModeFooter(this);
          return result;
        };
      }

      if (!InteractiveMode.prototype.__managingStyleStatusPatched && InteractiveMode.prototype.setExtensionStatus) {
        const originalSetExtensionStatus = InteractiveMode.prototype.setExtensionStatus;
        InteractiveMode.prototype.__managingStyleStatusPatched = true;
        InteractiveMode.prototype.setExtensionStatus = function setExtensionStatus(this: { ui?: { requestRender?: () => void } }, key: string, text?: string) {
          if (key === MANAGING_STYLE_STATUS_ID) {
            activeManagingStyleDisplay = text ?? "";
            wrapInteractiveModeFooter(this);
            this.ui?.requestRender?.();
            return;
          }
          return originalSetExtensionStatus.call(this, key, text);
        };
      }

      if (!InteractiveMode.prototype.__managingStyleShortcutPatched && InteractiveMode.prototype.setupExtensionShortcuts) {
        const originalSetupExtensionShortcuts = InteractiveMode.prototype.setupExtensionShortcuts;
        InteractiveMode.prototype.__managingStyleShortcutPatched = true;
        InteractiveMode.prototype.setupExtensionShortcuts = function setupExtensionShortcuts(this: { defaultEditor?: { onExtensionShortcut?: (data: string) => boolean }; createExtensionUIContext?: () => { notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void; setStatus?: (id: string, status?: string) => void } }, ...args: unknown[]) {
          const result = originalSetupExtensionShortcuts.apply(this, args);
          const originalOnExtensionShortcut = this.defaultEditor?.onExtensionShortcut;
          if (this.defaultEditor && !((this.defaultEditor as { __managingStyleShortcutPatched?: boolean }).__managingStyleShortcutPatched)) {
            (this.defaultEditor as { __managingStyleShortcutPatched?: boolean }).__managingStyleShortcutPatched = true;
            this.defaultEditor.onExtensionShortcut = (data: string) => {
              if (isShiftCtrlSemicolonFallbackInput(data)) {
                const ui = this.createExtensionUIContext?.() ?? activeManagingStyleUi;
                void cycleSessionManagingStyle("backward", { ui });
                return true;
              }
              return originalOnExtensionShortcut?.(data) ?? false;
            };
          }
          return result;
        };
      }

      if (!InteractiveMode.prototype.__managingStyleHotkeysPatched && InteractiveMode.prototype.handleHotkeysCommand) {
        const originalHandleHotkeysCommand = InteractiveMode.prototype.handleHotkeysCommand;
        InteractiveMode.prototype.__managingStyleHotkeysPatched = true;
        InteractiveMode.prototype.handleHotkeysCommand = function handleHotkeysCommand(this: { session?: { extensionRunner?: { getShortcuts?: (config: unknown) => Map<string, unknown> } } }, ...args: unknown[]) {
          const extensionRunner = this.session?.extensionRunner;
          const originalGetShortcuts = extensionRunner?.getShortcuts;
          if (!extensionRunner || !originalGetShortcuts) {
            return originalHandleHotkeysCommand.apply(this, args);
          }

          extensionRunner.getShortcuts = function getShortcutsWithCombinedManagementStyle(config: unknown) {
            const shortcuts = new Map(originalGetShortcuts.call(this, config));
            const forwardShortcut = shortcuts.get(MANAGEMENT_STYLE_CYCLE_SHORTCUT);
            const backwardShortcut = shortcuts.get(MANAGEMENT_STYLE_CYCLE_BACKWARD_SHORTCUT);
            if (forwardShortcut && backwardShortcut) {
              shortcuts.delete(MANAGEMENT_STYLE_CYCLE_SHORTCUT);
              shortcuts.delete(MANAGEMENT_STYLE_CYCLE_BACKWARD_SHORTCUT);
              shortcuts.set(MANAGEMENT_STYLE_CYCLE_HOTKEY_DISPLAY, {
                ...(forwardShortcut as Record<string, unknown>),
                description: "Cycle management style",
              });
            }
            return shortcuts;
          };

          try {
            return originalHandleHotkeysCommand.apply(this, args);
          }
          finally {
            extensionRunner.getShortcuts = originalGetShortcuts;
          }
        };
      }

      if (!FooterComponent.prototype.__managingStyleRenderPatched && FooterComponent.prototype.render) {
        const originalRender = FooterComponent.prototype.render;
        FooterComponent.prototype.__managingStyleRenderPatched = true;
        FooterComponent.prototype.render = function render(this: unknown, width: number) {
          const lines = removeManagingStyleStatusLine(originalRender.call(this, width));
          if (lines[0] !== undefined) {
            lines[0] = rightAlignManagingStyleStatus(lines[0], width, colorize("...", UI_PALETTE.hint));
          }
          return lines;
        };
      }

      if (SettingsSelectorComponent.prototype.__managingStyleSettingsPatched) return;
      const originalGetSettingsList = SettingsSelectorComponent.prototype.getSettingsList;
      if (!originalGetSettingsList) return;

      SettingsSelectorComponent.prototype.__managingStyleSettingsPatched = true;
      SettingsSelectorComponent.prototype.getSettingsList = function getSettingsList(this: unknown) {
        const settingsList = originalGetSettingsList.call(this);
        addManagingStyleSettingToSettingsList(
          settingsList,
          managingStyleCache ?? DEFAULT_MANAGING_STYLE,
          async (style) => {
            await setManagingStyle(style);
          },
          createManagingStyleSubmenuFactory(themeModule as SettingsThemeModule, (style) => {
            updateManagingStyleStatus(activeManagingStyleUi, style);
            void setManagingStyle(style);
          }),
        );
        return settingsList;
      };
    })().catch((error) => {
      settingsSelectorPatchPromise = undefined;
      console.error("Failed to patch pi settings menu for managing style:", error);
    });
  }

  return settingsSelectorPatchPromise;
}

function summarizeWrite(content: string | undefined) {
  if (!content) return "";
  const lines = content.split("\n").length;
  const chars = content.length;
  return `\n\n${uiLabel("New content:")} ${colorize(`${lines} line${lines === 1 ? "" : "s"}, ${chars} char${chars === 1 ? "" : "s"}`, UI_PALETTE.hint)}`;
}

function summarizeEdit(edits: Array<{ oldText: string; newText: string }> | undefined) {
  if (!edits || edits.length === 0) return "";
  const replacements = edits.length;
  return `\n\n${uiLabel("Changes:")} ${colorize(`${replacements} replacement${replacements === 1 ? "" : "s"}`, UI_PALETTE.hint)}`;
}

async function confirmWithWorkingHidden(
  ui: {
    confirm: (title: string, message: string, opts?: { signal?: AbortSignal }) => Promise<boolean>;
    setWorkingVisible?: (visible: boolean) => void;
    setWorkingMessage?: (message?: string) => void;
    setWorkingIndicator?: (options?: { frames?: string[]; intervalMs?: number }) => void;
  },
  title: string,
  message: string,
  opts?: { signal?: AbortSignal },
): Promise<boolean> {
  ui.setWorkingVisible?.(false);
  ui.setWorkingMessage?.("");
  ui.setWorkingIndicator?.({ frames: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    return await ui.confirm(title, message, opts);
  }
  finally {
    ui.setWorkingMessage?.();
    ui.setWorkingIndicator?.();
    ui.setWorkingVisible?.(true);
  }
}

async function confirmFileMutation(
  ctx: {
    ui: {
      getEditorText: () => string;
      setEditorText: (text: string) => void;
      confirm: (title: string, message: string) => Promise<boolean>;
      setWorkingVisible?: (visible: boolean) => void;
    };
  },
  options: {
    title: string;
    path: string;
    previewText: string;
    summary: string;
  },
) {
  const previousEditorText = ctx.ui.getEditorText();
  await notifyPiWaitingForUser(`Approval needed: ${options.title.replace(/\?$/, "")}`, ctx);
  ctx.ui.setEditorText(options.previewText);
  try {
    return await confirmWithWorkingHidden(
      ctx.ui,
      formatConfirmTitle(options.title),
      `${uiLabel("Path:")}\n\n${colorize(options.path, SYNTAX_PALETTE.text)}${options.summary}`,
    );
  }
  finally {
    ctx.ui.setEditorText(previousEditorText);
  }
}

function formatPlainLineNumber(lineNumber: number, width: number) {
  return String(lineNumber).padStart(width, " ");
}

function formatPlainNumberedLine(lineNumber: number, width: number, line: string) {
  return `${formatPlainLineNumber(lineNumber, width)} │ ${line}`;
}

function buildWritePreviewText(content: string | undefined) {
  if (content === undefined) return "";
  if (content.length === 0) return "<empty file>";

  const lines = content.split("\n");
  const width = String(lines.length).length;
  return lines.map((line, index) => formatPlainNumberedLine(index + 1, width, line)).join("\n");
}

function buildEditPreviewText(edits: Array<{ oldText: string; newText: string }> | undefined) {
  if (!edits || edits.length === 0) return "<no diff available>";

  const lines: string[] = [];

  for (const [index, edit] of edits.entries()) {
    if (index > 0) lines.push("");
    lines.push(`@@ edit ${index + 1} @@`);

    const removedLines = edit.oldText.length > 0 ? edit.oldText.split("\n") : ["<empty>"];
    const addedLines = edit.newText.length > 0 ? edit.newText.split("\n") : ["<empty>"];
    const removedWidth = String(removedLines.length).length;
    const addedWidth = String(addedLines.length).length;

    for (const [lineIndex, line] of removedLines.entries()) {
      lines.push(`- ${formatPlainNumberedLine(lineIndex + 1, removedWidth, line)}`);
    }

    for (const [lineIndex, line] of addedLines.entries()) {
      lines.push(`+ ${formatPlainNumberedLine(lineIndex + 1, addedWidth, line)}`);
    }
  }

  return lines.join("\n");
}


const COLOR_RESET = "\x1b[0m";
const BASH_WRAPPERS = new Set(["sudo", "command", "builtin", "env", "nohup", "time", "nice"]);
const XARGS_OPTIONS_WITH_VALUE = new Set(["-E", "-e", "-I", "-i", "-L", "-l", "-n", "-P", "-s", "-d"]);
const THEME_PATH = resolve(import.meta.dirname, "../themes/catppuccin-mocha.json");

type ThemeFile = {
  vars?: Record<string, string>;
  colors?: Record<string, string>;
};

type SyntaxPalette = {
  command: string;
  string: string;
  number: string;
  operator: string;
  variable: string;
  comment: string;
  punctuation: string;
  text: string;
};

type UiPalette = {
  title: string;
  sectionLabel: string;
  listIndex: string;
  primaryAction: string;
  secondaryAction: string;
  danger: string;
  warning: string;
  caution: string;
  warningText: string;
  separator: string;
  hint: string;
  hintKey: string;
};

type BashWarningLevel = "danger" | "warning" | "caution";

type BashWarning = {
  level: BashWarningLevel;
  label: string;
  detail: string;
};

type RiskyToken = {
  pattern: RegExp;
  level: BashWarningLevel;
};

function parseHexColor(hex: string) {
  const normalized = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return undefined;

  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return { r, g, b };
}

function hexToAnsiColor(hex: string) {
  const rgb = parseHexColor(hex);
  return rgb ? `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m` : undefined;
}

function resolveThemeRawColor(theme: ThemeFile, colorName: string | undefined) {
  if (!colorName) return undefined;
  return colorName.startsWith("#") ? colorName : theme.vars?.[colorName];
}

function resolveThemeColor(theme: ThemeFile, colorName: string | undefined) {
  const resolvedColor = resolveThemeRawColor(theme, colorName);
  return resolvedColor ? hexToAnsiColor(resolvedColor) : undefined;
}

function getThemeFile() {
  try {
    if (!existsSync(THEME_PATH)) throw new Error("Theme file not found");
    return JSON.parse(readFileSync(THEME_PATH, "utf8")) as ThemeFile;
  }
  catch {
    return undefined;
  }
}

function getSyntaxPalette(theme: ThemeFile | undefined): SyntaxPalette {
  if (theme) {
    return {
      command: resolveThemeColor(theme, theme.colors?.syntaxFunction ?? theme.colors?.bashMode ?? theme.colors?.accent) ?? "\x1b[38;5;117m",
      string: resolveThemeColor(theme, theme.colors?.syntaxString) ?? "\x1b[38;5;114m",
      number: resolveThemeColor(theme, theme.colors?.syntaxNumber) ?? "\x1b[38;5;215m",
      operator: resolveThemeColor(theme, theme.colors?.syntaxOperator) ?? "\x1b[38;5;117m",
      variable: resolveThemeColor(theme, theme.colors?.syntaxVariable ?? theme.colors?.text) ?? "\x1b[38;5;252m",
      comment: resolveThemeColor(theme, theme.colors?.syntaxComment ?? theme.colors?.dim) ?? "\x1b[38;5;245m",
      punctuation: resolveThemeColor(theme, theme.colors?.syntaxPunctuation) ?? "\x1b[38;5;250m",
      text: resolveThemeColor(theme, theme.colors?.text) ?? "\x1b[38;5;252m",
    };
  }

  return {
    command: "\x1b[38;5;117m",
    string: "\x1b[38;5;114m",
    number: "\x1b[38;5;215m",
    operator: "\x1b[38;5;117m",
    variable: "\x1b[38;5;252m",
    comment: "\x1b[38;5;245m",
    punctuation: "\x1b[38;5;250m",
    text: "\x1b[38;5;252m",
  };
}

function getUiPalette(theme: ThemeFile | undefined): UiPalette {
  if (theme) {
    return {
      title: resolveThemeColor(theme, theme.colors?.warning ?? theme.colors?.accent) ?? "\x1b[38;5;222m",
      sectionLabel: resolveThemeColor(theme, theme.colors?.toolTitle ?? theme.colors?.accent) ?? "\x1b[38;5;183m",
      listIndex: resolveThemeColor(theme, theme.colors?.mdListBullet ?? theme.colors?.accent) ?? "\x1b[38;5;117m",
      primaryAction: resolveThemeColor(theme, theme.colors?.success) ?? "\x1b[38;5;114m",
      secondaryAction: resolveThemeColor(theme, theme.colors?.muted ?? theme.colors?.dim) ?? "\x1b[38;5;250m",
      danger: resolveThemeColor(theme, theme.colors?.error) ?? "\x1b[38;5;203m",
      warning: resolveThemeColor(theme, theme.colors?.warning) ?? "\x1b[38;5;222m",
      caution: resolveThemeColor(theme, theme.colors?.bashMode ?? theme.colors?.syntaxNumber ?? theme.colors?.accent) ?? "\x1b[38;5;215m",
      warningText: resolveThemeColor(theme, theme.colors?.muted ?? theme.colors?.text) ?? "\x1b[38;5;250m",
      separator: resolveThemeColor(theme, theme.colors?.dim ?? theme.colors?.muted) ?? "\x1b[38;5;245m",
      hint: resolveThemeColor(theme, theme.colors?.dim ?? theme.colors?.muted) ?? "\x1b[38;5;245m",
      hintKey: resolveThemeColor(theme, theme.colors?.accent ?? theme.colors?.mdLink) ?? "\x1b[38;5;183m",
    };
  }

  return {
    title: "\x1b[38;5;222m",
    sectionLabel: "\x1b[38;5;183m",
    listIndex: "\x1b[38;5;117m",
    primaryAction: "\x1b[38;5;114m",
    secondaryAction: "\x1b[38;5;250m",
    danger: "\x1b[38;5;203m",
    warning: "\x1b[38;5;222m",
    caution: "\x1b[38;5;215m",
    warningText: "\x1b[38;5;250m",
    separator: "\x1b[38;5;245m",
    hint: "\x1b[38;5;245m",
    hintKey: "\x1b[38;5;183m",
  };
}

const THEME = getThemeFile();
const SYNTAX_PALETTE = getSyntaxPalette(THEME);
const UI_PALETTE = getUiPalette(THEME);
const COMMAND_COLOR = SYNTAX_PALETTE.command;
const RISKY_TOKENS: RiskyToken[] = [
  { pattern: /\bgit\s+push\s+--force-with-lease\b/g, level: "warning" },
  { pattern: /\bgit\s+push\s+--force\b/g, level: "danger" },
  { pattern: /\bchmod\s+-R\b/g, level: "danger" },
  { pattern: /\brm\s+-[^\n;|&]*[rf][^\n;|&]*/g, level: "danger" },
  { pattern: /\bsudo\b/g, level: "warning" },
];

function colorCommand(commandName: string) {
  return `${COMMAND_COLOR}${commandName}${COLOR_RESET}`;
}

function normalizeShellContinuations(command: string) {
  return command.replace(/\\\n[ \t]*/g, " ");
}

function stripHeredocBodies(command: string) {
  const lines = command.split("\n");
  const result: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    result.push(line);

    const heredocMatch = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*|EOF)\1/);
    if (!heredocMatch) continue;

    const terminator = heredocMatch[2];
    for (index += 1; index < lines.length; index++) {
      const heredocLine = lines[index]!;
      if (heredocLine.trim() === terminator) break;
    }
  }

  return result.join("\n");
}

function splitShellSegments(command: string) {
  const segments: string[] = [];
  let current = "";
  let singleQuote = false;
  let doubleQuote = false;
  let subshellDepth = 0;
  let commandSubDepth = 0;

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    const next = command[i + 1];
    const prev = command[i - 1];

    if (char === "'" && !doubleQuote && prev !== "\\") {
      singleQuote = !singleQuote;
      current += char;
      continue;
    }

    if (char === '"' && !singleQuote && prev !== "\\") {
      doubleQuote = !doubleQuote;
      current += char;
      continue;
    }

    if (!singleQuote) {
      if (char === "$" && next === "(") {
        commandSubDepth++;
        current += "$(";
        i++;
        continue;
      }

      if (!doubleQuote && char === "(") {
        subshellDepth++;
        current += char;
        continue;
      }

      if (char === ")" && commandSubDepth > 0) {
        commandSubDepth--;
        current += char;
        continue;
      }

      if (!doubleQuote && char === ")") {
        if (subshellDepth > 0) subshellDepth--;
        current += char;
        continue;
      }
    }

    const atTopLevel = !singleQuote && !doubleQuote && subshellDepth === 0 && commandSubDepth === 0;
    const separator =
      atTopLevel
      && (
        char === "\n"
        || char === ";"
        || (char === "&" && (next === "&" || next === undefined))
        || (char === "|" && (next === "|" || next === "&" || next === undefined))
      );

    if (separator) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if ((char === "&" || char === "|") && next === char) i++;
      else if (char === "|" && next === "&") i++;
      continue;
    }

    current += char;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

function tokenizeShell(segment: string) {
  const tokens: string[] = [];
  let current = "";
  let singleQuote = false;
  let doubleQuote = false;
  let commandSubDepth = 0;

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!;
    const next = segment[i + 1];
    const prev = segment[i - 1];

    if (char === "'" && !doubleQuote && prev !== "\\") {
      singleQuote = !singleQuote;
      current += char;
      continue;
    }

    if (char === '"' && !singleQuote && prev !== "\\") {
      doubleQuote = !doubleQuote;
      current += char;
      continue;
    }

    if (!singleQuote && char === "$" && next === "(") {
      commandSubDepth++;
      current += "$(";
      i++;
      continue;
    }

    if (!singleQuote && commandSubDepth > 0 && char === ")") {
      commandSubDepth--;
      current += char;
      continue;
    }

    if (!singleQuote && !doubleQuote && commandSubDepth === 0 && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function extractCommandSubstitutions(command: string) {
  const nested: string[] = [];

  for (let i = 0; i < command.length; i++) {
    if (command[i] !== "$" || command[i + 1] !== "(") continue;

    let depth = 1;
    let content = "";
    i += 2;

    for (; i < command.length; i++) {
      const char = command[i]!;
      const next = command[i + 1];

      if (char === "$" && next === "(") {
        depth++;
        content += "$(";
        i++;
        continue;
      }

      if (char === ")") {
        depth--;
        if (depth === 0) break;
      }

      content += char;
    }

    if (content.trim()) nested.push(content.trim());
  }

  return nested;
}

function isVariableAssignment(token: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function isOpeningGroupToken(token: string) {
  return /^[(]+$/.test(token) || token === "{" || token === "!";
}

function getNestedCommandNamesInOrder(text: string) {
  const names: string[] = [];

  for (const nested of extractCommandSubstitutions(text)) {
    names.push(...extractCommandNames(nested));
  }

  return names;
}

function getCommandNamesFromSegment(segment: string) {
  const tokens = tokenizeShell(segment);
  const names: string[] = [];
  let foundPrimaryCommand = false;
  let xargsState: "idle" | "options" | "needValue" | "lookingForCommand" | "done" = "idle";

  for (const token of tokens) {
    names.push(...getNestedCommandNamesInOrder(token));

    if (!foundPrimaryCommand) {
      if (isOpeningGroupToken(token)) continue;
      if (isVariableAssignment(token)) continue;
      if (BASH_WRAPPERS.has(token)) continue;

      names.push(token);
      foundPrimaryCommand = true;
      xargsState = token === "xargs" ? "options" : "done";
      continue;
    }

    if (xargsState === "done" || xargsState === "idle") continue;

    if (xargsState === "needValue") {
      xargsState = "options";
      continue;
    }

    if (token === "--") {
      xargsState = "lookingForCommand";
      continue;
    }

    if (xargsState === "options") {
      if (token.startsWith("-") && token !== "-") {
        if (XARGS_OPTIONS_WITH_VALUE.has(token)) {
          xargsState = "needValue";
          continue;
        }
        if (/^-([ELIPnsd]|e).+/.test(token)) continue;
        continue;
      }
      xargsState = "lookingForCommand";
    }

    if (xargsState === "lookingForCommand") {
      if (isOpeningGroupToken(token)) continue;
      if (isVariableAssignment(token)) continue;
      names.push(token);
      xargsState = "done";
    }
  }

  return names;
}

function extractCommandNames(command: string) {
  const names: string[] = [];
  const normalizedCommand = normalizeShellContinuations(stripHeredocBodies(command));

  for (const segment of splitShellSegments(normalizedCommand)) {
    names.push(...getCommandNamesFromSegment(segment));
  }

  return names;
}

function colorize(text: string, color: string) {
  return `${color}${text}${COLOR_RESET}`;
}

function findQuotedSpanEnd(text: string, start: number) {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return start + 1;

  let end = start + 1;
  while (end < text.length) {
    const current = text[end]!;
    if (current === quote && text[end - 1] !== "\\") {
      end++;
      break;
    }
    end++;
  }

  return end;
}

function bold(text: string) {
  return `\x1b[1m${text}${COLOR_RESET}`;
}

function uiLabel(text: string) {
  return colorize(bold(text), UI_PALETTE.sectionLabel);
}

function uiIndex(text: string) {
  return colorize(text, UI_PALETTE.listIndex);
}

function uiHint(text: string) {
  return colorize(text, UI_PALETTE.hint);
}

function formatConfirmTitle(text: string) {
  return colorize(bold(text), UI_PALETTE.title);
}

function highlightRiskyTokens(command: string) {
  let highlighted = command;

  for (const token of RISKY_TOKENS) {
    highlighted = highlighted.replace(token.pattern, (match) => colorize(match, getWarningColor(token.level)));
  }

  return highlighted;
}

function detectWarnings(command: string): BashWarning[] {
  const warnings: BashWarning[] = [];
  const seen = new Set<string>();

  const addWarning = (warning: BashWarning) => {
    const key = `${warning.level}:${warning.label}:${warning.detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push(warning);
  };

  if (/\bsudo\b/.test(command)) {
    addWarning({
      level: "warning",
      label: "sudo",
      detail: "runs with elevated privileges",
    });
  }

  if (/\brm\s+-[^\n;|&]*[rf][^\n;|&]*/.test(command) || /\brm\s+-[^\n;|&]*[fr][^\n;|&]*/.test(command)) {
    addWarning({
      level: "danger",
      label: "rm -rf",
      detail: "can recursively and forcibly delete files",
    });
  }
  else if (/(^|[^A-Za-z])rm(\s|$)/.test(command)) {
    addWarning({
      level: "danger",
      label: "rm",
      detail: "may delete files",
    });
  }

  if (/\bchmod\s+-R\b/.test(command)) {
    addWarning({
      level: "danger",
      label: "chmod -R",
      detail: "can recursively change permissions",
    });
  }

  if (/\bgit\s+push\s+[^\n]*--force-with-lease\b/.test(command) || /\bgit\s+push\s+--force-with-lease\b/.test(command)) {
    addWarning({
      level: "warning",
      label: "git push --force-with-lease",
      detail: "can rewrite remote history with lease checks",
    });
  }
  else if (/\bgit\s+push\s+[^\n]*--force\b/.test(command) || /\bgit\s+push\s+--force\b/.test(command)) {
    addWarning({
      level: "danger",
      label: "git push --force",
      detail: "can rewrite remote history",
    });
  }
  else if (/\bgit\s+push\b/.test(command)) {
    addWarning({
      level: "caution",
      label: "git push",
      detail: "may publish changes to a remote",
    });
  }

  return warnings;
}

function getWarningColor(level: BashWarningLevel) {
  if (level === "danger") return UI_PALETTE.danger;
  if (level === "warning") return UI_PALETTE.warning;
  return UI_PALETTE.caution;
}

function formatWarnings(warnings: BashWarning[]) {
  if (warnings.length === 0) return "";

  const lines = warnings.map((warning) => {
    const color = getWarningColor(warning.level);
    return `${colorize(bold("Warning:"), color)} ${colorize(warning.label, color)} ${colorize(warning.detail, UI_PALETTE.warningText)}`;
  });

  return `\n\n${lines.join("\n")}`;
}

type RenderTheme = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
  italic?: (text: string) => string;
};

function styleRenderCommandToken(theme: RenderTheme, text: string) {
  return theme.fg("warning", theme.bold(text));
}

function styleRenderFlagToken(theme: RenderTheme, text: string) {
  return theme.fg("toolTitle", text);
}

function styleRenderStringToken(theme: RenderTheme, text: string) {
  return theme.fg("syntaxString", text);
}

function styleRenderVariableToken(theme: RenderTheme, text: string) {
  return theme.fg("mdLink", text);
}

function styleRenderValueToken(theme: RenderTheme, text: string) {
  if (/^\d+(?:\.\d+)?$/.test(text)) return theme.fg("syntaxNumber", text);
  return theme.fg("text", text);
}

function renderStructuredToken(theme: RenderTheme, token: string, leftStyle: (theme: RenderTheme, text: string) => string) {
  const separatorMatch = token.match(/^([^=:]+)([=:])(.*)$/);
  if (!separatorMatch) return leftStyle(theme, token);

  const [, left, separator, right] = separatorMatch;
  if (!left || right === undefined) return leftStyle(theme, token);

  const leftPart = leftStyle(theme, left);
  const separatorPart = styleRenderOperatorToken(theme, separator);
  const rightPart = right.length > 0 ? styleRenderValueToken(theme, right) : "";
  return `${leftPart}${separatorPart}${rightPart}`;
}

function styleRenderCommentToken(theme: RenderTheme, text: string) {
  return theme.fg("syntaxComment", theme.italic ? theme.italic(text) : text);
}

function styleRenderOperatorToken(theme: RenderTheme, text: string) {
  return theme.fg("accent", text);
}

function styleRenderKeywordToken(theme: RenderTheme, text: string) {
  return theme.fg("bashMode", text);
}

function styleRenderScriptKeywordToken(theme: RenderTheme, text: string) {
  return theme.fg("thinkingHigh", text);
}

function styleRenderScriptFunctionToken(theme: RenderTheme, text: string) {
  return theme.fg("mdLink", text);
}

function styleRenderScriptNameToken(theme: RenderTheme, text: string) {
  return theme.fg("mdCode", text);
}

function styleRenderScriptVariableToken(theme: RenderTheme, text: string) {
  return theme.fg("customMessageLabel", text);
}

function styleRenderScriptOperatorToken(theme: RenderTheme, text: string) {
  return theme.fg("thinkingLow", text);
}

function styleRenderScriptPunctuationToken(theme: RenderTheme, text: string) {
  return theme.fg("toolTitle", text);
}

function getRenderWarningThemeColor(level: BashWarningLevel) {
  if (level === "danger") return "error";
  if (level === "warning") return "warning";
  return "bashMode";
}

type ShellHighlighterOptions = {
  commandNameSet: Set<string>;
  renderOperator: (theme: RenderTheme, text: string) => string;
  renderPunctuation: (theme: RenderTheme, text: string) => string;
  renderVariable: (theme: RenderTheme, text: string) => string;
  renderString: (theme: RenderTheme, text: string) => string;
  renderToken: (theme: RenderTheme, token: string, commandNameSet: Set<string>) => string;
  renderFallback?: (theme: RenderTheme, text: string) => string;
  renderBackslash?: (theme: RenderTheme, text: string) => string;
  punctuationPattern?: RegExp;
};

function highlightShellLikeTextWithTheme(source: string, theme: RenderTheme, options: ShellHighlighterOptions) {
  let result = "";
  const punctuationPattern = options.punctuationPattern ?? /[(){}\[\]]/;
  const renderFallback = options.renderFallback ?? ((currentTheme, text) => currentTheme.fg("text", text));

  for (let i = 0; i < source.length;) {
    const char = source[i]!;

    if (char === "#") {
      result += styleRenderCommentToken(theme, source.slice(i));
      break;
    }

    if (char === '"' || char === "'") {
      const end = findQuotedSpanEnd(source, i);
      result += options.renderString(theme, source.slice(i, end));
      i = end;
      continue;
    }

    if (options.renderBackslash && char === "\\") {
      result += options.renderBackslash(theme, char);
      i++;
      continue;
    }

    if (char === "$" && source[i + 1] === "(") {
      result += options.renderOperator(theme, "$(");
      i += 2;
      continue;
    }

    if (char === "$") {
      const match = source.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*/);
      if (match) {
        result += options.renderVariable(theme, match[0]);
        i += match[0].length;
        continue;
      }
    }

    if (/^[0-9]$/.test(char)) {
      const match = source.slice(i).match(/^\d+(?:\.\d+)?/);
      if (match) {
        result += theme.fg("syntaxNumber", match[0]);
        i += match[0].length;
        continue;
      }
    }

    const operatorMatch = source.slice(i).match(/^(?:&&|\|\||\|&|>>|<<|[|&;<>])/);
    if (operatorMatch) {
      result += options.renderOperator(theme, operatorMatch[0]);
      i += operatorMatch[0].length;
      continue;
    }

    if (punctuationPattern.test(char)) {
      result += options.renderPunctuation(theme, char);
      i++;
      continue;
    }

    if (/\s/.test(char)) {
      result += char;
      i++;
      continue;
    }

    const tokenMatch = source.slice(i).match(/^[^\s|&;<>()[\]{}]+/);
    if (tokenMatch) {
      const token = tokenMatch[0];
      result += options.renderToken(theme, token, options.commandNameSet);
      i += token.length;
      continue;
    }

    result += renderFallback(theme, char);
    i++;
  }

  return result;
}

function inferHeredocLanguage(line: string) {
  const lower = line.toLowerCase();
  if (/\bpython(?:3)?\b/.test(lower)) return "python";
  if (/\b(?:bash|sh|zsh|fish|ksh)\b/.test(lower)) return "shell";
  return undefined;
}

function highlightShellScriptLineWithTheme(line: string, theme: RenderTheme) {
  return highlightShellLikeTextWithTheme(line, theme, {
    commandNameSet: new Set(extractCommandNames(line)),
    renderOperator: styleRenderScriptOperatorToken,
    renderPunctuation: styleRenderScriptPunctuationToken,
    renderVariable: styleRenderScriptVariableToken,
    renderString: styleRenderStringToken,
    renderToken(currentTheme, token, commandNameSet) {
      if (isVariableAssignment(token)) return renderStructuredToken(currentTheme, token, styleRenderScriptVariableToken);
      if (commandNameSet.has(token)) return styleRenderScriptFunctionToken(currentTheme, token);
      if (token.startsWith("-") && token !== "-") return styleRenderScriptKeywordToken(currentTheme, token);
      if (/^[^=:]+[:=].+$/.test(token)) return renderStructuredToken(currentTheme, token, styleRenderScriptNameToken);
      return styleRenderScriptNameToken(currentTheme, token);
    },
  });
}

function highlightPythonLineWithTheme(line: string, theme: RenderTheme) {
  let result = "";
  const PYTHON_KEYWORDS = new Set([
    "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield",
  ]);

  for (let i = 0; i < line.length;) {
    const char = line[i]!;

    if (char === "#") {
      result += styleRenderCommentToken(theme, line.slice(i));
      break;
    }

    if (char === '"' || char === "'") {
      const end = findQuotedSpanEnd(line, i);
      result += styleRenderStringToken(theme, line.slice(i, end));
      i = end;
      continue;
    }

    if (/^[0-9]$/.test(char)) {
      const match = line.slice(i).match(/^\d+(?:\.\d+)?/);
      if (match) {
        result += theme.fg("syntaxNumber", match[0]);
        i += match[0].length;
        continue;
      }
    }

    const operatorMatch = line.slice(i).match(/^(?:==|!=|<=|>=|:=|\*\*|\/\/=|->|[-+*/%=<>])/);
    if (operatorMatch) {
      result += styleRenderScriptOperatorToken(theme, operatorMatch[0]);
      i += operatorMatch[0].length;
      continue;
    }

    if (/[(){}\[\].,:]/.test(char)) {
      result += styleRenderScriptPunctuationToken(theme, char);
      i++;
      continue;
    }

    if (/\s/.test(char)) {
      result += char;
      i++;
      continue;
    }

    const tokenMatch = line.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (tokenMatch) {
      const token = tokenMatch[0];
      const nextNonSpace = line.slice(i + token.length).match(/^\s*(.)/)?.[1];
      if (PYTHON_KEYWORDS.has(token)) result += styleRenderScriptKeywordToken(theme, token);
      else if (nextNonSpace === "(") result += styleRenderScriptFunctionToken(theme, token);
      else result += styleRenderScriptNameToken(theme, token);
      i += token.length;
      continue;
    }

    result += theme.fg("text", char);
    i++;
  }

  return result;
}

function highlightWholeCommandWithTheme(command: string, names: string[], theme: RenderTheme) {
  let highlighted = highlightShellLikeTextWithTheme(command, theme, {
    commandNameSet: new Set(names),
    renderOperator: styleRenderOperatorToken,
    renderPunctuation(currentTheme, text) {
      return currentTheme.fg("syntaxPunctuation", text);
    },
    renderVariable: styleRenderVariableToken,
    renderString: styleRenderStringToken,
    renderBackslash: styleRenderOperatorToken,
    renderToken(currentTheme, token, commandNameSet) {
      if (isVariableAssignment(token)) return renderStructuredToken(currentTheme, token, styleRenderVariableToken);
      if (commandNameSet.has(token)) return styleRenderCommandToken(currentTheme, token);
      if (token.startsWith("-") && token !== "-") return renderStructuredToken(currentTheme, token, styleRenderFlagToken);
      if (/^[^=:]+[:=].+$/.test(token)) return renderStructuredToken(currentTheme, token, (nestedTheme, text) => nestedTheme.fg("text", text));
      return currentTheme.fg("text", token);
    },
  });

  for (const token of RISKY_TOKENS) {
    highlighted = highlighted.replace(token.pattern, (match) => theme.fg(getRenderWarningThemeColor(token.level), theme.bold(match)));
  }
  return highlighted;
}

function buildBashRenderCallText(command: string | undefined, theme: RenderTheme) {
  if (!command) return theme.fg("muted", "No command provided.");

  const lines = command.split("\n");
  const lineNumberWidth = String(lines.length).length;
  const commandNames = extractCommandNames(command);
  let heredocTerminator: string | undefined;
  let heredocLanguage: string | undefined;

  return lines.map((line, index) => {
    const number = theme.fg("muted", formatPlainLineNumber(index + 1, lineNumberWidth));
    const gutter = theme.fg("dim", "│");

    let highlightedLine = line;
    if (line.trim()) {
      if (heredocTerminator) {
        if (line.trim() === heredocTerminator) {
          highlightedLine = styleRenderKeywordToken(theme, line);
          heredocTerminator = undefined;
          heredocLanguage = undefined;
        }
        else if (heredocLanguage === "python") highlightedLine = highlightPythonLineWithTheme(line, theme);
        else if (heredocLanguage === "shell") highlightedLine = highlightShellScriptLineWithTheme(line, theme);
        else highlightedLine = styleRenderScriptNameToken(theme, line);
      }
      else {
        highlightedLine = highlightWholeCommandWithTheme(line, commandNames, theme);
        const heredocMatch = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*|EOF)\1/);
        if (heredocMatch) {
          heredocTerminator = heredocMatch[2];
          heredocLanguage = inferHeredocLanguage(line);
        }
      }
    }

    return `${number} ${gutter} ${highlightedLine}`;
  }).join("\n");
}

function isPathInCurrentDirectory(targetPath: string | undefined, cwd: string | undefined) {
  if (!targetPath || !cwd) return false;
  const resolvedCwd = resolve(cwd);
  const resolvedTarget = resolve(resolvedCwd, targetPath);
  return resolvedTarget === resolvedCwd || resolvedTarget.startsWith(`${resolvedCwd}/`);
}

function commandRequiresConfirmationInEmpowerment(command: string | undefined) {
  if (!command) return false;

  const normalizedCommand = normalizeShellContinuations(stripHeredocBodies(command));
  const commandNames = extractCommandNames(command).map((name) => name.replace(/^.*\//, "").toLowerCase());

  if (/\b(?:sudo|doas|su)\b/.test(normalizedCommand)) return true;
  if (/(^|[^A-Za-z])rm(\s|$)/.test(normalizedCommand)) return true;
  if (/\b(?:chmod|chown|chgrp)\b/.test(normalizedCommand)) return true;
  if (/\bgit\s+(?:add|commit|push)\b/.test(normalizedCommand)) return true;
  if (/\bgit\s+(?:clone|fetch|pull|ls-remote|remote\s+(?:add|set-url))\b/.test(normalizedCommand)) return true;
  if (/\b(?:gh|glab)\s+(?:pr|mr)\s+create\b/.test(normalizedCommand)) return true;
  if (/\b(?:gh|glab)\s+api\b/.test(normalizedCommand)) return true;

  const localMutationCommands = new Set([
    "mv", "cp", "mkdir", "rmdir", "touch", "ln", "truncate", "tee", "install", "rsync", "dd", "patch",
  ]);

  if (commandNames.some((name) => localMutationCommands.has(name))) return true;

  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|rm|update|upgrade|publish|login|logout|link|unlink)\b/.test(normalizedCommand)) return true;
  if (/\bnpx\s+(?!tsc\b)[^\n;|&]*\b(?:create-|degit|yo|npm-check-updates|npm\b)/.test(normalizedCommand)) return true;
  if (/\b(?:pip|pip3|uv)\s+(?:install|uninstall|sync|add|remove|publish)\b/.test(normalizedCommand)) return true;
  if (/\bcargo\s+(?:install|publish|add|remove|update)\b/.test(normalizedCommand)) return true;
  if (/\bgo\s+(?:get|install|mod\s+(?:download|tidy|vendor))\b/.test(normalizedCommand)) return true;

  const networkCommands = new Set([
    "curl", "wget", "http", "https", "ssh", "scp", "sftp", "ftp", "telnet", "nc", "ncat", "netcat",
    "git-remote-https", "git-remote-http", "git-remote-ssh", "docker", "podman", "kubectl", "helm", "aws", "gcloud", "az", "gh", "glab",
  ]);

  if (commandNames.some((name) => networkCommands.has(name))) return true;

  return false;
}

function summarizeBash(command: string | undefined) {
  if (!command) return "No command provided.";

  const commandNames = extractCommandNames(command);
  const visibleCommandNames = commandNames.slice(0, MAX_PROGRAMS_TO_SHOW);
  const commandList = visibleCommandNames.length
    ? visibleCommandNames.map((name, index) => `${uiIndex(`${index + 1})`)} ${colorCommand(name)}`).join(", ")
    : `${uiIndex("1)")} ${uiHint("No command detected")}`;
  const morePrograms = commandNames.length > MAX_PROGRAMS_TO_SHOW
    ? ` ${uiHint(`(+${commandNames.length - MAX_PROGRAMS_TO_SHOW} more)`)}`
    : "";
  const warnings = detectWarnings(command);
  const warningBlock = formatWarnings(warnings);

  return `${uiLabel("Programs to run:")} ${commandList}${morePrograms}${warningBlock}`;
}


export default function (pi: ExtensionAPI) {
  void refreshManagingStyleCache();
  void patchBuiltInSettingsMenu();

  pi.on("session_start", async (_event, ctx) => {
    sessionManagingStyle = undefined;
    activeManagingStyleUi = ctx.ui;
    await patchBuiltInSettingsMenu();
    patchUiFooter(ctx.ui);
    wrapExistingUiFooter(ctx.ui);
    updateManagingStyleStatus(activeManagingStyleUi, await refreshManagingStyleCache());
    wrapExistingUiFooter(ctx.ui);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearManagingStyleStatus(ctx.ui);
    sessionManagingStyle = undefined;
    if (activeManagingStyleUi === ctx.ui) activeManagingStyleUi = undefined;
  });

  pi.registerShortcut?.(MANAGEMENT_STYLE_CYCLE_SHORTCUT, {
    description: "Cycle management style for this session",
    handler: async (ctx: { ui?: { notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void; setStatus?: (id: string, status?: string) => void } }) => {
      await cycleSessionManagingStyle("forward", ctx);
    },
  });

  pi.registerShortcut?.(MANAGEMENT_STYLE_CYCLE_BACKWARD_SHORTCUT, {
    description: "Cycle management style backward for this session",
    handler: async (ctx: { ui?: { notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void; setStatus?: (id: string, status?: string) => void } }) => {
      await cycleSessionManagingStyle("backward", ctx);
    },
  });

  const originalBash = createBashTool(process.cwd());

  pi.registerTool({
    ...originalBash,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createBashTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme) {
      return new Text(buildBashRenderCallText(args.command, theme), 0, 0);
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const managingStyle = await getCurrentManagingStyle();
      updateManagingStyleStatus(ctx.ui, managingStyle);
      const requiresConfirmation = managingStyle === "Micromanagement"
        || commandRequiresConfirmationInEmpowerment(event.input.command);

      if (!requiresConfirmation) return undefined;

      if (!ctx.hasUI) {
        return { block: true, reason: "Bash command blocked (no UI available for confirmation)" };
      }

      await notifyPiWaitingForUser("Approval needed: bash command", ctx);
      const ok = await confirmWithWorkingHidden(
        ctx.ui,
        formatConfirmTitle("Allow bash command?"),
        summarizeBash(event.input.command),
      );

      if (!ok) return { block: true, reason: "Bash command blocked by user" };
      return undefined;
    }

    if (isToolCallEventType("write", event)) {
      const managingStyle = await getCurrentManagingStyle();
      updateManagingStyleStatus(ctx.ui, managingStyle);
      const requiresConfirmation = managingStyle !== "Empowerment"
        || !isPathInCurrentDirectory(event.input.path, ctx.cwd);

      if (!requiresConfirmation) return undefined;

      if (!ctx.hasUI) {
        return { block: true, reason: "File write blocked (no UI available for confirmation)" };
      }

      const ok = await confirmFileMutation(ctx, {
        title: "Allow file write?",
        path: event.input.path,
        previewText: buildWritePreviewText(event.input.content),
        summary: summarizeWrite(event.input.content),
      });

      if (!ok) return { block: true, reason: "File write blocked by user" };
      return undefined;
    }

    if (isToolCallEventType("edit", event)) {
      const managingStyle = await getCurrentManagingStyle();
      updateManagingStyleStatus(ctx.ui, managingStyle);
      const requiresConfirmation = managingStyle !== "Empowerment"
        || !isPathInCurrentDirectory(event.input.path, ctx.cwd);

      if (!requiresConfirmation) return undefined;

      if (!ctx.hasUI) {
        return { block: true, reason: "File edit blocked (no UI available for confirmation)" };
      }

      const ok = await confirmFileMutation(ctx, {
        title: "Allow file edit?",
        path: event.input.path,
        previewText: buildEditPreviewText(event.input.edits),
        summary: summarizeEdit(event.input.edits),
      });

      if (!ok) return { block: true, reason: "File edit blocked by user" };
      return undefined;
    }

    return undefined;
  });
}
