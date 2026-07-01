---
description: Web research with citations
argument-hint: "<query>"
---
Research the web and return findings with citations for: $@

Use the subagent tool:
- If the query is a single focused question, use single mode with the `researcher` agent.
- If the query has multiple independent sub-questions, use one call with `tasks` (parallel mode), spawning one `researcher` per sub-question.

Return compressed findings with source URLs. Do not read or modify codebase files.
