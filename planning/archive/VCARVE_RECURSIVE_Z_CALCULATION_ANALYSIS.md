# V-Carve Recursive: Z-Level Calculation Analysis

**File:** [`src/engine/toolpaths/vcarveRecursive.ts`](src/engine/toolpaths/vcarveRecursive.ts)
**Date:** 2026-04-29

---

## Overview

The generated XY toolpath is good. The Z-levels, however, exhibit stair-stepping instead of smooth 3D ramps from corner to corner. This document catalogues **every location** in [`vcarveRecursive.ts`](src/engine/toolpaths/vcarveRecursive.ts) where Z is computed, assigned, or propagated, with an explanation of the algorithm used.

---

## 1. Foundational Z Formula

**Location:** [`generateVCarveRecursiveToolpathSingle`](src/engine/toolpaths/vcarveRecursive.ts:2634)

### 1.1 Slope from tool geometry
```typescript
const halfAngleRadians = (tool.vBitAngle * Math.PI) / 360
const slope = Math.tan(halfAngleRadians)
```
- **What:** The V-carve depth-to-offset ratio derived from the V-bit's included angle.
- **How:** Half-angle = full angle / 2. `slope = tan(halfAngle)`.
- **Meaning:** For every 1 unit of XY distance from the outer wall, the cutter descends `slope` units in Z. A 90° V-bit has slope ≈ 1.0 (1:1 depth/inward ratio). A 60° bit has slope ≈ 0.577.

### 1.2 The primary Z-depth formula
Used throughout the code, the fundamental relation is:

```typescript
Z = topZ - Math.min(maxDepth, totalOffset / slope)
```

- **`topZ`** — material surface Z (typically 0).
- **`totalOffset`** — cumulative inset distance from the outermost contour.
- **`slope`** — from 1.1 above.
- **`maxDepth`** — the operation's maximum carve depth cap.

This maps: at the outer wall (totalOffset = 0) → Z = topZ (surface). As you move inward by `totalOffset`, depth increases proportionally: `depth = totalOffset / slope`.

---

## 2. Where Z Is Calculated — All Locations

### 2.1 `traceRegion` — Main recursive entry

**Formula applied at each recursion level:**
```typescript
// line 2182
const currentZ = topZ - Math.min(maxDepth, totalOffset / slope)

// line 2184
const nextZ = topZ - Math.min(maxDepth, nextOffset / slope)
```
- **`currentZ`** — Z for the current contour ring (at `totalOffset` distance from outer edge).
- **`nextZ`** — Z for the next contour ring (at `totalOffset + stepSize`).
- **Algorithm:** Pure parametric: Z follows `totalOffset / slope`. The `stepArms` function then creates diagonal 2-point segments from `currentZ` → `nextZ`, which **should** produce a smooth linear ramp — **UNLESS** the arm chain is broken and a fresh seed or rescue path introduces a different Z.

### 2.2 `stepArms` — Arm stepping (1→1 CONTINUE)

**Locations:**
- [`stepArms`](src/engine/toolpaths/vcarveRecursive.ts:990-1128)

#### 2.2.1 Main arm cut (line 1125-1128)
```typescript
const armZ = arm.z ?? currentZ    // line 991
const mainCut: Path3D = [
  { x: arm.point.x, y: arm.point.y, z: armZ },
  { x: target.point.x, y: target.point.y, z: nextZ },
]
```
- **Algorithm:** Simple linear segment from the arm's current Z to the inscribed ring's Z at the next level.
- **What `arm.z` is:** The TrackedArm's `z` field ([`TrackedArm`](src/engine/toolpaths/vcarveRecursive.ts:524-528)) is set when the arm was created during rescue path construction, carrying forward the last midpoint Z from the rescue walk. If undefined, falls back to `currentZ`.

#### 2.2.2 Rescue path (line 995-1008)
```typescript
const rescue = buildCenterlineRescuePath(
  currentLogicContour, candidateCorners, arm, currentZ, nextZ,
  stepSize, slope, minZ, topZ
)
```
- Delegates to **buildCenterlineRescuePath** (see §2.5).
- The rescue path has multi-point Z calculated from `minDistToContourWalls`.

