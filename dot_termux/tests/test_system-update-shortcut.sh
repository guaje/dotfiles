#!/usr/bin/env bash
# Integration tests for the ~/.shortcuts/system-update shortcut. pkg, npm, pi,
# chezmoi, and timeout are PATH mocks and PREFIX and HOME are fixtures, so the
# report is checked against a recorded apt history and npm, pi, and chezmoi state
# without touching a package manager, a mirror, or the notification apps.

set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
SUBJECT="$SCRIPT_DIR/../../private_dot_shortcuts/private_executable_system-update.shortcut"
[[ -f $SUBJECT ]] || { printf 'missing shortcut source\n' >&2; exit 1; }
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/system-update-shortcut-test.XXXXXX")
# macOS reports /tmp as /private/tmp, so compare against the physical path.
ROOT=$(CDPATH='' cd -- "$ROOT" && pwd -P)

# The shortcut parses npm's JSON output with node and reads chezmoi's git history,
# so both are required rather than mocked; say so instead of failing later.
for tool in node git; do
    command -v "$tool" >/dev/null 2>&1 \
        || { printf 'missing %s: the shortcut depends on it directly\n' "$tool" >&2; exit 1; }
done

fail() {
    printf '❌ %s\n' "$*" >&2
    local part
    for part in out err; do
        if [[ -s $CASE/$part ]]; then
            printf -- '--- %s ---\n' "$part" >&2
            cat "$CASE/$part" >&2
        fi
    done
    if [[ -s $CASE/calls ]]; then
        printf -- '--- mock calls ---\n' >&2
        cat "$CASE/calls" >&2
    fi
    exit 1
}
pass() { printf '✅ %s\n' "$*"; }

cleanup() { rm -rf "$ROOT"; }
# shellcheck disable=SC2329 # Invoked through the EXIT trap.
trap cleanup EXIT HUP INT TERM

BA=$(command -v bash)

# Every case owns a fake prefix (bin, var/log/apt), a fake home, a committed git
# repository standing in for the chezmoi source, and a mock bin searched first.
# Mock inputs are reset here so no case can inherit another's fixtures.
new_case() {
    CASE=$(mktemp -d "$ROOT/case.XXXXXX")
    PREFIX="$CASE/prefix"
    REPO="$CASE/repo"
    STATE="$CASE/home/.cache/termux-update"
    mkdir -p "$CASE/bin" "$PREFIX/bin" "$PREFIX/var/log/apt" "$CASE/home" \
        "$CASE/tmp" "$REPO"
    : >"$CASE/calls"
    MOCK_APT_ENTRY=''
    MOCK_NPM_OLD='{}'
    MOCK_NPM_NEW='{}'
    MOCK_PI_NEW='1.0.0'
    MOCK_CHEZMOI_OUT=''
    MOCK_CHEZMOI_COMMIT=0
    MOCK_PKG_RC=0
    MOCK_PKG_FAIL_ARG=''
    MOCK_NPM_RC=0
    MOCK_PI_RC=0
    MOCK_CHEZMOI_RC=0
    MOCK_TIMEOUT_RC=0
    MOCK_TIMEOUT_CMD=''
    MOCK_NOTIFY_OUT=''
    MOCK_TOAST_OUT=''
    MOCK_HAVE_NOTIFY=1
    MOCK_HAVE_TOAST=1
    MOCK_REWRITE=0
    printf '1.0.0\n' >"$CASE/pi-version"
    git -C "$REPO" init -q .
    git -C "$REPO" config user.email t@example.invalid
    git -C "$REPO" config user.name t
    : >"$REPO/managed"
    git -C "$REPO" add managed
    git -C "$REPO" commit -qm base
    mocks
    history_seed
}

