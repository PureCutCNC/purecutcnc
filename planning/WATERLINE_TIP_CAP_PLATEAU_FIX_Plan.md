---
status: In progress
created: 2026-06-01
---

# Waterline Tip-Cap Plateau Fix Plan

## Goal

Remove the visible concentric ring/plateau at the first-step-down Z level (`tipZ`) on convex tips — the artefact in `work/Cone.camj` that the prior `f4bbb72` change did not address. User-visible outcome: the cone tip renders without a flat shelf at `z = 1.69` (the topmost-with-material coarse z); cap rings climb smoothly from the cap-band boundary toward the apex instead of stacking flat at `tipZ`.

## Approach

The bug lives in `processTipPath`'s `projectZAtPoint` ([src/engine/toolpaths/finishSurfaceWaterline.ts:803](src/engine/toolpaths/finishSurfaceWaterline.ts:803)). The cap base ring is `slice + toolOffset`, so its outer annulus (between the slice radius and the cap base radius) sits *outside* the slice footprint, where the cone surface — and therefore the bilinearly-sampled `safeToolTipZAt` — is **below** `tipZ`. The current code clamps these vertices back up to `tipZ`, which produces a flat plateau of rings all at `z = tipZ`. Visually that plateau is the concentric ring the user is pointing at, sitting at the "first step down" z level. The earlier attempt (removing the lower clamp entirely) traded the plateau for a worse defect — the cap dove below the band fill's inner Z and produced a *step* at the cap-band boundary instead.

The fix replaces the floor at `tipZ` with a floor at the **linear ramp** that already exists as the off-mesh fallback:

```
linearProjection(point) = tipZ + min(1, d/maxInsetDistance) * (effectivePeakZ − tipZ)
```

where `d` is the distance from the cap base ring boundary. This ramp is exactly `tipZ` at the boundary (so the cap↔band join stays flat — the regression my prior change caused does not return) and climbs to `effectivePeakZ` at the centre. Concretely: change the final return in `projectZAtPoint` from `min(upper, max(tipZ, sampled))` to `min(upper, max(linearProjection(point), sampled))`.

What this gives, on the Cone fixture (currently 10 rings):

| ring | r     | current z (clamped at tipZ) | after fix (max(linear, sampled)) |
|------|-------|-----------------------------|----------------------------------|
| 9    | 0.182 | 1.6900 (clamp floor)        | 1.6900 (linear at boundary)      |
| 8    | 0.162 | 1.6900 (clamp floor)        | 1.6967 (linear)                  |
| 7    | 0.142 | 1.6900 (clamp floor)        | 1.7033 (linear)                  |
| 6    | 0.122 | 1.6957 (sampled)            | 1.7100 (linear > sampled)        |
| 5    | 0.102 | 1.7058 (sampled)            | 1.7167 (linear > sampled)        |
| 4    | 0.082 | 1.7158 (sampled)            | 1.7233 (linear > sampled)        |
| 3    | 0.062 | 1.7258 (sampled)            | 1.7300 (linear > sampled)        |
| 2    | 0.042 | 1.7363 (sampled)            | 1.7367 (linear > sampled)        |
| 1    | 0.022 | 1.7457 (sampled)            | 1.7457 (sampled > linear)        |
| 0    | 0.002 | 1.7499 (sampled)            | 1.7499 (sampled > linear)        |

Plateau gone. The inner cap (rings 0, 1) still uses the sampled ball-wrap value (preserves the natural dome at the apex). The outer cap rises along a straight ramp to the boundary. The cap↔band boundary is exactly `tipZ` at ring 9, matching the band fill's inner edge.

Trade-off (called out so we're honest about it): on a tip whose cone-roll envelope drops faster than the linear ramp's slope (most steep tips), the cap now leaves slightly more stock above the cone surface than a perfectly cone-tangent path would. The previous behaviour left even more stock (everything in the plateau region). The cone surface is still finished by the band fill below, which already accepts this trade-off per `WATERLINE_ADAPTIVE_REFINEMENT_Plan.md`. Cusp height across the outer cap is now governed by the linear-ramp slope rather than ball kinematics; smaller stepover would tighten this if needed.

## Files affected

- `src/engine/toolpaths/finishSurfaceWaterline.ts` — change the floor in `projectZAtPoint` from `tipZ` to `linearProjection(point)`. Update the inline comment to document both why we need a floor (band-join preservation) and why it needs to climb (plateau elimination).

## Tests

- New unit-test case in `src/engine/toolpaths/finishSurface.test.ts` next to the existing tip-cap tests: build a synthetic cone-like fixture (the existing `makeSquareCcwContour` helper plus a `surfaceZAt` that drops below `tipZ` outside the slice footprint, mirroring the real `Cone.camj` situation), run `generateProjectedWaterlineLevels`, and assert:
  1. The outermost cap ring's per-vertex Z is exactly `tipZ` (boundary preserved → band join flat).
  2. No two consecutive cap rings have the same representative Z (plateau gone).
  3. The cap ring Z values are monotonically non-decreasing from outermost to innermost.
- Existing `testWaterlineTipCapRingsClimbAndAreRound` and `testWaterlineTipCapClimbsToApexOnPyramid` must continue to pass — the apex climb behaviour is unchanged (sampled value still wins where it exceeds the linear ramp, which is the inner-cap dome region).
- `npm run build` (which runs the full structural test suite) green before commit.
- User verification on `work/Cone.camj` and `work/Old-man-simple.camj` in the simulator — plateau gone on the cone apex, no new ledge at the cap↔band boundary.

## Open questions / risks

- **Inner cap on a tall sharp tip**: when the sampled safe-tool-tip Z is slightly *below* the linear ramp on a tall sharp tip (because the bilinear sampling can dip across cell boundaries), `max(linear, sampled)` lifts the cap to the linear ramp instead of following the natural dome. Result: marginally more stock at the cap centre. The existing `effectivePeakZ` clamp at the sampled apex still holds the absolute apex Z in place, so the centre never drops below where it is today. Worst case is a small amount of conservatism, not a new defect.
- **OldMan / multi-tip behaviour**: the change is per-tip and uniform; nothing tip-specific changes. The previously-stuck-at-tipZ outer rings on OldMan (rings 7, 8, 9, 17, 18, 19 in the earlier diagnostic) will rise along the linear ramp instead of stacking — same direction of improvement.
- **Non-topmost caps** (`hasHigherLevel = true`): the linear ramp's `effectivePeakZ` is the higher coarse rim, so the cap climbs to that rim. The change is identical in structure for those caps and the band-join still matches at `tipZ`. No special-casing needed.

## Out of scope

- Touching the band-fill Z source — band fills stay on the linear `projectedBandZAtPoint`, per the original adaptive plan.
- The kinematic ball-wrap dome at the very apex (≈0.007" tall on this cone) — that is a geometric consequence of the ball radius and only goes away by changing tool geometry or intentionally over-cutting the apex point. Issue #127's acceptance accepts a "smooth dome" at the peak.
- Reducing the global heightmap cell size or refining sampling — sampling is unchanged, only how its result is combined with the linear ramp.
- Intersecting-add wall cleanup — separate follow-up.
