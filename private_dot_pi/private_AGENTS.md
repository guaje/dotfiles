# Instructions for agents working in ~/.pi

## Scope

These instructions apply to work in `~/.pi/`.

- Edit files in `~/.pi/` only.
- Do **not** edit files in `~/.local/share/chezmoi/` unless the user explicitly asks for that.
- If the user wants changes persisted in chezmoi, suggest `chezmoi status` and `chezmoi add <path>` after updating the file in `~/.pi/`.

## Do / Do Not

### Do

- Make changes in `~/.pi/`.
- Apply pi settings changes in `agent/settings.config.json`, not `agent/settings.json`.
- Treat `agent/settings.json` as generated output from the merge workflow; do not make manual source-of-truth edits there.
- Run targeted tests for the files you change.
- Avoid hardcoding absolute paths, package/versioned install paths, version numbers, model IDs, provider IDs, or other environment-specific identifiers in any script, test, extension, or generated file you write. Discover them from config files, the runtime environment, command output, package metadata, or test fixtures instead.
- Review diffs before proposing completion or commits.
- Keep output styling aligned with the existing Catppuccin Mocha theme.
- Suggest the correct chezmoi path when a changed file should be tracked there.

### Do not

- Edit `~/.local/share/chezmoi/` directly unless explicitly requested.
- Edit `agent/settings.json` directly for persistent settings changes; update `agent/settings.config.json` instead.
- Commit or stage unrelated files.
- Modify secret-related chezmoi files or workflows unless explicitly requested.
- Claim a change works unless you ran the relevant validation.

## Portability and dynamic discovery

- Treat hardcoded paths, version numbers, and model/provider IDs as brittle defaults to avoid.
- Prefer deriving paths relative to the current file, repository root, `$HOME`, or documented config locations.
- Prefer reading available models/providers from `agent/settings.config.json`, `agent/models.json`, health-cache output, or the model registry instead of embedding specific model IDs in scripts or tests.
- Prefer discovering tool/package versions from installed package metadata or command output instead of embedding versioned paths such as package-manager cellar paths.
- If a literal identifier is unavoidable for a focused unit fixture, use synthetic fixture names (for example `test-provider/test-model`) and keep them clearly separate from real local model IDs or machine-specific paths.

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

Skill testing guidelines:

- Validate every new or changed skill's frontmatter and location:
  - `SKILL.md` exists in `agent/skills/<skill-name>/`.
  - `name` matches the parent directory.
  - `name` uses lowercase letters, numbers, and hyphens only.
  - `description` is present and under the Agent Skills limit.
- Add focused skill tests next to the skill when practical, e.g. `agent/skills/<skill-name>/*.test.sh`.
- Prefer POSIX shell assertions for shell-based skill tests. Use `#!/bin/sh`, `set -eu`, and portable tools such as `grep`, `sed`, `cut`, and `tr`.
- For live pi skill invocation tests, run `pi -p` with the target skill explicitly loaded and unrelated subsystems disabled:
  - `--no-tools`
  - `--no-extensions`
  - `--no-prompt-templates`
  - `--no-themes`
  - `--skill agent/skills/<skill-name>`
- Ask the model for constrained, machine-checkable output such as strict JSON, then assert the response content with POSIX shell or TypeScript assertions.
- Test behavior from the skill instructions, not just discovery: verify recommended workflows, parameters, endpoint choices, output types, and error-prone decision rules.
- Keep live model tests deterministic enough for repeated runs: avoid requiring web access, tool calls, or API calls unless the test is specifically for those integrations.
- Allow an optional model override for live tests, e.g. `PI_<SKILL_NAME>_MODEL`, without requiring it for normal runs.

Current targeted skill tests:

- `agent/skills/linkup-search/pi-invocation.test.sh`

## GitHub workflow coverage

Pi files tracked in chezmoi are validated by the `Pi tests` GitHub Actions workflow in the chezmoi repo:

- Workflow path: `~/.local/share/chezmoi/.github/workflows/pi-tests.yml`.

When a workflow fails, use GitHub CLI from the chezmoi repo context:

- `gh run list --repo guaje/dotfiles --limit 10`
- `gh run view <run-id> --repo guaje/dotfiles --log-failed`

If changing package scopes, test fixtures, model/provider assumptions, or skill invocation behavior, update both the local tests and `pi-tests.yml` as needed.

## Theming

- Preferred theme: `agent/themes/catppuccin-mocha.json`
- Keep UI colors, warnings, previews, and syntax styling consistent with Catppuccin Mocha.
- Prefer existing theme tokens and output conventions over inventing new styling.
- `confirm-before-actions.ts` reads the Catppuccin theme file directly; preserve that behavior unless intentionally redesigning it.

## Chezmoi sync notes

This directory is the editable working copy. Chezmoi is the source-of-truth repo for tracked dotfiles.

Settings note:

- `~/.pi/agent/settings.config.json` is the editable source of truth for pi settings in this repo.
- `~/.pi/agent/settings.json` is automatically generated/merged and may be untracked; agents should update `settings.config.json` and let the merge workflow regenerate `settings.json`.

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
