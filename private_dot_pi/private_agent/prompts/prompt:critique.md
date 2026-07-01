---
description: Multi-lens parallel critique (correctness + style + external)
argument-hint: "[what to critique]"
---
Critique from multiple lenses: $@

Use one subagent tool call with `tasks` (parallel mode). Spawn these review lenses in parallel:
- `reviewer`: "Review for correctness, bugs, and spec deviations: $@"
- `conventions-analyst`: "Review for pattern and convention adherence: $@"
- `researcher`: "Verify any external API/library claims against current documentation: $@"

Synthesize the three reviews into a single prioritized findings list.
