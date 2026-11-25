#!/usr/bin/env bash
# run-tests.sh — test suite for everything in herdr/scripts/.
#
#   ~/.config/herdr/scripts/tests/run-tests.sh
#
# Offline and deterministic: herdr-sync.sh is driven against ./fake-herdr.sh (via
# HERDR_BIN_PATH), which serves a fixed pane topology and records every
# injection, so no live Herdr server is needed and nothing is typed into your
# real panes. Needs bash + jq. Runs on a bash-only host too (Termux): every case
# whose vehicle is zsh skips itself there instead of failing — check that the summary
# reports skips, not failures, when zsh is missing (verified with a PATH with no zsh).
#
# Coverage: herdr-sync.sh (toggle semantics, tab scope, agent protection, loop
# prevention, text fidelity, receipt expiry), herdr-status.sh (pill text and
# tab-local gating), and both shell hooks (inert outside Herdr, no stacked
# preexec, syntax).
set -u

here="$(cd "$(dirname "$0")" && pwd)"
S="$here/../herdr-sync.sh"
PILL="$here/../herdr-status.sh"
HOOK="$here/../herdr-sync-hook.sh"
FAKEBIN="$here/fake-sync-bin.sh"
PTYT="$here/pty-hook-test.sh"

pass=0 fail=0 skip=0
ok()   { pass=$((pass+1)); printf 'ok    %-46s %s\n' "$1" "$2"; }
bad()  { fail=$((fail+1)); printf 'FAIL  %-46s %s\n' "$1" "$2"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; }
no()   { skip=$((skip+1)); printf 'skip  %-46s %s\n' "$1" "$2"; }
chk()  { local n="$1" want="$2" got="$3"; if [ "$want" = "$got" ]; then ok "$n" "got [$got]"; else bad "$n" "want [$want] got [$got]"; fi; }

fresh() { # new temp HOME / state / spool / call log
  D="$(mktemp -d "${TMPDIR:-/tmp}/herdrtest.XXXXXX")"
  HOME="$D" HERDR_SYNC_STATE="$D/sync.state" HERDR_SYNC_SPOOL="$D/sync.spool" \
  HERDR_BIN_PATH="$here/fake-herdr.sh" FAKE_LOG="$D/log" \
  FAKE_CUR_PANE="${FAKE_CUR_PANE:-w0:p0}" FAKE_CUR_TAB="${FAKE_CUR_TAB:-w0:t0}" \
  HERDR_WORKSPACE_ID=w1
  export HOME HERDR_SYNC_STATE HERDR_SYNC_SPOOL HERDR_BIN_PATH FAKE_LOG FAKE_CUR_PANE FAKE_CUR_TAB HERDR_WORKSPACE_ID
  : > "$D/log"
  unset HERDR_PANE_ID HERDR_TAB_ID HERDR_ACTIVE_PANE_ID HERDR_ACTIVE_TAB_ID HERDR_SYNC_TTL 2>/dev/null || true
}
log() { cat "$FAKE_LOG" 2>/dev/null; }
have() { command -v "$1" >/dev/null 2>&1; }
skip_if_missing() { # $1=shell $2=label; 0 means "caller should continue to next case"
  if have "$1"; then return 1; fi
  no "$2 ($1 vehicle)" "$1 not installed (bash-only host)"
  return 0
}
# Permission string via BSD or GNU stat. Deliberately no "assume correct" fallback:
# when neither flavour works this prints unknown, which fails the assertion loudly
# instead of silently passing on the other platform.
# GNU stat must be tried first: it reads -f as --file-system, prints a filesystem
# table and exits 0, so a BSD-first order "succeeds" with the wrong answer on Linux.
mode_of() { stat -c '%A' "$1" 2>/dev/null || stat -f '%Sp' "$1" 2>/dev/null || printf 'unknown'; }
# The fake CLI separates its log fields with real tabs. grep in a single-quoted
# pattern gets a literal backslash-t, which GNU BRE reads as the letter t: the want-0
# assertions below would then pass without matching anything at all. $'\t' is a real
# tab in bash, which runs this suite.
TAB=$'\t'
# Cases that only need *some* interactive-ish shell to source the hook use whichever
# one exists, so a bash-only box still exercises them.
PROBE_SHELL=zsh; have zsh || PROBE_SHELL=bash
case $PROBE_SHELL in zsh) PROBE_ARGS="-f" ;; *) PROBE_ARGS="--norc --noprofile" ;; esac
runs() { log | awk -F'\t' '$1=="RUN"{print $2}' | sort | tr '\n' ' '; }

# Turn sync on the way prefix+e does: detached, with Herdr pointing ACTIVE_* at the
# focused pane (w1:t1 here). `pane current` is a decoy in this fixture.
turn_on() { HERDR_ACTIVE_PANE_ID=w1:p2 HERDR_ACTIVE_TAB_ID=w1:t1 bash "$S" on >/dev/null 2>&1; }

