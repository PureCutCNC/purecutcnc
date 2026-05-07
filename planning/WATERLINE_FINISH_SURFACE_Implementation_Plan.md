# Waterline Finish Surface — Implementation Plan

## Overview

A **waterline** strategy for the existing `finish_surface` operation that machines the vertical walls of a 3D STL model by tracing the model's cross-section contour at each Z level. Complements the existing `parallel` strategy (which follows the top surface for near-horizontal areas) by providing clean, scallop-free wall finishing.

### Key feature: adaptive Z step refinement

When the model wall is sloped or curved, coarse Z steps leave visible stair-step tool marks. The waterline strategy detects this by measuring the XY gap between consecutive contours and automatically **subdivides** the Z interval until the gap is within tolerance.

The tolerance is derived from the existing **stepover ratio**: `maxGap = stepover × tool.diameter`. This reuses the user's existing surface quality preference without adding a new parameter.

## Algorithm

### Critical: Cumulative Shadow

Like the rough surface operation, each waterline contour is based on the **cumulative shadow** — the union of all mesh slices from the model top down to the current Z. Without this, at lower Z levels where the model cross-section is narrower, the tool would cut into material that belongs to wider upper cross-sections.

### Three-phase approach

**Phase 1: Build initial levels with cumulative shadow**
```
shadow = []
for each z in coarseLevels (top to bottom):
  slice = sliceMeshAtZ(z)
  shadow = union(shadow, slice)            ← accumulates top-down
  contour = offset(shadow, tool.radius)    ← tool center path
  levels.push({ z, shadow, contour })
```

**Phase 2: Iterative adaptive refinement**
```
repeat until converged (max 8 iterations):
  for each pair [upper, lower] in levels:
    gap = maxXYGap(upper.contour, lower.contour)
    if gap > stepover × diameter AND z_span > minZStep:
      z_mid = midpoint
      midShadow = union(upper.shadow, sliceMeshAtZ(z_mid))
      midContour = offset(midShadow, tool.radius)
      insert midpoint between upper and lower
```

**Phase 3: Emit contours**
```
for each level (top to bottom):
  clip contour to region (if any)
  subtract protected footprints
  apply cut direction
  emit as closed contour moves at this Z
```

### Contour gap measurement

Implementation: use Clipper XOR between the two contour sets, then measure the maximum width of the XOR region. This is cheaper than point-by-point distance queries and handles complex multi-polygon contours correctly.

Simpler fast-path: sample N points around contour_lower, find nearest point on contour_upper for each. If none exceeds maxGap, skip the full XOR measurement.

### Per-level contour generation

At each final Z level:
1. Slice mesh at Z via `sliceMeshAtZ(sliceIndex, z)`
2. Convert slice polygons to Clipper paths
3. Offset outward by `tool.radius + stockToLeaveRadial` (tool center path)
4. Clip to region features (if any) via Clipper intersection
5. Subtract protected footprints (clamps, tabs, other features)
6. Apply cut direction (conventional/climb)
7. Emit as closed contour moves at this Z

### Adaptive refinement limits

- **minZStep**: `0.01mm` (or equivalent in project units) — don't subdivide below this to prevent infinite recursion on vertical walls
- **maxSubdivisions**: cap recursion depth at 8 levels (256× refinement of original step) as safety
- **Skip flat areas**: if the contour at z_lower is empty (model has disappeared at this depth), emit nothing — the parallel strategy handles the top surface

## Type changes

### PocketPattern

Add `'waterline'` to the existing `PocketPattern` union:

```typescript
// src/types/project.ts
export type PocketPattern = 'offset' | 'parallel' | 'waterline'
```

No new fields on `Operation` — stepdown controls coarse Z steps, stepover controls adaptive refinement tolerance.

## Files to modify

| # | File | Change | Status |
|---|------|--------|--------|
| 1 | `src/types/project.ts` | Add `'waterline'` to `PocketPattern` | |
| 2 | `src/engine/toolpaths/finishSurface.ts` | Add `generateFinishSurfaceWaterline()` function; dispatch from main entry point based on `pocketPattern` | |
| 3 | `src/components/cam/CAMPanel.tsx` | Show pattern selector for `finish_surface` with Parallel/Waterline options; show angle only for parallel | |
| 4 | `src/store/projectStore.ts` | Update `pocketPatternLabel` if used, default pattern for finish_surface to `'waterline'` | |
| 5 | `src/engine/toolpaths/finishSurface.test.ts` | Add unit tests for waterline strategy and adaptive refinement | |

