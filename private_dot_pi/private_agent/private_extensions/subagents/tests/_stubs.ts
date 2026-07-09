/**
 * Shared package-stub writer for subagent tests.
 *
 * Subagent source modules import bare packages (@earendil-works/*, typebox)
 * that only resolve at pi bundle time. Tests run under tsx (Node resolution),
 * so we materialise minimal stubs into agent/extensions/node_modules/ before
 * importing a testable copy of the module under test.
 *
 * Each subagent test writes the SAME superset stubs, so the three test files
 * are safe to run in any order (and even in a shared process).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// subagent/tests/ -> ../.. -> agent/extensions
const NODE_MODULES = resolve(HERE, "../../node_modules");

function writePkg(name: string, indexContent: string): void {
	const dir = resolve(NODE_MODULES, ...name.split("/"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		resolve(dir, "package.json"),
		JSON.stringify({ name, type: "module", exports: "./index.js" }),
	);
	writeFileSync(resolve(dir, "index.js"), `${indexContent}\n`);
}

/**
 * Minimal YAML frontmatter parser matching pi's parseFrontmatter for the
 * `key: value` lines used by agent fixtures.
 */
const PARSE_FRONTMATTER = `
export function parseFrontmatter(content) {
  const m = content.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?([\\s\\S]*)$/);
  if (!m) return { frontmatter: {}, body: content };
  const frontmatter = {};
  for (const line of m[1].split(/\\r?\\n/)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    frontmatter[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { frontmatter, body: m[2] };
}
`.trim();

export function writePackageStubs(): void {
	writePkg(
		"@earendil-works/pi-ai",
		[
			"export async function completeSimple(model, context, options) { if (typeof globalThis.__subagentCompleteSimple === 'function') return globalThis.__subagentCompleteSimple(model, context, options); throw new Error('completeSimple not mocked'); }",
			"export function StringEnum(values, options = {}) { return { type: 'string', enum: [...values], ...options }; }",
		].join("\n"),
	);

	writePkg(
		"@earendil-works/pi-coding-agent",
		[
			"export function getAgentDir() { return globalThis.__subagentAgentDir || '/nonexistent-subagent-test'; }",
			PARSE_FRONTMATTER,
			"export function getMarkdownTheme() { return {}; }",
			"export function withFileMutationQueue(_p, fn) { return fn(); }",
		].join("\n"),
	);

	writePkg(
		"@earendil-works/pi-tui",
		[
			"export class Container { constructor() { this.children = []; } addChild(c) { this.children.push(c); return c; } }",
			"export class Text { constructor(text) { this.text = text; } }",
			"export class Spacer { constructor(n) { this.n = n; } }",
			"export class Markdown { constructor(text) { this.text = text; } }",
		].join("\n"),
	);

	writePkg(
		"typebox",
		[
			"export const Type = {",
			"  Object(properties) { return { type: 'object', properties }; },",
			"  Optional(schema) { return { ...schema, optional: true }; },",
			"  Array(items, options = {}) { return { type: 'array', items, ...options }; },",
			"  String(options = {}) { return { type: 'string', ...options }; },",
			"  Boolean(options = {}) { return { type: 'boolean', ...options }; },",
			"};",
		].join("\n"),
	);
}
