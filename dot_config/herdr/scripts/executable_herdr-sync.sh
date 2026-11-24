#!/usr/bin/env bash
# herdr-sync — tmux-style synchronize-panes for Herdr, scoped to one tab.
#
# Herdr 0.9.5 has no synchronize-panes (verified against the binary: no
# sync/broadcast action among the 63 bindable keys.* actions; `herdr pane
# send-keys <PANE_ID>` takes exactly one pane). This recreates the behaviour of
# `setw synchronize-panes` from three Herdr primitives:
#
#   * `herdr pane current` reports the CALLER's pane, so a pane always knows who
#     it is — it works from inside a pane and from a detached keybinding alike
#     (both verified against a running server);
#   * a shell hook (herdr-sync-hook.sh, sourced by .zshrc and .bashrc) hands each
#     command line about to execute to `herdr-sync mirror`;
#   * mirror replays that line into the sibling panes of the same tab.
#
# Scope: per tab, like tmux's window option. prefix+e toggles the tab you are
# looking at and leaves every other tab alone, so several tabs can be synced at
# once and each remembers its own state. The tab-bar pill prints on a synced tab
# and stays silent on any tab that is not synced.
#
# No visible marker. tmux injects raw keystrokes, so receivers show nothing
# special; to stay loop-free without a `_HERDR_SYNC=1`-style prefix in the text,
# every injection is first recorded as a one-shot "receipt" (pane + exact text +
# expiry) in sync.spool. When a pane runs a command that matches a receipt
# issued for it, that receipt is consumed and the line is NOT re-broadcast. The
# command a receiving pane shows is therefore exactly what you typed.
#
# Subcommands
#   status            state of the toggle, plus which panes are involved
#   on [-f]           enable sync for the current tab (-f also types into agents)
#   off [-a]          disable sync for this tab (-a: for every tab)
#   toggle            toggle the current tab only
#   send [flags] [cmd] one-shot replay to the tab's other panes, no state change
#   compose           open a scratch pane under this one, pre-typed with
#                    "herdr-sync bcast -- ": type the command, Enter runs it in the tab
#   bcast -- <cmd>    run one line in the tab's mirrorable panes, then close the pane
#                    it was typed in (this is what compose sets up)
#   cancel <pane>     close a scratch pane you decided against
#   doctor [--all] [--fix]  which panes can actually mirror (shell hook loaded?)
#   fold [--all] [--keep] [--print]  merge per-pane history back into the shared
#                    file (~/.zsh_history / ~/.bash_history) and delete the
#                    per-pane files, so they cannot accumulate; by default only
#                    panes that are gone are folded
#   mirror <cmd>      internal: called by the shell hooks
#
# send flags: -n no Enter, -N dry-run, -y no confirm, -f include agent panes,
#             --panes id,id
#
# Environment: HERDR_SYNC_TTL (receipt lifetime, default 5s), HERDR_SYNC_STATE,
# HERDR_SYNC_SPOOL overrides. Hooks register themselves under <state dir>/hooks.
#
# Safety: panes Herdr reports as hosting an agent, or as working/blocked, are
# never typed into unless -f/--force, because Enter submits an agent prompt.
#
# Portable: bash 3.2 (macOS default) through 5.x; no GNU-only tools. Every path
# needs a live Herdr server and exits quietly otherwise, so sourcing the hooks
# on a host without Herdr is harmless.
set -eu

CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/herdr"
STATE="${HERDR_SYNC_STATE:-$CFG_DIR/sync.state}"
SPOOL="${HERDR_SYNC_SPOOL:-$CFG_DIR/sync.spool}"
TTL="${HERDR_SYNC_TTL:-5}"
SEP=$'\x1f'
PILL_ON="Sync panes: ON"
HERDR="${HERDR_BIN_PATH:-}"
[ -n "$HERDR" ] || HERDR="$(command -v herdr 2>/dev/null || echo /opt/homebrew/bin/herdr)"

usage() { sed -n '2,41p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'; }
die() { printf 'herdr-sync: %s\n' "$1" >&2; exit "${2:-1}"; }
short() { printf '%s' "$1" | sed 's/^.*:p/p/'; }
count_lines() { printf '%s\n' "$1" | awk 'NF{n++} END{print n+0}'; }
now() { date +%s; }

need_tools() {
  command -v jq >/dev/null 2>&1 || die "needs jq" 1
  [ -x "$HERDR" ] || die "herdr binary not found ($HERDR)" 1
}

