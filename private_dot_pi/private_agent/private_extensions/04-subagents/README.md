# Subagents

Subagent roster and workload preferences live under `subagents` in `agent/settings.config.json`:

```json
"subagents": {
  "rosterCap": 10,
  "rosterScope": "user",
  "maxParallelTasks": 8,
  "maxConcurrency": 4
}
```

`rosterScope` accepts `user` or `both`. Workload values are bounded by code-owned safety limits, and concurrency never exceeds the maximum task count. Legacy flat keys remain readable for migration, while `/settings` writes only the nested fields and preserves sibling values.
