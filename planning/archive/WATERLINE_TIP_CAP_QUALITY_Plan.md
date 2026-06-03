---
status: Done
created: 2026-05-30
---

# Waterline Tip-Cap Quality Plan

## Goal

Fix issue #127: adaptive waterline tip caps should render smooth convex island peaks instead of producing concentric banding, terraced crowns, or bumpy cap texture. The user-visible target is a smoother cone apex and smoother OldMan nose/chin/forehead tips while preserving the existing band-fill quality elsewhere.

## Approach

- Keep the existing adaptive waterline strategy and focus only on `projectedCap` generation inside `generateProjectedWaterlineLevels`.
- Add a small synthetic cone-style regression fixture/test in `finishSurface.test.ts` so the failure can be measured without relying on large `work/` files or screenshot inspection.
- Improve tip-cap Z projection so caps do not blindly expose heightmap cell quantization:
  - use the first generated stepdown shape as the base for every local top instead of special-casing cone-like topology
  - create real intermediate "tip micro-step" waterline levels upward from that first stepdown, defaulting to half the operation stepdown
  - stop creating tip micro-step levels when the sliced/offset shape collapses into air above the island
  - feed those real intermediate contours through the same projected-band interpolation used between regular waterline levels
- Handle split/merge tip stacks generically: if one active micro-level branch disappears while another island continues upward, emit inward projected cap rings for the disappearing branch instead of dropping it.
- Keep generated toolpaths readable in the preview by emitting each column's real waterline boundaries before the generated projected fill rings.
- Reduce safe-Z round trips inside each waterline column by allowing short direct cut links between successive nearby rings, bounded by the adaptive stepover and disabled across protected clipped breaks.
- If the first-slice boundary remains visibly polygonal after the Z fix, re-derive or smooth the tip cap's starting boundary from the stored mesh slice material using round offset joins for the specific matched island.
- Preserve current protections around intersecting add features, containing pockets, tabs, clamps, region filtering, and adaptive band fills.

## Files affected

- `src/engine/toolpaths/finishSurfaceWaterline.ts` — adjust projected-cap generation, Z projection, peak estimation, and possibly the round-join starting boundary used for island tips.
- `src/engine/toolpaths/finishSurface.test.ts` — add or update waterline adaptive tip-cap regression coverage around a synthetic cone/peak model, plus assertions that band-fill behavior is not regressed.
- `src/engine/toolpaths/INDEX.md` — update only if the waterline entry needs a more precise description after the implementation.
- `planning/WATERLINE_TIP_CAP_QUALITY_Plan.md` — archive when complete.

## Tests

- Add a focused waterline regression test that generates projected cap cuts on a synthetic convex peak and asserts:
  - projected cap Z values are monotonic toward the peak within the cap
  - cap rings do not cluster into near-identical Z shelves at the crown
  - the highest projected cap reaches near the model/tool-safe peak instead of staying flat at the coarse top level
- Add a second synthetic regression where overlapping uneven peaks split at micro-Z levels and the lower branch collapses before the taller peak; assert the lower branch still receives projected cap cuts.
- Assert the cone fixture emits the real waterline boundary before projected cap fill paths so the output does not begin with interior fill rings.
- Assert nearby projected cap fill starts without an immediate safe-Z plunge when the preceding ring is close enough to link.
- Run `npx tsx src/engine/toolpaths/finishSurface.test.ts` during iteration.
- Run `npm run build` before committing.

## Open questions / risks

- Simulator visual quality is the real acceptance criterion, but automated tests can only approximate it with Z-distribution and monotonicity assertions. I will keep the regression test focused on the failure mechanics described in issue #127.
- Using heightmap samples too aggressively caused visible texture across band fills before; this work must stay local to `projectedCap` and avoid changing `projectedBand` Z behavior.
- Local heightmap refinement can become expensive if it rebuilds global grids. Any higher-resolution or interpolation work should be bounded to cap sampling or reuse existing data.

## Out of scope

- Replacing adaptive waterline with true 3D constant-scallop finishing.
- Changing parallel finish or rough-surface strategies.
- Redesigning adaptive band fills, region behavior, intersecting-add wall cleanup, or waterline UI controls.
- Starting the Vite dev server.
