# MAT V-Carve — Cut Quality Review

Review of `src/engine/toolpaths/vcarveMat.ts` (prototype on `feat/vcarve-mat-spine`), focused on the **geometric correctness of the emitted spine**. Efficiency, retractions, and path ordering are intentionally out of scope. Items are ordered by how badly each one degrades the final cut; P0 are must-fix before the algorithm is trustworthy.

Line references are against the current `vcarveMat.ts`.

---

## P0 — Deepest point at pointed corners is lost

**Symptom:** On letters like `A`, `V`, or any sharp convex corner, the deepest Z of the V-carve is at the corner apex. The current scanner never samples there.

**Root cause:** Two compounding issues.
1. `scanContourSpinePath` uses **segment midpoints** as ray origins (`vcarveMat.ts:773`). Corner vertices themselves are never ray origins, and neither adjacent segment's midpoint-normal passes through the apex.
2. `contourStride` (`vcarveMat.ts:1285`, used at `vcarveMat.ts:764`) can be > 1, skipping segments outright — so even the approximation via midpoints gets thinned near tips where resolution matters most.

**Fix I would apply:**
- Detect high-curvature vertices (turn angle above ~30°) during boundary subdivision.
- At each such vertex emit an extra ray whose origin is the vertex itself and whose direction is the inward angle-bisector of the two incident segments.
- Force `stride = 1` within a short window around those vertices (both sides), so the midpoint rays straddling the corner are not skipped either.
- Add a unit test: single isoceles triangle, verify the deepest hit lies within `scanStep` of the apex.

## P0 — Binary search tolerance is too loose, and too few iterations

**Symptom:** Random hits dropped, and those that survive carry Z errors large enough to be visible in the preview.

**Root cause:**
- Tolerance `medialTolerance = scanStep * 0.75` at `vcarveMat.ts:760` accepts a radius error of up to ~`scanStep * 0.375`. For a 60° V-bit that translates to a Z error of `0.375 · scanStep / tan(30°) ≈ 0.65 · scanStep` — for `scanStep = 0.1 mm` that is **0.065 mm of Z error per hit**, which shows up as a rippled bottom.
- `BINARY_SEARCH_ITERATIONS = 6` (`vcarveMat.ts:33`) means the bracket shrinks to `exitDistance / 64`. On a wide channel that never reaches the tolerance band → `foundDistance` stays `null` and the ray is silently discarded (`vcarveMat.ts:846–848`).

**Fix I would apply:**
- Drop tolerance to `scanStep * 0.05` (roughly 1/20th of the step — small enough that Z wobble is invisible).
- Raise iteration cap to ~24 and add a **fallback accept**: if iterations run out, accept the last bracket midpoint instead of dropping the hit. Flag it in the detection stats so we can see how often it happens.
- Optional: replace the last few iterations with a Newton step on `d_other − d_source` once the bracket is tight — converges quadratically and typically saves half the iterations.

## P0 — Junctions are never reconstructed

**Symptom:** At every T- or Y-junction (crossbar of `T`, center of `+`, fork of `Y`) the emitted spine is a set of disconnected fragments. Where arms meet, the tool leaves a small uncut island of material because each fragment enters independently and none of them actually touches the junction point.

**Root cause:** `connectRegionSpinePaths` (`vcarveMat.ts:1018`) despite the name does not *connect* anything. It only dedupes and simplifies. The scan itself produces independent per-contour paths, and there is no graph step that identifies a shared medial vertex.

**Fix I would apply:**
- After all rays are refined, snap every spine hit to a grid of size `scanStep` and build a cluster map: each cluster is a junction candidate.
- Build an undirected graph: nodes = clusters, edges = contiguous sub-sequences of the original per-contour paths between two clusters.
- Emit paths by walking the graph. Edges terminate *exactly* at the shared cluster centroid, so a junction is physically a single XY point hit from every incident arm.
- The cluster centroid's Z should be the **deepest** (most-negative Z) of its member hits — junctions are where multiple walls converge, so `R_min` is smallest, and the two estimates should agree; take min of their depths to be safe.

## P0 — Branch loss from endpoint-only equivalence

**Symptom:** Legitimate distinct arms get silently dropped or blended.

**Root cause:**
- `arePathsEquivalent` (`vcarveMat.ts:1005`) checks only endpoint proximity. Two genuinely different arms that happen to share endpoints (common inside closed glyphs like `O`, `B`, `D`) are declared equivalent and one is discarded.
- `tryMergeParallelPaths` (`vcarveMat.ts:946`) aligns by sample index and averages X/Y/Z. When two paths run nearly parallel but represent different arms (e.g. the two verticals of `H`), this merges them into a ghost spine down the middle.

