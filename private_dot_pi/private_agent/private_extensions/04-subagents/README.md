# Subagents

Subagent roster and workload preferences live under `subagents` in `agent/settings.config.json`:

```json
"subagents": {
  "rosterCap": 10,
  "rosterScope": "user",
  "maxParallelTasks": 8,
  "maxConcurrency": 4,
  "autoModelSelection": {
    "benchmarkSnapshotMaxAgeMs": 2592000000
  }
}
```

`rosterScope` accepts `user` or `both`. Workload values are bounded by code-owned safety limits, and concurrency never exceeds the maximum task count. Legacy flat keys remain readable for migration, while `/settings` writes only the nested fields and preserves sibling values.

Automatic model routing is benchmark-driven, local-only, and fails closed to the child default when no valid schema-v4 snapshot variant and fresh Health measurements exist. Schema v3 and earlier artifacts are intentionally rejected until `sh agent/scripts/refresh-artificial-analysis.sh --refresh-all` publishes reviewed v4 snapshots. Reasoning variants are matched to explicit `thinking:` frontmatter (or the policy default); generic mappings remain compatible with every level. See [BENCHMARK-ROUTING.md](./BENCHMARK-ROUTING.md).