# Seed an entry a previous run already reported; it must never be counted again,
# which is what makes the history offset observable from the outside.
history_seed() {
    cat >"$PREFIX/var/log/apt/history.log" <<'EOF'

Start-Date: 2020-01-01  00:00:00
Commandline: apt full-upgrade
Upgrade: stale:aarch64 (1.0, 1.1)
End-Date: 2020-01-01  00:00:02
EOF
}

# A stub script written with the interpreter running this suite: Termux has no
# /usr/bin/env. The heredocs are quoted so nothing expands at write time and case
# data arrives through the MOCK_* environment instead.
mock() { # mock <path>
    {
        printf '#!%s\n' "$BA"
        cat
    } >"$1"
    chmod +x "$1"
}

mocks() {
    mock "$CASE/bin/pkg" <<'EOF'
set -eu
printf '%s\n' "pkg $*" >> "$MOCK_CALLS"
if [[ -n ${MOCK_PKG_FAIL_ARG:-} && ${1:-} == "$MOCK_PKG_FAIL_ARG" ]]; then
    exit "${MOCK_PKG_RC}"
fi
if [[ ${1:-} == upgrade && -n ${MOCK_APT_ENTRY:-} ]]; then
    printf '%s\n' "$MOCK_APT_ENTRY" >> "$PREFIX/var/log/apt/history.log"
fi
exit 0
EOF

    # npm ls reports the recorded old state until the update call swaps in the
    # new state, so the two snapshots the shortcut takes really differ.
    mock "$CASE/bin/npm" <<'EOF'
set -eu
printf '%s\n' "npm $*" >> "$MOCK_CALLS"
[[ -f $MOCK_NPM_STATE ]] || printf '%s\n' "$MOCK_NPM_OLD" > "$MOCK_NPM_STATE"
case ${1:-} in
    update) printf '%s\n' "$MOCK_NPM_NEW" > "$MOCK_NPM_STATE" ;;
    ls) [[ ${MOCK_NPM_RC:-0} -eq 0 ]] || exit "${MOCK_NPM_RC}" ;;
esac
cat "$MOCK_NPM_STATE"
exit 0
EOF

    mock "$CASE/bin/pi" <<'EOF'
set -eu
printf '%s\n' "pi $*" >> "$MOCK_CALLS"
case ${1:-} in
    --version) cat "$MOCK_PI_VERSION" ;;
    update) printf '%s\n' "$MOCK_PI_NEW" > "$MOCK_PI_VERSION" ;;
esac
exit "${MOCK_PI_RC:-0}"
EOF

    mock "$CASE/bin/chezmoi" <<'EOF'
set -eu
printf '%s\n' "chezmoi $*" >> "$MOCK_CALLS"
case ${1:-} in
    source-path) printf '%s\n' "$MOCK_REPO" ;;
    update)
        if [[ ${MOCK_CHEZMOI_COMMIT:-0} -eq 1 ]]; then
            printf '%s\n' "$RANDOM" >> "$MOCK_REPO/managed"
            git -C "$MOCK_REPO" commit -qam advance
        fi
        # A run may pull a newer version of the shortcut itself. Record where the
        # still-running script lives before overwriting the managed path.
        if [[ ${MOCK_REWRITE:-0} -eq 1 ]]; then
            (shopt -s nullglob; printf '%s\n' "$TMPDIR"/system-update.run.*) > "$MOCK_SNAPSHOT"
            printf '#!/usr/bin/env bash\nprintf self-rewritten\nexit 3\n' > "$MOCK_SHORTCUT"
        fi
        printf '%s\n' "${MOCK_CHEZMOI_OUT:-}"
        ;;
esac
exit "${MOCK_CHEZMOI_RC:-0}"
EOF

    # timeout is stubbed as a pass-through so the suite needs no coreutils and can
    # reproduce the timeout status of the production command verbatim.
    mock "$CASE/bin/timeout" <<'EOF'
printf '%s\n' "timeout $1 $2" >> "$MOCK_CALLS"
if [[ -n ${MOCK_TIMEOUT_RC:-} && ${2:-} == "${MOCK_TIMEOUT_CMD:-}" ]]; then
    exit "${MOCK_TIMEOUT_RC}"
