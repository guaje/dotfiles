---
description: Parallel context gathering (web + codebase + conventions)
argument-hint: "<what to investigate>"
---
Gather context for: $@

Use one subagent tool call with `tasks` (parallel mode). Spawn these agents in parallel:
- 1+ `researcher` agents for web research — split the question into focused sub-queries and spawn one researcher per sub-query
- 1 `scout` agent for codebase recon — find relevant code, types, dependencies
- 1 `conventions-analyst` agent to extract relevant conventions — patterns, naming, structure

Run them in parallel and return the combined findings. Do NOT plan or implement.
