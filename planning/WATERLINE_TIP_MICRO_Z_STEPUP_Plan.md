---
status: In progress
created: 2026-06-01
---

# Waterline Tip Micro-Z Step-Up Plan

## Goal

Make convex tips (cone apex, nose/forehead/chin) carve at the actual cone slope without bumpy band-fill texture and without flat cap shoulders. User-visible outcome: the cone tip in the simulator has the same slope as the rest of the cone, the OldMan peaks render smooth, no visible step at the cap↔band boundary, no apex plateau wider than the natural ball-wrap dome.

## Approach

The pre-existing tip-cap pipeline tries to span the entire `[tipZ, peakZ]` band with a single set of XY-offset cap rings. That stretches a linear/sampled Z over the full cap radius (= `slice + toolOffset`), which is wider than the cone surface naturally spans — so the cap slope ends up shallower than the cone slope, or we cheat with a sampled-tangent floor and reintroduce the bumpy-texture / minor-gouge problems.

The fix: keep the tip-cap pipeline only for the small remaining dome above the topmost-with-material level, and fill the rest of the tip Z range with **real micro-Z coarse levels** — each one a real mesh slice at a finer Z step than the operation's `stepdown`. Bands between adjacent micro-Z levels use the existing band-fill linear interpolation between two **real** slice contours, which gives cone-matching slope without ever sampling the heightmap mid-band.

### Concretely

1. After `stepLevels` is built in `finishSurfaceWaterline.ts`, detect each *tip region* — a pair of adjacent step levels `(z_upper, z_lower)` where the mesh slice at `z_upper` is empty (or smaller than a fraction of a cell) and the slice at `z_lower` has real material.
2. For each tip region, insert micro-Z levels at `z_lower + k * microStepZ` for `k = 1, 2, …`, stopping as soon as the slice at that Z collapses (no material). Default `microStepZ = stepdown / 2`. The user already has `waterlineMicroStepover` for the XY stepover; this is a *Z* refinement, separate.
3. Pass the augmented `stepLevels` to `generateFinishSurfaceWaterline` → `buildWaterlineLevels`. The rest of the pipeline runs unchanged: coarse rings emit on every level, band fills emit between every adjacent pair, and tip-cap detection (already topmost-with-material-aware) now only fires on the new *highest* micro-Z level — a much smaller XY footprint than before, so its shallower-than-cone linear ramp covers less visible area.

### Worked example on `work/Cone.camj`

- Existing `stepLevels` top: `…, 1.95, 1.89, …, 1.75 (modelTopZ, slice empty), 1.69 (first real slice, r = 0.12), 1.63, …`
- `tipZ = 1.69`, `microStepZ = stepdown / 2 = 0.03`
- Insert at `1.72`. Slice at 1.72: cone radius `0.06` → real material. Keep.
- Try `1.75`: slice empty. Stop.
- New `stepLevels` top: `…, 1.75, 1.72, 1.69, 1.63, …`
- Band fills between `(1.72, 1.69)`: annulus `r = 0.1225` → `0.1825`. Z varies `1.72 → 1.69` over `Δr = 0.06`. Slope = `0.5` — **matches cone exactly**.
- Cap on the new topmost `(z = 1.72)`: rings inside `r = 0.1225` only, ramping `tipZ = 1.72 → peakZ = 1.75` over `maxInsetDistance ≈ 0.1225`. Linear ramp slope = `0.245`, still shallower than cone, but the affected radius is now `≤ 0.1225` instead of `≤ 0.18` — the visible cap shoulder shrinks.

Result on the cone: the visible cone slope from `r = 0.182` down to `r = 0.1225` (currently the wide-cap region) is replaced by a real band fill at cone-matching slope. The remaining cap at `r ≤ 0.1225` keeps the small natural ball-wrap dome at the apex but with a tighter footprint.

### Why the band-fill bumpy-texture risk doesn't apply here

