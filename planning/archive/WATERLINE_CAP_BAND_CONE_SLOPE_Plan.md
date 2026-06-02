---
status: Abandoned
created: 2026-06-01
---

> **Abandoned 2026-06-01.** Implementing the approach made the cone and OldMan visibly *worse* in the simulator: descending the cap to the bilinearly-sampled cone-tangent introduced (1) the documented bumpy-texture trade-off on band fills once the band's `upper.z` reference also moves onto a sampled-Z source, and (2) tiny gouges along the band annulus because bilinear interpolation of cell-max-take values can dip below the true safe-tool-tip-Z (the contribution function is convex in d). User opted to revert to the plateau-fix commit and pursue a different approach (micro-Z step-up).


# Waterline Cap-Band Cone-Slope Match Plan

## Goal

Make the projected cap on a steep tip carve at the cone's actual slope (e.g. `0.5` on `work/Cone.camj`), not the shallower linear-ramp slope (`0.333` on this cone). User-visible outcome: the cone tip in the simulator has the *same* slope as the rest of the cone — no visible "shoulder" where the cap meets the band fill, no visible plateau at the apex.

## Approach

The linear-ramp slope is `(peakZ − tipZ) / maxInsetDistance`. On `work/Cone.camj`, `maxInsetDistance = 0.18` (cap base ring radius), but the cone surface only rises across the slice's inradius (`0.12`, i.e. `maxInsetDistance − toolOffset`). The extra `toolOffset` of cap span is the *outer annulus*, sitting outside the slice footprint, where the cone surface is below `tipZ`. Either the ramp dilutes (current, shallow slope) or the cap ring drops below `tipZ` and breaks the cap↔band join.

The fix is two changes that move in lock-step:

1. **Cap stops flooring at the linear ramp.** `processTipPath`'s `projectZAtPoint` becomes just the upper-clamped sampled value (`min(effectivePeakZ, sampled)`), no `max(linearRamp, …)`. On the cone the outermost cap ring descends to the cone-tangent `≈ 1.6658` at `r = 0.182` — the natural ball-roll envelope — instead of clamping back up to `tipZ`. Inside the slice the sampled value is *above* tipZ and the slope naturally matches the cone (≈ 0.5).

2. **Band fill's inner Z reference follows the cap's outer ring.** `projectedBandZAtPoint` currently interpolates between `upper.z` (= coarse level z = `tipZ`) at the inner contour and `lower.z` at the outer. For bands whose upper contour was suppressed by a cap (i.e. there *is* a cap above this band), override `localUpper.z` with the sampled cone-tangent Z at the upper contour — the same value the cap's outer ring just descended to. Detection: `matchedUpperPaths` intersected with `suppressedCoarsePaths`. The override value is a representative sampled Z taken at a small number of vertices around the upper contour (≈ 8 samples, take the **min** so we never set `upper.z` above what the cap actually reaches — guarantees the cap↔band Z step is ≤ 0).

For non-cap bands `localUpper.z` is unchanged, so the existing band-fill linear-interp behaviour and the documented bumpy-texture trade-off stay exactly as before.

### Why this doesn't gouge

On the cone, with the override the band interpolates between `1.6658` at the inner contour (`r = 0.18`) and `1.63` at the outer contour (`r = 0.2625`). The cone-tangent (safe tool-tip Z) envelope at `r = 0.20` is `1.6574`; the linear interpolation gives `1.6577`. Above tangent — no gouge. Same check at `r = 0.22`: tangent `1.6474` vs linear `1.6484`. Above. The linear interp stays barely above the cone-tangent envelope throughout the annulus because the line from `(0.18, 1.6658)` to `(0.2625, 1.63)` has slope `≈ 0.443`, which is **shallower** than the cone slope `0.5` — so it tracks above the cone all the way. (If a future model has a band where the linear interp would dip below cone-tangent, the per-vertex projection in `projectedBandZAtPoint` could be additionally upper-clamped by the sampled value — but we're not doing that pre-emptively; we'll let the regression tests catch it if it shows up.)

### Why this doesn't reintroduce the band-fill bumpiness

The override is a single value per band (the min of ≈ 8 boundary samples), not a per-vertex heightmap query inside the band. The band's per-vertex Z still uses the smooth linear interpolation between `(new upper.z, contour at boundary)` and `(lower.z, lower contour at boundary)` — only the *endpoint* shifts. No new per-vertex sampling inside the band region.

