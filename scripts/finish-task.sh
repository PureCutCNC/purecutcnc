#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# finish-task.sh — merge an approved delegated slice into the integration branch
# and tear down its worktree. Run only AFTER the manager has reviewed the real
# diff from dispatch-task.sh. Merges --no-ff (one visible merge commit per slice)
# and refuses to merge into main/master without an explicit override.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly DEFAULT_BASE="feat/core-arch-simplification"
WORKTREE_BASE="${PURECUT_WORKTREE_BASE:-/Users/frankp/Projects/worktrees/purecutcnc}"

usage() {
  cat <<'EOF'
Usage: scripts/finish-task.sh --slug SLUG [--base BRANCH] [--allow-main] [--keep-worktree]

Merge an approved slice's branch into the integration branch (--no-ff) and remove
its worktree. Run only after reviewing the diff produced by dispatch-task.sh.

Options:
  --slug SLUG       Slug used at dispatch (locates worktree $PURECUT_WORKTREE_BASE/SLUG).
  --base BRANCH     Integration branch to merge into (default: feat/core-arch-simplification).
  --allow-main      Permit merging into main/master (refused by default).
  --keep-worktree   Merge but do not remove the worktree/branch afterwards.
  --help            Show this help.

Safety: refuses if the worktree has uncommitted changes, if the integration
checkout is dirty, or (without --allow-main) if --base is main/master.
EOF
}

fail() { printf 'finish-task: %s\n' "$*" >&2; exit 1; }

slug=""
base="$DEFAULT_BASE"
allow_main=false
keep_worktree=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug)          [[ $# -ge 2 ]] || fail "--slug requires a value"; slug="$2"; shift 2 ;;
    --base)          [[ $# -ge 2 ]] || fail "--base requires a branch"; base="$2"; shift 2 ;;
    --allow-main)    allow_main=true; shift ;;
    --keep-worktree) keep_worktree=true; shift ;;
    --help|-h)       usage; exit 0 ;;
    *)               fail "unknown option: $1" ;;
  esac
done

[[ -n "$slug" ]] || fail "--slug is required"

if [[ "$base" == "main" || "$base" == "master" ]] && [[ "$allow_main" != true ]]; then
  fail "refusing to merge into '$base' without --allow-main (delegated slices land on the integration branch)"
fi

worktree_dir="$WORKTREE_BASE/$slug"
[[ -d "$worktree_dir" ]] || fail "worktree not found: $worktree_dir"

# The task branch is whatever the worktree currently has checked out.
task_branch="$(git -C "$worktree_dir" rev-parse --abbrev-ref HEAD)"
[[ -n "$task_branch" && "$task_branch" != "HEAD" ]] \
  || fail "could not resolve the worktree's branch (detached HEAD?)"

# Clean-before-merge: never merge a worktree with uncommitted work.
[[ -z "$(git -C "$worktree_dir" status --porcelain)" ]] \
  || fail "worktree has uncommitted changes; commit or discard them first: $worktree_dir"

git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/heads/$base" >/dev/null \
  || fail "base branch does not exist: $base"
[[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]] \
  || fail "integration checkout has uncommitted changes; clean it before merging: $REPO_ROOT"

original_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"

printf '== checking out %s and merging %s (--no-ff) ==\n' "$base" "$task_branch" >&2
git -C "$REPO_ROOT" checkout "$base" || fail "could not checkout $base"

if ! git -C "$REPO_ROOT" merge --no-ff "$task_branch" \
       -m "Merge slice ${slug} (${task_branch}) into ${base}"; then
  git -C "$REPO_ROOT" merge --abort 2>/dev/null || true
  git -C "$REPO_ROOT" checkout "$original_branch" 2>/dev/null || true
  fail "merge produced conflicts and was aborted; resolve manually"
fi

merge_commit="$(git -C "$REPO_ROOT" log -1 --oneline)"

if [[ "$keep_worktree" == true ]]; then
  printf '\nMerged: %s\nKept worktree: %s (branch %s)\n' "$merge_commit" "$worktree_dir" "$task_branch"
  exit 0
fi

printf '== removing worktree and branch ==\n' >&2
git -C "$REPO_ROOT" worktree remove "$worktree_dir" \
  || fail "merge succeeded but worktree removal failed (not clean?): $worktree_dir"
git -C "$REPO_ROOT" branch -d "$task_branch" \
  || printf 'note: could not delete branch %s (delete manually if desired)\n' "$task_branch" >&2

cat <<EOF

================ finish-task done ================
merged:   $task_branch -> $base
commit:   $merge_commit
worktree: removed ($worktree_dir)
=================================================
EOF
