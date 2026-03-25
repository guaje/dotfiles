# Dotfiles Management with Chezmoi & SOPS

This repository uses `chezmoi` to manage dotfiles, with a focus on securely handling secrets using `sops` and `age`.

## Secrets Management: `check-secrets.sh`

A custom pre-add hook, `scripts/check-secrets.sh`, expands the standard `chezmoi add` functionality. It automatically scans files for sensitive patterns (e.g., `API_KEY`, `PASSWORD`) before they are added to the source directory.

### How it Works

When you run `chezmoi add <file>`, the script triggers and provides several options if sensitive data is detected:

1.  **Full Encryption:** Encrypts the entire file using `chezmoi`'s built-in `age` support.
2.  **SOPS Strategy (Recommended):** 
    *   Extracts only the sensitive key-value pairs.
    *   Saves them into a SOPS-encrypted YAML file in subdirectories within `secrets/` mirroring their relative `$HOME` path (e.g., `secrets/dot_config/app/settings.yaml.sops.yaml`).
    *   Converts the original file into a `chezmoi` template that retrieves values from the encrypted secrets at `chezmoi apply` time.
3.  **Plain:** Adds the file as-is (not recommended for secrets).
4.  **Abort:** Cancels the `add` operation.

### Usage

Simply use the standard `chezmoi` command:

```bash
chezmoi add ~/.config/myapp/config.yaml
```

If the script detects secrets, it will prompt you for action in the terminal.

## Development & Testing

If you modify `scripts/check-secrets.sh` or the `.chezmoi.toml.tmpl` configuration, you **must** ensure that the test suite passes.

### Running Tests

Run the following scripts to verify that adding secrets and rendering templates works correctly across different file formats and directory structures:

```bash
./scripts/test_check-secrets.sh
./scripts/test_apply-secrets.sh
```

These tests are also automatically executed via GitHub Actions on every push to the `scripts/` directory or the main configuration template, ensuring compatibility across `bash`, `zsh`, and `fish` shells.

## Configuration

The system is configured via `.chezmoi.toml.tmpl`, which sets up the `SOPS_AGE_KEY_FILE` environment variable and defines the `secret` command using a portable shell wrapper to ensure path expansion (e.g., `~` or `$HOME`) works correctly on all machines.
