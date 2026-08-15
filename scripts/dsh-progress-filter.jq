# SPDX-License-Identifier: Apache-2.0
#
# dsh-progress-filter.jq — distill DSH session JSONL records into observed,
# one-line manager-progress events. run-dsh-agent.sh decodes newly appended
# zstd frames and de-duplicates records by sequence number as a safety net.
#
# Output is: sequence<TAB>event-kind<TAB>normalized-payload

def excerpt($limit):
  if length > $limit then .[0:($limit - 1)] + "…" else . end;

def one_line($limit):
  tostring
  | excerpt($limit)
  | gsub("[\r\n\t]+"; " ")
  | gsub(" +"; " ");

def assistant_text:
  [.data.message.content[]? | select(.type == "text") | .text // empty]
  | join(" ")
  | one_line($event_max_chars);

def tool_result_text:
  [.data.message.content[]?
   | select(.type == "tool-result")
   | .content[]?
   | select(.type == "text")
   | .text // empty]
  | join(" ")
  | one_line($tool_result_max_chars);

inputs
| fromjson? // empty
| select(type == "object" and (.seq | type == "number"))
| select(.seq > $last_event_seq)
| if .type == "assistant/message" then
    assistant_text as $text
    | select($text != "")
    | [.seq, "assistant", $text] | @tsv
  elif .type == "tool/call" then
    [ .seq,
      "tool",
      (((.data.name // "unknown") + " " + (.data.arguments // "")) | one_line($event_max_chars))
    ] | @tsv
  elif .type == "tool/result" then
    tool_result_text as $text
    | select($text != "")
    | [.seq, "tool-result", $text] | @tsv
  else
    empty
  end