echo "# herdr scripts test suite"
command -v jq >/dev/null 2>&1 || { echo "jq is required"; exit 2; }
[ -x "$S" ] || { echo "not executable: $S"; exit 2; }

# --- tab identity (the bug: `pane current` ignores focus) ---------------
fresh
HERDR_ACTIVE_PANE_ID=w1:p4 HERDR_ACTIVE_TAB_ID=w1:t2 bash "$S" on >/dev/null 2>&1
chk "on records the FOCUSED tab, not pane current" "w1:t2" "$(jq -r '(.tabs//[])|join(",")' "$HERDR_SYNC_STATE")"
chk "on refuses to guess without Herdr context" "1" "$(env -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_ACTIVE_PANE_ID -u HERDR_ACTIVE_TAB_ID bash "$S" on 2>&1 | grep -c 'cannot tell which tab')"
fresh; turn_on
HERDR_PANE_ID=w1:p2 HERDR_TAB_ID=BOGUS_TAB bash "$S" mirror -- "echo server-truth" >/dev/null 2>&1
chk "mirror trusts the server pane table" "w1:p3 " "$(runs)"

# --- herdr-sync.sh: state and the instant signal ------------------------
fresh
chk "status before any toggle" "sync: OFF" "$(bash "$S" status | cut -d'(' -f1 | sed 's/ *$//')"

fresh; turn_on
chk "on records the active tab" "w1:t1" "$(jq -r '(.tabs//[])|join(",")' "$HERDR_SYNC_STATE")"
chk "on toasts immediately (pill has 1s floor)" "1" "$(log | grep -c '^NOTIFY	Sync panes: ON')"
chk "on stdout uses the agreed label" "1" "$(bash "$S" status | grep -c 'sync: ON')"

# --- herdr-status.sh: exact label, tab-local ---------------------------
fresh; turn_on
chk "pill text on the synced tab" "Sync panes: ON" "$(HERDR_ACTIVE_TAB_ID=w1:t1 sh "$PILL")"
chk "pill silent on another tab of same ws" "" "$(HERDR_ACTIVE_TAB_ID=w1:t2 sh "$PILL")"
chk "pill silent in another workspace" "" "$(HERDR_ACTIVE_TAB_ID=w2:t1 sh "$PILL")"
chk "pill silent with no viewed-tab context" "" "$(sh "$PILL")"
fresh
chk "pill silent when state disabled" "" "$(jq -n '{enabled:false,tab:"w1:t1"}' >"$HERDR_SYNC_STATE"; HERDR_ACTIVE_TAB_ID=w1:t1 sh "$PILL")"

# --- mirror: who gets typed into -------------------------------------
fresh; turn_on
HERDR_PANE_ID=w1:p2 HERDR_TAB_ID=w1:t1 bash "$S" mirror -- "echo hi" >/dev/null 2>&1
chk "broadcast hits siblings only (self/agent/other tabs excluded)" "w1:p3 " "$(runs)"
if log | grep -qFx $'RUN\tw1:p3\techo hi'; then ok "sent text has no marker prefix" "exact match"; else bad "sent text has no marker prefix" "$(log | sed -n 2p | cat -v)"; fi
chk "receiver does not re-broadcast (loop guard)" "w1:p3 " "$(HERDR_PANE_ID=w1:p3 HERDR_TAB_ID=w1:t1 bash "$S" mirror -- "echo hi" >/dev/null 2>&1; runs)"

fresh; turn_on
HERDR_PANE_ID=w1:p4 HERDR_TAB_ID=w1:t2 bash "$S" mirror -- "echo elsewhere" >/dev/null 2>&1
chk "unsynced tab broadcasts nothing" "" "$(runs)"

fresh; turn_on
for cmd in " ls" "" "echo one
two" "herdr pane list"; do
  HERDR_PANE_ID=w1:p2 HERDR_TAB_ID=w1:t1 bash "$S" mirror -- "$cmd" >/dev/null 2>&1
done
chk "space/multiline/machinery excluded" "" "$(runs)"
fresh; turn_on
for cmd in "exit" "logout" "shutdown -h now"; do
  HERDR_PANE_ID=w1:p2 HERDR_TAB_ID=w1:t1 bash "$S" mirror -- "$cmd" >/dev/null 2>&1
done
chk "exit/logout/shutdown never fan out" "" "$(runs)"

fresh; turn_on
HERDR_PANE_ID=w1:p3 HERDR_TAB_ID=w1:t1 bash "$S" mirror -- "pwd" >/dev/null 2>&1
chk "agent pane never typed into" "w1:p2 " "$(runs)"