**Fix I would apply:**
- Replace endpoint equivalence with **discrete Fréchet or mid-sample distance**: sample both paths at matched arc-length parameter and require the max deviation to be below `scanStep * 0.5`. Endpoint match is necessary but nowhere near sufficient.
- For merging twin paths (same arm scanned from both walls), do not average Z. Both walls report the same `R_min`, so take the **minimum Z** (deepest) at the matched XY and carry it — averaging can only hurt if one wall under-refined.
- Add a "don't merge" guard: if the two paths' tangent vectors at a matched sample disagree by more than 30°, they are not the same arm, regardless of XY proximity.

---

## P1 — Radius at the refined point is measured against all walls, including source

**Symptom:** Slightly shallow Z at hits where the binary search converged imperfectly. Visually this looks like the carve not quite reaching the apex line.

**Root cause:** After `refineMedialPoint` returns, `nearestBoundaryPoint` (`vcarveMat.ts:849`) finds the globally-closest boundary sample *including* samples on the source wall. If the refined point ended up biased toward its source by a fraction of a step, the reported `radius` is source-dominated and too small → Z is too shallow.

**Fix I would apply:**
- Mirror what `classifyRayPoint` already does: find the nearest non-same-wall sample and the exact distance to the source segment, then take `radius = min(sameWallDistance, otherWallDistance)`.
- `min` is the right reduction here because the tool must clear **both** walls.

## P1 — Ray direction is segment-local, not contour-local

**Symptom:** On curved or polygonal boundaries, rays from adjacent segments point in noticeably different directions, producing a fan instead of a consistent sweep. Near concave bends the midpoint-normal can miss the interior entirely and `inwardNormalForSegment` returns `null` (`vcarveMat.ts:551`), silently dropping the ray.

**Fix I would apply:**
- Compute a **vertex normal** per sampled boundary point (bisector of the two adjacent segment normals). For the ray fired between `points[i]` and `points[i+1]`, use the average of their vertex normals — this blends the two neighbors' inward directions instead of forcing a single segment's perpendicular.
- Keep the current midpoint-normal as a fallback only for contours with very long straight edges, where the bisector and segment normal coincide anyway.

## P1 — MIN_PATH_POINTS = 3 drops short but legitimate arms

**Symptom:** Serifs, short tabs, and the short arms of letters like `i` (the dot), `j`, `K` may lose their spine.

**Root cause:** `connectRegionSpinePaths` filters by path point count (`vcarveMat.ts:1027`). A 2-point path has a valid spine segment too.

**Fix I would apply:**
- Filter by **geometric XY length**: keep any path whose arc-length is at least `max(2 * scanStep, tool.diameter * 0.25)`.
- Allow 2-point paths through; they cost nothing to emit.

## P1 — Z-wobble from quantized nearest-boundary flips

**Symptom:** Along an emitted spine the Z value oscillates by small amounts as the "closest other wall" jumps between adjacent boundary samples on the opposite side. The preview shows a sawtooth floor.

**Root cause:** The radius at each hit is the distance to *one* boundary sample. Two hits a step apart can pick different samples on the opposite wall and see a small step in R even though the true medial radius varies smoothly.

**Fix I would apply:**
- After a path is collected, enforce the physical constraint `|dZ / dXY| ≤ slope` between consecutive samples (the MAT radius cannot change faster than the V-bit slope permits). Any segment that violates this is a measurement artifact on the **shallower** end; raise that end's Z to match the constraint.
- This is a one-pass forward-then-backward sweep over each path and is O(n).

---

## P2 — Simplify keeps original Z, then linearly interpolates between survivors

**Symptom:** On paths where R varies rapidly, the simplification can cut a "peak" vertex that carried the correct deep Z, and the straight line between its neighbors sits shallower than the true spine.

**Root cause:** `simplifyPath` (`vcarveMat.ts:907`) is a 2-D Douglas–Peucker (uses `distanceToSegment` in XY only). The dropped vertex's Z is discarded along with its XY.

**Fix I would apply:**
- Either simplify in **3-D** (measure perpendicular distance in XYZ with a uniform unit — scale Z against project units first), or
- Pre-pass: before simplification, for every triple `(a, b, c)` of consecutive samples, if `b.z < lerp(a.z, c.z, t)` by more than a small tolerance, **mark `b` as unsimplifiable** so Douglas–Peucker keeps all local Z minima.
- A simple implementation of the second option: split the input into sub-paths at every local Z minimum, simplify each sub-path independently, then concatenate.

