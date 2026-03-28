import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, Spacer, Text, type SelectItem } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function summarizeWrite(content: string | undefined) {
  if (!content) return "";
  const lines = content.split("\n").length;
  const chars = content.length;
  return `\n\nNew content: ${lines} line${lines === 1 ? "" : "s"}, ${chars} char${chars === 1 ? "" : "s"}`;
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
  selectedYesBg: string;
  selectedNoBg: string;
  selectedYesText: string;
  selectedNoText: string;
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

function hexToAnsiBgColor(hex: string) {
  const rgb = parseHexColor(hex);
  return rgb ? `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m` : undefined;
}

function resolveThemeRawColor(theme: ThemeFile, colorName: string | undefined) {
  if (!colorName) return undefined;
  return colorName.startsWith("#") ? colorName : theme.vars?.[colorName];
}

function resolveThemeColor(theme: ThemeFile, colorName: string | undefined) {
  const resolvedColor = resolveThemeRawColor(theme, colorName);
  return resolvedColor ? hexToAnsiColor(resolvedColor) : undefined;
}

function resolveThemeBgColor(theme: ThemeFile, colorName: string | undefined) {
  const resolvedColor = resolveThemeRawColor(theme, colorName);
  return resolvedColor ? hexToAnsiBgColor(resolvedColor) : undefined;
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
      selectedYesBg: resolveThemeBgColor(theme, theme.vars?.green) ?? "\x1b[48;5;151m",
      selectedNoBg: resolveThemeBgColor(theme, theme.vars?.red) ?? "\x1b[48;5;210m",
      selectedYesText: resolveThemeColor(theme, theme.vars?.base ?? theme.colors?.text) ?? "\x1b[38;5;235m",
      selectedNoText: resolveThemeColor(theme, theme.vars?.base ?? theme.colors?.text) ?? "\x1b[38;5;235m",
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
    selectedYesBg: "\x1b[48;5;151m",
    selectedNoBg: "\x1b[48;5;210m",
    selectedYesText: "\x1b[38;5;235m",
    selectedNoText: "\x1b[38;5;235m",
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

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

      if (!doubleQuote && char === ")") {
        if (commandSubDepth > 0) commandSubDepth--;
        else if (subshellDepth > 0) subshellDepth--;
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

    if (!singleQuote && !doubleQuote && commandSubDepth > 0 && char === ")") {
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

  for (const segment of splitShellSegments(command)) {
    names.push(...getCommandNamesFromSegment(segment));
  }

  return names;
}

function colorize(text: string, color: string) {
  return `${color}${text}${COLOR_RESET}`;
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

function uiHintKey(text: string) {
  return colorize(text, UI_PALETTE.hintKey);
}

function uiPrimaryAction(text: string) {
  return colorize(bold(text), UI_PALETTE.primaryAction);
}

function uiSecondaryAction(text: string) {
  return colorize(text, UI_PALETTE.secondaryAction);
}

function uiDangerAction(text: string) {
  return colorize(bold(text), UI_PALETTE.danger);
}

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function styleSelectedOption(text: string) {
  const plain = stripAnsi(text).trim();
  const isYes = /\bYes\b/.test(plain);
  const bg = isYes ? UI_PALETTE.selectedYesBg : UI_PALETTE.selectedNoBg;
  const fg = isYes ? UI_PALETTE.selectedYesText : UI_PALETTE.selectedNoText;
  return `${bg}${colorize(bold(`[ ${plain} ]`), fg)}${COLOR_RESET}`;
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

function highlightWholeCommand(command: string, names: string[]) {
  const commandNameSet = new Set(names);
  let result = "";

  for (let i = 0; i < command.length;) {
    const char = command[i]!;

    if (char === "#") {
      result += colorize(command.slice(i), SYNTAX_PALETTE.comment);
      break;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      let j = i + 1;
      while (j < command.length) {
        const current = command[j]!;
        if (current === quote && command[j - 1] !== "\\") {
          j++;
          break;
        }
        j++;
      }
      result += colorize(command.slice(i, j), SYNTAX_PALETTE.string);
      i = j;
      continue;
    }

    if (char === "$" && command[i + 1] === "(") {
      result += colorize("$(", SYNTAX_PALETTE.operator);
      i += 2;
      continue;
    }

    if (/[$]/.test(char)) {
      const match = command.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*/);
      if (match) {
        result += colorize(match[0], SYNTAX_PALETTE.variable);
        i += match[0].length;
        continue;
      }
    }

    if (/^[0-9]$/.test(char)) {
      const match = command.slice(i).match(/^\d+(?:\.\d+)?/);
      if (match) {
        result += colorize(match[0], SYNTAX_PALETTE.number);
        i += match[0].length;
        continue;
      }
    }

    const operatorMatch = command.slice(i).match(/^(?:&&|\|\||\|&|>>|<<|[|&;<>])/);
    if (operatorMatch) {
      result += colorize(operatorMatch[0], SYNTAX_PALETTE.operator);
      i += operatorMatch[0].length;
      continue;
    }

    if (/[(){}\[\]]/.test(char)) {
      result += colorize(char, SYNTAX_PALETTE.punctuation);
      i++;
      continue;
    }

    if (/\s/.test(char)) {
      result += char;
      i++;
      continue;
    }

    const tokenMatch = command.slice(i).match(/^[^\s|&;<>()[\]{}]+/);
    if (tokenMatch) {
      const token = tokenMatch[0];
      if (isVariableAssignment(token)) result += colorize(token, SYNTAX_PALETTE.variable);
      else if (commandNameSet.has(token)) result += colorCommand(token);
      else result += colorize(token, SYNTAX_PALETTE.text);
      i += token.length;
      continue;
    }

    result += colorize(char, SYNTAX_PALETTE.text);
    i++;
  }

  return highlightRiskyTokens(result);
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

function summarizeBash(command: string | undefined) {
  if (!command) return "No command provided.";

  const commandNames = extractCommandNames(command);
  const commandList = commandNames.length
    ? commandNames.map((name, index) => `${uiIndex(`${index + 1})`)} ${colorCommand(name)}`).join(", ")
    : `${uiIndex("1)")} ${uiHint("No command detected")}`;
  const warnings = detectWarnings(command);
  const warningBlock = formatWarnings(warnings);

  return `${uiLabel("Command:")}\n\n${highlightWholeCommand(command, commandNames)}\n\n${uiLabel("Programs to run:")} ${commandList}${warningBlock}`;
}

async function confirmBashCommand(ctx: any, command: string | undefined) {
  const body = summarizeBash(command);
  const items: SelectItem[] = [
    { value: "yes", label: uiHint("Yes") },
    { value: "no", label: colorize("No", UI_PALETTE.hint) },
  ];

  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));
    container.addChild(new Text(colorize(bold("Allow bash command?"), UI_PALETTE.title), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text(body, 1, 0));
    container.addChild(new Spacer(1));

    const selectList = new SelectList(items, items.length, {
      selectedPrefix: () => colorize(bold("❯"), UI_PALETTE.primaryAction),
      selectedText: (t) => styleSelectedOption(t),
      description: (t) => colorize(t, UI_PALETTE.hint),
      scrollInfo: (t) => colorize(t, UI_PALETTE.hint),
      noMatch: (t) => colorize(t, UI_PALETTE.warning),
    });
    selectList.onSelect = (item) => done(String(item.value));
    selectList.onCancel = () => done(null);
    container.addChild(selectList);
    container.addChild(new Spacer(1));
    container.addChild(new Text(`${uiHintKey("↑↓ navigate")} ${colorize("•", UI_PALETTE.separator)} ${uiHintKey("enter select")} ${colorize("•", UI_PALETTE.separator)} ${uiHintKey("escape/ctrl+c cancel")}`, 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        selectList.handleInput?.(data);
        tui.requestRender();
      },
    };
  }, { overlay: true, overlayOptions: { width: "92%", minWidth: 40, maxHeight: "80%" } });

  return result === "yes";
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      if (!ctx.hasUI) {
        return { block: true, reason: "Bash command blocked (no UI available for confirmation)" };
      }

      const ok = await confirmBashCommand(ctx, event.input.command);

      if (!ok) return { block: true, reason: "Bash command blocked by user" };
      return undefined;
    }

    if (isToolCallEventType("write", event)) {
      if (!ctx.hasUI) {
        return { block: true, reason: "File write blocked (no UI available for confirmation)" };
      }

      const ok = await ctx.ui.confirm(
        "Allow file write?",
        `Path:\n\n${event.input.path}${summarizeWrite(event.input.content)}`,
      );

      if (!ok) return { block: true, reason: "File write blocked by user" };
      return undefined;
    }

    if (isToolCallEventType("edit", event)) {
      if (!ctx.hasUI) {
        return { block: true, reason: "File edit blocked (no UI available for confirmation)" };
      }

      const ok = await ctx.ui.confirm(
        "Allow file edit?",
        `Path:\n\n${event.input.path}`,
      );

      if (!ok) return { block: true, reason: "File edit blocked by user" };
      return undefined;
    }

    return undefined;
  });
}
