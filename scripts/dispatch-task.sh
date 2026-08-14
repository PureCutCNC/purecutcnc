#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# dispatch-task.sh — integration-manager orchestrator around supported external
# worker providers. It creates a task worktree+branch, runs one bounded worker
# on the piped prompt, then runs an independent build gate. It deliberately does
# NOT merge — review is the manager's job; use finish-task.sh after approval.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly CLAUDE_DEEPSEEK_LEAF="$SCRIPT_DIR/run-claude-deepseek-agent.sh"
readonly DSH_LEAF="$SCRIPT_DIR/run-dsh-agent.sh"
readonly DEFAULT_BASE="feat/core-arch-simplification"
readonly MAX_DIRECT_PROMPT_BYTES=4096
WORKTREE_BASE="${PURECUT_WORKTREE_BASE:-$(dirname "$REPO_ROOT")/worktrees/$(basename "$REPO_ROOT")}"

usage() {
  cat <<'EOF'
Usage:
  Implement: scripts/dispatch-task.sh --issue NN --task-slug SLUG [--base BRANCH] [--provider PROVIDER] [--handoff REPO_PATH] < brief.txt
  Review:    scripts/dispatch-task.sh --mode review --worktree DIR [--provider PROVIDER] [--handoff REPO_PATH] < brief.txt

Orchestrate one bounded external-worker session and verify the result. The
brief instruction is piped on stdin. For a detailed task, use --handoff with a
tracked path relative to the task worktree; the provider receives a compact
bootstrap that tells it to read that file.

Implement mode (default):
  Creates a worktree at $PURECUT_WORKTREE_BASE/SLUG on a new branch
  feat/issue-NN-SLUG based off --base, runs the selected worker there, then runs
  an independent build gate. Reports branch, worktree, diffstat, build result,
  and the worker completion block. Does NOT merge.

Options:
  --issue NN          Issue number (implement mode; used in the branch name).
  --task-slug SLUG    Short kebab-case slug (implement mode; worktree dir + branch).
  --base BRANCH       Integration branch to branch from (default: feat/core-arch-simplification).
  --provider NAME     claude-deepseek (default) or dsh.
  --handoff REPO_PATH Optional tracked, relative handoff path in the task
                      worktree. The full file stays out of command arguments.
  --mode MODE         implement (default) or review.
  --worktree DIR      Existing worktree to review (review mode only).
  --skip-build        Skip the post-worker build gate (implement mode).
  --progress-log FILE Progress log path (default in implement mode:
                      $PURECUT_WORKTREE_BASE/SLUG.progress.log; review mode
                      only writes one when this is set explicitly).
  --help              Show this help.

Progress: Claude/DeepSeek logs observed worker events. DSH logs only lifecycle
and process-alive heartbeats, not tool activity. Dispatch in the background and
poll scripts/worker-status.sh --slug SLUG instead of killing a long run.

Permissions: every provider sends the prompt to its configured external service,
so get explicit approval first. claude-deepseek reads .env.agent and runs a
bypassPermissions Claude worker; dsh uses its own configured credentials and
confines worker tool calls to DSH's read-only/workspace-write modes.
EOF
}

fail() { printf 'dispatch-task: %s\n' "$*" >&2; exit 1; }

mode="implement"
provider="claude-deepseek"
handoff=""
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
    --provider)     [[ $# -ge 2 ]] || fail "--provider requires claude-deepseek or dsh"; provider="$2"; shift 2 ;;
    --handoff)      [[ $# -ge 2 ]] || fail "--handoff requires a tracked repository path"; handoff="$2"; shift 2 ;;
    --mode)         [[ $# -ge 2 ]] || fail "--mode requires implement or review"; mode="$2"; shift 2 ;;
    --worktree)     [[ $# -ge 2 ]] || fail "--worktree requires a directory"; review_worktree="$2"; shift 2 ;;
    --skip-build)   skip_build=true; shift ;;
    --progress-log) [[ $# -ge 2 ]] || fail "--progress-log requires a file path"; progress_log="$2"; shift 2 ;;
    --help|-h)      usage; exit 0 ;;
    *)              fail "unknown option: $1" ;;
  esac
done

# Append a lifecycle marker so worker-status.sh can tell "worker finished, gate
# running" from "dispatch fully done". Best-effort only.
progress_mark() {
  [[ -n "$progress_log" ]] || return 0
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$progress_log" 2>/dev/null || true
}

case "$mode" in
  implement|review) ;;
  *) fail "--mode must be implement or review" ;;
esac

case "$provider" in
  claude-deepseek)
    leaf="$CLAUDE_DEEPSEEK_LEAF"
    ;;
  dsh)
    leaf="$DSH_LEAF"
    ;;
  *)
    fail "--provider must be claude-deepseek or dsh: $provider"
    ;;
esac
[[ -x "$leaf" ]] || fail "leaf launcher not found or not executable: $leaf"

# Without redirection a worker can block waiting for the terminal.
[[ ! -t 0 ]] || fail "no prompt on stdin; pipe one, e.g.: $0 ... < prompt.md"

