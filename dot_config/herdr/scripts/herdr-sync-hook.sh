# shellcheck shell=bash
# herdr-sync-hook.sh — command-start hook for herdr-sync (zsh AND bash, one file).
# Sourced, never executed: there is no shebang because the shell that reads this is the
# shell that owns it (.zshrc or .bashrc). Checked as bash, its closest superset: the
# file must still parse under sh -n and zsh -n, so it stays off bash-only syntax where
# a portable spelling exists (no [[ -o ]], no $+functions[...]), which the CI matrix
# verifies on three shells.
#
# Source it from whichever rc you use; it detects the shell that is sourcing it:
#   . "$HOME/.config/herdr/scripts/herdr-sync-hook.sh"
#
# It forwards every command line you submit to `herdr-sync.sh mirror`, which
# replays it in the other panes of the same tab while the toggle is on
# (prefix+e). Outside Herdr it installs nothing, so the same two lines are
# correct in .zshrc and .bashrc on macOS, Linux and Termux alike.
#
#   herdr-sync status | on | off | toggle | send | doctor    (also on prefix+e)
#
# Inside a Herdr pane this also gives the pane its own history file (see
# "one pane, one history" below); outside Herdr it changes nothing at all.
#
# Why one file cannot be plain POSIX: POSIX sh has no command-start hook — no
# preexec, no DEBUG trap. zsh must be hooked with preexec, bash with the DEBUG
# trap, and the choice can only be made at source time by looking at
# ZSH_VERSION / BASH_VERSION. That branch lives here so the rc files stay
# identical (same trick starship's init takes). Everything else is POSIX.
#
# Per-shell notes:
#   zsh   preexec gets the whole line as the user typed it, including pipes.
#   bash  no preexec, so the DEBUG trap is used and the line is recovered from
#         history: $BASH_COMMAND reports one simple command at a time, which
#         would broadcast `ls | grep x` as two separate commands. The trap fires
#         once per simple command, hence the per-line de-duplication. It is not
#         inherited by child shells or scripts (no `set -T`), so nothing leaks
#         into the programs the panes run.
#   other dash/ksh/fish: the herdr-sync wrapper still works, mirroring cannot.

# Executing this instead of sourcing it would silently do nothing, so say so —
# but only where the test is trustworthy. In zsh, $0 is the name of the file being
# sourced, exactly as it is when the file is executed, so zsh cannot be asked;
# bash exposes BASH_SOURCE, which stays the file's path while $0 stays the shell's.
if [ -n "${BASH_SOURCE:-}" ] && [ "${BASH_SOURCE[0]:-}" = "$0" ]; then
  printf 'herdr-sync-hook.sh: source this file from your rc, do not execute it\n' >&2
  exit 1
fi

# Only wire up inside Herdr panes; a plain terminal has nothing to sync.
if [ -z "${HERDR_ENV:-}" ]; then
  herdr-sync() {
    printf 'herdr-sync: not inside a Herdr pane (HERDR_ENV unset)\n' >&2
    return 1
  }
  return 0
fi

# Register this pane as "a shell here can mirror". Herdr cannot tell a script that
# a pane's shell was started before this hook existed, which is the usual reason
# sync appears to do nothing; `herdr-sync doctor` reads these markers to say so.
# Filename encoding must stay identical to hook_enc() in herdr-sync.sh.
_hsync_registry() {
  local dir=${HERDR_SYNC_STATE:-$HOME/.config/herdr/sync.state}
  printf '%s/%s' "${dir%/*}/hooks" "$(printf '%s' "$HERDR_PANE_ID" | tr -c 'A-Za-z0-9._' '_')"
}
if [ -n "${HERDR_PANE_ID:-}" ]; then
  _hsync_marker="$(_hsync_registry)"
  # "<shell pid> <shell name> <pane id>"; the pid is compared against Herdr's own
  # `pane process-info`, so a marker left behind by a shell that has since exited
  # can never be mistaken for a live one.
  mkdir -p "${_hsync_marker%/*}" 2>/dev/null && \
    printf '%s %s %s\n' "$$" "${ZSH_VERSION:+zsh}${BASH_VERSION:+bash}" "$HERDR_PANE_ID" >"$_hsync_marker" 2>/dev/null || true
fi

