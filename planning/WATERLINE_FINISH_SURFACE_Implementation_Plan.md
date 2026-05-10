# Waterline Finish Surface — Implementation Plan

## Overview

A **waterline** strategy for the existing `finish_surface` operation that machines the walls of a 3D STL model by tracing projected offset contours between coarse Z levels. Unlike simple horizontal slicing (which over-concentrates passes on steep walls and under-concentrates on gentle slopes), this approach fills the XY gap between consecutive Z-level contours with inward offsets, interpolating Z for each ring based on its position between the two boundaries.

### Key insight: projected offsets between Z levels

At each pair of consecutive Z levels, the upper contour (narrower on a dome) sits inside the lower contour (wider). The band between them is the surface area that needs finishing. Instead of adding more horizontal Z slices, we fill this band with **inward offset rings** from the outer (lower) contour toward the inner (upper) contour, spaced at the stepover distance. Each ring's Z is interpolated based on how far it is between the two boundaries.

This naturally adapts to surface slope:
- **Steep walls**: contours are close in XY → few or zero intermediate rings needed (the coarse Z steps suffice)
- **Gentle slopes**: contours are far apart in XY → many offset rings fill the gap (exactly where they're needed)
- **Flat tops**: contours collapse quickly → rings stop when they shrink to nothing

### Z interpolation

For each intermediate ring at offset distance `d` from the outer (lower) contour:

```
t = d / totalGap        (0 at outer boundary, 1 at inner boundary)
z_ring = z_lower + t × (z_upper - z_lower)
```

Since the ring is a single Clipper path, all points on that ring share the same Z. This is an approximation — the actual surface height varies along the ring — but it's good enough because the ring is at most one stepover wide, limiting the Z error.

## Algorithm

### Phase 1: Build coarse Z levels with cumulative shadow

Same as before — slice the mesh at coarse stepdown intervals, building the cumulative shadow top-down. Each level stores its shadow paths and tool-offset contour.

```
shadow = []
for each z in coarseLevels (top to bottom):
  slice = sliceMeshAtZ(z)
  shadow = union(shadow, slice)
  contour = offset(shadow, tool.radius + stockToLeaveRadial)
  levels.push({ z, shadow, contour })
```

### Phase 2: Fill XY bands with projected offset rings

For each consecutive pair (upper, lower):

```
outerBoundary = lower.contour   (wider, at lower Z)
innerIsland   = upper.contour   (narrower, at upper Z)

band = difference(outerBoundary, innerIsland)
if band is empty: skip (contours are identical — vertical wall)

ring = outerBoundary
for step = 1, 2, 3, ...:
  ring = offset(ring, -stepover)           ← inward offset
  ring = intersect(ring, outerBoundary)    ← stay inside outer boundary
  ring = difference(ring, innerIsland)     ← don't cut inside inner boundary

  if ring is empty: break                  ← filled the entire band

  t = (step × stepover) / totalGap
  z_ring = z_lower + t × (z_upper - z_lower)

  emit ring at z_ring
```

The rings collapse to nothing once they reach the inner island, naturally stopping without a fixed iteration limit.

### Phase 3: Emit all contours

For each ring (from coarse levels and intermediate rings), top to bottom:
1. Clip to region features (if any)
2. Subtract protected footprints (clamps, tabs, other features)
3. Apply cut direction (conventional/climb)
4. Emit as closed contour moves at that ring's Z

### Handling multiple bands

Complex models may have multiple disconnected bands between upper and lower contours (e.g., a contour that splits around a hole). The Clipper difference naturally handles this — each disconnected band gets its own set of offset rings.

### Estimating totalGap for Z interpolation

The `totalGap` between two contours is the maximum XY distance from the outer boundary to the inner island. We already have `maxContourGap()` for this. For the Z interpolation fraction `t`, we use:

```
t = min(1, (step × stepover) / totalGap)
```

Clamping to 1 ensures we don't overshoot the upper Z.

### Ordering

Rings are emitted top to bottom (upper Z first, then intermediate rings descending, then lower Z level). Within each Z band, the rings go from outer toward inner (lower Z to upper Z). This matches climb milling direction for the typical case.

The final sort: all rings across all bands are sorted by Z descending before emission.

## Type changes

### PocketPattern

Already done — `'waterline'` added to the existing `PocketPattern` union:

```typescript
export type PocketPattern = 'offset' | 'parallel' | 'waterline'
```

No new fields on `Operation` — stepdown controls coarse Z steps, stepover controls ring spacing.

## Files to modify

| # | File | Change |
|---|------|--------|
| 1 | `src/engine/toolpaths/finishSurface.ts` | Rewrite `generateFinishSurfaceWaterline()` to use projected offset rings instead of horizontal slicing |
| 2 | `src/engine/toolpaths/finishSurface.test.ts` | Update tests for new algorithm behavior |

All other files (types, UI, store) are already done from the initial implementation.

## Implementation steps

- [x] **Step 1–8, 10–11**: Type, UI, dispatch, defaults (already complete)
- [ ] **Step 12: Rewrite waterline core** — Replace horizontal slicing + adaptive refinement with projected offset rings between Z levels
- [ ] **Step 13: Z interpolation** — Compute Z for each intermediate ring based on offset distance / total gap
- [ ] **Step 14: Ring emission** — Emit intermediate rings as closed contour cuts, sorted by Z descending
- [ ] **Step 15: Update tests** — Verify projected offset behavior, ring generation, Z interpolation
- [ ] **Step 16: Build verification** — `npm run build` passes clean

## Design decisions

1. **Projected offsets instead of horizontal slicing** — concentrates passes where the surface is gentle (big XY gap) and skips where it's steep (small XY gap), matching the surface topology rather than fighting it
2. **Z interpolation per ring** — approximates surface height based on position between boundaries; error bounded by one stepover width
3. **Inward offset from outer boundary** — outer = lower Z contour (wider), inner = upper Z contour (narrower); offsets shrink inward until they collapse, naturally filling the band
4. **Cumulative shadow preserved** — still needed for gouge prevention; the coarse Z levels use cumulative shadow as before
5. **No new parameters** — stepdown controls coarse Z spacing, stepover controls ring spacing; same as before
6. **Rings collapse naturally** — no fixed iteration limit needed; offset shrinks to nothing when it reaches the inner island
