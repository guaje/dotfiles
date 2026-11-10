# 🏠 Dotfiles

## 🚀 Installation

### 📱 Termux

After `chezmoi init --apply`, the Termux package bootstrap should complete automatically. A fresh Termux environment still requires these Android/Termux integration steps:

- Install the **Termux:API** Android app if `termux-api` commands are needed.
- Run `termux-setup-storage` to create `~/storage` symlinks and grant storage access.
- Start required services with `sv-enable sshd` and `sv-enable ssh-agent`.

These steps are required for the full Termux environment because Android app installation, storage permission grants, and service activation cannot be safely completed by a non-interactive package bootstrap script.

For Pi native notifications on Termux, see [`~/.pi/docs/tasker-autonotification.md`](private_dot_pi/private_docs/private_tasker-autonotification.md). It documents the Tasker + AutoNotification bridge used by Pi to show native Android notifications with Pi icons, including storage icon setup, required Tasker profile/action configuration, generated-image preview handling, and test broadcasts.

## 🔐 Dotfiles Management with Chezmoi & SOPS

This repository uses `chezmoi` to manage dotfiles, with a focus on securely handling secrets using `sops` and `age`.

### 🛠️ Secrets Management: `check-secrets.sh`

A custom pre-add hook, `scripts/check-secrets.sh`, expands the standard `chezmoi add` functionality. It automatically scans files for sensitive patterns (e.g., `API_KEY`, `PASSWORD`) and provider-specific tokens before they are added to the source directory.

The shared detector logic lives in `scripts/check-secrets.awk`, and can also be reused outside `chezmoi add` via `scripts/scan-secrets.sh` for CI and pre-commit checks.

#### ⚙️ How it Works

When you run `chezmoi add <file>`, the script triggers and provides several options if sensitive data is detected:

1. **📦 Full Encryption:** Encrypts the entire file using `chezmoi`'s built-in `age` support.
2. **🛡️ SOPS Strategy (Recommended):**
   - Extracts only the sensitive key-value pairs.
   - Stores them in an encrypted file under `secrets/`, following the same path as the original file (for example, `secrets/dot_config/app/settings.yaml.sops.yaml`).
   - Replaces the original file with a template that reads those secrets when `chezmoi apply` runs. Plaintext is never saved in the source directory, and an interrupted add can be retried safely.
3. **📄 Plain:** Adds the file as-is (not recommended for secrets).
4. **🛑 Abort:** Cancels the `add` operation.

Options 1 and 2 safely finish the conversion and then stop the original `chezmoi add` command. Add sensitive files one at a time so each choice can be reviewed.

Before the menu, the hook prints a preview of every matching line (`line<TAB>detector<TAB>source line`) to your terminal so you can confirm exactly what was detected.

The hook marks the templates it creates, so it will not overwrite templates maintained by hand. Normal value changes are updated automatically. If secret fields are added, removed, or renamed, the hook stops without changing anything and asks for a manual migration.

#### 🚀 Usage

Simply use the standard `chezmoi` command:

```bash
chezmoi add ~/.config/myapp/config.yaml
```

If the script detects secrets, it will prompt you for action in the terminal.

### 🧪 Development & Testing

If you modify `scripts/check-secrets.sh` or the `.chezmoi.toml.tmpl` configuration, you **must** ensure that the test suite passes.

#### 🏃 Running Tests

Run the five CI test suites to verify secret handling, removed-file safety, bootstrap behavior, and rendering across supported platforms:

```bash
bash ./scripts/test_check-secrets.sh
bash ./scripts/test_apply-secrets.sh
bash ./scripts/test_scan-secrets.sh
bash ./scripts/test_check-removed-files.sh
bash ./scripts/test_bootstrap.sh
```

#### 🔎 Reusable scanning for CI / pre-commit

Scan explicit files:

```bash
./scripts/scan-secrets.sh path/to/file1 path/to/file2
```

Emit JSON for CI tooling / annotations:

```bash
./scripts/scan-secrets.sh --format json path/to/file1
```