fi
shift
exec "$@"
EOF
}

# Whether the Android delivery tools exist at all is a case setting, so their
# stubs are installed at run time: the shortcut calls them by absolute path under
# PREFIX/bin and must treat {"error":...} output as a failed delivery.
delivery_stubs() {
    if [[ $MOCK_HAVE_NOTIFY -eq 1 ]]; then
        mock "$PREFIX/bin/termux-notification" <<'EOF'
printf '%s\n' "termux-notification $*" >> "$MOCK_CALLS"
printf '%s\n' "${MOCK_NOTIFY_OUT:-}"
exit 0
EOF
    fi
    if [[ $MOCK_HAVE_TOAST -eq 1 ]]; then
        mock "$PREFIX/bin/termux-toast" <<'EOF'
printf '%s\n' "termux-toast $*" >> "$MOCK_CALLS"
printf '%s\n' "${MOCK_TOAST_OUT:-}"
exit 0
EOF
    fi
}

# The shortcut re-executes a private copy of itself, so it is always run from a
# file at the path under test.
start_run() { # start_run [args...]
    cp "$SUBJECT" "$CASE/shortcut"
    chmod 700 "$CASE/shortcut"
    delivery_stubs
    env -i PATH="$CASE/bin:$PATH" HOME="$CASE/home" PREFIX="$PREFIX" \
        TMPDIR="$CASE/tmp" MOCK_CALLS="$CASE/calls" MOCK_REPO="$REPO" \
        MOCK_SHORTCUT="$CASE/shortcut" MOCK_SNAPSHOT="$CASE/snapshot" \
        MOCK_APT_ENTRY="$MOCK_APT_ENTRY" \
        MOCK_NPM_STATE="$CASE/npm.json" MOCK_NPM_OLD="$MOCK_NPM_OLD" \
        MOCK_NPM_NEW="$MOCK_NPM_NEW" MOCK_PI_VERSION="$CASE/pi-version" \
        MOCK_PI_NEW="$MOCK_PI_NEW" MOCK_CHEZMOI_OUT="$MOCK_CHEZMOI_OUT" \
        MOCK_CHEZMOI_COMMIT="$MOCK_CHEZMOI_COMMIT" MOCK_REWRITE="$MOCK_REWRITE" \
        MOCK_PKG_RC="$MOCK_PKG_RC" MOCK_PKG_FAIL_ARG="$MOCK_PKG_FAIL_ARG" \
        MOCK_NPM_RC="$MOCK_NPM_RC" \
        MOCK_PI_RC="$MOCK_PI_RC" MOCK_CHEZMOI_RC="$MOCK_CHEZMOI_RC" \
        MOCK_TIMEOUT_RC="$MOCK_TIMEOUT_RC" MOCK_TIMEOUT_CMD="$MOCK_TIMEOUT_CMD" \
        MOCK_NOTIFY_OUT="$MOCK_NOTIFY_OUT" \
        MOCK_TOAST_OUT="$MOCK_TOAST_OUT" \
        bash "$CASE/shortcut" "$@" >"$CASE/out" 2>"$CASE/err"
    RUN_RC=$?
}

# One apt run that upgrades several packages on one history line, as apt writes
# them, and installs a new dependency.
apt_changes() {
    MOCK_APT_ENTRY='Upgrade: tmux:aarch64 (3.7c-1, 3.8), neovim:aarch64 (0.12.5-1, 0.12.6)
Install: libevent:aarch64 (2.1.13, automatic)'
}

# ------------------------------------------------------------------------ cases

