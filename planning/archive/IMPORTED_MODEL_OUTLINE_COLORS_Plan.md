---
status: Done
created: 2026-05-21
---

# Imported 3D Model Outline Colors & Legend Fix Plan

## Goal

Add a dedicated color for imported 3D models (STL/OBJ) in the sketch view outline, replacing the current blue-gray default, and add both this new color and the missing region color to the feature color legend (expanded and collapsed variants).

## Background

The sketch view renders imported 3D meshes (features with `kind: 'stl'`) via two layers:

1. **[`drawFeature()`](src/components/canvas/previewPrimitives.ts:65)** — renders fill + stroke for ALL features. For `operation === 'model'`, the fill is drawn first, then the stroke. However, the fill is **covered** by the STL top-view image (step 2), so only the stroke (outline) is visible.

2. **[`drawStlTopViewImage()`](src/components/canvas/SketchCanvas.tsx:168)** — draws a pre-rendered grayscale image of the mesh top view, clipped to the feature's silhouette, then strokes an outline on top.

The original imported model outline was `#a0b0c0` (medium blue-gray), set in both functions. The fill was `rgba(160, 170, 180, 0.35)` but is invisible under the pre-rendered image.

Meanwhile, [`drawFeature()`](src/components/canvas/previewPrimitives.ts:65) already renders region features with a purple fill/stroke (`#9966cc`), but neither the expanded legend (rendered in [`SketchCanvas.tsx:4596`](src/components/canvas/SketchCanvas.tsx:4596)) nor the collapsed legend (rendered in [`App.tsx:861`](src/App.tsx:861)) included an entry for regions — a regression from when region support was introduced.

## Approach

1. **Create a new git worktree** from `main` at `../imported-model-outline-colors` so work is isolated.

2. **Change the imported mesh outline color** in both rendering paths:
   - `drawFeature()` → `operation === 'model'` stroke (this is the primary outline)
   - `drawStlTopViewImage()` → default outline (secondary outline drawn on top)
   
   Final color: **`#bcc8d4`** (light blue-gray) — chosen to be clearly distinct from:
   - Selected: `#efbc7a` (golden-amber)
   - Hovered: `#d2a064` (amber)
   - Editing: `#f7cd87` (light amber)
   - Add: `#63b176` (green)

3. **Revert the fill** in `drawFeature()` (`operation === 'model'`) to `rgba(188, 200, 212, 0.35)` — the fill is covered by the pre-rendered `stlTopViewImage` so it has no visible effect, kept for consistency.

4. **Add CSS swatch classes** for the new outline color and for regions in [`src/styles/layout.css:1299`](src/styles/layout.css:1299):
   - `--imported-model` (`#bcc8d4`)
   - `--region` (purple `#9966cc` — already used by `drawFeature`)

5. **Add legend entries to the expanded legend** in [`SketchCanvas.tsx:4610`](src/components/canvas/SketchCanvas.tsx:4610):
   - "Imported model" with light blue-gray swatch
   - "Region" with purple swatch

6. **Add legend entries to the collapsed legend** in [`App.tsx:870`](src/App.tsx:870):
   - Light blue-gray swatch for imported model
   - Purple swatch for region

## Files affected

- `src/components/canvas/previewPrimitives.ts` — change `operation === 'model'` stroke from `#a0b0c0` → `#bcc8d4`, fill from `rgba(160, 170, 180, 0.35)` → `rgba(188, 200, 212, 0.35)`
- `src/components/canvas/SketchCanvas.tsx` — change default outline stroke in `drawStlTopViewImage` from `#8eb6d8` → `#bcc8d4` (line 229), add region + imported-model items to expanded legend (lines 4623-4634)
- `src/App.tsx` — add region + imported-model swatches to collapsed legend (lines 870-877)
- `src/styles/layout.css` — add CSS swatch classes for `--region` (`#9966cc`) and `--imported-model` (`#bcc8d4`) after line 1313

## Tests

- Manual visual verification in sketch view:
  - An imported 3D model feature shows a light blue-gray outline (not bluish-gray)
  - The expanded legend includes "Imported model" (light blue-gray) and "Region" (purple) entries
  - The collapsed status-bar legend includes both swatches
  - Regions continue to render with purple fill/stroke in the canvas
- `npm run build` before completion

## Open questions / risks

- The interior fill of the imported model is a pre-rendered grayscale image (`stlTopViewImage`) — it cannot be colored via drawFeature() fill. The fill change is invisible.
- Orange and amber were attempted first (`#e8913a`, then `#d4a843`) but were too similar to the selected color (`#efbc7a`). Final choice is a neutral light blue-gray.

## Out of scope

- Changing the pre-rendered `stlTopViewImage` generation (it's a grayscale image rendered from the 3D mesh)
- Adding canvas outline rendering for regions (regions already render via `drawFeature` — only the legend was missing)
- Any changes to the 3D viewport or import dialogs