# Buffer the prompt so it can be fed to either leaf without changing its
# contract. The provider receives it only when the leaf is invoked below.
prompt_file="$(mktemp -t dispatch-task-prompt)"
worker_prompt_file="$prompt_file"
trap 'rm -f "$prompt_file" "$worker_prompt_file"' EXIT
cat > "$prompt_file"
[[ -s "$prompt_file" ]] || fail "the piped prompt is empty"
prompt_bytes="$(wc -c < "$prompt_file" | tr -d '[:space:]')"
[[ "$prompt_bytes" -le "$MAX_DIRECT_PROMPT_BYTES" ]] \
  || fail "the brief instruction exceeds ${MAX_DIRECT_PROMPT_BYTES} bytes; store the full task in a tracked handoff and use --handoff REPO_PATH"

validate_handoff() {
  local worktree="$1"
  [[ -n "$handoff" ]] || return 0
  [[ "$handoff" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] \
    || fail "--handoff must be a relative repository path without spaces or shell characters: $handoff"
  [[ "$handoff" != ./* && "$handoff" != */./* && "$handoff" != */ && "$handoff" != *//* ]] \
    || fail "--handoff must be a normalized relative file path: $handoff"
  [[ "/$handoff/" != *"/../"* ]] \
    || fail "--handoff must not contain parent-directory traversal: $handoff"
  git -C "$worktree" ls-files --error-unmatch -- "$handoff" >/dev/null 2>&1 \
    || fail "--handoff must name a tracked file in the task worktree: $handoff"
  [[ -f "$worktree/$handoff" && ! -L "$worktree/$handoff" ]] \
    || fail "--handoff must name a regular tracked file in the task worktree: $handoff"
}

prepare_worker_prompt() {
  local worktree="$1"
  [[ -n "$handoff" ]] || return 0
  validate_handoff "$worktree"
  worker_prompt_file="$(mktemp -t dispatch-task-worker-prompt)"
  {
    printf 'Read the complete task handoff at %s in the current worktree.\n' "$handoff"
    printf 'That tracked file is the primary specification; follow it exactly.\n\n'
    printf 'Short manager instruction:\n'
    cat "$prompt_file"
  } > "$worker_prompt_file"
}

if [[ "$provider" == "claude-deepseek" ]]; then
  # The Claude/DeepSeek leaf reads the canonical credential file in the primary
  # checkout; it is never copied into a task worktree.
  export DEEPSEEK_AGENT_ENV_FILE="${DEEPSEEK_AGENT_ENV_FILE:-$REPO_ROOT/.env.agent}"
else
  # DSH resolves its configured credentials itself. Do not expose the legacy
  # credential-file path to this provider.
  unset DEEPSEEK_AGENT_ENV_FILE
fi

run_review() {
  local status=0
  local -a leaf_args=(--mode review --worktree "$review_worktree")
  if [[ "$provider" == "claude-deepseek" ]]; then
    leaf_args+=(--output-format text)
  fi
  [[ -n "$progress_log" ]] && leaf_args+=(--progress-log "$progress_log")
  "$leaf" "${leaf_args[@]}" < "$worker_prompt_file" || status=$?
  progress_mark "[dispatch] done provider=$provider worker_exit=$status build=n/a"
  return "$status"
}

if [[ "$mode" == "review" ]]; then
  [[ -n "$review_worktree" ]] || fail "review mode requires --worktree DIR (an existing worktree)"
  [[ -d "$review_worktree" ]] || fail "--worktree is not a directory: $review_worktree"
  prepare_worker_prompt "$review_worktree"
  printf '== review worker (%s, read-only) in %s ==\n' "$provider" "$review_worktree" >&2
  run_review
  exit $?
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

[[ -n "$progress_log" ]] || progress_log="$WORKTREE_BASE/$slug.progress.log"
printf '== progress log: %s ==\n' "$progress_log" >&2
printf '== poll with: scripts/worker-status.sh --slug %s ==\n' "$slug" >&2

printf '== dispatching implement worker (%s) ==\n' "$provider" >&2
prepare_worker_prompt "$worktree_dir"
worker_status=0
leaf_args=(--mode implement --worktree "$worktree_dir" --progress-log "$progress_log")
if [[ "$provider" == "claude-deepseek" ]]; then
  leaf_args+=(--allow-bypass --output-format text)
fi
"$leaf" "${leaf_args[@]}" < "$worker_prompt_file" || worker_status=$?
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
progress_mark "[dispatch] done provider=$provider worker_exit=$worker_status build=$build_result"

# ---- report ----
last_commit="$(git -C "$worktree_dir" log -1 --oneline 2>/dev/null || echo '(none)')"
status_short="$(git -C "$worktree_dir" status --short 2>/dev/null || true)"
diffstat="$(git -C "$worktree_dir" diff --stat "$base"...HEAD 2>/dev/null || true)"

cat <<EOF

================ dispatch-task report ================
issue:        #$issue
slug:         $slug
provider:     $provider
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

[[ "$build_result" == "FAILED" || "$build_result" == "install-failed" ]] && exit 1
exit 0