# A tap that changes things must name every upgraded artifact per source.
new_case
apt_changes
MOCK_NPM_OLD='{"dependencies":{"left-pad":{"version":"1.0.0"}}}'
MOCK_NPM_NEW='{"dependencies":{"left-pad":{"version":"1.3.0"}}}'
MOCK_PI_NEW=2.0.0
MOCK_CHEZMOI_COMMIT=1
MOCK_CHEZMOI_OUT="modifying $CASE/home/.bashrc"
start_run || true
[[ $RUN_RC -eq 0 ]] || fail "a successful run exited $RUN_RC"
grep -Fq 'tmux: 3.7c-1 -> 3.8' "$CASE/out" || fail 'the apt upgrade is not reported'
grep -Fq 'neovim: 0.12.5-1 -> 0.12.6' "$CASE/out" \
    || fail 'a second package on the same apt history line is not reported'
grep -Fq 'apt: 3 upgraded' "$CASE/out" || fail 'apt items are not counted per package'
grep -Fq 'libevent: 2.1.13 (new)' "$CASE/out" || fail 'a newly installed package is not reported'
grep -Fq 'left-pad: 1.0.0 -> 1.3.0' "$CASE/out" || fail 'the npm global upgrade is not reported'
grep -Fq 'pi: 1.0.0 -> 2.0.0' "$CASE/out" || fail 'the pi version change is not reported'
grep -Eq 'chezmoi: repo [0-9a-f]+ -> [0-9a-f]+ \(1 commits\), 1 file\(s\) applied' "$CASE/out" \
    || fail 'the chezmoi commit range and applied target count are not reported'
grep -Fq 'chezmoi modifying ~/.bashrc' "$STATE/latest.log" \
    || fail 'the applied chezmoi target is not reported with home shortened'
# Two apt changes on one line plus the new install, one npm change, one pi change,
# and chezmoi contributes the pulled repo plus the one applied target.
grep -Fq 'Update: 7 upgraded' "$CASE/out" || fail 'the report does not total every change'
if grep -q stale "$CASE/out"; then fail 'history entries from an older run were reported again'; fi
pass 'the report names every upgraded artifact and totals them'

# Nothing changed anywhere: say so instead of inventing work. Global packages are
# present but identical, because reporting every installed package as an upgrade is
# the easy way to look busy.
new_case
MOCK_NPM_OLD='{"dependencies":{"left-pad":{"version":"1.3.0"},"npm":{"version":"12.0.0"}}}'
MOCK_NPM_NEW='{"dependencies":{"left-pad":{"version":"1.3.0"},"npm":{"version":"12.0.0"}}}'
start_run || true
[[ $RUN_RC -eq 0 ]] || fail "an idle run exited $RUN_RC"
grep -q 'nothing to do' "$CASE/out" || fail 'an idle run does not report nothing to do'
grep -Fq 'apt: 0 upgraded' "$CASE/out" || fail 'apt counts an upgrade with no upgrade'
grep -Fq 'npm: 0 upgraded' "$CASE/out" || fail 'npm counts an upgrade with no upgrade'
if grep -q '^  - ' "$CASE/out"; then fail 'an idle run listed changes it did not make'; fi
grep -q 'already latest' "$CASE/out" || fail 'an unchanged pi is not reported as latest'
grep -q 'repo unchanged' "$CASE/out" || fail 'an unchanged chezmoi repo is not reported'
[[ -s $STATE/latest.log ]] || fail 'the idle run left no log behind'
pass 'an idle run reports nothing to do and still leaves a log'

# One failing source must not stop the remaining sources or hide the report.
new_case
MOCK_PKG_FAIL_ARG=update
MOCK_PKG_RC=100
MOCK_NPM_OLD='{"dependencies":{"left-pad":{"version":"1.0.0"}}}'
MOCK_NPM_NEW='{"dependencies":{"left-pad":{"version":"1.3.0"}}}'
start_run || true
[[ $RUN_RC -eq 0 ]] || fail "a run with a failed step exited $RUN_RC"
grep -q 'pkg-update (exit 100)' "$CASE/out" || fail 'the failed step is not reported with its status'
grep -q '1 step(s) failed' "$CASE/out" || fail 'the summary omits the failure count'
grep -Fq 'pkg-update' "$STATE/latest.log" || fail 'the log omits the failed step'
grep -Fq 'left-pad: 1.0.0 -> 1.3.0' "$CASE/out" || fail 'the failure suppressed the other sources'
grep -Fq 'apt: 0 upgraded' "$CASE/out" || fail 'apt counted packages its failed run never touched'
for call in 'npm update' 'pi update' 'chezmoi update'; do
    grep -Fq "$call" "$CASE/calls" || fail "the failure stopped the run before $call"
