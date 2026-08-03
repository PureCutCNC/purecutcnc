#!/usr/bin/env bash
# PreToolUse(Bash) guard: refuse `git commit` while HEAD is on the default
# branch (main/master). Forces work onto a feature branch + PR instead of
# landing straight on main. Commits on any other branch pass through untouched.
#
# Wired up in .claude/settings.json. Reads the Claude Code hook payload (JSON)
# on stdin and, to block, prints a PreToolUse deny decision as JSON on stdout.
#
# The hook process runs in the primary checkout, but the command being judged
# may target a different worktree via `git -C <path>` or `cd <path> &&`. We
# parse the target directory out of the command and probe the branch there;
# when no directory is given we fall back to the cwd (the primary checkout).
# That fallback is fail-closed: in a worktree-driven session the primary sits
# on main, so an unresolvable target denies rather than slips through.

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

# Only act on an actual `git commit` invocation (also catches it inside a
# compound command like `git add -A && git commit`). Does not match
# `git commit-tree`, `git log --grep=commit`, etc.
#
# Capture the segment between `git` and `commit` (the global-options segment)
# so we can parse `-C <path>` from it. `-C` appearing after `commit` is
# `git commit -C <commit-ish>` (reuse message), not a directory, so it is
# deliberately excluded from that segment.
detect_re='(^|[^[:alnum:]])git[[:space:]]+([^|;&]*[[:space:]])?commit([[:space:]]|$)'
if ! [[ $command =~ $detect_re ]]; then
  exit 0
fi
global_opts="${BASH_REMATCH[2]}"

# Resolve the directory the git command targets. Start from the hook's cwd
# (the primary checkout) and apply a leading `cd <path>` and any `git -C
# <path>` global options cumulatively — matching git's own semantics.
target="$(pwd)"

# A leading `cd <path> &&` (or `;`) redirects the working directory for the
# rest of the command. The path may be single- or double-quoted.
cd_re="^[[:space:]]*cd[[:space:]]+(\"([^\"]+)\"|'([^']+)'|([^[:space:]&;|]+))[[:space:]]*(&&|;)[[:space:]]*(.*)$"
if [[ $command =~ $cd_re ]]; then
  cd_target="${BASH_REMATCH[2]:-${BASH_REMATCH[3]:-${BASH_REMATCH[4]}}}"
  if [[ $cd_target == /* ]]; then
    target="$cd_target"
  else
    target="$target/$cd_target"
  fi
fi

# `git -C <path>` global options, applied in order. Handles both `-C <path>`
# (separated) and `-C<path>` (joined); paths may be quoted. Other global
# options are skipped one token at a time so a later -C is still picked up.
c_re="^-C[[:space:]]+(\"([^\"]+)\"|'([^']+)'|([^[:space:]]+))(.*)$"
c_re_joined="^-C(\"([^\"]+)\"|'([^']+)'|([^[:space:]]+))(.*)$"
opts="$global_opts"
while :; do
  # Trim leading whitespace.
  while [[ $opts == [[:space:]]* ]]; do opts="${opts#?}"; done
  [ -z "$opts" ] && break
  if [[ $opts =~ $c_re ]]; then
    p="${BASH_REMATCH[2]:-${BASH_REMATCH[3]:-${BASH_REMATCH[4]}}}"
    opts="${BASH_REMATCH[5]}"
  elif [[ $opts =~ $c_re_joined ]]; then
    p="${BASH_REMATCH[2]:-${BASH_REMATCH[3]:-${BASH_REMATCH[4]}}}"
    opts="${BASH_REMATCH[5]}"
  else
    # Some other token; drop it and keep scanning for a later -C.
    [[ $opts =~ ^([^[:space:]]+) ]] && opts="${opts#"${BASH_REMATCH[1]}"}"
    continue
  fi
  [ -z "$p" ] && break
  if [[ $p == /* ]]; then
    target="$p"
  else
    target="$target/$p"
  fi
done

# symbolic-ref reports the branch name even before the first commit (unborn
# branch); fall back to rev-parse for the detached-HEAD case.
probe_branch() {
  git -C "$1" symbolic-ref --short -q HEAD 2>/dev/null \
    || git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null
}
branch="$(probe_branch "$target")"

# If a target was parsed but the probe came back empty (bad path / not a git
# dir), fall back to the cwd — fail-closed, since the cwd here is the primary
# checkout, which sits on main in a worktree-driven session.
if [ -z "$branch" ] && [ "$target" != "$(pwd)" ]; then
  branch="$(probe_branch "$(pwd)")"
fi

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
