import { analyzeShellGraph } from "./ast-analysis.ts";
import { parseShellAst } from "./ast-parser.ts";
import type { ShellGraph } from "./ast.ts";
import type { ShellAnalysis, ShellContext } from "../types.ts";

const LOCAL_CONTEXT: ShellContext = { location: "local", usesNetwork: false };

export interface ShellParserDependencies {
  parseShellAst: (source: string) => ShellGraph;
  analyzeShellGraph: (graph: ShellGraph, context?: ShellContext) => ShellAnalysis;
}

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
export function createShellParser(dependencies: ShellParserDependencies = defaultDependencies) {
  return (source: string, context: ShellContext = LOCAL_CONTEXT): ShellAnalysis => {
    try {
      return dependencies.analyzeShellGraph(dependencies.parseShellAst(source), context);
    }
    catch {
      return failedAnalysis(source, context);
    }
  };
}

/** The sole shell authorization parser. */
export const parseShell = createShellParser();
