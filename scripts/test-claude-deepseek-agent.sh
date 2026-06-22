#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly LAUNCHER="$SCRIPT_DIR/run-claude-deepseek-agent.sh"
readonly TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

fail() {
  printf 'test-claude-deepseek-agent: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" == *"$needle"* ]] || fail "expected output to contain: $needle"
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" != *"$needle"* ]] || fail "expected output not to contain: $needle"
}

mkdir -p "$TEMP_DIR/bin"
cat > "$TEMP_DIR/bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'args:\n'
printf '<%s>\n' "$@"
printf 'model=<%s>\n' "$ANTHROPIC_MODEL"
printf 'endpoint=<%s>\n' "$ANTHROPIC_BASE_URL"
printf 'stdin:\n'
cat
EOF
chmod +x "$TEMP_DIR/bin/claude"

cat > "$TEMP_DIR/agent.env" <<'EOF'
DEEPSEEK_API_KEY=test-secret
DEEPSEEK_PRO_MODEL="test-pro-model"
DEEPSEEK_FLASH_MODEL='test-flash-model'
DEEPSEEK_EFFORT_LEVEL=high
DEEPSEEK_MAX_BUDGET_USD=0.50
EOF

review_output="$(printf 'first line\nsecond line\n' | PATH="$TEMP_DIR/bin:$PATH" DEEPSEEK_AGENT_ENV_FILE="$TEMP_DIR/agent.env" "$LAUNCHER" --mode review)"
assert_contains "$review_output" '<--permission-mode>'
assert_contains "$review_output" '<plan>'
assert_not_contains "$review_output" 'bypassPermissions'
assert_contains "$review_output" '<--max-budget-usd>'
assert_contains "$review_output" '<0.50>'
assert_contains "$review_output" 'model=<test-pro-model>'
assert_contains "$review_output" 'endpoint=<https://api.deepseek.com/anthropic>'
assert_contains "$review_output" 'first line'
assert_contains "$review_output" 'second line'
assert_not_contains "$review_output" 'test-secret'

if implement_error="$(printf 'implement task\n' | PATH="$TEMP_DIR/bin:$PATH" DEEPSEEK_AGENT_ENV_FILE="$TEMP_DIR/agent.env" "$LAUNCHER" --mode implement 2>&1)"; then
  fail 'implementation mode unexpectedly ran without --allow-bypass'
fi
assert_contains "$implement_error" '--mode implement requires --allow-bypass'

implement_output="$(printf 'implement task\n' | PATH="$TEMP_DIR/bin:$PATH" DEEPSEEK_AGENT_ENV_FILE="$TEMP_DIR/agent.env" "$LAUNCHER" --mode implement --allow-bypass --max-budget-usd 0.25 --output-format json)"
assert_contains "$implement_output" '<bypassPermissions>'
assert_contains "$implement_output" '<0.25>'
assert_contains "$implement_output" '<json>'

if missing_config_error="$(printf 'review\n' | PATH="$TEMP_DIR/bin:$PATH" DEEPSEEK_AGENT_ENV_FILE="$TEMP_DIR/missing.env" "$LAUNCHER" --mode review 2>&1)"; then
  fail 'launcher unexpectedly ran without credentials'
fi
assert_contains "$missing_config_error" 'DEEPSEEK_API_KEY is not configured'
assert_not_contains "$missing_config_error" 'test-secret'

printf 'test-claude-deepseek-agent: passed\n'
