---
status: Done
created: 2026-05-30
---

# Waterline Entry Snap Plan

## Goal

Fix waterline finishing so adjacent closed rings in the same column keep same-XY entry alignment when their starts are only slightly shifted by slicing, offsetting, or simplification. The user-visible outcome is fewer unnecessary safe-Z retract, rapid, and plunge cycles while descending vertical or near-vertical waterline walls.

## Approach

- Keep the existing waterline column clustering and top-to-bottom machining flow in `finishSurfaceWaterline.ts`.
- After closed contour direction is resolved and the ring is rotated near the current endpoint, detect when the selected entry is within a small, bounded snap tolerance of the previous ring endpoint.
- For matching closed rings, insert or snap the first contour point so the emitted entry point exactly matches the previous XY before calling `transitionToCutEntry(..., maxLinkDistance = 0)`.
- Tie the tolerance to the waterline stepover/tool scale, with a conservative cap, so it absorbs numerical drift without moving real entry points across meaningful geometry.
- Preserve existing safety behavior for open contours, protected-region splits, intersecting-add forced retracts, and projected adaptive waterline paths.

## Files affected

- `src/engine/toolpaths/finishSurfaceWaterline.ts` — add the bounded closed-ring entry snapping helper and apply it in the column descent path.
- `src/engine/toolpaths/finishSurface.test.ts` — add a regression for stacked waterline rings that should descend with direct plunges rather than safe-Z round trips.
- `planning/INDEX.md` — register this plan while active.
- `planning/archive/WATERLINE_ENTRY_SNAP_Plan.md` — archive after implementation and build verification.

## Tests

- Add or update a focused finish-surface waterline test that builds a vertical-wall pocket/cylinder style imported mesh with multiple waterline levels and asserts adjacent same-column closed rings emit direct plunge moves between levels.
- Assert the regression does not contain a retract/rapid/plunge cycle between the adjacent closed rings being tested.
- Run `npx tsx src/engine/toolpaths/finishSurface.test.ts`.
- Run `npm run build`.

## Open questions / risks

- The snap tolerance needs to be large enough to handle Clipper/simplification drift but capped tightly enough that it cannot visibly distort a ring or hide a genuine XY transition.
- Existing intersecting-add wall protection intentionally forces retracts near add-feature walls; this work should not override that safety path.

## Out of scope

- Changing waterline column clustering or nearest-column ordering.
- Changing adaptive waterline refinement, containing-add classification, or UI quality controls.
- Broad toolpath transition behavior outside waterline closed-ring column descent.
