#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# test-claude-agent.sh — mocked coverage for scripts/run-claude-agent.sh.
# A fake `claude` on PATH records its cwd/argv/environment, so no token is spent
# and no network is touched. It is never the real CLI.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

fail() { printf 'test-claude-agent: %s\n' "$*" >&2; exit 1; }
contains() { [[ "$1" == *"$2"* ]] || fail "missing: $2"; }
not_contains() { [[ "$1" != *"$2"* ]] || fail "unexpected: $2"; }

# The recorded argv prints each argument as ` <value>` on one `args:` line.
# Pull out a single flag's value so the allow-list can be checked on its own,
# independently of the disallowed list that follows it.
recorded_arg() { # $1 = flag name
  local args
  args="$(sed -n 's/^args://p' "$FAKE_CLAUDE_RECORD")"
  args="${args#*<--$1> <}"
  printf '%s' "${args%%>*}"
}
readonly EXPECTED_DISALLOWED='Bash(git commit),Bash(git commit *),Bash(git add),Bash(git add *),Bash(git push),Bash(git push *),Bash(git reset *),Bash(git checkout *),Bash(git switch *),Bash(git stash *),Bash(gh),Bash(gh *)'

mkdir -p "$TEMP_DIR/bin" "$TEMP_DIR/repo with spaces/scripts"

cat > "$TEMP_DIR/bin/claude" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${FAKE_CLAUDE_RECORD:-}" ]]; then
  {
    printf 'cwd=%s\n' "$PWD"
    printf 'deepseek-env=<%s>\n' "${DEEPSEEK_AGENT_ENV_FILE:-}"
    printf 'deepseek-key=<%s>\n' "${DEEPSEEK_API_KEY:-}"
    printf 'anthropic-base=<%s>\n' "${ANTHROPIC_BASE_URL:-}"
    printf 'anthropic-token=<%s>\n' "${ANTHROPIC_AUTH_TOKEN:-}"
    printf 'anthropic-key=<%s>\n' "${ANTHROPIC_API_KEY:-}"
    printf 'args:'
    printf ' <%s>' "$@"
    printf '\n'
  } > "$FAKE_CLAUDE_RECORD"
fi
cat > "${FAKE_CLAUDE_PROMPT:?}"
if [[ " $* " == *" stream-json "* ]]; then
  printf '%s\n' '{"type":"system","subtype":"init","model":"fake-model"}'
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading context files"}]}}'
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm run build:gates"}}]}}'
fi
printf '%s\n' '{"type":"result","subtype":"success","result":"COMMIT: none","session_id":"11111111-2222-3333-4444-555555555555","num_turns":3,"duration_ms":4200}'
printf 'observed CLI activity\n' >&2
sleep "${FAKE_CLAUDE_SLEEP:-0}"
exit "${FAKE_CLAUDE_EXIT:-0}"
MOCK
chmod +x "$TEMP_DIR/bin/claude"

export PATH="$TEMP_DIR/bin:$PATH"
# The caller exports the legacy credentials the leaf must scrub.
export DEEPSEEK_AGENT_ENV_FILE="$TEMP_DIR/does-not-exist.env.agent"
export DEEPSEEK_API_KEY=test-secret
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=test-token
# ANTHROPIC_API_KEY is the CLI's own configured login and must survive.
export ANTHROPIC_API_KEY=test-api-key
export FAKE_CLAUDE_PROMPT="$TEMP_DIR/prompt"
export FAKE_CLAUDE_RECORD="$TEMP_DIR/record"

repo="$TEMP_DIR/repo with spaces"
git init -q "$repo"
git -C "$repo" config user.name test
git -C "$repo" config user.email test@example.com
cp "$SCRIPT_DIR/run-claude-agent.sh" "$SCRIPT_DIR/worker-status.sh" \
   "$SCRIPT_DIR/worker-progress-filter.jq" "$repo/scripts/"
printf 'tracked fixture\n' > "$repo/fixture.md"
git -C "$repo" add .
git -C "$repo" commit -qm 'fixture base'
canonical_repo="$(cd "$repo" && pwd -P)"
launcher="$repo/scripts/run-claude-agent.sh"