## Implementation steps

- [x] **Step 1: Type change** — Add `'waterline'` to `PocketPattern` in `src/types/project.ts`
- [x] **Step 2: Contour gap measurement** — Implement `maxContourGap()` helper in `finishSurface.ts` that measures XY distance between two sets of Clipper contours
- [x] **Step 3: Adaptive Z refinement** — Iterative refinement in `generateFinishSurfaceWaterline()` that subdivides where contour gap exceeds `stepover × diameter`
- [x] **Step 4: Waterline contour generation** — Implement `generateFinishSurfaceWaterline()` with cumulative shadow, adaptive refinement, and contour emission
- [x] **Step 5: Dispatch** — Wire waterline strategy into `generateFinishSurfaceToolpath()` entry point, dispatching on `pocketPattern === 'waterline'`
- [x] **Step 6: UI — Pattern selector** — Show Parallel/Waterline pattern dropdown for `finish_surface` operations in CAMPanel
- [x] **Step 7: UI — Conditional fields** — Show angle input only when parallel is selected; show stock-to-leave radial for waterline
- [x] **Step 8: Default pattern** — Set default `pocketPattern` for new `finish_surface` operations to `'waterline'` in `defaultOperationForTarget`
- [x] **Step 9: Tests** — Unit tests for contour gap measurement, adaptive refinement, waterline generation, and ball endmill Z-step density
- [x] **Step 10: Build verification** — `npm run build` passes clean
- [x] **Step 11: Ball endmill support** — For ball end mills, use `min(stepdown, stepover × diameter)` for initial Z step spacing to prevent stair-steps on vertical walls

## Reusable infrastructure

| Component | Source | Usage |
|-----------|--------|-------|
| `sliceMeshAtZ` | `meshSlicing.ts` | Slice triangle mesh at arbitrary Z |
| `getMeshSliceIndex` | `meshSlicing.ts` | Build/cache spatial index for slicing |
| `offsetClipperPaths` | `modelProtection.ts` | Outward offset for tool radius |
| `intersectClipperPaths` | `modelProtection.ts` | Region clipping |
| `unionClipperPaths` | `modelProtection.ts` | Union slice polygons |
| `differenceClipperPaths` | `modelProtection.ts` | XOR for gap measurement |
| `buildProtectedFootprintPaths` | `modelProtection.ts` | Avoid clamps/tabs/other features |
| `generateStepLevels` | `pocket.ts` | Initial coarse step generation |
| `transitionToCutEntry` | `pocket.ts` | Rapid + plunge to entry point |
| `retractToSafe` | `pocket.ts` | Retract to safe Z |
| `updateBounds` | `pocket.ts` | Accumulate toolpath bounds |
| `toClosedCutMoves` | `pocket.ts` | Convert points to closed contour moves |
| `loadSTLTransformedGeometry` | `csg.ts` | Load and transform STL geometry |
| `splitFeatureTargets` | `regions.ts` | Separate model vs region features |
| `buildRegionMask` | `regions.ts` | Build Clipper mask from region features |

## Design decisions

1. **Waterline as PocketPattern, not new OperationKind** — shares 90% of validation, STL loading, region clipping, and protected-footprint logic with the existing parallel strategy
2. **Stepover-derived tolerance** — `maxGap = stepover × diameter` reuses the user's existing quality preference; no new parameter needed
3. **Cumulative shadow (same as rough surface)** — each waterline contour traces the union of all mesh slices from the top down to the current Z, preventing the tool from cutting into material that belongs to wider upper cross-sections
4. **Iterative refinement** — adaptive subdivision runs as iterative passes (insert midpoints, re-check) rather than recursion, which works cleanly with cumulative shadow state
5. **Complementary to parallel** — waterline handles walls, parallel handles floors; user picks the right one for their geometry (or runs both)
