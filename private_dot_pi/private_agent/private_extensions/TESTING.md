# Extension test risk matrix

| Area | Required deterministic coverage |
| --- | --- |
| Handoff helper, protocol, locks | JSON bounds, token/nonce/expiry, explicit recovery |
| SSH failure | timeout, abort, write error, no local fallback |
| Handoff live SSH (opt-in only) | strict verified host key, isolated helper/root, cleanup, protocol and routed-operation contract |
| Settings | source fallback, serialized update, exact rollback |
| Permissions | local/remote Micromanagement and Empowerment, YOLO availability/cycling/route-loss fail-closed behavior |
| Fixtures | temp roots and precise cleanup; no shared `node_modules` deletion |
| Browse | synthetic config and secret-command injection only |
| Subagents | caps, observed concurrency, truncation/rendering |
| Health | freshness and policy bounds |
| Pi internals | retain structural/AST tests where patch layout is contractual |

The live Handoff suite is skipped unless all of `PI_HANDOFF_LIVE_TEST=1`, `PI_HANDOFF_LIVE_TARGET`, and an absolute `PI_HANDOFF_LIVE_KNOWN_HOSTS` are explicitly supplied. `PI_HANDOFF_LIVE_PORT` and an absolute `PI_HANDOFF_LIVE_IDENTITY_FILE` are optional. It must never be enabled in CI. It uses BatchMode and strict supplied known-host verification; it does not accept new hosts, disable checking, forward the local authentication agent, enable X11 or arbitrary forwarding, or permit local commands. The local SSH agent may authenticate the connection but is never forwarded. Each run uses an isolated `$HOME/.local/state/pi/handoff-live/<run-id>` root, validates that exact boundary before cleanup, and removes it in `finally`.

Current Handoff limitations are deliberate and tested/documented: resume selects/routes but does not hydrate remote JSONL into SessionManager; synchronize has no long-operation lock renewal. The opt-in suite covers isolated staged helper deployment/preflight, malformed protocol input, lock renewal/contention/recovery, invalid tokens, commit/fetch/CAS, real synchronize, routed file/search/Bash operations, path and command-injection rejection, timeout/abort, no local fallback, and cleanup. Secrets, tokens, and protocol payloads must be redacted from test output.
