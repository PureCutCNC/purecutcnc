#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
fail() { printf 'test-codex-agent: %s\n' "$*" >&2; exit 1; }
contains() { [[ "$1" == *"$2"* ]] || fail "missing: $2"; }
mkdir -p "$TEMP_DIR/bin" "$TEMP_DIR/repo with spaces/scripts"
cat > "$TEMP_DIR/bin/codex" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'cwd=<%s>\nlegacy-env=<%s>\nlegacy-key=<%s>\n' "$PWD" "${DEEPSEEK_AGENT_ENV_FILE:-}" "${DEEPSEEK_API_KEY:-}"
printf '<%s>\n' "$@"
# Assert exact argument shape, including no forced model or sandbox bypass.
[[ $# == 8 && "$1" == exec && "$2" == -s && "$4" == -C && "$6" == -o && "$8" == - ]] || exit 99
[[ "$PWD" == "$5" ]] || exit 97
cat > "${FAKE_CODEX_PROMPT:?}"
printf 'COMMIT: none\n' > "$7"
printf 'observed CLI activity\n' >&2
if [[ -n "${FAKE_CODEX_WRITE_FILE:-}" ]]; then printf 'change\n' > "$FAKE_CODEX_WRITE_FILE"; fi
sleep "${FAKE_CODEX_SLEEP:-0}"
exit "${FAKE_CODEX_EXIT:-0}"
MOCK
chmod +x "$TEMP_DIR/bin/codex"
export PATH="$TEMP_DIR/bin:$PATH"
export DEEPSEEK_AGENT_ENV_FILE="$TEMP_DIR/does-not-exist.env.agent"
export DEEPSEEK_API_KEY=test-secret
export FAKE_CODEX_PROMPT="$TEMP_DIR/prompt"
repo="$TEMP_DIR/repo with spaces"
git init -q "$repo"
git -C "$repo" config user.name test
git -C "$repo" config user.email test@example.com
cp "$SCRIPT_DIR/dispatch-task.sh" "$SCRIPT_DIR/run-codex-agent.sh" "$SCRIPT_DIR/worker-status.sh" "$repo/scripts/"
printf 'tracked handoff contents\n' > "$repo/handoff.md"
git -C "$repo" add .
git -C "$repo" commit -qm 'fixture base'
base="$(git -C "$repo" branch --show-current)"
canonical_repo="$(cd "$repo" && pwd -P)"
launcher="$repo/scripts/run-codex-agent.sh"
log="$TEMP_DIR/logs/review.progress.log"
review="$(printf 'first line\nsecond line\n' | CODEX_HEARTBEAT_SECONDS=1 FAKE_CODEX_SLEEP=2 \
  "$launcher" --mode review --worktree "$repo" --progress-log "$log")"
contains "$review" '<read-only>'
contains "$review" "cwd=<$canonical_repo>"
contains "$review" 'legacy-env=<>'
contains "$review" 'legacy-key=<>'
contains "$(cat "$FAKE_CODEX_PROMPT")" $'first line\nsecond line'
contains "$(cat "$log")" '[start] provider=codex mode=review sandbox=read-only'
contains "$(cat "$log")" 'observed CLI activity'
contains "$(cat "$log")" '[heartbeat] provider=codex process-alive (not tool activity)'
contains "$(cat "$log")" '[exit] provider=codex worker exited code=0'
[[ "$(cat "$log.final.md")" == 'COMMIT: none' ]] || fail 'missing final message'
contains "$("$repo/scripts/worker-status.sh" --log "$log")" 'state=verifying'
implement="$(printf 'implement task\n' | "$launcher" --mode implement --worktree "$repo" --progress-log "$TEMP_DIR/implement.log")"
contains "$implement" '<workspace-write>'
contains "$(cat "$FAKE_CODEX_PROMPT")" 'Leave all edits uncommitted; do not stage or commit.'
contains "$(cat "$FAKE_CODEX_PROMPT")" 'COMMIT: none'
[[ -z "$(git -C "$repo" status --short)" ]] || fail 'leaf changed repository'
if printf task | "$launcher" --mode implement >/dev/null 2>&1; then fail 'missing worktree accepted'; fi
if printf ' \n' | "$launcher" --mode review --worktree "$repo" >/dev/null 2>&1; then fail 'empty prompt accepted'; fi
if printf task | "$launcher" --mode invalid >/dev/null 2>&1; then fail 'invalid mode accepted'; fi
if printf task | "$launcher" --mode review --worktree "$TEMP_DIR/bin" >/dev/null 2>&1; then fail 'non-repository accepted'; fi
if printf task | CODEX_HEARTBEAT_SECONDS=0 "$launcher" --mode review --worktree "$repo" >/dev/null 2>&1; then fail 'invalid heartbeat accepted'; fi
if missing="$(printf task | PATH=/usr/bin:/bin "$launcher" --mode review --worktree "$repo" 2>&1)"; then
  fail 'missing codex accepted'
fi
contains "$missing" 'codex executable was not found on PATH'
# Relative logs are resolved from the caller, not from the worker directory.
relative="$(cd "$TEMP_DIR" && printf task | "$launcher" --mode review --worktree "$repo" --progress-log 'relative log')"
[[ -f "$TEMP_DIR/relative log.final.md" ]] || fail 'relative final path resolved against worker cwd'
if printf task | FAKE_CODEX_EXIT=7 "$launcher" --mode review --worktree "$repo" --progress-log "$TEMP_DIR/failed.log" >/dev/null; then
  fail 'worker failure swallowed'
else
  [[ $? == 7 ]] || fail 'worker exit changed'
fi
contains "$(cat "$TEMP_DIR/failed.log")" 'worker exited code=7'

# Dispatch review uses the handoff bootstrap and keeps its contents out of argv.
review="$(printf 'review slice\n' | "$repo/scripts/dispatch-task.sh" --provider codex \
  --mode review --worktree "$repo" --handoff handoff.md --progress-log "$TEMP_DIR/dispatch-review.log")"
contains "$(cat "$FAKE_CODEX_PROMPT")" 'Read the complete task handoff at handoff.md'
[[ "$review" != *'tracked handoff contents'* ]] || fail 'handoff leaked into argv'
contains "$("$repo/scripts/worker-status.sh" --log "$TEMP_DIR/dispatch-review.log")" 'state=done'

# One manager commit only for a successful worker with changes.
export PURECUT_WORKTREE_BASE="$TEMP_DIR/worktrees"
for scenario in success clean failure; do
  write_file=""; worker_exit=0
  [[ "$scenario" != success ]] || write_file=changed.txt
  if [[ "$scenario" == failure ]]; then write_file=failed.txt; worker_exit=9; fi
  output="$(printf implement | FAKE_CODEX_WRITE_FILE="$write_file" FAKE_CODEX_EXIT="$worker_exit" \
    "$repo/scripts/dispatch-task.sh" --provider codex --issue 1017 --task-slug "$scenario" --base "$base" --skip-build)"
  wt="$PURECUT_WORKTREE_BASE/$scenario"
  contains "$output" 'commit owner: manager'
  contains "$output" "worker exit:  $worker_exit"
  contains "$("$repo/scripts/worker-status.sh" --slug "$scenario")" 'state=done'
  [[ -f "$PURECUT_WORKTREE_BASE/$scenario.progress.log.final.md" ]] || fail 'missing dispatch final'
  count="$(git -C "$wt" rev-list --count "$base"..HEAD)"
  case "$scenario" in
    success)
      [[ "$count" == 1 ]] || fail 'successful worker did not produce one manager commit'
      [[ -z "$(git -C "$wt" status --short)" ]] || fail 'successful changes uncommitted'
      contains "$(git -C "$wt" log -1 --format=%s)" 'codex worker changes for issue #1017'
      ;;
    clean) [[ "$count" == 0 ]] || fail 'no-change run committed'; contains "$output" 'not-needed (clean worktree)' ;;
    failure)
      [[ "$count" == 0 ]] || fail 'failed run committed'
      contains "$output" 'not-attempted (worker failed)'
      [[ -f "$wt/failed.txt" ]] || fail 'failed edits removed'
      ;;
  esac
done

# #637: invoking from a worktree still creates an external sibling worktree.
outside="$(printf implement | env -u PURECUT_WORKTREE_BASE \
  "$TEMP_DIR/worktrees/success/scripts/dispatch-task.sh" --provider codex --issue 1017 \
  --task-slug sibling --base "$base" --skip-build)"
[[ -d "$TEMP_DIR/worktrees/repo with spaces/sibling" ]] || fail 'worktree copy used wrong default base'
if printf implement | PURECUT_WORKTREE_BASE="$repo/nested" "$repo/scripts/dispatch-task.sh" \
  --provider codex --issue 1017 --task-slug rejected --base "$base" --skip-build > "$TEMP_DIR/rejected" 2>&1; then
  fail 'nested worktree base accepted'
fi
contains "$(cat "$TEMP_DIR/rejected")" 'refusing to create a worktree inside a checkout'
[[ ! -e "$repo/nested" ]] || fail 'nested base created before refusal'
printf 'test-codex-agent: passed\n'
