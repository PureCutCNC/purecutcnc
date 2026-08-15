# SPDX-License-Identifier: Apache-2.0
#
# dsh-progress-filter.jq — distill DSH session JSONL records into observed,
# one-line manager-progress events. run-dsh-agent.sh repeatedly decodes DSH's
# growing session artifact and de-duplicates records by sequence number.
#
# Output is: sequence<TAB>event-kind<TAB>normalized-payload

def one_line:
  tostring | gsub("[\r\n\t]+"; " ") | gsub(" +"; " ");

def excerpt($limit):
  if length > $limit then .[0:($limit - 1)] + "…" else . end;

def assistant_text:
  [.data.message.content[]? | select(.type == "text") | .text // empty]
  | join(" ")
  | one_line;

def tool_result_text:
  [.data.message.content[]?
   | select(.type == "tool-result")
   | .content[]?
   | select(.type == "text")
   | .text // empty]
  | join(" ")
  | one_line;

inputs
| fromjson? // empty
| select(type == "object" and (.seq | type == "number"))
| if .type == "assistant/message" then
    assistant_text as $text
    | select($text != "")
    | [.seq, "assistant", $text] | @tsv
  elif .type == "tool/call" then
    [ .seq,
      "tool",
      (((.data.name // "unknown") + " " + (.data.arguments // "")) | one_line)
    ] | @tsv
  elif .type == "tool/result" then
    tool_result_text as $text
    | select($text != "")
    | [.seq, "tool-result", ($text | excerpt($tool_result_max_chars))] | @tsv
  else
    empty
  end
