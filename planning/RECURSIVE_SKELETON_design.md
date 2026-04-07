# Design Document: Recursive Skeletonized V-Carve Generator

## 1. Overview
This algorithm generates high-quality 3D V-carve toolpaths from 2D polygons. It uses a recursive "Poor Man’s Straight Skeleton" approach to find the center "ridges" of a shape, connecting vertices vertically to create the sloping walls of a V-groove.

## 2. Core Geometry & Physics
* **V-Bit Math:** Vertical depth ($Z$) is calculated based on the horizontal offset distance ($d$) and the bit's included angle ($\theta$):
  $$Z = -\frac{d}{\tan(\theta/2)}$$
* **Coordinate Space:** $Z=0$ is the material surface. All toolpath $Z$ values are negative.
* **Tooling:** Designed for a V-shaped engraving bit.

## 3. Pre-Processing (The "Clean" Phase)
Before any offset is processed, the polygon must be sanitized to prevent "chatter" and spikes:
1. **Join Type:** Use `JoinType.jtRound` in Clipper to stabilize inner corners.
2. **Vertex Filtering:** Remove any vertex where $Dist(P_i, P_{i-1}) < (stepSize / 2)$.
3. **Winding:** Ensure all outer polygons are Clockwise and all holes are Counter-Clockwise (or vice-versa) to keep Clipper's internal math consistent.

## 4. The Recursive Engine: `trace(currentPath, totalOffset)`

### Step 1: Calculate Next State
Generate `nextPaths = Clipper.offset(currentPath, -stepSize)`.

### Step 2: Branching Logic

#### Case A: Topology Maintained (The Taper)
*Criteria:* `nextPaths.length === 1` and the shape is functionally the same (no holes closed/opened).
* **Proximity Matching:** For every **Corner Vertex** (angle change > 15°) in `currentPath`, find the closest vertex in `nextPaths[0]`.
* **Emit Toolpath:** * Create 3D lines from `(current.x, current.y, currentZ)` to `(next.x, next.y, nextZ)`.
    * For smooth segments (non-corners), follow the horizontal loop of `nextPaths[0]` at the new $Z$ depth.
* **Recurse:** `trace(nextPaths[0], totalOffset + stepSize)`.

#### Case B: The "O" Rule (Dual-Wavefront)
*Criteria:* The shape contains an internal hole.
* **Logic:** Offset the outer boundary **inward** and the hole boundary **outward**.
* **Rule:** Do **not** attempt to connect vertices between the outer and inner loops. 
* **Termination:** When the gap between the inner and outer offset becomes $< stepSize$, treat it as a **Case D: Termination**.

#### Case C: Split Event (The Fork)
*Criteria:* `nextPaths.length > 1`.
* **The Bridge:** Before splitting, perform a **Resolution Trick** (Micro-Offset at $1/10$ stepSize) on `currentPath` to capture the "connective tissue" or "saddle point" where the split occurs. Emit this as a path at the current depth.
* **Branching:** Fork the recursion. Call `trace(subPolygon, totalOffset + stepSize)` for each new independent shape.

#### Case D: Termination / Collapse (The Final Ridge)
*Criteria:* `nextPaths.length === 0`.
* **Resolution Trick:** Perform a "Micro-Offset" ($1/10$ stepSize).
* **Result:** * If a micro-shape remains: Emit it as the final "spine" at the deepest $Z$.
    * If micro-shape is empty: Use the **Last Remembered Offset** as the toolpath. To avoid a flat bottom, connect remaining vertices to the **Centroid** (for round shapes) or a **Medial Line** (for long rectangles like the letter 'I').

## 5. Implementation Requirements for Agent
1. **Recursion Depth:** Implement a safety limit to prevent infinite loops on malformed geometry.
2. **Path Optimization:** After generation, merge any consecutive 3D segments that are nearly collinear ($< 0.1^\circ$ variance) to minimize G-code line count.
3. **Data Structure:** Output an array of 3D segments: `[{start: {x,y,z}, end: {x,y,z}}, ...]`.

