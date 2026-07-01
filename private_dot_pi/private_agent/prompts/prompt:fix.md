---
description: Locate, fix, and verify a bug
argument-hint: "<bug description>"
---
Locate and fix: $@

Use one subagent tool call with `chain` mode:
- `scout`: "Find the code relevant to this bug and identify the likely root cause: $@"
- `worker`: "Fix the bug using the scout's findings: {previous}"
- `reviewer`: "Review the fix for correctness and regressions: {previous}"

Pass output between steps via the {previous} placeholder.
