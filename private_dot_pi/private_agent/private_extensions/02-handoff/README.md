# SSH Handoff

`/ssh` connects Pi tools and optional session authority to a selected SSH workspace. It discovers concrete aliases from `~/.ssh/config`, waits for explicit selection before `ssh -G`, and never enables agent forwarding or changes SSH host-key policy.

Commands: `/ssh`, `/ssh toggle`, `/ssh status`, `/ssh sync`, and `/ssh disconnect`. The shortcut and remote root resolve source-first from settings. Sync uses protocol v2: one bounded JSON request and one response over SSH stdin, with no local fallback. Expired locks require explicit, state-checked recovery.

The local Pi SessionManager stays local. Remote JSONL snapshots are cached only under `agent/handoff-cache/`, which must not be tracked. The remote helper stores snapshots under `~/.local/state/pi/remote-sessions`; installation or update of the helper is an explicit confirmed operation only; headless installation is denied.
