---
description: Pattern-guided refactor with verification
argument-hint: "<what to refactor>"
---
Refactor: $@

Use one subagent tool call with `chain` mode:
- `conventions-analyst`: "Extract the conventions and patterns relevant to: $@"
- `worker`: "Refactor following these conventions: {previous}. Target: $@"
- `reviewer`: "Review the refactor for pattern adherence and regressions: {previous}"

Pass output between steps via the {previous} placeholder.