## Files affected

- `src/engine/toolpaths/finishSurfaceWaterline.ts`
  - `processTipPath` → `projectZAtPoint`: remove the `max(linearZ, sampled)` floor. Use `min(upper, sampled)`.
  - Band-fill loop (around line 905+): compute `overriddenUpperZ` once per band when any of `matchedUpperPaths` is in `suppressedCoarsePaths`. Build `localUpper` with `z: overriddenUpperZ ?? upper.z`. Also compute the band ring's representative `z` from the same overridden value.
  - Small helper `representativeSampledZAlongPaths(paths, surfaceZAt, sampleCount)` — sample `safeToolTipZAt` (via the bilinear sampler already exposed as `surfaceZAt`) at `sampleCount` equally-spaced vertices around each path's contour, return the **min**. Returns `null` if no sample resolves.
- `src/engine/toolpaths/finishSurface.test.ts`
  - New `testWaterlineBandUpperZTracksCapWhenSuppressed` synthetic test: a topmost-level tip whose `safeToolTipZAt` at the cap base ring is below `tipZ`. Run `generateProjectedWaterlineLevels`. Assert: (a) the outermost cap ring's per-vertex projected Z is below `tipZ`, (b) the next band level's `z` is at the same value as that outermost cap ring (within epsilon), and (c) the band's per-vertex projected Z at its inner contour is below `tipZ` (matching the cap).
  - Existing `testWaterlineTipCapOuterRingsClimbAlongLinearRamp` will need to be updated — the boundary ring no longer sits at `tipZ`, it sits at the sampled cone-tangent. Assertion shifts from "outermost = tipZ" to "outermost = sampled at boundary, and the next band ring's z matches".
  - Existing pyramid integration test and round-cap test should still pass — the inner-cap ball-wrap dome is unchanged.
- `planning/WATERLINE_CAP_BAND_CONE_SLOPE_Plan.md` — this plan, will `git mv` to `archive/` when verified.

## Tests

- New unit test as described above.
- Adjusted assertions in `testWaterlineTipCapOuterRingsClimbAlongLinearRamp`.
- `npm run build` (which runs `npm test`) green.
- User verifies in the simulator on `work/Cone.camj` that the cap slope matches the cone slope visually, with no visible ledge at the cap↔band boundary.
- Spot-check `work/Old-man-simple.camj` and `work/old-man-in-box.camj` — multi-tip case. Each tip's band gets its own override; expect each cap↔band boundary to remain joined.

## Open questions / risks

- **Non-symmetric tips**: the override is a single min-of-samples value per band. For a tip whose cap base ring has significantly varying sampled Z around its perimeter (e.g. OldMan nose: tip is asymmetric), the band's inner Z is held at the minimum, so the *higher* side of the band has a small upward step at the cap↔band boundary instead of being flat. The step is bounded by the variation in sampled Z around the cap perimeter — small in practice. Flagged for verification on OldMan.
- **A band shared between a suppressed and a non-suppressed upper path**: if `matchedUpperPaths` mixes cap-suppressed and non-suppressed paths (e.g. one cap and one regular contour both matched to the same lower path), overriding `upper.z` globally for that band would lower the non-cap region too. Mitigation: only override when **all** matched upper paths are suppressed. If mixed, fall back to original `upper.z`. (Probably rare in practice.)
- **Band level's representative `z`**: the band's `z` (used by the column walker for ordering) currently equals the band ring's per-vertex average per the formula `lower.z + (upper.z − lower.z) * (distance / gap)`. After override, this value drops, which is correct — the band ring sits at lower Z so it should be ordered closer to the cap rings. No change needed to the column walker.

## Out of scope

- Replacing band-fill Z source with the heightmap *inside* the band region — keeps the documented bumpy-texture risk at bay.
- Per-vertex Z on the cap's outer ring being passed verbatim to the band — useful for asymmetric tips but adds plumbing; deferred until the symmetric-case fix is verified.
- The natural ball-wrap dome at the very apex (≈ 0.007" tall on this cone) — still a geometric consequence of the ball radius. Issue #127 acceptance accepts a "smooth dome" at the peak.
- Intersecting-add wall cleanup, region-feature handling — separate follow-ups.
