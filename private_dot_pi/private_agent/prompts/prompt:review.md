---
description: Review current changes against a plan or spec
argument-hint: "[plan or spec]"
---
Review the current uncommitted changes against: $@

Use one subagent tool call (single mode) with the `reviewer` agent:
- task: "Run `git diff` and review the changes against this plan or spec: $@. Produce structured findings sorted by severity."

If no plan/spec is given, review the diff for bugs, logic errors, security issues, and pattern mismatches.
