#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DISPATCH="$SCRIPT_DIR/dispatch-task.sh"
readonly TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

fail() {
  printf 'test-dispatch-task: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" == *"$needle"* ]] || fail "expected output to contain: $needle"
}

mkdir -p "$TEMP_DIR/bin"
cat > "$TEMP_DIR/bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'provider=claude\n'
printf 'args:\n'
printf '<%s>\n' "$@"
cat
EOF
cat > "$TEMP_DIR/bin/dsh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'provider=dsh sandbox=<%s>\n' "${DSH_PERMISSION_MODE:-}"
printf 'args:\n'
printf '<%s>\n' "$@"
EOF
chmod +x "$TEMP_DIR/bin/claude" "$TEMP_DIR/bin/dsh"

cat > "$TEMP_DIR/agent.env" <<'EOF'
DEEPSEEK_API_KEY=test-secret
EOF
chmod 600 "$TEMP_DIR/agent.env"
git init -q "$TEMP_DIR/wt"
mkdir -p "$TEMP_DIR/wt/handoffs"
cat > "$TEMP_DIR/wt/handoffs/slice.md" <<'EOF'
This is the complete tracked handoff. It must not be included in the provider command.
EOF
git -C "$TEMP_DIR/wt" add handoffs/slice.md
git -C "$TEMP_DIR/wt" -c user.name=test -c user.email=test@example.com \
  commit -qm 'add handoff fixture'

# ---- omitted provider preserves the Claude/DeepSeek dispatch path ----
claude_output="$(printf 'default task\n' | PATH="$TEMP_DIR/bin:$PATH" \
  DEEPSEEK_AGENT_ENV_FILE="$TEMP_DIR/agent.env" "$DISPATCH" --mode review --worktree "$TEMP_DIR/wt")"
assert_contains "$claude_output" 'provider=claude'
assert_contains "$claude_output" '<--permission-mode>'
assert_contains "$claude_output" '<plan>'
assert_contains "$claude_output" 'default task'

# ---- explicit DSH provider selects the DSH leaf and read-only mode ----
dsh_output="$(printf 'dsh task\n' | PATH="$TEMP_DIR/bin:$PATH" \
  DEEPSEEK_AGENT_ENV_FILE="$TEMP_DIR/agent.env" "$DISPATCH" \
    --provider dsh --mode review --worktree "$TEMP_DIR/wt")"
assert_contains "$dsh_output" 'provider=dsh sandbox=<read-only>'
assert_contains "$dsh_output" '<--profile>'
assert_contains "$dsh_output" '<headless>'
assert_contains "$dsh_output" 'dsh task'

# ---- optional handoff is provider-neutral and keeps its contents out of argv ----
dsh_handoff_output="$(printf 'review the assigned slice\n' | PATH="$TEMP_DIR/bin:$PATH" \
  DEEPSEEK_AGENT_ENV_FILE="$TEMP_DIR/agent.env" "$DISPATCH" \
    --provider dsh --mode review --worktree "$TEMP_DIR/wt" --handoff handoffs/slice.md)"
assert_contains "$dsh_handoff_output" 'Read the complete task handoff at handoffs/slice.md in the current worktree.'
assert_contains "$dsh_handoff_output" 'Short manager instruction:'
assert_contains "$dsh_handoff_output" 'review the assigned slice'
assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" != *"$needle"* ]] || fail "expected output not to contain: $needle"
}
assert_not_contains "$dsh_handoff_output" 'This is the complete tracked handoff.'

claude_handoff_output="$(printf 'review the assigned slice\n' | PATH="$TEMP_DIR/bin:$PATH" \
  DEEPSEEK_AGENT_ENV_FILE="$TEMP_DIR/agent.env" "$DISPATCH" \
    --mode review --worktree "$TEMP_DIR/wt" --handoff handoffs/slice.md)"
assert_contains "$claude_handoff_output" 'Read the complete task handoff at handoffs/slice.md in the current worktree.'
assert_not_contains "$claude_handoff_output" 'This is the complete tracked handoff.'

if untracked_handoff_error="$(printf 'brief\n' | "$DISPATCH" --provider dsh --mode review \
  --worktree "$TEMP_DIR/wt" --handoff handoffs/missing.md 2>&1)"; then
  fail 'dispatch unexpectedly accepted an untracked handoff'
fi
assert_contains "$untracked_handoff_error" '--handoff must name a tracked file'

if absolute_handoff_error="$(printf 'brief\n' | "$DISPATCH" --provider dsh --mode review \
  --worktree "$TEMP_DIR/wt" --handoff /private/secret.md 2>&1)"; then
  fail 'dispatch unexpectedly accepted an absolute handoff'
fi
assert_contains "$absolute_handoff_error" '--handoff must be a relative repository path'

oversized_brief="$(printf '%*s' 4097 '' | tr ' ' x)"
if oversized_prompt_error="$(printf '%s' "$oversized_brief" | "$DISPATCH" --provider dsh --mode review \
  --worktree "$TEMP_DIR/wt" 2>&1)"; then
  fail 'dispatch unexpectedly accepted an oversized direct instruction'
fi
assert_contains "$oversized_prompt_error" 'use --handoff REPO_PATH'

if invalid_provider_error="$(printf 'task\n' | "$DISPATCH" --provider invalid --mode review --worktree "$TEMP_DIR/wt" 2>&1)"; then
  fail 'dispatch unexpectedly accepted an invalid provider'
fi
assert_contains "$invalid_provider_error" '--provider must be claude-deepseek or dsh'

printf 'test-dispatch-task: passed\n'
