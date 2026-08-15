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
if [[ "${FAKE_DSH_STREAM_EVENTS:-}" == true ]]; then
  session_path="${PWD#/}"
  session_slug="--${session_path//\//-}--"
  session_root="$HOME/.dsh/sessions/$session_slug"
  stream_id="${RANDOM}${RANDOM}"
  mkdir -p "$session_root/session-stream-$stream_id"
  cat > "$session_root/session-stream-$stream_id/session.jsonl.zstd" <<'JSON'
{"type":"assistant/message","seq":10,"data":{"message":{"content":[{"type":"reasoning","text":"internal reasoning must stay hidden"},{"type":"text","text":"Reading project context\nnow"}]}}}
JSON
  sleep 1
  cat >> "$session_root/session-stream-$stream_id/session.jsonl.zstd" <<'JSON'
{"type":"tool/call","seq":11,"data":{"name":"read_file","arguments":"{\"path\":\"INDEX.md\"}"}}
JSON
  sleep 1
  cat >> "$session_root/session-stream-$stream_id/session.jsonl.zstd" <<'JSON'
{"type":"tool/result","seq":12,"data":{"message":{"content":[{"type":"tool-result","content":[{"type":"text","text":"# INDEX\nScripts overview"}]}]}}}
JSON
  sleep 1
  if [[ "${FAKE_DSH_FINAL_EVENT:-}" == true ]]; then
    cat >> "$session_root/session-stream-$stream_id/session.jsonl.zstd" <<'JSON'
{"type":"assistant/message","seq":13,"data":{"message":{"content":[{"type":"text","text":"Final worker response"}]}}}
JSON
  fi
fi
if [[ "${FAKE_DSH_AMBIGUOUS:-}" == true ]]; then
  session_path="${PWD#/}"
  session_slug="--${session_path//\//-}--"
  session_root="$HOME/.dsh/sessions/$session_slug"
  ambiguous_id="${RANDOM}${RANDOM}"
  mkdir -p "$session_root/session-ambiguous-a-$ambiguous_id" "$session_root/session-ambiguous-b-$ambiguous_id"
  printf '%s\n' '{"type":"tool/call","seq":10,"data":{"name":"wrong","arguments":"{}"}}' \
    > "$session_root/session-ambiguous-a-$ambiguous_id/session.jsonl.zstd"
  printf '%s\n' '{"type":"tool/call","seq":11,"data":{"name":"wrong","arguments":"{}"}}' \
    > "$session_root/session-ambiguous-b-$ambiguous_id/session.jsonl.zstd"
  sleep 2
fi
sleep "${FAKE_DSH_SLEEP_SECONDS:-0}"
exit "${FAKE_DSH_EXIT:-0}"
EOF
cat > "$TEMP_DIR/bin/zstd" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "-dc" ]] || exit 2
[[ "${FAKE_ZSTD_FAIL:-}" != true ]] || exit 1
if [[ "${FAKE_ZSTD_FAIL_ONCE:-}" == true && ! -f "${FAKE_ZSTD_FAIL_ONCE_STATE:?}" ]]; then
  touch "$FAKE_ZSTD_FAIL_ONCE_STATE"
  exit 1
fi
if [[ -n "${FAKE_ZSTD_INPUT_LOG:-}" ]]; then
  cat "$2" >> "$FAKE_ZSTD_INPUT_LOG"
  printf '%s\n' '-- zstd input boundary --' >> "$FAKE_ZSTD_INPUT_LOG"
fi
cat "$2"
EOF
chmod +x "$TEMP_DIR/bin/dsh"
chmod +x "$TEMP_DIR/bin/zstd"

git init -q "$TEMP_DIR/wt"
canonical_wt="$(cd "$TEMP_DIR/wt" && pwd -P)"

run_launcher() {
  PATH="$TEMP_DIR/bin:$PATH" \
    HOME="$TEMP_DIR/home" \
    DEEPSEEK_AGENT_ENV_FILE=/private/secret/.env.agent \
    DEEPSEEK_API_KEY=test-secret \
    "$LAUNCHER" "$@"
}

# ---- review mode: readonly sandbox, cwd, prompt argv, no legacy credential env ----
review_output="$(printf 'first line\nsecond line\n' | run_launcher --mode review --worktree "$TEMP_DIR/wt")"
assert_contains "$review_output" "cwd=<$canonical_wt>"
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

# ---- session artifacts stream observed text, tool calls, and tool results ----
stream_progress_log="$TEMP_DIR/stream.progress.log"
stream_input_log="$TEMP_DIR/stream.zstd-input.log"
printf 'task\n' | DSH_HEARTBEAT_SECONDS=1 FAKE_DSH_STREAM_EVENTS=true \
  FAKE_ZSTD_INPUT_LOG="$stream_input_log" \
  run_launcher --mode review --worktree "$TEMP_DIR/wt" \
  --progress-log "$stream_progress_log" >/dev/null
