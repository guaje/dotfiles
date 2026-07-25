import { parseSsh } from "./ssh.ts";
import { SHELL_GRAPH_LIMITS, type AstCommand, type AstRedirection, type AstWord, type SequenceOperator, type ShellGraph, type ShellNode, type Span } from "./ast.ts";

const STRUCTURAL_WRAPPERS = new Set(["command", "env", "timeout", "sudo", "doas", "su", "xargs", "nohup"]);

type Token = { kind: "word" | "op"; text: string; span: Span; word?: AstWord };
type ParseOptions = { depth?: number; offset?: number };

function unsupportedGraph(source: string, reason: string, offset = 0, depth = 0): ShellGraph {
  return { root: { kind: "unsupported", reason, span: { start: offset, end: offset + source.length } }, source, complete: false, errors: [reason], nodeCount: 1, maxDepth: depth };
}

function matchingParen(source: string, openParen: number) {
  let depth = 1;
  let quote: "'" | '"' | undefined;
  for (let index = openParen + 1; index < source.length; index++) {
    const current = source[index]!;
    if (current === "\\") { index++; continue; }
    if (quote) { if (current === quote) quote = undefined; continue; }
    if (current === "'" || current === '"') { quote = current; continue; }
    if (source.startsWith("$(", index)) { depth++; index++; continue; }
    if (current === ")" && --depth === 0) return index;
  }
  return -1;
}

function lex(source: string, depth: number, offset: number): { tokens: Token[]; errors: string[]; nestedNodes: number; maxDepth: number } {
  const tokens: Token[] = [];
  const errors: string[] = [];
  let nestedNodes = 0;
  let deepest = depth;
  let index = 0;
  const pushOp = (text: string, start: number, length = text.length) => tokens.push({ kind: "op", text, span: { start: offset + start, end: offset + start + length } });

  while (index < source.length) {
    if (source[index] === "\n") {
      const previous = tokens.at(-1);
      if (previous?.kind === "word" || previous?.text === ")") pushOp("\n", index);
      index++;
      continue;
    }
    if (/\s/.test(source[index]!)) { index++; continue; }
    if (source[index] === "#") { while (index < source.length && source[index] !== "\n") index++; continue; }
    if (source.startsWith("$((", index)) { errors.push("arithmetic substitution is not supported"); break; }
    if (source.startsWith("<(", index) || source.startsWith(">(", index)) { errors.push("process substitution is not supported"); break; }
    if (source[index] === "`") { errors.push("backtick command substitution is not supported"); break; }

    const pair = source.slice(index, index + 2);
    const triple = source.slice(index, index + 3);
    if (triple === "<<<" || pair === "<<") { errors.push("heredoc and here-string input is not reviewed"); break; }
    if (["&&", "||", ">>"].includes(pair)) { pushOp(pair, index); index += 2; continue; }
    if (";|&()<>".includes(source[index]!)) { pushOp(source[index]!, index); index++; continue; }

    const start = index;
    let value = "";
    let literal = true;
    const substitutions: ShellGraph[] = [];
    while (index < source.length && !/\s/.test(source[index]!) && !";&|<>()".includes(source[index]!)) {
      const current = source[index]!;
      if (current === "'") {
        const close = source.indexOf("'", index + 1);
        if (close < 0) { errors.push("unterminated quote"); index = source.length; break; }
        value += source.slice(index + 1, close);
        index = close + 1;
        continue;
      }
      if (current === '"') {
        index++;
        let closed = false;
        while (index < source.length) {
          if (source[index] === '"') { closed = true; index++; break; }
          if (source[index] === "\\") {
            if (index + 1 >= source.length) { errors.push("trailing escape"); index++; break; }
            value += source[index + 1]!; index += 2; continue;
          }
          if (source.startsWith("$((", index)) { errors.push("arithmetic substitution is not supported"); index = source.length; break; }
          if (source.startsWith("$(", index)) {
            const close = matchingParen(source, index + 1);
            if (close < 0) { errors.push("unterminated command substitution"); index = source.length; break; }
            const nestedSource = source.slice(index + 2, close);
            const nested = parseShellAst(nestedSource, { depth: depth + 1, offset: offset + index + 2 });
            substitutions.push(nested); nestedNodes += nested.nodeCount; deepest = Math.max(deepest, nested.maxDepth);
            value += source.slice(index, close + 1); index = close + 1; continue;
          }
          if (source[index] === "`") { errors.push("backtick command substitution is not supported"); index = source.length; break; }
          if (source[index] === "$") literal = false;
          value += source[index++]!;
        }
        if (!closed && !errors.length) errors.push("unterminated quote");
        continue;
      }
      if (source.startsWith("$(", index)) {
        const close = matchingParen(source, index + 1);
        if (close < 0) { errors.push("unterminated command substitution"); index = source.length; break; }
        const nestedSource = source.slice(index + 2, close);
        const nested = parseShellAst(nestedSource, { depth: depth + 1, offset: offset + index + 2 });
        substitutions.push(nested); nestedNodes += nested.nodeCount; deepest = Math.max(deepest, nested.maxDepth);
        value += source.slice(index, close + 1); index = close + 1; continue;
      }
      if (current === "`") { errors.push("backtick command substitution is not supported"); index = source.length; break; }
      if (current === "$") literal = false;
      if (current === "\\") {
        if (index + 1 >= source.length) { errors.push("trailing escape"); index++; break; }
        value += source[index + 1]!; index += 2; continue;
      }
      value += current;
      index++;
    }
    if (errors.length) break;
    if (!value) { errors.push("unsupported shell token"); break; }
    const word: AstWord = { value, raw: source.slice(start, index), span: { start: offset + start, end: offset + index }, literal, substitutions };
    tokens.push({ kind: "word", text: value, span: word.span, word });
  }

  while (tokens.at(-1)?.text === "\n") tokens.pop();
  return { tokens, errors, nestedNodes, maxDepth: deepest };
}

