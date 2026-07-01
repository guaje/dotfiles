---
description: Architecture design with prior-art research (no code)
argument-hint: "<what to design>"
---
Produce a design document for: $@

Make two subagent tool calls:

1. **Research + recon** (one call, `tasks` parallel mode):
   - 1+ `researcher` agents for prior-art and architecture research on relevant sub-questions
   - 1 `scout` agent for codebase recon — existing architecture, constraints, integration points

2. **Design + review** (one call, `chain` mode) — incorporate the findings from step 1 into the first task:
   - `planner`: "Produce a design document for $@ with architecture, tradeoffs, and alternatives, using these findings: <research output>"
   - `plan-reviewer`: "Critique this design: {previous}. Challenge assumptions and flag risks."

Do NOT implement. Return the reviewed design document.
