#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# worker-status.sh — cheap, bounded status probe for a dispatched slice.
# Reads the progress log written by dispatch-task.sh / run-claude-deepseek-agent.sh
# and reports the worker's state plus its recent activity. Designed for a manager
# to poll every 30-60s instead of blocking on (or killing) a long dispatch:
# judge the worker by idle time since its last progress entry, never by total
# wall-clock runtime — a healthy slice can run 10+ minutes.

set -euo pipefail

WORKTREE_BASE="${PURECUT_WORKTREE_BASE:-/Users/frankp/Projects/worktrees/purecutcnc}"

usage() {
  cat <<'EOF'
Usage: scripts/worker-status.sh --slug SLUG [options]
       scripts/worker-status.sh --log FILE [options]

Report the state of a dispatched worker from its progress log:
  state=waiting     log not created yet (dispatch still setting up)
  state=running     worker active; idle= shows seconds since the last entry
  state=stale       no progress for --stale-after seconds — inspect the log
                    tail and worktree before deciding anything; do not kill
                    on this signal alone
  state=verifying   worker exited; independent build gate in progress
  state=done        dispatch finished; read the dispatch report

Options:
  --slug SLUG         Locate the log at $PURECUT_WORKTREE_BASE/SLUG.progress.log.
  --log FILE          Explicit progress log path (overrides --slug).
  --stale-after SECS  Idle threshold before reporting stale (default 300).
  --lines N           Recent progress lines to echo (default 8).
  --help              Show this help.
EOF
}

fail() { printf 'worker-status: %s\n' "$*" >&2; exit 1; }

slug=""
log=""
stale_after=300
lines=8

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug)        [[ $# -ge 2 ]] || fail "--slug requires a value"; slug="$2"; shift 2 ;;
    --log)         [[ $# -ge 2 ]] || fail "--log requires a file path"; log="$2"; shift 2 ;;
    --stale-after) [[ $# -ge 2 ]] || fail "--stale-after requires seconds"; stale_after="$2"; shift 2 ;;
    --lines)       [[ $# -ge 2 ]] || fail "--lines requires a number"; lines="$2"; shift 2 ;;
    --help|-h)     usage; exit 0 ;;
    *)             fail "unknown option: $1" ;;
  esac
done

[[ -n "$log" || -n "$slug" ]] || fail "--slug SLUG or --log FILE is required"
[[ "$stale_after" =~ ^[0-9]+$ ]] || fail "--stale-after must be a number of seconds"
[[ "$lines" =~ ^[0-9]+$ ]] || fail "--lines must be a number"
[[ -n "$log" ]] || log="$WORKTREE_BASE/$slug.progress.log"

if [[ ! -f "$log" ]]; then
  printf 'state=waiting log=%s (not created yet)\n' "$log"
  exit 0
fi

mtime="$(stat -f '%m' "$log" 2>/dev/null || stat -c '%Y' "$log" 2>/dev/null)" \
  || fail "cannot stat progress log: $log"
idle=$(( $(date +%s) - mtime ))

# Lifecycle markers, newest wins: [dispatch] done > [exit] > activity.
if grep -q '\[dispatch\] done' "$log"; then
  state="done"
elif grep -q '\[exit\]' "$log"; then
  state="verifying"
elif (( idle > stale_after )); then
  state="stale"
else
  state="running"
fi

printf 'state=%s idle=%ss log=%s\n' "$state" "$idle" "$log"
if [[ "$state" == "stale" ]]; then
  printf 'no progress for %ss — inspect the log tail and worktree before acting; do not kill on this alone\n' "$idle"
fi
printf -- '--- last %s entries ---\n' "$lines"
tail -n "$lines" "$log"