# ---- state -------------------------------------------------------------
is_on()      { [ -f "$STATE" ] && jq -e '.enabled == true and ((.tabs // []) | length > 0)' "$STATE" >/dev/null 2>&1; }
synced_tabs(){ is_on && jq -r '(.tabs // [])[]' "$STATE" 2>/dev/null || true; }
tab_synced() { is_on && jq -e --arg t "$1" '(.tabs // []) | index($t) != null' "$STATE" >/dev/null 2>&1; }
state_force(){ is_on && jq -r 'if .force then 1 else 0 end' "$STATE" 2>/dev/null || printf 0; }
# The tab a broadcast belongs to; empty when nothing is synced.
state_tab()  { is_on && jq -r '(.tabs // [])[0] // empty' "$STATE" 2>/dev/null || true; }

# One `pane list` snapshot per invocation: the server itself says which pane
# sits in which tab, which is the only trustworthy answer here.
fetch_panes() {
  local raw
  raw="$("$HERDR" pane list 2>/dev/null)" || die "cannot reach the Herdr server (is one up? check HERDR_SOCKET_PATH)" 1
  printf '%s' "$raw" | jq -e '.result.panes' >/dev/null 2>&1 || die "unexpected reply from \`herdr pane list\`" 1
  PANES_RAW="$(printf '%s' "$raw" | jq -r '.result.panes[] | [ .pane_id, (.tab_id // "?"), (.agent // "-"), (.agent_status // "unknown"), (.cwd // "?") ] | @tsv')"
}
pane_tab() { printf '%s\n' "${PANES_RAW:-}" | awk -F'\t' -v p="$1" '$1==p{print $2; exit}'; }

# Whose tab are we scoping to?
#   inside a pane            HERDR_PANE_ID / HERDR_TAB_ID (exact, exported by Herdr)
#   detached keys.command    HERDR_ACTIVE_PANE_ID / HERDR_ACTIVE_TAB_ID, which Herdr
#                            keeps pointed at the *focused* pane
# `herdr pane current` is deliberately NOT trusted for scoping: measured against a
# live 0.9.5 server it stayed pinned to one pane across `herdr tab focus` on three
# other tabs, which is exactly what made prefix+e keep re-recording the first tab.
# It is kept only as a last resort, flagged so callers can complain.
# tmux broadcasts keystrokes, so an "exit" typed in a synced tmux window closes
# whatever it closes and that is tmux's problem; here we replay command lines, so we
# can simply decline. One broadcast "exit" would close every pane in the tab, and the
# sync machinery must never mirror itself. Checked on the first word, so that
# `shutdown -h now` counts as `shutdown`.
dangerous_first_word() {
  case "${1%%[[:space:]]*}" in
    exit | logout | halt | poweroff | reboot | shutdown | init | herdr | herdr-sync) return 0 ;;
    *) return 1 ;;
  esac
}

my_ctx() {
  MY_PANE="${HERDR_PANE_ID:-${HERDR_ACTIVE_PANE_ID:-}}"
  MY_TAB="${HERDR_TAB_ID:-${HERDR_ACTIVE_TAB_ID:-}}"
  # Only the missing half is filled in, and from the server's pane table. When
  # Herdr gave us nothing at all we refuse to guess rather than record a tab the
  # user is not looking at.
  if [ -z "$MY_PANE" ] && [ -z "$MY_TAB" ]; then
    printf 'herdr-sync: cannot tell which tab you are looking at (no HERDR_ACTIVE_TAB_ID or HERDR_TAB_ID) — run this inside a Herdr pane or through a Herdr keybinding\n' >&2
    return 1
  fi
  if [ -n "$MY_PANE" ] && [ -z "$MY_TAB" ]; then fetch_panes; MY_TAB="$(pane_tab "$MY_PANE")"; fi
  [ -n "$MY_TAB" ]
}

# Sets SYNC_TARGETS / SYNC_SKIPPED to the other panes of tab $2, excluding $1.
# $3=1 also includes agent/busy panes.
siblings() {
  local exclude="$1" tab="$2" force="$3" rows idle busy
  rows="$(printf '%s\n' "${PANES_RAW:-}" | awk -F'\t' -v tab="$tab" -v ex="$exclude" '$2==tab && $1!=ex && NF>=4')"
  idle="$(printf '%s\n' "$rows" | awk -F'\t' '$3=="-" && ($4=="idle"||$4=="done"||$4=="unknown")')"
  busy="$(printf '%s\n' "$rows" | awk -F'\t' '$3!="-" || !($4=="idle"||$4=="done"||$4=="unknown")')"
  if [ "$force" = 1 ]; then SYNC_TARGETS="$rows"; SYNC_SKIPPED=""; else SYNC_TARGETS="$idle"; SYNC_SKIPPED="$busy"; fi
}