done
pass 'a failing step is reported and the remaining steps still run'

# A timeout is the one status that must be translated for the reader, and the
# upgrade steps get a larger budget than the metadata steps.
new_case
MOCK_TIMEOUT_RC=124
MOCK_TIMEOUT_CMD=pkg
MOCK_NPM_OLD='{"dependencies":{"left-pad":{"version":"1.0.0"}}}'
MOCK_NPM_NEW='{"dependencies":{"left-pad":{"version":"1.3.0"}}}'
start_run || true
grep -q 'pkg-update (timed out after 900s)' "$CASE/out" \
    || fail 'a timed out step is not reported as a timeout'
grep -q 'pkg-upgrade (timed out after 3600s)' "$CASE/out" \
    || fail 'the upgrade timeout budget is not reported per step'
grep -q '3 step(s) failed' "$CASE/out" || fail 'the three apt steps are not all reported as failures'
grep -Fq 'apt: 0 upgraded' "$CASE/out" || fail 'a timed out apt run still reported packages'
grep -Fq 'left-pad: 1.0.0 -> 1.3.0' "$CASE/out" || fail 'a timeout stopped the later sources'
if grep -Fq 'pkg upgrade -y' "$CASE/calls"; then fail 'a timed out step still ran the real command'; fi
pass 'a timed out step is reported as a timeout'

# Termux:API exits successfully while printing {"error":...} when its app is
# missing, so the fallback to toast is the only perceivable delivery.
new_case
apt_changes
MOCK_NOTIFY_OUT='{"error": "API method is not implemented: Notification"}'
start_run || true
grep -Fq 'termux-notification' "$CASE/calls" || fail 'the notification was never attempted'
grep -Fq 'termux-toast' "$CASE/calls" || fail 'a failed notification did not fall back to toast'
pass 'an unavailable notification app falls back to a toast'

# With neither delivery available the run is still reported and logged.
new_case
apt_changes
MOCK_HAVE_NOTIFY=0
MOCK_HAVE_TOAST=0
start_run || true
grep -Fq 'tmux: 3.7c-1 -> 3.8' "$CASE/out" || fail 'an undeliverable run lost its report'
[[ -s $STATE/latest.log ]] || fail 'an undeliverable run left no log behind'
if grep -Fq 'termux-' "$CASE/calls"; then fail 'a removed notification tool was still called'; fi
pass 'an undeliverable run is still reported on stdout and in the log'

# A second tap while a run is live must not start a parallel upgrade.
new_case
mkdir -p "$STATE/running"
printf '%s\n' "$$" > "$STATE/running/pid"
start_run || true
[[ $RUN_RC -eq 0 ]] || fail "a refused concurrent run exited $RUN_RC"
grep -q 'already running' "$CASE/err" || fail 'a concurrent run is not refused'
[[ ! -s $CASE/calls ]] || fail 'a concurrent run executed steps anyway'
pass 'a concurrent tap is refused without running anything'

# A lock left behind by a killed run must not wedge the shortcut forever.
new_case
mkdir -p "$STATE/running"
DEAD=$(bash -c 'sleep .2 & pid=$!; wait "$pid"; printf %s "$pid"')
printf '%s\n' "$DEAD" > "$STATE/running/pid"
apt_changes
start_run || true
[[ $RUN_RC -eq 0 ]] || fail 'a stale lock was not reclaimed'
grep -Fq 'pkg update' "$CASE/calls" || fail 'a stale lock stopped the run'
grep -Fq 'tmux: 3.7c-1 -> 3.8' "$CASE/out" || fail 'the reclaimed run lost its report'
pass 'a stale lock from a dead run is reclaimed'

