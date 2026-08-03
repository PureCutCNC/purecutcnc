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
#
# Compound commands are checked in full: the command is split on chain
# operators (&&, ||, ;, |, &) and every `git commit` segment is resolved. A
# `cd <path>` segment updates the running directory for later segments (as it
# would in a real shell); `git -C <path>` applies only within its own segment
# (git never changes the shell cwd). If ANY commit segment resolves to the
# default branch the whole command is denied — `git -C /feature commit && git
# commit` does not get to slip the second commit onto main.

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

# Tokenize the command into segments by chain operators so every `git commit`
# in a compound command is checked, not just the first. Operators are replaced
# with newlines (length-descending: && before &, || before |) so multi-char
# operators are not split into single chars.
nl=$'\n'
split="$command"
split="${split//&&/$nl}"
split="${split//||/$nl}"
split="${split//;/$nl}"
split="${split//|/$nl}"
split="${split//&/$nl}"

# Matches a `git commit` invocation and captures the global-options segment
# between `git` and `commit`. `-C` after `commit` is `git commit -C <commit>`
# (reuse message), not a directory, so only the pre-`commit` segment is
# scanned for -C. Does not match `git commit-tree`, `git log --grep=commit`.
detect_re='(^|[^[:alnum:]])git[[:space:]]+([^|;&]*[[:space:]])?commit([[:space:]]|$)'
# A `cd <path>` segment (own segment after splitting) updates the running cwd.
cd_re="^[[:space:]]*cd[[:space:]]+(\"([^\"]+)\"|'([^']+)'|([^[:space:]&;|]+))[[:space:]]*$"
# `git -C <path>` and `git -C<path>` global options; paths may be quoted.
c_re="^-C[[:space:]]+(\"([^\"]+)\"|'([^']+)'|([^[:space:]]+))(.*)$"
c_re_joined="^-C(\"([^\"]+)\"|'([^']+)'|([^[:space:]]+))(.*)$"

# Resolve a path against a base: absolute overrides, relative stacks.
join_path() {
  local base="$1" p="$2"
  if [[ $p == /* ]]; then printf '%s' "$p"; else printf '%s/%s' "$base" "$p"; fi
}

# symbolic-ref reports the branch name even before the first commit (unborn
# branch); fall back to rev-parse for the detached-HEAD case. Empty if the
# path is not a git worktree.
probe_branch() {
  git -C "$1" symbolic-ref --short -q HEAD 2>/dev/null \
    || git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null
}

cwd="$(pwd)"
running_dir="$cwd"   # tracks `cd` across segments
deny_branch=""

while IFS= read -r segment; do
  # Trim leading whitespace.
  seg="$segment"
  while [[ $seg == [[:space:]]* ]]; do seg="${seg#?}"; done
  [ -z "$seg" ] && continue

  # A `cd <path>` segment updates the running directory for later segments.
  if [[ $seg =~ $cd_re ]]; then
    cd_target="${BASH_REMATCH[2]:-${BASH_REMATCH[3]:-${BASH_REMATCH[4]}}}"
    running_dir="$(join_path "$running_dir" "$cd_target")"
    continue
  fi

  # Is this segment a `git commit`? If not, skip it (e.g. `git add -A`).
  if ! [[ $seg =~ $detect_re ]]; then
    continue
  fi
  global_opts="${BASH_REMATCH[2]}"

  # Resolve this commit's target: start from the running dir, apply this
  # segment's -C options cumulatively (absolute overrides, relative stacks).
  target="$running_dir"
  opts="$global_opts"
  while :; do
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
    target="$(join_path "$target" "$p")"
  done

  branch="$(probe_branch "$target")"
  # Unresolvable target: fall back to cwd — fail-closed, since the primary
  # sits on main in a worktree-driven session.
  if [ -z "$branch" ] && [ "$target" != "$cwd" ]; then
    branch="$(probe_branch "$cwd")"
  fi
  if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
    deny_branch="$branch"
    break
  fi
done <<< "$split"

if [ -n "$deny_branch" ]; then
  jq -n --arg b "$deny_branch" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("Refusing to commit directly on the default branch (" + $b + "). Create a feature branch first (git checkout -b feat/your-change), commit there, and open a PR. \"commit here\"/\"no PR\" does not authorize a direct main commit.")
    }
  }'
fi

exit 0
