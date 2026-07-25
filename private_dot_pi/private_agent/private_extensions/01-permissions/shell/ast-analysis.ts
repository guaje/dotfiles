import { classifyCurl } from "./curl.ts";
import { classifyProfile } from "./profiles.ts";
import { SHELL_GRAPH_LIMITS, type AstCommand, type AstSsh, type ShellGraph, type ShellNode } from "./ast.ts";
import type { ExecutionUnitSummary, ShellAnalysis, ShellCommand, ShellContext, ShellEffect } from "../types.ts";

const LOCAL_CONTEXT: ShellContext = { location: "local", usesNetwork: false };
const EFFECT_RANK: Record<ShellEffect, number> = { "read-only": 0, mutating: 1, unknown: 2 };
function combine(left: ShellEffect, right: ShellEffect): ShellEffect { return EFFECT_RANK[left] >= EFFECT_RANK[right] ? left : right; }
function unique(values: string[]) { return [...new Set(values)]; }

type NodeResult = { effect: ShellEffect; complete: boolean; reasons: string[]; commands: ShellCommand[] };
type Unwrapped = { index: number; reason?: string };

function unwrap(argv: string[]): Unwrapped {
  let index = 0;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index] ?? "")) return { index, reason: "leading environment assignments are not reviewed" };
  const wrapperName = argv[index];
  if (wrapperName === "command") {
    if (argv[index + 1] === "-v" && argv.length === index + 3) return { index };
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

type PreparedCommand = {
  argv: string[];
  unwrapped: Unwrapped;
  executableWord: AstCommand["words"][number];
  executableName: string;
  dependencyEffect: ShellEffect;
  complete: boolean;
  reasons: string[];
  nestedCommands: ShellCommand[];
};

function prepareCommand(node: AstCommand, inheritedContext: ShellContext, depth: number): PreparedCommand | NodeResult {
  const argv = node.words.map((word) => word.value);
  const unwrapped = unwrap(argv);
  const executableWord = node.words[unwrapped.index];
  if (!executableWord || !executableWord.literal || executableWord.substitutions.length > 0 || /^(?:function|alias|eval|source|\.|if|then|else|elif|fi|for|while|until|do|done|case|esac|select|coproc|\{|\})$/.test(executableWord.value)) {
    return { effect: "unknown", complete: false, reasons: ["dynamic or unsupported executable"], commands: [] };
  }
  if (node.words.some((word) => !word.literal && word.substitutions.length === 0)) {
    return { effect: "unknown", complete: false, reasons: ["unsupported dynamic shell expansion"], commands: [] };
  }

  let dependencyEffect: ShellEffect = "read-only";
  let complete = true;
  const reasons: string[] = [];
  const nestedCommands: ShellCommand[] = [];
  for (const word of node.words) {
    for (const substitution of word.substitutions) {
      const nested = analyzeShellGraph(substitution, inheritedContext, depth + 1);
      dependencyEffect = combine(dependencyEffect, nested.effect);
      reasons.push(...nested.reasons);
      nestedCommands.push(...nested.commands);
      complete &&= nested.complete;
    }
  }
  for (const redirection of node.redirections) {
    for (const substitution of redirection.target?.substitutions ?? []) {
      const nested = analyzeShellGraph(substitution, inheritedContext, depth + 1);
      dependencyEffect = combine(dependencyEffect, nested.effect);
      reasons.push(...nested.reasons);
      nestedCommands.push(...nested.commands);
      complete &&= nested.complete;
    }
    if (!redirection.supported || !redirection.target?.literal) {
      dependencyEffect = "unknown";
      reasons.push(redirection.reason ?? "unsupported redirection");
      complete = false;
      continue;
    }
    if ((redirection.operator === ">" || redirection.operator === ">>") && redirection.target.value !== "/dev/null") {
      dependencyEffect = combine(dependencyEffect, "mutating");
      reasons.push("output redirection writes a file");
    }
  }
  return {
    argv,
    unwrapped,
    executableWord,
    executableName: executableWord.value.replace(/^.*[\\/]/, "").toLowerCase(),
    dependencyEffect,
    complete,
    reasons,
    nestedCommands,
  };
}

function analyzeCommand(node: AstCommand, inheritedContext: ShellContext, depth: number): NodeResult {
  const prepared = prepareCommand(node, inheritedContext, depth);
  if (!("argv" in prepared)) return prepared;
  const { argv, unwrapped, executableWord, executableName } = prepared;
  let context = inheritedContext;
  let verdict = unwrapped.reason
    ? { effect: "unknown" as ShellEffect, reason: unwrapped.reason }
    : classifyProfile(executableWord.value, argv.slice(unwrapped.index + 1));
  if (executableName === "glab" || executableName === "gh" || executableName === "curl") {
    context = { ...inheritedContext, usesNetwork: true };
  }
  if (executableName === "curl") verdict = classifyCurl(argv.slice(unwrapped.index + 1));
  verdict.effect = combine(verdict.effect, prepared.dependencyEffect);
  const command: ShellCommand = {
    name: executableWord.value,
    argv: argv.slice(unwrapped.index + 1),
    span: { start: executableWord.span.start, end: node.words.at(-1)!.span.end },
    effect: verdict.effect,
    reason: verdict.reason,
    context,
  };
  return {
    effect: verdict.effect,
    complete: prepared.complete,
    reasons: unique([...prepared.reasons, ...(verdict.reason ? [verdict.reason] : [])]),
    commands: [...prepared.nestedCommands, command],
  };
}

function analyzeSsh(node: AstSsh, inheritedContext: ShellContext, depth: number): NodeResult {
  const prepared = prepareCommand(node.command, inheritedContext, depth);
  if (!("argv" in prepared)) return prepared;
  const context: ShellContext = node.target
    ? { location: "remote", transport: "ssh", target: node.target, usesNetwork: true }
    : inheritedContext;
  const dynamicArguments = node.command.words.slice(prepared.unwrapped.index + 1).some((word) => word.substitutions.length > 0);
  let verdict: { effect: ShellEffect; reason?: string } = prepared.unwrapped.reason
    ? { effect: "unknown", reason: prepared.unwrapped.reason }
    : dynamicArguments
      ? { effect: "unknown", reason: "ssh arguments contain local command substitution" }
      : node.reason
        ? { effect: "unknown", reason: node.reason }
        : { effect: node.invocationEffect };
  const payloadCommands: ShellCommand[] = [];
  const payloadReasons: string[] = [];
  let complete = prepared.complete;
  if (!dynamicArguments && node.payload && node.target && verdict.effect === "read-only") {
    const payload = analyzeShellGraph(node.payload, context, depth + 1);
    verdict = { effect: payload.effect, reason: payload.reasons[0] };
    payloadReasons.push(...payload.reasons);
    payloadCommands.push(...payload.commands);
    complete &&= payload.complete;
  }
  verdict.effect = combine(verdict.effect, prepared.dependencyEffect);
  const command: ShellCommand = {
    name: prepared.executableWord.value,
    argv: prepared.argv.slice(prepared.unwrapped.index + 1),
    span: { start: prepared.executableWord.span.start, end: node.command.words.at(-1)!.span.end },
    effect: verdict.effect,
    reason: verdict.reason,
    context,
  };
  return {
    effect: verdict.effect,
    complete,
    reasons: unique([...prepared.reasons, ...payloadReasons, ...(verdict.reason ? [verdict.reason] : [])]),
    commands: [...prepared.nestedCommands, ...payloadCommands, command],
  };
}

function analyzeNode(node: ShellNode, context: ShellContext, depth: number): NodeResult {
  if (node.kind === "unsupported") return { effect: "unknown", complete: false, reasons: [node.reason], commands: [] };
  if (node.kind === "command") return analyzeCommand(node, context, depth);
  if (node.kind === "wrapper") return analyzeCommand(node.command, context, depth);
  if (node.kind === "ssh") return analyzeSsh(node, context, depth);
  if (node.kind === "group") return analyzeNode(node.body, context, depth + 1);
  const children = node.kind === "pipeline" ? node.stages : node.units.map((unit) => unit.node);
  const results = children.map((child) => analyzeNode(child, context, depth + 1));
  return {
    effect: results.reduce((effect, result) => combine(effect, result.effect), "read-only" as ShellEffect),
    complete: results.every((result) => result.complete),
    reasons: unique(results.flatMap((result) => result.reasons)),
    commands: results.flatMap((result) => result.commands),
  };
}

export function analyzeShellGraph(graph: ShellGraph, context: ShellContext = LOCAL_CONTEXT, depth = 0): ShellAnalysis {
  const roots = graph.root.kind === "sequence" ? graph.root.units : [{ node: graph.root, operatorAfter: undefined }];
  const unitResults = roots.map((unit) => depth > SHELL_GRAPH_LIMITS.maxDepth
    ? { effect: "unknown" as ShellEffect, complete: false, reasons: ["shell analysis depth limit exceeded"], commands: [] }
    : analyzeNode(unit.node, context, depth));
  const executionUnits: ExecutionUnitSummary[] = unitResults.map((result, index) => ({
    id: index,
    effect: result.effect,
    span: roots[index]!.node.span,
    ...(roots[index]!.operatorAfter ? { operatorAfter: roots[index]!.operatorAfter } : {}),
  }));
  const reasons = unique([...graph.errors, ...unitResults.flatMap((result) => result.reasons)]);
  const complete = graph.complete && unitResults.every((result) => result.complete);
  const effect = complete
    ? unitResults.reduce((current, result) => combine(current, result.effect), "read-only" as ShellEffect)
    : "unknown";
  return {
    source: graph.source,
    complete,
    effect,
    reasons,
    commands: unitResults.flatMap((result) => result.commands),
    context,
    executionUnits,
  };
}
