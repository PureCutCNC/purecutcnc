# V-Carve: Clipper-Based Skeleton Extraction Design

**Date:** 2026-04-05
**Status:** Implementation in progress — hybrid collapse strategy decided
**File:** `src/engine/toolpaths/vcarve/clipperSkeleton.ts`

---

## Core idea

Approximate the straight skeleton by stepping inward with Clipper offsets and detecting topology changes (splits and collapses) between consecutive frames. The output is a `SkeletonGraph { arcs, nodes }` that feeds directly into the existing `depth.ts → toolpath.ts` pipeline.

**Key:** always re-offset from the original polygon at each step (absolute offset), never chain incremental offsets. This avoids accumulated drift.

---

## Algorithm overview

1. Build `initialPaths` from `region.outer` + `region.holes` (CCW outer, CW holes).
2. Step `absoluteOffsetCli` from `stepCli` to `maxRadius` in increments of `stepCli`.
3. At each step call `clipperInset(initialPaths, absoluteOffsetCli)` → `insetPaths`.
4. Convert surviving paths to `LiveContour[]` (id, centroid, area, points).
5. Match `prevContours` → `currContours` by centroid proximity (two-phase, see below).
6. Classify topology events: COLLAPSE, CONTINUATION, SPLIT.
7. After the loop, emit terminal geometry for any contours still alive at `maxRadius`.

---

## Contour matching (two-phase)

Phase 1 — strict one-to-one greedy match (handles normal continuation, N→N).
Phase 2 — orphaned `curr` contours re-match to nearest `prev` without exclusivity.
Multiple `curr` mapping to the same `prev` = SPLIT detected.

---

## Tracking maps (per contour id)

- `lastCentroid` / `lastRadius` — position and radius at the most recent frame.
- `lastEventCentroid` / `lastEventRadius` — position and radius at the **last topology event** (split or initial placement). Used to emit the full arc from that branching point to the contour's eventual collapse.

---

## Topology event handlers

### COLLAPSE — contour disappears

A previous contour has no match in the current frame.
Calls `emitCollapseGeometry(graph, prev, r, eventCentroid, eventRadius)`.

### CONTINUATION — 1 prev → 1 curr

No arc emitted. Just propagate `lastEventCentroid`/`lastEventRadius` to the new contour id. Arcs are only emitted at topology-event boundaries so the graph stays clean.

### SPLIT — 1 prev → N curr (N ≥ 2)

1. Emit arc: `lastEventCentroid[prev] → splitCentroid` at radii `[lastEventRadius[prev], rSplit]`.
2. Emit node at `splitCentroid, rSplit`.
3. Set each child's `lastEventCentroid = splitCentroid`, `lastEventRadius = rSplit`.
4. Do **not** emit child arcs yet — those will be emitted at the child's eventual collapse.

---

## Collapse geometry — the hybrid decision

`emitCollapseGeometry` uses a **single condition** to choose between two strategies:

### Case A — contour has a meaningful prior event (post-split arm)

Condition: `dist(lastEventCentroid, prev.centroid) > 2 * stepSize`

Action: emit a **single arc** from `lastEventCentroid → prev.centroid` at radii `[lastEventRadius, r]`.

This produces the correct skeleton arm running from the split/branch node to the tip of the arm. Works for: hourglass arms, T junction arms, any shape that produces topology splits.

### Case B — contour never split (original contour throughout its life)

Condition: `dist(lastEventCentroid, prev.centroid) ≤ 2 * stepSize`

Action: emit the **last surviving polygon boundary** as arc segments (`prev.points[i] → prev.points[i+1]` at constant radius `r`).

Rationale: the innermost Clipper offset contour IS the approximate medial axis of the shape. For shapes that shrink without splitting (F, rectangle, circle, triangle), this polygon directly traces the skeleton. Works for: letter F, letter T strokes, rectangle spine, circle center.

### Special cases

- `prev.points.length < 3`: emit a single node at `prev.centroid`.
- `prev.points.length === 2`: emit one arc between the two points.

---

## Why no separate corner-clearing pass is needed

The straight skeleton by definition includes arcs from every reflex-free vertex of the original polygon to the nearest skeleton junction. In this Clipper-based approximation:

- For shapes that split: the split arc (from split node to the arm tip) covers the corner-to-skeleton connection, because the collapse centroid of a triangular arm tip naturally lies near the corner bisector.
- For shapes that use the polygon fallback (Case B): the polygon boundary arcs connect adjacent corners and trace through the skeleton, inherently covering corner connections.

A separate corner-clearing post-processing pass is therefore **not needed** — it would be an indication that the skeleton itself is incomplete or disconnected.

---

## Exit criteria

The solver is correct when all of the following produce proper skeleton output:

1. **Rectangle** → single spine along the long axis
2. **Circle / dot** → single center point node (or tiny center polygon)
3. **Letter I** (tall rectangle) → vertical spine
4. **Letter F** → two horizontal arms + one vertical stem, meeting at junctions
5. **Letter T** → one horizontal arm + one vertical stem, meeting at junction
6. **Hourglass / bowtie** → vertical arc through the waist + two arm tips, one at each lobe
7. **Triangle** → three arms from centroid/incenter to the three sides
8. **Letter O / ring** → arc midway between outer and inner boundary

---

## Pipeline integration

`pipeline.ts → buildGeometricVCarveRegionResult()`:

```
solveClipperSkeleton(region, { stepSize, maxRadius })
  → constrainSkeletonGraphToRegion      // filter arcs outside original polygon
  → cleanupSkeletonGraph                // deduplicate, merge collinear, filter tiny arcs
  → skeletonGraphToRadiusBranches       // sample arc/node positions with radii
  → radiusBranchesToToolpathMoves       // emit variable-Z cut moves
```

Parameters:
- `stepSize = clamp(segmentLength * 0.5, 0.01, 0.1)` mm
- `maxRadius = maxDepth * slope` (slope = tan(halfAngle) of V-bit)

---

## What this does NOT do

- No wavefront simulation
- No bisector computation
- No analytical event detection
- No per-step arc emission during continuation (only at events)
- No corner-clearing post-processing pass
- No contour-parallel toolpath loops

The entire `skeleton.ts` and `wavefront.ts` complexity is bypassed. Only `clipperSkeleton.ts` is new; everything downstream (`cleanup.ts`, `depth.ts`, `toolpath.ts`, `traverse.ts`) is reused unchanged.
