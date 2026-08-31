# Model health

The extension entrypoint is `index.ts`. Policy defaults and bounds are machine-readable in `assets/policy.json`; settings are resolved source-first through `08-settings`. Chat models are displayed by their stable registered `provider/model` identity, matching `/stats`; optional registry display names do not replace that identity.

## Settings

Health settings can be configured in `settings.config.json` under the `health` nested object. Legacy flat keys are still supported for backwards compatibility but nested keys take precedence.

```json
{
  "health": {
    "cacheTtlMs": 900000,
    "probeConcurrency": 3
  }
}
```

- `health.cacheTtlMs` (number): How long cached health results remain valid, in milliseconds. Default: `900000` (15 minutes). Valid range: 1000–86400000.
- `health.probeConcurrency` (number): Maximum number of concurrent model probes during health checks. Default: `3`. Valid range: 1–8.

Legacy flat keys (deprecated but still supported as fallback):
- `modelHealthCacheTtlMs` is used when `health.cacheTtlMs` is absent or invalid.
- `modelHealthProbeConcurrency` is used when `health.probeConcurrency` is absent or invalid.

Scripts outside the TypeScript runtime (e.g. `scripts/read-policy.mjs`) read nested keys directly from JSON files with the same precedence rules.
