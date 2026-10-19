/**
 * Display-only program extraction for the approval dialog.
 *
 * This helper is presentation metadata only: it must never feed authorization
 * decisions, identity verification, or remembered session approvals. The strict
 * structural parser (shell/parser.ts) remains the sole authority for effects.
 * It exists so that when the strict parser fails closed and yields no flattened
 * commands, the human still sees which programs a command appears to run
 * instead of "No supported command detected.".
 */

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Drops heredoc bodies so their lines are never listed as programs. */
function stripHeredocBodies(source: string): string {
  const kept: string[] = [];
  let delimiter: string | undefined;
  for (const line of source.split("\n")) {
    if (delimiter) {
      if (line.trim() === delimiter) delimiter = undefined;
      continue;
    }
    kept.push(line);
    const match = /<<-?\s*\\?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (match) delimiter = match[2]!;
  }
  return kept.join("\n");
}

/** Quote-aware scan that keeps track of whether an index is inside quotes. */
function scanSegments(source: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const flushWord = () => { if (word) { current.push(word); word = ""; } };
  const flushSegment = () => { flushWord(); if (current.length) segments.push(current); current = []; };
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (escaped) { word += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = undefined; word += char; continue; }
    if (char === "'" || char === '"') { quote = char; word += char; continue; }
    if (char === "&" && (source[index - 1] === ">" || source[index + 1] === ">")) { word += char; continue; }
    if (char === ";" || char === "\n" || char === "&" || char === "|") { flushSegment(); continue; }
    if (char === "#" && !word.trim()) { while (index < source.length && source[index] !== "\n") index++; continue; }
    if (/\s/.test(char)) { flushWord(); continue; }
    word += char;
  }
  flushSegment();
  return segments;
}

/** Extracts program substitutions nested inside $(...) anywhere in a segment token. */
function nestedPrograms(token: string): string[] {
  const names: string[] = [];
  let index = 0;
  while ((index = token.indexOf("$(", index)) >= 0) {
    let level = 1;
    let close = index + 2;
    let quote: "'" | '"' | undefined;
    for (; close < token.length && level > 0; close++) {
      const char = token[close]!;
      if (quote) { if (char === quote) quote = undefined; continue; }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (token.startsWith("$(", close)) { level++; close++; continue; }
      if (char === ")") level--;
    }
    const body = token.slice(index + 2, close - 1);
    for (const segment of scanSegments(body)) {
      const program = segmentPrograms(segment);
      if (program.name) names.push(...program.nested, program.name);
      else names.push(...program.nested);
    }
    index = close;
  }
  return names;
}

type Program = { name?: string; nested: string[] };

function segmentPrograms(segment: string[]): Program {
  const nested: string[] = [];
  let name: string | undefined;
  for (const token of segment) {
    nested.push(...nestedPrograms(token));
    if (name !== undefined) continue;
    if (/^\d+$/.test(token)) continue;
    if (ASSIGNMENT.test(token)) continue;
    if (token.startsWith("-") || token.startsWith(">") || token.startsWith("<")) continue;
    const bare = token.replace(/\$\(.*/, "");
    if (bare) name = bare;
  }
  return { name, nested };
}

/**
 * Lists apparent program names for display, in order of appearance.
 * Tolerant of syntax the strict parser refuses (heredocs, descriptor
 * duplication, unusual redirections); never used for authorization.
 */
export function extractProgramsForDisplay(source: string): string[] {
  const names: string[] = [];
  for (const segment of scanSegments(stripHeredocBodies(source).replace(/\\\n/g, " "))) {
    const program = segmentPrograms(segment);
    for (const name of [...program.nested, ...(program.name ? [program.name] : [])]) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}
