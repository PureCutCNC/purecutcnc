# V-Carve Geometric Solver — Analysis Report

**Date:** 2026-04-05  
**Scope:** Analysis of visible failures in the geometric skeleton solver based on the test image and full code review. No changes made.

---

## What the test image shows

Seven test shapes are visible. Mapping left to right:

| Shape | Description | Skeleton visible |
|---|---|---|
| Bowtie/hourglass | Concave waist — two wide triangular lobes joined at a narrow neck | Busy, wrong — many crossing branches, no clean medial arc through waist |
| Tall rectangle (I) | Simple convex shape | Correct — one vertical spine with corner branches |
| Letter F | Two internal 270° concave corners | Wrong — branches point outward from interior corners instead of inward along strokes |
| Circle (dot) | Regular polygon approximation | Wrong — radial star of many short spokes instead of collapsing to a center point |
| Letter T | Two internal 270° concave corners | Partially correct on crossbar; missing stroke arm spine |
| Triangle | Simple convex | Correct — three branches meeting at centroid |

The solver is working correctly for **convex polygons with no reflex vertices**. It is failing for shapes with **reflex vertices** (concave corners) and for **near-circular/regular shapes** with many vertices of similar bisector speed.

---

## Root cause analysis

### Problem 1: Split event detection is not finding events that should exist (reflex vertex misses)

**What should happen:** When a reflex vertex's bisector ray hits the opposite side of the polygon, a split event fires and the ring divides into two sub-rings. For a shape like the hourglass waist or the interior corners of F and T, this is the critical event that produces the correct skeleton branching.

**What is happening:** The split events are either not being detected, or are being detected at the wrong time and discarded.

**Where the bug is — `splitEventForVertexAgainstEdge` in `skeleton.ts`:**

The inward normal direction for the edge is computed as:
```ts
const inwardNormal = ring.hole ? rightNormal(edgeDirection) : leftNormal(edgeDirection)
```

But the outer ring winding in this codebase is **CCW** (counter-clockwise). For a CCW polygon, the inward normal of an edge pointing from A→B is the **right** normal (rotating the direction vector 90° clockwise). But the code uses `leftNormal` for non-hole rings. This is inverted.

The consequence: the split event formula computes a time `t` that is negative or imaginary for valid inward intersections, so they are filtered out by `time > EVENT_EPSILON` and the split never fires.

**Verify:** In `geometry.ts`, `leftNormal` is `(-dy, dx)` — that is the CCW perpendicular, pointing to the **left** of the direction of travel. For a CCW ring with an edge pointing rightward (positive X), the left normal points upward — **outward** from the polygon, not inward. The right normal `(dy, -dx)` would point downward — inward. So for a CCW outer ring, `rightNormal` is the inward normal, but `leftNormal` is used.

**Note:** The edge building in `wavefront.ts` `buildEdges` correctly uses `leftNormal` for holes and `rightNormal` for the outer ring... but then `buildVertices` calls `angleBisector(prevEdge.direction, nextEdge.direction, prevEdge.inwardNormal, hole)` passing the already-correct `inwardNormal` from the edge. So the bisector directions for vertices are computed correctly from the correct edge normals. However `splitEventForVertexAgainstEdge` independently re-derives the inward normal from the edge direction using the opposite convention. **This inconsistency is the likely root cause of split events being missed.**

---

### Problem 2: Edge event intersection uses bisector rays as lines, not as ray vs. bisector of neighbor

**What is happening in `edgeEventForVertex`:**

```ts
const left = rayLineIntersection(vertex.point, vertex.bisectorDirection, prev.point, prev.bisectorDirection)
const right = rayLineIntersection(vertex.point, vertex.bisectorDirection, next.point, next.bisectorDirection)
```

This finds where the current vertex's bisector ray intersects the *bisector lines* of its two neighbors. This is a shortcut that works in the ideal case but is not what a proper straight skeleton computes. The correct edge event time for vertex V is the time at which the two adjacent wavefront edges collapse — i.e., when the moving edge endpoints (not the bisector lines of the neighbor vertices) coincide. The current approach gives approximately correct times for convex polygons (which is why the rectangle and triangle work) but drifts for polygons with varying edge lengths, which is why the circle produces a radial star rather than a center point.

For a regular polygon with N sides, all bisectors converge at the same time to the centroid. The code should detect this as a simultaneous multi-vertex edge event and emit a single center node. Instead, each vertex finds a slightly different time (due to floating-point variation in the bisector intersection) and they collapse sequentially, each emitting a short arc to a slightly different point, producing the observed radial star of arcs.

---

### Problem 3: `collapseEdgeCluster` all-event centroid path has a guard that prevents it from firing on circles

```ts
if (allEventVertices && collapsePoints.length > 2 && cluster.every((vertex) => !vertex.reflex)) {
  const centroid = collapsePoints.reduce(...)
  appendNode(graph, center, ring.offset + time)
  continue
}
```

This guard requires `collapsePoints.length > 2`. For a circle approximated with many vertices, the edge events will not all fall within `EVENT_EPSILON = 1e-7` of each other — the time window is too tight for a floating-point wavefront simulation of a regular polygon. So `allEventVertices` is false, events fire one at a time, and the star pattern emerges. Widening the event clustering window could help for the circle case specifically, but the fundamental issue is Problem 2.