Emit SARIF for code scanning uploads:

```bash
./scripts/scan-secrets.sh --format sarif path/to/file1 > secrets.sarif
```

Emit GitHub Actions workflow annotations:

```bash
./scripts/scan-secrets.sh --format gha path/to/file1
```

Scan staged git files in a pre-commit hook (deleted entries are filtered automatically):

```bash
./scripts/scan-secrets.sh --git-staged
```

Explicit inputs fail closed: every path must name an existing regular file. Missing files—including paths absent from a sparse checkout—print a diagnostic and return status 1, the same status used when a secret is found. When scanning tracked files, filter unavailable paths and preserve unusual filenames with NUL delimiters:

```bash
git ls-files -z | while IFS= read -r -d '' file; do
    [ -f "$file" ] && printf '%s\0' "$file"
done | xargs -0 ./scripts/scan-secrets.sh --
```

Run the security-focused test suites:

```bash
bash ./scripts/test_check-secrets.sh
bash ./scripts/test_apply-secrets.sh
bash ./scripts/test_scan-secrets.sh
bash ./scripts/test_check-removed-files.sh
bash ./scripts/test_bootstrap.sh
```

### 🗑️ Removed Files After Updates

Before an update, `scripts/check-removed-files.sh` quickly records which source files belong to which destination files. After the update, it looks only at files deleted or renamed by Git, removing the destinations whose sources are gone. This makes the repository the source of truth. Stopping tracking a file *is* the decision to remove it, and `chezmoi update` is where that decision gets carried out.

It never deletes on a guess. A target is unlinked only when it is a regular file or a symlink inside the destination directory, nothing in chezmoi manages it any more, its source is provably absent from `HEAD`, and its contents have not changed since the update started. `jq` is required; if it, or any information needed to be sure, is unavailable, the file is reported instead of deleted. How many files a commit removed is never itself a reason to doubt it, and every destination is still checked on its own.

A directory goes when the files it was made for go. Once a run has removed every file chezmoi tracked inside one, it tries `rmdir` on it and on each parent up to the destination directory. That needs no confirmation and has no undo, because `rmdir` only succeeds on a directory that is genuinely empty, hidden files included: one untracked leftover, or one directory chezmoi still manages, and the directory stays. Only directories on the way up from a file this run actually removed are considered — a directory that never held a tracked file is not this hook's business, and nothing it holds is ever opened. That is also why nothing here keeps a copy of what it deleted: a deletion that could not be checked is left where it is, and the file it removes is still in the git history named in the message.

What a run could not carry out goes to a pending ledger under `~/.cache/chezmoi/check-removed-files/`—a preview, a target that failed one of the checks above, a source Git could not be asked about. Nothing is dropped and nothing has to be remembered: the next `chezmoi update` settles that ledger as part of finishing itself. `clean` is there for when you want to look by hand, and it re-verifies every entry rather than trusting the note:

```bash
./scripts/check-removed-files.sh clean           # settle the list
./scripts/check-removed-files.sh clean --list    # look; nothing is removed
```

`clean` needs no hook environment—a `--destination` override is recovered by asking chezmoi itself—and refuses to run while an update holds its lock. State lives under `~/.cache/chezmoi/check-removed-files/` in a directory named after the working tree it belongs to, because that cache directory is shared by every chezmoi source on the machine; a second source can neither act on another's targets nor discard a baseline it still owes.

State outlives the update that wrote it: the snapshot a successful post consumed is kept as a baseline, so a removal whose update never reached the pre hook—an interrupted apply, a `git pull` followed by `chezmoi apply` instead of `chezmoi update`, an update that pulled nothing—is still carried out later instead of being silently forgotten. A report is not repeated forever: the next update that brings its own snapshot advances the baseline, and a target that is already gone is never offered again. State is written and read by this one script and nothing else, so anything it cannot parse is dropped rather than acted on; deleting the state directory simply means the next update starts from a fresh snapshot, and abandoned scratch files are reaped after a day.
