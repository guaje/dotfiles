/**
 * Shared, race-free package stubs for test suites that load real extension
 * modules under tsx/Node resolution.
 *
 * Bare `@earendil-works/*` and `typebox` imports only resolve at pi bundle
 * time, so tests materialise stubs into `agent/extensions/node_modules/`.
 * node:test runs test files in parallel worker processes that all share that
 * directory, and leftover stubs would shadow the real packages in a live pi
 * session, so the manager installs the SAME union content from every suite,
 * holds one per-process reference, and only the process that sees no
 * remaining references removes the stubs. Stale references (dead pid or older
 * than a day) are collected before acquiring.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// tests/helpers/ -> ../.. -> agent/extensions
const NODE_MODULES = resolve(HERE, "../../node_modules");
const REFS_DIR = resolve(NODE_MODULES, ".test-stub-refs");
const REF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

const PACKAGES: Record<string, string> = {
  "@earendil-works/pi-ai": [
    "export function StringEnum(values, options = {}) { return { type: 'string', enum: [...values], ...options }; }",
    "export async function completeSimple() { return { role: 'assistant', content: [], usage: {} }; }",
  ].join("\n"),
  "@earendil-works/pi-coding-agent": [
    "export function getAgentDir() { return globalThis.__subagentAgentDir || '/nonexistent-subagent-test'; }",
    PARSE_FRONTMATTER,
    "export function getMarkdownTheme() { return {}; }",
    "export function withFileMutationQueue(_p, fn) { return fn(); }",
    "export function isToolCallEventType(name, event) { return event?.toolName === name; }",
    "export function createBashTool(cwd, options) {",
    "  return {",
    "    name: 'bash', label: 'bash', description: 'stub bash', parameters: { type: 'object' }, promptGuidelines: ['original guideline'],",
    "    async execute(_id, params) { return { content: [{ type: 'text', text: params.command }], details: { cwd, remote: Boolean(options?.operations) } }; },",
    "  };",
    "}",
  ].join("\n"),
  "@earendil-works/pi-tui": [
    "const strip = (value) => String(value).replace(/\\x1b\\[[0-?]*[ -\\/]*[@-~]/g, \"\");",
    "export function visibleWidth(value) { return [...strip(value)].length; }",
    "export function truncateToWidth(value, width, marker = \"\") {",
    "  const text = String(value);",
    "  if (visibleWidth(text) <= width) return text;",
    "  return [...strip(text)].slice(0, Math.max(0, width - visibleWidth(marker))).join(\"\") + marker;",
    "}",
    "export const Key = { escape: 'escape', up: 'up', down: 'down', pageUp: 'pageUp', pageDown: 'pageDown', home: 'home', end: 'end', space: 'space', ctrl: (k) => `ctrl+${k}` };",
    "export function matchesKey(data, key) { return data === key || (key === 'escape' && data === '\\x1b') || (key === 'ctrl+c' && data === '\\x03'); }",
    "export class Container { constructor() { this.children = []; } addChild(c) { this.children.push(c); return c; } }",
    "export class Text { constructor(text) { this.text = text; } }",
    "export class Spacer { constructor(n) { this.n = n; this.size = n; } }",
    "export class Markdown { constructor(text) { this.text = text; } }",
    "export class SelectList { constructor(options) { this.options = options; } setSelectedIndex(index) { this.selectedIndex = index; } }",
  ].join("\n"),
  "typebox": [
    "export const Type = {",
    "  Object(properties) { return { type: 'object', properties }; },",
    "  Optional(schema) { return { ...schema, optional: true }; },",
    "  Array(items, options = {}) { return { type: 'array', items, ...options }; },",
    "  String(options = {}) { return { type: 'string', ...options }; },",
    "  Boolean(options = {}) { return { type: 'boolean', ...options }; },",
    "};",
  ].join("\n"),
};

let refFile: string | null = null;

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function collectStaleRefs(): void {
  let entries: string[];
  try { entries = readdirSync(REFS_DIR); } catch { return; }
  const now = Date.now();
  for (const name of entries) {
    if (!name.endsWith(".ref")) continue;
    const [pidRaw, createdAtRaw] = name.slice(0, -".ref".length).split("-");
    const pid = Number(pidRaw);
    const createdAt = Number(createdAtRaw);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(createdAt) || now - createdAt > REF_MAX_AGE_MS || !processAlive(pid)) {
      try { rmSync(resolve(REFS_DIR, name), { force: true }); } catch { /* best effort */ }
    }
  }
}

function writePackages(): void {
  for (const [name, indexContent] of Object.entries(PACKAGES)) {
    const dir = resolve(NODE_MODULES, ...name.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "package.json"), JSON.stringify({ name, type: "module", exports: "./index.js" }));
    writeFileSync(resolve(dir, "index.js"), `${indexContent}\n`);
  }
}

function packagesPresent(): boolean {
  return Object.keys(PACKAGES).every((name) => existsSync(resolve(NODE_MODULES, ...name.split("/"), "package.json")));
}

/** Install the shared union stubs and hold this process's reference. */
export function installPackageStubs(): void {
  mkdirSync(REFS_DIR, { recursive: true });
  collectStaleRefs();
  if (!refFile) {
    for (let attempt = 0; !refFile && attempt < 16; attempt++) {
      const candidate = resolve(REFS_DIR, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ref`);
      try { writeFileSync(candidate, String(process.pid), { flag: "wx" }); refFile = candidate; }
      catch { refFile = null; }
    }
    if (!refFile) throw new Error("unable to acquire a shared package-stub reference");
  }
  writePackages();
  // A finishing process may remove the stubs while this one installs; rewrite until stable.
  for (let attempt = 0; attempt < 3 && !packagesPresent(); attempt++) writePackages();
}

/** Drop this process's reference; the last process removes the stubs. */
export function releasePackageStubs(): void {
  const ref = refFile;
  refFile = null;
  try { if (ref) rmSync(ref, { force: true }); } catch { /* best effort */ }
  try {
    if (readdirSync(REFS_DIR).filter((name) => name.endsWith(".ref")).length === 0) {
      for (const name of Object.keys(PACKAGES)) rmSync(resolve(NODE_MODULES, ...name.split("/")), { recursive: true, force: true });
    }
  } catch { /* best effort */ }
}
