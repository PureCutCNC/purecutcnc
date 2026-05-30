---
status: Draft
created: 2026-05-30
---

# Waterline Tip-Cap Quality Plan

## Goal

Eliminate the visibly poor surface quality at the tops of islands produced by the adaptive waterline finish strategy — the concentric ring banding on the cone apex and the terraced/scaly texture on the OldMan nose tip, chin, and forehead (issue #127). The user-visible outcome is that convex island peaks render as smooth domes in the simulator at typical stepovers, while band-fill surface elsewhere is unchanged. The fix stays local to `processTipPath` and its inputs — band fills, intersecting-add wall cleanup, and the overall waterline pipeline are out of scope.

## Approach

Three coordinated changes inside `generateProjectedWaterlineLevels` / `processTipPath` in `src/engine/toolpaths/finishSurfaceWaterline.ts`. None of them touch the band-fill path.

1. **Re-derive the outermost tip-cap ring from the raw mesh slice with round joins.**
   - Today `tipPath` comes from `buildWaterlineLevels`, which `offsetClipperPaths(shadow, toolOffset)` with miter joins on the cumulative shadow. The outermost cap ring inherits that miter polygon (a 4-corner rectangle on a small nose tip / a coarse polygon on a cone) and all subsequent inset rings shrink from it.
   - `coarseBuild.sliceMaterialByZ` already holds the raw mesh slice paths at `tipZ`. In `processTipPath`, look up the slice material that overlaps `tipPath` (centroid-in-polygon or bbox-overlap match against `sliceMaterialByZ.get(tipZ)`) and re-derive the outermost ring by `offsetClipperPathsRound(matchedSlice, toolOffset)`. Use this re-derived ring as both the suppression target and the first inset source. Fall back to the existing `tipPath` if no slice match is found (defensive — keeps current behaviour for unusual topologies).
   - Net effect: the outermost cap ring is round, not polygonal. All inset rings shrink off a smooth boundary.

2. **Raise `peakZ` to the actual sampled mesh peak inside the cap footprint.**
   - Today `peakZ = higher.z` (or `upper.z` on the topmost level), so on a sharp cone or nose the clamp keeps interior rings stuck a full coarse-step below the true peak — producing a flat plateau / final ring at `higher.z`.
   - Sample `surfaceZAt` at a small grid of points inside `tipPath`'s bounding box (filter to points actually inside the polygon via `pointInClipperPaths`). Take the max finite sample as `sampledPeakZ`. Use `peakZ = Math.min(higherZBound, Math.max(tipZ, sampledPeakZ))` where `higherZBound = higher ? higher.z : stockTopZ` (or `upper.z` when neither is available — preserves today's topmost-level behaviour as the ceiling, never below). This raises the Z ceiling on sharp tips while still capping at the next coarse rim so we never cut above an already-finished surface.
   - Keep the existing `[tipZ, peakZ]` clamp inside `projectZAtPoint`; only the bound changes.

3. **Bilinearly interpolate `safeToolTipZAt` for tip-cap surface sampling.**
   - Today `surfaceZAt` calls `safeToolTipZAt` directly, which returns the single most-constraining cell's kinematic-safe tip Z. Tiny lateral motion changes which neighbor cell wins → staircase texture, and on rotationally symmetric features (cone) the grid alignment shows as concentric ring banding.
   - Introduce a tip-cap-only `surfaceZAtBilinear` that evaluates `safeToolTipZAt` at the four nearest cell *centers* surrounding the query point and bilinearly blends the four results. This adds 4× cost per sample but is only invoked on tip-cap rings (small XY footprint, modest sample count). The cost is bounded.
   - Keep the existing call site for band fills unchanged — band fills don't use `surfaceZAt`, they use linear `projectedBandZAtPoint`, so no risk of band-fill regressions.
   - Wire the bilinear sampler into `processTipPath` by passing it instead of the raw `surfaceZAt`. The simplest path is to add a second optional sampler argument `surfaceZAtSmooth` to `generateProjectedWaterlineLevels` and have `generateFinishSurfaceWaterline` build it next to the existing `surfaceZAt`.

Suggested directions from the issue that are **not** taken here, with brief reasoning:

- *Per-ring representative Z from sampled profile* — leaving column ordering on the linear estimate. The three changes above already give monotonically rising sampled Z from outer to inner rings, so the linear-estimate sort still produces the right top-down order. Revisit if a regression test on a saddle case shows order inversions.
- *Densify rings near the collapse point* — change 1 already smooths the outer ring; with rounder insets the near-collapse stack tends to disappear. Revisit only if cone/nose still shows a stack after the three changes land.
- *Selectively apply heightmap correction only where it disagrees with the linear ramp* — the band-fill plan call-out in `WATERLINE_ADAPTIVE_REFINEMENT_Plan.md`. Out of scope here.

## Files affected

