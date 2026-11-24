#!/bin/sh
# herdr-status.sh — the tab-bar pill for herdr-sync.
#
# Wired through [ui] tab_bar_right = [{ type = "command", ... }]. Herdr re-runs
# command entries on the server every interval_seconds and renders the last line
# of successful output, clearing the entry on empty output — so printing a line
# while sync is ON and nothing while it is OFF gives a persistent indicator whose
# disappearance is itself the "sync off" signal (that is why there is no
# "sync off" toast).
#
# Tab-local: Herdr hands command entries the *active* tab in HERDR_ACTIVE_TAB_ID
# (verified against a running 0.9.5 server), so the pill prints only on a tab that
# is actually synced and stays silent on the others and in other workspaces.
#
# Latency note: interval_seconds cannot go below 1, so the pill can lag a keypress
# by up to a second. The instant acknowledgement is the toast in herdr-sync.sh.
#
# Keep this cheap — it runs on a timer, no herdr calls, no network.
state="${HERDR_SYNC_STATE:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/sync.state}"
LABEL="Sync panes: ON"

# Periodic housekeeping. This is the only automatic fold trigger that does not wait
# for somebody to open a pane: Herdr gives [[keys.command]] no timer (verified on
# 0.9.5 — "unknown config key keys.command.N.interval_seconds; ignoring key"), but it
# does re-run tab-bar command entries every interval_seconds, which makes this the
# right home for folding leftovers. Throttled by the same stamp herdr-sync-hook.sh
# uses, and fired in the background because this script has a 2s timeout. herdr-sync
# still decides *what* is safe to fold (panes that are gone) and locks against a
# concurrent fold, so running it here cannot disturb a live pane.
#
#   touch ~/.config/herdr/no-autofold     stop the periodic fold
#   HERDR_HIST_AUTOFOLD=0                 stop it at shell startup (in a pane)
statedir="${state%/*}"
syncbin="${HERDR_SYNC_BIN:-$statedir/scripts/herdr-sync.sh}"
if [ "${HERDR_HIST_AUTOFOLD:-1}" != 0 ] && [ -x "$syncbin" ] && [ ! -e "$statedir/no-autofold" ]; then
  stamp="$statedir/fold.stamp"
  now=$(date +%s 2>/dev/null || echo 0)
  last=$(cut -c1-20 "$stamp" 2>/dev/null | tr -dc 0-9); last=${last:-0}
  if [ "$((last + 60))" -le "$now" ]; then
    mkdir -p "$statedir" 2>/dev/null && printf '%s' "$now" >"$stamp" 2>/dev/null &&
      ( "$syncbin" fold --quiet >/dev/null 2>&1 & ) >/dev/null 2>&1
  fi
fi

[ -f "$state" ] || exit 0

# The pill is a hot path (once a second), so avoid jq when it is not needed: the
# viewed tab simply has to appear in the enabled state file.
viewed="${HERDR_ACTIVE_TAB_ID:-}"
if command -v jq >/dev/null 2>&1; then
  on="$(jq -r 'if .enabled == true and ((.tabs // []) | index("'"$viewed"'")) != null then "yes" else "" end' "$state" 2>/dev/null)" || on=""
else
  grep -qF -- "$viewed" "$state" 2>/dev/null && on=yes || on=""
fi

[ -n "$on" ] || exit 0

# No viewed tab, nothing to gate on: stay silent rather than guess. Herdr always
# supplies HERDR_ACTIVE_TAB_ID to command entries (verified on 0.9.5).
[ -n "$viewed" ] || exit 0

printf '%s\n' "$LABEL"
