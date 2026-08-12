# SSH Handoff

`/ssh` connects Pi tools and optional session authority to a selected SSH workspace. It discovers concrete aliases from `~/.ssh/config`, waits for explicit selection before `ssh -G`, and never enables agent forwarding or changes SSH host-key policy.

Commands: `/ssh`, `/ssh toggle`, `/ssh status`, `/ssh sync`, and `/ssh disconnect`. The shortcut and remote root resolve nested-first from settings, with legacy flat-key fallback:

```json
"handoff": {
  "remoteRoot": "~/.local/state/pi/remote-sessions",
  "hotkey": "ctrl+alt+s"
}
```

The hotkey must be a documented Pi keybinding and cannot replace protected built-ins; invalid values safely use `ctrl+alt+s`. The resolved binding appears in `/hotkeys`. Custom `keybindings.json` remaps can still create runtime conflicts; Pi reports those conflicts and skips protected collisions. Sync uses protocol v2: one bounded JSON request and one response over SSH stdin, with no local fallback. Expired locks require explicit, state-checked recovery. The Handoff backend registry exposes only current remote-route availability to Permissions. When connected with tools routed remotely, Permissions may offer session-only YOLO; it bypasses only Permissions-owned Bash/write/edit checks for those routed remote operations. It never enables local tools, direct SSH, subagents, or Handoff connection/helper-install confirmations. Toggling local, disconnecting, route loss, and shutdown immediately revoke YOLO and do not restore it on reconnect.

The local Pi SessionManager stays local. Resume selects and routes a remote session but does **not** hydrate its JSONL into SessionManager. Remote JSONL snapshots are cached only under `agent/handoff-cache/`, which must not be tracked. The production helper stores snapshots under `~/.local/state/pi/remote-sessions`; installation or update of that helper is an explicit confirmed operation only, and headless installation is denied. Synchronize does not renew a long-running lock, so operations must complete within the acquired lock lifetime.

`tests/live-handoff.test.ts` is opt-in and never enabled in CI. Before running it, independently verify the server key in an owner-controlled known-hosts file and use a dedicated disposable VM with SSH ingress restricted to the tester. The harness enforces BatchMode, strict supplied known-host verification, no agent forwarding, X11 forwarding, arbitrary forwarding, or local commands. It may use the local SSH agent for authentication, but never forwards that agent to the host. Every run stages its helper and all state beneath a random `$HOME/.local/state/pi/handoff-live/<run-id>` root, validates that boundary before recursive cleanup, and never touches the production helper or state root. It covers helper preflight, malformed protocol input, locking/renewal/contention/recovery, invalid tokens, commit/fetch/CAS, real synchronization, routed file/search/Bash operations, path/injection rejection, timeout/abort, no local fallback, and cleanup.

```sh
PI_HANDOFF_LIVE_TEST=1 \
PI_HANDOFF_LIVE_TARGET=exouser@pi.jetstream-cloud.org \
PI_HANDOFF_LIVE_KNOWN_HOSTS="$HOME/.ssh/known_hosts" \
npx -y tsx --test agent/extensions/02-handoff/tests/live-handoff.test.ts
```

`PI_HANDOFF_LIVE_PORT` and an absolute `PI_HANDOFF_LIVE_IDENTITY_FILE` are optional. Never use `StrictHostKeyChecking=no`, `accept-new`, `/dev/null`, or an unverified `ssh-keyscan` result.