fresh; turn_on
HERDR_SYNC_TTL=0 HERDR_PANE_ID=w1:p2 HERDR_TAB_ID=w1:t1 bash "$S" mirror -- "echo ttl" >/dev/null 2>&1
HERDR_SYNC_TTL=0 HERDR_PANE_ID=w1:p3 HERDR_TAB_ID=w1:t1 bash "$S" mirror -- "echo ttl" >/dev/null 2>&1
# TTL 0 means the receipt is already stale, so the receiver replays it once back.
# Exactly two injections total proves the bounce is bounded, not a ping-pong storm.
chk "expired receipt re-broadcasts once" "2" "$(log | grep -c '^RUN')"
chk "expired receipt: both panes typed into once" "w1:p2 w1:p3 " "$(runs)"

# --- toggle semantics --------------------------------------------------
fresh; turn_on
HERDR_PANE_ID=w1:p2 HERDR_TAB_ID=w1:t1 bash "$S" on >/dev/null 2>&1   # idempotent
chk "on is idempotent (no duplicate tab entries)" "1" "$(HERDR_ACTIVE_PANE_ID=w1:p2 HERDR_ACTIVE_TAB_ID=w1:t1 bash "$S" on >/dev/null 2>&1; jq -r '(.tabs//[])|length' "$HERDR_SYNC_STATE")"
HERDR_PANE_ID=w1:p2 HERDR_TAB_ID=w1:t1 bash "$S" toggle >/dev/null 2>&1
chk "toggle in synced tab turns off" "absent" "$(test -f "$HERDR_SYNC_STATE" && echo present || echo absent)"
baHERDR_ACTIVE_PANE_ID=w1:p2 HERDR_ACTIVE_TAB_ID=w1:t1 bash "$S" on >/dev/null 2>&1   # detached path, as prefix+e gets it
chk "toggle works detached (prefix+e)" "w1:t1" "$(jq -r '(.tabs//[])|join(",")' "$HERDR_SYNC_STATE")"
HERDR_PANE_ID=w1:p4 HERDR_TAB_ID=w1:t2 bash "$S" toggle >/dev/null 2>&1
chk "toggling a 2nd tab leaves the 1st synced (tmux per-window)" "w1:t1,w1:t2" \
  "$(jq -r '(.tabs//[])|sort|join(",")' "$HERDR_SYNC_STATE")"
chk "pill prints on either synced tab" "2" \
  "$(for t in w1:t1 w1:t2; do HERDR_ACTIVE_TAB_ID=$t sh "$PILL"; done | grep -c 'Sync panes: ON')"
chk "pill silent on an unsynced tab" "" "$(HERDR_ACTIVE_TAB_ID=w1:t9 sh "$PILL")"
HERDR_PANE_ID=w1:p4 HERDR_TAB_ID=w1:t2 bash "$S" off >/dev/null 2>&1
chk "off affects only the tab in view" "w1:t1" "$(jq -r '(.tabs//[])|join(",")' "$HERDR_SYNC_STATE")"
HERDR_PANE_ID=w1:p2 HERDR_TAB_ID=w1:t1 bash "$S" on >/dev/null 2>&1
HERDR_ACTIVE_TAB_ID=w1:t2 bash "$S" off --all >/dev/null 2>&1
chk "off --all clears every tab" "absent" "$(test -f "$HERDR_SYNC_STATE" && echo present || echo absent)"
chk "no state file means no pill" "" "$(HERDR_ACTIVE_TAB_ID=w1:t1 sh "$PILL")"

# --- send (one-shot) ---------------------------------------------------
fresh
# Detached send: Herdr hands the binding the focused pane in ACTIVE_*.
chk "send dry-run: siblings of this tab" "1" \
  "$(env HERDR_ACTIVE_PANE_ID=w1:p2 HERDR_ACTIVE_TAB_ID=w1:t1 bash "$S" send -N -- pwd 2>&1 | grep -c 'to:    w1:p3')"
chk "send rejects removed workspace scope" "gone" \
  "$(env HERDR_ACTIVE_PANE_ID=w1:p2 HERDR_ACTIVE_TAB_ID=w1:t1 bash "$S" send -a -N -- pwd 2>&1 | grep -o 'gone')"
chk "send -f includes agent panes" "1" \
  "$(env HERDR_PANE_ID=w1:p2 HERDR_TAB_ID=w1:t1 bash "$S" send -f -N -- pwd 2>&1 | grep -c w1:p1)"

fresh
FAKE_FAIL=1 bash "$S" status >/dev/null 2>&1
chk "no server: status still answers" "1" "$(FAKE_FAIL=1 bash "$S" status 2>/dev/null | grep -c 'sync: OFF')"
chk "no server: on fails cleanly" "1" "$(FAKE_FAIL=1 HERDR_ACTIVE_TAB_ID=w1:t1 bash "$S" on 2>&1 | grep -c 'cannot reach the Herdr server')"

# --- who can actually mirror (the silent-failure this used to hide) -------
fresh
env HERDR_BIN_PATH="$here/fake-herdr.sh" HERDR_SYNC_STATE="$HERDR_SYNC_STATE" HERDR_SYNC_SPOOL="$HERDR_SYNC_SPOOL" \
    HERDR_ACTIVE_TAB_ID=w1:t1 HERDR_ACTIVE_PANE_ID=w1:p2 bash "$S" doctor --tab >"$D/doc1" 2>&1
