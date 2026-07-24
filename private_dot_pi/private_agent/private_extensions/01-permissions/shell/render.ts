import { sshRenderParts } from "./ssh.ts";

export type RenderTheme = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
  italic?: (text: string) => string;
};

const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in"]);
const MUTATING_CURL = /^(?:-X(?:POST|PUT|PATCH|DELETE)|--request=(?:POST|PUT|PATCH|DELETE)|--data|--json|--form|--upload-file|-T|-o|--output|-O|--remote-name)/i;

/** Presentation is deliberately tolerant; authorization uses parser.ts. */
export function renderShell(source: string | undefined, theme: RenderTheme) {
  if (!source) return theme.fg("muted", "No command provided.");
  const lines = source.split("\n");
  const numberWidth = String(lines.length).length;
  const rendered: string[] = [];
  let heredoc: { delimiter: string; language?: "shell" | "python" } | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const prefix = `${theme.fg("muted", String(index + 1).padStart(numberWidth))} ${theme.fg("dim", "│")} `;
    if (heredoc) {
      if (line.trim() === heredoc.delimiter) {
        rendered.push(`${prefix}${theme.fg("bashMode", line)}`);
        heredoc = undefined;
      }
      else rendered.push(`${prefix}${heredoc.language === "python" ? highlightPython(line, theme) : highlightLine(line, theme)}`);
      continue;
    }

    const ssh = sshRenderParts(line);
    if (ssh) {
      rendered.push(`${prefix}${highlightLine(ssh.outer, theme)}`);
      const continuation = `${" ".repeat(numberWidth)} ${theme.fg("dim", "│")} `;
      rendered.push(`${continuation}${theme.fg("muted", `remote shell (${ssh.target}): `)}${highlightLine(ssh.payload, theme)}`);
      if (ssh.localSuffix) rendered.push(`${continuation}${theme.fg("muted", "local shell: ")}${highlightLine(ssh.localSuffix, theme)}`);
      continue;
    }

    rendered.push(`${prefix}${highlightLine(line, theme)}`);
    const match = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (match) heredoc = { delimiter: match[2]!, language: /\bpython\d*\b/.test(line) ? "python" : /\b(?:ba|z|fi|k)?sh\b/.test(line) ? "shell" : undefined };
  }
  return rendered.join("\n");
}

function highlightLine(line: string, theme: RenderTheme) {
  let output = "";
  let index = 0;
  let expectCommand = true;
  while (index < line.length) {
    const current = line[index]!;
    if (current === "#") { output += theme.fg("syntaxComment", theme.italic ? theme.italic(line.slice(index)) : line.slice(index)); break; }
    if (/\s/.test(current)) { output += current; index++; continue; }
    const operator = /^(?:&&|\|\||\|&|>>|<<|[|&;<>()[\]{}])/.exec(line.slice(index))?.[0];
    if (operator) { output += theme.fg("accent", operator); index += operator.length; if (/^(?:&&|\|\||\||;)$/.test(operator)) expectCommand = true; continue; }
    if (current === "'" || current === '"') {
      const end = quotedEnd(line, index, current);
      output += theme.fg("syntaxString", line.slice(index, end));
      index = end;
      continue;
    }
    const token = /^[^\s|&;<>()[\]{}]+/.exec(line.slice(index))?.[0];
    if (!token) { output += theme.fg("text", current); index++; continue; }
    output += styleToken(token, expectCommand, theme);
    if (expectCommand && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) && !SHELL_KEYWORDS.has(token)) expectCommand = false;
    index += token.length;
  }
  return output;
}

function styleToken(token: string, command: boolean, theme: RenderTheme) {
  if (SHELL_KEYWORDS.has(token)) return theme.fg("bashMode", token);
  if (command) return theme.fg("warning", theme.bold(token));
  if (/^https?:\/\//i.test(token)) return theme.fg("mdLink", token);
  if (/^\$[A-Za-z_][A-Za-z0-9_]*/.test(token)) return theme.fg("mdLink", token);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
    const split = token.indexOf("=");
    return `${theme.fg("mdLink", token.slice(0, split))}${theme.fg("accent", "=")}${theme.fg("text", token.slice(split + 1))}`;
  }
  if (MUTATING_CURL.test(token)) return theme.fg("error", token);
  if (token.startsWith("-")) return theme.fg("toolTitle", token);
  if (/^\d+(?:\.\d+)?$/.test(token)) return theme.fg("syntaxNumber", token);
  return theme.fg("text", token);
}

function quotedEnd(source: string, start: number, quote: string) {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\" && quote === '"') { index += 2; continue; }
    if (source[index] === quote) return index + 1;
    index++;
  }
  return source.length;
}

function highlightPython(line: string, theme: RenderTheme) {
  const keywords = /\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\b/g;
  let output = "";
  let index = 0;
  for (const match of line.matchAll(keywords)) {
    const start = match.index ?? 0;
    output += theme.fg("text", line.slice(index, start));
    output += theme.fg("thinkingHigh", match[0]);
    index = start + match[0].length;
  }
  return output + theme.fg("text", line.slice(index));
}
