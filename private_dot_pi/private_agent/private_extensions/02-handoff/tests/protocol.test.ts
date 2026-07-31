import assert from "node:assert/strict";
import test from "node:test";
import vectors from "../assets/protocol-test-vectors.json" with { type: "json" };
import { HANDOFF_PROTOCOL_VERSION } from "../config.ts";
import { decodeGateResponse, encodeGateRequest } from "../protocol.ts";

test("handoff protocol accepts the shared valid request vectors", () => {
  for (const request of vectors.validRequests) assert.doesNotThrow(() => encodeGateRequest(request as any));
  assert.deepEqual(JSON.parse(encodeGateRequest({ version: HANDOFF_PROTOCOL_VERSION, command: "version" }).toString()), { version: HANDOFF_PROTOCOL_VERSION, command: "version" });
});

test("handoff protocol rejects shared invalid request vectors", () => {
  for (const request of vectors.invalidRequests) assert.throws(() => encodeGateRequest(request as any));
});

test("handoff protocol accepts one bounded response only", () => {
  for (const response of vectors.validResponses) assert.equal(decodeGateResponse(Buffer.from(JSON.stringify(response))).ok, response.ok);
  assert.throws(() => decodeGateResponse(Buffer.from('{"ok":true}\n{"ok":true}')));
});
