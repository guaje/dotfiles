# Dotfiles Configuration Overview

This directory (`~/.config`) serves as the central hub for managing user-specific configuration files (dotfiles) for various CLI tools and development environments on Android (Termux). The project employs `chezmoi` for robust dotfiles management, including encryption support via `age`.

## Project Components

### 1. [chezmoi](./chezmoi/)
*   **Purpose:** Manages the lifecycle of dotfiles, ensuring consistency across environments.
*   **Key Files:**
    *   `chezmoi.toml`: Configuration for `chezmoi`, specifying `age` for encryption.
    *   `key.txt`: Private key for `age` decryption (sensitive).
*   **Workflow:** Use `chezmoi add <file>` to track new configurations and `chezmoi apply` to deploy changes.

### 2. [Starship](./starship/)
*   **Purpose:** A cross-shell prompt that provides rich contextual information.
*   **Configuration:** `config.toml`
*   **Theme:** **Catppuccin Mocha** palette.
*   **Key Features:**
    *   Nerd Font icons for languages (Python, Rust, Go, etc.) and directories.
    *   Enhanced modules for `git_status`, `git_metrics`, `kubernetes`, `terraform`, and `openstack`.
    *   Custom `continuation_prompt` for multi-line commands.
    *   Configured to show `username` and `hostname` contextually (SSH/Root).

### 3. [Neovim (nvim)](./nvim/)
*   **Purpose:** Highly extensible text editor.
*   **Structure:**
    *   `init.lua`: Main entry point setting basic editor preferences (tabs, spacing).
    *   `lua/config/lazy.lua`: Plugin manager configuration using `lazy.nvim`.
    *   `lua/plugins/`: Directory for individual plugin configurations (e.g., `telescope.lua`).
*   **Key Plugins:**
    *   `telescope.nvim`: Fuzzy finder for files and symbols.

### 4. [Tmux](./tmux/)
*   **Purpose:** Terminal multiplexer for managing multiple sessions and panes.
*   **Configuration:** `tmux.conf`
*   **Key Features:**
    *   Mouse support enabled.
    *   Vi-style mode keys for navigation.
    *   Automatic pane opening in the current working directory.

## Usage & Development

### Adding Changes
When modifying configurations, always remember to add them to `chezmoi` to persist changes in the source repository:
```bash
chezmoi add ~/.config/starship/config.toml
```

### Encryption
Sensitive files are encrypted using `age`. Ensure the `key.txt` is protected and correctly referenced in `chezmoi.toml`.

### Validation
After updating the Starship configuration, verify for any parsing errors:
```bash
starship explain
```
