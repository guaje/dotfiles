#!/bin/sh
# pty-hook-test.sh — prove a *real interactive shell* wires the hook up correctly.
#
#   pty-hook-test.sh <shell> <hook-file> <fake-sync-bin> <log> <marker-dir> [pane_id]
#
# zsh's preexec and bash's DEBUG trap only run when the shell is genuinely attached
# to a terminal, so this puts the shell on a pty, sources the hook through a
# throwaway rc, types a command, and exits.
#
# Assertions are on FILES, never on screen output (the pty's output is thrown away on
# purpose — matching prompt themes, p10k instant prompt, or a locale change must not
# be able to turn this test red):
#   <log>         what the fake herdr-sync binary was handed   -> mirroring is wired
#   <marker-dir>  the pane registration the hook should write   -> doctor can see it
#   <work>/seed-probe.txt  what the live shell saw about history -> isolation + seeding
#
# HOME is a temp dir: without that the hook would create real per-pane history files
# in the developer's home on every run.
#
# Exit codes: 0 passed, 1 failed, 2 usage, 77 no pty driver here (the runner treats
# 77 as a skip, so this never fakes a pass on a machine that cannot run it).
#
# Drivers, in order of preference:
#   expect            macOS ships /usr/bin/expect; Termux: pkg install expect
#   script -e         util-linux only (BSD/macOS script has no -c/-e)
set -u

[ $# -ge 5 ] || { echo "usage: $0 <shell> <hook> <fake-bin> <log> <marker-dir> [pane_id]" >&2; exit 2; }
shell=$1 hook=$2 fakebin=$3 log=$4 markerdir=$5 pane=${6:-}
for f in "$hook" "$fakebin"; do
  [ -r "$f" ] || { echo "missing $f" >&2; exit 2; }
done
case $shell in zsh | bash) ;; *) echo "unsupported shell: $shell" >&2; exit 2 ;; esac

work=$(mktemp -d "${TMPDIR:-/tmp}/herdrpty.XXXXXX") || exit 2
# shellcheck disable=SC2064
trap "rm -rf '$work'" EXIT INT TERM
mkdir -p "$work/home" "$work/zdotdir" "$markerdir"
# zsh reads $ZDOTDIR/.zshrc; macOS' /etc/zshrc hard-sets HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history
# *before* that, so the rc file has to set HISTFILE itself (as a real ~/.zshrc does) or the
# history base silently becomes the throwaway ZDOTDIR.
printf 'export HISTFILE=%s/.zsh_history\nsource "%s"\n' "$work/home" "$hook" >"$work/zdotdir/.zshrc"
printf 'export HISTFILE=%s/.bash_history\nsource "%s"\n' "$work/home" "$hook" >"$work/rc-bash"  # bash: --rcfile

# A shared history with a marker in it, which a new pane is expected to inherit.
printf ': 111:0;SEEDED-FROM-SHARED\n' >"$work/home/.zsh_history"
printf ': 111:0;SEEDED-FROM-SHARED\n' >"$work/home/.bash_history"

marker="unit-$shell"
probe="$work/seed-probe.txt"
# The probe runs *inside* the live shell. It has to be a file: the expect side must
# never quote shell syntax (Tcl chokes on the quotes), and the prompt cannot be used
# as a sync point because /etc/zshrc rewrites PS1 after any inherited one.
cat >"$work/probe.sh" <<PROBE
if [ -n "\${ZSH_VERSION:-}" ]; then
  m=\$(fc -l 1 2>/dev/null | grep -c SEEDED-FROM-SHARED)
else
  m=\$(history 2>/dev/null | grep -c SEEDED-FROM-SHARED)
fi
f=\$(grep -c SEEDED-FROM-SHARED "\$HISTFILE" 2>/dev/null)
printf 'MEM=%s FILE=%s PANEFILE=%s\n' "\$m" "\$f" "\$HISTFILE" >"\${HERDR_SEED_PROBE:-/dev/null}"
PROBE

# The shell is started through this so the expect/tcl side never has to quote anything.
{
  printf '#!/bin/sh\n'
  printf 'export HOME=%s\n' "$work/home"
  printf 'export HERDR_ENV=1 HERDR_SYNC_BIN=%s FAKE_SYNC_LOG=%s\n' "$fakebin" "$log"
  # the hook derives its registration dir from the state file's parent, so pointing
  # the state file at <markerdir>/sync.state puts markers in <markerdir>/hooks
  printf 'export HERDR_SYNC_STATE=%s/sync.state HERDR_HIST_SEED=5000 HERDR_SEED_PROBE=%s\n' "$markerdir" "$probe"
  printf 'export PS1="HERDRTEST> "\n'
  printf 'unset HERDR_PANE_ID HERDR_TAB_ID\n'
  [ -n "$pane" ] && printf 'export HERDR_PANE_ID=%s HERDR_TAB_ID=%s HERDR_WORKSPACE_ID=%s\n' "$pane" "${pane%:*}:t1" "${pane%%:*}"
  case $shell in
    zsh)  printf 'ZDOTDIR=%s exec zsh\n' "$work/zdotdir" ;;
    bash) printf 'exec bash --rcfile %s -i\n' "$work/rc-bash" ;;
  esac
} >"$work/launch.sh"
chmod +x "$work/launch.sh"

