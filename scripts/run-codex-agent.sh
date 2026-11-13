#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# Codex owns its login. Keep linked-worktree Git writes in the manager process.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: scripts/run-codex-agent.sh --mode review|implement [options] < prompt.md
  --worktree DIR       Required for implement; review defaults to cwd.
  --progress-log FILE  Lifecycle markers and observed Codex stderr. If omitted,
                       create a temporary log. Final message: FILE.final.md.
  --help               Show this help.

Uses Codex's own login and configured model, never .env.agent. Review uses
read-only; implement uses workspace-write and leaves edits uncommitted for the
manager. Heartbeats indicate process liveness only. CODEX_HEARTBEAT_SECONDS
sets the heartbeat interval (default 15). Codex session artifacts remain Codex-owned.
HELP
}
fail() { printf 'run-codex-agent: %s\n' "$*" >&2; exit 1; }
mode=""
worktree=""
progress_log=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) [[ $# -ge 2 ]] || fail '--mode requires review or implement'; mode="$2"; shift 2 ;;
    --worktree) [[ $# -ge 2 ]] || fail '--worktree requires a directory'; worktree="$2"; shift 2 ;;
    --progress-log) [[ $# -ge 2 ]] || fail '--progress-log requires a file path'; progress_log="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done
case "$mode" in
  review) sandbox_mode=read-only ;;
  implement) sandbox_mode=workspace-write; [[ -n "$worktree" ]] || fail '--mode implement requires --worktree DIR' ;;
  *) fail '--mode review or --mode implement is required' ;;
esac
[[ ! -t 0 ]] || fail 'no prompt on stdin; pipe a task instruction'
worktree="${worktree:-$PWD}"
[[ -d "$worktree" ]] || fail "--worktree path is not a directory: $worktree"
git -C "$worktree" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "--worktree path is not a git worktree: $worktree"
worktree="$(cd "$worktree" && pwd -P)"
command -v codex >/dev/null 2>&1 || fail 'codex executable was not found on PATH'
heartbeat_seconds="${CODEX_HEARTBEAT_SECONDS:-15}"
[[ "$heartbeat_seconds" =~ ^[1-9][0-9]*$ ]] || fail 'CODEX_HEARTBEAT_SECONDS must be a positive integer'
task="$(cat)"
[[ -n "${task//[[:space:]]/}" ]] || fail 'the piped prompt is empty'

prompt_file="$(mktemp "${TMPDIR:-/tmp}/run-codex-agent-prompt.XXXXXX")"
result_file="$(mktemp "${TMPDIR:-/tmp}/run-codex-agent-result.XXXXXX")"
worker_pid=""
cleanup() {
  if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -f "$prompt_file" "$result_file"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
{
  printf '%s\n\n' "$task"
  printf 'Launcher constraints: do not read .env.agent or use legacy DeepSeek credentials.\n'
  if [[ "$mode" == implement ]]; then
    printf 'Remain in the supplied worktree. Leave all edits uncommitted; do not stage or commit. The manager owns the commit. Report COMMIT: none in your final completion block.\n'
  else
    printf 'Review only. Do not edit, stage, or commit files. Report COMMIT: none.\n'
  fi
} > "$prompt_file"
[[ -n "$progress_log" ]] || progress_log="$(mktemp "${TMPDIR:-/tmp}/run-codex-agent-progress.XXXXXX")"
mkdir -p "$(dirname "$progress_log")" || fail "cannot create progress log directory: $progress_log"
# Resolve before changing cwd, including caller-supplied relative log paths.
progress_log="$(cd "$(dirname "$progress_log")" && pwd -P)/$(basename "$progress_log")"
final_message="$progress_log.final.md"
: > "$progress_log"
: > "$final_message"
mark() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$progress_log"; }
mark "[start] provider=codex mode=$mode sandbox=$sandbox_mode"
printf '== Codex progress: %s; final message: %s ==\n' "$progress_log" "$final_message" >&2
(
  cd "$worktree"
  exec env -u DEEPSEEK_AGENT_ENV_FILE -u DEEPSEEK_API_KEY \
    codex exec -s "$sandbox_mode" -C "$worktree" -o "$final_message" -
) < "$prompt_file" > "$result_file" 2>> "$progress_log" &
worker_pid=$!
seconds_since_heartbeat=0
while kill -0 "$worker_pid" 2>/dev/null; do
  sleep 1
  kill -0 "$worker_pid" 2>/dev/null || break
  seconds_since_heartbeat=$((seconds_since_heartbeat + 1))
  if (( seconds_since_heartbeat >= heartbeat_seconds )); then
    mark '[heartbeat] provider=codex process-alive (not tool activity)'
    seconds_since_heartbeat=0
  fi
done
worker_status=0
wait "$worker_pid" || worker_status=$?
worker_pid=""
cat "$result_file"
mark "[exit] provider=codex worker exited code=$worker_status"
exit "$worker_status"