chk "doctor flags an unhooked pane" "2" "$(grep -c 'NO SHELL HOOK' "$D/doc1")"
chk "doctor spares agent panes from blame" "1" "$(grep -c 'agent pane' "$D/doc1")"
env HERDR_ACTIVE_TAB_ID=w1:t1 HERDR_ACTIVE_PANE_ID=w1:p2 bash "$S" on >"$D/on1" 2>&1
chk "toggling on warns that nothing can mirror" "1" "$(grep -c 'no pane in this tab can mirror' "$D/on1")"
# A marker whose pid matches the pane's live shell pid (fake default 4242).
mkdir -p "$(dirname "$HERDR_SYNC_STATE")/hooks"
printf '4242 zsh w1:p3\n' >"$(dirname "$HERDR_SYNC_STATE")/hooks/w1_p3"
env HERDR_ACTIVE_TAB_ID=w1:t1 HERDR_ACTIVE_PANE_ID=w1:p2 bash "$S" doctor --tab >"$D/doc2" 2>&1
chk "doctor accepts a matching registration" "1" "$(grep -c 'w1:p3.*can mirror (pid 4242, zsh)' "$D/doc2")"
printf '9999 zsh w1:p3\n' >"$(dirname "$HERDR_SYNC_STATE")/hooks/w1_p3"
env HERDR_ACTIVE_TAB_ID=w1:t1 HERDR_ACTIVE_PANE_ID=w1:p2 bash "$S" doctor --tab >"$D/doc3" 2>&1
chk "a marker from a dead shell is not trusted" "1" "$(grep -c 'w1:p3.*NO SHELL HOOK' "$D/doc3")"
printf '4242 zsh w1:p9\n' >"$(dirname "$HERDR_SYNC_STATE")/hooks/w1_p3"
env HERDR_ACTIVE_TAB_ID=w1:t1 HERDR_ACTIVE_PANE_ID=w1:p2 bash "$S" doctor --tab >/dev/null 2>&1
chk "marker naming another pane is discarded" "1" "$(test -e "$(dirname "$HERDR_SYNC_STATE")/hooks/w1_p3" && echo kept || echo pruned | grep -c pruned)"
printf '4242 zsh w1:p3\n' >"$(dirname "$HERDR_SYNC_STATE")/hooks/w1_p3"
printf '4242 bash w1:p9\n' >"$(dirname "$HERDR_SYNC_STATE")/hooks/w1_p9"
env HERDR_ACTIVE_TAB_ID=w1:t1 HERDR_ACTIVE_PANE_ID=w1:p2 bash "$S" doctor --tab >/dev/null 2>&1
chk "stale pane registration is pruned" "absent" "$(test -e "$(dirname "$HERDR_SYNC_STATE")/hooks/w1_p9" && echo present || echo absent)"
env HERDR_ACTIVE_TAB_ID=w1:t1 HERDR_ACTIVE_PANE_ID=w1:p2 bash "$S" on >"$D/on2" 2>&1
chk "no warning once a pane can mirror" "0" "$(grep -c 'no pane in this tab can mirror' "$D/on2")"

# --- compose / bcast: one line typed once, run across the tab -------------
# Herdr has no command prompt for panes, so this is a hand-built one: a scratch pane
# pre-typed with "herdr-sync bcast -- ", whose Enter fans the line out and closes it.
fresh; turn_on
env HERDR_ACTIVE_PANE_ID=w1:p2 HERDR_ACTIVE_TAB_ID=w1:t1 bash "$S" compose >"$D/compose" 2>&1
chk "compose opens a scratch pane" "1" "$(grep -c 'w1:p9' "$D/compose")"
chk "compose pre-types the broadcast prefix" "1" "$(log | grep -c "TEXT${TAB}w1:p9${TAB}herdr-sync bcast -- ")"
chk "compose complains without Herdr context" "1" \
  "$(env -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_ACTIVE_PANE_ID -u HERDR_ACTIVE_TAB_ID bash "$S" compose 2>&1 | grep -c 'cannot determine')"

