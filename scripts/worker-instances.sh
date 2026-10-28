#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# worker-instances.sh — list the dispatch workers running on this machine,
# across every provider `dispatch-task.sh` supports (dsh, claude,
# claude-deepseek, codex), and optionally tail their progress logs.
#
# A dispatch worker is one live process that dispatch-task.sh (or a manager
# session) started to do a slice:
#   - a provider leaf (`run-<provider>-agent.sh`), which carries provider, mode,
#     worktree and progress log in its arguments;
#   - a raw provider CLI not covered by a leaf (`dsh --profile headless`,
#     `codex exec`, `claude -p`), which is how ad-hoc review runs happen;
#   - `dispatch-task.sh` itself during the post-worker build gate, when the
#     worker process is already gone.
#
# Liveness always comes from the process table. A progress log without a final
# `[dispatch] done` line is not proof that a worker is running — a dead worker
# stops writing too — so never infer "running" from a log alone.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The repository is the primary checkout, not the worktree this copy may live
# in — every task worktree carries its own scripts/ (see issue #637).
if repo_common_dir="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
  readonly REPO_ROOT="$(dirname "$repo_common_dir")"
else
  readonly REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
WORKTREE_BASE="${PURECUT_WORKTREE_BASE:-$(dirname "$REPO_ROOT")/worktrees/$(basename "$REPO_ROOT")}"
readonly NOW="$(date +%s)"

usage() {
  cat <<'EOF'
Usage: scripts/worker-instances.sh [options]

List every live dispatch worker with its provider, mode, worktree slug,
dispatch phase, idle time, and branch. One row per provider+worktree.

Options:
  --logs [N]        Also print the last N progress-log lines per worker
                    (default 20).
  --follow          Keep tailing those logs after printing (implies --logs).
  --provider NAME   Only show one provider: dsh, claude, claude-deepseek,
                    codex, or claude-app (app sessions; needs --all).
  --slug SLUG       Only show the worker for one dispatch slug / worktree.
  --pid PID         Only show the worker with this process id.
  --log TARGET      Print the progress log for TARGET (a slug, a live PID, or
                    a path). A PID resolves through its launch arguments or
                    working directory, so it only works while the process is
                    alive; a slug or path also works for a finished run.
                    Combine with --logs N / --follow.
  --all             Also show provider processes that are not dispatch workers:
                    dsh profiles other than headless (web, tui) and Claude.app
                    chat sessions. Both are hidden by default because they stay
                    alive long after their work is done.
  --help            Show this help.

Examples:
  scripts/worker-instances.sh                     # who is running, and how idle
  scripts/worker-instances.sh --logs              # ... plus the last 20 lines
  scripts/worker-instances.sh --provider codex    # only Codex workers
  scripts/worker-instances.sh --pid 44132 --logs 50
  scripts/worker-instances.sh --follow            # follow all live logs
  scripts/worker-instances.sh --log rotary-c2-square-window-dsh

Progress-log phases: [start], [assistant], [tool], [heartbeat], [build],
[commit], [exit], [dispatch] done. A heartbeat means the process is alive, not
that tools are still producing output; judge staleness by the last marker.
EOF
}

fail() { printf 'worker-instances: %s\n' "$*" >&2; exit 1; }

