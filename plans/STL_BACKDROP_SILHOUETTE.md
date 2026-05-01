# STL Silhouette in Sketch View — Attempt Summary

## Goal
Display a filled silhouette (top-down footprint) of an imported STL model as part of the STL feature's rendering in the 2D sketch canvas. The silhouette should overlay the feature's profile fill so the imported model's top-down shape is clearly visible in sketch view.

---

## Implementation Attempts

### Attempt 1: Backdrop-based approach (rejected by user)

- Created [`src/import/stl.ts`](../src/import/stl.ts) function `renderSilhouetteToDataUrl(profile)` — renders the polygon on an offscreen canvas using Canvas2D `fill()`, returns a PNG data URL
- Wired as a backdrop entity in [`ImportGeometryDialog.tsx`](../src/components/project/ImportGeometryDialog.tsx) using `setBackdrop()`
- **Result**: User rejected this approach: *"I did not mean to load that into the splash image... forget about doing anything with backdrop when an STL is loaded. the requirement is to create a backdrop image that shows within the model feature, when in sketch view."*

### Attempt 2: Image-based silhouette in SketchCanvas (didn't render)

- Added `silhouetteDataUrl?: string` to `STLFeatureData` in [`src/types/project.ts`](../src/types/project.ts:195-201)
- Changed `renderSilhouetteToDataUrl` return type from object to `string | null`
- Stored `silhouetteDataUrl` on the feature's `stl` property during import in [`ImportGeometryDialog.tsx`](../src/components/project/ImportGeometryDialog.tsx:187-234)
- Added `silhouetteImageCacheRef` (`Map<string, HTMLImageElement>`) in [`SketchCanvas.tsx`](../src/components/canvas/SketchCanvas.tsx)
- Added `useEffect` to load silhouette data URLs into `Image` elements, auto-prune stale cache entries
- Added `drawImage()` in the feature loop to render the loaded Image on canvas
- **Bug 1 — upside down**: Fixed by removing Y-flip in `renderSilhouetteToDataUrl` (`sy(y) = (y + originY) * scale` instead of `canvasH - ...`)
- **Bug 2 — not visible**: User reported *"orientation is good but there is still no image of the model, just blueish background."* The Image-loading pipeline (data URL → `new Image()` → `onload` → cache → `drawImage`) never successfully displayed the silhouette.

### Attempt 3: Direct polygon rendering in SketchCanvas (unverified)

- Removed the entire `silhouetteImageCacheRef` and `useEffect`-based Image-loading pipeline from [`SketchCanvas.tsx`](../src/components/canvas/SketchCanvas.tsx)
- Replaced `drawImage()` with direct polygon rendering using `traceProfilePath()` + `ctx.fill()` + `ctx.stroke()` right after `drawFeature()` in the feature loop
- **Status**: Code compiles (`npx tsc --noEmit` passes) but **never verified in browser** — user was troubleshooting test outputs instead

---

## Diagnostic Test Script

Created [`scripts/test-stl-silhouette.ts`](../scripts/test-stl-silhouette.ts) to isolate the silhouette generation outside the browser:

- Loads `/Users/frankp/Projects/purecutcnc/work/Oldman-splash-final.STL` (7.9 MB)
- Calls `extractStlProfileAndBounds()` — uses Manifold WASM, falls back to ClipperLib for non-manifold STLs
- Test STL is non-manifold, so ClipperLib fallback is used (~99s runtime)
- Profile extracted: **1727 vertices**, bounding box **91.7×126.3** model units
- Outputs multiple formats:
  - **PNG** (743×1024) via manual scanline fill (`pointInPolygon` ray-casting)
  - **SVG** via `<polygon>` element
  - **PPM** (raw bitmap fallback)
  - **HTML diagnostic** — side-by-side Canvas2D `fill()` vs scanline fill

### Findings from test script

| Metric | Value |
|--------|-------|
| Profile vertices | 1727 |
| Bounding box | 91.70 × 126.35 model units |
| Image size | 743 × 1024 px |
| Filled pixels (both orientations) | 517,682 / 760,832 = **68.04%** |
| PNG size | 11 KB (efficient compression of solid blue on black) |
| `renderSilhouetteToDataUrl` in Node.js | throws (no DOM canvas — expected) |

### User feedback on test outputs

Throughout testing, the user consistently reported seeing **"just blue outline"** rather than a filled shape, across all output formats (SVG, PPM, PNG, and even the Canvas2D `fill()` API HTML diagnostic). The user also questioned whether the orientation showed the **bottom view** rather than top view.

---

## Root Cause Analysis

The fact that even the native **Canvas2D `fill()` API** (used in the HTML diagnostic page) produces only "blue outline" strongly suggests the issue is **not** in the rendering code but in the **polygon data itself**:

1. **`extractStlProfileAndBounds`** ([`src/import/stl.ts`](../src/import/stl.ts:44-215)) uses ClipperLib to project all STL triangles to 2D (XY plane) and union them. For non-manifold STLs:
   - Only CCW triangles are included (`crossProduct > 0` check on line 147)
   - The largest-area polygon from the union result is selected as the outer boundary
   - **Potential issue**: The union of 2D triangle projections for a complex non-manifold mesh may produce a polygon with self-intersections, degenerate edges, or incorrect winding that prevents proper fill

2. **Canvas2D `fill()` uses the non-zero winding rule** — a self-intersecting polygon with inconsistent winding may not fill at all, appearing as just "outline" when stroke is applied

3. **1727 vertices on a small polygon** — dense vertices close together may give the visual impression of an outline rather than a filled shape

### Possible fixes (if revisited)

- **Simplify the polygon** using ClipperLib's `SimplifyPolygon` or Ramer-Douglas-Peucker vertex reduction before rendering
- **Ensure correct winding order** — force CCW winding before Canvas2D fill
- **Use `evenodd` fill rule** in Canvas2D (`ctx.fill('evenodd')`) to handle self-intersections
- **Render to a temporary canvas**, then flood-fill from a known interior point for maximum robustness
- **Debug the ClipperLib union output** by reducing to a simple test case (e.g., a cube STL with known geometry)

---

## Files Modified

| File | Change |
|------|--------|
| [`src/types/project.ts`](../src/types/project.ts:195-201) | Added `silhouetteDataUrl?: string` to `STLFeatureData` |
| [`src/import/stl.ts`](../src/import/stl.ts:223-292) | Added `renderSilhouetteToDataUrl(profile)` function |
| [`src/components/project/ImportGeometryDialog.tsx`](../src/components/project/ImportGeometryDialog.tsx:187-234) | Stores `silhouetteDataUrl` on feature during STL import |
| [`src/components/canvas/SketchCanvas.tsx`](../src/components/canvas/SketchCanvas.tsx:680-694) | Direct polygon rendering for STL features using `traceProfilePath` + `fill()` + `stroke()` |
| [`scripts/test-stl-silhouette.ts`](../scripts/test-stl-silhouette.ts) | Diagnostic test script with PNG/PPM/SVG/HTML outputs |

## Build Status

- `npx tsc --noEmit` passes cleanly
- The direct polygon rendering approach in `SketchCanvas.tsx` has not been browser-tested
