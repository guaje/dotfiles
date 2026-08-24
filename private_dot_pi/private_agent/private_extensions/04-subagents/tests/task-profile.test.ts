import assert from "node:assert/strict";
import test from "node:test";
import { parseRoutingProfile } from "../task-profile.ts";

test("routing profiles are closed and custom omissions are balanced", () => {
	assert.equal(parseRoutingProfile("coding"), "coding");
	assert.equal(parseRoutingProfile("LONG-CONTEXT"), "long-context");
	assert.equal(parseRoutingProfile("experimental"), "balanced");
	assert.equal(parseRoutingProfile(undefined), "balanced");
});
