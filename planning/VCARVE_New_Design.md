# Design Specification: Boundary-Normal MAT V-Carve for PureCutCNC

## 1. Overview
The goal is to implement a V-carving toolpath generator that finds the local medial spine by scanning inward from the true boundary. Instead of testing every interior grid point, the solver traces rays along inward normals from the digitized wall, finds where that ray first meets the opposite side of the material, and then refines the medial point along that 1D interval.

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
3. Use the segment midpoint as the ray origin.
4. Cast the inward ray and find the first forward intersection with any boundary segment other than the source segment.
5. This source-to-exit interval becomes the 1D search domain for the medial point.

### Step 3: Medial Hit Refinement
Within the source-to-exit interval:
- Start at the midpoint of the interval.
- Measure:
  - $d_{source}$ = exact distance from the test point to the source segment
  - $d_{other}$ = shortest distance to any non-source boundary sample
- Apply the binary update rule:
  - if $|d_{source} - d_{other}| \le tolerance$, accept the point
  - if $d_{other} < d_{source}$, the test point is too far inward, so move the upper bound back toward the source
  - if $d_{other} > d_{source}$, the test point is still source-dominated, so move the lower bound outward toward the previous farther point
- Use the accepted point as the provisional spine point.
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

### Step 6: Debug Instrumentation
During solver development, the preview can optionally draw:
- low bracket points near the source wall
- high bracket points at the ray exit
- binary-search probe points
- accepted raw medial hits

These overlays are diagnostic only and should stay independently switchable from the main MAT toolpath preview.

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

    const exitDistance = nearestRayExitDistance(origin, normal, region, i);
    if (exitDistance === null) {
      continue;
    }

    let low = 0;
    let high = exitDistance;

    for (let iteration = 0; iteration < 6; iteration++) {
      const mid = (low + high) * 0.5;
      const sample = {
        x: origin.x + normal.x * mid,
        y: origin.y + normal.y * mid,
      };

      const dSource = distanceToSegment(sample, p1, p2);
      const dOther = nearestOtherBoundaryDistance(sample, p1, boundaryCloud, boundaryIndex);

      if (Math.abs(dSource - dOther) <= stepSize * 0.75) {
        hits.push({
          x: sample.x,
          y: sample.y,
          radius: Math.min(dSource, dOther),
        });
        break;
      }

      if (dOther < dSource) {
        high = mid;
      } else {
        low = mid;
      }
    }
  }

  return hits;
}
```

## 4. Operational Notes
- Boundary resolution should stay at least as fine as the ray step, and often finer around corners.
- The nearest-boundary query is still performance critical, so the spatial index remains mandatory.
- Inward normal selection should be validated against the actual material region, not assumed from polygon winding alone.
- The current prototype measures the source side against the exact source segment, not an approximate source sample neighborhood.
- Duplicate path cleanup is expected because opposite walls can converge to the same medial branch.
- Corner cleanup and junction cleanup remain separate post-processing problems even when the medial hit detection is correct.
- This approach favors ordered tracing and stable Z evaluation over dense interior classification.