report() {
  printf '  from:  %s\n' "$(short "$1")"
  printf '  to:    %s\n' "$(printf '%s\n' "$SYNC_TARGETS" | awk -F'\t' 'NF{printf "%s ", $1}')"
  [ -n "$(printf '%s' "$SYNC_SKIPPED" | tr -d '[:space:]')" ] && \
    printf '  never: %s  (agent/busy — Enter would submit their prompt)\n' \
      "$(printf '%s\n' "$SYNC_SKIPPED" | awk -F'\t' 'NF{printf "%s ", $1}')"
}

# ---- receipts (loop prevention without a visible marker) ---------------
spool_prune() {
  [ -f "$SPOOL" ] || return 0
  local tmp; tmp="$(mktemp "${TMPDIR:-/tmp}/herdr-spool.XXXXXX")"
  awk -F"$SEP" -v n="$(now)" '$1+0 > n' "$SPOOL" > "$tmp" || true
  mv "$tmp" "$SPOOL" 2>/dev/null || true
}

spool_add() { # $1=pane $2=text
  mkdir -p "$(dirname "$SPOOL")"
  printf '%s%s%s%s%s\n' "$(( $(now) + TTL ))" "$SEP" "$1" "$SEP" "$2" >> "$SPOOL"
}

# Consumes a receipt matching this pane + this exact command line.
spool_take() { # $1=pane $2=text
  [ -f "$SPOOL" ] || return 1
  local tmp hit; tmp="$(mktemp "${TMPDIR:-/tmp}/herdr-spool.XXXXXX")"
  hit="$(awk -F"$SEP" -v p="$1" -v c="$2" -v n="$(now)" -v s="$SEP" \
        '$1+0 > n && $2 == p && $3 == c { print "yes"; exit }' "$SPOOL")"
  [ "$hit" = "yes" ] || { rm -f "$tmp"; return 1; }
  awk -F"$SEP" -v p="$1" -v c="$2" -v n="$(now)" '
    { if ($1+0 > n && $2 == p && $3 == c && !done) { done=1; next } print }' "$SPOOL" > "$tmp"
  mv "$tmp" "$SPOOL" 2>/dev/null || rm -f "$tmp"
  return 0
}

replay() { # $1=targets tsv $2=text $3=enter(1/0) $4=dry(1/0) $5=record receipts(1/0)
  local rows="$1" text="$2" enter="$3" dry="$4" record="$5" n=0 id
  while IFS=$'\t' read -r id _a _s _c; do
    [ -n "$id" ] || continue
    if [ "$dry" = 1 ]; then printf '  [dry] %s <- %s\n' "$id" "$text"
    else
      # Receipt first, then the keystrokes: a receiver must never see text it
      # cannot yet match, or it would re-broadcast and loop.
      [ "$record" = 1 ] && spool_add "$id" "$text"
      if [ "$enter" = 1 ]; then "$HERDR" pane run "$id" "$text" >/dev/null
      else "$HERDR" pane send-text "$id" "$text" >/dev/null; fi
    fi
    n=$((n+1))
  done <<EOF
$rows
EOF
  printf '%s' "$n"
}

# ---- which panes can mirror ------------------------------------------------
# A pane can only mirror if its shell sourced herdr-sync-hook.sh, which registers
# itself here (pid, shell, pane id) at that moment. Panes started before the rc
# lines existed — or after `chezmoi apply` without a reload — registered nothing,
# and then sync silently does nothing. That silence is the bug this reports on.
HOOKDIR="${STATE%/*}/hooks"
PANE_PID_CACHE=""

hook_enc() { printf '%s' "$1" | tr -c 'A-Za-z0-9._' '_'; }   # keep in sync with the hook
hook_marker() { printf '%s/%s' "$HOOKDIR" "$(hook_enc "$1")"; }

# The pane's live shell pid, straight from Herdr (cached: one call per pane).
pane_shell_pid() {
  local hit sp
  hit="$(printf '%s\n' "$PANE_PID_CACHE" | awk -F= -v p="$1" '$1==p && $2!=""{print $2; exit}')"
  [ -n "$hit" ] && { printf '%s' "$hit"; return 0; }
  sp="$("$HERDR" pane process-info --pane "$1" 2>/dev/null | jq -r '.result.process_info.shell_pid // empty' 2>/dev/null)" || sp=""
  PANE_PID_CACHE="$PANE_PID_CACHE
$1=$sp"
  printf '%s' "$sp"
}

