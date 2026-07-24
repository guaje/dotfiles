import { Container, matchesKey, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { importPiModule } from "../packages/pi-package.ts";
import { MANAGING_STYLE_LABELS, MANAGING_STYLE_VALUES, normalizeManagingStyle } from "./management-style.ts";
import type { ManagingStyle } from "./types.ts";

type List = { items: any[]; filteredItems: any[]; onChange: (id: string, value: string) => void; updateValue?: (id: string, value: string) => void };
type ThemeModule = { theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }; getSelectListTheme: () => unknown };
type NotifyUi = { notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void };

const SETTINGS_PATCH = Symbol.for("pi.permissions.settings-ui.v1");
const SHORTCUT_PATCH = Symbol.for("pi.permissions.shortcut-ui.v1");
const EDITOR_PATCH = Symbol.for("pi.permissions.shortcut-editor.v1");
const HOTKEYS_PATCH = Symbol.for("pi.permissions.hotkeys-ui.v1");
const LIST_PATCH = Symbol.for("pi.permissions.settings-list.v1");
const RUNTIME_STATE = Symbol.for("pi.permissions.settings-runtime.v1");
const FORWARD_SHORTCUT = "ctrl+;";
const BACKWARD_SHORTCUT = "shift+ctrl+;";
const HOTKEY_DISPLAY = `${FORWARD_SHORTCUT} / ${BACKWARD_SHORTCUT}`;

type RuntimeState = {
  getStyle: () => ManagingStyle;
  save: (style: ManagingStyle) => Promise<void>;
  cycleBackward: (ui?: NotifyUi) => void | Promise<void>;
  ui?: NotifyUi;
};
function runtimeState(): RuntimeState {
  const global = globalThis as typeof globalThis & { [RUNTIME_STATE]?: RuntimeState };
  return global[RUNTIME_STATE] ??= { getStyle: () => "Micromanagement", save: async () => {}, cycleBackward: () => {} };
}

export function isShiftCtrlSemicolonFallbackInput(data: string) {
  return matchesKey(data, "ctrl+:") || matchesKey(data, "shift+ctrl+:");
}

export function decorateSettingsList(list: List, style: ManagingStyle, save: (style: ManagingStyle) => Promise<void>, theme?: ThemeModule) {
  const item = {
    id: "managing-style",
    label: "Management style",
    description: "Choose how much approval Pi needs before acting",
    currentValue: style === "Empowerment" ? "Empowering" : style,
    submenu: theme ? submenu(theme, style, save) : undefined,
  };
  const existing = list.items.find((candidate) => candidate.id === item.id);
  if (existing) Object.assign(existing, item);
  else {
    const thinkingIndex = list.items.findIndex((candidate) => candidate.id === "thinking");
    list.items.splice(thinkingIndex < 0 ? list.items.length : thinkingIndex + 1, 0, item);
  }
  list.filteredItems = list.items;
  list.updateValue?.(item.id, item.currentValue);
  if (!(list as any)[LIST_PATCH]) {
    const original = list.onChange;
    (list as any)[LIST_PATCH] = true;
    list.onChange = (id, value) => id === item.id ? void save(normalizeManagingStyle(value)) : original(id, value);
  }
}

