import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_CONFIRM_COMMAND_LINES = 24;
const MAX_CONFIRM_COMMAND_CHARS = 3000;
const MAX_PROGRAMS_TO_SHOW = 12;

function summarizeWrite(content: string | undefined) {
  if (!content) return "";
  const lines = content.split("\n").length;
  const chars = content.length;
  return `\n\n${uiLabel("New content:")} ${colorize(`${lines} line${lines === 1 ? "" : "s"}, ${chars} char${chars === 1 ? "" : "s"}`, UI_PALETTE.hint)}`;
}

function truncatePreview(text: string, maxLines: number, maxChars: number) {
  const fullLines = text.split("\n").length;
  const fullChars = text.length;

  let preview = text;
  const lines = preview.split("\n");
  if (lines.length > maxLines) preview = lines.slice(0, maxLines).join("\n");
  if (preview.length > maxChars) preview = `${preview.slice(0, maxChars)}\n…`;
  else if (preview.length < text.length) preview = `${preview}\n…`;

  const previewLines = preview.split("\n").length;
  const previewChars = preview.replace(/\n…$/, "").length;
  const truncated = previewChars < fullChars || previewLines < fullLines;

  return {
    preview,
    truncated,
    summary: truncated
      ? `${uiHint("Preview truncated:")} ${colorize(`showing ${previewLines}/${fullLines} lines, ${previewChars}/${fullChars} chars`, UI_PALETTE.hint)}`
      : "",
  };
}

