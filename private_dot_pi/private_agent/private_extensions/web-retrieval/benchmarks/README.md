# Web retrieval benchmark (manual, non-CI)

Run only with explicit credentials and real network access:

```sh
LINKUP_API_KEY=... TAVILY_API_KEY=... npx -y tsx agent/extensions/web-retrieval/benchmarks/run.ts
```

The runner records Linkup and Tavily results for fixed public queries, measuring latency, result size, source/citation count, freshness fields, failures, and rejection of unsafe URLs. It does not change settings or enable Tavily fallback. Review its JSON output before any manual configuration change.