function submenu(theme: ThemeModule, current: ManagingStyle, save: (style: ManagingStyle) => Promise<void>) {
  return (_value: string, done: (value?: string) => void) => {
    const box = new Container();
    box.addChild(new Text(theme.theme.bold(theme.theme.fg("accent", "Management style")), 0, 0));
    box.addChild(new Spacer(1));
    box.addChild(new Text(theme.theme.fg("muted", "Select how much approval Pi needs before acting"), 0, 0));
    box.addChild(new Spacer(1));
    const choices = MANAGING_STYLE_VALUES.map((value) => ({
      value,
      label: value === "Empowerment" ? "Empowering" : value,
      description: value === "Empowerment"
        ? "Allow classified read-only commands and permitted file changes"
        : "Ask before every bash command, write, and edit",
    }));
    const select = new SelectList(choices, choices.length, theme.getSelectListTheme(), { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 24 }) as any;
    select.setSelectedIndex?.(choices.findIndex((choice) => choice.value === current));
    select.onSelect = (choice: { value: ManagingStyle }) => { void save(choice.value); done(choice.value); };
    select.onCancel = () => done();
    box.addChild(select);
    box.addChild(new Spacer(1));
    box.addChild(new Text(theme.theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
    return box;
  };
}

let patchPromise: Promise<void> | undefined;
/** All unsupported Pi internals live here. Decoration failures never affect policy enforcement. */
export function patchBuiltInSettingsMenu(
  getStyle: () => ManagingStyle,
  save: (style: ManagingStyle) => Promise<void>,
  cycleBackward?: (ui?: NotifyUi) => void | Promise<void>,
) {
  const runtime = runtimeState();
  runtime.getStyle = getStyle;
  runtime.save = save;
  if (cycleBackward) runtime.cycleBackward = cycleBackward;
  if (patchPromise) return patchPromise;

  patchPromise = Promise.all([
    importPiModule("dist/modes/interactive/interactive-mode.js"),
    importPiModule("dist/modes/interactive/components/settings-selector.js"),
    importPiModule("dist/modes/interactive/theme/theme.js"),
  ]).then(([interactive, selector, theme]) => {
    const interactivePrototype = interactive.InteractiveMode?.prototype;
    const settingsPrototype = selector.SettingsSelectorComponent?.prototype;

    if (interactivePrototype?.showSettingsSelector && !interactivePrototype[SETTINGS_PATCH]) {
      const original = interactivePrototype.showSettingsSelector;
      interactivePrototype[SETTINGS_PATCH] = true;
      interactivePrototype.showSettingsSelector = function (this: { ui?: NotifyUi }, ...args: unknown[]) {
        runtimeState().ui = this.ui;
        return original.apply(this, args);
      };
    }
    if (interactivePrototype?.setupExtensionShortcuts && !interactivePrototype[SHORTCUT_PATCH]) {
      const original = interactivePrototype.setupExtensionShortcuts;
      interactivePrototype[SHORTCUT_PATCH] = true;
      interactivePrototype.setupExtensionShortcuts = function (this: any, ...args: unknown[]) {
        const result = original.apply(this, args);
        const editor = this.defaultEditor;
        if (editor && !editor[EDITOR_PATCH]) {
          const previous = editor.onExtensionShortcut;
          editor[EDITOR_PATCH] = true;
          editor.onExtensionShortcut = (data: string) => {
            if (isShiftCtrlSemicolonFallbackInput(data)) {
              const ui = this.createExtensionUIContext?.() ?? runtimeState().ui;
              void runtimeState().cycleBackward(ui);
              return true;
            }
            return previous?.(data) ?? false;
          };
        }
        return result;
      };
    }
    if (interactivePrototype?.handleHotkeysCommand && !interactivePrototype[HOTKEYS_PATCH]) {
      const original = interactivePrototype.handleHotkeysCommand;
      interactivePrototype[HOTKEYS_PATCH] = true;
      interactivePrototype.handleHotkeysCommand = function (this: any, ...args: unknown[]) {
        const runner = this.session?.extensionRunner;
        const getShortcuts = runner?.getShortcuts;
        if (!runner || !getShortcuts) return original.apply(this, args);
        runner.getShortcuts = function (config: unknown) {
          const shortcuts = new Map(getShortcuts.call(this, config));
          const forward = shortcuts.get(FORWARD_SHORTCUT);
          const backward = shortcuts.get(BACKWARD_SHORTCUT);
          if (forward && backward) {
            shortcuts.delete(FORWARD_SHORTCUT);
            shortcuts.delete(BACKWARD_SHORTCUT);
            shortcuts.set(HOTKEY_DISPLAY, { ...(forward as Record<string, unknown>), description: "Cycle management style" });
          }
          return shortcuts;
        };
        try { return original.apply(this, args); }
        finally { runner.getShortcuts = getShortcuts; }
      };
    }
    if (settingsPrototype?.getSettingsList && !settingsPrototype[SETTINGS_PATCH]) {
      const original = settingsPrototype.getSettingsList;
      settingsPrototype[SETTINGS_PATCH] = true;
      settingsPrototype.getSettingsList = function () {
        const list = original.call(this);
        try { const runtime = runtimeState(); decorateSettingsList(list, runtime.getStyle(), runtime.save, theme as ThemeModule); }
        catch (error) { console.error("Permissions settings decoration failed:", error); }
        return list;
      };
    }
  }).catch((error) => {
    patchPromise = undefined;
    console.error("Permissions settings decoration unavailable:", error);
  });
  return patchPromise;
}

export { MANAGING_STYLE_LABELS };