function summarizeEdit(edits: Array<{ oldText: string; newText: string }> | undefined) {
  if (!edits || edits.length === 0) return "";
  const replacements = edits.length;
  return `\n\n${uiLabel("Changes:")} ${colorize(`${replacements} replacement${replacements === 1 ? "" : "s"}`, UI_PALETTE.hint)}`;
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

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const normalizedCommand = stripHeredocBodies(command);

  for (const segment of splitShellSegments(normalizedCommand)) {
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

function inferHeredocLanguage(line: string) {
  const lower = line.toLowerCase();
  if (/\bpython(?:3)?\b/.test(lower)) return "python";
  if (/\b(?:bash|sh|zsh|fish|ksh)\b/.test(lower)) return "shell";
  return undefined;
}

function highlightShellScriptLineWithTheme(line: string, theme: RenderTheme) {
  const commandNames = extractCommandNames(line);
  const commandNameSet = new Set(commandNames);
  let result = "";

  for (let i = 0; i < line.length;) {
    const char = line[i]!;

    if (char === "#") {
      result += styleRenderCommentToken(theme, line.slice(i));
      break;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      let j = i + 1;
      while (j < line.length) {
        const current = line[j]!;
        if (current === quote && line[j - 1] !== "\\") {
          j++;
          break;
        }
        j++;
      }
      result += styleRenderStringToken(theme, line.slice(i, j));
      i = j;
      continue;
    }

    if (char === "$" && line[i + 1] === "(") {
      result += styleRenderScriptOperatorToken(theme, "$(");
      i += 2;
      continue;
    }

    if (char === "$") {
      const match = line.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*/);
      if (match) {
        result += styleRenderScriptVariableToken(theme, match[0]);
        i += match[0].length;
        continue;
      }
    }

    if (/^[0-9]$/.test(char)) {
      const match = line.slice(i).match(/^\d+(?:\.\d+)?/);
      if (match) {
        result += theme.fg("syntaxNumber", match[0]);
        i += match[0].length;
        continue;
      }
    }

    const operatorMatch = line.slice(i).match(/^(?:&&|\|\||\|&|>>|<<|[|&;<>])/);
    if (operatorMatch) {
      result += styleRenderScriptOperatorToken(theme, operatorMatch[0]);
      i += operatorMatch[0].length;
      continue;
    }

    if (/[(){}\[\]]/.test(char)) {
      result += styleRenderScriptPunctuationToken(theme, char);
      i++;
      continue;
    }

    if (/\s/.test(char)) {
      result += char;
      i++;
      continue;
    }

    const tokenMatch = line.slice(i).match(/^[^\s|&;<>()[\]{}]+/);
    if (tokenMatch) {
      const token = tokenMatch[0];
      if (isVariableAssignment(token)) result += renderStructuredToken(theme, token, styleRenderScriptVariableToken);
      else if (commandNameSet.has(token)) result += styleRenderScriptFunctionToken(theme, token);
      else if (token.startsWith("-") && token !== "-") result += styleRenderScriptKeywordToken(theme, token);
      else if (/^[^=:]+[:=].+$/.test(token)) result += renderStructuredToken(theme, token, styleRenderScriptNameToken);
      else result += styleRenderScriptNameToken(theme, token);
      i += token.length;
      continue;
    }

    result += theme.fg("text", char);
    i++;
  }

  return result;
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
      const quote = char;
      let j = i + 1;
      while (j < line.length) {
        const current = line[j]!;
        if (current === quote && line[j - 1] !== "\\") {
          j++;
          break;
        }
        j++;
      }
      result += styleRenderStringToken(theme, line.slice(i, j));
      i = j;
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
  const commandNameSet = new Set(names);
  let result = "";

  for (let i = 0; i < command.length;) {
    const char = command[i]!;

    if (char === "#") {
      result += styleRenderCommentToken(theme, command.slice(i));
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
      result += styleRenderStringToken(theme, command.slice(i, j));
      i = j;
      continue;
    }

    if (char === "$" && command[i + 1] === "(") {
      result += styleRenderOperatorToken(theme, "$(");
      i += 2;
      continue;
    }

    if (/[$]/.test(char)) {
      const match = command.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*/);
      if (match) {
        result += styleRenderVariableToken(theme, match[0]);
        i += match[0].length;
        continue;
      }
    }

    if (/^[0-9]$/.test(char)) {
      const match = command.slice(i).match(/^\d+(?:\.\d+)?/);
      if (match) {
        result += theme.fg("syntaxNumber", match[0]);
        i += match[0].length;
        continue;
      }
    }

    const operatorMatch = command.slice(i).match(/^(?:&&|\|\||\|&|>>|<<|[|&;<>])/);
    if (operatorMatch) {
      result += styleRenderOperatorToken(theme, operatorMatch[0]);
      i += operatorMatch[0].length;
      continue;
    }

    if (/[(){}\[\]]/.test(char)) {
      result += theme.fg("syntaxPunctuation", char);
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
      if (isVariableAssignment(token)) result += renderStructuredToken(theme, token, styleRenderVariableToken);
      else if (commandNameSet.has(token)) result += styleRenderCommandToken(theme, token);
      else if (token.startsWith("-") && token !== "-") result += renderStructuredToken(theme, token, styleRenderFlagToken);
      else if (/^[^=:]+[:=].+$/.test(token)) result += renderStructuredToken(theme, token, (currentTheme, text) => currentTheme.fg("text", text));
      else result += theme.fg("text", token);
      i += token.length;
      continue;
    }

    result += theme.fg("text", char);
    i++;
  }

  let highlighted = result;
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
      if (!ctx.hasUI) {
        return { block: true, reason: "Bash command blocked (no UI available for confirmation)" };
      }

      const ok = await ctx.ui.confirm(
        formatConfirmTitle("Allow bash command?"),
        summarizeBash(event.input.command),
      );

      if (!ok) return { block: true, reason: "Bash command blocked by user" };
      return undefined;
    }

    if (isToolCallEventType("write", event)) {
      if (!ctx.hasUI) {
        return { block: true, reason: "File write blocked (no UI available for confirmation)" };
      }

      const previousEditorText = ctx.ui.getEditorText();
      ctx.ui.setEditorText(buildWritePreviewText(event.input.content));
      try {
        const ok = await ctx.ui.confirm(
          formatConfirmTitle("Allow file write?"),
          `${uiLabel("Path:")}\n\n${colorize(event.input.path, SYNTAX_PALETTE.text)}${summarizeWrite(event.input.content)}`,
        );

        if (!ok) return { block: true, reason: "File write blocked by user" };
        return undefined;
      }
      finally {
        ctx.ui.setEditorText(previousEditorText);
      }
    }

    if (isToolCallEventType("edit", event)) {
      if (!ctx.hasUI) {
        return { block: true, reason: "File edit blocked (no UI available for confirmation)" };
      }

      const previousEditorText = ctx.ui.getEditorText();
      ctx.ui.setEditorText(buildEditPreviewText(event.input.edits));
      try {
        const ok = await ctx.ui.confirm(
          formatConfirmTitle("Allow file edit?"),
          `${uiLabel("Path:")}\n\n${colorize(event.input.path, SYNTAX_PALETTE.text)}${summarizeEdit(event.input.edits)}`,
        );

        if (!ok) return { block: true, reason: "File edit blocked by user" };
        return undefined;
      }
      finally {
        ctx.ui.setEditorText(previousEditorText);
      }
    }

    return undefined;
  });
}