show_logs=0
log_lines=20
follow=0
provider_filter=""
slug_filter=""
pid_filter=""
log_target=""
include_all=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --logs)
      show_logs=1
      if [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]]; then
        log_lines="$2"
        shift 2
      else
        shift
      fi
      ;;
    --logs=*)
      show_logs=1
      log_lines="${1#*=}"
      [[ "$log_lines" =~ ^[0-9]+$ ]] || fail "--logs= requires a number"
      shift
      ;;
    --follow)
      follow=1
      show_logs=1
      shift
      ;;
    --provider)
      [[ $# -ge 2 ]] || fail "--provider requires a value"
      provider_filter="$2"
      shift 2
      ;;
    --slug)
      [[ $# -ge 2 ]] || fail "--slug requires a value"
      slug_filter="$2"
      shift 2
      ;;
    --pid)
      [[ $# -ge 2 ]] || fail "--pid requires a value"
      pid_filter="$2"
      shift 2
      ;;
    --log)
      [[ $# -ge 2 ]] || fail "--log requires a slug, PID, or path"
      log_target="$2"
      shift 2
      ;;
    --all)
      include_all=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1 (see --help)"
      ;;
  esac
done

case "$provider_filter" in
  ""|dsh|claude|claude-deepseek|claude-app|codex) ;;
  *) fail "--provider must be one of: dsh, claude, claude-deepseek, codex, claude-app" ;;
esac
[[ "$log_lines" =~ ^[0-9]+$ ]] || fail "--logs value must be a number"
[[ -z "$pid_filter" || "$pid_filter" =~ ^[0-9]+$ ]] || fail "--pid requires a numeric process id"

# Everything below reads from a snapshot of the process table, so a worker that
# exits mid-run cannot make two phases disagree about it.
listing="$(mktemp "${TMPDIR:-/tmp}/worker-instances.XXXXXX")" || fail "cannot create a temporary file"
records="$(mktemp "${TMPDIR:-/tmp}/worker-instances-records.XXXXXX")" || fail "cannot create a temporary file"
leaves_file="$(mktemp "${TMPDIR:-/tmp}/worker-instances-leaves.XXXXXX")" || fail "cannot create a temporary file"
raw_file="$(mktemp "${TMPDIR:-/tmp}/worker-instances-raw.XXXXXX")" || fail "cannot create a temporary file"
dispatch_file="$(mktemp "${TMPDIR:-/tmp}/worker-instances-dispatch.XXXXXX")" || fail "cannot create a temporary file"
apps_file="$(mktemp "${TMPDIR:-/tmp}/worker-instances-apps.XXXXXX")" || fail "cannot create a temporary file"
cleanup() { rm -f "$listing" "$records" "$leaves_file" "$raw_file" "$dispatch_file" "$apps_file"; }
trap cleanup EXIT

patterns=(
  'run-[a-z-]*-agent\.sh'
  'dispatch-task\.sh'
  'codex exec'
  'claude -p'
  'MacOS/claude'
  'dsh --profile'
)
: >"$listing"
for pattern in "${patterns[@]}"; do
  pgrep -fl "$pattern" >>"$listing" 2>/dev/null || true
done
# One record per PID: "PID<TAB>first command line". Continuation lines (a
# pasted prompt) are dropped on purpose; every flag this script needs is on the
# first line.
awk '/^[0-9]+ /{pid=$1; if (pid in seen) next; seen[pid]=1; sub(/^[0-9]+ /,""); print pid "\t" $0}' \
  "$listing" >"$records"

# Parse a progress-log UTC timestamp; GNU date and BSD date disagree, so try
# both. Echoes nothing on failure.
epoch_from_iso() {
  date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null \
    || date -u -d "$1" +%s 2>/dev/null \
    || true
}

human_age() {
  local s="$1"
  if (( s < 0 )); then s=0; fi
  if (( s < 60 )); then printf '%ss' "$s"
  elif (( s < 3600 )); then printf '%dm' "$((s / 60))"
  elif (( s < 86400 )); then printf '%dh' "$((s / 3600))"
  else printf '%dd' "$((s / 86400))"
  fi
}

# Value of `flag` in a command line, or empty. Paths and flags in this repo have
# no embedded spaces, so word splitting is safe here.
flag_value() {
  local flag="$1" cmd="$2" prev="" word
  for word in $cmd; do
    if [[ "$prev" == "$flag" ]]; then
      printf '%s' "$word"
      return 0
    fi
    prev="$word"
  done
  return 1
}

cwd_for_pid() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true
}

# True when a leaf is an ancestor of PID: the leaf row already represents that
# worker, so the raw CLI child must not add a second row.
pid_is_leaf_descendant() {
  case " $leaf_descendants " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

cmd_for_pid() {
  awk -F'\t' -v pid="$1" '$1 == pid { print $2; exit }' "$records"
}

# Resolve a live PID to its dispatch progress log: explicit --progress-log,
# then a codex -C / leaf --worktree / dispatch slug, then the working directory.
log_for_pid() {
  local pid="$1" cmd="" log dir slug wt
  cmd="$(cmd_for_pid "$pid")"
  [[ -n "$cmd" ]] || return 1
  log="$(flag_value --progress-log "$cmd" || true)"
  [[ -n "$log" && -f "$log" ]] && { printf '%s\n' "$log"; return 0; }
  dir="$(flag_value -C "$cmd" || true)"
  [[ -n "$dir" ]] || dir="$(flag_value --worktree "$cmd" || true)"
  slug="$(flag_value --task-slug "$cmd" || true)"
  if [[ -z "$dir" ]]; then
    wt="$(cwd_for_pid "$pid")"
    dir="$wt"
  fi
  [[ -n "$slug" ]] || slug="$(basename "$dir" 2>/dev/null || true)"
  [[ -n "$slug" ]] || return 1
  log="$WORKTREE_BASE/$slug.progress.log"
  [[ -f "$log" ]] && { printf '%s\n' "$log"; return 0; }
  return 1
}

# --log TARGET resolves before discovery so it works for a finished run too.
if [[ -n "$log_target" ]]; then
  target_log=""
  if [[ "$log_target" =~ ^[0-9]+$ ]]; then
    if ! target_log="$(log_for_pid "$log_target")"; then
      fail "PID $log_target is not a tracked worker, or has no dispatch progress log"
    fi
  elif [[ -f "$log_target" ]]; then
    target_log="$log_target"
  elif [[ -f "$WORKTREE_BASE/$log_target.progress.log" ]]; then
    target_log="$WORKTREE_BASE/$log_target.progress.log"
  elif [[ -f "$WORKTREE_BASE/$log_target" ]]; then
    target_log="$WORKTREE_BASE/$log_target"
  else
    fail "no progress log for '$log_target' (looked in $WORKTREE_BASE)"
  fi
  printf '==> %s <==\n' "$target_log"
  if (( follow )); then
    cleanup
    trap - EXIT
    exec tail -n "$log_lines" -F "$target_log"
  fi
  tail -n "$log_lines" "$target_log"
  exit 0
fi

# Classify each process once; rows are then added in priority order so a leaf
# always wins over the CLI child it launched, and both win over the dispatcher.
# Tokenise past the interpreter. A script invoked by its shebang reports the
# interpreter as argv[0] and the script path as argv[1] (`bash .../run-dsh-agent.sh`,
# `node .../dsh --profile`; `env` may add one more hop), so classify the first
# non-interpreter token. Shell wrappers that merely quote a pattern (`zsh -c`)
# normalise to `-c` and are ignored, which is what keeps a manager's own shell
# out of the list.
classify_tokens() {
  local first="" second=""
  set -f
  set -- $1
  set +f
  while (( $# > 0 )); do
    first="${1##*/}"
    case "$first" in
      bash|sh|zsh|env|node|python3) shift; continue ;;
    esac
    break
  done
  (( $# > 0 )) || { printf '\t'; return 0; }
  (( $# >= 2 )) && second="${2##*/}"
  printf '%s\t%s\n' "$first" "$second"
}

while IFS=$'\t' read -r pid cmd; do
  [[ -n "$pid" ]] || continue

  # The Claude desktop app lives under ".../Application Support/Claude/...", a
  # path with a space, so its argv cannot be tokenised reliably. Match its
  # binary path instead and skip the `disclaimer` wrapper that also quotes it.
  case "$cmd" in
    *"MacOS/claude "*)
      raw_first="${cmd%% *}"
      if [[ "${raw_first##*/}" != "disclaimer" ]]; then
        case "$cmd" in
          *"MacOS/claude -p "*) printf '%s\t%s\n' "$pid" "$cmd" >>"$raw_file" ;;
          *) printf '%s\t%s\n' "$pid" "$cmd" >>"$apps_file" ;;
        esac
        continue
      fi
      ;;
  esac

  tokens="$(classify_tokens "$cmd")"
  first="${tokens%%$'\t'*}"
  second="${tokens#*$'\t'}"

  case "$first" in
    run-*-agent.sh)
      printf '%s\t%s\n' "$pid" "$cmd" >>"$leaves_file"
      ;;
    dispatch-task.sh)
      printf '%s\t%s\n' "$pid" "$cmd" >>"$dispatch_file"
      ;;
    codex)
      [[ "$second" == "exec" ]] && printf '%s\t%s\n' "$pid" "$cmd" >>"$raw_file"
      ;;
    claude)
      if [[ "$second" == "-p" ]]; then
        printf '%s\t%s\n' "$pid" "$cmd" >>"$raw_file"
      else
        printf '%s\t%s\n' "$pid" "$cmd" >>"$apps_file"
      fi
      ;;
    dsh)
      [[ "$second" == "--profile" ]] && printf '%s\t%s\n' "$pid" "$cmd" >>"$raw_file"
      ;;
  esac
