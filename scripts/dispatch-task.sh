#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# dispatch-task.sh — integration-manager orchestrator around the DeepSeek leaf
# launcher (run-claude-deepseek-agent.sh). It automates the manual steps from
# AGENTS.md "DeepSeek implementation workers": create the task worktree+branch,
# run one bounded worker on the piped prompt, then run an independent build gate
# and report. It deliberately does NOT merge — review is the manager's job; use
# finish-task.sh after approval.
#
# This step needs elevated access: it reads the .env.agent credential file,
# makes outbound network calls to the DeepSeek endpoint, and (in implement mode)
# spawns a bypassPermissions worker. Request the user's approval before running.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly LEAF="$SCRIPT_DIR/run-claude-deepseek-agent.sh"
readonly DEFAULT_BASE="feat/core-arch-simplification"
WORKTREE_BASE="${PURECUT_WORKTREE_BASE:-/Users/frankp/Projects/worktrees/purecutcnc}"

usage() {
  cat <<'EOF'
Usage:
  Implement: scripts/dispatch-task.sh --issue NN --task-slug SLUG [--base BRANCH] < prompt.md
  Review:    scripts/dispatch-task.sh --mode review --worktree DIR < prompt.md

Orchestrate one DeepSeek worker session and verify the result. The prompt is
piped on stdin (fill scripts/claude-deepseek-agent-prompt.md first).

Implement mode (default):
  Creates a worktree at $PURECUT_WORKTREE_BASE/SLUG on a new branch
  feat/issue-NN-SLUG based off --base, runs a bypass worker there, then runs an
  independent build gate. Reports branch, worktree, diffstat, build result, and
  the worker completion block. Does NOT merge.

Options:
  --issue NN          Issue number (implement mode; used in the branch name).
  --task-slug SLUG    Short kebab-case slug (implement mode; worktree dir + branch).
  --base BRANCH       Integration branch to branch from (default: feat/core-arch-simplification).
  --mode MODE         implement (default) or review.
  --worktree DIR      Existing worktree to review (review mode only).
  --skip-build        Skip the post-worker build gate (implement mode).
  --progress-log FILE Progress log path (default in implement mode:
                      $PURECUT_WORKTREE_BASE/SLUG.progress.log; review mode
                      only streams progress when this is set explicitly).
  --help              Show this help.

Progress: the worker streams one-line progress entries into the progress log
as it works. Dispatch in the background and poll scripts/worker-status.sh
--slug SLUG (instant, bounded) instead of blocking on — or killing — a long
foreground run. Judge the worker by idle time in the log, not total runtime.

Permissions: this command reads .env.agent, connects to the DeepSeek endpoint,
and (implement) runs a bypassPermissions worker. Get explicit approval first.
EOF
}

fail() { printf 'dispatch-task: %s\n' "$*" >&2; exit 1; }

mode="implement"
issue=""
slug=""
base="$DEFAULT_BASE"
review_worktree=""
skip_build=false
progress_log=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue)        [[ $# -ge 2 ]] || fail "--issue requires a number"; issue="$2"; shift 2 ;;
    --task-slug)    [[ $# -ge 2 ]] || fail "--task-slug requires a value"; slug="$2"; shift 2 ;;
    --base)         [[ $# -ge 2 ]] || fail "--base requires a branch"; base="$2"; shift 2 ;;
    --mode)         [[ $# -ge 2 ]] || fail "--mode requires implement or review"; mode="$2"; shift 2 ;;
    --worktree)     [[ $# -ge 2 ]] || fail "--worktree requires a directory"; review_worktree="$2"; shift 2 ;;
    --skip-build)   skip_build=true; shift ;;
    --progress-log) [[ $# -ge 2 ]] || fail "--progress-log requires a file path"; progress_log="$2"; shift 2 ;;
    --help|-h)      usage; exit 0 ;;
    *)              fail "unknown option: $1" ;;
  esac
done

# Append a lifecycle marker to the progress log so worker-status.sh can tell
# "worker finished, gate running" from "dispatch fully done". Best-effort only.
progress_mark() {
  [[ -n "$progress_log" ]] || return 0
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$progress_log" 2>/dev/null || true
}

[[ -x "$LEAF" ]] || fail "leaf launcher not found or not executable: $LEAF"
# Without redirection the worker's `claude --print` would block on the terminal.
[[ ! -t 0 ]] || fail "no prompt on stdin; pipe one, e.g.: $0 ... < prompt.md"

case "$mode" in
  implement|review) ;;
  *) fail "--mode must be implement or review" ;;
esac

# Buffer the prompt so it can be fed to the leaf (and re-read if ever needed).
prompt_file="$(mktemp -t dispatch-task-prompt)"
trap 'rm -f "$prompt_file"' EXIT
cat > "$prompt_file"
[[ -s "$prompt_file" ]] || fail "the piped prompt is empty"

# The leaf finds credentials via DEEPSEEK_AGENT_ENV_FILE; default to the one
# canonical file in the primary checkout (never copied into a task worktree).
export DEEPSEEK_AGENT_ENV_FILE="${DEEPSEEK_AGENT_ENV_FILE:-$REPO_ROOT/.env.agent}"

if [[ "$mode" == "review" ]]; then
  [[ -n "$review_worktree" ]] || fail "review mode requires --worktree DIR (an existing worktree)"
  [[ -d "$review_worktree" ]] || fail "--worktree is not a directory: $review_worktree"
  printf '== review worker (read-only) in %s ==\n' "$review_worktree" >&2
  leaf_args=(--mode review --worktree "$review_worktree" --output-format text)
  [[ -n "$progress_log" ]] && leaf_args+=(--progress-log "$progress_log")
  review_status=0
  "$LEAF" "${leaf_args[@]}" < "$prompt_file" || review_status=$?
  progress_mark "[dispatch] done worker_exit=$review_status build=n/a"
  exit "$review_status"
fi

# ---- implement mode ----
[[ -n "$issue" ]] || fail "implement mode requires --issue NN"
[[ "$issue" =~ ^[0-9]+$ ]] || fail "--issue must be numeric: $issue"
[[ -n "$slug" ]] || fail "implement mode requires --task-slug SLUG"
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]] || fail "--task-slug must be kebab-case [a-z0-9-]: $slug"

