import { analyzeShellGraph } from "./ast-analysis.ts";
import { parseShellAst } from "./ast-parser.ts";
import type { ShellGraph } from "./ast.ts";
import type { ShellAnalysis, ShellContext } from "../types.ts";

const LOCAL_CONTEXT: ShellContext = { location: "local", usesNetwork: false };

export interface ShellParserDependencies {
  parseShellAst: (source: string) => ShellGraph;
  analyzeShellGraph: (graph: ShellGraph, context?: ShellContext) => ShellAnalysis;
}

export type ParsedShellInspection = { graph: ShellGraph; analysis: ShellAnalysis };

const defaultDependencies: ShellParserDependencies = { parseShellAst, analyzeShellGraph };

function failedAnalysis(source: string, context: ShellContext): ShellAnalysis {
  return {
    source,
    complete: false,
    effect: "unknown",
    reasons: ["structural shell parser failed closed"],
    commands: [],
    context,
    executionUnits: [{ id: 0, effect: "unknown", span: { start: 0, end: source.length } }],
  };
}

/** Builds a bounded parser whose unexpected failures always become one unknown unit. */
export function createShellInspector(dependencies: ShellParserDependencies = defaultDependencies) {
  return (source: string, context: ShellContext = LOCAL_CONTEXT): ParsedShellInspection => {
    try {
      const graph = dependencies.parseShellAst(source);
      return { graph, analysis: dependencies.analyzeShellGraph(graph, context) };
    }
    catch {
      return { graph: { root: { kind: "unsupported", reason: "structural shell parser failed closed", span: { start: 0, end: source.length } }, source, complete: false, errors: [], nodeCount: 0, maxDepth: 0 }, analysis: failedAnalysis(source, context) };
    }
  };
}

/** Compatibility view of the sole shell authorization parser. */
export function createShellParser(dependencies: ShellParserDependencies = defaultDependencies) {
  const inspect = createShellInspector(dependencies);
  return (source: string, context: ShellContext = LOCAL_CONTEXT) => inspect(source, context).analysis;
}

/** The sole shell authorization parser. */
export const inspectShell = createShellInspector();
export const parseShell = (source: string, context: ShellContext = LOCAL_CONTEXT) => inspectShell(source, context).analysis;
