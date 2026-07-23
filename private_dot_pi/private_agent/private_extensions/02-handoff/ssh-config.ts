import { glob } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { MAX_SSH_CONFIG_BYTES, MAX_SSH_CONFIG_DEPTH, MAX_SSH_CONFIG_FILES } from "./config.ts";
import type { SshHost } from "./types.ts";

function uncomment(line: string) { let quote = ""; let out = ""; for (let i = 0; i < line.length; i++) { const c = line[i]!; if ((c === "'" || c === '"') && line[i - 1] !== "\\") quote = quote === c ? "" : quote || c; if (c === "#" && !quote) break; out += c; } return out.trim(); }
function words(line: string) { const m = uncomment(line).match(/^([^\s=]+)\s*(?:=\s*|\s+)(.*)$/); if (!m) return []; const value = m[2]!.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"); return [m[1]!.toLowerCase(), ...value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((v) => v.replace(/^(?:"|')|(?:"|')$/g, "")) ?? []]; }
function concrete(alias: string) { return !!alias && !/[*!?]/.test(alias); }

/** Focused OpenSSH Host/Include discovery. It intentionally does not evaluate Match. */
export async function discoverSshHosts(configPath = resolve(homedir(), ".ssh/config")): Promise<SshHost[]> {
  const found = new Map<string, SshHost>(); const visited = new Set<string>(); let bytes = 0;
  async function visit(path: string, depth: number): Promise<void> {
    if (depth > MAX_SSH_CONFIG_DEPTH || visited.size >= MAX_SSH_CONFIG_FILES) return;
    const real = resolve(path); if (visited.has(real)) return; visited.add(real);
    let text: string; try { text = await readFile(real, "utf8"); } catch { return; }
    bytes += Buffer.byteLength(text); if (bytes > MAX_SSH_CONFIG_BYTES) return;
    for (const raw of text.split(/\r?\n/)) { const [key, ...values] = words(raw); if (!key) continue;
      if (key === "host") for (const alias of values) if (concrete(alias) && !found.has(alias)) found.set(alias, { alias, source: real });
      if (key === "include") for (const item of values) { const pattern = item.replace(/^~/, homedir()); const absolute = isAbsolute(pattern) ? pattern : resolve(dirname(real), pattern); try { for await (const child of glob(absolute)) await visit(child, depth + 1); } catch { /* unsupported glob: ignore */ } }
    }
  }
  await visit(configPath, 0); return [...found.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}
export function validateManualTarget(host: string, user?: string, port?: string | number) { if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) throw new Error("Invalid SSH host"); if (user && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(user)) throw new Error("Invalid SSH user"); const n = port === undefined || port === "" ? undefined : Number(port); if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 65535)) throw new Error("Invalid SSH port"); return { host, user, port: n }; }
