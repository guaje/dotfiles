# Delegation routing v3

Automatic delegation is local and deterministic. An agent's explicit `model:` remains the highest-priority override.

## Evidence

Routing reads reviewed immutable snapshots only; it never fetches benchmark data. BenchLM supplies coding, agentic, instruction-following, knowledge, reasoning, and math. Artificial Analysis supplies long-context and faithfulness, plus tool-use when available. If BenchLM is absent, reviewed AA evidence remains an interim cold path.

Scores from different publishers are never compared directly. Each source/column is converted to a 0–100 percentile among the currently eligible fleet. Missing columns are ignored and weights are renormalised. A model needs at least three measured outside-evidence categories and measured columns covering at least 60% of its profile weight. There are no absolute score floors.

Profiles and weights are code-reviewed in `assets/routing-policy.json`. Its generation must match `ROUTING_POLICY_VERSION` in `benchmark-assets.ts`; change them together, or routing rejects the mismatch and disables certified and interim benchmark selection (session-start warns, and `describePolicyGenerationMismatch` names both generations). Research and long-context require 131072 input tokens; review requires 32768; agentic requires tool support. The configurable research floor is `subagents.researchMinimumContextWindow`.

## Asset maintenance

- Runtime routing is network-free. Refresh BenchLM and Artificial Analysis only through `/catalog sync`, which publishes reviewed immutable assets into `assets/`.
- `/catalog sync` executes `chezmoi forget --force --no-tty` and `rm -f` automatically only for deletions confined to `agent/extensions/04-subagents/assets/` (`09-catalog/asset-cleanup.ts`); it must never wait on a prompt the interface cannot answer. Every other chezmoi or git action stays printed for the owner.
- De-scoping a model through `/scoped-models` removes its file from `assets/models/`. A composite shared with Artificial Analysis keeps the file until the AA cleanup reclaims it; only the withdrawn publisher's block is cleared first.
- `agent/subagent-outcomes.json` is a bounded local work log. Never add it to chezmoi or git.
- Routing diagnostics must preserve health-gate reasons, evidence sources, missing columns, confidence, drift vetoes, and ETA disagreement.

## Health and ETA

Health is an unconditional gate. Missing/stale entries are refreshed on demand, capability-filtered and best-evidence-first, within `subagents.healthProbeBudgetMs` and health probe concurrency. Diagnostics distinguish stale cache, failed probe, over-threshold latency, and `unprobed (budget)`. Every health cache entry names how its throughput was measured (`throughputSource`: `decode-window`, `end-to-end`, `escalated`, or `truncated`); routing reads the rate, and diagnostics should carry the source so a conservative estimate is never mistaken for a measured one. Logged success never bypasses this gate.

Cold ETA is probe latency plus expected output divided by probe throughput. Probe throughput is a decode-window rate (first generated token to completion, with a floor guard for buffered endpoints), so thinking time is charged once — through probe latency — instead of twice. After `measuredSpeedMinimumRuns` successful runs for an endpoint/profile, warm ETA uses median turns × current probe latency plus expected output divided by effective output tokens per wall second. Task size scales expected output by `clamp(chars / 2000, 0.5, 3)`. Effective throughput includes tools and thinking; it is not decode speed, which is why a heavy thinker can legitimately show a >2× probe/log gap: the `speedDisagreement` flag reports that mismatch, it never vetoes a route.

## Local outcomes

`agent/subagent-outcomes.json` is local-only, corruption-tolerant, and bounded per endpoint/profile. It records wall time, first-token time, usage, automatic outcome, task fingerprint, retry linkage, and selector. A clean result is successful unless the same agent/task is re-dispatched in the same session within three delegations or 15 minutes.

Routing ranks each model on the best evidence it actually has — a three-rung ladder. Top rung, the BenchLM/AA scorecard: capability is what benchmarks measure and what history (automatic verdicts only) cannot, so measured history never outranks capability: its ranking weight is `min(routing-policy history.maxRankInfluence, observations / subagents.outcomeInfluenceFullAt)` — 0.25 by default, reached after 15 observations — and it only reorders candidates the quality band already treats as near-ties. Fallback rung, own measured history: a model whose scorecard is missing still routes on its own record when it has at least `subagents.driftWarmupRows` observations and cleared drift alarms; its combined percentile is its own success-rate percentile among the fleet, no scorecard machinery applies, diagnostics mark it `basis: "history"` with sources `"history"`, and a history-basis winner additionally sets the `historyBasis: true` route flag. Bottom rung, ineligible: a model with neither evidence is never guessed at (exclusion reason `noSnapshot`, or `driftAlarm` when the record it does have is drifting), and the session model remains the terminal fallback. A success or time drift alarm vetoes any candidate outright (exclusion reason `driftAlarm`): collapsing reliability is the one thing measured history must still catch. Fast/slow EWMAs feed both the alarm and `/stats`; thinking-level effort yield is informational only. The exploration slot was retired with the cap: a better newcomer is picked immediately and accumulates its own record by being routed to.

Expanded routing diagnostics name sources, missing columns, history influence, ETA, and throughput disagreement. `/stats` shows recent outcomes and drift flags.
