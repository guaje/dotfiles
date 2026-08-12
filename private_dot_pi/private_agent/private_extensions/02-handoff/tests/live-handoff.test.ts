// Opt-in integration coverage. Never enable this file in CI.
// Run only with PI_HANDOFF_LIVE_TEST=1 PI_HANDOFF_LIVE_TARGET=<user@host-or-alias>
// PI_HANDOFF_LIVE_KNOWN_HOSTS=<absolute-known_hosts>;
// optional PI_HANDOFF_LIVE_PORT/PI_HANDOFF_LIVE_IDENTITY_FILE.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { HANDOFF_PROTOCOL_VERSION, helperSource } from "../config.ts";
import { loadHelperArtifact } from "../gate.ts";
import { createRemoteOperations } from "../operations.ts";
import { decodeGateResponse, encodeGateRequest, type GateResponse } from "../protocol.ts";
import { validateManualTarget } from "../ssh-config.ts";
import { HandoffGateError, synchronize } from "../sync.ts";
import { shellLiteral, sshExec, type SshTransportOptions } from "../transport.ts";
import type { HandoffState } from "../types.ts";

const knownHosts = process.env.PI_HANDOFF_LIVE_KNOWN_HOSTS;
const identityFile = process.env.PI_HANDOFF_LIVE_IDENTITY_FILE;
const enabled = process.env.PI_HANDOFF_LIVE_TEST === "1"
  && Boolean(process.env.PI_HANDOFF_LIVE_TARGET)
  && Boolean(knownHosts)
  && isAbsolute(knownHosts ?? "")
  && (!identityFile || isAbsolute(identityFile));

function digest(data: Buffer) { return createHash("sha256").update(data).digest("hex"); }

function transportOptions(): SshTransportOptions {
  const raw = process.env.PI_HANDOFF_LIVE_TARGET ?? "";
  const separator = raw.lastIndexOf("@");
  const host = separator < 0 ? raw : raw.slice(separator + 1);
  const user = separator < 0 ? undefined : raw.slice(0, separator);
  const target = validateManualTarget(host, user, process.env.PI_HANDOFF_LIVE_PORT);
  return {
    alias: target.host,
    user: target.user,
    port: target.port,
    knownHostsPath: knownHosts,
    ...(identityFile ? { identityFile } : {}),
  };
}