class Parser {
  private index = 0;
  nodeCount = 0;
  errors: string[] = [];
  constructor(private tokens: Token[], private source: string, private offset: number, private depth: number) {}

  private node<T extends ShellNode>(value: T): T { this.nodeCount++; return value; }
  private peek() { return this.tokens[this.index]; }
  private take() { return this.tokens[this.index++]; }

  parse(): ShellNode {
    if (!this.tokens.length) return this.node({ kind: "unsupported", reason: "shell command is empty", span: { start: this.offset, end: this.offset } });
    const root = this.sequence();
    if (this.index < this.tokens.length) {
      const token = this.peek()!;
      const reason = token.text === "&" ? "background shell execution is not reviewed" : `unsupported shell token: ${token.text}`;
      this.errors.push(reason);
      return this.node({ kind: "unsupported", reason, span: { start: this.offset, end: this.offset + this.source.length } });
    }
    return root;
  }

  private sequence(stopAtGroup = false): ShellNode {
    const units: Array<{ node: ShellNode; operatorAfter?: SequenceOperator }> = [];
    const first = this.pipeline(stopAtGroup);
    units.push({ node: first });
    while (true) {
      const token = this.peek();
      if (!token || token.kind !== "op" || ![";", "\n", "&&", "||"].includes(token.text)) break;
      const operator = this.take()!.text as SequenceOperator;
      if (!this.peek() || (stopAtGroup && this.peek()!.text === ")")) {
        if (operator !== ";" && operator !== "\n") this.errors.push("trailing shell operator");
        break;
      }
      units.at(-1)!.operatorAfter = operator;
      units.push({ node: this.pipeline(stopAtGroup) });
    }
    if (units.length === 1) return first;
    return this.node({ kind: "sequence", units, span: { start: units[0]!.node.span.start, end: units.at(-1)!.node.span.end } });
  }