done <"$records"

row_pid=()
row_provider=()
row_mode=()
row_slug=()
row_state=()
row_idle=()
row_branch=()
row_log=()
seen_worktrees=""
seen_slugs=""
leaf_descendants=" "
hidden_dsh=0
hidden_claude=0

add_row() {
  local pid="$1" provider="$2" mode="$3" slug="$4" wt="$5" log="$6" dedupe="${7:-1}"
  local state idle branch last ts epoch marker candidate key

  if [[ -n "$pid_filter" && "$pid" != "$pid_filter" ]]; then return 0; fi
  if [[ -n "$provider_filter" && "$provider" != "$provider_filter" ]]; then return 0; fi

  if [[ -z "$log" && -n "$wt" && "$wt" == "$WORKTREE_BASE"/* ]]; then
    candidate="$WORKTREE_BASE/$(basename "$wt").progress.log"
    [[ -f "$candidate" ]] && log="$candidate"
  fi
  if [[ -z "$slug" ]]; then
    [[ -n "$wt" ]] && slug="$(basename "$wt")" || slug="(unknown)"
  fi
  [[ -n "$mode" ]] || mode="-"
  if [[ -n "$slug_filter" && "$slug" != "$slug_filter" ]]; then return 0; fi

  # One row per (provider, worktree): a provider's forks of the same leaf
  # collapse, while two providers working in the same directory stay separate.
  # A raw CLI that a leaf spawned is skipped by ancestry before reaching here,
  # and a dispatcher is skipped by slug — see seen_slugs. App sessions pass
  # dedupe=0 because two chat sessions in one checkout are separate processes.
  if [[ -n "$wt" && "$dedupe" == 1 ]]; then
    key="$provider|$(basename "$wt")"
    case "$seen_worktrees" in
      *"|$key|"*) return 0 ;;
    esac
    seen_worktrees="$seen_worktrees|$key|"
    seen_slugs="$seen_slugs|$(basename "$wt")|"
  fi

  state="no progress log"
  idle="-"
  if [[ -n "$log" && -f "$log" ]]; then
    last="$(tail -n 1 "$log" 2>/dev/null || true)"
    [[ -n "$last" ]] || state="log empty"
    if [[ -n "$last" ]]; then
      ts="${last%% *}"
      epoch="$(epoch_from_iso "$ts")"
      if [[ -n "$epoch" ]]; then
        idle="$(human_age "$(( NOW - epoch ))")"
      fi
      case "$last" in
        *"[dispatch] done"*) state="done (process still alive?)" ;;
        *"[exit]"*) state="exiting" ;;
        *)
          marker="$(printf '%s' "$last" | sed -n 's/^[^ ]* \[\([^]]*\)\].*/\1/p')"
          case "$marker" in
            heartbeat) state="alive (heartbeat only)" ;;
            "") state="log has no marker" ;;
            *) state="$marker" ;;
          esac
          ;;
      esac
    fi
  fi

  branch="-"
  if [[ -n "$wt" && -d "$wt" ]]; then
    branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    [[ -n "$branch" ]] || branch="-"
  fi

  row_pid+=("$pid")
  row_provider+=("$provider")
  row_mode+=("$mode")
  row_slug+=("$slug")
  row_state+=("$state")
  row_idle+=("$idle")
  row_branch+=("$branch")
  row_log+=("$log")
}