# ---- one pane, one history ---------------------------------------------------
# Your history config otherwise shares a single file across every session on the
# machine (zsh: SHARE_HISTORY; bash: histappend plus `history -a` in
# PROMPT_COMMAND), so "up arrow" in pane B can surface what you typed in pane A
# even with sync off — and since sync replays command lines into sibling panes,
# that collision would otherwise happen on every broadcast. Inside Herdr each
# pane gets its own history file next to the shared one:
#   ~/.zsh_history.w5_p1        (bash panes: ~/.bash_history.w5_p1)
# HERDR_HIST_SEED = how many recent commands a brand-new pane starts with, copied
# out of the shared file into its own (0 = start empty). Keep it modest: whatever is
# copied here is what `herdr-sync fold` will re-append to the shared file later.
# Pane ids are reused across server restarts, so a new pane can inherit the history
# of an earlier pane that happened to get the same id; `herdr-sync fold` deletes a
# pane's file once its pane is gone, which keeps that window small.
if [ -n "${HERDR_PANE_ID:-}" ]; then
  if [ -n "${ZSH_VERSION:-}" ]; then
    _hsync_hist_shared=${HISTFILE:-$HOME/.zsh_history}
  else
    _hsync_hist_shared=${HISTFILE:-$HOME/.bash_history}
  fi
  # HISTFILE may be relative (zsh resolves those against $HOME); anchor it so a pane's
  # file lands next to the shared file, not in the shell's current directory.
  case $_hsync_hist_shared in
    /*) ;;
    *) _hsync_hist_shared="$HOME/$_hsync_hist_shared" ;;
  esac
  _hsync_seed=${HERDR_HIST_SEED-500}
  HISTFILE="$_hsync_hist_shared.$(printf '%s' "$HERDR_PANE_ID" | tr -c 'A-Za-z0-9._' '_')"

  if [ ! -e "$HISTFILE" ]; then
    # 077 inside a subshell only: a bare umask here would leak into your whole session.
    ( umask 077; : >"$HISTFILE" ) 2>/dev/null || true
    _hsync_new=1
  else
    _hsync_new=0
  fi
  chmod 600 "$HISTFILE" 2>/dev/null || true

  # Give a brand-new pane some memory. Both shells read their history file *after* the
  # rc file finishes, so seeding in memory here (fc -R / history -r) is wiped a moment
  # later -- measured in a real pty, both shells came back remembering nothing. The
  # only thing they will read is the file, so the seed has to go in the file.
  #
  # The cost: `herdr-sync fold` re-appends those seeded lines to the shared file when
  # this pane's file is folded back, so the default is small on purpose. With
  # HERDR_HIST_SEED=0 a new pane starts empty and folding then duplicates nothing.
  if [ "$_hsync_new" = 1 ] && [ "$_hsync_seed" != 0 ] && [ -r "$_hsync_hist_shared" ]; then
    tail -n "$_hsync_seed" "$_hsync_hist_shared" >>"$HISTFILE" 2>/dev/null || true
  fi

  # No `history -c` / `history -r` dance here, for either shell: both read their
  # history file *after* the rc file (measured: an interactive bash's list is empty at
  # rc time and filled from HISTFILE by the first prompt), so simply pointing HISTFILE
  # at the pane's file is enough. Reloading by hand only lists every entry twice.
  unset _hsync_hist_shared _hsync_seed _hsync_new
fi

# Everything below needs the sync script itself. It is checked *after* pane
# registration and history isolation above: those only describe this pane, and
# silently skipping them just because the binary moved would be a bad trade.
: "${HERDR_SYNC_BIN:=$HOME/.config/herdr/scripts/herdr-sync.sh}"
if [ ! -x "$HERDR_SYNC_BIN" ]; then
  herdr-sync() {
    printf 'herdr-sync: script not found/executable at %s\n' "$HERDR_SYNC_BIN" >&2
    return 1
  }
  return 0
fi

herdr-sync() { "$HERDR_SYNC_BIN" "$@" </dev/null; }

# Leftover per-pane histories (panes that have since closed) are merged back into
# the shared file and deleted, so disk use does not grow with every pane you ever
# opened. Fire-and-forget and throttled: shell startup must never wait on the
# Herdr socket for this. HERDR_HIST_AUTOFOLD=0 turns it off.
if [ "${HERDR_HIST_AUTOFOLD:-1}" != 0 ]; then
  _hsync_stamp=${HERDR_SYNC_STATE:-$HOME/.config/herdr/sync.state}; _hsync_stamp="${_hsync_stamp%/*}/fold.stamp"
  _hsync_now=$(date +%s 2>/dev/null || echo 0)
  _hsync_last=$(cut -c1-20 "$_hsync_stamp" 2>/dev/null | tr -dc 0-9)
  if [ "$((_hsync_last + 60))" -le "$_hsync_now" ]; then
    mkdir -p "${_hsync_stamp%/*}" 2>/dev/null && printf '%s' "$_hsync_now" >"$_hsync_stamp" 2>/dev/null && \
      ( "$HERDR_SYNC_BIN" fold --quiet >/dev/null 2>&1 & ) 2>/dev/null
  fi
  unset _hsync_stamp _hsync_now _hsync_last
fi

# Re-source guard: without it zsh stacks a second preexec (and bash re-arms the
# trap) every time the rc is re-read, so each command would be broadcast twice.
if [ -n "${_HERDR_SYNC_HOOKED:-}" ]; then
  return 0
fi
_HERDR_SYNC_HOOKED=1

# "$-" carries i in both zsh and bash. Deliberately not [[ -o interactive ]]:
# bash validates option names inside [[ ]] while *parsing*, and its option is -i,
# so that spelling makes the whole file unreadable in bash.
_herdr_sync_interactive() { case "$-" in *i*) return 0 ;; *) return 1 ;; esac; }

# The one job, shared by both shells: hand the submitted line to the sync script.
# Detached and silent on purpose — a slow or failing mirror must never delay or
# dirty the prompt, and state lives in the script's state file, not here.
_herdr_sync_line() {
  [ -n "${1:-}" ] || return 0
  "$HERDR_SYNC_BIN" mirror -- "$1" </dev/null >/dev/null 2>&1
  return 0
}

if [ -n "${ZSH_VERSION:-}" ]; then
  _herdr_sync_preexec() {
    _herdr_sync_interactive || return 0
    _herdr_sync_line "$1"        # $1 = full command line, pre-execution
  }
  if autoload -Uz add-zsh-hook 2>/dev/null; then
    add-zsh-hook preexec _herdr_sync_preexec
  else
    preexec_functions+=(_herdr_sync_preexec)
  fi
  # Tab completion for subcommands (no-op before compinit has run).
  # Gate is a runtime lookup, not zsh's (( $+functions[compdef] )): that is
  # zsh-only *syntax* and bash refuses to even parse the file. compdef exists
  # only in zsh, and only after compinit has run.
  if [ -n "$(command -v compdef 2>/dev/null)" ]; then
    _herdr_sync_cmds() {
      _describe 'command' '(status on off toggle send)'
    }
    compdef _herdr_sync_cmds herdr-sync
  fi
elif [ -n "${BASH_VERSION:-}" ]; then
  __herdr_sync_last=""
  _herdr_sync_preexec() {
    _herdr_sync_interactive || return 0
    # NB: no FUNCNAME filter. The DEBUG trap is not inherited into functions
    # without `set -T`, so it already only fires at top level — and since the
    # trap action is itself a function call, FUNCNAME always holds at least this
    # frame, which would reject every command.
    local line
    # shellcheck disable=SC1007  # prefix assignment for one builtin call: empty HISTTIMEFORMAT
    line="$(HISTTIMEFORMAT= history 1 2>/dev/null)" || return 0
    # Drop the history number. BRE on purpose: sed -E is a BSD/GNU extension and
    # this has to parse on Termux too. Anchoring the number to the leading run of
    # digits+space is what keeps a command like `2to3 x` intact.
    line="$(printf '%s' "$line" | sed 's/^[[:space:]]*[0-9][0-9]*[[:space:]]*//')"
    [ -n "$line" ] || return 0
    [ "$line" = "$__herdr_sync_last" ] && return 0
    __herdr_sync_last="$line"
    _herdr_sync_line "$line"
  }
  trap '_herdr_sync_preexec' DEBUG
  complete -W 'status on off toggle send' herdr-sync 2>/dev/null || true
fi