hooked_pane() { # $1=pane_id → success when a hooked shell is that pane's current shell
  local f pid _sh pane sp; f="$(hook_marker "$1")"; [ -r "$f" ] || return 1
  read -r pid _sh pane <"$f" 2>/dev/null || return 1
  [ "${pane:-}" = "$1" ] || return 1                  # marker belongs to this pane
  sp="$(pane_shell_pid "$1")"
  if [ -n "$sp" ]; then
    [ "$pid" = "$sp" ]                                 # exact: same shell process
  else
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null        # fallback: process exists
  fi
}
hook_pid() { cut -d' ' -f1 "$(hook_marker "$1")" 2>/dev/null; }
hook_shell() { cut -d' ' -f2 "$(hook_marker "$1")" 2>/dev/null; }

# Counts hooked / unhooked rows of $1 (targets tsv).
count_hooks() { # sets HOOK_OK, HOOK_MISSING
  HOOK_OK=0; HOOK_MISSING=0; local id
  while IFS=$'\t' read -r id _a _s _c; do
    [ -n "$id" ] || continue
    if hooked_pane "$id"; then HOOK_OK=$((HOOK_OK+1)); else HOOK_MISSING=$((HOOK_MISSING+1)); fi
  done <<EOF
$1
EOF
}

warn_unhooked() {
  [ "${HOOK_MISSING:-0}" = 0 ] && return 0
  if [ "${HOOK_OK:-0}" = 0 ]; then
    printf '  WARNING: no pane in this tab can mirror: their shells were started before\n'
    printf '         the hook was installed. Reload them (exec $SHELL) or run: herdr-sync doctor --fix\n'
  else
    printf '  note: %s of %s target pane(s) cannot mirror yet (hooked: %s) — see: herdr-sync doctor\n' \
      "$HOOK_MISSING" "$((HOOK_OK+HOOK_MISSING))" "$HOOK_OK"
  fi
}

# Fold per-pane history files (written by herdr-sync-hook.sh) back into the shared
# history file, then remove them. Files belonging to panes that are still running
# are left alone: their shell is still writing there, and folding a live file
# would only split that pane's history in two.
#
# Nothing needs to be stopped to run this: it reads the server's own pane table and
# only touches files whose pane is not in it. It can be run inside Herdr, from a
# plain shell, or from the tab-bar timer (herdr-status.sh does that every minute).
#
# Two callers can race anyway (e.g. a new shell's startup fold and the timer fold).
# The stamp file only throttles, so exclusivity comes from this lock: mkdir is
# atomic on every unix, and a lock older than 5 minutes is treated as abandoned by a
# process that died mid-fold, so a crash cannot permanently stall housekeeping.
fold_lock_acquire() {
  FOLD_LOCK="${HERDR_SYNC_STATE:-$HOME/.config/herdr/sync.state}"; FOLD_LOCK="${FOLD_LOCK%/*}/fold.lock"
  mkdir -p "${FOLD_LOCK%/*}" 2>/dev/null || true
  mkdir "$FOLD_LOCK" 2>/dev/null && return 0
  if find "$FOLD_LOCK" -maxdepth 0 -mmin +5 2>/dev/null | grep -q .; then
    rmdir "$FOLD_LOCK" 2>/dev/null && mkdir "$FOLD_LOCK" 2>/dev/null && return 0
  fi
  return 1
}

fold_lock_release() { [ -n "${FOLD_LOCK:-}" ] && rmdir "$FOLD_LOCK" 2>/dev/null; return 0; }

