#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# run-dsh-agent.sh — run one DeepSeek Harness headless worker inside a bounded
# git worktree. DSH owns its configured credentials; this script never reads
# .env.agent or forwards its path to the worker. When a progress log is
# requested, it tails DSH's own growing session artifact for observed assistant,
# tool-call, and tool-result events.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DSH_PROGRESS_FILTER="$SCRIPT_DIR/dsh-progress-filter.jq"
readonly DEFAULT_EVENT_MAX_CHARS=2048

usage() {
  cat <<'EOF'
Usage: scripts/run-dsh-agent.sh --mode review|implement [options] < prompt.md

Run one DeepSeek Harness headless session with the prompt supplied on stdin.

Options:
  --mode MODE            Required: review or implement.
  --worktree DIR         Git worktree to run the session in. Required with
                         --mode implement; optional for review (defaults to cwd).
  --progress-log FILE    Append lifecycle, observed DSH events, and fallback
                         process-alive markers to FILE.
  --help                 Show this help.

Review sessions run with DSH_PERMISSION_MODE=read-only. Implementation sessions
run with DSH_PERMISSION_MODE=workspace-write and must remain in the supplied
worktree. DSH stores its own configured credential and session state under
~/.dsh; this launcher does not read .env.agent. The full raw session remains
DSH-owned. Observed event payloads are normalized and capped at
DSH_EVENT_MAX_CHARS (default: 2048) in the manager progress log.
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
worktree="$(cd "$worktree" && pwd -P)"

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
session_snapshot_file="$(mktemp -t run-dsh-agent-sessions)"
decoded_events_file="$(mktemp -t run-dsh-agent-events)"
worker_pid=""
cleanup() {
  if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
  fi
  rm -f "$result_file" "$stderr_file" "$session_snapshot_file" "$decoded_events_file"
}
trap cleanup EXIT INT TERM
: > "$progress_log"
printf '%s [start] provider=dsh mode=%s sandbox=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$mode" "$sandbox_mode" >> "$progress_log"

event_max_chars="${DSH_EVENT_MAX_CHARS:-$DEFAULT_EVENT_MAX_CHARS}"
[[ "$event_max_chars" =~ ^[1-9][0-9]*$ ]] \
  || fail "DSH_EVENT_MAX_CHARS must be a positive integer"

# DSH keys sessions by an encoded physical cwd: /a/b becomes --a-b--.
session_path="${worktree#/}"
session_slug="--${session_path//\//-}--"
session_root="${PURECUT_DSH_SESSIONS_ROOT:-$HOME/.dsh/sessions}"
session_directory="$session_root/$session_slug"
: > "$session_snapshot_file"
if [[ -d "$session_directory" ]]; then
  find "$session_directory" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null \
    | sort > "$session_snapshot_file"
fi

tail_enabled=true
tail_state="waiting"
tail_artifact=""
last_artifact_size=""
last_event_seq=0

if ! command -v zstd >/dev/null 2>&1; then
  printf '%s [tail] provider=dsh unavailable: zstd not found; using heartbeats\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$progress_log"
  tail_enabled=false
elif ! command -v jq >/dev/null 2>&1; then
  printf '%s [tail] provider=dsh unavailable: jq not found; using heartbeats\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$progress_log"
  tail_enabled=false
elif [[ ! -f "$DSH_PROGRESS_FILTER" ]]; then
  printf '%s [tail] provider=dsh unavailable: filter missing; using heartbeats\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$progress_log"
  tail_enabled=false
fi

clip_event_payload() {
  local payload="$1"
  if (( ${#payload} > event_max_chars )); then
    printf '%s…' "${payload:0:event_max_chars}"
  else
    printf '%s' "$payload"
  fi
}

find_session_artifact() {
  local -a new_sessions=()
  local candidate

  [[ -d "$session_directory" ]] || return 1
  while IFS= read -r candidate; do
    grep -Fqx -- "$candidate" "$session_snapshot_file" \
      || new_sessions+=("$candidate")
  done < <(find "$session_directory" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null)

  if (( ${#new_sessions[@]} > 1 )); then
    if [[ "$tail_state" != "ambiguous" ]]; then
      printf '%s [tail] provider=dsh session-attribution=ambiguous; using heartbeats\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$progress_log"
    fi
    tail_state="ambiguous"
    tail_enabled=false
    return 1
  fi

  if (( ${#new_sessions[@]} == 1 )); then
    tail_artifact="${new_sessions[0]}/session.jsonl.zstd"
    [[ -f "$tail_artifact" ]] || return 1
    tail_state="active"
    return 0
  fi

  return 1
}

tail_observed_events() {
  local artifact_size seq event_kind payload

  [[ "$tail_enabled" == true ]] || return 0
  if [[ -z "$tail_artifact" ]] && ! find_session_artifact; then
    return 0
  fi
  [[ -f "$tail_artifact" ]] || return 0

  artifact_size="$(stat -f '%z' "$tail_artifact" 2>/dev/null \
    || stat -c '%s' "$tail_artifact" 2>/dev/null)" || return 0
  [[ "$artifact_size" != "$last_artifact_size" ]] || return 0

  if ! zstd -dc "$tail_artifact" 2>/dev/null \
      | jq -nRr --unbuffered -f "$DSH_PROGRESS_FILTER" > "$decoded_events_file"; then
    return 0
  fi
  last_artifact_size="$artifact_size"

  while IFS=$'\t' read -r seq event_kind payload; do
    [[ "$seq" =~ ^[0-9]+$ ]] || continue
    (( seq > last_event_seq )) || continue
    payload="$(clip_event_payload "$payload")"
    printf '%s [%s] provider=dsh %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$event_kind" "$payload" >> "$progress_log"
    last_event_seq="$seq"
  done < "$decoded_events_file"
}

run_dsh >"$result_file" 2>"$stderr_file" &
worker_pid=$!
heartbeat_seconds="${DSH_HEARTBEAT_SECONDS:-15}"
[[ "$heartbeat_seconds" =~ ^[1-9][0-9]*$ ]] \
  || fail "DSH_HEARTBEAT_SECONDS must be a positive integer"

seconds_since_heartbeat=0
while kill -0 "$worker_pid" 2>/dev/null; do
  sleep 1
  kill -0 "$worker_pid" 2>/dev/null || break
  tail_observed_events
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
tail_observed_events
cat "$result_file"
cat "$stderr_file" >&2
printf '%s [exit] provider=dsh worker exited code=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$worker_status" >> "$progress_log"
exit "$worker_status"