#### 2.2.3 Direct-connect fallback (line 1029-1032)
```typescript
const cut: Path3D = [
  { x: arm.point.x, y: arm.point.y, z: armZ },
  { x: directTarget.point.x, y: directTarget.point.y, z: nextZ },
]
```
- **Algorithm:** Simple 2-point segment `armZ → nextZ`.

#### 2.2.4 Wall-anchor fallback (line 1058-1061)
```typescript
const cut: Path3D = [
  { x: arm.point.x, y: arm.point.y, z: armZ },
  { x: wallAnchor.x, y: wallAnchor.y, z: nextZ },
]
```
- **Algorithm:** Same simple 2-point segment `armZ → nextZ`.

#### 2.2.5 Tiny-remnant fallback (line 1081-1084)
```typescript
const cut: Path3D = [
  { x: arm.point.x, y: arm.point.y, z: armZ },
  { x: nearestTinyCorner.target.x, y: nearestTinyCorner.target.y, z: nextZ },
]
```
- **Algorithm:** Same simple 2-point segment `armZ → nextZ`.

### 2.3 `bridgeSplitArms` — Split bridging (1→N SPLIT)

**Location:** [`bridgeSplitArms`](src/engine/toolpaths/vcarveRecursive.ts:1236-1317)

#### 2.3.1 Direct connect (line 1255-1258)
```typescript
const armZ = arm.z ?? currentZ    // line 1237
const cut: Path3D = [
  { x: arm.point.x, y: arm.point.y, z: armZ },
  { x: direct.point.x, y: direct.point.y, z: nextZ },
]
```
- **Algorithm:** Simple 2-point segment `armZ → nextZ`, identical to stepArms.

#### 2.3.2 Rescue path (line 1295-1299)
Delegates to **buildCenterlineRescuePath** (see §2.5), with `SPLIT_BRIDGE_MAX_RESCUE_STEPS = 8` cap.

#### 2.3.3 Desperation rescue (line 1339-1343)
Same as rescue but with an extended step cap (24 steps).

### 2.4 `buildFreshSeedBootstrapCuts` — Fresh-seed bootstrap

**Location:** [`buildFreshSeedBootstrapCuts`](src/engine/toolpaths/vcarveRecursive.ts:1858-1948)

#### 2.4.1 Direct connect (line 1882-1885)
```typescript
const cut: Path3D = [
  { x: sourceArm.point.x, y: sourceArm.point.y, z: sourceArm.z ?? currentZ },
  { x: freshSeedArm.point.x, y: freshSeedArm.point.y, z: nextZ },
]
```
- **Algorithm:** Simple 2-point segment from source arm's Z (tracked or fallback) to the fresh seed corner's `nextZ`.

#### 2.4.2 Rescue fallback (line 1903-1914)
Delegates to **buildCenterlineRescuePath** (see §2.5).

#### 2.4.3 Wall-anchor fallback (line 1943-1946)
```typescript
const cut: Path3D = [
  { x: wallAnchor.x, y: wallAnchor.y, z: currentZ },
  { x: freshSeedArm.point.x, y: freshSeedArm.point.y, z: nextZ },
]
```
- **Algorithm:** `currentZ → nextZ` — the wall anchor sits on the current contour, the fresh seed on the next.

### 2.5 `buildCenterlineRescuePath` — Medial-axis rescue walk

**Location:** [`buildCenterlineRescuePath`](src/engine/toolpaths/vcarveRecursive.ts:1692-1819)

This is the **most complex Z calculation** in the file. It walks along the medial axis (centerline) of the current contour and computes Z at each midpoint based on true distance to the nearest wall.

#### 2.5.1 Start point Z (line 1692)
```typescript
const startZ = arm.z ?? currentZ
```
- Carries forward the arm's tracked Z, or falls back.

#### 2.5.2 Midpoint Z computation (line 1779-1785)
```typescript
const distToWall = minDistToContourWalls(channel.point, [currentContour])
const targetMidpointZ = topZ - distToWall / slope
const midpointZ = Math.max(minZ, Math.min(lastZ, targetMidpointZ))
```
- **Key insight:** The Z at each medial-axis waypoint is computed from **`minDistToContourWalls`** — the shortest distance from the channel midpoint to any wall of the current contour. This is the inscribed circle radius at that XY point.
- **Clamping:** `midpointZ = max(minZ, min(lastZ, targetMidpointZ))` — Z only goes deeper (more negative) as you walk inward; it never rises. This monotonic clamp was added to prevent Z-bounce.

