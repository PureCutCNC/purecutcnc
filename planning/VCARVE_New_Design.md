# Design Specification: Boundary-Normal MAT V-Carve for PureCutCNC

## 1. Overview
The goal is to implement a V-carving toolpath generator that finds the local medial spine by scanning inward from the true boundary. Instead of testing every interior grid point, the solver traces rays along inward normals from the digitized wall and records the point where the nearest wall "flips" to a different boundary neighborhood.

This keeps the critical V-carve invariant:

$$Z = \frac{R_{min}}{\tan(\theta / 2)}$$

Where:
- $R_{min}$ is the local distance from the spine point to the nearest wall
- $\theta$ is the V-bit angle

## 2. Technical Architecture

### Step 1: Boundary Digitization (Edge Point Cloud)
Convert all input Clipper paths into a dense point cloud.
- Interpolate every contour segment so no segment is longer than the boundary resolution.
- Keep contours grouped for ordered scanning, but also flatten them into one unified cloud for nearest-neighbor lookup.
- Build a spatial index over the flattened cloud for fast nearest-boundary queries.

### Step 2: Boundary-Normal Scan
For each contour in order:
1. Take consecutive boundary samples $(P_i, P_{i+1})$.
2. Compute the local inward normal from that segment.
3. Start from the segment midpoint and step inward by `gridScale` increments.
4. At each test point, query the nearest boundary sample.
5. As long as the nearest boundary is still the originating wall neighborhood, continue stepping inward.
6. The moment the nearest boundary is no longer the originating wall, the scan has crossed the medial axis.

### Step 3: Medial Hit Refinement
When a scan crosses from the source wall to a different wall neighborhood:
- Refine the crossing interval with a short binary search.
- Use the refined point as the provisional spine point.
- Compute its carving radius from the nearest boundary distance.
- Compute Z from the V-bit slope:
  $$Z = Z_{top} - \min\left(D_{max}, \frac{R_{min}}{\tan(\theta / 2)}\right)$$

### Step 4: Path Construction
Because scans are emitted in boundary order, provisional spine hits already arrive grouped by their source contour.
- Keep hits in scan order to form provisional paths.
- Remove consecutive duplicates and tiny corner artifacts.
- Merge or drop near-identical duplicate paths created by opposite walls collapsing onto the same spine.
- Leave retract / rapid / plunge transitions between disconnected paths.

### Step 5: G-Code Generation
- Optionally simplify final paths.
- Emit `G01` cut moves along each spine path with computed Z.
- Emit safe retract and rapid moves between disconnected branches.

## 3. Reference Loop

```typescript
function scanSpineFromBoundary(
  contour: BoundaryPoint[],
  boundaryCloud: BoundaryPoint[],
  boundaryIndex: BoundaryIndex,
  region: Region,
  stepSize: number,
): SpinePoint[] {
  const hits: SpinePoint[] = [];

  for (let i = 0; i < contour.length; i++) {
    const p1 = contour[i];
    const p2 = contour[(i + 1) % contour.length];
    const origin = midpoint(p1, p2);
    const normal = inwardNormalForSegment(p1, p2, region);
    if (!normal) {
      continue;
    }

    let lastSame = 0;
    let dist = stepSize;

    while (dist < maxDistanceForRegion(region)) {
      const sample = {
        x: origin.x + normal.x * dist,
        y: origin.y + normal.y * dist,
      };

      if (!pointInRegionMaterial(sample, region)) {
        break;
      }

      const nearest = nearestBoundaryPoints(sample, boundaryCloud, boundaryIndex, 1)[0];
      if (!isSameWallNeighborhood(p1, nearest.point)) {
        const refined = refineFlip(origin, normal, lastSame, dist);
        hits.push(refined);
        break;
      }

      lastSame = dist;
      dist += stepSize;
    }
  }

  return hits;
}
```

## 4. Operational Notes
- Boundary resolution still needs to be finer than the normal scan step.
- The nearest-boundary query is still performance critical, so the spatial index remains mandatory.
- Inward normal selection should be validated against the actual material region, not assumed from polygon winding alone.
- Duplicate path cleanup is expected because opposite walls can converge to the same medial branch.
- This approach favors ordered tracing and stable Z evaluation over dense interior classification.