cmd_fold() {
  local mode=orphan keep=0 quiet=0 print_only=0 base shared f suffix n raw
  for a in "$@"; do
    case "$a" in
      --all) mode=all ;; --keep) keep=1 ;; --print) print_only=1 ;; --quiet) quiet=1 ;;
      *) die "fold: unknown option $a" 2 ;;
    esac
  done
  # --print only reads, so it does not need the lock; anything that appends does.
  if [ "$print_only" != 1 ] && ! fold_lock_acquire; then
    [ "$quiet" = 1 ] || printf 'another fold is running; nothing done\n'
    return 0
  fi
  trap 'fold_lock_release' EXIT INT TERM

  # Live panes, encoded exactly the way the hook names the files. Encoding ids
  # rather than decoding filenames keeps this lossless (":" became "_" on purpose).
  local live="" server_up=0
  raw="$("$HERDR" pane list 2>/dev/null)" || raw=""
  if printf '%s' "$raw" | jq -e '.result.panes' >/dev/null 2>&1; then
    server_up=1
    live="$(printf '%s' "$raw" | jq -r '.result.panes[].pane_id' | while IFS= read -r i; do hook_enc "$i"; printf '\n'; done)"
  fi
  local folded=0 kept=0 bytes=0
  for base in .zsh_history .bash_history; do
    shared="$HOME/$base"
    for f in "$HOME/$base".[A-Za-z0-9._]*; do
      [ -f "$f" ] || continue
      case "$f" in "$shared") continue ;; esac
      suffix="${f##*"$base".}"
      if [ "$mode" = orphan ] && [ "$server_up" = 1 ] && printf '%s\n' "$live" | grep -qx -- "$suffix"; then
        [ "$quiet" = 1 ] || printf '  keep   %s  (pane still running there)\n' "${f##*/}"
        kept=$((kept+1)); continue
      fi
      n="$(wc -c <"$f" | tr -d ' ')"
      if [ "$print_only" = 1 ]; then
        printf '  would fold %s (%s bytes)\n' "${f##*/}" "$n"
        folded=$((folded + 1)); bytes=$((bytes + n)); continue
      fi
      if [ "$n" != 0 ]; then
        ( umask 077; cat -- "$f" >>"$shared" ) 2>/dev/null || { printf 'herdr-sync: could not append %s\n' "$f" >&2; continue; }
        chmod 600 "$shared" 2>/dev/null || true
      fi
      folded=$((folded+1)); bytes=$((bytes+n))
      if [ "$keep" = 0 ]; then rm -f -- "$f"; else kept=$((kept+1)); fi
    done
  done
  [ "$quiet" = 1 ] && return 0
  if [ "$folded" = 0 ] && [ "$kept" = 0 ]; then printf 'nothing to fold (no per-pane history files)\n'
  else printf '%s %s pane history file(s), %s byte(s); left alone: %s%s\n' \
    "$([ "$print_only" = 1 ] && echo would-fold || echo folded)" "$folded" "$bytes" "$kept" \
    "$([ "$keep" = 1 ] && echo " (--keep: re-running will append them again)" )"
  fi
  [ "$server_up" = 1 ] || [ "$quiet" = 1 ] || printf '  note: no Herdr server answered, so every file was treated as a leftover\n'
}

cmd_doctor() {
  need_tools
  local scope=tab fix=0 rows id ag st pane pid sp n=0
  for a in "$@"; do
    case "$a" in
      --all) scope=all ;; --tab) scope=tab ;; --fix) fix=1 ;;
      *) die "doctor: unknown option $a" 2 ;;
    esac
  done
  fetch_panes
  my_ctx 2>/dev/null || true
  [ "$scope" = tab ] && [ -z "${MY_TAB:-}" ] && scope=all
  if [ "$scope" = tab ]; then
    rows="$(printf '%s\n' "$PANES_RAW" | awk -F'\t' -v t="$MY_TAB" '$2==t')"
    printf 'herdr-sync doctor — tab %s\n' "$MY_TAB"
  else
    rows="$PANES_RAW"
    printf 'herdr-sync doctor — all panes\n'
  fi
  local ok=0 miss=0 guard=0
  while IFS=$'\t' read -r id pane ag st _c; do
    [ -n "$id" ] || continue
    if [ "$ag" != "-" ]; then
      printf '  %-8s agent pane (%s, %s) — never typed into without --force\n' "$id" "$ag" "$st"
      guard=$((guard+1))
    elif hooked_pane "$id"; then
      printf '  %-8s can mirror (pid %s, %s)\n' "$id" "$(hook_pid "$id")" "$(hook_shell "$id")"
      ok=$((ok+1))
    elif [ "$fix" = 1 ] && { [ "$st" = idle ] || [ "$st" = unknown ] || [ "$st" = "done" ]; }; then
      "$HERDR" pane run "$id" "exec ${SHELL:-zsh}" >/dev/null 2>&1
      printf '  %-8s was unhooked → ran `exec %s`; re-check with: herdr-sync doctor\n' "$id" "${SHELL:-zsh}"
      miss=$((miss+1))
    else
      printf '  %-8s NO SHELL HOOK — its commands will not be broadcast; run: exec %s\n' "$id" "${SHELL:-zsh}"
      miss=$((miss+1))
    fi
  done <<EOF