collect_leaf() {
  local pid="$1" cmd="$2" provider mode wt log
  provider="$(printf '%s' "$cmd" | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /run-[a-z-]*-agent\.sh$/) { print $i; exit } }')"
  provider="${provider##*/}"
  provider="${provider#run-}"
  provider="${provider%-agent.sh}"
  [[ -n "$provider" ]] || provider="?"
  mode="$(flag_value --mode "$cmd" || true)"
  wt="$(flag_value --worktree "$cmd" || true)"
  log="$(flag_value --progress-log "$cmd" || true)"
  [[ -n "$wt" ]] || wt="$(cwd_for_pid "$pid")"
  add_row "$pid" "$provider" "$mode" "" "$wt" "$log"
}

collect_codex() {
  local pid="$1" cmd="$2" dir sandbox mode
  pid_is_leaf_descendant "$pid" && return 0
  dir="$(flag_value -C "$cmd" || true)"
  [[ -n "$dir" ]] || dir="$(cwd_for_pid "$pid")"
  sandbox="$(flag_value -s "$cmd" || true)"
  case "$sandbox" in
    read-only) mode="review" ;;
    workspace-write) mode="implement" ;;
    *) mode="-" ;;
  esac
  add_row "$pid" "codex" "$mode" "" "$dir" ""
}