// This exercises only an isolated disposable root. Remote resume still does not hydrate
// SessionManager JSONL, and synchronize still has no long-operation lease renewal.
test("live Handoff isolated transport, helper, synchronization, and routed operations", {
  skip: enabled ? false : "set PI_HANDOFF_LIVE_TEST=1, PI_HANDOFF_LIVE_TARGET, and absolute PI_HANDOFF_LIVE_KNOWN_HOSTS/identity paths",
  timeout: 120_000,
}, async () => {
  const options = transportOptions();
  const runId = randomUUID();
  const localRoot = await mkdtemp(join(tmpdir(), "pi-handoff-live-"));
  let exactRoot: string | undefined;
  let primaryFailure: unknown;
  const liveExec = (script: string, stdin?: Buffer, extra: Partial<SshTransportOptions> = {}) => sshExec({ ...options, ...extra, ...(stdin ? { stdin } : {}) }, script);

  try {
    const home = (await liveExec("printf %s \"$HOME\"")).stdout.toString("utf8").trim();
    assert.ok(home.startsWith("/") && home !== "/" && !home.includes("\0"), "remote HOME must be a safe absolute user directory");
    const prefix = `${home.replace(/\/+$/, "")}/.local/state/pi/handoff-live`;
    exactRoot = `${prefix}/${runId}`;
    assert.equal(exactRoot, `${prefix}/${runId}`);
    assert.ok(exactRoot.startsWith(`${prefix}/`) && exactRoot !== prefix && exactRoot !== home && exactRoot !== "/");

    const helperPath = `${exactRoot}/helper/pi-handoff-gate.py`;
    const workspace = `${exactRoot}/workspace`;
    const stagedHelper = `${exactRoot}/helper/.pi-handoff-gate.${randomBytes(8).toString("hex")}.tmp`;
    const helperCommand = `PI_HANDOFF_ROOT=${shellLiteral(exactRoot)} python3 ${shellLiteral(helperPath)} --stdio`;
    const source = await readFile(helperSource);
    const artifact = await loadHelperArtifact();

    // Isolated staged deployment mirrors the production install contract without touching
    // ~/.local/libexec/pi-handoff-gate.py or the production session root.
    await liveExec(`umask 077; mkdir -p -- ${shellLiteral(`${exactRoot}/helper`)} ${shellLiteral(workspace)}; cat > ${shellLiteral(stagedHelper)}; chmod 700 ${shellLiteral(stagedHelper)}`, source);
    const staged = JSON.parse((await liveExec(`python3 ${shellLiteral(stagedHelper)} version`)).stdout.toString("utf8"));
    assert.equal(staged.version, HANDOFF_PROTOCOL_VERSION);
    assert.equal(staged.checksum, artifact.checksum);
    await liveExec(`mv -f -- ${shellLiteral(stagedHelper)} ${shellLiteral(helperPath)}; chmod 700 ${shellLiteral(helperPath)}`);
    const installed = JSON.parse((await liveExec(`python3 ${shellLiteral(helperPath)} version`)).stdout.toString("utf8"));
    assert.equal(installed.ok, true);
    assert.equal(installed.version, HANDOFF_PROTOCOL_VERSION);
    assert.equal(installed.checksum, artifact.checksum);

    const gate = async (command: string, args: string[] = [], data?: Buffer): Promise<GateResponse> => {
      const request = encodeGateRequest({ version: HANDOFF_PROTOCOL_VERSION, command, args, ...(data ? { dataBase64: data.toString("base64") } : {}) });
      return decodeGateResponse((await liveExec(helperCommand, request, { acceptedExitCodes: [0, 2] })).stdout);
    };
    const strictGate = async (command: string, args: string[] = [], data?: Buffer) => {
      const response = await gate(command, args, data);
      if (!response.ok) throw new HandoffGateError(response);
      return response;
    };

    const malformed = decodeGateResponse((await liveExec(helperCommand, Buffer.from("{}"), { acceptedExitCodes: [0, 2] })).stdout);
    assert.equal(malformed.ok, false);
    assert.deepEqual(await gate("list-sessions"), { ok: true, sessions: [] });

    const session = `live-${randomBytes(8).toString("hex")}`;
    const lock: any = await strictGate("acquire-lock", [session, "--owner", "live", "--lease", "120"]);
    assert.equal(typeof lock.token, "string");
    assert.equal(typeof lock.nonce, "string");
    assert.equal((await gate("acquire-lock", [session, "--owner", "other"])).ok, false);
    assert.equal((await gate("release-lock", [session, "--nonce", lock.nonce, "--token", "invalid"])).ok, false);
    assert.equal((await strictGate("renew-lock", [session, "--nonce", lock.nonce, "--token", lock.token, "--lease", "60"])).ok, true);

    const payload = Buffer.from('{"type":"message","content":"live fixture"}\n');
    const hash = digest(payload);
    const committed: any = await strictGate("commit", [session, "--nonce", lock.nonce, "--token", lock.token, "--generation", "0", "--expected-hash", "", "--hash", hash], payload);
    assert.equal(committed.manifest.generation, 1);
    assert.equal(committed.manifest.hash, hash);
    const fetched: any = await strictGate("fetch-manifest", [session]);
    assert.equal(fetched.manifest.generation, 1);
    assert.equal(digest(Buffer.from(fetched.jsonl)), hash);
    assert.equal((await gate("commit", [session, "--nonce", lock.nonce, "--token", lock.token, "--generation", "0", "--expected-hash", "", "--hash", hash], payload)).ok, false, "stale generation must fail CAS");
    assert.equal((await strictGate("release-lock", [session, "--nonce", lock.nonce, "--token", lock.token])).ok, true);

    const recoverySession = `recovery-${randomBytes(8).toString("hex")}`;
    await strictGate("acquire-lock", [recoverySession, "--owner", "live", "--lease", "1"]);
    await delay(1_200);
    const expired: any = await gate("acquire-lock", [recoverySession, "--owner", "other"]);
    assert.equal(expired.ok, false);
    assert.equal(expired.recoveryRequired, true);
    assert.equal(typeof expired.recoveryToken, "string");
    assert.equal((await gate("recover-lock", [recoverySession, "--token", "invalid"])).ok, false);
    await strictGate("recover-lock", [recoverySession, "--token", expired.recoveryToken]);
    const recovered: any = await strictGate("acquire-lock", [recoverySession, "--owner", "other"]);
    await strictGate("release-lock", [recoverySession, "--nonce", recovered.nonce, "--token", recovered.token]);

    const syncSession = `sync-${randomBytes(8).toString("hex")}`;
    const localSession = join(localRoot, "session.jsonl");
    const syncPayload = Buffer.from('{"type":"message","content":"sync fixture"}\n');
    await writeFile(localSession, syncPayload);
    let snapshotHash: string | undefined;
    let savedGeneration: number | undefined;
    const state: HandoffState = {
      connection: "connected",
      sessionAuthority: "remote",
      toolRoute: "remote",
      syncState: "dirty",
      sessionId: syncSession,
      target: { alias: options.alias, user: options.user, port: options.port, workspace },
    };
    const synced = await synchronize(state, localSession, {
      request: (async (_target: unknown, command: string, args: string[] = [], data?: Buffer) => strictGate(command, args, data)) as any,
      saveSnapshot: (async (_sessionId: string, data: Buffer) => { snapshotHash = digest(data); return join(localRoot, "snapshot.jsonl"); }) as any,
      saveManifest: (async (_sessionId: string, manifest: any) => { savedGeneration = manifest.generation; }) as any,
    });
    assert.equal(synced.syncState, "clean");
    assert.equal(snapshotHash, digest(syncPayload));
    assert.equal(savedGeneration, 1);
    const syncFetch: any = await strictGate("fetch-manifest", [syncSession]);
    assert.equal(syncFetch.manifest.hash, digest(syncPayload));

    const localCwd = join(localRoot, "workspace");
    const sentinel = join(localRoot, "local-sentinel");
    await writeFile(sentinel, "unchanged");
    const operations = createRemoteOperations({ ...options, workspace, localCwd });
    await operations.write.mkdir("dir");
    await operations.write.writeFile("dir/file.txt", "needle\n");
    assert.equal((await operations.read.readFile("dir/file.txt")).toString("utf8"), "needle\n");
    assert.deepEqual(await operations.ls.readdir("dir"), ["file.txt"]);
    assert.match(await operations.remoteGrep("needle", "dir"), /file\.txt:1:needle/);
    assert.ok((await operations.find.glob("*.txt", "dir", { limit: 10 })).includes("file.txt"));
    let streamed = "";
    assert.equal((await operations.bash.exec("printf remote-ok", localCwd, { onData: (data) => { streamed += data.toString("utf8"); } })).exitCode, 0);
    assert.equal(streamed, "remote-ok");
    await assert.rejects(operations.write.writeFile("/tmp/handoff-live-escape", "blocked"), /outside the selected remote workspace/);
    const injectionName = "dir/quote'$(touch injected).txt";
    await operations.write.writeFile(injectionName, "safe");
    assert.equal((await operations.read.readFile(injectionName)).toString("utf8"), "safe");
    await liveExec(`test ! -e ${shellLiteral(`${workspace}/injected`)}`);
    await assert.rejects(operations.bash.exec("sleep 2", localCwd, { timeout: 0.05 }), /timed out/);
    const controller = new AbortController();
    const aborted = operations.bash.exec("sleep 2", localCwd, { signal: controller.signal });
    controller.abort();
    await assert.rejects(aborted, /aborted/);
    assert.equal((await readFile(sentinel, "utf8")), "unchanged", "SSH failures must never fall back to local operations");
  }
  catch (error) {
    primaryFailure = error;
    throw error;
  }
  finally {
    let cleanupFailure: string | undefined;
    if (exactRoot) {
      const marker = `/.local/state/pi/handoff-live/${runId}`;
      if (!exactRoot.endsWith(marker) || exactRoot === "/" || exactRoot.endsWith("/.local/state/pi/handoff-live")) {
        cleanupFailure = `refused unsafe live Handoff cleanup path: ${exactRoot}`;
      }
      else {
        const removed = await liveExec(`rm -rf -- ${shellLiteral(exactRoot)}; test ! -e ${shellLiteral(exactRoot)}`).then(() => true).catch(() => false);
        if (!removed) cleanupFailure = `isolated live Handoff root was not removed: ${exactRoot}`;
      }
    }
    await rm(localRoot, { recursive: true, force: true });
    if (cleanupFailure) {
      if (primaryFailure) console.error(cleanupFailure);
      else assert.fail(cleanupFailure);
    }
  }
});
