---
description: Recon → plan → plan review (no implementation)
argument-hint: "<what to plan>"
---
Produce a validated implementation plan for: $@

Make two subagent tool calls:

1. **Recon** (one call, `tasks` parallel mode):
   - 1+ `researcher` agents for web research on relevant sub-questions
   - 1 `scout` agent for codebase recon
   - 1 `conventions-analyst` agent for relevant conventions

2. **Plan + review** (one call, `chain` mode) — incorporate the recon findings from step 1 into the first task:
   - `planner`: "Create an implementation plan for $@ using these recon findings: <recon output>"
   - `plan-reviewer`: "Review this plan: {previous}. Return APPROVE WITH CHANGES or concrete issues."

Do NOT implement. Return the validated plan.