stream_progress_content="$(cat "$stream_progress_log")"
assert_contains "$stream_progress_content" '[assistant] provider=dsh Reading project context now'
assert_contains "$stream_progress_content" '[tool] provider=dsh read_file {"path":"INDEX.md"}'
assert_contains "$stream_progress_content" '[tool-result] provider=dsh # INDEX Scripts overview'
assert_not_contains "$stream_progress_content" 'internal reasoning must stay hidden'
[[ "$(grep -F -c '[tool] provider=dsh read_file' "$stream_progress_log")" -eq 1 ]] \
  || fail 'repeated session decodes duplicated the tool event'
[[ "$(grep -F -c '"seq":10' "$stream_input_log")" -eq 1 ]] \
  || fail 'incremental tail re-decoded the first session record'

# ---- a failed segment decode retries from the same cursor ----
retry_progress_log="$TEMP_DIR/retry.progress.log"
retry_state_file="$TEMP_DIR/zstd-failed-once"
printf 'task\n' | DSH_HEARTBEAT_SECONDS=1 FAKE_DSH_STREAM_EVENTS=true \
  FAKE_ZSTD_FAIL_ONCE=true FAKE_ZSTD_FAIL_ONCE_STATE="$retry_state_file" \
  run_launcher --mode review --worktree "$TEMP_DIR/wt" \
  --progress-log "$retry_progress_log" >/dev/null
retry_progress_content="$(cat "$retry_progress_log")"
[[ -f "$retry_state_file" ]] || fail 'the injected decode failure did not run'
assert_contains "$retry_progress_content" '[assistant] provider=dsh Reading project context now'

# ---- the post-exit drain captures an event written immediately before exit ----
final_progress_log="$TEMP_DIR/final.progress.log"
printf 'task\n' | DSH_HEARTBEAT_SECONDS=1 FAKE_DSH_STREAM_EVENTS=true FAKE_DSH_FINAL_EVENT=true \
  run_launcher --mode review --worktree "$TEMP_DIR/wt" \
  --progress-log "$final_progress_log" >/dev/null
final_progress_content="$(cat "$final_progress_log")"
assert_contains "$final_progress_content" '[assistant] provider=dsh Final worker response'

# ---- ambiguous artifacts retain heartbeat-only fallback ----
ambiguous_progress_log="$TEMP_DIR/ambiguous.progress.log"
printf 'task\n' | DSH_HEARTBEAT_SECONDS=1 FAKE_DSH_AMBIGUOUS=true \
  run_launcher --mode review --worktree "$TEMP_DIR/wt" \
  --progress-log "$ambiguous_progress_log" >/dev/null
ambiguous_progress_content="$(cat "$ambiguous_progress_log")"
assert_contains "$ambiguous_progress_content" '[tail] provider=dsh session-attribution=ambiguous; using heartbeats'
assert_contains "$ambiguous_progress_content" '[heartbeat] provider=dsh process-alive (not tool activity)'
assert_not_contains "$ambiguous_progress_content" '[tool] provider=dsh wrong'

# ---- unreadable artifacts and bounded rendering retain safe behavior ----
unreadable_progress_log="$TEMP_DIR/unreadable.progress.log"
printf 'task\n' | DSH_HEARTBEAT_SECONDS=1 FAKE_DSH_STREAM_EVENTS=true FAKE_ZSTD_FAIL=true \
  run_launcher --mode review --worktree "$TEMP_DIR/wt" \
  --progress-log "$unreadable_progress_log" >/dev/null
unreadable_progress_content="$(cat "$unreadable_progress_log")"
assert_contains "$unreadable_progress_content" '[heartbeat] provider=dsh process-alive (not tool activity)'
assert_not_contains "$unreadable_progress_content" '[assistant] provider=dsh'

bounded_progress_log="$TEMP_DIR/bounded.progress.log"
printf 'task\n' | DSH_TOOL_RESULT_MAX_CHARS=1 FAKE_DSH_STREAM_EVENTS=true \
  run_launcher --mode review --worktree "$TEMP_DIR/wt" \
  --progress-log "$bounded_progress_log" >/dev/null
bounded_progress_content="$(cat "$bounded_progress_log")"
assert_contains "$bounded_progress_content" '[tool-result] provider=dsh …'
assert_contains "$bounded_progress_content" '[assistant] provider=dsh Reading project context now'

# ---- filter discards emitted sequences and bounds before whitespace cleanup ----
filter_input="$(jq -cn \
  --arg oversized_text "start$(printf '%*s' 10000 '')end" \
  '[
    {type: "assistant/message", seq: 14, data: {message: {content: [{type: "text", text: "already emitted"}]}}},
    {type: "assistant/message", seq: 15, data: {message: {content: [{type: "text", text: $oversized_text}]}}}
  ][]')"
filter_output="$(printf '%s\n' "$filter_input" \
  | jq -nRr --argjson event_max_chars 32 --argjson tool_result_max_chars 16 --argjson last_event_seq 14 \
    -f "$SCRIPT_DIR/dsh-progress-filter.jq")"
assert_not_contains "$filter_output" 'already emitted'
assert_contains "$filter_output" $'15\tassistant\tstart …'

# ---- worker failure propagates ----
if FAKE_DSH_EXIT=7 run_launcher --mode review --worktree "$TEMP_DIR/wt" \
     < <(printf 'task\n') >/dev/null 2>&1; then
  fail 'launcher unexpectedly exited zero when dsh failed'
fi

printf 'test-dsh-agent: passed\n'
