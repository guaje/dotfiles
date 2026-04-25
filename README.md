# 🔐 Dotfiles Management with Chezmoi & SOPS

This repository uses `chezmoi` to manage dotfiles, with a focus on securely handling secrets using `sops` and `age`.

## 🛠️ Secrets Management: `check-secrets.sh`

A custom pre-add hook, `scripts/check-secrets.sh`, expands the standard `chezmoi add` functionality. It automatically scans files for sensitive patterns (e.g., `API_KEY`, `PASSWORD`) and provider-specific tokens before they are added to the source directory.

The shared detector logic lives in `scripts/check-secrets.awk`, and can also be reused outside `chezmoi add` via `scripts/scan-secrets.sh` for CI and pre-commit checks.

### ⚙️ How it Works

When you run `chezmoi add <file>`, the script triggers and provides several options if sensitive data is detected:

1.  **📦 Full Encryption:** Encrypts the entire file using `chezmoi`'s built-in `age` support.
2.  **🛡️ SOPS Strategy (Recommended):** 
    *   Extracts only the sensitive key-value pairs.
    *   Saves them into a SOPS-encrypted YAML file in subdirectories within `secrets/` mirroring their relative `$HOME` path (e.g., `secrets/dot_config/app/settings.yaml.sops.yaml`).
    *   Converts the original file into a `chezmoi` template that retrieves values from the encrypted secrets at `chezmoi apply` time.
3.  **📄 Plain:** Adds the file as-is (not recommended for secrets).
4.  **🛑 Abort:** Cancels the `add` operation.

### 🚀 Usage

Simply use the standard `chezmoi` command:

```bash
chezmoi add ~/.config/myapp/config.yaml
```

If the script detects secrets, it will prompt you for action in the terminal.

## 🧪 Development & Testing

If you modify `scripts/check-secrets.sh` or the `.chezmoi.toml.tmpl` configuration, you **must** ensure that the test suite passes.

### 🏃 Running Tests

Run the following scripts to verify that adding secrets, reusable scanning, and rendering templates works correctly across different file formats and directory structures:

```bash
./scripts/test_check-secrets.sh
./scripts/test_apply-secrets.sh
```

### 🔎 Reusable scanning for CI / pre-commit

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

Run the dedicated scanner tests:

```bash
./scripts/test_scan-secrets.sh
```

These tests are also automatically executed via GitHub Actions on every push to the `scripts/` directory or the main configuration template, ensuring compatibility across `bash`, `zsh`, and `fish` shells.

## 🔧 Configuration

The system is configured via `.chezmoi.toml.tmpl`, which sets up the `SOPS_AGE_KEY_FILE` environment variable and defines the `secret` command using a portable shell wrapper to ensure path expansion (e.g., `~` or `$HOME`) works correctly on all machines.
