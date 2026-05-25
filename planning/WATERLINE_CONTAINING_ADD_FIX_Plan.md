---
status: In progress
created: 2026-05-24
---

# Waterline Containing Add Fix Plan

## Goal

Fix waterline finish on oldman-style projects where a 3D model sits inside selected or surrounding add geometry. Waterline should emit contours for the imported mesh instead of dropping every path because containing/base add features were mistaken for intersecting vertical walls.

## Approach

- Update the intersecting-add detection used by finish-surface waterline so add features that contain the full model footprint are treated as base/containing geometry, not as protruding intersecting wall features.
- Keep the existing behavior for true partially-overlapping add features that straddle or protrude into the model footprint, because those still create vertical walls waterline should finish.
- Preserve the adaptive waterline refinement logic; this fix is about which add features activate the intersecting-add clipping path.

## Files affected

- `src/engine/toolpaths/modelProtection.ts` — refine `relatedIntersectingAddFeatures(...)` classification to skip containing/base add footprints.
- `src/engine/toolpaths/finishSurface.ts` — opt waterline finish into the containing/base add exclusion while leaving cleanup strategy semantics unchanged.
- `src/engine/toolpaths/finishSurface.test.ts` — add a reduced regression for a model inside a containing add feature where waterline must still emit moves, plus retain the existing intersecting-add wall test.
- `planning/INDEX.md` — register and move this plan through the normal workflow.
- `planning/archive/WATERLINE_CONTAINING_ADD_FIX_Plan.md` — archive after the fix and build are complete.

## Tests

- Add a waterline regression using the existing synthetic model fixtures with a containing add feature covering the model footprint.
- Run the oldman throwaway reproduction against `/Users/frankp/Projects/purecutcnc/work/old-man-in-box.camj` and `/Users/frankp/Projects/purecutcnc/work/Oldman-splash-final.camj`.
- Run `npx tsx src/engine/toolpaths/finishSurface.test.ts`.
- Run `npm run build`.

## Open questions / risks

- The containment test must use geometric containment rather than bounding boxes so non-rectangular base geometry does not get misclassified.

## Out of scope

- Changing UI labels or operation settings.
- Implementing region-filtered adaptive waterline refinement.
