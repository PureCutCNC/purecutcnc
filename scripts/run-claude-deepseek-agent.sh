#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly PROGRESS_FILTER="$SCRIPT_DIR/worker-progress-filter.jq"

usage() {
  cat <<'EOF'
Usage: scripts/run-claude-deepseek-agent.sh --mode review|implement [options] < prompt.md

Run one Claude Code non-interactive session through the DeepSeek Anthropic-compatible endpoint.

Options:
  --mode MODE            Required: review or implement.
  --worktree DIR         Git worktree to run the session in. Required with
                         --mode implement; optional for review (defaults to cwd).
  --allow-bypass         Required with --mode implement.
  --output-format FORMAT Claude print output: text or json (default: text).
  --progress-log FILE    Append one-line timestamped progress entries to FILE
                         while the worker runs (mirrored to stderr), so a
                         manager can tail the log instead of staring at a
                         silent pipe. Runs claude in stream-json mode
                         internally; stdout still carries only the final
                         result in the requested --output-format. The raw
                         event stream is kept at FILE.ndjson for forensics.
  --help                 Show this help.

Credentials are loaded from DEEPSEEK_AGENT_ENV_FILE when set, otherwise the
project-local .env.agent, unless DEEPSEEK_API_KEY is already present in the
environment. The integration manager should point DEEPSEEK_AGENT_ENV_FILE at
the canonical ignored file in the primary worktree; never commit .env.agent.
EOF
}

fail() {
  printf 'run-claude-deepseek-agent: %s\n' "$*" >&2
  exit 1
}

strip_optional_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    printf '%s' "${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    printf '%s' "${value:1:${#value}-2}"
  else
    printf '%s' "$value"
  fi
}

load_env_file() {
  local env_file="$1"
  local line key value

  [[ -f "$env_file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || fail "invalid .env.agent line; expected KEY=VALUE"

    key="${line%%=*}"
    value="$(strip_optional_quotes "${line#*=}")"
    case "$key" in
      DEEPSEEK_API_KEY|DEEPSEEK_PRO_MODEL|DEEPSEEK_FLASH_MODEL|DEEPSEEK_EFFORT_LEVEL)
        if [[ -z "${!key:-}" ]]; then
          export "$key=$value"
        fi
        ;;
      *)
        fail "unsupported .env.agent key: $key"
        ;;
    esac
  done < "$env_file"
}

mode=""
worktree=""
allow_bypass=false
output_format="text"
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
    --allow-bypass)
      allow_bypass=true
      shift
      ;;
    --output-format)
      [[ $# -ge 2 ]] || fail "--output-format requires text or json"
      output_format="$2"
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

case "$output_format" in
  text|json) ;;
  *) fail "--output-format must be text or json" ;;
esac

if [[ -n "$progress_log" ]]; then
  command -v jq >/dev/null 2>&1 || fail "--progress-log requires jq on PATH"
  [[ -f "$PROGRESS_FILTER" ]] || fail "progress filter not found: $PROGRESS_FILTER"
  mkdir -p "$(dirname "$progress_log")" 2>/dev/null \
    || fail "cannot create progress log directory for: $progress_log"
fi

# The prompt must be piped in on stdin; without redirection `claude --print` would
# block waiting on the terminal. Fail fast with a clear message instead of hanging.
[[ ! -t 0 ]] || fail "no prompt on stdin; pipe one, e.g.: $0 --mode $mode < prompt.md"

if [[ "$mode" == "implement" && "$allow_bypass" != true ]]; then
  fail "--mode implement requires --allow-bypass"
fi

# A bypass worker must be confined to an explicit worktree; review may run in cwd.
if [[ "$mode" == "implement" && -z "$worktree" ]]; then
  fail "--mode implement requires --worktree DIR to confine the session"
fi

if [[ -n "$worktree" ]]; then
  [[ -d "$worktree" ]] || fail "--worktree path is not a directory: $worktree"
  git -C "$worktree" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || fail "--worktree path is not a git worktree: $worktree"
fi

env_file="${DEEPSEEK_AGENT_ENV_FILE:-$REPO_ROOT/.env.agent}"

# Refuse to run with a group/other-readable credential file (must be chmod 600).
if [[ -f "$env_file" ]]; then
  perms="$(stat -f '%Lp' "$env_file" 2>/dev/null || stat -c '%a' "$env_file" 2>/dev/null)"
  if [[ -n "$perms" && "${perms: -2}" != "00" ]]; then
    fail "credential file is group/other-accessible ($perms); run: chmod 600 $env_file"
  fi
