# SAME-CHILD CORNER BRIDGE ALGORITHM

This document describes the medial-axis-style bridging algorithm that connects corners on the **same offset level** in V-Carve recursive toolpaths, including curved narrow passages.

## Objective

Connect sharp, convex corners on the same contour/offset level across narrow passages in the parent geometry, following the required depth profile. This handles both:

- **Cross-child connections** (corners on different child regions at a SPLIT boundary)
- **Same-child connections** (corners on the same child region across a narrow pinch point)

## Implementation

The algorithm is implemented in [`bridgeSiblingChildren()`](../src/engine/toolpaths/vcarveRecursive.ts:1342), called from [`traceRegion()`](../src/engine/toolpaths/vcarveRecursive.ts:2093) at two sites:

| Call Site | Trigger | Purpose |
|-----------|---------|---------|
| SPLIT (line 2150) | `nextRegions.length > 1` | Connect corners across different children that share a parent pinch point |
| CONTINUE (line 2267) | always after `stepArms` + `buildFreshSeedBootstrapCuts` | Connect corners on the same child across a narrowing passage |

## Algorithm Steps

### Step 1 — Corner Detection

Collect all convex corners from all child regions, tagging each with its child index:

```typescript
const allChildCorners: { point: Point, childIdx: number }[] = []
for (let ci = 0; ci < nextRegions.length; ci += 1) {
  for (const c of detectRecursiveCorners(nextRegions[ci].outer, stepSize)) {
    allChildCorners.push({ point: c, childIdx: ci })
  }
}
```

A deduplication set (`connectedCornerIndices`) tracks which corners have already been connected-to by another corner's walk. When corner A walks and connects to corner B, B's index is recorded so its own walk is skipped, avoiding A→B, B→A duplicates.

### Step 2 — Outward Bisector

For each unconsumed corner, compute the **inward** bisector at that corner on the **child** contour, then negate it to get the **outward** direction. The outward bisector projects away from the child's interior, through the narrow passage into the parent region.

```typescript
const inward = inwardDirectionAtContourPoint(nextRegions[startChildIdx].outer, startCorner)
const outward = { x: -inward.x, y: -inward.y }
```

### Step 3 — Medial Walk

Advance the walk point by `stepSize` along the current guide direction. At each step:

1. **Probe**: Compute a probe point at `currentPoint + currentGuide * stepSize`.
2. **Bounds check**: If the probe is outside the parent contour (via `pointInPolygon`), terminate this walk (no connection possible from this corner).
3. **Perpendicular channel**: Construct a line through the probe, perpendicular to the guide direction. Intersect it with all parent walls (outer contour + islands). Find the bracketing pair with the **narrowest** separation and take the **midpoint** — this is the channel center.
4. **Z-depth**: Compute `topZ - distToWall / slope` where `distToWall` is the true distance to the nearest parent wall (`minDistToContourWalls`). Clamp by `minZ` and prevent Z-increasing steps.
5. **Record midpoint**: Push the channel midpoint as a `Point3D` onto the accumulating path.

### Step 4 — Channel Centerline Guide Update (Key for Curved Passages)

After advancing to each channel midpoint (and the path has ≥3 points), update the guide direction to follow the **direction from the previous channel midpoint to the current one**:

```typescript
if (path.length >= 3) {
  const pdx = channel.point.x - path[path.length - 3].x
  const pdy = channel.point.y - path[path.length - 3].y
  const plen = Math.hypot(pdx, pdy)
  if (plen > 1e-12) {
    currentGuide = { x: pdx / plen, y: pdy / plen }
  }
}
```

**Why this is necessary**: The fixed outward bisector from Step 2 is a purely local direction derived from the two edges meeting at the corner. In curved narrow passages (e.g., the letter e's bowl-to-outer pinch point), this fixed bisector has a component that points **out of** the parent contour, causing the walk to fail after a few steps. By updating the guide to follow the channel centerline, the walk stays centered in the passage and navigates curves naturally.

For straight passages (e.g., letter A legs), the centerline direction matches the initial bisector, so behaviour is unchanged.

### Step 5 — Snap Detection

At each step, check whether any **other** corner (same child or different child, excluding only the starting corner itself) is within `stepSize` of the current channel midpoint:

```typescript
const snapTargetIdx = allChildCorners.findIndex(
  (c, idx) => idx !== ci
    && Math.hypot(c.point.x - channel.point.x, c.point.y - channel.point.y) <= stepSize,
)
```

- If a target is found: record the target's index in `connectedCornerIndices` (preventing a duplicate back-and-forth walk later), append the channel midpoint and the target corner to the path, mark the walk as connected, and emit.
- If no target is found: continue to the next step (go to Step 3).

### Step 6 — Path Emission

If the walk successfully connected (path length ≥ 2 and `connected = true`), simplify the path using `simplifyPath3DCollinear` with a tolerance of `stepSize * 0.05`, tag it with `diagTag('bridgeSiblingChildren', ...)`, and push it into the cuts array.

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Same-child matching allowed | The walk moves **into the parent region** before snap-checking, so any found same-child corner is across the narrow passage, not adjacent along the contour. Excluding `childIdx !== startChildIdx` would miss these connections. |
| Channel centerline guide update | Fixed outward bisector fails in curved passages (letter e). Following the channel centerline keeps the walk inside the parent contour. |
| `minDistToContourWalls` for Z | Uses the true inscribed-circle radius at the XY point (`topZ - distToWall / slope`), not the perpendicular half-width. This is correct for all shapes including wide legs (letter A). |
| Connected-corner deduplication | Prevents double emission: corner A walks to B, then B's walk would walk back to A. Recording B's index in `connectedCornerIndices` skips the redundant B→A path. |
| No multi-child guard | Removing `nextRegions.length > 1` allows same-child bridging at CONTINUE steps where there is exactly one child. |

## Verification

The algorithm is verified via:

- [`scripts/quick-verify.ts`](../scripts/quick-verify.ts) — generates toolpaths for all 6 test operations (C, A, T, e, o, circle) and reports cut/rapid counts.
- [`scripts/check-letter-e.ts`](../scripts/check-letter-e.ts) — specifically checks that the pt1→pt2 bridge across the letter e's curved pinch point is produced.

**Letter-e bridge (DIAG output)**:
```
DIAG[0] source=bridgeSiblingChildren len=0.1755 z=0.6634 pts=8
  [0](4.8482,1.0615) [1](4.8672,1.0550) [2](4.8964,1.0480) [3](4.9261,1.0434)
  [4](4.9562,1.0430) [5](4.9861,1.0459) [6](5.0058,1.0498) [7](5.0236,1.0545)
```

The walk takes 17 steps, with the guide direction evolving from (0.9145, -0.4046) to (0.981, 0.193), successfully navigating the curved passage.
