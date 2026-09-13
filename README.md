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

The hook marks the templates it creates, so it will not overwrite templates maintained by hand. Normal value changes are updated automatically. If secret fields are added, removed, or renamed, the hook stops without changing anything and asks for a manual migration.

For a manual migration, back up the existing template and encrypted SOPS file outside the source directory, move the old pair aside, and run `chezmoi add` again. Test the new result before deleting the backup, and restore the backup if anything fails. Never place a decrypted backup in the repository.

#### 🚀 Usage

Simply use the standard `chezmoi` command:

```bash
chezmoi add ~/.config/myapp/config.yaml
```

If the script detects secrets, it will prompt you for action in the terminal.

### 🧪 Development & Testing

If you modify `scripts/check-secrets.sh` or the `.chezmoi.toml.tmpl` configuration, you **must** ensure that the test suite passes.

#### 🏃 Running Tests

Run the following scripts to verify that adding secrets, reusable scanning, and rendering templates works correctly across different file formats and directory structures:

```bash
./scripts/test_check-secrets.sh
./scripts/test_apply-secrets.sh
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

Scan staged git files in a pre-commit hook:

```bash
./scripts/scan-secrets.sh --git-staged
```

Use it in CI with tracked files:

```bash
git ls-files | xargs ./scripts/scan-secrets.sh
```

Run the security-focused test suites:

```bash
bash ./scripts/test_check-secrets.sh
bash ./scripts/test_apply-secrets.sh
bash ./scripts/test_scan-secrets.sh
bash ./scripts/test_check-removed-files.sh
```

The tests use temporary directories and test-only secrets, so they do not touch the real source directory or reveal real values. CI runs the same Bash tests and ShellCheck on Linux and macOS.

On macOS, install a current version of Bash and the required tools with Homebrew:

```bash
brew install bash chezmoi sops age jq
```

It is fine to launch `chezmoi` from zsh. The hooks themselves run with the Homebrew version of Bash found in `PATH`; macOS's built-in Bash 3.2 is too old.

### 🗑️ Removed Files After Updates

Before an update, `scripts/check-removed-files.sh` quickly records which source files belong to which destination files. After the update, it looks only at files deleted or renamed by Git. If an old destination may need to be removed, the hook asks about it individually—there is no “delete all” option.

The hook never deletes directories and leaves a file alone if it was modified, is still managed, or cannot be checked safely. Dry runs and non-interactive updates do not delete anything. `jq` is required; if it or any needed information is unavailable, the hook reports the file instead of removing it.

### 🔧 Configuration

The system is configured via `.chezmoi.toml.tmpl`, which sets up the `SOPS_AGE_KEY_FILE` environment variable and defines the `secret` command using a portable shell wrapper to ensure path expansion (e.g., `~` or `$HOME`) works correctly on all machines.