collect_dsh() {
  local pid="$1" cmd="$2" profile wt
  pid_is_leaf_descendant "$pid" && return 0
  profile="$(flag_value --profile "$cmd" || true)"
  wt="$(cwd_for_pid "$pid")"
  if [[ "$profile" == "headless" ]]; then
    add_row "$pid" "dsh" "-" "" "$wt" ""
    return 0
  fi
  if (( include_all )) || [[ -n "$pid_filter" && "$pid" == "$pid_filter" ]]; then
    add_row "$pid" "dsh" "${profile:--}" "" "$wt" "" 0
  else
    hidden_dsh=$((hidden_dsh + 1))
  fi
}

collect_claude() {
  local pid="$1" cmd="$2" permission wt mode
  pid_is_leaf_descendant "$pid" && return 0
  permission="$(flag_value --permission-mode "$cmd" || true)"
  case "$permission" in
    plan) mode="review" ;;
    acceptEdits|bypassPermissions) mode="implement" ;;
    *) mode="-" ;;
  esac
  wt="$(cwd_for_pid "$pid")"
  add_row "$pid" "claude" "$mode" "" "$wt" ""
}

collect_claude_app() {
  local pid="$1" cmd="$2" wt
  wt="$(cwd_for_pid "$pid")"
  if (( include_all )) || [[ -n "$pid_filter" && "$pid" == "$pid_filter" ]]; then
    add_row "$pid" "claude-app" "-" "" "$wt" "" 0
  else
    hidden_claude=$((hidden_claude + 1))
  fi
}

