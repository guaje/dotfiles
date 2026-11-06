# Testing

These rules apply to any test change in this repository. Read this file before editing tests.

Keep a test only if it can fail for a reason a caller or user would care about. A test that breaks on a pure refactor, or that survives a real bug, is the wrong test.

What to assert, in priority order:

1. Observable outcomes: returned values, rendered text, written files, exec'd argv, emitted notifications, exit codes.
2. Boundary contracts: wire protocol frames and call ordering, cross-language constants (`02-handoff` TS ↔ `assets/pi-handoff-gate.py`), published file shapes (`catalog-state.json`), CLI flags, env overrides.
3. Fail-closed and error paths: rejected input, path traversal, redacted secrets, stale/missing fixtures. These are this repo's highest-value tests — keep them exact.
4. Persisted side effects and idempotence (re-run, atomic publish, restored state).

Do not write:

- Mirrors/tautologies: a constant asserted against its own literal, or `join`/`resolve` output compared against the same composition the implementation uses.
- Source-text greps (`assert.match(source, /identifier/)` / `doesNotMatch` on banned identifiers) as a stand-in for behavior. Allow only as an architecture guard for a *named* decision, and pair it with a test that proves the decision (e.g. "no LLM in model selection" → install a throwing completion mock and show selection still resolves).
- Interaction-only assertions (`registerTool`/`registerCommand` was called). Register, then drive the handler and assert its output.
- Private helpers tested directly when the same behavior is reachable through the public entry point. Test behaviors, not methods.
- Exact UI strings or whole argv arrays where the contract is "these fields are present and placed" (`00-hud/tests/adapter.test.ts`, `extensions/tests/native-notify.test.ts`) — assert the meaningful keys/order and let cosmetics move.
- Tests for glue, re-exports, and type-only modules with no logic.

One test = one behavior, titled as a sentence about observable behavior ("unknown routing profiles fall back to balanced"), not a function name.

Determinism:

- Match the test language to the implementation language (TypeScript ↔ TypeScript, shell ↔ shell, `.mjs` ↔ `.mjs`, Python ↔ Python). Do not substitute a different language unless the user asks.
- No live model, network, SSH, or real timer unless the test is explicitly for that integration; gate on an env var and `skip:` with a reason (see `02-handoff/tests/live-handoff.test.ts`). CI has no model credentials and no network tokens.
- Mock time and `globalThis.fetch`; for HTTP-backed scripts stand up a local `http.createServer` on port 0 and read the bound port.
- Restore every mutation per test (in `finally`, or in `beforeEach`) — `globalThis.fetch`, `process.env.*` (delete keys that were originally undefined), `globalThis.__*` hooks, timers, tmp dirs. File-level `test.after` alone is not enough: one failing test must not leak its mocks into the next.
- Build fixtures under `os.tmpdir()` / `mktemp -d`; derive in-test paths from `import.meta.dirname` (or `$0` in shell), never the caller's cwd. Never write generated or stub files into the source tree — `04-subagents/tests/index.test.ts`'s `.index.testable.ts` is the only sanctioned exception.

Structure:

- Import the unit directly (`import { fn } from "../module.ts"`) whenever it is pure. Use `agent/extensions/tests/helpers/package-stubs.ts` (`installPackageStubs`/`releasePackageStubs`) only when the module imports bare `@earendil-works/*` or `typebox`.
- One file per unit under test, in `<extension>/tests/<unit>.test.ts`; reserve `index.test.ts` for entry-point wiring and assert the wiring by invoking the registered handler.
- Stub package imports with temporary modules in `agent/extensions/node_modules/` via the shared helper (reference-counted; release in `after`).
- Any new test must be reachable by `sh agent/scripts/run-extension-tests.sh`; if it lives outside the discovery scopes, extend that runner in the same change.
- Change tests with behavior: add or repoint the covering test in the same change, and delete tests whose code is gone. Prefer repointing an implementation-coupled test to the behavior it meant to protect over deleting coverage outright.

Extension tests use the lightweight Node-native style: `node:test` with `assert/strict`, run via `npx -y tsx --test <path>`, focused tests in `agent/extensions/tests/` or co-located `tests/` dirs.

Skill tests:

- Validate frontmatter and location: `SKILL.md` in `agent/skills/<skill-name>/`, `name` matches the parent directory (lowercase, hyphens, numbers only), `description` present and under the limit.
- Prefer POSIX shell assertions (`#!/bin/sh`, `set -eu`, portable tools) for shell-based skill tests.
- For live pi skill invocation tests: `pi --no-session -p` with the target skill loaded and unrelated subsystems disabled (`--no-tools`, `--no-extensions`, `--no-prompt-templates`, `--no-themes`, `--skill agent/skills/<skill-name>`).
- Ask for constrained, machine-checkable output (strict JSON), then assert with POSIX shell or TypeScript.
- Keep live model tests deterministic: avoid requiring web/tool/API access unless the test is specifically for that integration. Allow an optional model override (`PI_<SKILL_NAME>_MODEL`).

## Extension test risk matrix

| Area | Required deterministic coverage |
| --- | --- |
| Handoff helper, protocol, locks | JSON bounds, token/nonce/expiry, explicit recovery |
| SSH failure | timeout, abort, write error, no local fallback |
| Handoff live SSH (opt-in only) | strict verified host key, isolated helper/root, cleanup, protocol and routed-operation contract |
| Settings | source fallback, serialized update, exact rollback |
| Permissions | local/remote Micromanagement and Empowerment, YOLO availability/cycling/route-loss fail-closed behavior |
| Fixtures | temp roots and precise cleanup; no shared `node_modules` deletion |
| Browse | synthetic config and secret-command injection only |
| Subagents | caps, observed concurrency, truncation/rendering, deterministic benchmark snapshot/profile/routing and refresh-script checks |
| Health | freshness and policy bounds |
| Pi internals | retain structural/AST tests where patch layout is contractual |

The live Handoff suite is skipped unless all of `PI_HANDOFF_LIVE_TEST=1`, `PI_HANDOFF_LIVE_TARGET`, and an absolute `PI_HANDOFF_LIVE_KNOWN_HOSTS` are explicitly supplied. `PI_HANDOFF_LIVE_PORT` and an absolute `PI_HANDOFF_LIVE_IDENTITY_FILE` are optional. It must never be enabled in CI. It uses BatchMode and strict supplied known-host verification; it does not accept new hosts, disable checking, forward the local authentication agent, enable X11 or arbitrary forwarding, or permit local commands. The local SSH agent may authenticate the connection but is never forwarded. Each run uses an isolated `$HOME/.local/state/pi/handoff-live/<run-id>` root, validates that exact boundary before cleanup, and removes it in `finally`.

Current Handoff limitations are deliberate and tested/documented: resume selects/routes but does not hydrate remote JSONL into SessionManager; synchronize has no long-operation lock renewal. The opt-in suite covers isolated staged helper deployment/preflight, malformed protocol input, lock renewal/contention/recovery, invalid tokens, commit/fetch/CAS, real synchronize, routed file/search/Bash operations, path and command-injection rejection, timeout/abort, no local fallback, and cleanup. Secrets, tokens, and protocol payloads must be redacted from test output.