$rows
EOF
  # Drop registrations whose pane is gone or whose shell has been replaced. The
  # pane id is read from the marker's own contents, never guessed from its name.
  if [ -d "$HOOKDIR" ]; then
    for m in "$HOOKDIR"/*; do
      [ -e "$m" ] || continue
      read -r pid _sh pane <"$m" 2>/dev/null || continue
      sp=""; [ -n "$pane" ] && sp="$(pane_shell_pid "$pane")"
      if [ -z "$pane" ] || ! printf '%s\n' "$PANES_RAW" | cut -f1 | grep -qx -- "$pane" || \
         { [ -n "$sp" ] && [ "$pid" != "$sp" ]; } || { [ -z "$sp" ] && ! kill -0 "${pid:-0}" 2>/dev/null; }; then
        rm -f "$m"
      fi
    done
  fi
  printf '  can mirror: %s, cannot: %s, agent-protected: %s\n' "$ok" "$miss" "$guard"
  printf '  per-pane history: herdr-sync fold --print\n'
}

toast() { "$HERDR" notification show "$1" --body "$2" --position bottom-right --sound "${3:-none}" >/dev/null 2>&1 || true; }

# ---- subcommands -------------------------------------------------------
cmd_status() {
  need_tools
  if is_on; then
    # Purely diagnostic here: status must still answer without a tab context.
    my_ctx 2>/dev/null || true
    fetch_panes
    printf 'sync: ON  tabs=%s  viewing=%s%s\n' "$(synced_tabs | tr '\n' ' ')" "${MY_TAB:-?}" \
      "$(tab_synced "${MY_TAB:-}" && printf ' (this tab synced)' || printf ' (this tab NOT synced)')"
    siblings "${MY_PANE:-}" "${MY_TAB:-$(state_tab)}" "$(state_force)"
    report "${MY_PANE:-?}"
    count_hooks "$SYNC_TARGETS"
    printf '  can mirror: %s/%s target pane(s)  (details: herdr-sync doctor)\n' "$HOOK_OK" "$((HOOK_OK+HOOK_MISSING))"
  else
    printf 'sync: OFF  (state file: %s)\n' "$STATE"
  fi
}

cmd_on() {
  need_tools
  local force=0
  while [ $# -gt 0 ]; do
    case "$1" in -f|--force) force=1 ;; *) die "on: unknown option $1" 2 ;; esac
    shift
  done
  my_ctx || die "no Herdr tab context — see herdr-sync.sh --help" 1
  fetch_panes
  mkdir -p "$(dirname "$STATE")"
  # State first, then the toast: the tab-bar pill polls once a second, so the
  # earlier the file lands, the sooner the pill can show it. Other tabs already
  # synced are merged in rather than replaced.
  local before; before="$(synced_tabs | tr '\n' ' ')"
  jq -n --arg tab "$MY_TAB" --arg ws "${HERDR_WORKSPACE_ID:-}" --arg force "$force" \
        --arg since "$(date '+%Y-%m-%d %H:%M:%S')" --argjson prev "$(tabs_json)" \
     '{enabled:true, tabs: (($prev + [$tab]) | unique), force:($force=="1"), workspace:$ws, since:$since, last:$tab}' > "$STATE"
  # The pill cannot be instant: Herdr re-runs command entries at a 1s floor
  # (interval_seconds minimum). This toast is the immediate acknowledgement.
  siblings "$MY_PANE" "$MY_TAB" "$force"
  count_hooks "$SYNC_TARGETS"
  if [ "${HOOK_MISSING:-0}" != 0 ] && [ "${HOOK_OK:-0}" = 0 ]; then
    toast "$PILL_ON" "no pane here can mirror yet — run: herdr-sync doctor" warning
  else
    toast "$PILL_ON" "typing in this tab replays in its other panes" request
  fi
  printf '%s — tab %s\n' "$PILL_ON" "$MY_TAB"
  warn_unhooked
  [ -n "${before// /}" ] && printf '  other synced tabs: %s\n' "$before"
  report "$MY_PANE"
}

cmd_off() {
  local all=0
  if [ $# -gt 0 ]; then
    case "$1" in -a|--all) all=1 ;; *) die "off: unknown option $1" 2 ;; esac
  fi
  if [ "$all" = 1 ]; then rm -f "$STATE"; printf 'sync: OFF for every tab\n'; return 0; fi
  my_ctx || die "no Herdr tab context — use off --all" 1
  local left; left="$(synced_tabs | grep -vx -- "$MY_TAB" | tr '\n' ' ')"
  if [ -z "${left// /}" ]; then
    rm -f "$STATE"                       # last one off: delete the file so the pill clears
    printf 'sync: OFF — tab %s\n' "$MY_TAB"
  else
    local tmp; tmp="$(mktemp "${TMPDIR:-/tmp}/herdr-state.XXXXXX")"
    jq --arg t "$MY_TAB" '.tabs = [(.tabs // [])[] | select(. != $t)]' "$STATE" > "$tmp" && mv "$tmp" "$STATE"
    printf 'sync: OFF — tab %s (still on: %s)\n' "$MY_TAB" "$left"
  fi
}

# prefix+e: affects only the tab in view, matching tmux's per-window option.
cmd_toggle() {
  need_tools
  if my_ctx && tab_synced "$MY_TAB"; then
    cmd_off
  else
    cmd_on
  fi
}

# JSON array of the tabs currently synced, for merging in cmd_on.
tabs_json() { is_on && jq -c '(.tabs // [])' "$STATE" 2>/dev/null || printf '[]'; }

cmd_mirror() {
  local raw=""
  [ $# -gt 0 ] && shift
  [ $# -gt 0 ] && raw="$*"
  is_on || return 0
  [ -n "$raw" ] || return 0
  case "$raw" in
    " "*)     return 0 ;;   # leading space = run here only, do not broadcast
    *"$nl"*)  return 0 ;;   # multiline input would desync the panes
  esac
  dangerous_first_word "$raw" && return 0
  spool_prune
  my_ctx || return 0
  [ -n "$MY_PANE" ] || return 0                  # must know itself to avoid a loop
  fetch_panes
  # Tab from the server's own pane table, not from memory: if a pane was moved
  # between tabs, or the state was set from another tab, this is what decides.
  local mytab; mytab="$(pane_tab "$MY_PANE")"; [ -n "$mytab" ] || mytab="${MY_TAB:-}"
  [ -n "$mytab" ] || return 0
  tab_synced "$mytab" || return 0                # only tabs switched on broadcast
  spool_take "$MY_PANE" "$raw" && return 0       # this line came from a sibling
  siblings "$MY_PANE" "$mytab" "$(state_force)"
  [ -n "$(printf '%s' "$SYNC_TARGETS" | tr -d '[:space:]')" ] || return 0
  replay "$SYNC_TARGETS" "$raw" 1 0 1 >/dev/null
  return 0
}

cmd_send() {
  need_tools
  local enter=1 dry=0 assume_yes=0 force=0 only="" cmd=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -n|--no-enter) enter=0; shift ;;
      -N|--dry-run)  dry=1; shift ;;
      -y|--yes)      assume_yes=1; shift ;;
      -f|--force)    force=1; shift ;;
      -a|--all)      printf 'herdr-sync: sync is tab-scoped; -a is gone\n' >&2; shift ;;
      --panes)       only="${2:-}"; shift 2 ;;
      -h|--help)     usage; exit 0 ;;
      --)            shift; [ $# -gt 0 ] && cmd="$*"; break ;;
      -*)            die "unknown option $1" 2 ;;
      *)             [ -n "$cmd" ] && cmd="$cmd $1" || cmd="$1"; shift ;;
    esac
  done
  my_ctx || die "cannot determine the current pane" 1
  fetch_panes
  siblings "${HERDR_PANE_ID:-$MY_PANE}" "$MY_TAB" "$force"
  if [ -n "$only" ]; then
    SYNC_TARGETS="$(printf '%s\n' "$SYNC_TARGETS" | awk -F'\t' -v w="$only" 'BEGIN{n=split(w,a,",");for(i=1;i<=n;i++)keep[a[i]]=1} keep[$1]')"
  fi
  local n; n="$(count_lines "$SYNC_TARGETS")"
  [ "$n" != 0 ] || die "no targetable panes in tab $MY_TAB — use -f/--force or --panes" 1
  printf 'herdr-sync send — %d target(s)\n' "$n"
  report "$MY_PANE"
  printf '\n'
  if [ -z "$cmd" ]; then
    [ -t 0 ] || die "no command given and stdin is not a terminal" 2
    IFS= read -r -e -p "sync> " cmd || exit 1
  fi
  [ -n "$cmd" ] || die "empty command, nothing sent" 1
  if [ "$dry" = 1 ]; then printf '[dry-run] would send to %d pane(s): %s\n' "$n" "$cmd"; exit 0; fi
  if [ "$assume_yes" != 1 ]; then
    printf 'Send "%s" to %d pane(s)? [y/N] ' "$cmd" "$n"
    IFS= read -r -e ans || ans=""
    case "$ans" in [yY]|[yY][eE][sS]) ;; *) echo "aborted"; exit 1 ;; esac
  fi
  # No receipts: a manual send is a deliberate one-way replay, and the receivers
  # have no reason to bounce it back.
  local sent; sent="$(replay "$SYNC_TARGETS" "$cmd" "$enter" 0 0)"
  printf 'sent "%s" to %s pane(s)\n' "$cmd" "$sent"
}

# ---- compose: type once in a scratch pane, run it across the tab -----------
# Herdr has no tmux "choose-buffer/command prompt" for panes, so this builds one from
# primitives: a narrow pane is created under the one you were in and pre-typed with
# "herdr-sync bcast -- ". Whatever you append is executed by Enter, fanned out to the
# tab's mirrorable panes, and the scratch pane closes itself. Agent/busy panes are
# skipped on exactly the same rule sync uses.
pane_create() { # $1 = pane to split from; prints the new pane's id
  local out id
  out="$("$HERDR" pane split "$1" --direction down --ratio 0.3 --no-focus 2>&1)"
  # production answers {"result":{"pane":{"pane_id":...}}}; the older shape is kept
  # as a fallback so an upgrade in either direction cannot strand this feature.
  id="$(printf '%s' "$out" | jq -r '.result.pane.pane_id // .result.pane_id // empty' 2>/dev/null)"
  case "$id" in
    '' | null) die "could not create a scratch pane: $(printf '%s' "$out" | head -1)" 1 ;;
  esac
  printf '%s' "$id"
}

cmd_compose() {
  need_tools
  my_ctx || die "cannot determine the current pane" 1
  fetch_panes
  local src="${HERDR_PANE_ID:-$MY_PANE}"
  [ -n "$src" ] || src="$(printf '%s\n' "$PANES_RAW" | awk -F'\t' -v t="$MY_TAB" '$2==t{print $1; exit}')"
  [ -n "$src" ] || die "no pane in tab $MY_TAB to compose against" 1
  local scratch
  scratch="$(pane_create "$src")"
  "$HERDR" pane send-text "$scratch" "herdr-sync bcast -- " >/dev/null 2>&1 ||
    printf 'herdr-sync: could not pre-type into %s; type it yourself\n' "$scratch" >&2
  printf 'herdr-sync: scratch pane %s — type a command, Enter runs it in tab %s\n' "$scratch" "$MY_TAB"
  toast "herdr-sync" "Scratch pane $scratch: Enter runs it in this tab"
}

cmd_bcast() { # $1.. = the command; run it in the tab, then close this scratch pane
  local cmd targets n
  [ "${1:-}" = "--" ] && shift
  cmd="$*"
  [ -n "$cmd" ] || die "usage: herdr-sync bcast -- <command>" 2
  if dangerous_first_word "$cmd"; then
    die "refusing to broadcast '$1' — that would close or hijack panes; run it in one pane" 1
  fi
  my_ctx || die "cannot determine the current pane" 1
  fetch_panes
  siblings "${HERDR_PANE_ID:-$MY_PANE}" "$MY_TAB" 0
  n="$(count_lines "$SYNC_TARGETS")"
  [ "$n" != 0 ] || die "no mirrorable sibling panes in tab $MY_TAB" 1
  targets="$SYNC_TARGETS"
  replay "$targets" "$cmd" 1 0 0 >/dev/null
  # Close the pane this was typed in last: it exists only to hold the command line.
  [ -n "${HERDR_PANE_ID:-}" ] && "$HERDR" pane close "$HERDR_PANE_ID" >/dev/null 2>&1
  printf 'ran "%s" in %s pane(s)\n' "$cmd" "$n"
  toast "herdr-sync" "Ran in $n pane(s): $cmd"
}

cmd_cancel() {
  [ $# -ge 1 ] || die "usage: herdr-sync cancel <pane_id>" 2
  "$HERDR" pane close "$1" >/dev/null 2>&1 || die "could not close $1" 1
  printf 'closed %s\n' "$1"
}

nl=$'\n'
main() {
  sub="${1:-status}"; [ $# -gt 0 ] && shift
  case "$sub" in
    status) cmd_status ;;
    on)     cmd_on "$@" ;;
    off)    cmd_off "$@" ;;
    toggle) cmd_toggle "$@" ;;
    send)    cmd_send "$@" ;;
    compose) cmd_compose ;;
    bcast)   cmd_bcast "$@" ;;
    cancel)  cmd_cancel "$@" ;;
    doctor) cmd_doctor "$@" ;;
    fold)   cmd_fold "$@" ;;
    mirror) cmd_mirror "$@" ;;
    -h|--help|help) usage ;;
    *) die "unknown subcommand '$sub' (try: help)" 2 ;;
  esac
}
main "$@"