# ---- review mode: read-only flags, cwd, prompt, credential isolation ----
log="$TEMP_DIR/logs/review.progress.log"
review="$(printf 'first line\nsecond line\n' | CLAUDE_HEARTBEAT_SECONDS=1 FAKE_CLAUDE_SLEEP=2 \
  "$launcher" --mode review --worktree "$repo" --progress-log "$log" 2>"$TEMP_DIR/review.stderr")"
[[ "$review" == 'COMMIT: none' ]] || fail "expected final result text, got: $review"
record="$(cat "$FAKE_CLAUDE_RECORD")"
contains "$record" "cwd=$canonical_repo"
contains "$record" 'deepseek-env=<>'
contains "$record" 'deepseek-key=<>'
contains "$record" 'anthropic-base=<>'
contains "$record" 'anthropic-token=<>'
contains "$record" 'anthropic-key=<test-api-key>'
contains "$record" '<--permission-mode>'
contains "$record" '<plan>'
contains "$record" 'Bash(git diff)'
contains "$record" 'Bash(git log *)'
contains "$record" 'Bash(git show *)'
contains "$record" 'Bash(git status *)'
contains "$record" 'Bash(npx tsx *)'
contains "$record" 'Bash(npx eslint *)'
contains "$record" 'Bash(npx tsc *)'
# The denying specs reach the CLI in review argv too; the allow-list itself
# stays read-only (no commit-capable spec).
contains "$record" '<--disallowedTools>'
[[ "$(recorded_arg disallowedTools)" == "$EXPECTED_DISALLOWED" ]] \
  || fail "review disallowed list: $(recorded_arg disallowedTools)"
for denied in 'Bash(git commit' 'Bash(git add' 'Bash(git push' 'Bash(git reset' \
              'Bash(git checkout' 'Bash(git switch' 'Bash(git stash' 'Bash(gh'; do
  not_contains "$(recorded_arg allowedTools)" "$denied"
done
not_contains "$record" 'Edit'
not_contains "$record" 'Write'
not_contains "$record" 'bypassPermissions'
not_contains "$record" '--no-session-persistence'
contains "$(cat "$FAKE_CLAUDE_PROMPT")" $'first line\nsecond line'
contains "$(cat "$log")" '[start] provider=claude mode=review permission-mode=plan'
contains "$(cat "$log")" 'observed CLI activity'
contains "$(cat "$log")" '[heartbeat] provider=claude process-alive (not tool activity)'
contains "$(cat "$log")" '[exit] provider=claude worker exited code=0'
[[ "$(cat "$log.final.md")" == 'COMMIT: none' ]] || fail 'missing final result artifact'
[[ "$(cat "$log.session")" == '11111111-2222-3333-4444-555555555555' ]] || fail 'missing session artifact'
[[ -f "$log.ndjson" ]] || fail 'raw stream artifact was not kept'
contains "$(cat "$log.ndjson")" '"type":"result"'
contains "$("$repo/scripts/worker-status.sh" --log "$log")" 'state=verifying'

# ---- no progress log: single json result, still writing final/session ----
no_log="$(printf 'json task\n' | "$launcher" --mode review --worktree "$repo")"
[[ "$no_log" == 'COMMIT: none' ]] || fail "json path did not print the result: $no_log"
record="$(cat "$FAKE_CLAUDE_RECORD")"
contains "$record" '<--output-format> <json>'
not_contains "$record" 'stream-json'

