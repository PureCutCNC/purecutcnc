---
status: Done   # shipped to main (PR #100); closed in core-arch Phase 0, not re-verified
created: 2026-05-23
---

# Waterline Adaptive Refinement Plan

## Goal

Improve the existing imported-mesh `finish_surface` waterline strategy so it better finishes shallow-slope regions without turning into a full constant-scallop implementation. The user-visible outcome is that waterline fills the XY bands between adjacent coarse waterline contours with projected inward offset passes, reducing visible scallop gaps on slow slopes while avoiding dense redundant full-model Z slices on steep walls. The practical quality target is that adaptive waterline should produce shallow-slope finish quality comparable to the existing parallel finish, while preserving waterline's strengths on vertical and near-vertical walls.

## Approach

- Keep the existing `finish_surface` waterline operation and evolve it in place instead of introducing a new operation kind.
- Build on the current waterline infrastructure rather than starting over:
  - keep the current coarse slice / cumulative shadow / protect / clip / column-machining pipeline intact
  - reuse the older projected-offset design from `planning/archive/WATERLINE_FINISH_SURFACE_Implementation_Plan.md`
  - replace dense midpoint-Z refinement with local XY band-fill passes between adjacent coarse waterline levels
- Generate the current coarse waterline levels first, including existing critical horizontal floor levels and containing-subtract limits.
- Add a projected micro-offset pass for waterline only:
  - inspect adjacent coarse levels
  - treat the lower/current offset contour as an outer boundary and the upper/previous offset contour as an island
  - generate inward XY offsets inside that band at stepover spacing, stopping when each shape collapses
  - for model tops/island tips and later-emerging islands, match each upper contour to its related next-lower contour and fill that local band so the projected paths blend in Z instead of creating isolated cap patterns
  - suppress coarse local-maximum contours once replacement projected cap paths are generated, so quantized first-slice shapes do not remain as visible square/boxy finish paths
  - filter projected cap remnants that collapse into tiny boxy loops or connector-heavy paths, leaving the larger blended cap offsets while avoiding visible square/diagonal artifacts
  - assign Z per vertex (and therefore per segment endpoint) by projecting each XY point between the adjacent upper and lower Z boundaries, so micro passes are true 3D moves rather than flat same-Z contours
  - preserve valley/pocket handling by treating upper/lower contour differences as polygon bands with islands/holes instead of assuming one simple nested outer ring
- Keep projected refinement focused on the imported mesh surface:
  - coarse waterline levels still include intersecting add-wall geometry, tabs, clamps, regions, and model protection
  - projected micro-offset bands are generated from mesh-only waterline slices when intersecting add features are present, avoiding add-wall/envelope corner caps while keeping the add walls in the coarse waterline pass
- Keep the refinement heuristic explicit and bounded:
  - no micro-offset bands when adjacent contours are effectively coincident and existing waterline is already appropriate
  - no unbounded subdivision
  - preserve operator predictability by surfacing debug warnings/metrics when `debugToolpath` is enabled
- Leave naming/UI unchanged for this work. This is still a waterline operation, just improved.

## Files affected

- `src/engine/toolpaths/finishSurface.ts` — adjust waterline step-level preparation so adaptive refinement can plug into the existing finish-surface dispatcher cleanly.
- `src/engine/toolpaths/finishSurfaceWaterline.ts` — implement projected XY band-fill offsets with per-point Z projection, and keep the contour-generation / column-machining path stable for coarse rings.
- `src/engine/toolpaths/finishSurface.test.ts` — add regression coverage for shallow-slope projected micro passes, non-refinement on steep/vertical cases, top-island cleanup, valley/pocket handling, and bounded subdivision.
- `src/engine/toolpaths/INDEX.md` — update the waterline entry to mention adaptive shallow-slope refinement if the implementation lands here.
- `planning/archive/WATERLINE_ADAPTIVE_REFINEMENT_Plan.md` — archive on completion per workflow.

## Tests

- Add or update `src/engine/toolpaths/finishSurface.test.ts` with cases covering:
  - adaptive insertion of projected micro-offset 3D passes on a shallow tapered model where coarse waterline leaves a large XY gap
  - generated shallow-slope test models that compare adaptive waterline against the existing parallel finish for similar coverage quality
  - no extra refinement on clearly vertical-wall / pocket-wall geometry
  - top island/tip cleanup where the first contour has no previous upper ring
  - valley/pocket bands where contour topology includes holes or multiple shapes
  - containing subtract pockets and intersecting-add walls still respect the current waterline protections after refinement
  - offset generation stops at collapse / iteration cap and does not explode move counts
  - projected Z decisions are stable across repeated runs
- Use `work/model-in-pocket.camj` during implementation testing, and promote it or a reduced equivalent into `src/engine/test-fixtures/` if it exposes a regression that should live in the tracked suite.
- Run `npm run build` after implementation.

## Open questions / risks