  private pipeline(stopAtGroup: boolean): ShellNode {
    const stages: ShellNode[] = [this.unit(stopAtGroup)];
    while (this.peek()?.text === "|") {
      this.take();
      if (!this.peek() || this.peek()!.text === ")") { this.errors.push("trailing shell operator"); break; }
      stages.push(this.unit(stopAtGroup));
    }
    if (stages.length === 1) return stages[0]!;
    return this.node({ kind: "pipeline", stages, span: { start: stages[0]!.span.start, end: stages.at(-1)!.span.end } });
  }

  private unit(stopAtGroup: boolean): ShellNode {
    const token = this.peek();
    if (!token) return this.node({ kind: "unsupported", reason: "empty shell branch", span: { start: this.offset + this.source.length, end: this.offset + this.source.length } });
    if (token.text === "&") { this.take(); return this.node({ kind: "unsupported", reason: "background shell execution is not reviewed", span: { start: this.offset, end: this.offset + this.source.length } }); }
    if (token.text === "(") {
      const open = this.take()!;
      const body = this.sequence(true);
      const close = this.peek();
      if (!close || close.text !== ")") { this.errors.push("unclosed shell group"); return this.node({ kind: "unsupported", reason: "unclosed shell group", span: { start: open.span.start, end: body.span.end } }); }
      this.take();
      return this.node({ kind: "group", body, span: { start: open.span.start, end: close.span.end } });
    }
    if (token.text === ")" && stopAtGroup) return this.node({ kind: "unsupported", reason: "empty shell group", span: token.span });
    return this.command();
  }

  private command(): ShellNode {
    const words: AstWord[] = [];
    const redirections: AstRedirection[] = [];
    let start = this.peek()?.span.start ?? this.offset;
    let end = start;
    while (this.peek()) {
      const token = this.peek()!;
      if (token.kind === "op" && [";", "\n", "&&", "||", "|", "&", ")", "("].includes(token.text)) break;
      if (token.kind === "op" && [">", ">>", "<", "<<", "<<<"].includes(token.text)) {
        const operator = this.take()!;
        const target = this.peek()?.kind === "word" ? this.take()!.word : undefined;
        const heredoc = operator.text === "<<" || operator.text === "<<<";
        const reason = heredoc ? "heredoc and here-string input is not reviewed" : !target ? "redirection target is missing or dynamic" : undefined;
        redirections.push({ kind: "redirection", operator: operator.text as AstRedirection["operator"], target, span: { start: operator.span.start, end: target?.span.end ?? operator.span.end }, supported: !reason, reason });
        end = target?.span.end ?? operator.span.end;
        continue;
      }
      if (token.kind !== "word") break;
      const word = this.take()!.word!;
      words.push(word); end = word.span.end;
    }
    if (!words.length) {
      const reason = "dynamic or unsupported executable";
      this.errors.push(reason);
      return this.node({ kind: "unsupported", reason, span: { start, end } });
    }
    const value: AstCommand = this.node({ kind: "command", words, redirections, span: { start, end } });
    const executable = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value))?.value.replace(/^.*[\\/]/, "").toLowerCase();
    if (executable === "ssh") {
      const invocation = parseSsh(words.slice(1).map((word) => word.value), this.source, words[0]!.span.start - this.offset);
      const payload = invocation.payload && this.depth + 1 <= SHELL_GRAPH_LIMITS.maxDepth
        ? parseShellAst(invocation.payload, { depth: this.depth + 1, offset: invocation.payloadSpan ? this.offset + invocation.payloadSpan.start : 0 })
        : undefined;
      const payloadDepthExceeded = Boolean(invocation.payload && !payload);
      return this.node({
        kind: "ssh",
        command: value,
        target: invocation.target,
        payload,
        invocationEffect: payloadDepthExceeded ? "unknown" : invocation.effect,
        reason: invocation.reason ?? (payloadDepthExceeded ? "shell analysis depth limit exceeded" : undefined),
        span: value.span,
      });
    }
    if (executable && STRUCTURAL_WRAPPERS.has(executable)) return this.node({ kind: "wrapper", name: executable, command: value, span: value.span });
    return value;
  }
}

