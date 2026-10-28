#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# run-claude-agent.sh — Claude Code leaf launcher using the CLI's own login.
# It never reads .env.agent and never sets a DeepSeek or Anthropic endpoint or
# credential variable: the credential is whatever the user configured for the
# `claude` CLI, so the worker draws on that account (and its weekly limit).
# The worker is instructed to review only, to edit only inside the supplied
# worktree, and to leave its edits uncommitted for the manager. Heartbeats
# indicate process liveness only, never tool activity.
#
# Confinement is permission-based, not an OS sandbox. --allowedTools is an
# allow-list, not a sandbox: it decides only which commands run without a prompt
# in a non-interactive -p session. The direct git/gh write path is explicitly
# denied with --disallowedTools, but in both modes the allow-listed `npx tsx`,
# `npx eslint` and `npm run …` execute repository code, so they can still
# perform arbitrary file writes and subprocess work; they remain
# general-purpose escape hatches. The manager's review of the actual diff is
# the acceptance gate — a worker commit can never merge itself.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROGRESS_FILTER="$SCRIPT_DIR/worker-progress-filter.jq"

# Flag verification against the installed Claude Code 2.1.206 (`claude --help`):
#   --permission-mode (acceptEdits|auto|bypassPermissions|manual|dontAsk|plan),
#   --output-format (text|json|stream-json), --model, --allowedTools,
#   --disallowedTools, --verbose, --include-partial-messages and -p/--print all
#   exist.
#   `--max-turns` does NOT exist in 2.1.206, so this leaf deliberately omits it
#   rather than inventing a flag; tool-spec syntax uses the form `--help` shows
#   (e.g. `Bash(git *)`), never a remembered one.
usage() {
  cat <<'HELP'
Usage: scripts/run-claude-agent.sh --mode review|implement [options] < prompt.md

  --mode MODE          Required: review or implement.
  --worktree DIR       Required for implement; review defaults to cwd.
  --progress-log FILE  Lifecycle markers and observed Claude activity. If
                       omitted, a temporary log is created. Result text:
                       FILE.final.md; session id (for a later --resume):
                       FILE.session; raw stream-json events: FILE.ndjson.
  --model MODEL        Model passed through to Claude. CLAUDE_AGENT_MODEL is
                       honoured when --model is not given; otherwise the CLI's
                       own default is used (no --model flag).
  --help               Show this help.

Uses the Claude Code CLI's own configured login, never .env.agent, and scrubs
inherited DeepSeek/Anthropic endpoint variables so a legacy DeepSeek endpoint
can never be used. The worker is instructed to review only in review mode, to
edit only inside the supplied worktree in implement mode, and to leave its
edits uncommitted for the manager. Review uses plan permission mode plus a
read-only tool allowlist; implement uses acceptEdits with a repository
build/test allowlist. Confinement is permission-based, not an OS sandbox:
--allowedTools only decides which commands run without a prompt, and in both
modes the allow-listed build/test commands execute repository code, so they can
still perform arbitrary file writes and subprocess work. The direct git/gh
write path is denied with --disallowedTools; the manager's review of the actual
diff is the acceptance gate. Session persistence is left enabled so
FILE.session can be resumed later. Heartbeats indicate process liveness only.
CLAUDE_HEARTBEAT_SECONDS sets the heartbeat interval (default 15).
HELP
}

fail() { printf 'run-claude-agent: %s\n' "$*" >&2; exit 1; }

