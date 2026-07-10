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

# Fake claude: echoes args/env/stdin (plain modes), or emits a canned
# stream-json event stream when invoked with --output-format stream-json so
# the --progress-log path can be tested without a real endpoint.
cat > "$TEMP_DIR/bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" stream-json "* ]]; then
  cat >/dev/null
  printf '%s\n' '{"type":"system","subtype":"init","model":"fake-model"}'
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading context files"}]}}'
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm run build"}}]}}'
  printf '%s\n' '{"type":"result","subtype":"success","result":"STATUS: complete","num_turns":3,"duration_ms":4200}'
  exit "${FAKE_CLAUDE_EXIT:-0}"
fi
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
EOF
# The launcher refuses group/other-readable credential files.
chmod 600 "$TEMP_DIR/agent.env"

# A minimal real git repo so --worktree validation passes in implement mode.
git init -q "$TEMP_DIR/wt"

run_launcher() {
  PATH="$TEMP_DIR/bin:$PATH" DEEPSEEK_AGENT_ENV_FILE="$TEMP_DIR/agent.env" "$LAUNCHER" "$@"
}

# ---- review mode: plan permissions, model/endpoint env, prompt passthrough ----
review_output="$(printf 'first line\nsecond line\n' | run_launcher --mode review)"
assert_contains "$review_output" '<--permission-mode>'
assert_contains "$review_output" '<plan>'
assert_not_contains "$review_output" 'bypassPermissions'
assert_contains "$review_output" 'model=<test-pro-model>'
assert_contains "$review_output" 'endpoint=<https://api.deepseek.com/anthropic>'
assert_contains "$review_output" 'first line'
assert_contains "$review_output" 'second line'
assert_not_contains "$review_output" 'test-secret'

# ---- implement mode guards ----
if implement_error="$(printf 'implement task\n' | run_launcher --mode implement 2>&1)"; then
  fail 'implementation mode unexpectedly ran without --allow-bypass'
fi
assert_contains "$implement_error" '--mode implement requires --allow-bypass'

if no_worktree_error="$(printf 'implement task\n' | run_launcher --mode implement --allow-bypass 2>&1)"; then
  fail 'implementation mode unexpectedly ran without --worktree'
fi
assert_contains "$no_worktree_error" '--mode implement requires --worktree'

implement_output="$(printf 'implement task\n' | run_launcher --mode implement --allow-bypass --worktree "$TEMP_DIR/wt" --output-format json)"
assert_contains "$implement_output" '<bypassPermissions>'
assert_contains "$implement_output" '<json>'

# ---- missing credentials ----
if missing_config_error="$(printf 'review\n' | PATH="$TEMP_DIR/bin:$PATH" DEEPSEEK_AGENT_ENV_FILE="$TEMP_DIR/missing.env" "$LAUNCHER" --mode review 2>&1)"; then
  fail 'launcher unexpectedly ran without credentials'
fi
assert_contains "$missing_config_error" 'DEEPSEEK_API_KEY is not configured'
assert_not_contains "$missing_config_error" 'test-secret'

# ---- progress log: distilled entries stream to the log; stdout stays final-text ----
progress_log="$TEMP_DIR/slice.progress.log"
progress_stdout="$(printf 'task\n' | run_launcher --mode review --progress-log "$progress_log" 2>"$TEMP_DIR/progress.stderr")"
[[ "$progress_stdout" == "STATUS: complete" ]] \
  || fail "expected stdout to be the final result text, got: $progress_stdout"
[[ -f "$progress_log" ]] || fail 'progress log was not created'
progress_content="$(cat "$progress_log")"
assert_contains "$progress_content" '[init] model=fake-model'
assert_contains "$progress_content" '[note] Reading context files'
assert_contains "$progress_content" '[tool] Bash npm run build'
assert_contains "$progress_content" '[done] success turns=3'
assert_contains "$progress_content" '[exit] worker exited code=0'
[[ -f "$progress_log.ndjson" ]] || fail 'raw event stream (.ndjson) was not kept'
# Progress lines are mirrored to stderr for foreground callers.
assert_contains "$(cat "$TEMP_DIR/progress.stderr")" '[tool] Bash npm run build'

# ---- progress log + json format: stdout carries the final result event ----
progress_json="$(printf 'task\n' | run_launcher --mode review --progress-log "$TEMP_DIR/json.progress.log" --output-format json 2>/dev/null)"
assert_contains "$progress_json" '"type":"result"'
assert_contains "$progress_json" '"result":"STATUS: complete"'

# ---- progress log: worker exit code propagates through the pipeline ----
if FAKE_CLAUDE_EXIT=7 run_launcher --mode review --progress-log "$TEMP_DIR/fail.progress.log" \
     < <(printf 'task\n') >/dev/null 2>&1; then
  fail 'launcher unexpectedly exited zero when the worker failed'
fi
assert_contains "$(cat "$TEMP_DIR/fail.progress.log")" '[exit] worker exited code=7'

printf 'test-claude-deepseek-agent: passed\n'