b() { env HERDR_PANE_ID=w1:p9 HERDR_TAB_ID=w1:t1 bash "$S" bcast "$@" 2>&1; }
fresh; turn_on
b -- echo hi >"$D/b1" 2>&1
chk "bcast runs the line in the tab's shells" "w1:p2 w1:p3 " "$(runs)"
chk "bcast skips the agent pane in the same tab" "0" "$(log | grep -c "RUN${TAB}w1:p1")"
chk "bcast closes the scratch pane it was typed in" "1" "$(log | grep -c "CLOSE${TAB}w1:p9")"
chk "bcast leaves the other tab and workspace alone" "0" "$(log | grep -cE "RUN${TAB}w1:p4|RUN${TAB}w2:p5")"
chk "bcast reports what it did" "1" "$(grep -c 'ran "echo hi" in 2 pane' "$D/b1")"
fresh; turn_on
chk "bcast refuses a line that would close the tab" "1" "$(b -- exit | grep -c 'refusing to broadcast')"
chk "bcast refused without typing anything" "0" "$(log | grep -c "RUN${TAB}")"
chk "bcast refuses to run itself" "1" "$(b -- herdr-sync off | grep -c 'refusing to broadcast')"
chk "bcast needs a command" "2" "$(b >/dev/null 2>&1; echo $?)"
chk "cancel closes a scratch pane" "1" "$(bash "$S" cancel w1:p9 >/dev/null 2>&1; log | grep -c "CLOSE${TAB}w1:p9")"

# --- folding pane history back, then deleting it --------------------------
# Per-pane files must not accumulate: leftovers get merged into the shared file and
# removed, while a file whose pane is still running is left for that shell to keep
# writing to. "Live" is decided by encoding the server's pane ids, never by
# decoding a filename (":" became "_" and that step is lossy). Each case builds its
# own fixture so no case depends on the last one.
fold_setup() {
  mkdir -p "$D/h"
  printf 'shared\n'        >"$D/h/.zsh_history"
  printf 'shared-bash\n'   >"$D/h/.bash_history"
  printf 'FROM-LIVE-PANE\n'  >"$D/h/.zsh_history.w1_p3"     # w1:p3 exists in the fixture
  printf 'FROM-DEAD-ZSH\n'   >"$D/h/.zsh_history.w9_p9"     # nothing like it exists
  printf 'FROM-DEAD-BASH\n'  >"$D/h/.bash_history.gone_p1"  # bash pane, also gone
}
fold() { HOME="$D/h" HERDR_BIN_PATH="${FAKE:-$here/fake-herdr.sh}" bash "$S" fold "$@"; }

fresh; fold_setup; fold >"$D/f1" 2>&1
chk "fold merges leftovers into the right shared file" "1 1" \
  "$(grep -c FROM-DEAD-ZSH "$D/h/.zsh_history") $(grep -c FROM-DEAD-BASH "$D/h/.bash_history")"
chk "fold leaves a live pane's file alone" "present" "$(test -f "$D/h/.zsh_history.w1_p3" && echo present || echo absent)"
chk "fold does not pull a live pane's commands in yet" "0" "$(grep -c FROM-LIVE "$D/h/.zsh_history")"
chk "fold removes the leftovers it merged" "absent" "$(test -e "$D/h/.zsh_history.w9_p9" && echo present || echo absent)"
chk "fold covers bash panes too" "absent" "$(test -e "$D/h/.bash_history.gone_p1" && echo present || echo absent)"
chk "fold keeps the shared file private (0600)" "-rw-------" "$(mode_of "$D/h/.zsh_history")"
chk "running fold twice folds nothing new" "1" "$(fold | grep -c '^folded 0 ')"

fresh; fold_setup; rm -f "$D/h/.zsh_history".* "$D/h/.bash_history".*
chk "nothing to fold is reported as such" "1" "$(fold | grep -c 'nothing to fold')"

fresh; fold_setup; fold --print >/dev/null 2>&1
chk "fold --print touches nothing" "3 2" \
  "$(find "$D/h" -maxdepth 1 -name '.zsh_history*' | wc -l | tr -d ' ') $(find "$D/h" -maxdepth 1 -name '.bash_history*' | wc -l | tr -d ' ')"
chk "fold --print lists what it would do" "2" "$(fold --print | grep -c 'would fold')"
chk "fold --print totals the bytes it would move" "1" "$(fold --print | grep -cE 'would-fold 2 pane history file.s., [1-9][0-9]* byte')"

fresh; fold_setup; fold --keep >/dev/null 2>&1
chk "fold --keep merges but leaves files alone" "2" \
  "$(test -f "$D/h/.zsh_history.w9_p9" && test -f "$D/h/.bash_history.gone_p1" && echo 2 || echo 0)"

fresh; fold_setup; fold --all >/dev/null 2>&1
chk "fold --all folds live panes too when told to" "1" "$(grep -c FROM-LIVE "$D/h/.zsh_history")"
chk "fold --all removes the live file as well" "absent" "$(test -e "$D/h/.zsh_history.w1_p3" && echo present || echo absent)"

fresh; fold_setup; FAKE=/nonexistent/herdr fold >"$D/f2" 2>&1
chk "no server: everything counts as a leftover" "2 1" \
  "$(grep -cE 'FROM-DEAD-ZSH|FROM-LIVE' "$D/h/.zsh_history") $(grep -c FROM-DEAD-BASH "$D/h/.bash_history")"
chk "no server: and it says so" "1" "$(grep -c 'no Herdr server' "$D/f2")"