- Z projection is the main design risk. Micro-offset paths cannot be emitted at a single Z; each point needs a projected Z based on its XY position between the current and previous waterline boundaries.
- The first/top island case has no previous upper ring; the implementation must project inward from that top ring and sample the model surface rather than skipping the top.
- Valley/pocket topology can create multiple bands and holes; the band-fill logic must avoid assuming a single simple outer/island pair.
- The simplified approach should stay clearly heuristic. It should not be marketed or named as true constant-scallop finishing unless we later implement the real algorithm.

## Per-vertex Z source: heightmap (tip caps) vs. linear (bands)

Iterating on the OldMan model surfaced a clear visual tradeoff between two Z-projection options for the projected micro-offset rings. Tip caps and band fills now use *different* sources, intentionally.

- **Tip caps** use the shared heightmap built once via `finishSurfaceParallel`'s `safeToolTipZAt` (the kinematic-safe tool-tip Z, not the raw geometric surface Z — `queryHeightMapTopZ` gouges on every slope because it ignores tool radius).
  - The cap covers a small XY footprint (one island top), so following the actual mesh surface there is what makes the nose / forehead / lip tips look right.
  - Heightmap cell-size quantization is bounded to the cap area, so any cell-level texture in the result stays localized.
  - Per-vertex Z is clamped into `[tipZ, peakZ]` where `peakZ = higher.z` (the next coarse level above the tip's first slice) so a noisy heightmap reading on the steep flank can't drive the cut above an already-finished rim.

- **Band fills** stay on the original linear XY interpolation between upper/lower contour boundaries (`projectedBandZAtPoint`).
  - We tried switching band fills to the same heightmap-based per-vertex Z as the tip caps. The result was visually much rougher across the entire face — the heightmap's cell quantization, plus `safeToolTipZAt`'s discrete neighbor scan, showed up as bumpy texture wherever bands cover the surface (which is most of the model).
  - Bands cover most of the model surface and the linear ramp is geometrically smoother, so it gives a cleaner-looking surface in the simulator.
  - Linear projection does leave small flat plateaus on convex regions immediately around tip footprints (the ramp cuts slightly above the actual surface curvature). We accepted that tradeoff for now — those plateaus are local to the tip's surrounding band and far less objectionable than all-over heightmap roughness.

A future refinement could selectively apply the heightmap correction only when the heightmap Z disagrees with the linear Z by more than some threshold (so the convex plateaus around tips get corrected without re-introducing cell-quantization noise on smooth slopes). Worth attempting if the plateau areas become more visible at finer stepovers.

## Tip-cap inset offset uses round joins

The project-wide `offsetClipperPaths` uses `JoinType.jtMiter`, which preserves sharp axis-aligned corners. Tip-cap rings inset a small first-slice polygon, so miter joins kept turning the nose tip into an axis-aligned rectangle no matter how many insets we ran.

`processTipPath` now uses a local `offsetClipperPathsRound` helper that switches to `jtRound` with a tight `ArcTolerance`. Each successive inset replaces corners with arc segments, so the visible squareness fades after the first ring. The outermost cap ring still inherits the miter shape of the upstream `buildWaterlineLevels` slice offset; a follow-up could re-derive that first ring from the raw mesh slice (we have it in `sliceMaterialByZ`) with round joins, but it wasn't needed for the immediate user-visible improvement.

## Follow-up: intersecting-wall cleanup quality

The `work/old-man-in-box.camj` fixture exposed two separate issues around the wedge/add feature that intersects the imported head model:

- The deeper right-side pocket was not being finished down to the lower floor/wall area. This was improved by preserving legitimate clipped wall spans at the deep step instead of trimming them away as short open-contour caps.
- The intersecting wedge/head wall cleanup is safer than before, but the visual blend is still not fully acceptable. The current logic splits/lifts spans that would cut through the target mesh, and preserves real model-wall side-cutting when the tool center is at the expected offset from the current mesh slice boundary. That avoids the worst gouging, but the resulting wall cleanup can still leave a visible transition/scar where the wedge intersects the head.

Leave this as an explicit follow-up rather than declaring the waterline work done. The likely next refinement is to treat intersecting-add wall cleanup as its own local 3D wall-finishing problem instead of forcing it through the same coarse waterline contour pipeline. In practical terms, that means generating the wedge/model intersection wall span from the current mesh slice boundary plus the add boundary, then projecting Z with the same tool-shape-aware surface safety used by the adaptive passes. That should blend with the surrounding finish without either gouging through the head or skipping the lower pocket wall.

## Follow-up implemented in parameter-controls plan

`WATERLINE_PARAMETERS_QUALITY_CONTROLS_Plan.md` now owns user-facing quality controls for this adaptive refinement: enable/disable, projected-ring spacing, trigger gap, and max rings per band. The adaptive algorithm remains here; the parameter plan controls how much of it is applied for a given waterline operation.

## Out of scope

- A true 3D constant-scallop / constant-cusp finishing algorithm.
- Replacing or removing the current parallel finish strategy.
- Renaming the operation in the UI as part of this change.
- Broad path-ordering or plunge-link cleanup unrelated to adaptive shallow-slope refinement.