## P2 — Concave corner bisector arms are absent

**Symptom:** At inward-pointing corners (the armpit of an `L` cut as a pocket, the inside of a right angle), the true medial has a short arm running from the corner along the bisector. The current scan can miss this because both incident segments' midpoint-normals point away from the corner apex, not toward it.

**Fix I would apply:**
- Treat concave vertices symmetrically to the P0 convex-corner fix: detect them by sign of cross-product relative to the contour's winding, then emit an extra vertex-origin ray directed along the inward bisector.
- These rays will often terminate at a shared junction with convex-corner rays from across the pocket — which is exactly what the junction reconstruction in P0 needs to absorb.

## P2 — Boundary subdivision is non-uniform

**Symptom:** Arc-length between adjacent boundary samples varies segment-to-segment because `steps = ceil(length / resolution)` (`vcarveMat.ts:213`). Short segments get proportionally denser sampling. In cases where the scanner walks by `contourStride`, the effective ray density depends on the local segment mix, not on a predictable spatial step.

**Fix I would apply:**
- Replace per-segment subdivision with **global arc-length sampling**: compute total contour length, lay samples at a fixed arc-length interval, and derive XY by walking the segments.
- Ensures every ray represents the same length of wall, which keeps the refinement tolerance meaningful.

## P2 — Wide regions produce a clamped-depth "spine" that leaves wall material uncut

**Symptom:** In pockets where the local radius exceeds `maxCarveDepth * slope`, the computed Z is clamped (`vcarveMat.ts:855`). The tool runs along the spine at the clamped depth, but because it cannot reach the walls at that depth the material between the V flank and the wall is left standing — there is no pocketing pass to remove it.

**This is a scope decision, not a bug,** but it produces visibly bad cuts if left unadvertised.

**Fix I would apply:**
- When a region's inradius exceeds the maximum carvable radius, add a warning naming the region and suggest pairing the MAT op with a pocket op for the floor.
- Optionally, trim the spine to the locus where R ≤ maxCarveDepth · slope so no moves are emitted at the clamped depth at all — a pocket op can own everything inside that locus.

---

## P3 — Minor hygiene items that slightly affect quality

- `inwardNormalForSegment` returns `null` when both sides of the probe test report "inside" — which happens on thin slivers. Those rays get dropped. Fall back to the winding-direction normal when the PIP test is ambiguous.
- `raySegmentIntersectionDistance` epsilons (`vcarveMat.ts:583`) are hard-coded in project units. On mm projects this is fine; on inch projects `1e-6` inches ≈ `2.5e-5 mm`, which is tighter than needed and can occasionally reject a legitimate exit on nearly-tangent segments. Scale epsilons by project units.
- `collapseDuplicatePoints` uses the same `tolerance` for XY and Z (`vcarveMat.ts:881`). For V-carve, a hit that moved only in Z by less than tolerance but in XY by a meaningful amount is still a new hit. Split the two thresholds.
- Debug markers retract-plunge per marker (`vcarveMat.ts:1107–1216`). Cosmetic in debug mode, but they interleave into the real toolpath when `debugOverlay` is on, which makes visual verification of the *actual* spine harder. Emit debug markers into a separate `debugMoves` array rather than the main `moves`.

---

## Suggested order of attack

1. **P0 corner tips** and **P0 binary-search tolerance** — both are one-afternoon fixes and each one alone produces a visibly better cut.
2. **P0 branch-loss equivalence** — prerequisite for trusting the merge/dedup stage. Without this, fixes higher up can be masked by later drops.
3. **P0 junction reconstruction** — the biggest geometric change, but also the single thing that makes MAT V-carving look professional. Worth doing after the above so you are building on a reliable hit stream.
4. **P1 items** in any order; each one is local and independent.
5. **P2 items** as polish. Z-wobble smoothing (P1) should land before the simplify fix (P2) so simplify has a stable input.

## Test shapes I would add to the debug harness

- Isoceles triangle (convex tip verification).
- Plus sign `+` (orthogonal 4-way junction).
- Letter `Y` (3-way junction at an off-angle).
- Letter `B` with both loops (branch loss; enclosed voids).
- A thin S-curve (Z-wobble visibility along a long smoothly-varying spine).
- Any oversized rectangle wider than `2 · maxCarveDepth · slope` (clamped-depth warning).

Each of these isolates one failure mode from above and should be checked after every P0/P1 change.
