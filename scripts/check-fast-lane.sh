#!/usr/bin/env bash
# Fast-lane eligibility gate (see AGENTS.md, "Fast lane").
#
# Decides mechanically whether a change may skip the Plan and Approve steps of
# the workflow. Nothing here is a judgment call: a change is eligible only when
# it stays inside the size budget AND touches no protected path.
#
# Deliberately dependency-free bash so CI can run it without `npm ci` and so it
# works in a checkout that has never been built.
#
# Exit 0 = eligible (or, in --ci mode, not a fast-lane PR). Exit 1 = full lane.

set -euo pipefail

MAX_FILES=3
MAX_LINES=25

BASE_REF='origin/main'
CI_MODE=0

usage() {
  cat <<'USAGE'
Usage: bash scripts/check-fast-lane.sh [--base <ref>] [--ci]

  (no args)      Check the working tree against origin/main. Run this before
                 branching and again before opening the PR.
  --base <ref>   Compare against something other than origin/main.
  --ci           CI mode: no-op unless FAST_LANE_LABELED=true, so the job can
                 run on every PR and still be a required check.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE_REF="${2:?--base needs a ref}"; shift 2 ;;
    --base=*) BASE_REF="${1#--base=}"; shift ;;
    --ci) CI_MODE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'check-fast-lane: unknown argument %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

# The CI job runs on every PR so it can be a required check, but it only has an
# opinion when the author actually claimed the fast lane.
if [ "$CI_MODE" -eq 1 ] && [ "${FAST_LANE_LABELED:-false}" != 'true' ]; then
  echo "No 'fast-lane' label on this PR — full lane assumed, nothing to check."
  exit 0
fi

if ! git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null; then
  printf 'check-fast-lane: base ref %s not found (fetch it, or pass --base)\n' "$BASE_REF" >&2
  exit 2
fi
MERGE_BASE=$(git merge-base "$BASE_REF" HEAD)

# Protected paths: touching any of these is the full lane, however small the
# diff. Patterns are matched with bash `case`, where * also spans '/'.
protected_bucket() {
  case "$1" in
    src/engine/toolpaths/*|src/engine/gcode/*|src/machine/*|src/utils/units.ts)
      echo 'machine output & safety' ;;
    src/types/project.ts|src/store/helpers/projectFormat.ts|src/import/camj.ts)
      echo '.camj format & migrations' ;;
    src/store/types.ts)
      echo 'frozen ProjectStore contract' ;;
    AGENTS.md|PROJECT.md|ARCHITECTURE.md|.github/*|.claude/*|package.json|tsconfig*.json|eslint.config.js)
      echo 'process & gate machinery' ;;
    # Gate logic under scripts/. Anything whose corruption would silently weaken
    # a gate belongs here — not just check-*. Add to this list when a new gate
    # lands; scripts/backlog-hygiene.ts arrived after the first draft and was
    # missed by the original `scripts/check-*` glob.
    scripts/check-*|scripts/run-tests.ts|scripts/docs-check-core.ts|scripts/backlog-hygiene.ts)
      echo 'process & gate machinery' ;;
    *) return 1 ;;
  esac
}

# Tests are exempt from both counts on purpose: charging a change for the tests
# it adds is an incentive to skip them.
is_test() {
  case "$1" in
    *.test.ts|*.test.tsx|e2e/*) return 0 ;;
    *) return 1 ;;
  esac
}

counted_files=0
counted_lines=0
exempt_files=0
violations=''
counted_report=''
exempt_report=''

add_violation() {
  violations="${violations}  - $1
"
}

record() {
  local added="$1" deleted="$2" path="$3" bucket lines

  if bucket=$(protected_bucket "$path"); then
    add_violation "protected path touched: $path ($bucket)"
  fi

  if is_test "$path"; then
    exempt_files=$((exempt_files + 1))
    exempt_report="${exempt_report}    ${path}
"
    return
  fi

  counted_files=$((counted_files + 1))

  if [ "$added" = '-' ] || [ "$deleted" = '-' ]; then
    add_violation "binary change, size not measurable: $path"
    counted_report="${counted_report}    $(printf '%-50s %s' "$path" 'binary')
"
    return
  fi

  lines=$((added + deleted))
  counted_lines=$((counted_lines + lines))
  counted_report="${counted_report}    $(printf '%-50s +%-5s -%-5s = %s' "$path" "$added" "$deleted" "$lines")
"
}

# Committed, staged and unstaged changes against the merge base. --no-renames
# keeps paths unambiguous and makes a rename cost its full add+delete, which is
# the conservative reading we want.
while IFS=$'\t' read -r added deleted path; do
  [ -n "${path:-}" ] || continue
  record "$added" "$deleted" "$path"
done <<EOF
$(git diff --numstat --no-renames "$MERGE_BASE")
EOF

# Untracked files are part of the change too — a new file is the common case.
# git itself counts the lines, so binary detection matches the tracked path.
while IFS= read -r path; do
  [ -n "$path" ] || continue
  stat=$(git diff --numstat --no-index -- /dev/null "$path" 2>/dev/null || true)
  if [ -n "$stat" ]; then
    record "$(printf '%s' "$stat" | cut -f1)" "$(printf '%s' "$stat" | cut -f2)" "$path"
  else
    record 0 0 "$path"
  fi
done <<EOF
$(git ls-files --others --exclude-standard)
EOF

if [ "$counted_files" -gt "$MAX_FILES" ]; then
  add_violation "$counted_files changed files, max $MAX_FILES (tests excluded)"
fi
if [ "$counted_lines" -gt "$MAX_LINES" ]; then
  add_violation "$counted_lines changed lines, max $MAX_LINES (tests excluded)"
fi

echo 'Fast-lane eligibility check'
printf '  base: %s (merge-base %s)\n\n' "$BASE_REF" "$(git rev-parse --short "$MERGE_BASE")"
printf '  counted files: %s / %s\n' "$counted_files" "$MAX_FILES"
if [ -n "$counted_report" ]; then printf '%s' "$counted_report"; fi
printf '  counted lines: %s / %s\n' "$counted_lines" "$MAX_LINES"
if [ "$exempt_files" -gt 0 ]; then
  printf '  test files (exempt): %s\n' "$exempt_files"
  printf '%s' "$exempt_report"
fi
echo

if [ -n "$violations" ]; then
  echo 'NOT ELIGIBLE — this change takes the full lane (issue -> plan -> explicit approval):'
  printf '%s' "$violations"
  echo
  echo 'Do not split the change across PRs to fit the budget. Write the plan into the'
  echo 'issue, wait for approval, and drop any fast-lane label.'
  exit 1
fi

if [ "$counted_files" -eq 0 ] && [ "$exempt_files" -eq 0 ]; then
  echo 'No changes against the base — nothing to check yet.'
  exit 0
fi

echo 'ELIGIBLE — the fast lane may be used: skip Plan and Approve, nothing else.'
echo 'Label the PR `fast-lane`. Re-run this before opening the PR.'
