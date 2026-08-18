import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { requireRemoteRouteForToolCall, resetBackendRegistryForTests, setRemoteBashBackend } from "../backend-registry.ts";
import { authorizedRemoteOperations } from "../remote-authorization.ts";

afterEach(() => resetBackendRegistryForTests());

const backend = { exec: async () => ({ exitCode: 0 }) } as any;
const fileOperations = { write: {}, edit: {} };

function activateRoute(label = "host:/repo") {
  setRemoteBashBackend(() => backend, () => label, undefined, () => label);
}

test("YOLO-authorized file tools keep remote operations when the route is unchanged", () => {
  activateRoute();
  assert.equal(requireRemoteRouteForToolCall("stable-file"), true);
  assert.equal(authorizedRemoteOperations("stable-file", () => fileOperations), fileOperations);
});

test("YOLO-authorized file tools fail closed on route loss or target changes", () => {
  activateRoute();
  assert.equal(requireRemoteRouteForToolCall("lost-file"), true);
  setRemoteBashBackend(undefined);
  assert.throws(
    () => authorizedRemoteOperations("lost-file", () => undefined),
    /route changed after YOLO authorization/,
  );

  activateRoute("first:/repo");
  assert.equal(requireRemoteRouteForToolCall("changed-file"), true);
  activateRoute("second:/repo");
  assert.throws(
    () => authorizedRemoteOperations("changed-file", () => fileOperations),
    /route changed after YOLO authorization/,
  );
});

test("non-YOLO file tools may still resolve local operations when no remote route is required", () => {
  assert.equal(authorizedRemoteOperations("ordinary-file", () => undefined), undefined);
});