# Two typed lines: the marker (proves the hook forwards) and the probe (proves what
# the live shell knows about history). Both go in, then the shell is exited.
if command -v expect >/dev/null 2>&1; then
  cat >"$work/drive.exp" <<EOF
set timeout 25
log_user 0
spawn -noecho sh $work/launch.sh
# Wait for the shell's own prompt instead of guessing how long startup takes. On a
# loaded Linux runner a blind sleep types the first command before zle has taken the
# tty over, and its leading bytes are dropped: echo arrived as "cho".
expect { -re "HERDRTEST> " {} timeout { exit 6 } }
# A bare newline absorbs whatever the editor swallowed while it was starting up, and
# the reprinted prompt proves it reads and echoes before anything is asserted on.
send -- "\r"
expect { -re "HERDRTEST> " {} timeout { exit 6 } }
send -- "echo $marker\r"
expect { -re "echo $marker" {} timeout { exit 3 } }
sleep 1
send -- ". $work/probe.sh\r"
send -- "echo PROBE-DONE-$marker\r"
expect { -re "PROBE-DONE-$marker" {} timeout { exit 5 } }
sleep 1
send -- "exit\r"
expect { eof {} timeout { exit 4 } }
exit 0
EOF
  expect -f "$work/drive.exp" >/dev/null 2>&1
  rc=$?
elif script --version 2>&1 | grep -qi 'util-linux'; then
  # Same flush the expect driver sends, plus a longer first wait: this branch has no
  # prompt to wait on, so it can only guess, and a cold container needs the room.
  { sleep 3; printf '\n'; sleep 1; printf 'echo %s\n' "$marker"; sleep 1
    printf '. %s/probe.sh\n' "$work"; printf 'echo PROBE-DONE-%s\n' "$marker"; sleep 1; printf 'exit\n'
  } | script -q -e -c "sh $work/launch.sh" /dev/null >/dev/null 2>&1
  rc=$?
else
  echo "no pty driver available (need expect, or util-linux script)" >&2
  exit 77
fi

fail() { printf '%s\n' "$1" >&2; exit 1; }
# rc 3/4/5 mean the shell never echoed our line back: a failure, not a skip.
[ "$rc" -ge 3 ] && fail "pty interaction failed (rc=$rc)"
[ -s "$log" ] || fail "hook never called the sync binary"

# 1. mirroring: preexec (zsh) / DEBUG trap (bash) must have reached the binary
grep -q "mirror -- echo $marker" "$log" 2>/dev/null ||
  fail "no 'mirror -- echo $marker' in the log; got: $(tr '\n' ';' <"$log")"
printf 'pty: %s forwards commands through the hook\n' "$shell"

# 2. registration: only checked when a pane id was supplied (see run-tests.sh)
if [ -n "$pane" ]; then
  enc=$(printf '%s' "$pane" | tr -c 'A-Za-z0-9._' '_')
  reg="$markerdir/hooks/$enc"
  [ -s "$reg" ] || fail "hook did not register pane $pane (looked in $reg)"
  grep -q "^$pane\$" "$reg" || grep -q " $pane\$" "$reg" ||
    fail "registration does not name pane $pane: $(cat "$reg")"
  printf 'pty: %s registers pane %s as mirror-capable\n' "$shell" "$pane"
  # a stale marker (dead pid) must be distinguishable: pid 1 can never be a shell
  grep -qv '^1 ' "$reg" || fail "registration recorded an impossible pid: $(cat "$reg")"
fi

# 3. history isolation + seeding, as seen by a shell that actually read its file.
#    The shared marker must be reachable via "up arrow" (it was seeded into the
#    pane's own file) while commands typed elsewhere stay out of it.
[ -s "$probe" ] || fail "the interactive shell never wrote the history probe ($probe)"
# at least one copy in memory; exact-once is asserted on the file, where it matters
sed -n 's/^MEM=\([0-9]*\).*/\1/p' "$probe" | grep -qE '^[1-9]$' ||
  fail "shell cannot remember the seeded history: $(tr '\n' ' ' <"$probe")"
sed -n 's/^MEM=[0-9]* FILE=\([0-9]*\).*/\1/p' "$probe" | grep -q '^1$' ||
  fail "the seed should sit exactly once in a new pane's file: $(tr '\n' ' ' <"$probe")"
# The pane file must sit next to the shared file, not wherever the shell happens to
# have landed (ZDOTDIR, cwd, a relative HISTFILE).
case $(sed -n 's/.*PANEFILE=//p' "$probe") in
  "$work/home/"*) printf 'pty: %s keeps its pane history beside the shared file\n' "$shell" ;;
  *) fail "pane history file landed in the wrong place: $(sed -n 's/.*PANEFILE=//p' "$probe")" ;;
esac
printf 'pty: %s starts a new pane with seeded history\n' "$shell"

exit 0