fi

load_env_file "$env_file"

[[ -n "${DEEPSEEK_API_KEY:-}" ]] || fail "DEEPSEEK_API_KEY is not configured; copy agent.env.example to .env.agent"
command -v claude >/dev/null 2>&1 || fail "claude executable was not found on PATH"

# When this launcher is invoked from inside a Claude Code session, the child
# `claude` process inherits the parent session's host/OAuth markers and would
# authenticate with the parent's (rotating) Anthropic OAuth token instead of the
# DeepSeek token set below — every request then 401s against the DeepSeek endpoint.
# Scrub that inherited session context so the worker authenticates ONLY with the
# DeepSeek credential. (The CLAUDE_CODE_* vars this script needs are exported below.)
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CLAUDECODE AI_AGENT \
      CLAUDE_AGENT_SDK_VERSION CLAUDE_EFFORT
for __var in ${!CLAUDE_CODE_@}; do unset "$__var"; done
unset __var

export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"
export ANTHROPIC_MODEL="${DEEPSEEK_PRO_MODEL:-deepseek-v4-pro}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$ANTHROPIC_MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$ANTHROPIC_MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${DEEPSEEK_FLASH_MODEL:-deepseek-v4-flash}"
export CLAUDE_CODE_SUBAGENT_MODEL="$ANTHROPIC_DEFAULT_HAIKU_MODEL"
export CLAUDE_CODE_EFFORT_LEVEL="${DEEPSEEK_EFFORT_LEVEL:-max}"

# The token now lives in ANTHROPIC_AUTH_TOKEN. Drop the raw DeepSeek vars and the
# credential-file path so the worker process can't read the key back out of its
# environment or locate the on-disk .env.agent.
unset DEEPSEEK_API_KEY DEEPSEEK_AGENT_ENV_FILE \
      DEEPSEEK_PRO_MODEL DEEPSEEK_FLASH_MODEL DEEPSEEK_EFFORT_LEVEL

claude_args=(
  --print
  --no-session-persistence
  --effort "$CLAUDE_CODE_EFFORT_LEVEL"
)

if [[ "$mode" == "implement" ]]; then
  claude_args+=(--permission-mode bypassPermissions)
else
  claude_args+=(--permission-mode plan)
fi

if [[ -n "$progress_log" ]]; then
  # Stream events so progress can be distilled live; the final result is
  # re-emitted on stdout in the requested --output-format below, so callers
  # see the same stdout contract as a non-streaming run.
  claude_args+=(--output-format stream-json --verbose --include-partial-messages)
else
  claude_args+=(--output-format "$output_format")
fi

# Run the worker from inside its worktree. NOTE: this sets the working directory
# only — it is NOT a sandbox. A bypassPermissions worker can still reach any path
# via absolute paths; staying in the worktree is a convention enforced by the
# prompt and post-hoc review, not a technical boundary.
if [[ -n "$worktree" ]]; then
  cd "$worktree" || fail "could not enter worktree: $worktree"
fi

# Fast path: no progress log requested — hand the process over to claude.
[[ -n "$progress_log" ]] || exec claude "${claude_args[@]}"

# Progress path: distill each stream-json event into a one-line entry appended
# to the progress log the moment it happens (mirrored to stderr), so a manager
# can poll the log and judge the worker by idle time instead of killing a
# long-but-healthy session. The raw stream is kept beside it for forensics.
raw_stream="$progress_log.ndjson"
: > "$progress_log"
: > "$raw_stream"

set +e
claude "${claude_args[@]}" \
  | tee "$raw_stream" \
  | jq -nRr --unbuffered -f "$PROGRESS_FILTER" \
  | tee -a "$progress_log" >&2
worker_status="${PIPESTATUS[0]}"
set -e

printf '%s [exit] worker exited code=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$worker_status" >> "$progress_log"

# Re-emit the final result on stdout in the caller's requested format,
# tolerating a truncated last line if the worker died mid-write.
if [[ "$output_format" == "json" ]]; then
  jq -nRc '[inputs | fromjson? // empty | select(type == "object" and .type == "result")] | last // empty' \
    "$raw_stream"
else
  jq -nRr '[inputs | fromjson? // empty | select(type == "object" and .type == "result")] | last | .result // empty' \
    "$raw_stream"
fi

exit "$worker_status"
