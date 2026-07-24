# Permissions

Permissions is Pi's approval-policy extension and the sole owner of the built-in Bash tool override.

## Modes

- **Micromanagement** asks before every Bash, write, and edit call.
- **Empowerment** runs completely classified read-only Bash locally or remotely, asks before mutations and unknown commands, and returns mixed read/mutation calls to the model for separation.

Legacy `Guidance` settings normalize to Empowerment. Session shortcuts (`ctrl+;` and `shift+ctrl+;`) do not persist; `/settings` changes are written atomically to `agent/settings.config.json`.

## Writable roots in Empowerment

Built-in `write` and `edit` are allowed under the canonical current directory, registered worktrees of its Git repository, and configured disposable roots. Bash mutations remain approval-gated.

Configure portable disposable roots in `agent/settings.config.json`:

```json
"empowermentDisposableRoots": ["@user-temp"]
```

`@user-temp` is a private, owner-only directory below the OS temporary directory. Absolute paths and `~/...` paths are also accepted when they already exist and canonicalize safely. Shared `/tmp` itself is never trusted automatically.

## Shell policy

Shell parsing is intentionally conservative. Only completely consumed, reviewed syntax and executable/argument profiles can be read-only. Unsupported syntax, dynamic commands, programmable interpreters, ambiguous SSH payloads, and unreviewed curl options are unknown and require approval.

Remote/network execution is metadata rather than an approval category: `ssh host ls` and a curl GET can be read-only, while remote mutations, HTTP writes, forwarding, uploads, and local output files are not.

Reviewed chezmoi inspection commands such as `chezmoi status --verbose`, `chezmoi diff -- <target>`, `verify`, `managed`, and `cat` are read-only. Source/destination mutations, local output files, external refreshes, and explicit helper/configuration overrides require approval.
