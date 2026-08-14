#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LAUNCHER="$SCRIPT_DIR/run-dsh-agent.sh"
readonly TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

fail() {
  printf 'test-dsh-agent: %s\n' "$*" >&2
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
cat > "$TEMP_DIR/bin/dsh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'cwd=<%s>\n' "$PWD"
printf 'sandbox=<%s>\n' "${DSH_PERMISSION_MODE:-}"
printf 'legacy-env=<%s>\n' "${DEEPSEEK_AGENT_ENV_FILE:-}"
printf 'legacy-key=<%s>\n' "${DEEPSEEK_API_KEY:-}"
printf 'args:\n'
printf '<%s>\n' "$@"
sleep "${FAKE_DSH_SLEEP_SECONDS:-0}"
exit "${FAKE_DSH_EXIT:-0}"
EOF
chmod +x "$TEMP_DIR/bin/dsh"

git init -q "$TEMP_DIR/wt"

run_launcher() {
  PATH="$TEMP_DIR/bin:$PATH" \
    DEEPSEEK_AGENT_ENV_FILE=/private/secret/.env.agent \
    DEEPSEEK_API_KEY=test-secret \
    "$LAUNCHER" "$@"
}

# ---- review mode: readonly sandbox, cwd, prompt argv, no legacy credential env ----
review_output="$(printf 'first line\nsecond line\n' | run_launcher --mode review --worktree "$TEMP_DIR/wt")"
assert_contains "$review_output" "cwd=<$TEMP_DIR/wt>"
assert_contains "$review_output" 'sandbox=<read-only>'
assert_contains "$review_output" '<--profile>'
assert_contains "$review_output" '<headless>'
assert_contains "$review_output" 'first line'
assert_contains "$review_output" 'second line'
assert_contains "$review_output" 'legacy-env=<>'
assert_contains "$review_output" 'legacy-key=<>'
assert_not_contains "$review_output" 'test-secret'

# ---- implementation guard and workspace-write sandbox ----
if implement_error="$(printf 'implement task\n' | run_launcher --mode implement 2>&1)"; then
  fail 'implementation mode unexpectedly ran without --worktree'
fi
assert_contains "$implement_error" '--mode implement requires --worktree'

implement_output="$(printf 'implement task\n' | run_launcher --mode implement --worktree "$TEMP_DIR/wt")"
assert_contains "$implement_output" 'sandbox=<workspace-write>'

# ---- missing dsh fails clearly ----
if missing_dsh_error="$(printf 'review\n' | PATH=/usr/bin:/bin "$LAUNCHER" --mode review --worktree "$TEMP_DIR/wt" 2>&1)"; then
  fail 'launcher unexpectedly ran without dsh on PATH'
fi
assert_contains "$missing_dsh_error" 'dsh executable was not found on PATH'

# ---- lifecycle log identifies a process heartbeat as non-tool activity ----
progress_log="$TEMP_DIR/slice.progress.log"
printf 'task\n' | DSH_HEARTBEAT_SECONDS=1 FAKE_DSH_SLEEP_SECONDS=2 \
  run_launcher --mode review --worktree "$TEMP_DIR/wt" \
  --progress-log "$progress_log" >/dev/null
progress_content="$(cat "$progress_log")"
assert_contains "$progress_content" '[start] provider=dsh mode=review sandbox=read-only'
assert_contains "$progress_content" '[heartbeat] provider=dsh process-alive (not tool activity)'
assert_contains "$progress_content" '[exit] provider=dsh worker exited code=0'

# ---- worker failure propagates ----
if FAKE_DSH_EXIT=7 run_launcher --mode review --worktree "$TEMP_DIR/wt" \
     < <(printf 'task\n') >/dev/null 2>&1; then
  fail 'launcher unexpectedly exited zero when dsh failed'
fi

printf 'test-dsh-agent: passed\n'
