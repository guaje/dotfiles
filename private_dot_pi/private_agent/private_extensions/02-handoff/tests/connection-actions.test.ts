import assert from "node:assert/strict";
import test from "node:test";
import { dispatchConnectedAction } from "../connection-actions.ts";
import { canRouteRemote, initialState } from "../state.ts";
import type { HandoffState, RemoteTarget } from "../types.ts";

function connectedState(): HandoffState {
  return {
    ...initialState(),
    connection: "connected",
    target: { alias: "host", host: "example.test", workspace: "/repo" },
  };
}

function harness(options: { selectedWorkspace?: RemoteTarget } = {}) {
  const states: HandoffState[] = [];
  const resumes: RemoteTarget[] = [];
  let workspaceTarget: Omit<RemoteTarget, "workspace"> | undefined;
  const dependencies = {
    async resumeRemoteSession(_ctx: any, target: RemoteTarget) { resumes.push(target); },
    async chooseWorkspace(_ctx: any, target: Omit<RemoteTarget, "workspace">) {
      workspaceTarget = target;
      return options.selectedWorkspace;
    },
    setState(state: HandoffState) { states.push(state); },
    now: () => 123,
  };
  const ctx = { sessionManager: { getSessionId: () => "local-session" }, ui: { notify() {} } };
  return { ctx, dependencies, states, resumes, getWorkspaceTarget: () => workspaceTarget };
}

test("connected resume dispatches directly instead of reopening the management menu", async () => {
  const state = connectedState();
  const app = harness();

  assert.equal(await dispatchConnectedAction("resume", app.ctx, state, app.dependencies), true);
  assert.deepEqual(app.resumes, [state.target]);
  assert.deepEqual(app.states, []);
});

test("connected new-session dispatch activates remote history and tools", async () => {
  const app = harness();

  assert.equal(await dispatchConnectedAction("new", app.ctx, connectedState(), app.dependencies), true);
  assert.equal(app.states.length, 1);
  assert.equal(app.states[0]?.sessionId, "local-session");
  assert.equal(app.states[0]?.sessionAuthority, "remote");
  assert.equal(canRouteRemote(app.states[0]!), true);
});

test("connected workspace dispatch browses and applies the selected remote directory", async () => {
  const selected = { alias: "host", host: "example.test", workspace: "/other" };
  const app = harness({ selectedWorkspace: selected });

  assert.equal(await dispatchConnectedAction("workspace", app.ctx, connectedState(), app.dependencies), true);
  assert.deepEqual(app.getWorkspaceTarget(), { alias: "host", host: "example.test", user: undefined, port: undefined });
  assert.equal(app.states[0]?.target?.workspace, "/other");
  assert.equal(canRouteRemote(app.states[0]!), true);
});

test("unknown connected actions fall through to the normal command handler", async () => {
  const app = harness();
  assert.equal(await dispatchConnectedAction("sync", app.ctx, connectedState(), app.dependencies), false);
  assert.deepEqual(app.states, []);
});
