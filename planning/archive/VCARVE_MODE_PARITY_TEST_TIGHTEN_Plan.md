---
status: Done
created: 2026-05-20
---

# V-carve mode-parity test tightening Plan

## Goal

`testVCarveFeatureFirstProducesSameMoveCount` in [src/engine/toolpaths/toolpaths.test.ts:775](src/engine/toolpaths/toolpaths.test.ts:775) currently asserts only that `level_first` and `feature_first` v-carve produce the **same number** of cut moves for two disjoint identical features. A regression that emits the same count but with completely wrong XY/Z values would pass undetected.

Tighten the test so it actually verifies that `feature_first` is a **reordering** of `level_first`, not just an equal-cardinality move set. This brings v-carve parity coverage up to the level the pocket tests already provide (`testPocketSingleFeatureParity` uses `movesEqual` for full content comparison; the equivalent pocket multi-feature ordering tests at least cluster moves by XY pivot to spot-check per-feature content).

## Approach

For two disjoint identical features A (at x=0..10) and B (at x=30..10), the invariant is:

> The multiset of cut moves produced by `level_first` equals the multiset produced by `feature_first`. Only the order differs.

Plan:

1. Cluster `cutMoves(rLevel.moves)` and `cutMoves(rFeature.moves)` each into per-feature groups using the existing `cutZsByFeatureCluster`-style pivot at `x = 20` (midpoint between A and B). For each result, that yields a "left feature" cut list and a "right feature" cut list.
2. Within each per-feature group, sort cuts by `(from.x, from.y, from.z, to.x, to.y, to.z)` and compare the sorted sequences across modes using `approx` per coordinate. If both `level_first.left == feature_first.left` and `level_first.right == feature_first.right` (modulo sort), the parity invariant holds.
3. Keep the existing equal-cardinality check as a fast pre-condition (cheaper to fail with a clearer message when counts differ).
4. Additionally assert that **`feature_first` produces contiguous per-feature blocks** — i.e. there's a single XY-cluster boundary crossing in the move sequence. `level_first` should have ≥2 boundary crossings (one per Z level). This guards the actual ordering semantic, complementing the content parity check.

The implementation is test-only: add a small `sortedMovesByXYZ(moves)` helper in the test file (or inline in the test), reuse `cutZsByFeatureCluster`'s pivot pattern, and replace the single count assertion with the multi-step parity check.

## Files affected

- `src/engine/toolpaths/toolpaths.test.ts` — replace `testVCarveFeatureFirstProducesSameMoveCount` body with the tighter parity check (rename to `testVCarveFeatureFirstIsLevelFirstReordering` for accuracy); add a small `sortedCutMoves` helper if it makes the assertion cleaner. Update the driver call at line 950 to match the new name.

No engine-code changes. No changes to `scripts/run-tests.ts`.

## Tests

- The renamed test must pass (verifies v-carve really does produce the same multiset of cut moves across modes for the two-disjoint-features case).
- All other tests in `toolpaths.test.ts` must continue to pass — driver runs the full suite.
- `npm test` (all 16 test files) must remain green; `npm run build` must end green.

If the tightened assertion **fails** on `main`, that's a real v-carve bug (mode-parity broken at the content level) — surface it as a finding and we'll decide whether to fix the engine or relax the assertion before re-planning.

## Open questions / risks

- **Sort tiebreak ambiguity.** If two different cut moves happen to land at exactly the same `from`/`to` coordinates (e.g. a retract-and-re-cut), the sort comparison can't distinguish them — but multiset equality is unaffected (both modes would produce both copies). Low risk.
- **Floating-point tolerance.** Use `approx` (the file's existing 1e-6 helper) per coordinate, not strict equality. V-carve depth calculations have already-known FP variability.
- **Test runtime.** Sorting two move lists of ~hundreds of entries is negligible. No perf concern.

## Out of scope

These were flagged in the same test review but each warrants its own decision and should not bloat this plan:

- `testFollowLineRegionClipsOpenPath` (line 904) — asymmetric `from.x >= 2 && to.x <= 6` bound check that misses some buggy patterns.
- `testEdgeOutsideClipsAroundNonSelectedAddFeatures` (line 754) — only inspects `move.to`, not `move.from`.
- `testEdgeOutsideAcceptsModelSilhouette` (line 621) — `cuts.some(...)` is too weak; one valid cut passes the whole assertion.
- `testPocketFeatureFirstOrder` (line 418–426) — `length / 2` bisection assumes a 50/50 move split between features (fragile).
- `testMergeToolpathResults` (line 333) — "warnings concatenated" assertion not actually exercised because partB has no warnings.
- `testPocketRestRegionsFindUnreachableArea` (line 510) — smoke-test only; doesn't check rest-region location.

Engine-code changes of any kind. Other test files outside `toolpaths.test.ts`.
