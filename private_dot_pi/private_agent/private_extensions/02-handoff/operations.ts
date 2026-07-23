import type { BashOperations, EditOperations, FindOperations, GrepOperations, LsOperations, ReadOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import { PathBoundaryError } from "./errors.ts";
import { shellLiteral, sshExec, type SshTransportOptions } from "./transport.ts";

export interface RemoteOperationsOptions extends SshTransportOptions { workspace: string; localCwd: string; }
function remotePath(options: RemoteOperationsOptions, input: string) { const relative = input.startsWith(options.localCwd) ? input.slice(options.localCwd.length) : input; const pieces = relative.replace(/^\/+/, "").split("/"); if (input.startsWith("/") && !input.startsWith(options.localCwd)) throw new PathBoundaryError(input); if (pieces.some((piece) => piece === "..")) throw new PathBoundaryError(input); return `${options.workspace.replace(/\/$/, "")}/${pieces.filter(Boolean).join("/")}`; }
async function execute(options: RemoteOperationsOptions, script: string) { return sshExec(options, `umask 077; cd -- ${shellLiteral(options.workspace)} && ${script}`); }
function encoded(content: string | Buffer) { return Buffer.from(content).toString("base64"); }
/** Remote operations never fall back to local operations after an SSH failure. */
export function createRemoteOperations(options: RemoteOperationsOptions) {
  const access = async (path: string) => { await execute(options, `test -r ${shellLiteral(remotePath(options, path))}`); };
  const readFile = async (path: string) => (await execute(options, `cat -- ${shellLiteral(remotePath(options, path))}`)).stdout;
  const writeFile = async (path: string, content: string | Buffer) => { const target = remotePath(options, path); await execute(options, `mkdir -p -- ${shellLiteral(target.substring(0, target.lastIndexOf("/")))} && printf %s ${shellLiteral(encoded(content))} | base64 -d > ${shellLiteral(target)}`); };
  return {
    read: { readFile, access, detectImageMimeType: async (path: string) => { const value = (await execute(options, `file --mime-type -b -- ${shellLiteral(remotePath(options, path))}`)).stdout.toString().trim(); return value.startsWith("image/") ? value : null; } } satisfies ReadOperations,
    write: { writeFile, mkdir: async (path: string) => { await execute(options, `mkdir -p -- ${shellLiteral(remotePath(options, path))}`); } } satisfies WriteOperations,
    edit: { readFile, access, writeFile } satisfies EditOperations,
    bash: { exec: async (command: string, cwd: string, execOptions: { onData?: (data: Buffer) => void; signal?: AbortSignal; timeout?: number }) => { const path = remotePath(options, cwd); const result = await sshExec({ ...options, signal: execOptions.signal, timeoutMs: execOptions.timeout ? execOptions.timeout * 1000 : undefined }, `umask 077; cd -- ${shellLiteral(path)} && ${command}`); execOptions.onData?.(result.stdout); if (result.stderr.length) execOptions.onData?.(result.stderr); return { exitCode: result.code }; } } satisfies BashOperations,
    // Grep reads remote files (and never silently substitutes a local path); the explicit
    // grep command below documents the genuine remote search primitive used by callers.
    grep: { isDirectory: async (path: string) => { try { await execute(options, `test -d -- ${shellLiteral(remotePath(options, path))}`); return true; } catch { return false; } }, readFile: async (path: string) => (await execute(options, `cat -- ${shellLiteral(remotePath(options, path))}`)).stdout.toString() } satisfies GrepOperations,
    find: { exists: async (path: string) => { try { await execute(options, `test -e -- ${shellLiteral(remotePath(options, path))}`); return true; } catch { return false; } }, glob: async (pattern: string, cwd: string, opts: { limit: number }) => (await execute(options, `cd -- ${shellLiteral(remotePath(options, cwd))} && find . -path './${pattern.replace(/'/g, "'\"'\"'")}' -type f -maxdepth 10 2>/dev/null | head -n ${Math.max(1, opts.limit)}`)).stdout.toString().trim().split("\n").filter(Boolean).map((line) => line.replace(/^\.\//, "")) } satisfies FindOperations,
    ls: { exists: async (path: string) => { try { await execute(options, `test -e -- ${shellLiteral(remotePath(options, path))}`); return true; } catch { return false; } }, stat: async (path: string) => { const target = remotePath(options, path); let isDir = false; try { await execute(options, `test -d -- ${shellLiteral(target)}`); isDir = true; } catch { /* not a directory */ } return { isDirectory: () => isDir }; }, readdir: async (path: string) => (await execute(options, `ls -1 -- ${shellLiteral(remotePath(options, path))}`)).stdout.toString().trim().split("\n").filter(Boolean) } satisfies LsOperations,
    remoteGrep: async (pattern: string, path: string) => (await execute(options, `grep -RIn -- ${shellLiteral(pattern)} ${shellLiteral(remotePath(options, path))}`)).stdout.toString(),
  };
}
export { remotePath };