mode=""
worktree=""
progress_log=""
progress_log_requested=false
model=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) [[ $# -ge 2 ]] || fail '--mode requires review or implement'; mode="$2"; shift 2 ;;
    --worktree) [[ $# -ge 2 ]] || fail '--worktree requires a directory'; worktree="$2"; shift 2 ;;
    --progress-log) [[ $# -ge 2 ]] || fail '--progress-log requires a file path'; progress_log="$2"; progress_log_requested=true; shift 2 ;;
    --model) [[ $# -ge 2 ]] || fail '--model requires a model name'; model="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

case "$mode" in
  review)
    permission_mode=plan
    # Read tools plus read-only shell. This is an allow-list, not a sandbox: in
    # a non-interactive -p session only these commands skip the prompt. Review's
    # read-only intent rests on plan mode plus the denied git/gh write path
    # below, but the allow-listed `npx tsx`/`npx eslint`/`npx tsc` execute
    # repository code, so they can still write files, commit through a spawned
    # subprocess, or reach the network; the permission rules do not prevent it.
    allowed_tool_list=(
      Read Glob Grep
      'Bash(git diff)' 'Bash(git diff *)'
      'Bash(git log)' 'Bash(git log *)'
      'Bash(git show)' 'Bash(git show *)'
      'Bash(git status)' 'Bash(git status *)'
      'Bash(npx tsx)' 'Bash(npx tsx *)'
      'Bash(npx eslint)' 'Bash(npx eslint *)'
      'Bash(npx tsc)' 'Bash(npx tsc *)'
    )
    ;;
  implement)
    permission_mode=acceptEdits
    [[ -n "$worktree" ]] || fail '--mode implement requires --worktree DIR'
    # Repository build/test commands. These run repository code, so they are
    # escape hatches rather than a sandbox: in implement mode they can still
    # perform arbitrary file writes and subprocess work. The direct git/gh write
    # path is denied in disallowed_tool_list below, and the worker is instructed
    # to leave edits uncommitted for the manager.
    allowed_tool_list=(
      Read Glob Grep Edit Write
      'Bash(npm run build:gates)' 'Bash(npm run build:gates *)'
      'Bash(npx tsx)' 'Bash(npx tsx *)'
      'Bash(npx eslint)' 'Bash(npx eslint *)'
      'Bash(npx tsc)' 'Bash(npx tsc *)'
      'Bash(npm run check:i18n)' 'Bash(npm run check:i18n *)'
    )
    ;;
  *) fail '--mode review or --mode implement is required' ;;
esac
allowed_tools="$(IFS=,; printf '%s' "${allowed_tool_list[*]}")"

# Deny rules take precedence over allow rules, so this explicitly closes the
# direct git/gh write path in both modes. It cannot sandbox the allow-listed
# commands themselves: `npx tsx` and friends execute repository code.
disallowed_tool_list=(
  'Bash(git commit)' 'Bash(git commit *)'
  'Bash(git add)' 'Bash(git add *)'
  'Bash(git push)' 'Bash(git push *)'
  'Bash(git reset *)'
  'Bash(git checkout *)'
  'Bash(git switch *)'
  'Bash(git stash *)'
  'Bash(gh)' 'Bash(gh *)'
)
disallowed_tools="$(IFS=,; printf '%s' "${disallowed_tool_list[*]}")"

# A caller-supplied model wins; otherwise honour CLAUDE_AGENT_MODEL; otherwise
# omit --model and let the CLI use its own configured default.
[[ -n "$model" ]] || model="${CLAUDE_AGENT_MODEL:-}"

[[ ! -t 0 ]] || fail 'no prompt on stdin; pipe a task instruction'
worktree="${worktree:-$PWD}"
[[ -d "$worktree" ]] || fail "--worktree path is not a directory: $worktree"
git -C "$worktree" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "--worktree path is not a git worktree: $worktree"
worktree="$(cd "$worktree" && pwd -P)"

command -v claude >/dev/null 2>&1 || fail 'claude executable was not found on PATH'
command -v jq >/dev/null 2>&1 || fail 'jq executable was not found on PATH'
heartbeat_seconds="${CLAUDE_HEARTBEAT_SECONDS:-15}"
[[ "$heartbeat_seconds" =~ ^[1-9][0-9]*$ ]] || fail 'CLAUDE_HEARTBEAT_SECONDS must be a positive integer'
task="$(cat)"
[[ -n "${task//[[:space:]]/}" ]] || fail 'the piped prompt is empty'

prompt_file="$(mktemp "${TMPDIR:-/tmp}/run-claude-agent-prompt.XXXXXX")"
json_file="$(mktemp "${TMPDIR:-/tmp}/run-claude-agent-json.XXXXXX")"
status_file="$(mktemp "${TMPDIR:-/tmp}/run-claude-agent-status.XXXXXX")"
worker_pid=""
cleanup() {
  if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -f "$prompt_file" "$json_file" "$status_file"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The worker prompt states the manager-commit rule the caller enforces. The
# git/gh ban is backed by --disallowedTools above, not by an OS sandbox.
{
  printf '%s\n\n' "$task"
  printf 'Launcher constraints: do not read .env.agent or use legacy DeepSeek credentials.\n'
  if [[ "$mode" == implement ]]; then
    printf 'Remain in the supplied worktree. Leave all edits uncommitted; the direct git commit/add/push/reset/checkout/switch/stash and gh commands are denied. The manager owns the commit. Report COMMIT: none in your final completion block.\n'
  else
    printf 'Review only. Do not edit, stage, or commit files. Report COMMIT: none.\n'
  fi
} > "$prompt_file"

[[ -n "$progress_log" ]] || progress_log="$(mktemp "${TMPDIR:-/tmp}/run-claude-agent-progress.XXXXXX")"
mkdir -p "$(dirname "$progress_log")" || fail "cannot create progress log directory: $progress_log"
# Resolve before changing cwd, including caller-supplied relative log paths.
progress_log="$(cd "$(dirname "$progress_log")" && pwd -P)/$(basename "$progress_log")"
final_message="$progress_log.final.md"
session_file="$progress_log.session"
raw_stream="$progress_log.ndjson"
: > "$progress_log"
: > "$final_message"
: > "$session_file"
mark() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$progress_log"; }

# A requested progress log distils the raw stream-json events live; otherwise a
# single json result is enough and no filter (or jq stream) is needed.
if [[ "$progress_log_requested" == true ]]; then
  streaming=true
  [[ -f "$PROGRESS_FILTER" ]] || fail "progress filter not found: $PROGRESS_FILTER"
  : > "$raw_stream"
else
  streaming=false
fi

claude_args=(
  -p
  --permission-mode "$permission_mode"
  --allowedTools "$allowed_tools"
  --disallowedTools "$disallowed_tools"
)
[[ -n "$model" ]] && claude_args+=(--model "$model")
if [[ "$streaming" == true ]]; then
  claude_args+=(--output-format stream-json --verbose --include-partial-messages)
else
  claude_args+=(--output-format json)
fi
# Session persistence is deliberately left enabled (no --no-session-persistence)
# so FILE.session can be handed to a follow-up `claude --resume`.

mark "[start] provider=claude mode=$mode permission-mode=$permission_mode"
printf '== Claude progress: %s; final message: %s ==\n' "$progress_log" "$final_message" >&2

# Never inherit a legacy DeepSeek credential or endpoint. ANTHROPIC_API_KEY is
# left alone: the CLI's own configured login is the credential.
if [[ "$streaming" == true ]]; then
  (
    cd "$worktree" || exit 1
    set +e
    env -u DEEPSEEK_AGENT_ENV_FILE -u DEEPSEEK_API_KEY \
        -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN \
        claude "${claude_args[@]}" 2>> "$progress_log" \
      | tee "$raw_stream" \
      | jq -nRr --unbuffered -f "$PROGRESS_FILTER" \
      | tee -a "$progress_log" >&2
    printf '%s' "${PIPESTATUS[0]}" > "$status_file"
  ) < "$prompt_file" &
else
  (
    cd "$worktree" || exit 1
    exec env -u DEEPSEEK_AGENT_ENV_FILE -u DEEPSEEK_API_KEY \
        -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN \
        claude "${claude_args[@]}"
  ) < "$prompt_file" > "$json_file" 2>> "$progress_log" &
fi
worker_pid=$!

seconds_since_heartbeat=0
while kill -0 "$worker_pid" 2>/dev/null; do
  sleep 1
  kill -0 "$worker_pid" 2>/dev/null || break
  seconds_since_heartbeat=$((seconds_since_heartbeat + 1))
  if (( seconds_since_heartbeat >= heartbeat_seconds )); then
    mark '[heartbeat] provider=claude process-alive (not tool activity)'
    seconds_since_heartbeat=0
  fi
done

if [[ "$streaming" == true ]]; then
  wait "$worker_pid" 2>/dev/null || true
  worker_status="$(cat "$status_file" 2>/dev/null || true)"
  [[ "$worker_status" =~ ^[0-9]+$ ]] || worker_status=1
  jq -nRr '[inputs | fromjson? // empty | select(type == "object" and .type == "result")] | last | .result // empty' \
    "$raw_stream" > "$final_message" 2>/dev/null || : > "$final_message"
  jq -nRr '[inputs | fromjson? // empty | select(type == "object" and .type == "result")] | last | .session_id // empty' \
    "$raw_stream" > "$session_file" 2>/dev/null || : > "$session_file"
else
  worker_status=0
  wait "$worker_pid" || worker_status=$?
  jq -nRr '[inputs | fromjson? // empty | select(type == "object")] | last | .result // empty' \
    "$json_file" > "$final_message" 2>/dev/null || : > "$final_message"
  jq -nRr '[inputs | fromjson? // empty | select(type == "object")] | last | .session_id // empty' \
    "$json_file" > "$session_file" 2>/dev/null || : > "$session_file"
fi
worker_pid=""

mark "[exit] provider=claude worker exited code=$worker_status"
cat "$final_message"
exit "$worker_status"
