# Extension test risk matrix

| Area | Required deterministic coverage |
| --- | --- |
| Handoff helper, protocol, locks | JSON bounds, token/nonce/expiry, explicit recovery |
| SSH failure | timeout, abort, write error, no local fallback |
| Settings | source fallback, serialized update, exact rollback |
| Fixtures | temp roots and precise cleanup; no shared `node_modules` deletion |
| Browse | synthetic config and secret-command injection only |
| Permissions | directional shortcut behavior |
| Subagents | caps, observed concurrency, truncation/rendering |
| Health | freshness and policy bounds |
| Pi internals | retain structural/AST tests where patch layout is contractual |

Secrets and credential-management behavior are deliberately deferred.