# --- fold cannot collide with itself, and cannot be wedged ----------------
# Two triggers can fire at the same moment (a new pane's startup fold and the tab-bar
# timer). The stamp only throttles, so a real lock decides who folds; and a lock left
# by a killed process must not stop housekeeping forever.
fresh; fold_setup
mkdir -p "$(dirname "$HERDR_SYNC_STATE")/fold.lock"
chk "a second fold stands down while another holds the lock" "1" "$(fold | grep -c 'another fold is running')"
chk "the locked-out fold moved nothing" "present" "$(test -e "$D/h/.zsh_history.w9_p9" && echo present || echo absent)"
chk "--print reads without needing the lock" "2" "$(fold --print | grep -c 'would fold')"
touch -t 202001010000 "$(dirname "$HERDR_SYNC_STATE")/fold.lock"
chk "a lock older than 5 minutes is treated as abandoned" "1" "$(fold | grep -c '^folded 2 ')"
fresh; fold_setup; fold >/dev/null 2>&1
chk "fold releases its lock when it finishes" "absent" \
  "$(test -e "$(dirname "$HERDR_SYNC_STATE")/fold.lock" && echo present || echo absent)"

# --- the tab-bar timer is the periodic trigger, not a new shell -----------
# [[keys.command]] has no interval_seconds on 0.9.5, so herdr-status.sh — which Herdr
# re-runs every second — is what keeps a long session tidy without opening panes.
fresh; fold_setup; turn_on          # synced, so the pill has something to print
mkdir -p "$(dirname "$HERDR_SYNC_STATE")"; : >"$D/pill.log"
env HOME="$D/h" HERDR_SYNC_STATE="$HERDR_SYNC_STATE" HERDR_SYNC_BIN="$FAKEBIN" \
    HERDR_ACTIVE_TAB_ID=w1:t1 FAKE_SYNC_LOG="$D/pill.log" sh "$PILL" >/dev/null 2>&1
sleep 0.4
chk "the pill fires one throttled fold" "1" "$(grep -c 'fold --quiet' "$D/pill.log")"
chk "the pill records the attempt in the stamp" "1" "$(grep -c '[0-9]' "$(dirname "$HERDR_SYNC_STATE")/fold.stamp" 2>/dev/null)"
chk "the pill still prints its line" "Sync panes: ON" \
  "$(env HOME="$D/h" HERDR_SYNC_STATE="$HERDR_SYNC_STATE" HERDR_SYNC_BIN="$FAKEBIN" HERDR_ACTIVE_TAB_ID=w1:t1 sh "$PILL" | tail -1)"
: >"$D/pill.log"
touch "$(dirname "$HERDR_SYNC_STATE")/no-autofold"
env HOME="$D/h" HERDR_SYNC_STATE="$HERDR_SYNC_STATE" HERDR_SYNC_BIN="$FAKEBIN" HERDR_HIST_AUTOFOLD=1 \
    HERDR_ACTIVE_TAB_ID=w1:t1 FAKE_SYNC_LOG="$D/pill.log" sh "$PILL" >/dev/null 2>&1
sleep 0.3
chk "no-autofold file stops the periodic fold" "0" "$(grep -c 'fold' "$D/pill.log")"



# Autofold: fire-and-forget at most once a minute, so shell startup never waits on
# the Herdr socket. The fake sync binary records whether it was asked to fold.
autofold_once() { # $1 = stamp contents ("none" to start without one), rest = env
  # Own home and own pane id: these shells are backgrounded, and zsh rewrites
  # $HISTFILE when it exits, which would clobber another case's fixture.
  rm -f "$D/state/fold.stamp"
  mkdir -p "$D/state" "$D/h-af"; : >"$D/h-af/.zsh_history"; : >"$D/log"
  [ "$1" != none ] && printf '%s' "$1" >"$D/state/fold.stamp"
  env -u HISTFILE HOME="$D/h-af" HERDR_ENV=1 FAKE_SYNC_LOG="$D/log" \
    HERDR_PANE_ID=af:p1 HERDR_SYNC_BIN="$FAKEBIN" HERDR_SYNC_STATE="$D/state/sync.state" ${2+"$2"} \
    "$PROBE_SHELL" $PROBE_ARGS -c 'source "$1"' _ "$HOOK" >/dev/null 2>&1
  sleep 0.4; wait 2>/dev/null || true
}
fresh
autofold_once none
chk "first shell start asks for a fold" "1" "$(grep -c 'fold --quiet' "$D/log")"
chk "and stamps when it did" "1" "$(grep -c '[0-9]\{9,\}' "$D/state/fold.stamp" 2>/dev/null)"
autofold_once "$(date +%s)"
chk "a second start within the minute does not fold again" "0" "$(grep -c 'fold --quiet' "$D/log")"
autofold_once "$(( $(date +%s) - 3600 ))"
chk "a stale stamp re-arms the fold" "1" "$(grep -c 'fold --quiet' "$D/log")"
autofold_once none HERDR_HIST_AUTOFOLD=0
chk "HERDR_HIST_AUTOFOLD=0 disables it entirely" "0" "$(grep -c 'fold' "$D/log")"

