import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage } from "../types.ts";
import { resolveSubagentExecutionSettings } from "../settings.ts";

test("emptyUsage returns a fresh zeroed record", () => { assert.equal(emptyUsage().turns, 0); assert.notEqual(emptyUsage(), emptyUsage()); });
test("execution settings use nested benchmark max age only", () => {
	assert.deepEqual(resolveSubagentExecutionSettings({ subagents: { maxParallelTasks: 2, maxConcurrency: 8, autoModelSelection: { benchmarkSnapshotMaxAgeMs: 60_000 } } }), { maxParallelTasks: 2, maxConcurrency: 2, benchmarkSnapshotMaxAgeMs: 60_000 });
	assert.equal(resolveSubagentExecutionSettings({ subagentBenchmarkSnapshotMaxAgeMs: 1 }).benchmarkSnapshotMaxAgeMs, 2_592_000_000);
});
