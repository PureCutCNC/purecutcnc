# Design Document: Recursive Skeletonized V-Carve Generator

## 1. Overview
This algorithm generates high-quality 3D V-carve toolpaths from 2D polygons. It uses a recursive "Poor Man's Straight Skeleton" approach to find the center "ridges" of a shape, connecting vertices vertically to create the sloping walls of a V-groove.

## 2. Core Geometry & Physics
* **V-Bit Math:** Vertical depth ($Z$) is calculated based on the horizontal offset distance ($d$) and the bit's included angle ($\theta$):
  $$Z = -\frac{d}{\tan(\theta/2)}$$
* **Coordinate Space:** $Z=0$ is the material surface. All toolpath $Z$ values are negative.
* **Tooling:** Designed for a V-shaped engraving bit.

## 3. Pre-Processing (The "Clean" Phase)
Before any offset is processed, the polygon must be sanitized to prevent "chatter" and spikes:
1. **Join Type:** Use `JoinType.jtRound` in Clipper to stabilize inner corners.
2. **Vertex Filtering:** Remove any vertex where $Dist(P_i, P_{i-1}) < 1$ Clipper unit (≈ 1/scale project units) to reduce offset noise.
3. **Winding:** Ensure all outer polygons are Clockwise and all holes are Counter-Clockwise (or vice-versa) to keep Clipper's internal math consistent.

## 4. The Recursive Engine: `traceRegion(region, totalOffset)`

### Step 1: Calculate Next State
Generate `nextRegions = buildInsetRegions(region, stepSize, jtRound)`.

### Step 2: Branching Logic

#### Case A: Topology Maintained — CONTINUE (1 → 1)
*Criteria:* `nextRegions.length === 1`.

**Corner detection:** Corners are detected from `region.outer` using a convexity filter:
- Compute signed area of the polygon (shoelace formula) to determine winding direction.
- At each vertex, compute the cross product of the two edge vectors.
- A corner is convex (and thus eligible for a skeleton arm) only when `cross * area > 0`. Concave / armpit corners are skipped — they produce false arms in shapes like F and T.
- Threshold: angle change > 15°.

**Skeleton arm emission:** For each active corner:
- Find the nearest vertex to `corner` in `currentContour` → `inCurrent`
- Find the nearest vertex to `corner` in `nextContour` → `inNext`
- Emit a 3D cut from `(inCurrent.x, inCurrent.y, currentZ)` to `(inNext.x, inNext.y, nextZ)`
- Carry `inNext` as the corner position for the next recursive level (chain tracking)

**Recurse:** `traceRegion(nextRegion, totalOffset + stepSize)` passing `inNext[]` as the new active corners.

#### Case B: Split Event — FORK (1 → N)
*Criteria:* `nextRegions.length > 1`.

- Emit `region.outer` as a horizontal bridge contour at `currentZ` (the pre-split junction).
- For each child region, **re-detect corners fresh** from `child.outer` using the convexity filter. This captures new pointed tips introduced by the split topology.
- Recurse independently into each child.

#### Case C: Collapse — TERMINATION (1 → 0)
*Criteria:* `nextRegions.length === 0`.

- Perform a **micro-inset** at `stepSize × 0.1` to capture the residual spine.
- If the micro-inset survives: emit each surviving contour at `microZ`.
- If nothing survives: emit `region.outer` at `currentZ` as the final spine approximation.

---

## 5. Corner Tracking Strategy (Chain Tracking)

The key to clean skeleton arms is that each arm segment must connect consecutive offset levels — not jump from the original shape to some deep level. This is achieved by **chain tracking**:

1. **Depth 0:** detect corners from the original contour. These are actual vertices of `region.outer`.
2. **Each CONTINUE step:** for each tracked corner position, find `inNext = nearest(corner, nextContour)`. Emit cut from `corner@currentZ` → `inNext@nextZ`. Pass `inNext[]` forward as the new corner positions for depth+1.
3. **Result:** each corner generates one short segment per level (~stepSize long), forming a connected path from the surface down to the collapse point. No long diagonal "destruction cuts".

**Why NOT to use original corner positions throughout:**
- At depth 0, original corners are vertices of the contour — safe.
- At depth N, the original positions drift away from the actual shape. `findClosestVertex(originalCorner, currentContour)` finds an increasingly wrong vertex, producing long cuts that shoot across the shape.

**Why NOT to chain from `inCurrent` → `inNext` (both re-snapped):**
- If the tracked corner is already a vertex of `currentContour` (guaranteed by chain tracking), re-snapping to `currentContour` is redundant and introduces instability near offset seams.
- Using the tracked corner directly as `inCurrent` is cleaner.

**Post-split:** corners are always re-detected fresh on each child — chain tracking resets at every split event.

---

## 6. Known Issues & Future Work

### Resolved
- ✅ Concentric rings on circles: removed fallback ring emission when no corners detected
- ✅ False corner cuts on circles: corners detected once from original shape, not from every offset level
- ✅ Armpit corners on F/T: convexity filter (cross × area sign check) skips concave corners
- ✅ Post-split corner detection: fresh detection from each child captures new pointed tips
- ✅ Long diagonal destruction cuts: chain tracking ensures cuts are always ~stepSize long

### Open
- **"e" horizontal bar at fine resolution:** the bar tip skeleton line may still be faint or missing at very fine step sizes. The bar collapses gradually; chain tracking should improve this since the bar-tip corner will be continuously tracked as it narrows. Needs validation after chain tracking is fully implemented.
- **Convergence produces duplicate cuts:** when two tracked corners both find the same nearest vertex in `nextContour`, identical cuts are emitted. This is harmless for carving quality (the tool passes the same point twice) and intentionally left without deduplication — dedup was found to cause cascade failures where one shape (e.g. 'k') loses all skeleton arms after a single level of convergence.
- **Rapids optimization:** currently all paths retract to safeZ between segments. A nearest-neighbor sort and intelligent linking of sequential segments would reduce air-cutting time significantly.
- **Collapse geometry quality:** the micro-inset spine is a rough approximation. For long thin shapes (e.g. stems of letters), the medial line (connecting midpoints of the collapsing bar) would give a more accurate spine.

---

## 7. Implementation Requirements
1. **Recursion Depth:** Safety limit of 200 levels to prevent infinite loops on malformed geometry.
2. **Path Optimization:** Consecutive collinear 3D segments could be merged (< 0.1° variance) to reduce G-code line count — deferred.
3. **Data Structure:** Internal representation is `Path3D = Array<{x,y,z}>`. Converted to `ToolpathMove[]` at the end.