- `src/engine/toolpaths/finishSurfaceWaterline.ts`
  - Add `surfaceZAtSmooth` sampler (bilinear blend over four `safeToolTipZAt` cell-center evaluations). Used only inside `processTipPath`.
  - `processTipPath`: look up the matching raw mesh slice path from `sliceMaterialByZ` and use `offsetClipperPathsRound(..., toolOffset)` for the outermost cap ring, replacing the miter-derived `tipPath` as the inset source. Suppression still targets the original `tipPath`. Defensive fallback to `tipPath` if no slice match.
  - `processTipPath`: estimate `sampledPeakZ` inside the cap footprint and use it (clamped to `higher.z` / topmost ceiling) instead of bare `higher.z`.
  - `generateProjectedWaterlineLevels` and the call site in `generateFinishSurfaceWaterline`: thread the new smooth sampler and the toolOffset parameter through to `processTipPath`.
- `src/engine/toolpaths/finishSurface.test.ts`
  - Add a synthetic cone-tip regression test: a tapered cone mesh fixture (or reuse the existing tapered model if it produces tip caps), assert that projected cap rings sampled Z is **monotonically non-decreasing** from outermost to innermost ring (allowing equality at the floor/ceiling clamps).
  - Add an assertion that no two consecutive cap rings cluster within `epsilon` of each other in representative Z (guards the "ring stack near collapse" pattern from regressing).
  - Add an assertion that the outermost cap ring has more than 4 distinct vertices on a small tip (catches re-derived round-join replacement).
- `planning/WATERLINE_TIP_CAP_QUALITY_Plan.md` — this plan. `git mv` to `planning/archive/` on completion per the workflow.

## Tests

Unit-test additions in `src/engine/toolpaths/finishSurface.test.ts`:

- `testWaterlineTipCapZIsMonotonic` — synthetic cone or tapered tip fixture; collect `projectedCap`-sourced cut moves, group them by ring (clustered by representative Z), and assert each successive ring's sampled max Z is `>=` the previous ring's max Z (modulo a small epsilon).
- `testWaterlineTipCapHasNoNearDuplicateRings` — same fixture; assert no two consecutive cap-ring representative Z values are within `1e-3 * (peakZ - tipZ)` of each other.
- `testWaterlineTipCapOutermostRingIsRound` — assert that on a small tip footprint the outermost cap ring (first `projectedCap` ring at the highest Z in its cluster) has > 4 vertices (rejects pure miter-derived rectangle).
- Existing tests (`testWaterlineAdaptivelyRefinesShallowSlope`, `testWaterlineLevelsAreConstantBands`, `testWaterlineReachesModelTop`, the disabled/limit tests, all OldMan-style intersecting-add tests) must continue to pass without modification.

Build verification: `npm run build` after implementation. The structural test suite runs as part of the build.

## Open questions / risks

- **Heightmap cell size is not refined.** The bilinear interpolation softens the quantization but doesn't eliminate it. If the cone apex still shows residual ring banding after bilinear sampling, the follow-up is a locally refined heightmap inside tip-cap bounding boxes. Calling that out so reviewers don't expect a single-pass cure-all on extreme cases.
- **`sampledPeakZ` could read above `higher.z` on a noisy heightmap near the cap rim.** The hard clamp to `min(sampledPeakZ, higher.z)` (or `stockTop` on the topmost level) keeps the ceiling safe — we never raise above an already-finished coarse rim. This is the same safety the existing `[tipZ, peakZ]` per-vertex clamp relies on.
- **The outermost-ring re-derivation needs a slice-match. **On a model with multiple unrelated tip islands at the same Z, we must pick the slice path that corresponds to *this* tip — not all slices at the same Z. The match strategy (centroid of `tipPath` inside the slice path, with bbox-overlap fallback) is straightforward but worth testing on the OldMan fixture, which has multiple convex peaks at similar Z. Defensive fallback to `tipPath` keeps current behaviour if the match fails.
- **No new performance budget.** Bilinear sampling is 4× per query but only on tip-cap rings (small footprints); slice-match is per tip path (a few tips per model). Tested on OldMan during implementation to confirm no measurable slowdown.

## Out of scope

- Band-fill Z source — band fills stay on the existing linear `projectedBandZAtPoint`, per the explicit tradeoff documented in `WATERLINE_ADAPTIVE_REFINEMENT_Plan.md`.
- Intersecting-add wall cleanup — separate follow-up in `WATERLINE_ADAPTIVE_REFINEMENT_Plan.md`.
- Renaming or restructuring the waterline operation, or any UI changes.
- A true 3D constant-scallop / constant-cusp algorithm.
- Reducing the global heightmap cell size or building a locally refined heightmap for tip caps (mentioned in Open questions as a follow-up only if residual banding remains).
- Per-ring representative-Z replacement and ring densification near collapse (listed in the issue's suggested directions but skipped here for the reasons in the Approach section).
