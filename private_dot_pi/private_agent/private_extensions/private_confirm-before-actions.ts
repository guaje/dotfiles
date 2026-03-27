import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
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

function hexToAnsiColor(hex: string) {
  const normalized = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return undefined;

  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function resolveThemeColor(theme: ThemeFile, colorName: string | undefined) {
  if (!colorName) return undefined;
  const resolvedColor = colorName.startsWith("#") ? colorName : theme.vars?.[colorName];
  return resolvedColor ? hexToAnsiColor(resolvedColor) : undefined;
}

function getSyntaxPalette(): SyntaxPalette {
  try {
    if (!existsSync(THEME_PATH)) throw new Error("Theme file not found");

    const theme = JSON.parse(readFileSync(THEME_PATH, "utf8")) as ThemeFile;
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
  catch {
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
}

const SYNTAX_PALETTE = getSyntaxPalette();
const COMMAND_COLOR = SYNTAX_PALETTE.command;

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

  return result;
}

function summarizeBash(command: string | undefined) {
  if (!command) return "No command provided.";

  const commandNames = extractCommandNames(command);
  const commandList = commandNames.length
    ? commandNames.map((name, index) => `${index + 1}) ${colorCommand(name)}`).join(", ")
    : "1) No command detected";

  return `Command:\n\n${highlightWholeCommand(command, commandNames)}\n\nPrograms to run: ${commandList}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      if (!ctx.hasUI) {
        return { block: true, reason: "Bash command blocked (no UI available for confirmation)" };
      }

      const ok = await ctx.ui.confirm(
        "Allow bash command?",
        summarizeBash(event.input.command),
      );

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