collect_dispatch() {
  local pid="$1" cmd="$2" provider slug mode wt log
  provider="$(flag_value --provider "$cmd" || true)"
  [[ -n "$provider" ]] || provider="dsh"
  mode="$(flag_value --mode "$cmd" || true)"
  [[ -n "$mode" ]] || mode="implement"
  slug="$(flag_value --task-slug "$cmd" || true)"
  wt="$(flag_value --worktree "$cmd" || true)"
  if [[ -z "$slug" ]]; then
    [[ -n "$wt" ]] || wt="$(cwd_for_pid "$pid")"
    [[ -n "$wt" ]] && slug="$(basename "$wt")"
  fi
  [[ -n "$slug" ]] || return 0
  [[ -n "$wt" ]] || wt="$WORKTREE_BASE/$slug"
  log="$(flag_value --progress-log "$cmd" || true)"
  [[ -n "$log" ]] || log="$WORKTREE_BASE/$slug.progress.log"
  # A live worker row for this slug already says what the dispatcher is doing;
  # the dispatcher row only covers the build-gate window after the worker exits.
  case "$seen_slugs" in
    *"|$slug|"*) return 0 ;;
  esac
  add_row "$pid" "$provider" "$mode" "$slug" "$wt" "$log"
}

# Priority order matters: leaves, raw CLIs, dispatchers, then app processes.
while IFS=$'\t' read -r pid cmd; do
  [[ -n "$pid" ]] || continue
  collect_leaf "$pid" "$cmd"
done <"$leaves_file"

# A leaf spawns the provider CLI as a child (`bash run-dsh-agent.sh` -> `node
# dsh`), so the raw CLI discovered by its own pattern is the same worker. Walk
# each leaf's process subtree and remember it; without this, dedupe by
# directory would also hide an independent worker of another provider.
while IFS=$'\t' read -r leaf_pid _; do
  [[ -n "$leaf_pid" ]] || continue
  frontier="$leaf_pid"
  depth=0
  while [[ -n "$frontier" && "$depth" -lt 5 ]]; do
    next_frontier=""
    for parent in $frontier; do
      for child_pid in $(pgrep -P "$parent" 2>/dev/null || true); do
        leaf_descendants="$leaf_descendants$child_pid "
        next_frontier="$next_frontier $child_pid"
      done
    done
    frontier="$next_frontier"
    depth=$((depth + 1))
  done
done <"$leaves_file"

while IFS=$'\t' read -r pid cmd; do
  [[ -n "$pid" ]] || continue
  tokens="$(classify_tokens "$cmd")"
  first="${tokens%%$'\t'*}"
  case "$first" in
    codex) collect_codex "$pid" "$cmd" ;;
    claude) collect_claude "$pid" "$cmd" ;;
    dsh) collect_dsh "$pid" "$cmd" ;;
  esac
done <"$raw_file"

while IFS=$'\t' read -r pid cmd; do
  [[ -n "$pid" ]] || continue
  collect_dispatch "$pid" "$cmd"
done <"$dispatch_file"

while IFS=$'\t' read -r pid cmd; do
  [[ -n "$pid" ]] || continue
  collect_claude_app "$pid" "$cmd"
done <"$apps_file"

count="${#row_pid[@]}"

if (( count == 0 )); then
  if [[ -n "$pid_filter" ]]; then
    printf 'No running worker instance with PID: %s\n' "$pid_filter"
  elif [[ -n "$slug_filter" ]]; then
    printf 'No running worker instance for slug: %s\n' "$slug_filter"
  elif [[ -n "$provider_filter" ]]; then
    printf 'No running %s worker instances.\n' "$provider_filter"
  else
    printf 'No running dispatch workers.\n'
  fi
