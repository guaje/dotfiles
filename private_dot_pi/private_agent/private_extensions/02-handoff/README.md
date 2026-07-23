# SSH Handoff

`/ssh` connects Pi tools and optional session authority to a selected SSH workspace. It discovers concrete aliases from `~/.ssh/config`, waits for explicit selection before `ssh -G`, and never enables agent forwarding or changes SSH host-key policy.

Commands: `/ssh`, `/ssh toggle`, `/ssh status`, `/ssh sync`, and `/ssh disconnect`. `ctrl+alt+s` is equivalent to `/ssh toggle`.

The local Pi SessionManager stays local. Remote JSONL snapshots are cached only under `agent/handoff-cache/`, which must not be tracked. The remote helper stores snapshots under `~/.local/state/pi/remote-sessions`; installation or update of the helper is an explicit confirmed operation only.
