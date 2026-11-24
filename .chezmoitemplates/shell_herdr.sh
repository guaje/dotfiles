# Herdr synchronize-panes (prefix+e inside a Herdr tab). The hook decides at
# source time whether it is in zsh (preexec) or bash (DEBUG trap), so these
# lines are identical in .zshrc and .bashrc and need no OS gate: it is inert
# unless HERDR_ENV is set, which Herdr exports only into its own panes.
#
# Knobs for the per-pane history that hook also sets up. Both are read once, at
# source time, so they must be set here — before the hook is sourced:
#   HERDR_HIST_SEED      lines a brand-new pane starts with, copied out of
#                        ~/.zsh_history into its own pane file. Shells read their
#                        history file after the rc, so this has to be a copy. Keep it
#                        small: `herdr-sync fold` re-appends them to the shared file.
#                        0 = new panes start empty and folding duplicates nothing.
#   HERDR_HIST_AUTOFOLD  0 disables the throttled "herdr-sync fold" that merges
#                        leftover per-pane history back into the shared file and
#                        deletes the pane copies (default: on, at most once a minute).
HERDR_HIST_SEED=${HERDR_HIST_SEED-500}
if [ -r "$HOME/.config/herdr/scripts/herdr-sync-hook.sh" ]; then
  . "$HOME/.config/herdr/scripts/herdr-sync-hook.sh"
fi
