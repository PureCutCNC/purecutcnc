---
status: Done
created: 2026-05-20
---

# Edge-route-outside obstacle-clip regression Plan

## Goal

The regression test `testEdgeOutsideClipsAroundNonSelectedAddFeatures` in [src/engine/toolpaths/toolpaths.test.ts:730](src/engine/toolpaths/toolpaths.test.ts:730) (added by commit `89f4e70`) currently fails on `main` with:

```
Assertion failed: expected no cuts inside featureB keep-away zone, got 3 (first at x=10.00, y=12.00)
```

The test asserts that when `edge_route_outside` runs on featureA (an `add` rect at x=0..10), a second non-selected `add` rect featureB (at x=12..22, with featureA→featureB gap 2mm < tool diameter 4mm) is treated as an obstacle and no cut move's tool centre enters featureB's keep-away zone (featureB expanded by tool.radius=2 ⇒ x ≥ 10, y ∈ [−2, 12]).

We need to restore the invariant either by fixing the obstacle-clip pipeline in `edge.ts`/`regions.ts` so the test passes, or — if investigation shows the test's expectation is mis-specified — by correcting the test to assert the actually-intended behaviour. The former is the expected outcome; the latter is the fall-back if the test geometry is provably wrong.

## Approach

1. **Reproduce in isolation** with `npx tsx src/engine/toolpaths/toolpaths.test.ts`. (Confirmed already — assertion fires with `violatingCuts.length === 3`, first cut at `x=10.00, y=12.00`.)
2. **Narrow which step of the clip pipeline fails.** Add temporary `console.log`s (or a one-off scratch script under `scripts/`) to print:
   - `allAdditiveObstacles.length` and each obstacle's `span` and path count at [src/engine/toolpaths/edge.ts:499](src/engine/toolpaths/edge.ts:499)
   - the set of distinct `move.to.z` values that reach `clipToolpathResultToObstaclesByLevel` at [src/engine/toolpaths/regions.ts:289](src/engine/toolpaths/regions.ts:289)
   - whether `obstacleMaskForZ(z)` returns null vs a mask for each of those z values
   - how many fragments `clipCutMoveToRegion(move, inverseMask)` returns for the three violating cuts
3. **Form a hypothesis.** Likely candidates, in order of suspicion:
   - **a.** `expandFeatureGeometry(featureB)` does not yield featureB for `operation: 'add'` + `kind: 'rect'`, so featureB never lands in `allAdditiveObstacles`. The `89f4e70` filter at [edge.ts:500–501](src/engine/toolpaths/edge.ts:500) only includes a non-model feature via `expandFeatureGeometry`; if that helper is text-/path-feature-oriented it may return `[]` for plain rect adds.
   - **b.** Z-span gate `z <= span.max && z >= span.min` at [edge.ts:514](src/engine/toolpaths/edge.ts:514) excludes the levels where cuts actually land (e.g. `z = top` exact-equal vs floating-point drift, or step levels falling outside `[0, 6]`).
   - **c.** `clipCutMoveToRegion` with the inverse mask doesn't actually subtract the obstacle (mask construction via `buildMaskFromClipperPaths` may keep `pointInClipperPaths` semantics rather than path-difference geometry for the cut segment clip).
   - **d.** The contour combination path (line 537+) is being taken when only one target is selected — should not be, but worth confirming `shouldAttemptCombinedOutside` is `false` here.
4. **Fix at the root.** Apply the minimal change in `edge.ts` and/or `regions.ts` that restores the invariant. Concretely, if (a) is the cause, broaden the obstacle-collection branch to include the raw feature when it has closed geometry (mirror the `'model'` branch). If (b), align the Z gate with how levels are generated (`generateStepLevels` semantics) — likely needs an epsilon or inclusive-bound check. If (c), drive `clipCutMoveToRegion` with the obstacle paths directly rather than a point-containment mask, or use a Clipper segment-difference.
5. **Re-run the test file** end-to-end; ensure every test in `toolpaths.test.ts` still passes, not just the regression.
6. **Confirm no behaviour regressions for the common case** (single feature, no neighbour) by inspecting the existing `edge_route_outside accepts model silhouette` / `stored silhouette` / `tiny stored silhouette artifacts` tests, which all run on a single feature and should be unaffected.

## Files affected

- `src/engine/toolpaths/edge.ts` — likely root cause sits in the `allAdditiveObstacles` collection (lines 498–506) or the `obstacleMaskForZ` Z gate (lines 508–522). Change to be determined after step 3 above.
- `src/engine/toolpaths/regions.ts` — possibly: tighten `clipToolpathResultToObstaclesByLevel` (lines 289–337) and/or `buildMaskFromClipperPaths` (lines 106–112) if the mask semantics turn out to be the bug.
- `src/engine/toolpaths/toolpaths.test.ts` — only touched if investigation shows the test geometry is wrong (e.g. asserts a stricter invariant than the algorithm can deliver). Default expectation: no change.
- `scripts/run-tests.ts` — remove `'src/engine/toolpaths/toolpaths.test.ts'` from the `KNOWN_FAILING_TESTS` set once the test passes. This file was added on `main` in commit `a85056c` (PR #93) after the initial task brief was written; the fast-forward pulled it in cleanly. `npm run build` now runs `npm test` between `tsc -b` and `vite build`, so removing the skip and getting `npm run build` green is the end-to-end verification.

## Tests

- The fix is itself a test-driven repair: `testEdgeOutsideClipsAroundNonSelectedAddFeatures` (lines 730–766) must pass with the existing assertions unchanged.
- All other tests in `toolpaths.test.ts` must continue to pass (the file's `main` driver at line 946 runs the full suite).
- If during investigation we discover a related uncovered case — e.g. obstacle whose Z range partly overlaps the cut's Z range, or a `kind: 'model'` neighbour — add one further targeted test in the same file. Do not expand scope beyond that.
- After removing the `KNOWN_FAILING_TESTS` entry, `npm test` must discover and run every `src/**/*.test.ts` file (not just the toolpaths file) without failure, and `npm run build` must end green.

## Open questions / risks

- **Risk: changing obstacle semantics affects other edge-route call sites.** `edge_route_outside` is the only kind that clips against obstacles today, but `generateEdgeRouteToolpathSingle` is shared with `edge_route_inside`. The obstacle clip is only invoked when `allAdditiveObstacles.length > 0` (line 591), so inside-edge routes should be unaffected — to be confirmed by running the full test file.
- **Question for the user:** if root-cause turns out to be `expandFeatureGeometry` deliberately excluding plain `add` rect features (e.g. because text-related callers rely on that), is it OK to add a separate obstacle-collection path in `edge.ts` rather than altering `expandFeatureGeometry`'s contract? I'll flag this before changing shared helpers.

## Out of scope

- Any change to the `scripts/run-tests.ts` harness itself beyond removing the one `KNOWN_FAILING_TESTS` entry.
- Any change to `edge_route_inside` behaviour.
- Any change to how obstacles are visualised in the canvas or 3D preview.
- Performance work on the obstacle-mask cache (it caches by `z.toFixed(9)`, which is fine for the test and for typical step-level counts).
- Fixing any other test files that `npm test` may surface as failing once the toolpaths file is re-enabled (would be handled under a separate plan).