export function parseShellAst(source: string, options: ParseOptions = {}): ShellGraph {
  const depth = options.depth ?? 0;
  const offset = options.offset ?? 0;
  if (source.length > SHELL_GRAPH_LIMITS.maxSourceLength) return unsupportedGraph(source, "shell source length limit exceeded", offset, depth);
  if (depth > SHELL_GRAPH_LIMITS.maxDepth) return unsupportedGraph(source, "shell analysis depth limit exceeded", offset, depth);
  const lexed = lex(source, depth, offset);
  if (lexed.errors.length) return unsupportedGraph(source, lexed.errors[0]!, offset, lexed.maxDepth);
  const parser = new Parser(lexed.tokens, source, offset, depth);
  const root = parser.parse();
  const errors = [...parser.errors];
  if (root.kind === "unsupported" && !errors.includes(root.reason)) errors.push(root.reason);
  const nodeCount = parser.nodeCount + lexed.nestedNodes + embeddedPayloadNodes(root);
  if (nodeCount > SHELL_GRAPH_LIMITS.maxNodes) return unsupportedGraph(source, "shell analysis node limit exceeded", offset, lexed.maxDepth);
  const structuralDepth = Math.max(lexed.maxDepth, nodeDepth(root, depth));
  if (structuralDepth > SHELL_GRAPH_LIMITS.maxDepth) return unsupportedGraph(source, "shell analysis depth limit exceeded", offset, structuralDepth);
  const nestedErrors = collectNestedErrors(root);
  errors.push(...nestedErrors);
  return { root, source, complete: errors.length === 0, errors: [...new Set(errors)], nodeCount, maxDepth: structuralDepth };
}

function embeddedPayloadNodes(node: ShellNode): number {
  if (node.kind === "sequence") return node.units.reduce((count, unit) => count + embeddedPayloadNodes(unit.node), 0);
  if (node.kind === "pipeline") return node.stages.reduce((count, stage) => count + embeddedPayloadNodes(stage), 0);
  if (node.kind === "group") return embeddedPayloadNodes(node.body);
  if (node.kind === "wrapper") return embeddedPayloadNodes(node.command);
  if (node.kind === "ssh") return (node.payload?.nodeCount ?? 0) + embeddedPayloadNodes(node.command);
  return 0;
}

function nodeDepth(node: ShellNode, depth: number): number {
  if (node.kind === "unsupported") return depth;
  if (node.kind === "sequence") return Math.max(depth, ...node.units.map((unit) => nodeDepth(unit.node, depth + 1)));
  if (node.kind === "pipeline") return Math.max(depth, ...node.stages.map((stage) => nodeDepth(stage, depth + 1)));
  if (node.kind === "group") return nodeDepth(node.body, depth + 1);
  if (node.kind === "wrapper") return nodeDepth(node.command, depth + 1);
  if (node.kind === "ssh") return Math.max(nodeDepth(node.command, depth + 1), node.payload?.maxDepth ?? depth);
  return Math.max(depth, ...node.words.flatMap((word) => word.substitutions.map((graph) => graph.maxDepth)), ...node.redirections.flatMap((redirection) => redirection.target?.substitutions.map((graph) => graph.maxDepth) ?? []));
}

function collectNestedErrors(node: ShellNode): string[] {
  if (node.kind === "unsupported") return [node.reason];
  if (node.kind === "sequence") return node.units.flatMap((unit) => collectNestedErrors(unit.node));
  if (node.kind === "pipeline") return node.stages.flatMap(collectNestedErrors);
  if (node.kind === "group") return collectNestedErrors(node.body);
  if (node.kind === "wrapper") return collectNestedErrors(node.command);
  if (node.kind === "ssh") return collectNestedErrors(node.command).concat(node.payload?.errors ?? []);
  return node.words.flatMap((word) => word.substitutions.flatMap((graph) => graph.errors)).concat(node.redirections.flatMap((redirection) => [...(redirection.reason ? [redirection.reason] : []), ...(redirection.target?.substitutions.flatMap((graph) => graph.errors) ?? [])]));
}