---

### Problem 4: `constrainSkeletonGraphToRegion` clips valid branches for concave shapes

For the hourglass/bowtie shape, the skeleton includes a branch along the narrow waist axis. However `segmentInsidePreparedRegion` tests 12 uniformly-spaced samples along each arc:

```ts
for (let index = 0; index <= safeSamples; index += 1) {
```

For a skeleton arc that runs very close to the boundary (near the narrow waist), some of the 12 sample points may land just outside the polygon boundary due to floating-point precision, causing the arc to be discarded. This is visible as missing skeleton arms near concave features, exactly what the bowtie shows. Increasing the sample count or adding a small tolerance band to `pointInPreparedRegion` would reduce false removals, but the real fix is Problem 1 — if split events fire correctly, the skeleton arcs will be better-centered in the polygon and less likely to be clipped.

---

### Problem 5: Holes are explicitly skipped in `geometricToolpath.ts`

```ts
if (preparedRegion.holes.length > 0) {
  warnings.push('Geometric V-carve solver does not yet support regions with holes')
  continue
}
```

This means letters like `a`, `e`, `o`, `p`, `q`, `d`, `b` — any closed letter with a counter (interior void) — produce no toolpath at all. This is the correct and honest thing to do right now (rather than producing wrong output), but it is the reason those letter shapes produce nothing. The solver would need proper polygon-with-holes skeleton support to handle these, which requires each hole's wavefront to propagate inward (toward the outer ring) and fire split events when they collide with the outer ring's wavefront. The current architecture processes each ring independently, which is correct for a polygon without holes, but two independent wavefronts never interact.

---

## Summary of what needs to change

### Fix 1 — Inward normal convention in split event detection (HIGH priority)

In `splitEventForVertexAgainstEdge` in `skeleton.ts`, change:
```ts
const inwardNormal = ring.hole ? rightNormal(edgeDirection) : leftNormal(edgeDirection)
```
to:
```ts
const inwardNormal = ring.hole ? leftNormal(edgeDirection) : rightNormal(edgeDirection)
```

This is the inverse of the current code. For a CCW outer ring, the inward normal is the right normal; for a CW hole ring, it is the left normal. This should unlock split events for all the interior-corner shapes (F, T, hourglass).

**Verify the expected convention first** by checking: given a CCW outer ring with an edge from left to right (positive X direction), the interior of the polygon is below the edge (negative Y). The right normal of (1,0) is (0,-1) — pointing downward into the interior. That is correct. The left normal (0,1) points outward. So `rightNormal` is correct for the outer ring.

---

### Fix 2 — Proper edge event timing (MEDIUM priority)

The current bisector-vs-bisector intersection approach approximates edge event time but does not compute it from first principles. For each non-reflex vertex V with neighbors P and N, the correct edge event time is:

```
The time at which the wavefront edges (P→V) and (V→N) both vanish,
i.e. when the moving endpoint of (P→V) meets the moving start of (V→N).
```

This is equivalent to finding when the moving point at V reaches the intersection of the moving lines through the P and N edges, which is what the bisector approach approximates — but only exactly when P, V, N all have equal edge speeds. For polygons with unequal edge lengths this diverges.

The correct formula: advance P and N by time t, find the intersection of (moved P edge line) and (moved N edge line), and solve for t such that V's moved position equals that intersection. This is a quadratic in the general case but linear for straight-skeleton (since edge directions don't change). This is the standard straight-skeleton edge event formula.

---

### Fix 3 — Multi-ring wavefront interaction for holes (LOW priority / scope expansion)

To support letters with counters, the wavefront must be initialized with both the outer ring and the holes simultaneously, and events between the outer ring and a hole ring must be handled — these produce split events that split the outer ring into pieces that wrap around each hole. This requires the solver loop to consider cross-ring events, which is a significant extension. Currently each ring is processed independently.

This is the correct thing to defer. The current skip-with-warning behavior is appropriate.

---

### Fix 4 — Widen event cluster epsilon or switch to exact simultaneous detection (LOW priority)

For the circle case specifically, simultaneous edge events that should collapse to one center node are being processed one at a time due to EVENT_EPSILON being too tight relative to floating-point drift in the wavefront positions. Widening `EVENT_EPSILON` from `1e-7` to something like `1e-5` would help here but risks merging events that should be separate for complex polygons. The cleaner fix is Fix 2 (correct event timing), which would make all circle events arrive at exactly the same computed time and naturally cluster.

---

## Recommended build order

1. **Verify and fix the inward normal convention in split event detection** — this is likely responsible for both the hourglass and the F/T failures. Test on the hourglass first; if it produces a clean waist-axis branch, the formula is correct.
2. **Replace the edge event timing approximation** with the correct linear solve — this should fix the circle and improve regularity of all event times.
3. **Widen the event cluster epsilon** as a patch if Fix 2 does not fully resolve the circle.
4. **Multi-ring wavefront (holes)** — defer until Fixes 1 and 2 are stable and tested on letters without counters.
