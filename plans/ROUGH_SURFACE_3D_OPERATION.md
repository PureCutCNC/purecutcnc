# Rough Surface 3D Operation — Implementation Plan

## Overview

The rough surface operation is the first **3D-aware** CAM operation. It machines the area between a 2D region boundary and a 3D STL model, step by step from top to bottom, using the model's actual 3D cross-section at each Z level.

## Target Design

Requires exactly **two features** bound to the operation:

| Slot | Operation type | Feature kind | Description |
|------|---------------|-------------|-------------|
| 0 | `model` | `stl` | The 3D STL part to rough around |
| 1 | `region` | any closed sketch | The outer boundary of the machining area |

## Algorithm

### High-level flow

```
buildFeatureSolid(module, project, modelFeature)  → 3D Manifold
       │
       ▼
bbox = solid.boundingBox()   → modelTopZ, modelBottomZ
       │
       ▼
stepLevels = generateStepLevels(modelTopZ, effectiveBottom, stepdown)
       │
       ▼
  ┌──────────────────────────────────────────┐
  │  for each z in stepLevels:               │
  │    ┌──────────────┐                      │
  │    │ slice(z)     │  ← different shape   │
  │    │ toPolygons() │    at each level     │
  │    └──────┬───────┘                      │
  │           ▼                              │
  │    Convert slice polygons → ClipperPaths │
  │           ▼                              │
  │    Build surface coverage regions:       │
  │    • Expand region by tool.radius        │
  │    • Expand slice polygons by tool.radius│
  │    • expandedRegion - expandedSlices     │
  │    • Apply radial stock-to-leave inset   │
  │           ▼                              │
  │    Generate toolpath at this Z:          │
  │    • Boundary contour pass               │
  │    • Parallel scanline pass              │
  │    (Both at current Z height)            │
  │           ▼                              │
  │    Retract to safe Z                     │
  └──────────────────────────────────────────┘
```

### Per-level surface cleaning (replaces offset pocket)

Instead of [`cutOffsetRegionRecursive`](src/engine/toolpaths/pocket.ts:767) which generates concentric offset pocket passes, each level performs a **full surface clean**:

1. **Boundary contour pass** — cut the outer perimeter of the machinable area at this Z level (using [`toClosedCutMoves`](src/engine/toolpaths/pocket.ts:144))
2. **Parallel scanline pass** — sweep parallel lines across the entire machinable area at this Z level (using [`buildPocketParallelSegments`](src/engine/toolpaths/pocket.ts:692))

This ensures all material within the region boundary (but outside the model cross-section) is cleared at each depth.

### Handling multiple slice polygons

When [`solid.slice(z)`](src/engine/toolpaths/roughSurface.ts:264) returns multiple polygons (e.g., outer contour + hole contour for a model with a through-hole), **all** polygons are passed as protected paths to the coverage region builder. The Clipper difference operation and [`polyTreeToRegions`](src/engine/toolpaths/pocket.ts:109) handle multiple clip paths correctly:

- Each polygon from the slice becomes part of the "protected" set
- The resulting [`ResolvedPocketRegion`](src/engine/toolpaths/types.ts:95) has `outer` (region boundary minus model) and `islands` (model cross-section contours)
- [`buildPocketParallelSegments`](src/engine/toolpaths/pocket.ts:692) already respects islands: it subtracts island scanline intervals from outer scanline intervals

### Stock-to-leave

| Parameter | Application |
|-----------|------------|
| `stockToLeaveAxial` | `effectiveBottom = modelBottomZ + axialLeave` — tool stops above model bottom |
| `stockToLeaveRadial` | Added to tool radius when insetting coverage regions |

### Important detail: tool center path

The surface coverage area accounts for **tool radius offset**:
- Region boundary is expanded **outward** by `tool.radius` — tool center can go slightly past the region wall
- Model slice polygons are expanded **outward** by `tool.radius` — tool center stays away from the model surface
- Result: `expandedRegion - expandedSlices` defines the area where the tool center can safely travel

Then `radialLeave` is applied as an additional inward inset.

## Functions to reuse

| Function | Source | Purpose |
|---|---|---|
| [`offsetPaths`](src/engine/toolpaths/pocket.ts:72) | pocket.ts | Expand/contract Clipper paths by radius |
| [`buildPocketParallelSegments`](src/engine/toolpaths/pocket.ts:692) | pocket.ts | Generate scanlines across regions |
| [`buildContourLoops`](src/engine/toolpaths/pocket.ts:322) | pocket.ts | Extract boundary contours from regions |
| [`orderClosedContoursGreedy`](src/engine/toolpaths/pocket.ts:585) | pocket.ts | Optimize contour travel order |
| [`orderOpenSegmentsGreedy`](src/engine/toolpaths/pocket.ts:648) | pocket.ts | Optimize segment travel order |
| [`transitionToCutEntry`](src/engine/toolpaths/pocket.ts:212) | pocket.ts | Rapid + plunge to entry point |
| [`toClosedCutMoves`](src/engine/toolpaths/pocket.ts:144) | pocket.ts | Generate contour cut moves |
| [`toOpenCutMoves`](src/engine/toolpaths/pocket.ts:820) | pocket.ts | Generate open segment cut moves |
| [`applyContourDirection`](src/engine/toolpaths/geometry.ts:143) | geometry.ts | Set conventional/climb milling |
| [`retractToSafe`](src/engine/toolpaths/pocket.ts:196) | pocket.ts | Rapid retract to safe Z |
| [`contourStartPoint`](src/engine/toolpaths/pocket.ts:139) | pocket.ts | First point of a contour |
| [`polyTreeToRegions`](src/engine/toolpaths/pocket.ts:109) | pocket.ts | Convert Clipper result to pocket regions |
| [`executeDifference`](src/engine/toolpaths/pocket.ts:89) | pocket.ts | Clipper boolean difference |
| [`buildFeatureSolid`](src/engine/csg.ts:482) | csg.ts | Build 3D Manifold from STL feature |
| [`getManifoldModuleSync`](src/engine/csg.ts:55) | csg.ts | Get cached Manifold module |

## Files to modify

| File | Change |
|---|---|
| [`src/engine/toolpaths/roughSurface.ts`](src/engine/toolpaths/roughSurface.ts) | **Rewrite core algorithm** — replace offset pocket loop with per-level surface cleaning (boundary contour + parallel scanlines at each Z level) |

## Changes from first version

| Aspect | First version (v1) | Refined version (v2) |
|--------|-------------------|---------------------|
| Algorithm | `intersect(region, slice)` — pocket in intersection area | `difference(region, slice)` — region pocket with model islands |
| At each level | Same silhouette outline reused | `solid.slice(z)` produces **different** cross-section per level |
| Toolpath type | Offset pocket (`cutOffsetRegionRecursive`) | Surface clean (boundary contour + parallel scanlines) at each Z |
| Slice polygons | All treated as single clip | All polygons properly handled (holes become islands) |