# --- one pane, one history ------------------------------------------------
# Herdr panes must not share ~/.zsh_history (SHARE_HISTORY) or ~/.bash_history
# (histappend + history -a): up arrow in one pane should not show another's work,
# and sync would otherwise push every broadcast into everyone's history too.
hist_env() { # $1=shell $2=pane_id ; sources the hook as a pane with seeded history
  local h="$D/hist-$2"; mkdir -p "$h"; : >"$h/.zsh_history"; : >"$h/.bash_history"
  for i in 1 2 3 4 5; do printf 'shared-%s\n' "$i" >>"$h/.zsh_history"; printf 'shared-%s\n' "$i" >>"$h/.bash_history"; done
  env -u HISTFILE -u HERDR_PANE_ID HOME="$h" HERDR_ENV=1 HERDR_PANE_ID="$2" HERDR_HIST_SEED=2 HERDR_HIST_AUTOFOLD=0 \
      HERDR_SYNC_BIN="$FAKEBIN" HERDR_SYNC_STATE="$D/state-$2/sync.state" "${@:3}" \
      "$1" -c 'source "$1"; printf "FILE=%s\n" "$HISTFILE"
                 printf "SEEDTMP=%s\n" "$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name "herdr-hist-seed.*" 2>/dev/null | wc -l | tr -d " ")"' _ "$HOOK"
}
for sh in zsh bash; do
  skip_if_missing "$sh" "$sh pane history isolation" && continue
  case $sh in zsh) base=.zsh_history ;; bash) base=.bash_history ;; esac
  pid="se-$sh:p1"; h="$D/hist-$pid"; enc=$(printf '%s' "$pid" | tr -c 'A-Za-z0-9._' '_')
  out="$(hist_env "$sh" "$pid")"; got="$(printf '%s\n' "$out" | sed -n 's/^FILE=//p')"
  chk "$sh pane gets its own HISTFILE" "$h/$base.$enc" "$got"
  chk "$sh pane history file is private (0600)" "-rw-------" "$(mode_of "$h/$base.$enc")"
  # "does up arrow remember" needs a real interactive shell: see pty-hook-test.sh
  chk "$sh leaves no seed temp file behind" "0" "$(printf '%s\n' "$out" | sed -n 's/^SEEDTMP=//p')"
  # and crucially the seed is NOT in the file, so folding cannot re-append it
  # shells read their history file after the rc, so the seed has to live in the file
  chk "$sh seeds its own file from the shared one" "2" "$(wc -l <"$h/$base.$enc" | tr -d ' ')"
  chk "$sh seed takes the newest lines" "shared-5" "$(tail -1 "$h/$base.$enc")"
done
# an existing pane history is never rewritten by re-sourcing the rc
if ! have zsh; then
  no "existing pane history is preserved" "zsh not installed"; no "HERDR_HIST_SEED=0 starts the pane empty" "zsh not installed"
  no "still isolates when HERDR_SYNC_BIN is missing" "zsh not installed"; no "outside Herdr: HISTFILE untouched" "zsh not installed"
else
fresh; mkdir -p "$D/h-pr"; : >"$D/h-pr/.zsh_history"; printf 'KEEP-ME\n' >"$D/h-pr/.zsh_history.pr_p1"
chk "existing pane history is preserved" "KEEP-ME" \
  "$(env -u HISTFILE HOME="$D/h-pr" HERDR_ENV=1 HERDR_PANE_ID=pr:p1 HERDR_HIST_AUTOFOLD=0 HERDR_SYNC_BIN="$FAKEBIN" zsh -c 'source "$1"' _ "$HOOK" >/dev/null 2>&1; tail -1 "$D/h-pr/.zsh_history.pr_p1")"
fresh; mkdir -p "$D/h-z0"; : >"$D/h-z0/.zsh_history"; printf 'shared\n' >>"$D/h-z0/.zsh_history"
env -u HISTFILE HOME="$D/h-z0" HERDR_ENV=1 HERDR_PANE_ID=z0:p1 HERDR_HIST_SEED=0 HERDR_HIST_AUTOFOLD=0 HERDR_SYNC_BIN="$FAKEBIN" zsh -c 'source "$1"' _ "$HOOK" >/dev/null 2>&1
chk "HERDR_HIST_SEED=0 starts the pane empty" "0" "$(wc -l <"$D/h-z0/.zsh_history.z0_p1" | tr -d ' ')"
# isolation is pane identity, not a side effect of the sync binary being present
fresh; mkdir -p "$D/h-mb"; : >"$D/h-mb/.zsh_history"
env -u HISTFILE HOME="$D/h-mb" HERDR_ENV=1 HERDR_PANE_ID=mb:p3 HERDR_HIST_AUTOFOLD=0 HERDR_SYNC_BIN="$D/nowhere" zsh -c 'source "$1"' _ "$HOOK" >/dev/null 2>&1
chk "still isolates when HERDR_SYNC_BIN is missing" "present" \
  "$(test -e "$D/h-mb/.zsh_history.mb_p3" && echo present || echo absent)"
