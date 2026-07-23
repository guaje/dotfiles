import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { SSH_TIMEOUT_MS, MAX_OUTPUT_BYTES } from "./config.ts";
import { TransportError } from "./errors.ts";
import type { TransportResult } from "./types.ts";

export interface SshTransportOptions { alias: string; user?: string; port?: number; timeoutMs?: number; signal?: AbortSignal; spawn?: typeof nodeSpawn; }
function bounded(chunks: Buffer[], chunk: Buffer) { const used = chunks.reduce((n, item) => n + item.length, 0); if (used < MAX_OUTPUT_BYTES) chunks.push(chunk.subarray(0, MAX_OUTPUT_BYTES - used)); }
/** Executes SSH through argv only. `script` is interpreted only by the remote sh. */
export function sshExec(options: SshTransportOptions, script: string): Promise<TransportResult> {
  return new Promise((resolve, reject) => {
    const destination = options.user ? `${options.user}@${options.alias}` : options.alias;
    const args = ["-T", "-o", "BatchMode=yes", "-o", `ConnectTimeout=${Math.max(1, Math.ceil((options.timeoutMs ?? SSH_TIMEOUT_MS) / 1000))}`, "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2"];
    if (options.port) args.push("-p", String(options.port)); args.push(destination, "sh", "-lc", script);
    const child: ChildProcess = (options.spawn ?? nodeSpawn)("ssh", args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let done = false; let timedOut = false;
    const finish = (error?: Error, value?: TransportResult) => { if (done) return; done = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(value!); };
    const stop = () => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 250).unref?.(); };
    const abort = () => { stop(); finish(new TransportError("SSH operation aborted")); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? SSH_TIMEOUT_MS);
    options.signal?.addEventListener("abort", abort, { once: true }); child.stdout?.on("data", (data: Buffer) => bounded(stdout, Buffer.from(data))); child.stderr?.on("data", (data: Buffer) => bounded(stderr, Buffer.from(data)));
    child.once("error", (error) => finish(new TransportError(`SSH could not start: ${error.message}`)));
    child.once("close", (code) => { if (timedOut) finish(new TransportError("SSH operation timed out")); else if (code !== 0) finish(new TransportError(`SSH failed (${code ?? "signal"}): ${Buffer.concat(stderr).toString("utf8").trim()}`)); else finish(undefined, { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? 0 }); });
  });
}
export function shellLiteral(value: string) { return `'${value.replace(/'/g, "'\\''")}'`; }
/** Resolve OpenSSH aliases only after an explicit user selection. The alias remains the execution target. */
export function sshGetConfig(alias: string, spawn: typeof nodeSpawn = nodeSpawn, timeoutMs = SSH_TIMEOUT_MS): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-G", alias], { stdio: ["ignore", "pipe", "pipe"], shell: false }); const out: Buffer[] = []; const err: Buffer[] = []; let done = false;
    const finish = (error?: Error, value?: Record<string, string>) => { if (done) return; done = true; clearTimeout(timeout); error ? reject(error) : resolve(value!); };
    const stop = () => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 250).unref?.(); };
    const timeout = setTimeout(() => { stop(); finish(new TransportError("SSH config lookup timed out")); }, timeoutMs);
    child.stdout?.on("data", (data: Buffer) => bounded(out, Buffer.from(data))); child.stderr?.on("data", (data: Buffer) => bounded(err, Buffer.from(data)));
    child.once("error", (error) => finish(new TransportError(`SSH config lookup failed: ${error.message}`)));
    child.once("close", (code) => { if (done) return; if (code !== 0) return finish(new TransportError(`SSH config lookup failed: ${Buffer.concat(err).toString().trim()}`)); const values: Record<string, string> = {}; for (const line of Buffer.concat(out).toString().split(/\r?\n/)) { const [key, value] = line.trim().split(/\s+/, 2); if (key && value) values[key] = value; } finish(undefined, values); });
  });
}
