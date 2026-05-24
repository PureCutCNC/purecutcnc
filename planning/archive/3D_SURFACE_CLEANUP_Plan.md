---
status: Done
created: 2026-05-22
---

# 3D Surface Cleanup Plan

## Goal

Add a new imported-mesh CAM operation that reuses the 3D rough-surface stepdown logic but emits cleanup-style finish moves instead of full clearing. The user-visible outcome is a dedicated "rough then cleanup" operation for imported models, with separate `Finish Walls` and `Finish Floor` controls and toolpaths emitted at the deepest Z where each wall/floor contour actually needs to be cleaned up.

## Approach

- Introduce a new `OperationKind`, working name `finish_surface_cleanup`, with UI label `3D Surface cleanup`. Keep it separate from the existing `finish_surface` parallel/waterline operation so the two 3D finishing models do not share incompatible behavior or settings.
- Extract the per-level mesh-slice and clearable-region resolution from `roughSurface.ts` into a shared 3D stepdown helper. That helper should own: target/model validation, optional region-mask clipping, related subtract depth limiting, surrounding protection geometry, floor-level detection, open-slice fallback, and the final clearable/tool-center-safe regions per Z level.
- Implement a new cleanup generator that consumes those resolved levels and emits finish-only moves:
  - `finishWalls`: closed contour passes for the final inset wall loops at retained levels.
  - `finishFloor`: one cleanup pass across retained floor regions using existing floor helpers (`buildPocketFloorContours` for `offset`, `buildPocketParallelSegments` for `parallel`).
  - Lowest-Z behavior: identify repeated wall/floor path columns across the resolved levels and keep the deepest retained member of each column, so the operation does not emit the full stepped roughing stack.
- Reuse existing 3D rough protections and conventions: model-shadow handling, related subtract limits, region filters, add/clamp/tab protection, cut direction, safe-Z motion, and radial/axial stock-to-leave semantics.
  - The shared rough/cleanup outer silhouette envelope should stay tight to the tool-center outer wall (`tool radius + radial leave`, with only a small numerical margin), matching waterline semantics instead of machining an extra outer waste pocket.
- Default the new operation to `pass: 'finish'`, `pocketPattern: 'parallel'`, `finishWalls: true`, and `finishFloor: true`. `stepdown` remains the band resolver for the cleanup logic; `stepover` and `pocketAngle` only affect floor coverage.
  - Cleanup uses a derived internal vertical sampling step based on model height and exact critical floor Zs, and does not expose or inherit roughing-style `stepdown` from tool defaults in the CAM panel.

## Files affected

- `src/types/project.ts` — add the new `OperationKind` entry and keep the operation schema/default fields aligned with the new cleanup op.
- `src/store/projectStore.ts` — add labels/default naming, default operation creation, target validation, and normalization fallback handling for the new kind.
- `src/components/cam/CAMPanel.tsx` — add the new operation to the add menu, wire target hints/selection validation, and expose pattern/angle plus `Finish Walls` / `Finish Floor` controls for the cleanup op.
- `src/App.tsx` — dispatch the new kind to its generator and keep the existing tab/clamp warning wrappers consistent.
- `src/engine/toolpaths/roughSurface.ts` — extract shared 3D stepdown resolution pieces out of the current monolith.
- *(new)* `src/engine/toolpaths/surfaceStepdown3d.ts` — shared imported-mesh stepdown resolver used by rough-surface and cleanup-surface operations.
- *(new)* `src/engine/toolpaths/finishSurfaceCleanup.ts` — cleanup generator built on the shared 3D stepdown resolver.
- `src/engine/toolpaths/index.ts` — export the new generator/shared helper.
- *(new)* `src/engine/toolpaths/finishSurfaceCleanup.test.ts` — dedicated tests for cleanup-specific wall/floor behavior.
- `src/engine/toolpaths/roughSurface.test.ts` — keep the existing rough-surface regressions green after the shared-helper extraction; update only where fixture sharing is needed.
- `src/engine/toolpaths/toolpaths.test.ts` — add smoke coverage for the new operation kind.
- `src/engine/toolpaths/INDEX.md` — document the new generator/helper files and their purpose.

## Tests

- Add `src/engine/toolpaths/finishSurfaceCleanup.test.ts` with cases covering:
  - no target model / no tool / invalid step settings / both finish toggles disabled
  - vertical outside walls are emitted only when `finishWalls` is enabled
  - pocket floors / terraces are emitted only when `finishFloor` is enabled
  - repeated wall/floor geometry across adjacent rough levels is emitted once at the lowest effective Z
  - related subtract depths, optional region masks, and surrounding add protection are still respected
  - open/non-watertight slice fallback stays conservative
- Update `src/engine/toolpaths/toolpaths.test.ts` to include the new kind in broad generation coverage.
- Run `npm run build` after implementation.

## Open questions / risks

- Naming: `3D Surface cleanup` is the recommended label because it distinguishes this from the existing `3D Surface finish` parallel/waterline operation. If you want a different user-facing name, settle it before implementation so the new kind/labels stay stable.
- Lowest-Z deduping needs a clear geometry-comparison tolerance across repeated contour columns. The implementation should normalize paths before comparison so it does not leave duplicate cleanup cuts on vertical walls or accidentally merge genuinely different contours.

## Out of scope

- Changing the behavior of the existing `finish_surface` parallel or waterline strategies.
- Full scallop/parallel finishing of arbitrary sloped mesh surfaces; this cleanup op only finishes the stepdown walls and terraces produced by the rough-surface-style resolver.
- Tool-to-tool rest-stock simulation against a prior roughing operation; this work is geometry-driven cleanup, not stock-state comparison between operations.
