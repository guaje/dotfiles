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

## Session Bash approvals

In Empowerment, one approval selector prioritizes **Allow similar commands for this session**, followed by **Allow once** and **Deny**. There is no separate exact-command approval action. The dialog previews the effective similarity template, whether it is audited or conservative, and how many operand slots may vary. Remembered rules are HMAC fingerprints with safe metadata only; command text, arguments, paths, URLs, and remote payloads are not retained. `/session-approvals` lists, revokes, or clears active rules.

A data-driven signature registry provides audited templates for Git staging/commit messages, `npx -y tsx --test`, common filesystem mutators, and workspace-contained `chezmoi add`. Audited options and operation anchors remain fixed while canonical workspace operands may vary; copy/move/link rules also fix operand arity and destination. Test globs are accepted only when every current match canonicalizes inside the workspace. Other complete literal commands receive conservative templates: executable, operation, options, effect, context, and ambiguous operands stay fixed, while only high-confidence contained paths can vary. Shell/programming interpreters, runtime executors, unaudited package-runner or chezmoi forms, parser failures, dynamic expansion, substitutions, pipelines, groups, redirections, and interactive commands remain approve-once only. Handoff and SSH use conservative target/workspace-bound templates without remote path generalization. Rules never apply in Micromanagement or to mixed read/non-read-only units.

The in-memory bound is configured in `agent/settings.config.json`:

```json
"permissionsSessionApprovalMaxRules": 100
```

At capacity, existing rules continue and a new remember choice allows only the current invocation. Rules survive `/reload`; they are cleared on quit, new/resumed/forked sessions, startup, and management-style changes. The template-schema upgrade invalidates older exact/special-case rules once while preserving the active session identity.

## Shell policy

Shell parsing is intentionally conservative. Only completely consumed, reviewed syntax and executable/argument profiles can be read-only. Unsupported syntax, dynamic commands, programmable interpreters, ambiguous SSH payloads, and unreviewed curl options are unknown and require approval.

Remote/network execution is metadata rather than an approval category: `ssh host ls` and a curl GET can be read-only, while remote mutations, HTTP writes, forwarding, uploads, and local output files are not.

Reviewed chezmoi inspection commands such as `chezmoi status --verbose`, `chezmoi diff -- <target>`, `verify`, `managed`, and `cat` are read-only. Source/destination mutations, local output files, external refreshes, and explicit helper/configuration overrides require approval.

### Structural parser

Permissions has one bounded structural parser. Its mandatory execution units are the sole input to authorization and split guidance; flattened commands are presentation metadata only. Only direct children of the outermost sequence can be separated. Pipelines, substitutions, wrappers, redirections, groups, and SSH payloads are coupled and require one decision.

Unsupported syntax and parser failures fail closed. Source input is limited to 32 KiB, graphs to 256 nodes, and nested structure to depth 8. SSH analyzes its already-built payload graph, retaining the distinction between local substitutions in the SSH invocation and remote substitutions in its payload.

## Visual hierarchy

Permissions uses semantic theme roles rather than fixed colors: only dialog titles and section labels are bold; paths and remote targets are cool gray-blue secondary text; metadata is muted; ordinary executables are blue; elevated wrappers are warnings; destructive executables and mutating options are errors. Flags, strings, numbers, URLs, and nested SSH payloads keep distinct syntax roles. Authorization never depends on presentation colors.
