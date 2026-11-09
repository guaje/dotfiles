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
- Routing diagnostics must preserve health-gate reasons, evidence sources, missing columns, confidence, exploration, and ETA disagreement.

## Health and ETA

Health is an unconditional gate. Missing/stale entries are refreshed on demand, capability-filtered and best-evidence-first, within `subagents.healthProbeBudgetMs` and health probe concurrency. Diagnostics distinguish stale cache, failed probe, over-threshold latency, and `unprobed (budget)`. Logged success never bypasses this gate.

Cold ETA is probe latency plus expected output divided by probe throughput. After `measuredSpeedMinimumRuns` successful runs for an endpoint/profile, warm ETA uses median turns × current probe latency plus expected output divided by effective output tokens per wall second. Task size scales expected output by `clamp(chars / 2000, 0.5, 3)`. Effective throughput includes tools and thinking; it is not decode speed. A >2× probe/log disagreement is reported.

## Local outcomes

`agent/subagent-outcomes.json` is local-only, corruption-tolerant, and bounded per endpoint/profile. It records wall time, first-token time, usage, automatic outcome, task fingerprint, retry linkage, and selector. A clean result is successful unless the same agent/task is re-dispatched in the same session within three delegations or 15 minutes.

Outside and local percentiles blend continuously: `confidence = min(1, observations / outcomeInfluenceFullAt)`. Every fourth matching delegation may explore a candidate below 0.25 confidence when it is within eight percentile points of the leader. Fast/slow EWMAs report success and time drift; thinking-level effort yield is informational only.

Expanded routing diagnostics name sources, missing columns, confidence, exploration, ETA, and throughput disagreement. `/stats` shows recent outcomes and drift flags.
