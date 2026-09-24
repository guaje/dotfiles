import { randomBytes } from "node:crypto";
import { HANDOFF_PROTOCOL_VERSION, HELPER_READY_TTL_MS } from "./config.ts";
import { loadHelperArtifact, verifyHelperPreflight } from "./gate.ts";
import { sshExec, type SshTransportOptions } from "./transport.ts";

const REMOTE_DIRECTORY = '"$HOME"/.local/libexec';
const REMOTE_HELPER = `${REMOTE_DIRECTORY}/pi-handoff-gate.py`;

export interface InstallerDependencies {
  loadArtifact?: typeof loadHelperArtifact;
  exec?: typeof sshExec;
  /** Test seams for the readiness window; production uses wall time and the configured TTL. */
  now?: () => number;
  readyTtlMs?: number;
}

function parsePreflight(stdout: Buffer) {
  let value: unknown;
  try { value = JSON.parse(stdout.toString("utf8")); } catch { throw new Error("Handoff helper preflight returned invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Handoff helper preflight returned invalid data");
  return value as { ok?: boolean; version?: number; checksum?: string; limits?: { snapshotBytes?: number; chunkBytes?: number } };
}

export interface RemoteLimits { snapshotBytes: number; chunkBytes: number }

/** Remote caps as reported by the helper handshake; undefined when the installed helper predates capability reporting. */
export async function remoteLimits(options: SshTransportOptions, dependencies: InstallerDependencies = {}): Promise<RemoteLimits | undefined> {
  const value = await preflightPath(options, REMOTE_HELPER, dependencies);
  const { snapshotBytes, chunkBytes } = value.limits ?? {};
  if (typeof snapshotBytes !== "number" || typeof chunkBytes !== "number" || snapshotBytes < 1 || chunkBytes < 1) return undefined;
  return { snapshotBytes, chunkBytes };
}

async function preflightPath(options: SshTransportOptions, path: string, dependencies: InstallerDependencies = {}) {
  const result = await (dependencies.exec ?? sshExec)(options, `python3 ${path} version`);
  const value = parsePreflight(result.stdout);
  if (!value.ok) throw new Error("Handoff helper preflight failed");
  return value;
}

export async function preflightRemoteHelper(options: SshTransportOptions, dependencies: InstallerDependencies = {}) {
  return preflightPath(options, REMOTE_HELPER, dependencies);
}

export async function installRemoteHelper(options: SshTransportOptions, dependencies: InstallerDependencies = {}): Promise<void> {
  const artifact = await (dependencies.loadArtifact ?? loadHelperArtifact)();
  const exec = dependencies.exec ?? sshExec;
  const suffix = randomBytes(8).toString("hex");
  const staged = `${REMOTE_DIRECTORY}/.pi-handoff-gate.${suffix}.tmp`;
  try {
    await exec({ ...options, stdin: artifact.bytes }, `umask 077; mkdir -p -- ${REMOTE_DIRECTORY}; cat > ${staged}; chmod 700 ${staged}`);
    const stagedResult = await preflightPath(options, staged, dependencies);
    if (!verifyHelperPreflight(stagedResult, artifact.checksum)) throw new Error("Staged Handoff helper failed version or checksum verification");
    await exec(options, `mv -f -- ${staged} ${REMOTE_HELPER}; chmod 700 ${REMOTE_HELPER}`);
    const installed = await preflightRemoteHelper(options, dependencies);
    if (!verifyHelperPreflight(installed, artifact.checksum)) throw new Error("Installed Handoff helper failed version or checksum verification");
    invalidateRemoteHelperReadiness(); // the trusted window belonged to the helper that was just replaced
  } catch (error) {
    await exec(options, `rm -f -- ${staged}`).catch(() => undefined);
    throw error;
  }
}

/**
 * A verified helper is trusted for a short window. Without this, every protocol request — each chunk
 * of a large upload — repeats the version handshake, doubling the number of SSH invocations.
 * Only successes are cached, and a checksum change or explicit invalidation ends the window.
 */
const verified = new Map<string, number>();
export function invalidateRemoteHelperReadiness() { verified.clear(); }

export async function assertRemoteHelperReady(options: SshTransportOptions, dependencies: InstallerDependencies = {}): Promise<void> {
  const artifact = await (dependencies.loadArtifact ?? loadHelperArtifact)();
  const now = dependencies.now ?? Date.now;
  const ttl = dependencies.readyTtlMs ?? HELPER_READY_TTL_MS;
  const key = `${options.user ?? ""}@${options.alias}:${options.port ?? 22}#${artifact.checksum}`;
  if (ttl > 0 && now() < (verified.get(key) ?? 0)) return;
  const current = await preflightRemoteHelper(options, dependencies);
  if (!verifyHelperPreflight(current, artifact.checksum)) { verified.delete(key); throw new Error("Handoff helper version or checksum mismatch"); }
  if (ttl > 0) verified.set(key, now() + ttl);
}

export async function ensureRemoteHelper(
  options: SshTransportOptions,
  hasUi: boolean,
  confirm: (message: string) => Promise<boolean>,
  dependencies: InstallerDependencies = {},
): Promise<void> {
  const artifact = await (dependencies.loadArtifact ?? loadHelperArtifact)();
  const current = await preflightRemoteHelper(options, dependencies).catch(() => undefined);
  if (current && verifyHelperPreflight(current, artifact.checksum)) return;
  if (!hasUi || !await confirm(`Install or update Handoff helper v${HANDOFF_PROTOCOL_VERSION} on ${options.alias}?`)) {
    throw new Error("Handoff helper installation or update was not approved");
  }
  await installRemoteHelper(options, dependencies);
}
