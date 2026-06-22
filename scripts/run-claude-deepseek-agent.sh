#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/run-claude-deepseek-agent.sh --mode review|implement [options] < prompt.md

Run one Claude Code non-interactive session through the DeepSeek Anthropic-compatible endpoint.

Options:
  --mode MODE            Required: review or implement.
  --allow-bypass         Required with --mode implement.
  --max-budget-usd USD   Override DEEPSEEK_MAX_BUDGET_USD (default: 1.00).
  --output-format FORMAT Claude print output: text or json (default: text).
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
      DEEPSEEK_API_KEY|DEEPSEEK_PRO_MODEL|DEEPSEEK_FLASH_MODEL|DEEPSEEK_EFFORT_LEVEL|DEEPSEEK_MAX_BUDGET_USD)
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
allow_bypass=false
max_budget_usd=""
output_format="text"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || fail "--mode requires review or implement"
      mode="$2"
      shift 2
      ;;
    --allow-bypass)
      allow_bypass=true
      shift
      ;;
    --max-budget-usd)
      [[ $# -ge 2 ]] || fail "--max-budget-usd requires a value"
      max_budget_usd="$2"
      shift 2
      ;;
    --output-format)
      [[ $# -ge 2 ]] || fail "--output-format requires text or json"
      output_format="$2"
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

if [[ "$mode" == "implement" && "$allow_bypass" != true ]]; then
  fail "--mode implement requires --allow-bypass"
fi

load_env_file "${DEEPSEEK_AGENT_ENV_FILE:-$REPO_ROOT/.env.agent}"

[[ -n "${DEEPSEEK_API_KEY:-}" ]] || fail "DEEPSEEK_API_KEY is not configured; copy agent.env.example to .env.agent"
command -v claude >/dev/null 2>&1 || fail "claude executable was not found on PATH"

export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"
export ANTHROPIC_MODEL="${DEEPSEEK_PRO_MODEL:-deepseek-v4-pro}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$ANTHROPIC_MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$ANTHROPIC_MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${DEEPSEEK_FLASH_MODEL:-deepseek-v4-flash}"
export CLAUDE_CODE_SUBAGENT_MODEL="$ANTHROPIC_DEFAULT_HAIKU_MODEL"
export CLAUDE_CODE_EFFORT_LEVEL="${DEEPSEEK_EFFORT_LEVEL:-max}"

if [[ -z "$max_budget_usd" ]]; then
  max_budget_usd="${DEEPSEEK_MAX_BUDGET_USD:-1.00}"
fi

claude_args=(
  --print
  --no-session-persistence
  --effort "$CLAUDE_CODE_EFFORT_LEVEL"
  --max-budget-usd "$max_budget_usd"
  --output-format "$output_format"
)

if [[ "$mode" == "implement" ]]; then
  claude_args+=(--permission-mode bypassPermissions)
else
  claude_args+=(--permission-mode plan)
fi

exec claude "${claude_args[@]}"
