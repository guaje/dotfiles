# Model health

The extension entrypoint is `index.ts`. Policy defaults and bounds are machine-readable in `assets/policy.json`; settings are resolved source-first through `08-settings`. Chat models are displayed by their stable registered `provider/model` identity, matching `/stats`; optional registry display names do not replace that identity.

## Settings

Health settings can be configured in `settings.config.json` under the `health` nested object. Legacy flat keys are still supported for backwards compatibility but nested keys take precedence.

```json
{
  "health": {
    "cacheTtlMs": 900000,
    "probeConcurrency": 3,
    "probeTimeoutMs": 20000
  }
}
```

- `health.cacheTtlMs` (number): How long cached health results remain valid, in milliseconds. Default: `900000` (15 minutes). Valid range: 1000–86400000.
- `health.probeConcurrency` (number): Maximum number of concurrent model probes during health checks. Default: `3`. Valid range: 1–16.
- `health.probeTimeoutMs` (number): Wall-clock ceiling for one chat model probe, covering every attempt made for that model. Default: `20000`. Valid range: 2000–120000. Raise it when reasoning probes on slow links would otherwise be reported as failures; it is a ceiling, not a target, so a healthy model returns as soon as it answers.

Legacy flat keys (deprecated but still supported as fallback):
- `modelHealthCacheTtlMs` is used when `health.cacheTtlMs` is absent or invalid.
- `modelHealthProbeConcurrency` is used when `health.probeConcurrency` is absent or invalid.
- `modelHealthProbeTimeoutMs` is used when `health.probeTimeoutMs` is absent or invalid.

Scripts outside the TypeScript runtime (e.g. `scripts/read-policy.mjs`) read nested keys directly from JSON files with the same precedence rules.

## Probe semantics

- Every reasoning-capable model is probed **with thinking enabled** at the cheapest level it
  declares (`minimal`, then `low`, then `medium`; levels mapped to `null` are skipped). Probing
  some models with thinking off and others with it on would make the reported `tokensPerSecond`
  and `latencyMs` measure thinking policy instead of speed, and delegation routing turns exactly
  those two numbers into task ETA and a latency gate. Models that cannot reason are probed plain,
  and a model whose endpoint rejects the level falls back to the registered model unchanged.
- One deadline (`health.probeTimeoutMs`) bounds a whole model probe, so a rejected first attempt
  costs only the time it took and a wedged endpoint cannot spend the ceiling twice.
- Chat probes stream, which records `firstTokenMs` and lets `tokensPerSecond` be measured over the
  decode window (first generated token → completion) while `latencyMs` stays end to end. Routing
  ETA is `turns × probeLatency + expectedTokens ÷ probeTokSec`, so a throughput measured end to end
  would charge thinking time twice and make a thinking model look an order of magnitude slower than
  it decodes. A window is only trusted when it covers at least 100 ms and at least 5% of the round
  trip (buffered endpoints deliver first and last token together, and a sample too thin to time
  keeps its conservative end-to-end number).
- Each cache entry says how its rate was measured (`throughputSource`): `decode-window`,
  `end-to-end`, `escalated`, or `truncated`.
- **Escalation** (`health.probeEscalation`, default on). When a model answers but decoded too few
  tokens to time — typically a ~6 s think
  followed by ~12 visible tokens — the probe runs that model once more asking for three short
  sentences, which lengthens the visible tail until it clears the guard. It is decided from the
  measurement, never from a model list: a model that streams earlier or thinks less simply stops
  paying. It never escalates a `truncated` sample (the output ceiling was eaten by thinking, so a
  longer prompt buys only more thinking), never runs twice, shares the model's existing
  `health.probeTimeoutMs` deadline, and can only improve the rate — `status`, `latencyMs`, and the
  standard sample's numbers stay published if the escalation does not measure. Measured cost on the
  fleet that needs it: ~+0.3–0.8 s for those models once per cache TTL, nothing for the rest.
- Image-generation probes keep their own internal ceiling; generation is a different shape of
  request from a chat probe.
