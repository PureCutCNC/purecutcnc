---
status: Abandoned
created: 2026-05-30
---

> **Abandoned 2026-06-01.** Implementing the proposed change (removing the `tipZ` lower-clamp) introduced a visible ring step at the cap↔band interface on `work/Cone.camj` — the cap's outermost ring sits at the same XY radius as the band fill's inner ring, and both need to meet at the same `tipZ` for the join to be flat. The original lower-clamp at `tipZ` was load-bearing for this reason; the "flat ledges at outer cap" I identified in diagnosis were not a real artefact, they were the natural cap↔band join. The user's reported visible ring near the cone apex (issue #127) is a *different* defect that this plan did not address. Leaving the original code intact.


# Waterline Tip-Cap Ledge Fix Plan

## Goal

Eliminate the flat ledges at the outer edge of waterline tip caps that the prior tip-cap quality fix (`f4bbb72`, issue #127) failed to remove. On `work/Cone.camj` the cone apex still shows three concentric cap rings stacked at `z = tipZ` (the topmost-with-material coarse slice z) instead of following the cone surface down. On `work/Old-man-simple.camj` the same artefact produces multiple flat rings at the head's slice z. User-visible outcome: convex tips render without those concentric ledges in the simulator.

## Approach

The root cause sits in `processTipPath` (`src/engine/toolpaths/finishSurfaceWaterline.ts:803-812`). `projectZAtPoint` clamps the bilinearly-sampled safe tool-tip Z into `[tipZ, effectivePeakZ]`. The cap base ring is built from the raw mesh slice expanded by `toolOffset`, so it extends *outside* the slice footprint at `tipZ`. At those outer XY positions the true surface (and the kinematic-safe tool-tip Z) is naturally **below** `tipZ`, but the lower clamp forces those vertices back up to `tipZ`. Reproduced on Cone via `scripts/diagnose-cone-tipcap.ts`:

```
ring 9: half-extent 0.182  sampled=1.6658  cut z=1.6900 (clamped)
ring 8: half-extent 0.162  sampled=1.6768  cut z=1.6900 (clamped)
ring 7: half-extent 0.142  sampled=1.6869  cut z=1.6900 (clamped)
ring 6: half-extent 0.122  sampled=1.6970  cut z=1.6957..1.6962 (no clamp)
```

Fix: drop the `tipZ` lower bound in the cap's per-vertex Z clamp. Keep the upper clamp at `effectivePeakZ` (it still protects against noisy samples driving the cut above an already-finished higher coarse rim). The safe tool-tip Z is by construction kinematically safe — if it's below `tipZ` at a point, the surface is genuinely lower there and cutting at that Z is correct. There is no band-fill conflict: the cap's outer ring exactly meets the band-fill's inner contour at the same XY radius, and band fills below `tipZ` live in the annulus outside the cap. The previously suppressed coarse ring at `tipZ` was already replaced by the cap rings, so we are not overwriting any other pass.

For the linear fallback (only used when `surfaceZAt` returns `null` for a vertex), keep the existing `tipZ + (d/denom)*zSpan` projection — it bottoms out at `tipZ` at the outer boundary, which is fine for the fallback case. The change is only in the heightmap-sampled branch.

## Files affected

- `src/engine/toolpaths/finishSurfaceWaterline.ts` — in `processTipPath`'s `projectZAtPoint`, remove the lower-clamp at `tipZ` for the sampled branch. The upper clamp at `effectivePeakZ` stays. Updates the inline comment to describe the new contract.
- `src/engine/toolpaths/finishSurface.test.ts` — extend the existing tip-cap monotonicity test to also assert that the outer cap rings on a cone fixture descend below `tipZ` (matching the cone surface) rather than stacking at `tipZ`.
- *(new)* `scripts/diagnose-cone-tipcap.ts` — small repro script kept for future tip-cap debugging. Loads a project, runs the waterline finish, prints per-ring `projectedCap` z/extent. Already proven useful for this investigation.

## Tests

- New assertion in `finishSurface.test.ts` on the existing cone-tip / pyramid synthetic fixture: the outermost projected cap ring's max z is strictly less than `tipZ` (it must follow the surface down), and no two consecutive outer cap rings cluster within epsilon at exactly `tipZ`.
- Existing `testWaterlineTipCapZIsMonotonic`, `testWaterlineTipCapHasNoNearDuplicateRings`, and `testWaterlineTipCapOutermostRingIsRound` must continue to pass — the monotonicity assertion is unchanged (rings still climb from outer to inner), only the absolute floor moves down.
- `npm run build` (which runs the full structural test suite) green before commit.

## Open questions / risks

- **Could relaxing the lower clamp let a noisy heightmap sample drive a cut implausibly low?** The sampled Z is `safeToolTipZAt` — by construction the most-constraining of the surrounding cells. It cannot go below the true surface, only above. The risk is the other direction (cutting too high), already handled by `effectivePeakZ`. Net risk is low.
- **Could outer cap rings now collide with band fills?** No — the cap's outer ring is at exactly `slice + toolOffset` (the band's inner contour). Cap rings extend inward from there; band fills outward. The two domains are disjoint in XY and there is no annulus that both touch.
- **OldMan multi-tip behaviour.** The diagnostic showed 23 cap rings across multiple convex peaks (nose, forehead, chin). The lower-clamp removal applies uniformly per-tip — no per-tip special-casing needed. Visual verification on `work/Old-man-simple.camj` after the fix lands.

## Out of scope

- The per-ring scallop spacing between cap rings (already adequate with `microStepover=0.02` and a 1/16" ball — geometric scallop height ≈ 0.001").
- Band-fill Z source — still linear `projectedBandZAtPoint`, per the original adaptive plan.
- Smooth-spiral / helical cap descent — a true "smooth dome" would require swapping concentric rings for a 3D spiral, a much bigger redesign and not required by the acceptance criteria.
- Heightmap cell-size refinement — current 0.01" cells already exceed the cap's needs at the chosen stepover.
