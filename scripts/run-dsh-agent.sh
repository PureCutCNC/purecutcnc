#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# run-dsh-agent.sh — run one DeepSeek Harness headless worker inside a bounded
# git worktree. DSH owns its configured credentials; this script never reads
# .env.agent or forwards its path to the worker.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/run-dsh-agent.sh --mode review|implement [options] < prompt.md

Run one DeepSeek Harness headless session with the prompt supplied on stdin.

Options:
  --mode MODE            Required: review or implement.
  --worktree DIR         Git worktree to run the session in. Required with
                         --mode implement; optional for review (defaults to cwd).
  --progress-log FILE    Append lifecycle and process-alive markers to FILE.
  --help                 Show this help.

Review sessions run with DSH_PERMISSION_MODE=read-only. Implementation sessions
run with DSH_PERMISSION_MODE=workspace-write and must remain in the supplied
worktree. DSH stores its own configured credential and session state under
~/.dsh; this launcher does not read .env.agent.
EOF
}

fail() { printf 'run-dsh-agent: %s\n' "$*" >&2; exit 1; }

mode=""
worktree=""
progress_log=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || fail "--mode requires review or implement"
      mode="$2"
      shift 2
      ;;
    --worktree)
      [[ $# -ge 2 ]] || fail "--worktree requires a directory"
      worktree="$2"
      shift 2
      ;;
    --progress-log)
      [[ $# -ge 2 ]] || fail "--progress-log requires a file path"
      progress_log="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

case "$mode" in
  review|implement) ;;
  *) fail "--mode review or --mode implement is required" ;;
esac

[[ ! -t 0 ]] || fail "no prompt on stdin; pipe one, e.g.: $0 --mode $mode < prompt.md"

if [[ "$mode" == "implement" && -z "$worktree" ]]; then
  fail "--mode implement requires --worktree DIR to confine the session"
fi
worktree="${worktree:-$PWD}"
[[ -d "$worktree" ]] || fail "--worktree path is not a directory: $worktree"
git -C "$worktree" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "--worktree path is not a git worktree: $worktree"

command -v dsh >/dev/null 2>&1 || fail "dsh executable was not found on PATH"

task="$(cat)"
[[ -n "${task//[[:space:]]/}" ]] || fail "the piped prompt is empty"
[[ ${#task} -le 131072 ]] || fail "the piped prompt exceeds the 128 KiB DSH command-line limit"

if [[ "$mode" == "review" ]]; then
  sandbox_mode="read-only"
else
  sandbox_mode="workspace-write"
fi

run_dsh() {
  (
    cd "$worktree" || exit 1
    env -u DEEPSEEK_AGENT_ENV_FILE -u DEEPSEEK_API_KEY \
      DSH_PERMISSION_MODE="$sandbox_mode" \
      dsh --profile headless "$task"
  )
}

if [[ -z "$progress_log" ]]; then
  run_dsh
  exit $?
fi

mkdir -p "$(dirname "$progress_log")" 2>/dev/null \
  || fail "cannot create progress log directory for: $progress_log"
result_file="$(mktemp -t run-dsh-agent-result)"
stderr_file="$(mktemp -t run-dsh-agent-stderr)"
worker_pid=""
cleanup() {
  if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
  fi
  rm -f "$result_file" "$stderr_file"
}
trap cleanup EXIT INT TERM
: > "$progress_log"
printf '%s [start] provider=dsh mode=%s sandbox=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$mode" "$sandbox_mode" >> "$progress_log"

run_dsh >"$result_file" 2>"$stderr_file" &
worker_pid=$!
heartbeat_seconds="${DSH_HEARTBEAT_SECONDS:-15}"
[[ "$heartbeat_seconds" =~ ^[1-9][0-9]*$ ]] \
  || fail "DSH_HEARTBEAT_SECONDS must be a positive integer"

seconds_since_heartbeat=0
while kill -0 "$worker_pid" 2>/dev/null; do
  sleep 1
  kill -0 "$worker_pid" 2>/dev/null || break
  seconds_since_heartbeat=$((seconds_since_heartbeat + 1))
  if (( seconds_since_heartbeat >= heartbeat_seconds )); then
    printf '%s [heartbeat] provider=dsh process-alive (not tool activity)\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$progress_log"
    seconds_since_heartbeat=0
  fi
done

set +e
wait "$worker_pid"
worker_status=$?
set -e
worker_pid=""
cat "$result_file"
cat "$stderr_file" >&2
printf '%s [exit] provider=dsh worker exited code=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$worker_status" >> "$progress_log"
exit "$worker_status"