# and nothing at all happens outside Herdr
fresh; mkdir -p "$D/h"; : >"$D/h/.zsh_history"
chk "outside Herdr: HISTFILE untouched" "SHARED" \
  "$(env -u HERDR_ENV -u HERDR_PANE_ID HOME="$D/h" zsh -f -c 'source "$1"; [ "${HISTFILE:-$HOME/.zsh_history}" = "$HOME/.zsh_history" ] && echo SHARED' _ "$HOOK")"
chk "outside Herdr: no per-pane files written" "0" "$(find "$D/h" -maxdepth 1 -name '.*history.*' | wc -l | tr -d ' ')"
fi

# --- shell hook: one file, two shells ----------------------------------
fresh
for sh in bash /bin/bash zsh; do
  command -v "$sh" >/dev/null 2>&1 || { no "hook parses in $sh" "not installed"; continue; }
  chk "hook parses in $sh" "0" "$("$sh" -n "$HOOK" 2>&1 | wc -l | tr -d ' ')"
done
# inert outside Herdr: the wrapper exists but refuses, and no hook is installed
if have zsh; then chk "inert outside Herdr (zsh)"  "1" "$(zsh  -f -c 'unset HERDR_ENV; source "$1"; herdr-sync status' _ "$HOOK" 2>&1 | grep -c 'not inside a Herdr pane')"
chk "inert outside Herdr (bash)" "1" "$(env -u HERDR_ENV bash -c 'source "$1"; herdr-sync status' _ "$HOOK" 2>&1 | grep -c 'not inside a Herdr pane')"
chk "no preexec installed outside Herdr" "0" "$(zsh -f -c 'unset HERDR_ENV; source "$1"; print -lr $preexec_functions' _ "$HOOK" 2>&1 | grep -c _herdr_sync_preexec)"
# re-source guard, else every command is broadcast once per source
  chk "zsh hook does not stack when re-sourced" "1" \
  "$(HERDR_ENV=1 HERDR_SYNC_BIN="$FAKEBIN" zsh -f -c 'source "$1"; source "$1"; print -lr $preexec_functions' _ "$HOOK" 2>/dev/null | grep -c '_herdr_sync_preexec')"
else no "zsh-only hook cases" "zsh not installed (bash-only host)"; fi
# Path passed as a positional ($1) rather than nested quotes: \" inside \$( ) ends
# up as literal quote characters inside the env assignment, which silently points
# the hook at a nonexistent binary.
chk "bash installs a DEBUG trap" "1" \
  "$(HERDR_ENV=1 HERDR_SYNC_BIN="$FAKEBIN" bash -c 'source "$1"; trap -p DEBUG' _ "$HOOK" 2>/dev/null | grep -c _herdr_sync_preexec)"
chk "refuses to be executed (bash)" "1" "$(bash "$HOOK" 2>&1 | grep -c 'source this file')"
# The payload both shells call, called directly.
# the real interactive wiring: preexec / DEBUG only fire on a terminal
if [ -x "$PTYT" ]; then
  for sh in zsh bash; do
    # args: shell hook fake-binary log-file registration-dir pane-id-to-claim
    have "$sh" || { no "interactive $sh test" "$sh not installed (bash-only host)"; continue; }
    : >"$D/log.$sh"
    sh "$PTYT" "$sh" "$HOOK" "$FAKEBIN" "$D/log.$sh" "$D/hooks.$sh" "$sh-paneprobe" >"$D/pty.$sh" 2>&1
    rc=$?
    if [ "$rc" = 0 ]; then
      ok "interactive $sh forwards + registers itself" "$(grep -o 'mirror -- echo unit-' "$D/log.$sh" | head -1)"
      # the harness asserts on files (log, registration, history probe) and prints one
      # "pty:" line per thing it proved; surface those rather than duplicating them
      grep '^pty:' "$D/pty.$sh" | sed 's/^/        /'
    elif [ "$rc" = 77 ]; then
      no "interactive $sh test" "no pty driver (install expect or util-linux script)"
    else
      bad "interactive $sh test" "rc=$rc: $(tr '\n' ';' <"$D/pty.$sh" | cut -c1-150)"
    fi
  done
else
  no "interactive preexec/DEBUG tests" "pty harness not found"
fi

printf '\n%d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
# Machine-readable tail, for CI: a job asserts "failed=0", and the bash-only job also
# requires skipped > 0. Coverage that quietly disappears is worse than a red build, so
# the skip count is part of the contract instead of something a human has to read.
printf 'summary passed=%d failed=%d skipped=%d\n' "$pass" "$fail" "$skip"
[ "$fail" = 0 ] || exit 1
