#!/usr/bin/env bash
#!/usr/bin/env bash
# fake-herdr.sh — deterministic stand-in for the herdr CLI, used by tests/run-tests.sh.
#
# Serves a fixed pane topology and records every injection into $FAKE_LOG so the
# tests can assert exactly which panes were typed into, with what text.
#
# Knobs (all env):
#   FAKE_LOG        file to record calls into        (required)
#   FAKE_CUR_PANE   pane id returned by `pane current` (a DECOY: on a real server
#   FAKE_CUR_TAB    `pane current` does not follow tab focus, so the defaults sit
#                   in a tab that is not in the fixture at all — anything that
#                   trusts it for scoping fails loudly instead of passing by luck)
#   FAKE_FAIL       "1" makes every call fail (no-server simulation)
#   FAKE_NEW_PANE   pane id handed back by `pane split` (default w1:p9)
set -u

LOG="${FAKE_LOG:?fake-herdr: FAKE_LOG must be set}"
[ "${FAKE_FAIL:-0}" = 1 ] && { echo "no server running" >&2; exit 1; }

pane="${FAKE_CUR_PANE:-w0:p0}"
tab="${FAKE_CUR_TAB:-w0:t0}"

case "$1 ${2:-}" in
  "pane current")
    printf '{"result":{"pane":{"pane_id":"%s","tab_id":"%s","workspace_id":"w1","agent_status":"unknown"}}}\n' "$pane" "$tab"
    ;;
  "pane list")
    # One synced tab (p1 hosts an agent, p2/p3 are shells), a second tab (p4),
    # and a second workspace (w2:p5) that must never be touched by tab scope.
    cat <<'JSON'
{"result":{"panes":[
 {"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1","agent":"pi","agent_status":"working","cwd":"/p1"},
 {"pane_id":"w1:p2","tab_id":"w1:t1","workspace_id":"w1","agent_status":"unknown","cwd":"/p2"},
 {"pane_id":"w1:p3","tab_id":"w1:t1","workspace_id":"w1","agent_status":"idle","cwd":"/p3"},
 {"pane_id":"w1:p4","tab_id":"w1:t2","workspace_id":"w1","agent_status":"unknown","cwd":"/p4"},
 {"pane_id":"w2:p5","tab_id":"w2:t1","workspace_id":"w2","agent_status":"unknown","cwd":"/p5"}
]}}
JSON
    ;;
  "pane process-info")
    # shell_pid is fake-able so tests can model a stale registration marker:
    # FAKE_SHELL_PID_<pane with : and - turned into _> = pid (default 4242).
    pid=""; prev=""
    for a in "$@"; do case "$prev" in --pane) pid="$a" ;; esac; prev="$a"; done
    # name of the env var holding this pane's fake shell pid
    vname="FAKE_SHELL_PID_$(printf '%s' "${pid:-none}" | tr -c 'A-Za-z0-9._' '_')"
    sp="${!vname:-4242}"   # bash indirect expansion: the fake is bash, not sh
    printf '{"result":{"process_info":{"pane_id":"%s","shell_pid":%s}}}\n' "$pid" "$sp"
    ;;
  "pane split")
    # Shaped like production, which answers {"result":{"pane":{"pane_id":...}}} — a
    # fake that invents its own shape lets a test pass against a payload that does
    # not exist (this is exactly how a .result.pane_id bug survived once).
    printf 'SPLIT\t%s\n' "${3:-}" >>"$LOG"
    printf '{"result":{"pane":{"pane_id":"%s","tab_id":"%s","focused":false}}}\n' \
      "${FAKE_NEW_PANE:-w1:p9}" "${FAKE_NEW_TAB:-w1:t1}"
    ;;
  "pane close")  printf 'CLOSE\t%s\n' "${3:-}" >>"$LOG" ;;
  "pane run")      printf 'RUN\t%s\t%s\n' "$3" "$4" >>"$LOG" ;;
  "pane send-text") printf 'TEXT\t%s\t%s\n' "$3" "$4" >>"$LOG" ;;
  "notification show") printf 'NOTIFY\t%s\n' "$3" >>"$LOG" ;;
  *) printf '{}\n' ;;
esac
