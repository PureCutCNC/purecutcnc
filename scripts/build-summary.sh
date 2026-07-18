#!/usr/bin/env bash
# Run the full build gate ONCE and print a compact summary: which stage
# failed and the extracted error lines. Agents must not re-run `npm run
# build` to hunt for failures — the full output is saved to a log file whose
# path is printed at the end; re-read that instead.
#
# Usage:
#   scripts/build-summary.sh                 # run npm run build, then summarize
#   scripts/build-summary.sh --from-log FILE # summarize an existing build log
#
# Exit code: the build's exit code (0 on --from-log unless the log shows a
# failure, then 1).

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

log=""
ran_build=0
if [[ "${1:-}" == "--from-log" ]]; then
  log="${2:-}"
  [[ -r "$log" ]] || { echo "build-summary: cannot read log: $log" >&2; exit 2; }
  status=0
else
  log="${BUILD_SUMMARY_LOG:-$(mktemp -t purecutcnc-build).log}"
  ran_build=1
  npm run build >"$log" 2>&1
  status=$?
fi

has() { grep -q "$1" "$log"; }

# The build chain is &&-sequenced, so the log ends inside the failing stage.
stage="unknown"
if has "✓ built in"; then
  stage="all-passed"
elif grep -qE "vite v[0-9]" "$log"; then
  stage="vite build"
elif grep -qE "run-tests: .*failed" "$log"; then
  stage="unit tests"
elif has "run-tests: discovered"; then
  # discovered but neither the all-passed nor the failed summary line: a test
  # file crashed the runner — still the tests stage.
  grep -q "run-tests: all" "$log" || stage="unit tests"
elif grep -qE "error TS[0-9]+" "$log"; then
  stage="typecheck (tsc)"
elif grep -qE "✖ [0-9]+ problem" "$log"; then
  stage="lint (eslint)"
elif has "docs-check: OK"; then
  stage="icon sprite / typecheck startup"
else
  stage="docs:check"
fi

echo "================ build summary ================"
if [[ $ran_build -eq 1 ]]; then
  echo "overall: $([[ $status -eq 0 ]] && echo PASS || echo "FAIL (exit $status)")"
else
  echo "overall: $([[ "$stage" == "all-passed" ]] && echo "PASS (from log)" || echo "FAIL (from log)")"
  [[ "$stage" == "all-passed" ]] || status=1
fi
[[ "$stage" != "all-passed" ]] && echo "failing stage: $stage"

# Stage checkpoints that appear on the happy path.
echo "stages reached:"
has "docs-check: OK"          && echo "  ✓ docs:check"
grep -qE "✖ [0-9]+ problem" "$log" || { has "docs-check: OK" && echo "  ✓ lint (no problem summary)"; }
grep -qE "error TS[0-9]+" "$log"   || echo "  ✓ typecheck (no TS errors seen)"
grep -qE "run-tests: all .* passed" "$log" && echo "  ✓ unit tests ($(grep -oE 'run-tests: all [0-9]+' "$log" | grep -oE '[0-9]+') files)"
has "✓ built in"              && echo "  ✓ vite build"

# ── Error extraction ─────────────────────────────────────────────
if grep -qE "✖ [0-9]+ problem" "$log"; then
  echo ""
  echo "-- eslint problems --"
  # File headers are unindented paths; problem lines are indented line:col.
  grep -B1 -E "^\s+[0-9]+:[0-9]+\s+(error|warning)" "$log" | grep -vE "^--$" | head -60
  grep -E "✖ [0-9]+ problem" "$log"
fi

if grep -qE "error TS[0-9]+" "$log"; then
  echo ""
  echo "-- TypeScript errors --"
  grep -E "error TS[0-9]+" "$log" | head -50
fi

failed_tests=$(grep -E "run-tests: FAILED" "$log" | sed -E 's/run-tests: FAILED ([^ ]+).*/\1/')
if [[ -n "$failed_tests" ]]; then
  echo ""
  echo "-- failed test files --"
  while IFS= read -r rel; do
    echo "FAILED: $rel"
    # Print the tail of that file's section: from its ── header to the next
    # ── header (or EOF), keeping the last 20 lines (the thrown assertion).
    awk -v f="$rel" '
      index($0, "── " f " ") { insec=1; n=0; delete buf; next }
      insec && /^── / { insec=0 }
      insec { buf[n++ % 20]=$0 }
      END { if (n>0) { s=(n>20)?n-20:0; for (i=s; i<n; i++) print "  " buf[i % 20] } }
    ' "$log"
  done <<< "$failed_tests"
fi

if [[ "$stage" == "vite build" ]]; then
  echo ""
  echo "-- vite build errors --"
  grep -A4 -iE "error during build|RollupError|Build failed|^error:" "$log" | head -30
fi

if [[ "$stage" == "docs:check" ]]; then
  echo ""
  echo "-- docs:check output tail --"
  tail -20 "$log"
fi

echo ""
echo "full log: $log"
echo "==============================================="
exit $status
