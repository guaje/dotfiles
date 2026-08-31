import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { aaService } from "./service.ts";
import { isThinkingLevel, validateBatchMappings, type ThinkingLevel } from "./schema.ts";

const USAGE = `Usage: node agent/extensions/09-catalog/aa/cli.ts --missing|--check
       node agent/extensions/09-catalog/aa/cli.ts --discover provider/model
       node agent/extensions/09-catalog/aa/cli.ts --add provider/model --aa-model-id ID [--thinking-level LEVEL]
       node agent/extensions/09-catalog/aa/cli.ts --replace-batch FILE
       node agent/extensions/09-catalog/aa/cli.ts --refresh provider/model|--refresh-all

Snapshot-producing commands supplement null API evaluation components from the
canonical public model page. They never map uncallable Pi reasoning variants.`;
export interface CliIo { stdout(text: string): void; stderr(text: string): void; env: NodeJS.ProcessEnv; signal?: AbortSignal; }
function output(stream: NodeJS.WriteStream): (text: string) => void { return (text) => { stream.write(text); }; }
function tsv(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/[\x00-\x1f\x7f]/g, (character) => {
    if (character === "\t") return "\\t"; if (character === "\r") return "\\r"; if (character === "\n") return "\\n";
    return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}
function safeDynamic(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
}
function usage(io: CliIo): number { io.stderr(`${USAGE}\n`); return 2; }
function cleanupWarnings(io: CliIo, result: { warnings: string[] }): void { for (const warning of result.warnings) io.stderr(`artificial-analysis: warning: ${safeDynamic(warning)}\n`); }
async function readBatch(file: string): Promise<unknown> {
  const resolved = path.resolve(file); let info;
  try { info = await lstat(resolved); } catch { throw new Error(`missing batch file: ${path.basename(resolved)}`); }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error(`unsafe batch file: ${path.basename(resolved)}`);
  try { return JSON.parse(await readFile(resolved, "utf8")); } catch { throw new Error(`invalid JSON in ${path.basename(resolved)}`); }
}
export async function runCli(args: string[], io: CliIo = { stdout: output(process.stdout), stderr: output(process.stderr), env: process.env }): Promise<number> {
  if (!args.length) return usage(io);
  try {
    switch (args[0]) {
      case "--check": if (args.length !== 1) return usage(io); await aaService.check(io.env); io.stdout("Artificial Analysis snapshot is valid\n"); return 0;
      case "--missing": if (args.length !== 1) return usage(io); for (const id of await aaService.missing(io.env)) io.stdout(`${id}\n`); return 0;
      case "--discover": {
        if (args.length !== 2) return usage(io); const candidates = await aaService.discover(args[1]!, io.signal, io.env);
        for (const candidate of candidates) io.stdout(`${tsv(candidate.aaModelId)}\t${tsv(candidate.slug)}\t${tsv(candidate.name)}\n`); return 0;
      }
      case "--add": {
        if (args.length !== 4 && args.length !== 6 || args[2] !== "--aa-model-id" || (args.length === 6 && args[4] !== "--thinking-level")) return usage(io);
        const level: unknown = args.length === 6 ? args[5] : null; if (!isThinkingLevel(level)) throw new Error("invalid thinking level"); cleanupWarnings(io, await aaService.add(args[1]!, args[3]!, level as ThinkingLevel, io.signal, io.env)); return 0;
      }
      case "--replace-batch": {
        if (args.length !== 2) return usage(io); const value = await readBatch(args[1]!); if (!validateBatchMappings(value)) throw new Error("invalid, duplicate, or mixed generic/variant batch mapping"); cleanupWarnings(io, await aaService.replaceBatch(value, io.signal, io.env)); return 0;
      }
      case "--refresh": if (args.length !== 2) return usage(io); cleanupWarnings(io, await aaService.refresh(args[1]!, io.signal, io.env)); return 0;
      case "--refresh-all": if (args.length !== 1) return usage(io); cleanupWarnings(io, await aaService.refreshAll(io.signal, io.env)); return 0;
      default: return usage(io);
    }
  } catch (error) { io.stderr(`artificial-analysis: ${safeDynamic(error instanceof Error ? error.message : "operation failed")}\n`); return 1; }
}

const direct = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url : false;
if (direct) void runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