# ---- implement mode: acceptEdits + build/test allowlist, no commit tools ----
implement_log="$TEMP_DIR/implement.progress.log"
implement="$(printf 'implement task\n' | "$launcher" --mode implement --worktree "$repo" --progress-log "$implement_log")"
[[ "$implement" == 'COMMIT: none' ]] || fail "implement did not return its result: $implement"
record="$(cat "$FAKE_CLAUDE_RECORD")"
contains "$record" '<acceptEdits>'
contains "$record" 'Bash(npm run build:gates)'
contains "$record" 'Bash(npm run build:gates *)'
contains "$record" 'Bash(npx tsx *)'
contains "$record" 'Bash(npx eslint *)'
contains "$record" 'Bash(npx tsc *)'
contains "$record" 'Bash(npm run check:i18n)'
contains "$record" 'Grep,Edit,Write'
# Implement argv carries the denying specs; the build/test allow-list contains
# no commit-capable command spec of its own.
contains "$record" '<--disallowedTools>'
[[ "$(recorded_arg disallowedTools)" == "$EXPECTED_DISALLOWED" ]] \
  || fail "implement disallowed list: $(recorded_arg disallowedTools)"
not_contains "$(recorded_arg allowedTools)" 'Bash(git'
not_contains "$(recorded_arg allowedTools)" 'Bash(gh'
not_contains "$record" 'bypassPermissions'
contains "$(cat "$FAKE_CLAUDE_PROMPT")" 'Leave all edits uncommitted'
contains "$(cat "$FAKE_CLAUDE_PROMPT")" 'COMMIT: none'
[[ -z "$(git -C "$repo" status --short)" ]] || fail 'leaf changed the repository'

# ---- --model precedence: flag, then CLAUDE_AGENT_MODEL, then CLI default ----
printf 'model task\n' | "$launcher" --mode review --worktree "$repo" --model flag-model >/dev/null
contains "$(cat "$FAKE_CLAUDE_RECORD")" '<--model> <flag-model>'
printf 'model task\n' | "$launcher" --mode review --worktree "$repo" >/dev/null
not_contains "$(cat "$FAKE_CLAUDE_RECORD")" '--model'
printf 'model task\n' | env CLAUDE_AGENT_MODEL=env-model "$launcher" --mode review --worktree "$repo" >/dev/null
contains "$(cat "$FAKE_CLAUDE_RECORD")" '<--model> <env-model>'
printf 'model task\n' | env CLAUDE_AGENT_MODEL=env-model "$launcher" --mode review --worktree "$repo" --model flag-model >/dev/null
contains "$(cat "$FAKE_CLAUDE_RECORD")" '<--model> <flag-model>'
not_contains "$(cat "$FAKE_CLAUDE_RECORD")" 'env-model'

# ---- guards ----
if printf task | "$launcher" --mode implement >/dev/null 2>&1; then fail 'missing worktree accepted'; fi
if printf ' \n' | "$launcher" --mode review --worktree "$repo" >/dev/null 2>&1; then fail 'empty prompt accepted'; fi
if printf task | "$launcher" --mode invalid >/dev/null 2>&1; then fail 'invalid mode accepted'; fi
if printf task | "$launcher" --mode review --worktree "$TEMP_DIR/bin" >/dev/null 2>&1; then fail 'non-repository accepted'; fi
if printf task | CLAUDE_HEARTBEAT_SECONDS=0 "$launcher" --mode review --worktree "$repo" >/dev/null 2>&1; then fail 'invalid heartbeat accepted'; fi
if missing="$(printf task | PATH=/usr/bin:/bin "$launcher" --mode review --worktree "$repo" 2>&1)"; then
  fail 'missing claude accepted'
fi
contains "$missing" 'claude executable was not found on PATH'

# Relative logs resolve from the caller, not from the worker directory.
cd "$TEMP_DIR"
printf 'relative task\n' | "$launcher" --mode review --worktree "$repo" --progress-log 'relative log' >/dev/null
[[ -f "$TEMP_DIR/relative log.final.md" ]] || fail 'relative final path resolved against worker cwd'
cd "$SCRIPT_DIR"

# ---- exit-code propagation ----
if printf task | FAKE_CLAUDE_EXIT=7 "$launcher" --mode review --worktree "$repo" --progress-log "$TEMP_DIR/failed.log" >/dev/null 2>&1; then
  fail 'worker failure swallowed'
else
  [[ $? == 7 ]] || fail 'worker exit changed'
fi
contains "$(cat "$TEMP_DIR/failed.log")" 'worker exited code=7'

printf 'test-claude-agent: passed\n'
