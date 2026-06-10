---
status: Done
created: 2026-06-09
---

# UX Review P2 — A2.1: Visual Collision & Stock-Setup Overlays

> Derived from [`planning/reviews/CONSOLIDATED_REVIEW_2026-06-08.md`](reviews/CONSOLIDATED_REVIEW_2026-06-08.md), section "P2 — A2.1".
> Depends on no P0/P1 items; independently shippable.

## Goal

Make the collision and setup problems visible directly on the canvas, so a user never has to hunt through text warnings to understand what went wrong. Concretely: highlight the specific toolpath segments that pass through a colliding clamp zone, show the stock outline in amber when a feature exceeds it, add W×H dimension labels to the stock border, and add axis labels ("X" / "Y") to the existing machine-origin marker — all so the digital canvas maps obviously to the physical machine.

## What's already there (context)

- `collidingClampIds` is already computed and propagated to `SketchCanvas`, `Viewport3D`, and `SimulationViewport`.
- `drawClampFootprint` already renders colliding clamps with a red fill/stroke vs. blue for non-colliding.
- `applyClampWarnings` (`src/engine/toolpaths/clamps.ts`) already identifies which moves cross into which clamp zones and produces text warnings — but it only surfaces *which clamps* collide (`collidingClampIds`), not *which moves*.
- `drawOriginMarker` (`src/components/canvas/scenePrimitives.ts`) already draws X/Y axis arrows at the project origin; it's shown when `project.origin.visible`.
- `profileExceedsStock` is called in `PropertiesPanel.tsx` and shows a text warning — no canvas-level indicator.

## Approach

### 1 — Per-move collision tagging

Extend `ToolpathResult` (`src/engine/toolpaths/types.ts`) with an optional `collidingMoveIndices: number[]` field. In `applyClampWarnings` (`src/engine/toolpaths/clamps.ts`), while iterating moves that cross into unsafe clamp zones, record the move index. No existing callers need to change; the field defaults to `undefined`.

### 2 — Highlight colliding toolpath segments

In `drawToolpath` (`src/components/canvas/previewPrimitives.ts`), when `toolpath.collidingMoveIndices` is non-empty, draw an additional pass over those specific moves in a distinct warning color (amber: `rgba(255, 180, 60, 0.95)`, slightly thicker than the normal cut layer). Draw this on top of the normal toolpath so it's clearly visible.

### 3 — Stock border feedback

In the main `SketchCanvas` draw loop (`src/components/canvas/SketchCanvas.tsx`, draw function around line 1343), compute whether any visible feature exceeds the stock bounds (`profileExceedsStock` already exists in `src/types/project.ts`). If so, stroke the stock outline in amber (`rgba(240, 160, 40, 0.9)`) instead of the normal stock color. Keep the fill neutral; only the border changes.

This computation happens per-frame inside the canvas draw callback (not a React render), so it does not affect re-render frequency.

### 4 — Stock dimension labels

In `drawStockOutline` (or the inline block in the draw loop), after drawing the stock stroke, add two dimension labels at canvas edges: width along the top edge, height along the right edge, both formatted with `formatLength` in the project's units. Use a small semi-transparent pill background (matching the existing constraint-label style) so labels read against the canvas background.

Extract the inline stock-drawing block into a small `drawStockOutline(ctx, stock, vt, exceedsAny)` function in `src/components/canvas/scenePrimitives.ts` to keep the logic tidy.

### 5 — Axis labels on the origin marker

In `drawOriginMarker` (`src/components/canvas/scenePrimitives.ts`), add "X" (red) and "Y" (green) text labels at the arrowhead tips. Labels use `sans-serif 10px` with a dark background pill (same style as the existing origin name label that already appears below the dot).

## Files affected

- `src/engine/toolpaths/types.ts` — add `collidingMoveIndices?: number[]` to `ToolpathResult`.
- `src/engine/toolpaths/clamps.ts` — populate `collidingMoveIndices` in `applyClampWarnings`.
- `src/components/canvas/previewPrimitives.ts` — `drawToolpath`: extra pass for colliding moves.
- `src/components/canvas/scenePrimitives.ts` — extract `drawStockOutline`; extend `drawOriginMarker` with axis labels.
- `src/components/canvas/SketchCanvas.tsx` — call `drawStockOutline` (with `exceedsAny` flag) instead of the inline stock block; pass computed excess flag.

No changes to `PropertiesPanel.tsx` (its text warning is complementary), engine logic, or data model.

## Tests

- **`collidingMoveIndices` population**: unit test in `src/engine/toolpaths/clamps.test.ts` (or alongside the existing engine tests) that runs `applyClampWarnings` with a fixture project + a toolpath move that crosses a clamp zone below clearance; asserts the colliding move index appears in `collidingMoveIndices`.
- **No regression on existing warning text**: existing warning string assertions still pass.
- **Structural/snapshot**: no new component tests needed — the drawing changes are purely canvas-side and already tested at the integration level by the build.

## Open questions / risks

- **Label overlap at small zoom levels**: the stock dimension labels could overlap feature geometry at very high zoom (small stock, many features). Use a minimum scale threshold (don't render labels when the stock viewport-px width is below ~200 px).
- **`collidingMoveIndices` on adjusted moves**: `applyClampWarnings` can inject extra lift moves (`liftRapidMove`). The indices should refer to positions in the *output* `adjustedMoves` array, not the input — confirm this is what the draw path gets.
- **Viewport3D / SimulationViewport**: these already colorize colliding clamps; the per-move field is purely 2D-canvas-side for now. 3D toolpath segment coloring is possible but would be a separate 3D renderer change — leave for a follow-up if requested.

## Out of scope

- 3D toolpath segment collision highlights in `Viewport3D` (canvas only for this PR).
- Changes to collision-detection rules or clearance parameters.
- Simulation voxel-level collision feedback (that is A3.2 territory).
- Any toolbar or layout changes (that is A2.2 in a separate PR).
