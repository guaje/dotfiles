import { classifyCurl } from "./curl.ts";
import { classifyProfile } from "./profiles.ts";
import { parseSsh, remoteContext } from "./ssh.ts";
import type { ShellAnalysis, ShellCommand, ShellContext, ShellEffect } from "../types.ts";

type Token = { text: string; start: number; end: number; kind: "word" | "op"; literal: boolean; substitutions: string[] };
const local: ShellContext = { location: "local", usesNetwork: false };
const effectRank: Record<ShellEffect, number> = { "read-only": 0, mutating: 1, unknown: 2 };
function combine(a: ShellEffect, b: ShellEffect): ShellEffect { return effectRank[a] >= effectRank[b] ? a : b; }

/** Conservative shell lexer. It deliberately rejects syntax it cannot consume completely. */
function lex(source: string): { tokens: Token[]; complete: boolean; reason?: string } {
  const tokens: Token[] = []; let i = 0;
  const pushOp = (text: string, start: number) => tokens.push({ text, start, end: start + text.length, kind: "op", literal: true, substitutions: [] });
  while (i < source.length) {
    if (source[i] === "\n") {
      if (/^\s*$/.test(source.slice(i + 1)) || tokens.at(-1)?.kind === "op") { i++; continue; }
      pushOp(";", i); i++; continue;
    }
    if (/\s/.test(source[i]!)) { i++; continue; }
    if (source[i] === "#") { while (i < source.length && source[i] !== "\n") i++; continue; }
    const start = i; const pair = source.slice(i, i + 2);
    if (["&&", "||", ">>", "<<", "<<-"].includes(pair) || source[i] === ";" || source[i] === "|" || source[i] === "&" || source[i] === "(" || source[i] === ")" || source[i] === "<" || source[i] === ">") { pushOp(pair === "<<-" ? pair : ["&&", "||", ">>", "<<"].includes(pair) ? pair : source[i]!, start); i += tokens.at(-1)!.text.length; continue; }
    let text = "", literal = true; const substitutions: string[] = [];
    while (i < source.length && !/\s/.test(source[i]!) && !";&|<>()".includes(source[i]!)) {
      const quote = source[i]!;
      if (quote === "'" || quote === '"') { const closing = source.indexOf(quote, i + 1); if (closing < 0) return { tokens, complete: false, reason: "unterminated quote" }; const part = source.slice(i + 1, closing); text += part; if (quote === '"' && /\$(?!\()|`/.test(part)) literal = false; substitutions.push(...commandSubstitutions(part)); i = closing + 1; continue; }
      if (source.startsWith("$(", i)) { const close = matchingParen(source, i + 1); if (close < 0) return { tokens, complete: false, reason: "unterminated command substitution" }; substitutions.push(source.slice(i + 2, close)); text += source.slice(i, close + 1); i = close + 1; continue; }
      if (source[i] === "$" || source[i] === "`" || source.startsWith("<( ", i)) literal = false;
      if (source[i] === "\\") { if (i + 1 >= source.length) return { tokens, complete: false, reason: "trailing escape" }; text += source[i + 1]!; i += 2; continue; }
      text += source[i++]!;
    }
    if (!text) return { tokens, complete: false, reason: "unsupported shell token" };
    tokens.push({ text, start, end: i, kind: "word", literal, substitutions });
  }
  return { tokens, complete: true };
}
function matchingParen(source: string, open: number) {
  let depth = 1; let quote: "'" | '"' | undefined;
  for (let i = open + 1; i < source.length; i++) {
    const current = source[i]!;
    if (current === "\\") { i++; continue; }
    if (quote) { if (current === quote) quote = undefined; continue; }
    if (current === "'" || current === '"') { quote = current; continue; }
    if (source.startsWith("$(", i)) { depth++; i++; }
    else if (current === ")" && --depth === 0) return i;
  }
  return -1;
}
function commandSubstitutions(value: string) { const parts: string[] = []; for (let i = 0; i < value.length; i++) if (value.startsWith("$(", i)) { const close = matchingParen(value, i + 1); if (close >= 0) { parts.push(value.slice(i + 2, close)); i = close; } } return parts; }
type Unwrapped = { index: number; reason?: string };
function unwrap(argv: string[]): Unwrapped {
  let index = 0;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index] ?? "")) return { index, reason: "leading environment assignments are not reviewed" };
  const wrapperName = argv[index];
  if (wrapperName === "command") {
    if (argv[index + 1] === "-v") return { index };
    index++;
    if (argv[index] === "--") index++;
    return argv[index] ? { index } : { index: 0, reason: "command wrapper has no executable" };
  }
  if (wrapperName === "timeout") {
    index++;
    while ((argv[index] ?? "").startsWith("-")) {
      const option = argv[index]!;
      if (["--foreground", "--preserve-status", "--verbose"].includes(option) || option.startsWith("--signal=")) index++;
      else if (["-s", "--signal", "-k", "--kill-after"].includes(option) && argv[index + 1]) index += 2;
      else return { index: 0, reason: `unreviewed timeout option: ${option}` };
    }
    if (!/^\d+(?:\.\d+)?[smhd]?$/.test(argv[index] ?? "")) return { index: 0, reason: "timeout duration is missing or dynamic" };
    index++;
    return argv[index] ? { index } : { index: 0, reason: "timeout wrapper has no executable" };
  }
  if (wrapperName === "env") {
    index++;
    let isolated = false;
    while (index < argv.length) {
      const value = argv[index]!;
      if (value === "-i" || value === "--ignore-environment") { isolated = true; index++; continue; }
      if ((value === "-u" || value === "--unset") && argv[index + 1]) { index += 2; continue; }
      if (value.startsWith("--unset=")) { index++; continue; }
      if (/^(?:LANG|LC_[A-Z_]+|TZ|TERM|NO_COLOR|COLUMNS|LINES)=/.test(value)) { index++; continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) return { index: 0, reason: "env assignment can change command behavior" };
      break;
    }
    if (index >= argv.length) return isolated ? { index: 0, reason: "env wrapper has no executable" } : { index: 0 };
    return isolated ? { index } : { index: 0, reason: "env command inheritance is not reviewed; use env -i" };
  }
  return { index };
}
function summarize(source: string, complete: boolean, commands: ShellCommand[], reasons: string[]): ShellAnalysis { const effect = commands.reduce((result, command) => combine(result, command.effect), complete ? "read-only" as ShellEffect : "unknown"); return { source, complete, effect, reasons, commands, containsReadOnly: commands.some((x) => x.effect === "read-only"), containsNonReadOnly: commands.some((x) => x.effect !== "read-only"), context: local }; }
function withoutHeredocBodies(source: string) {
  const lines = source.split("\n"); const result: string[] = [];
  for (let index = 0; index < lines.length; index++) { const line = lines[index]!; result.push(line); const match = line.match(/<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?/); if (!match) continue; const delimiter = match[1]!; while (++index < lines.length && lines[index]!.trim() !== delimiter) {} }
  return result.join("\n");
}
export function parseShell(source: string): ShellAnalysis {
  const parsed = lex(withoutHeredocBodies(source)); if (!parsed.complete) return summarize(source, false, [], [parsed.reason ?? "unsupported shell syntax"]);
  const commands: ShellCommand[] = []; const reasons: string[] = []; let groupDepth = 0; let i = 0; let expectCommand = true;
  while (i < parsed.tokens.length) {
    const token = parsed.tokens[i]!;
    if (token.kind === "op") { if ([";", "&&", "||", "|"].includes(token.text)) { if (expectCommand) reasons.push("empty shell branch"); expectCommand = true; } else if (token.text === "&") { reasons.push("background shell execution is not reviewed"); expectCommand = true; } else if (token.text === "(") { groupDepth++; } else if (token.text === ")") { if (!groupDepth--) reasons.push("unmatched group closing"); } else if (token.text === ">" || token.text === ">>") { const target = parsed.tokens[++i]; const previous = commands.at(-1); if (!target || target.kind !== "word" || !target.literal || !previous) reasons.push("unsupported output redirection"); else if (target.text !== "/dev/null") { previous.effect = "mutating"; previous.reason = "output redirection writes a file"; reasons.push(previous.reason); } } else if (token.text === "<") { const target = parsed.tokens[++i]; if (!target || target.kind !== "word" || !target.literal) reasons.push("unsupported input redirection"); } else if (token.text.startsWith("<<")) { const delimiter = parsed.tokens[++i]; if (!delimiter || delimiter.kind !== "word") reasons.push("invalid heredoc delimiter"); else reasons.push("heredoc bodies are not reviewed"); } i++; continue; }
    if (!expectCommand) { i++; continue; }
    const words: Token[] = []; while (i < parsed.tokens.length && parsed.tokens[i]!.kind === "word") words.push(parsed.tokens[i++]!);
    expectCommand = false;
    const argv = words.map((word) => word.text);
    const unwrapped = unwrap(argv);
    const commandIndex = unwrapped.index;
    const executable = words[commandIndex];
    if (!executable || !executable.literal || /^(?:function|alias|eval|source|\.)$/.test(executable.text)) { reasons.push("dynamic or unsupported executable"); continue; }
    if (words.some((word) => !word.literal && word.substitutions.length === 0)) { reasons.push("unsupported dynamic shell expansion"); continue; }
    let result = unwrapped.reason
      ? { effect: "unknown" as ShellEffect, reason: unwrapped.reason }
      : classifyProfile(executable.text, argv.slice(commandIndex + 1));
    let context = local;
    for (const word of words) for (const nested of word.substitutions) { const analysis = parseShell(nested); result.effect = combine(result.effect, analysis.effect); reasons.push(...analysis.reasons); commands.push(...analysis.commands); }
    if (executable.text === "curl") { const curl = classifyCurl(argv.slice(commandIndex + 1)); result = curl; context = { location: "local", usesNetwork: true }; }
    if (executable.text === "ssh") { const ssh = parseSsh(argv.slice(commandIndex + 1), source, executable.start); context = { location: "remote", transport: "ssh", target: ssh.target, usesNetwork: true }; result = ssh; if (ssh.payload && ssh.target && ssh.effect === "read-only") { const nested = remoteContext(parseShell(ssh.payload), ssh.target); result = { effect: nested.effect, reason: nested.reasons[0] }; commands.push(...nested.commands); } }
    const command: ShellCommand = { name: executable.text, argv: argv.slice(commandIndex + 1), span: { start: executable.start, end: words.at(-1)!.end }, effect: result.effect, reason: result.reason, context };
    commands.push(command); if (result.reason) reasons.push(result.reason);
  }
  if (groupDepth) reasons.push("unclosed shell group");
  const finalToken = parsed.tokens.at(-1);
  if (expectCommand && finalToken?.kind === "op" && ["&&", "||", "|", "&"].includes(finalToken.text)) reasons.push("trailing shell operator");
  const complete = !reasons.some((reason) => /^(?:empty shell branch|unmatched|unclosed|trailing|dynamic|unsupported|invalid heredoc|heredoc bodies|background shell)/.test(reason));
  return summarize(source, complete, commands, reasons);
}
export const shellParser = { parse: parseShell };