The new micro-Z bands interpolate Z linearly between *two real coarse slice contours* (the heightmap is **never queried**). The only sampled-Z queries remain inside `processTipPath` on the smallest remaining cap — same code, smaller area. No change to the linear-interp band-fill strategy that the original adaptive plan committed to.

### Multi-tip handling (OldMan)

The tip-region detection is per adjacent-step-level pair, so each tip that emerges between two coarse levels gets its own micro-Z refinement independently. The bands generated between micro-Z levels are local to that tip (their inner contour is the cap base of the tip above; their outer contour is the next coarse level's contour around that tip).

## Files affected

- `src/engine/toolpaths/finishSurfaceWaterline.ts` (or a new helper file) — add a `densifyStepLevelsAboveTips(stepLevels, sliceAtZ, microStepZ, fillFraction)` helper. Called from `generateFinishSurfaceWaterline` immediately after `sliceAtZ` is defined and before `buildWaterlineLevels`. Returns a new sorted-descending `number[]` of step levels with micro-Z entries inserted in each tip region.
- `src/engine/toolpaths/finishSurface.ts` — wire the operation parameter (default `stepdown / 2`, no UI yet) through to `generateFinishSurfaceWaterline`. Use the existing `operation.waterlineMicroStepover` *only if it's interpreted as the Z stepover specifically* (it isn't right now — it's the XY stepover for the projected pass), so add a new internal parameter `waterlineTipMicroStepZ` defaulting to `stepdown / 2`. Plumb through.
- `src/engine/toolpaths/finishSurface.test.ts` — new test: synthetic cone-like fixture, run waterline, assert (a) micro-Z levels appear between the original tipZ and modelTopZ, (b) band fills exist between adjacent micro-Z levels with cone-matching Z interpolation, (c) the projected-cap rings only cover the smaller top contour, (d) no two consecutive cap rings stack flat.

## Tests

- Unit test as described above.
- `npm run build` (= `tsc + npm test + vite`) green.
- User verification on `work/Cone.camj` (smooth cone slope from band-fill, smaller cap shoulder) and OldMan fixtures (no scaly/terraced texture on forehead/nose, no large flat shoulder).

## Open questions / risks

- **Tip detection threshold.** What counts as "slice at `z_upper` empty"? Strictly empty `(slice.length === 0)` may miss thin tips where the topmost slice has a tiny non-zero polygon. Soft threshold: total slice area below some fraction of a heightmap cell. Or just use strict `length === 0` to start and tighten later if needed.
- **Configurability of micro-step.** Hard-coded `stepdown / 2` for v1. Once verified to help, expose as `waterlineTipMicroStepZ` operation parameter and add a UI control.
- **Performance.** Each micro-Z level adds one mesh slice + one Clipper offset + one contour-pair to the band-fill loop. On a typical model with 1–3 tip regions and 1–4 micro-Z levels per tip, that's ≤ 12 extra slices and band-fill iterations — negligible vs. the existing coarse loop's tens of slices.
- **Non-symmetric or asymmetric tips.** Each tip's micro-Z slices follow the actual mesh, so non-symmetric shapes (e.g. OldMan nose tip) get the correct contour. No special handling needed.
- **Band-fill interaction with intersecting adds.** Existing band fill subtracts intersecting-add footprints. Micro-Z bands inherit this behaviour — the `clipRingsAgainstAdds` call already in the band loop runs on the new bands too.

## Out of scope

- Replacing the linear band-fill Z source with a heightmap-derived one — keeps the documented bumpy-texture risk at bay.
- The natural ball-wrap dome at the very apex inside the smallest remaining cap (≈ `R * (1 − cos θ)` tall, e.g. `0.007"` on this cone) — a geometric consequence of the ball radius. Issue #127 acceptance accepts a smooth dome at the peak.
- UI exposure of the new micro-Z parameter — code-level default in v1; UI follow-up.
- Intersecting-add wall cleanup, region-feature handling, the existing `WATERLINE_ADAPTIVE_REFINEMENT_Plan.md` follow-ups — out of scope here.