# The chezmoi step can pull a newer version of this shortcut, and the run already
# in progress must keep going from its own copy.
new_case
apt_changes
MOCK_REWRITE=1
start_run || true
[[ $RUN_RC -eq 0 ]] || fail "a run whose file was rewritten exited $RUN_RC"
[[ -s $CASE/snapshot ]] || fail 'the run did not hold its own copy of the shortcut'
grep -Fq 'system-update.run.' "$CASE/snapshot" \
    || fail 'the run executed from the managed path instead of a private copy'
grep -Fq 'tmux: 3.7c-1 -> 3.8' "$CASE/out" || fail 'the rewritten file corrupted the report'
if grep -Fq self-rewritten "$CASE/out"; then fail 'the rewritten shortcut content took effect mid-run'; fi
pass 'a mid-run rewrite of the shortcut cannot corrupt the running report'

# Locks, step directories, and the private copy are all internal state.
new_case
apt_changes
start_run || true
[[ ! -e $STATE/running ]] || fail 'the run left its lock behind'
if compgen -G "$STATE/steps.*" >/dev/null; then fail 'the run left step directories behind'; fi
if compgen -G "$CASE/tmp/system-update.run.*" >/dev/null; then fail 'the run left its private copy behind'; fi
grep -Fq 'full log:' "$STATE/latest.log" || fail 'the log does not name itself'
pass 'the run cleans up its lock, step directories, and private copy'

# A dry run must not change anything: read-only snapshots are fine, but no
# mutating command may be invoked, and the report still has to be labelled.
new_case
apt_changes
MOCK_NPM_OLD='{"dependencies":{"left-pad":{"version":"1.0.0"}}}'
MOCK_NPM_NEW='{"dependencies":{"left-pad":{"version":"1.3.0"}}}'
start_run --dry-run || true
[[ $RUN_RC -eq 0 ]] || fail "a dry run exited $RUN_RC"
for call in 'pkg update' 'pkg upgrade' 'pkg autoclean' 'npm update' 'pi update' 'chezmoi update'; do
    if grep -Fq "$call" "$CASE/calls"; then fail "a dry run ran $call"; fi
done
grep -Fq '[dry-run]' "$CASE/out" || fail 'the report does not say it was a dry run'
if grep -Fq 'tmux: 3.7c-1 -> 3.8' "$CASE/out"; then fail 'a dry run reported apt upgrades it never made'; fi
if grep -Fq 'left-pad: 1.0.0 -> 1.3.0' "$CASE/out"; then
    fail 'a dry run reported npm upgrades it never made'
fi
pass 'a dry run changes nothing and only reports what it skipped'

# Old transcripts are pruned so a widget tapped daily cannot fill the phone.
new_case
mkdir -p "$STATE"
for index in $(seq 1 12); do
    file=$(printf '%s/update-20200101-%02d0000.log' "$STATE" "$index")
    : >"$file"
    touch -t "2020010100$(printf '%02d' "$index")" "$file"
done
oldest=$(printf '%s/update-20200101-010000.log' "$STATE")
newest=$(printf '%s/update-20200101-120000.log' "$STATE")
start_run || true
remaining=$(find "$STATE" -maxdepth 1 -name 'update-*.log' | wc -l | tr -d '[:space:]')
[[ $remaining -lt 13 ]] || fail 'old transcripts are never pruned'
[[ ! -e $oldest ]] || fail 'the oldest transcript survived the prune'
[[ -e $newest ]] || fail 'the newest old transcript was pruned first'
pass 'old transcripts are pruned while the newest ones survive'

printf 'All system-update shortcut tests passed.\n'
