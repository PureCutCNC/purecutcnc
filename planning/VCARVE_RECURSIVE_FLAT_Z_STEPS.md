# V-Carve Recursive: Stepped/Flat Z Path Issue

## Symptom

Letters 'o', 'e', and others show a staircase Z profile instead of smooth diagonal
V-carve arms. The tool walks horizontally at a fixed depth, then makes a tiny Z step,
walks horizontally again, etc. Visually this looks like zig-zag steps rather than
smooth diagonal cuts.

## Z Profile Pattern

```
DIAG (tiny xy, dz=+0.0173)   ← arm Z-step at corner
FLAT (larger xy, dz=0)        ← horizontal walk at fixed depth
DIAG (tiny xy, dz=+0.0173)   ← next arm Z-step
FLAT (larger xy, dz=0)        ← horizontal walk
...
```

For 'o': 85% of cut moves are flat (dz < 0.001), only 15% are diagonal.
Flat segments appear at 10 distinct Z levels matching each offset level.

## Root Cause

### Shape topology for 'o'

The 'o' is a ring (outer contour + inner hole). At offset depth 4 (offset=0.04"),
the ring splits into 2 arc-shaped children. Each child is a curved band with
**corners=2** at every recursion level — the two pinch points where the ring split.

### What `buildCenterlineRescuePath` does for arc-shaped children

At each CONTINUE level, `stepArms` calls `buildCenterlineRescuePath` to connect
the tracked corner to the next offset level's corner. The rescue path:

1. Starts at the corner (pinch point)
2. Steps along the medial axis of the arc using `findPerpendicularChannelMidpoint`
3. At each step, computes Z = `topZ - minDistToWall / slope`

For a **uniform-width arc band**, the distance to the nearest wall is approximately
constant along the entire arc. Therefore Z stays flat — the rescue path walks
horizontally along the center of the arc at a constant depth.

### Why Z should NOT be flat

The correct V-carve depth at any point inside the shape is determined by the
distance to the nearest wall of the **original shape** (the 'o' outline), not the
distance to the walls of the current offset contour. As the rescue path walks from
one pinch point toward the arc midpoint, it moves farther from the pinch point
corners and deeper into the shape — the correct Z should decrease (go deeper).

The flat Z is a consequence of using the **local channel width** (distance between
the two walls of the current offset band) as the depth reference. This is correct
for the bridge midpoint Z calculation, but wrong for the rescue path which is
supposed to trace the skeleton arm from one corner to another.

### The actual skeleton arm for an arc

For an arc-shaped child of 'o', the correct skeleton arm connects the two pinch
point corners with a smooth path that:
- Starts at corner A at Z = `topZ - distA / slope` (where distA = distance from A to nearest wall)
- Descends to the arc midpoint at Z = `topZ - distMid / slope` (deepest point)
- Rises back to corner B at Z = `topZ - distB / slope`

This is an inverted-V shape in 3D. The current rescue path produces a flat
horizontal line instead.

## Affected Code

`buildCenterlineRescuePath` in `vcarveRecursive.ts`:

The function walks the medial axis and computes Z from `minDistToContourWalls`.
For a uniform-width band, this gives constant Z. The function was designed for
shapes where the medial axis converges (getting narrower as you walk inward),
but for arc-shaped post-split children the band width is roughly constant.

## Proposed Fix

The rescue path Z should be computed from the distance to the walls of the
**original region's contour** (the pre-split parent), not the current offset
contour. The original contour has the correct V-carve geometry — points near
the pinch corners are close to the original walls, points at the arc midpoint
are farther from the original walls.

Alternatively: instead of using `buildCenterlineRescuePath` for the CONTINUE
case (connecting corners across an arc), use a direct 2-point arm segment from
the current corner to the nearest corner on the next offset level. This is what
the original simple `stepCorners` did — and it produced correct diagonal arms.
The rescue path is only needed when the direct connection is blocked.

The key distinction:
- `buildCenterlineRescuePath` is correct for **converging** shapes (getting narrower)
  where the medial axis walk naturally descends in Z
- It is **wrong** for **uniform-width** shapes (arcs, bands) where the medial axis
  walk stays at constant depth

## Test Case

- File: `/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj`
- Operation: `op0046` (V-Carve skeleton o)
- Verification: after fix, the Z profile should show smooth diagonal segments
  (dz ≈ constant per unit XY) rather than flat-then-step patterns.
- Metric: flat segment percentage should drop from 85% to near 0%.

## Related

- `bridgeSiblingChildren` has the same issue for the same reason — it walks the
  parent contour's medial axis and gets flat Z for uniform-width bands.
- The fix for `bridgeSiblingChildren` (using `minDistToContourWalls` with the
  original contour) partially addresses this but the walk direction is still
  tangential rather than radial for arc shapes.