#### 2.5.3 Snap-to-corner Z (line 1796)
```typescript
path.push({ x: nearestReachableCorner.point.x, y: nearestReachableCorner.point.y, z: nextZ })
```
- Final point is at `nextZ` (the next contour ring's Z), regardless of what the midpoint Z was.

#### 2.5.4 Salvage Z (line 1763)
```typescript
path.push({ x: salvage.point.x, y: salvage.point.y, z: nextZ })
```
- If the walk bails but accumulated at least 2 points, snap to `nextZ`.

### 2.6 `bridgeSiblingChildren` — Sibling/same-child bridge walk

**Location:** [`bridgeSiblingChildren`](src/engine/toolpaths/vcarveRecursive.ts:1441-1514)

#### 2.6.1 Start point (line 1441)
```typescript
const path: Point3D[] = [{ x: startCorner.x, y: startCorner.y, z: nextZ }]
```
- Starts at `nextZ` (the child contour's ring Z).

#### 2.6.2 Midpoint Z (line 1468-1470)
```typescript
const distToWall = minDistToContourWalls(channel.point, allParentContours)
const targetZ = topZ - distToWall / slope
const pointZ = Math.max(minZ, Math.min(lastZ, targetZ))
```
- **Same formula** as rescue midpoint Z, but `distToWall` is measured against **all parent contours** (outer + islands), not just the current contour. The comment at line 1465-1467 explicitly notes:
  > "Using channel.radius (perpendicular half-width) and currentZ (edge Z) both produce wrong results for wide shapes like the legs of letter A."
- **Monotonic clamp:** `min(lastZ, targetZ)` ensures Z only drops.

#### 2.6.3 Snap-to-corner Z (line 1492)
```typescript
path.push({ x: snapTarget.point.x, y: snapTarget.point.y, z: nextZ })
```
- Returns to `nextZ` at the target corner.

#### 2.6.4 `lastZ` tracking (line 1514)
```typescript
lastZ = pointZ
```
- Tracks monotonic descent.

### 2.7 `emitCollapseGeometry` — Collapse handler

**Location:** [`emitCollapseGeometry`](src/engine/toolpaths/vcarveRecursive.ts:2051-2151)

#### 2.7.1 currentZ and microZ (lines 2052-2054)
```typescript
const currentZ = topZ - Math.min(maxDepth, totalOffset / slope)
const microZ = topZ - Math.min(maxDepth, (totalOffset + microStep) / slope)
```
- **`currentZ`** — same formula, at current totalOffset.
- **`microZ`** — at `totalOffset + microStep` where `microStep = stepSize * 0.1`.

#### 2.7.2 1→1 micro stepArms (line 2069)
```typescript
stepArms(activeArms, region.outer, contour, currentZ, microZ, stepSize, slope, ...)
```
- Uses standard `stepArms` (see §2.2) with `currentZ → microZ`.

#### 2.7.3 1→N micro split (lines 2098-2117)
```typescript
bridgeSplitArms(parentSplitArms, region.outer, microRegions, currentZ, microZ, ...)
bridgeSiblingChildren(region.outer, region.islands, microRegions, currentZ, microZ, ...)
```
- Uses standard split bridging with `currentZ → microZ`.

#### 2.7.4 Micro contour as flat path (line 2087, 2128, 2138)
```typescript
const rotated = contourToPath3D(rotateContour(contour, contourStartIdx), microZ)
```
- Contours are emitted as **flat horizontal paths** at `microZ` — all points at the same Z.

#### 2.7.5 No-micro fallback (line 2146)
```typescript
const cp = contourToPath3D(region.outer, currentZ)
```
- Fallback flat contour at `currentZ`.

### 2.8 `buildInteriorCornerBridge` — Interior corner bridge

**Location:** [`buildInteriorCornerBridge`](src/engine/toolpaths/vcarveRecursive.ts:2024-2027)

```typescript
const intCut: Path3D = [
  { x: start.x, y: start.y, z },
  { x: end.x, y: end.y, z },
]
```
- **Algorithm:** **Flat horizontal cut** at a single Z — no slope. Both endpoints get the same Z value passed in from the caller (`nextZ` at line 2325 in the CONTINUE case).

### 2.9 `contourToPath3D` — Contour emission helper

**Location:** [`contourToPath3D`](src/engine/toolpaths/vcarveRecursive.ts:110-115)

```typescript
function contourToPath3D(contour: Point[], z: number): Path3D {
  const pts: Point3D[] = contour.map((p) => ({ x: p.x, y: p.y, z }))
  pts.push({ ...pts[0] })
  return pts
}
```
- **Algorithm:** All contour vertices get the **same Z**. The contour is closed (last point = first point).
- Used for: collapse contours, micro contours, and (indirectly) all flat-path emissions.

### 2.10 `stepCorners` — External corner stepping

**Location:** [`stepCorners`](src/engine/toolpaths/vcarveRecursive.ts:1149)

```typescript
const slope = Math.abs(currentZ - nextZ) > 1e-9
  ? stepSize / Math.abs(currentZ - nextZ)
  : Number.POSITIVE_INFINITY
```
- **Algorithm:** The slope is **backed out** from the passed-in `currentZ` and `nextZ` values, rather than computed from tool geometry. This is an alternative slope derivation used by external callers.
- The derived slope is then passed into `stepArms` at line 1150.

### 2.11 `trackedArm.z` propagation

**Locations:**
- [`createTrackedArm`](src/engine/toolpaths/vcarveRecursive.ts:808-819) — sets `z` on the arm.
- [`mergeTrackedArms`](src/engine/toolpaths/vcarveRecursive.ts:829-830):
  ```typescript
  existing.z = existing.z === undefined ? arm.z : Math.min(existing.z, arm.z)
  ```
  When merging duplicate arms, keeps the **shallower** (less negative) Z.
- [`splitSourceArms`](src/engine/toolpaths/vcarveRecursive.ts:883) — carries forward `arm.z ?? z`.

### 2.12 Band depth clamping

**Location:** [`generateVCarveRecursiveToolpathSingle`](src/engine/toolpaths/vcarveRecursive.ts:2656)

```typescript
const maxBandDepth = Math.max(0, Math.min(operation.maxCarveDepth, band.topZ - band.bottomZ))
```
- Clamps each band's max depth to the band's thickness.

---

## 3. Summary: The Two Competing Z Models

There are **two fundamentally different Z computations** in this file:

| Model | Formula | Where Used |
|-------|---------|------------|
| **Parametric depth** | `Z = topZ - totalOffset / slope` | `traceRegion` (§2.1), `emitCollapseGeometry` (§2.7), all simple 2-point cuts |
| **Inscribed-circle depth** | `Z = topZ - minDistToContourWalls(point, contours) / slope` | `buildCenterlineRescuePath` midpoint Z (§2.5), `bridgeSiblingChildren` midpoint Z (§2.6) |

### The Problem

The **parametric model** (model 1) assigns Z based purely on how many `stepSize` increments you've taken from the outer edge. This produces a smooth ramp from corner to corner *when the arm chain remains intact and every stepArms call succeeds*. In a perfect 1→1 CONTINUE chain, each 2-point arm segment goes from `currentZ` to `nextZ`, creating a smooth linear descent.

However, when the chain breaks (arm rejected → fresh seed bootstrap → rescue path → wall anchor), the Z computations mix models:

1. A rescue path may compute midpoint Zs based on `minDistToContourWalls` (model 2), which can differ from the parametric Z at the same XY position.
2. The rescue path's final point snaps to `nextZ` (model 1), creating a Z discontinuity at the snap.
3. A fresh seed bootstrap's direct connect goes from `sourceArm.z` (possibly from a rescue path, model 2) to `nextZ` (model 1).
4. The monotonic clamp `Math.min(lastZ, targetMidpointZ)` in rescue/sibling walks prevents Z from rising, but can create Z **plateaus** — flat segments where the inscribed circle radius hasn't decreased enough to justify a deeper cut.
5. Wall-anchor fallbacks connect `currentZ → nextZ` (model 1) but the anchor point is on the *current* contour's wall, not the *next* contour's corner — the arm tracking then carries this wall-anchor Z forward, breaking the chain.

### Z-Step Root Causes

The stair-stepping likely comes from:

1. **Arm rejection** → fresh seed bootstrap → the fresh seed starts at `nextZ` (parametric model 1), but the source arm may be at a different Z (from rescue model 2), creating a Z jump at the handoff.
2. **Rescue path midpoint Z ≠ parametric Z** at the same XY — the inscribed-circle model produces a different depth than the offset-count model.
3. **The contour emissions are flat** — collapse contours, micro contours, and interior corner bridges are all at a fixed Z, creating horizontal ledges.
4. **`Math.min(lastZ, targetMidpointZ)` clamp** — if the inscribed circle radius doesn't shrink between two successive midpoint steps, Z stays flat, creating plateaus.

---

## 4. Recommended Changes

The following recommendations are ordered by expected impact, from highest to lowest. Each item is scoped as an independent task suitable for implementation tracking.

### R1. Unify the two Z models — replace `nextZ` snap with interpolated Z in rescue paths

**Files:** [`buildCenterlineRescuePath`](src/engine/toolpaths/vcarveRecursive.ts:1796), [`bridgeSiblingChildren`](src/engine/toolpaths/vcarveRecursive.ts:1492)

**Problem:** At the end of a rescue/sibling walk, the final point snaps to `nextZ` (parametric model 1) regardless of what the last midpoint Z was (inscribed-circle model 2). This creates a Z jump where the path suddenly changes depth.

**Fix:** When snapping to the target corner at the end of the walk, interpolate the final Z between `lastZ` (last midpoint Z from model 2) and `nextZ` (parametric model 1) based on how far the snap point is from the last midpoint, relative to the remaining step. Alternatively, compute the snap Z using the same inscribed-circle formula: `topZ - minDistToContourWalls(snapPoint, contours) / slope`, clamped to `[lastZ, nextZ]`.

```typescript
// Current (line 1796):
path.push({ x: nearestReachableCorner.point.x, y: nearestReachableCorner.point.y, z: nextZ })

// Proposed: interpolate or recompute from inscribed-circle
const snapDistToWall = minDistToContourWalls(nearestReachableCorner.point, [currentContour])
const snapZ = topZ - snapDistToWall / slope
const finalZ = Math.max(minZ, Math.max(nextZ, Math.min(lastZ, snapZ)))
path.push({ x: nearestReachableCorner.point.x, y: nearestReachableCorner.point.y, z: finalZ })
```

#### Testing R1

After making the R1 changes to [`vcarveRecursive.ts`](src/engine/toolpaths/vcarveRecursive.ts), run the following tests to verify correctness.

##### 1. TypeScript build
```bash
npm run build
# or
npx tsc --noEmit
```
**Expect:** Zero compilation errors. The R1 changes only add local variables and replace `z:` literals — no new imports or type changes.

##### 2. Quick regression — move count stability
```bash
npx tsx scripts/quick-verify.ts
```
**Expect:** All 6 operations (C, A, T, e, o, circle) report the same cut/rapid counts as before the fix. The R1 changes only affect Z values of snap/salvage points, not XY geometry, so move counts must not change. Example output (counts will vary by codebase version):
```
  C (op0006): 286 cuts, 87 rapids, 373 total
  A (op0008): 765 cuts, 144 rapids, 909 total
  T (op0009): 396 cuts, 130 rapids, 526 total
  e (op0012): 304 cuts, 93 rapids, 397 total
  o (op0046): 195 cuts, 88 rapids, 283 total
  circle (op0047): 64 cuts, 20 rapids, 84 total
```

##### 3. Segment continuity — debug letter A
```bash
npx tsx scripts/debug-letter-a.ts
```
**Expect:** The segment grouping output shows smooth Z transitions. Key indicators:
- **Fewer flat runs** — the inscribed-circle snap Z prevents the rescue/sibling walk from snapping to a fixed `nextZ` that differs from the last midpoint Z. Previously, the snap point would create an isolated flat segment at `nextZ` followed by a jump; now the snap Z bridges smoothly.
- **Consistent `zRange` spans** — adjacent segments that were separated by a Z gap should now have overlapping or contiguous Z ranges.
- Look for segments tagged with direction `DN` (descending) or `MIXED` that flow naturally into each other, rather than abrupt `flat` → `DN` transitions at snap boundaries.

Example output to look for (before vs after):
```
# BEFORE R1 (snap at nextZ creates a gap):
[ 45- 52] flat       z=[-0.5300,-0.5300] span=0.0000 xy=1.2345 dir=--
[ 53- 53] flat       z=[-0.6500,-0.6500] span=0.0000 xy=0.0100 dir=--    ← isolated snap at nextZ
[ 54- 78] descending z=[-0.6510,-0.8900] span=0.2390 xy=4.5678 dir=DN

# AFTER R1 (snap uses inscribed-circle Z, continuous with walk):
[ 45- 52] descending z=[-0.5300,-0.6100] span=0.0800 xy=1.2345 dir=DN
[ 53- 78] descending z=[-0.6100,-0.8900] span=0.2800 xy=4.5778 dir=DN    ← single continuous ramp
```

##### 4. Flat-run analysis — analyze-stepped-z
```bash
npx tsx scripts/analyze-stepped-z.ts
```
**Expect:** Reduced number of flat runs (sequences of ≥3 moves with Z change < 0.001). The tool reports:
```
--- Flat Z runs followed by Z jump ---
```
Fewer entries in this section means the R1 fix successfully eliminated Z jumps at snap/salvage points. Ideally only genuine flat segments (e.g. the outermost contour at topZ) remain.

##### 5. Visual inspection in the 3D viewport

Open the application, load `v-carve-skeleton-tests.camj`, and inspect a v-carve recursive operation in the **3D Preview** tab.

**How to navigate the viewport:**
- **Orbit (rotate):** Click and drag anywhere on the 3D view
- **Pan:** Right-click and drag
- **Zoom:** Scroll wheel
- **View presets:** Use the view-preset buttons (iso, top, front, right, etc.) in the viewport toolbar to snap the camera to standard angles

**What to look for:**

The 3D viewport renders toolpaths as colored lines. Cut moves are shown in **red/orange** (`#ff735c`). The vertical axis in the viewport is Z (depth) — `toolpathPointToWorld` maps `{x, y, z}` → `THREE.Vector3(x, z, y)`, so Z becomes the world Y axis.

**Step-by-step visual check:**

1. **Select a v-carve recursive operation** — e.g. the letter "A" (`op0008`), "e" (`op0012`), or "o" (`op0046`) — by clicking it in the operations list. This highlights its toolpath in the viewport.

2. **Switch to Front or Side view** — click the **Front** preset button (or press the keyboard shortcut if available). From this angle, the toolpath is seen in profile: X is horizontal, Z is vertical. The red cut lines should form a **single continuous ramp** from the outer contour (shallow/top) inward to deeper cuts.

3. **Look for stair-step ledges** — before R1, the toolpath had horizontal "flat" segments at fixed Z levels, connected by sudden vertical drops. This is the stepped-Z pattern: the red line would run horizontally for several moves, then jump vertically, then run horizontally again. After R1, these horizontal ledges at snap/salvage points should be gone — the line should angle smoothly downward without abrupt vertical jumps.

4. **Toggle the "Debug Toolpath" checkbox** — in the operation's properties panel (CAMPanel), enable **Debug Toolpath**. This adds colored shape markers on the **2D Sketch canvas view** (not the 3D viewport), coloring each move by its source function. See [`DEBUG_MARKER_LEGEND.md`](planning/DEBUG_MARKER_LEGEND.md) for the marker shape/color legend. Look for:
   - **Cyan triangles (▼)** — `sameChildBridge` (the [`bridgeSiblingChildren`](src/engine/toolpaths/vcarveRecursive.ts:1492) snap point, modified by R1)
   - **Yellow diamonds (◆)** — `siblingBridge` (other bridge paths)
   - **White dots (•)** — `rescue` paths (the [`buildCenterlineRescuePath`](src/engine/toolpaths/vcarveRecursive.ts:1774, 1814) snap/salvage points, modified by R1)
   
   Before R1, you could see these markers at locations where the toolpath had a Z jump (a marker in the middle of a flat run, then a gap). After R1, the Z values at these markers should match the surrounding walk Zs, so the markers should blend into continuous sloping segments rather than sitting at isolated flat-Z islands.

5. **Compare with the "front" view** — switch to the **Front** view preset. Look at the Z profile of the toolpath lines:
   - **Before R1:** You'd see distinct horizontal shelves at the Z-level of each offset step, connected by vertical drops. The red line would look like a staircase.
   - **After R1:** The red line should form a smoother diagonal slope, especially in areas where rescue paths and sibling bridges connect offset levels. The stair-step ledges at connection points should be gone.

6. **Zoom in on problem areas** — the letter "e" (`op0012`) has particularly noticeable stepped-Z issues. Or to a small region of the toolpath, zoom in, and use orbit to rotate to a side angle where you can clearly see the Z profile of individual segments.

##### 6. Targeted DIAG trace (if a tracer is active)
If using a rescue tracer (e.g. [`trace-vcarve-rescue.ts`](scripts/trace-vcarve-rescue.ts)), inspect the `rescue:snap` and `rescue:salvage` events. The Z value at snap should now be computed from `minDistToContourWalls(snapPoint, contour)` instead of being hard-coded to `nextZ`. Compare the tracer output before and after the fix — the `z` field on snap events should be closer to the last midpoint Z than to `nextZ`.

---

### R2. Remove or loosen the monotonic Z clamp in rescue/sibling walks

**Files:** [`buildCenterlineRescuePath`](src/engine/toolpaths/vcarveRecursive.ts:1781), [`bridgeSiblingChildren`](src/engine/toolpaths/vcarveRecursive.ts:1470)

**Problem:** `Math.max(minZ, Math.min(lastZ, targetMidpointZ))` prevents Z from ever rising. In a narrow→wide channel the inscribed-circle radius could grow, meaning the correct Z should rise (less negative). The clamp forces Z to stay flat instead, creating plateaus.

**Fix options:**
- **Option A (preferred):** Remove the `lastZ` cap entirely. Let Z follow the true inscribed circle, which naturally goes deeper in narrow passages and shallower in wide ones. The V-carve geometry is correct: if the channel widens, the cutter should rise.
- **Option B (conservative):** Replace the hard clamp with a configurable limit on Z increase per step (e.g. Z cannot rise by more than 10% of the step depth), smoothing out numerical noise while allowing genuine rises.
- **Option C:** Keep the monotonic clamp but compute `targetMidpointZ` against the parent contour (not the current contour) in rescue paths, aligning with how `bridgeSiblingChildren` already works.

---

### R3. Eliminate horizontal contour emissions — slope the collapse/micro contour paths

**Files:** [`contourToPath3D`](src/engine/toolpaths/vcarveRecursive.ts:110-115), [`emitCollapseGeometry`](src/engine/toolpaths/vcarveRecursive.ts:2087, 2128, 2138, 2146), [`buildInteriorCornerBridge`](src/engine/toolpaths/vcarveRecursive.ts:2024-2027)

**Problem:** Contour outlines (collapse contours, micro contours, split bridges) and interior corner bridges are emitted flat at a single Z. Where they meet sloped arm-chain paths, there is a Z discontinuity → visible ledge in the cut.

**Fix options:**
- **Option A (collapse contours):** Instead of emitting the contour at `microZ` (or `currentZ`), walk each contour vertex and compute its Z from the inscribed-circle formula: `contourZ[i] = topZ - minDistToContourWalls(vertex[i], parentContours) / slope`. Each vertex gets its own Z.
- **Option B (interior corner bridges):** Slope the bridge: start Z at one corner, end Z at the other, using the inscribed-circle depth at each endpoint. Replace the single `z` param with per-endpoint computation.
- **Option C (split bridge contours):** Same as Option A — compute per-vertex Z from true wall distance within the parent contour.

---

### R4. Ensure `nextZ` propagation respects the arm's accumulated Z in fresh seed bootstrap

**Files:** [`buildFreshSeedBootstrapCuts`](src/engine/toolpaths/vcarveRecursive.ts:1882-1885, 1903-1914, 1943-1946)

**Problem:** When `stepArms` rejects an arm (no valid target found on the next contour), the arm's tracked Z is lost. The fresh seed bootstrap then creates a cut from a surviving `sourceArm.z ?? currentZ` to `nextZ` — but the source arm may be at `currentZ` (parametric) while the rejected arm was deeper (from a prior rescue path). The fresh seed thus receives the wrong starting Z.

**Fix:**
1. In `stepArms`, when an arm is rejected, record its `arm.z` in the `RejectedCorner` struct or a parallel structure.
2. In the caller (`traceRegion` CONTINUE path, line 2308-2323), pass the rejected arms' Zs into `buildFreshSeedBootstrapCuts` so fresh seed connections can interpolate from the correct depth.
3. For the bootstrap direct-connect: use the **maximum** (most negative) Z among all nearby source arms, not just the closest one's Z.

---

### R5. Use inscribed-circle depth for rescue path *start* Z too, not just midpoint Zs

**Files:** [`buildCenterlineRescuePath`](src/engine/toolpaths/vcarveRecursive.ts:1692)

**Problem:** The rescue path starts at `arm.z ?? currentZ`. If `arm.z` is undefined (arm created by `createTrackedArm` without an explicit Z), it defaults to `currentZ` (parametric model 1), but the rescue path's first midpoint is at an inscribed-circle Z (model 2). The discrepancy creates a Z jump in the first segment of the rescue path.

**Fix:** Compute the inscribed-circle Z at the start point as well:
```typescript
const startZ = arm.z ?? currentZ
const startDistToWall = minDistToContourWalls(arm.point, [currentContour])
const inscribedStartZ = topZ - startDistToWall / slope
const adjustedStartZ = Math.max(minZ, Math.min(startZ, inscribedStartZ))
// Use adjustedStartZ instead of startZ
```

Or more simply: always set `arm.z` when creating arms for contours that are deeper than depth 0, so the inscribed-circle Z is baked in at arm-creation time.

---

### R6. Interpolate Z in salvage fallback of rescue path

**Files:** [`buildCenterlineRescuePath`](src/engine/toolpaths/vcarveRecursive.ts:1763)

**Problem:** The salvage fallback (when the walk bails but has accumulated midpoints) snaps directly to `nextZ` — skipping any intermediate Z computation. If the last midpoint was at a significantly different Z (model 2), the salvage creates a Z jump.

**Fix:** Use the same interpolated or inscribed-circle Z as proposed in R1 for the salvage snap point, rather than hard-coding `nextZ`.

---

### R7. Profile and reduce arm-rejection rate in `stepArms`

**Files:** [`stepArms`](src/engine/toolpaths/vcarveRecursive.ts:1097-1105)

**Problem:** Every rejected arm triggers a fresh seed bootstrap (R4) or is silently dropped. Arm rejection occurs when the arm's ray along its inward guide doesn't hit any corner on the next contour within budget, and all fallbacks (rescue, direct, wall-anchor) fail. The higher the rejection rate, the more Z chains are broken.

**Fix options:**
- Review the `findArmTarget` / `findContourRayHit` heuristics to see why corners are being missed. Is the inward guide direction diverging from the true bisector at deep offsets?
- Consider a "nearest-inside-corner" catch-all: if the ray misses but a corner is clearly visible and reachable by a straight segment inside the contour, accept it even if it's slightly off-ray.
- Log the rejection reasons to identify the dominant failure mode.

---

### R8. Add a diagnostic pass that flags Z discontinuities in the generated path

**Files:** New script or inline in [`pathsToMoves`](src/engine/toolpaths/vcarveRecursive.ts:2514-2556)

**Problem:** There is no automated check for Z jumps between consecutive path segments. The issue is currently only visible by inspecting the 3D preview.

**Fix:** Add a validation pass (either in `pathsToMoves` or as a standalone debug script) that:
1. For each pair of consecutive points in the final toolpath (after chaining and sorting), compute the expected Z from the parametric model at that XY.
2. Flag any point whose actual Z deviates from the expected Z by more than `stepSize / slope * 0.5` (half a step depth).
3. Output the XY location, actual Z, expected Z, and the emitting function's DIAG source tag for each discontinuity.

This can be implemented as an opt-in check gated by `operation.debugToolpath`.


**NOTE**: check VCARVE_RECURSIVE_TESTING_SCRIPTS.md for the ways to test your changes.
