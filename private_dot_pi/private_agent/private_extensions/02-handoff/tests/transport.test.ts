import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { sshExec, sshGetConfig } from "../transport.ts";

class Child extends EventEmitter { stdout = new EventEmitter(); stderr = new EventEmitter(); killed: string[] = []; kill(signal?: string) { this.killed.push(signal ?? ""); return true; } }
test("SSH transport uses argv security options and no shell", async () => {
  let args: string[] = []; let options: any; const child = new Child();
  const result = sshExec({ alias: "work", user: "me", port: 2222, spawn: ((_cmd: string, values: string[], opts: any) => { args = values; options = opts; queueMicrotask(() => { child.stdout.emit("data", Buffer.from("ok")); child.emit("close", 0); }); return child as any; }) as any }, "pwd");
  assert.equal((await result).stdout.toString(), "ok"); assert.equal(options.shell, false); assert.ok(args.includes("-T")); assert.ok(args.includes("BatchMode=yes")); assert.ok(!args.includes("-A")); assert.deepEqual(args.slice(-2), ["me@work", "pwd"]);
});
test("isolated live transport forces verified host keys and disables forwarding", async () => {
  let args: string[] = []; const child = new Child();
  const result = sshExec({ alias: "work", knownHostsPath: "/tmp/known_hosts", identityFile: "/tmp/key", spawn: ((_cmd: string, values: string[]) => { args = values; queueMicrotask(() => child.emit("close", 0)); return child as any; }) as any }, "true");
  await result;
  assert.ok(args.includes("UserKnownHostsFile=/tmp/known_hosts"));
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.ok(args.includes("IdentitiesOnly=yes"));
  assert.ok(args.includes("ForwardAgent=no"));
  assert.ok(args.includes("ForwardX11=no"));
  assert.ok(args.includes("ClearAllForwardings=yes"));
  assert.ok(args.includes("PermitLocalCommand=no"));
  assert.ok(args.includes("-i"));
});
test("framed protocol callers may accept only explicitly listed remote exit codes", async () => {
  const acceptedChild = new Child();
  const accepted = sshExec({ alias: "work", acceptedExitCodes: [0, 2], spawn: (() => { queueMicrotask(() => { acceptedChild.stdout.emit("data", Buffer.from("protocol error")); acceptedChild.emit("close", 2); }); return acceptedChild as any; }) as any }, "helper --stdio");
  assert.equal((await accepted).code, 2);
  const rejectedChild = new Child();
  const rejected = sshExec({ alias: "work", acceptedExitCodes: [0, 2], spawn: (() => { queueMicrotask(() => rejectedChild.emit("close", 255)); return rejectedChild as any; }) as any }, "helper --stdio");
  await assert.rejects(rejected, /SSH failed \(255\)/);
});
test("SSH transport aborts without a local fallback", async () => {
  const child = new Child(); const controller = new AbortController();
  const pending = sshExec({ alias: "work", signal: controller.signal, spawn: (() => child as any) as any }, "pwd"); controller.abort();
  await assert.rejects(pending, /aborted/); assert.deepEqual(child.killed, ["SIGTERM"]);
});
test("sshGetConfig times out and kills the child", async () => {
  let args: string[] = []; const child = new Child();
  const promise = sshGetConfig("test", ((_cmd: string, values: string[]) => { args = values; return child as any; }) as any, 50);
  await assert.rejects(promise, /timed out/); assert.ok(child.killed.length > 0);
});
test("sshGetConfig emits completed result when child exits 0", async () => {
  let args: string[] = []; const child = new Child();
  const p = sshGetConfig("work", ((_cmd: string, values: string[]) => { args = values; queueMicrotask(() => { child.stdout.emit("data", Buffer.from("hostname w\nuser me\nport 2222\n")); child.emit("close", 0); }); return child as any; }) as any, 5_000);
  const result = await p;
  assert.equal(result.hostname, "w"); assert.equal(result.user, "me"); assert.equal(result.port, "2222");
});