else
  w_pid=7; w_provider=13; w_mode=10; w_slug=34; w_state=26; w_idle=5; w_branch=8
  for i in "${!row_pid[@]}"; do
    (( ${#row_pid[$i]} > w_pid )) && w_pid=${#row_pid[$i]}
    (( ${#row_provider[$i]} > w_provider )) && w_provider=${#row_provider[$i]}
    (( ${#row_mode[$i]} > w_mode )) && w_mode=${#row_mode[$i]}
    (( ${#row_slug[$i]} > w_slug )) && w_slug=${#row_slug[$i]}
    (( ${#row_state[$i]} > w_state )) && w_state=${#row_state[$i]}
    (( ${#row_idle[$i]} > w_idle )) && w_idle=${#row_idle[$i]}
    (( ${#row_branch[$i]} > w_branch )) && w_branch=${#row_branch[$i]}
    if (( ${#row_slug[$i]} > 60 )); then
      row_slug[$i]="${row_slug[$i]:0:57}..."
    fi
  done

  printf '%-*s  %-*s  %-*s  %-*s  %-*s  %*s  %s\n' \
    "$w_pid" "PID" "$w_provider" "PROVIDER" "$w_mode" "MODE" "$w_slug" "SLUG/WORKTREE" \
    "$w_state" "STATE" "$w_idle" "IDLE" "BRANCH"
  for i in "${!row_pid[@]}"; do
    printf '%-*s  %-*s  %-*s  %-*s  %-*s  %*s  %s\n' \
      "$w_pid" "${row_pid[$i]}" "$w_provider" "${row_provider[$i]}" \
      "$w_mode" "${row_mode[$i]}" "$w_slug" "${row_slug[$i]}" \
      "$w_state" "${row_state[$i]}" "$w_idle" "${row_idle[$i]}" "${row_branch[$i]}"
  done

  unique_providers=""
  for i in "${!row_provider[@]}"; do
    case " $unique_providers " in
      *" ${row_provider[$i]} "*) ;;
      *) unique_providers="$unique_providers ${row_provider[$i]}" ;;
    esac
  done
  provider_counts=""
  for provider in $unique_providers; do
    n=0
    for i in "${!row_provider[@]}"; do
      [[ "${row_provider[$i]}" == "$provider" ]] && n=$((n + 1))
    done
    provider_counts="${provider_counts}${provider_counts:+, }$provider $n"
  done
  app_rows=0
  for i in "${!row_provider[@]}"; do
    case "${row_provider[$i]}:${row_mode[$i]}" in
      claude-app:*) app_rows=$((app_rows + 1)) ;;
      dsh:web|dsh:tui) app_rows=$((app_rows + 1)) ;;
    esac
  done
  if (( app_rows > 0 )); then
    printf '\n%s instance(s): %s\n' "$count" "$provider_counts"
  else
    printf '\n%s worker instance(s): %s\n' "$count" "$provider_counts"
  fi
fi

hidden_notes=""
if (( hidden_dsh > 0 )); then
  hidden_notes="${hidden_dsh} dsh app process(es)"
fi
if (( hidden_claude > 0 )); then
  [[ -n "$hidden_notes" ]] && hidden_notes="$hidden_notes, "
  hidden_notes="${hidden_notes}${hidden_claude} Claude app session(s)"
fi
if [[ -n "$hidden_notes" ]]; then
  printf '(%s hidden — use --all to show)\n' "$hidden_notes"
fi

# --logs: print each worker's progress log under a header, so a manager can see
# what the worker is doing without hunting for the file.
if (( show_logs )) && (( count > 0 )); then
  follow_logs=()
  for i in "${!row_pid[@]}"; do
    log="${row_log[$i]}"
    [[ -n "$log" ]] || continue
    if [[ ! -f "$log" ]]; then
      printf '\n==> %s: no progress log yet <==\n' "${row_slug[$i]}"
      continue
    fi
    if (( follow )); then
      follow_logs+=("$log")
    else
      printf '\n==> %s (last %s lines) <==\n' "$log" "$log_lines"
      tail -n "$log_lines" "$log"
    fi
  done
  if (( follow )) && (( ${#follow_logs[@]} > 0 )); then
    printf '\n(following %s log(s) — Ctrl-C to stop)\n' "${#follow_logs[@]}"
    cleanup
    trap - EXIT
    exec tail -n "$log_lines" -F "${follow_logs[@]}"
  elif (( follow )); then
    printf '\n(no progress logs to follow yet)\n'
  fi
fi