branch="feat/issue-${issue}-${slug}"
worktree_dir="$WORKTREE_BASE/$slug"

git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "primary checkout is not a git repo: $REPO_ROOT"
git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/heads/$base" >/dev/null \
  || fail "base branch does not exist locally: $base (fetch/create it first)"
git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null \
  && fail "branch already exists: $branch"
[[ -e "$worktree_dir" ]] && fail "worktree path already exists: $worktree_dir"

mkdir -p "$WORKTREE_BASE"
printf '== creating worktree %s on %s (from %s) ==\n' "$worktree_dir" "$branch" "$base" >&2
git -C "$REPO_ROOT" worktree add "$worktree_dir" -b "$branch" "$base" \
  || fail "failed to create worktree"

# Per-slice progress log: the worker streams one-line entries here as it works,
# so a backgrounded dispatch can be polled (worker-status.sh) instead of killed
# for looking silent.
[[ -n "$progress_log" ]] || progress_log="$WORKTREE_BASE/$slug.progress.log"
printf '== progress log: %s ==\n' "$progress_log" >&2
printf '== poll with: scripts/worker-status.sh --slug %s ==\n' "$slug" >&2

printf '== dispatching implement worker (bypass) ==\n' >&2
worker_status=0
"$LEAF" --mode implement --allow-bypass --worktree "$worktree_dir" \
  --output-format text --progress-log "$progress_log" < "$prompt_file" || worker_status=$?
if [[ "$worker_status" -ne 0 ]]; then
  printf '\n!! worker exited non-zero (%s); worktree left in place for inspection !!\n' \
    "$worker_status" >&2
fi

# ---- independent build gate (manager verification, not the worker's report) ----
build_result="skipped"
if [[ "$skip_build" == false ]]; then
  printf '== build gate: npm run build in worktree ==\n' >&2
  progress_mark "[gate] npm run build starting"
  if [[ ! -d "$worktree_dir/node_modules" ]]; then
    printf '   node_modules missing; running npm install\n' >&2
    ( cd "$worktree_dir" && npm install ) || build_result="install-failed"
  fi
  if [[ "$build_result" != "install-failed" ]]; then
    if ( cd "$worktree_dir" && npm run build ); then build_result="passed"; else build_result="FAILED"; fi
  fi
fi
progress_mark "[dispatch] done worker_exit=$worker_status build=$build_result"

# ---- report ----
last_commit="$(git -C "$worktree_dir" log -1 --oneline 2>/dev/null || echo '(none)')"
status_short="$(git -C "$worktree_dir" status --short 2>/dev/null || true)"
diffstat="$(git -C "$worktree_dir" diff --stat "$base"...HEAD 2>/dev/null || true)"

cat <<EOF

================ dispatch-task report ================
issue:        #$issue
slug:         $slug
branch:       $branch
worktree:     $worktree_dir
base:         $base
worker exit:  $worker_status
build gate:   $build_result
progress log: $progress_log
last commit:  $last_commit

uncommitted (should be empty if worker committed):
${status_short:-  (clean)}

diffstat vs $base:
${diffstat:-  (no commits yet)}
=====================================================
Review the real diff, then merge with:
  scripts/finish-task.sh --slug $slug --base $base
EOF

# Surface a non-zero status to the caller if the gate failed, so automation halts.
[[ "$build_result" == "FAILED" || "$build_result" == "install-failed" ]] && exit 1
exit 0
