---
description: Implement a plan, review, apply fixes (assumes plan is done)
argument-hint: "<plan or task>"
---
Implement, review, and fix: $@

Assume recon and planning are already done. Use one subagent tool call with `chain` mode:
- `worker`: "Implement this: $@"
- `reviewer`: "Review the implementation against the original task: {previous}. Report issues by severity."
- `worker`: "Apply the fixes from the review: {previous}"

Pass output between steps via the {previous} placeholder.
