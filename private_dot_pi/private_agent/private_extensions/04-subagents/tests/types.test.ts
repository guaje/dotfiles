import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage } from "../types.ts";
import { resolveSubagentExecutionSettings } from "../settings.ts";
test("emptyUsage returns a fresh zeroed record", () => { assert.equal(emptyUsage().turns, 0); assert.notEqual(emptyUsage(), emptyUsage()); });
test("execution settings validate nested routing controls", () => { const settings = resolveSubagentExecutionSettings({ subagents: { maxParallelTasks: 2, maxConcurrency: 8, maxProbeLatencyMs: 6000, outcomeWindow: 80, autoModelSelection: { benchmarkSnapshotMaxAgeMs: 60_000 } } }); assert.equal(settings.maxParallelTasks, 2); assert.equal(settings.maxConcurrency, 2); assert.equal(settings.benchmarkSnapshotMaxAgeMs, 60_000); assert.equal(settings.maxProbeLatencyMs, 6000); assert.equal(settings.outcomeWindow, 80); assert.equal(settings.healthProbeBudgetMs, 30000, "reasoning-on probes need a budget that a single thinking model can fit inside"); assert.equal(resolveSubagentExecutionSettings({ subagents: { maxProbeLatencyMs: -1 } }).maxProbeLatencyMs, 15000); });
