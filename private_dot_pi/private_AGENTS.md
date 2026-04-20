# Instructions for agents working in ~/.pi

## Scope

These instructions apply to work in `~/.pi/`.

- Edit files in `~/.pi/` only.
- Do **not** edit files in `~/.local/share/chezmoi/` unless the user explicitly asks for that.
- If the user wants changes persisted in chezmoi, suggest `chezmoi status` and `chezmoi add <path>` after updating the file in `~/.pi/`.

## Do / Do Not

### Do

- Make changes in `~/.pi/`.
- Run targeted tests for the files you change.
- Review diffs before proposing completion or commits.
- Keep output styling aligned with the existing Catppuccin Mocha theme.
- Suggest the correct chezmoi path when a changed file should be tracked there.

### Do not

- Edit `~/.local/share/chezmoi/` directly unless explicitly requested.
- Commit or stage unrelated files.
- Modify secret-related chezmoi files or workflows unless explicitly requested.
- Claim a change works unless you ran the relevant validation.

## Testing

- Test files in the same language they are written in whenever practical.
- Match the test language to the implementation language: TypeScript with TypeScript tests, shell scripts with shell tests, etc.
- Do not replace a native-language test with a test in a different language unless the user explicitly wants that.

Use the existing lightweight Node-native test style for extensions:

- Use `node:test` with `assert/strict`.
- Run tests with `npx -y tsx --test <path>`.
- Prefer focused tests in `agent/extensions/tests/`.
- Stub package imports with temporary modules in `agent/extensions/node_modules/`.
- If needed for loading, create a temporary `agent/extensions/.<name>.testable.ts` file and clean it up in `test.after()`.
- Mock network calls with `globalThis.fetch` and always restore originals.
- Test behavior, not just registration: verify updates, previews, request payloads, error paths, and final returned content.

Current targeted tests:

- `agent/extensions/tests/confirm-before-actions.test.ts`
- `agent/extensions/tests/google-search.test.ts`

## Theming

- Preferred theme: `agent/themes/catppuccin-mocha.json`
- Keep UI colors, warnings, previews, and syntax styling consistent with Catppuccin Mocha.
- Prefer existing theme tokens and output conventions over inventing new styling.
- `confirm-before-actions.ts` reads the Catppuccin theme file directly; preserve that behavior unless intentionally redesigning it.

## Chezmoi sync notes

This directory is the editable working copy. Chezmoi is the source-of-truth repo for tracked dotfiles.

Common mappings:

- `~/.pi/agent/extensions/google-search.ts`
  -> `~/.local/share/chezmoi/private_dot_pi/private_agent/private_extensions/private_google-search.ts`
- `~/.pi/agent/extensions/tests/google-search.test.ts`
  -> `~/.local/share/chezmoi/private_dot_pi/private_agent/private_extensions/tests/private_google-search.test.ts`
- `~/.pi/agent/extensions/confirm-before-actions.ts`
  -> `~/.local/share/chezmoi/private_dot_pi/private_agent/private_extensions/private_confirm-before-actions.ts`
- `~/.pi/agent/themes/catppuccin-mocha.json`
  -> `~/.local/share/chezmoi/private_dot_pi/private_agent/private_themes/private_catppuccin-mocha.json`

Notes:

- Follow the existing chezmoi naming convention exactly; many tracked files use `private_` prefixes.
- Verify the destination path before suggesting chezmoi commands because naming is not perfectly uniform.
- Suggest `chezmoi status` to inspect pending source updates.
- Suggest `chezmoi add <changed-file>` to import the final `~/.pi/` version into chezmoi.

## Commit preferences

When the user asks for a commit in the chezmoi repo:

- Review `git status` and relevant diffs first.
- Stage only the intended files.
- Prefer `git add <specific files>` over broad adds.
- Do not include unrelated untracked files unless explicitly requested.
- Use short, imperative commit messages.

Examples:

- `Add Google search pi extension and test`
- `Clean up Google search extension imports`
- `Refine confirm-before-actions previews and tests`

## Workflow

1. Make and validate changes in `~/.pi/`.
2. Run the relevant targeted test file(s).
3. Suggest `chezmoi status`.
4. Suggest `chezmoi add <changed-file>` if the user wants the change tracked.
5. Review chezmoi diffs.
6. Commit only the intended tracked files when asked.
