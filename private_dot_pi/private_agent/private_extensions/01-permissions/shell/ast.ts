import type { ShellEffect } from "../types.ts";

export type Span = { start: number; end: number };
export type SequenceOperator = ";" | "\n" | "&&" | "||";

export interface AstWord {
  value: string;
  raw: string;
  span: Span;
  literal: boolean;
  substitutions: ShellGraph[];
}

export interface AstRedirection {
  kind: "redirection";
  operator: ">" | ">>" | "<" | "<<" | "<<<" | "fd";
  target?: AstWord;
  span: Span;
  supported: boolean;
  reason?: string;
}

export interface AstCommand {
  kind: "command";
  words: AstWord[];
  redirections: AstRedirection[];
  span: Span;
}

export interface AstPipeline {
  kind: "pipeline";
  stages: ShellNode[];
  span: Span;
}

export interface AstSequence {
  kind: "sequence";
  units: Array<{ node: ShellNode; operatorAfter?: SequenceOperator }>;
  span: Span;
}

export interface AstGroup {
  kind: "group";
  body: ShellNode;
  span: Span;
}

export interface AstWrapper {
  kind: "wrapper";
  name: string;
  command: AstCommand;
  span: Span;
}

export interface AstSsh {
  kind: "ssh";
  command: AstCommand;
  target?: string;
  payload?: ShellGraph;
  invocationEffect: ShellEffect;
  reason?: string;
  span: Span;
}

export interface AstUnsupported {
  kind: "unsupported";
  reason: string;
  span: Span;
}

export type ShellNode = AstCommand | AstPipeline | AstSequence | AstGroup | AstWrapper | AstSsh | AstUnsupported;

export interface ShellGraph {
  root: ShellNode;
  source: string;
  complete: boolean;
  errors: string[];
  nodeCount: number;
  maxDepth: number;
}

export interface AnalyzedNode {
  effect: ShellEffect;
  complete: boolean;
  reasons: string[];
}

export const SHELL_GRAPH_LIMITS = { maxSourceLength: 32 * 1024, maxNodes: 256, maxDepth: 8 } as const;
