# V-Carve Recursive: Letter A — Deep Z Plunge Root Cause

## The Bug

`bridgeSiblingChildren` produces bridge paths that plunge far too deep. In letter A,
the bridge midpoint hits z=0.3760 when the correct Z is ~0.5588 — an error of 0.183"
with a 60° V-bit. The path immediately rises back after the deep point, confirming
the Z is wrong rather than the XY position.

## Root Cause: Wrong Z Reference in the Bridge Formula

The Z formula in `bridgeSiblingChildren` (line ~1353):

```ts
const targetZ = currentZ - channel.radius / slope
```

This is **fundamentally wrong**. It uses `currentZ` (the Z of the parent contour edge
at the split moment) as the reference, then subtracts `channel.radius / slope`.

The V-carve depth formula always measures from the **material surface** (`topZ`), not
from the current offset level. The correct formula is:

```ts
const targetZ = topZ - distToNearestWall / slope
```

where `distToNearestWall` is the minimum distance from the probe point to any wall of
the parent contour (the inscribed circle radius at that XY location).

## Why `currentZ` Is Wrong

`currentZ` is the Z of the parent contour's *edge* — i.e. the depth the V-bit reaches
when its tip is sitting exactly on the parent contour boundary. As the probe walks
inward from a child corner, it is already inside the shape, at some distance from the
walls. The depth at any interior point is determined solely by its distance to the
nearest wall, measured from `topZ`.

Using `currentZ` as the reference effectively adds an extra offset equal to
`(topZ - currentZ)`, making the computed Z too deep by exactly that amount.

## Why `channel.radius` Is Also Wrong

`findPerpendicularChannelMidpoint` measures the **perpendicular half-width** of the
channel — the distance from the probe to the nearest wall in the direction
perpendicular to the walk guide. For a thin shape (like the crossbar of T) this
approximates the inscribed circle radius well. For a wide shape (like the legs of A),
the perpendicular hits the far wall of the band, giving the full band width — much
larger than the true inscribed circle radius at that point.

Measured values at the deep bridge points in letter A:
| Point | minDistToWall | channelHalfWidth | correctZ | actualZ | error |
|-------|--------------|-----------------|----------|---------|-------|
| (2.9608, 1.5849) | 0.1104 | ~0.2007 | 0.5588 | 0.3760 | -0.183 |
| (2.9641, 1.5945) | 0.1108 | ~0.2007 | 0.5580 | 0.3760 | -0.182 |
| (2.9666, 1.6068) | 0.1126 | ~0.2007 | 0.5550 | 0.3760 | -0.179 |

The channel half-width (~0.2007) is nearly double the true min-dist-to-wall (~0.111),
and the wrong `currentZ` reference compounds the error further.

## The Fix

Replace the Z formula in `bridgeSiblingChildren` with the correct one:

```ts
// WRONG (current):
const targetZ = currentZ - channel.radius / slope
const pointZ = Math.max(minZ, Math.min(lastZ, targetZ))

// CORRECT:
const distToWall = minDistToContourWalls(channel.point, allParentContours)
const targetZ = topZ - distToWall / slope
const pointZ = Math.max(minZ, Math.min(topZ, targetZ))
```

Where `minDistToContourWalls` computes the minimum distance from a point to any
segment of any of the parent contours (outer + islands). This is the inscribed circle
radius — the exact quantity the V-carve formula requires.

The same fix applies to `buildCenterlineRescuePath` which uses the identical formula:

```ts
// line ~1640:
const targetMidpointZ = currentZ - (channel.radius / slope)
```

This should also use `topZ - minDistToWall / slope`.

## Why This Works for T but Breaks for A

For the crossbar of T, the parent contour at the split moment is a thin horizontal
band. The perpendicular channel half-width ≈ the inscribed circle radius because the
band is narrow and the perpendicular hits the near wall. The `currentZ` error is also
small because the split happens early (shallow offset), so `currentZ ≈ topZ`.

For the legs of A, the parent contour is wide. The perpendicular hits the far wall of
the leg, giving a large channel radius. The split also happens at a deeper offset
(the A's legs are wide, so the inset travels far before splitting), making the
`currentZ` reference error larger.

## Test Scripts

- `scripts/trace-letter-a-bridge-z.ts` — reverse-engineers the radius from the observed Z
- `scripts/trace-letter-a-bridge-z2.ts` — verifies min-dist-to-wall gives the correct Z
- `scripts/analyze-letter-a.ts` — full move list and dangerous drop detection
- `scripts/analyze-letter-a-drops.ts` — focused context around each drop

## Test Case

- File: `/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj`
- Operation: `op0008` (V-Carve skeleton A)
- After fix: no bridge midpoint Z should be deeper than `topZ - minDistToWall / slope`
  for any point inside the parent contour. The deep point at z=0.3760 should become
  ~0.558.

## Affected Functions

1. `bridgeSiblingChildren` — primary location of the bug
2. `buildCenterlineRescuePath` — same formula, same bug, may affect other letters

## Status: FIXED

Fixed by replacing `currentZ - channel.radius / slope` with `topZ - minDistToContourWalls(point, contours) / slope`
in both `bridgeSiblingChildren` and `buildCenterlineRescuePath`. Added `minDistToContourWalls` helper and
threaded `topZ` through the call chain: `traceRegion` → `stepArms` / `bridgeSplitArms` /
`buildFreshSeedBootstrapCuts` → `buildCenterlineRescuePath`.

Verification: zero `badDrops` (deep cut immediately followed by rising cut) across all test letters
(o, e, C, T, A) after the fix. The z=0.3733 and z=0.3760 drops in letter A are gone.
