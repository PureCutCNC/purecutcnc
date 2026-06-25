#!/usr/bin/env bash
# PreToolUse(Bash) guard: refuse `git commit` while HEAD is on the default
# branch (main/master). Forces work onto a feature branch + PR instead of
# landing straight on main. Commits on any other branch pass through untouched.
#
# Wired up in .claude/settings.json. Reads the Claude Code hook payload (JSON)
# on stdin and, to block, prints a PreToolUse deny decision as JSON on stdout.

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

# Only act on an actual `git commit` invocation (also catches it inside a
# compound command like `git add -A && git commit`). Does not match
# `git commit-tree`, `git log --grep=commit`, etc.
if ! printf '%s' "$command" | grep -Eq '(^|[^[:alnum:]])git[[:space:]]+([^|;&]*[[:space:]])?commit([[:space:]]|$)'; then
  exit 0
fi

# symbolic-ref reports the branch name even before the first commit (unborn
# branch); fall back to rev-parse for the detached-HEAD case.
branch=$(git symbolic-ref --short -q HEAD || git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  jq -n --arg b "$branch" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("Refusing to commit directly on the default branch (" + $b + "). Create a feature branch first (git checkout -b feat/your-change), commit there, and open a PR. \"commit here\"/\"no PR\" does not authorize a direct main commit.")
    }
  }'
fi

exit 0
