# SPDX-License-Identifier: Apache-2.0
#
# worker-progress-filter.jq — distill `claude --output-format stream-json`
# events (one JSON object per line on stdin) into short, timestamped,
# one-line progress entries for the dispatch progress log.
#
# Used by run-claude-deepseek-agent.sh --progress-log; kept as a standalone
# file so it can be tested and tuned without touching the launcher.
#
# Invoke as: jq -nRr --unbuffered -f worker-progress-filter.jq
#
# Line vocabulary (worker-status.sh and the manager skill key off these tags):
#   [init]  session started, resolved model
#   [note]  assistant text — the worker narrating what it is doing
#   [think] extended-thinking excerpt (reasoning models)
#   [tool]  a tool call observed by the harness — the reliable liveness signal
#   [gen]   heartbeat during a long uninterrupted generation turn
#   [done]  final result event (subtype, turn count, duration)

def ts: now | todate;
def clip: tostring | gsub("\\s+"; " ") | .[0:160];

foreach (inputs | fromjson? // empty | select(type == "object")) as $e (
  0;
  # State: consecutive stream_event chunks since the last full event, so a
  # long generation turn with no tool calls still heartbeats periodically.
  if $e.type == "stream_event" then . + 1 else 0 end;
  . as $chunks
  | (if $e.type == "system" and $e.subtype == "init" then
       "[init] model=\($e.model // "?")"
     elif $e.type == "assistant" then
       (($e.message.content // [])[]
        | if .type == "tool_use" then
            "[tool] \(.name) \((.input.file_path // .input.command // .input.pattern // .input.description // "") | clip)"
          elif .type == "text" and ((.text // "") | length) > 0 then
            "[note] \(.text | clip)"
          elif .type == "thinking" and ((.thinking // "") | length) > 0 then
            "[think] \(.thinking | clip)"
          else
            empty
          end)
     elif $e.type == "result" then
       "[done] \($e.subtype // "?") turns=\($e.num_turns // "?") duration=\((($e.duration_ms // 0) / 1000) | floor)s"
     elif $e.type == "stream_event" and ($chunks % 250 == 0) then
       "[gen] model is generating (long turn in progress)"
     else
       empty
     end)
  | "\(ts) \(.)"
)
