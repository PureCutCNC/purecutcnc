# Rotation Constraint Propagation - Debug Analysis

## Problem Statement
Constrained features move in a random/unexpected way when a referenced feature is rotated, instead of maintaining the proper fixed distance.

## Visual Evidencee sti
The attached image shows:
- **Rect 1** (brown rotated rectangle) - the feature being rotated
- **Circle 2, 3, 4** and a small rectangle - constrained features with 0.25 unit fixed distances
- **Issue:** After rotation, the circles should maintain their 0.25 unit distance from Rect 1's edges/corners, but they move to incorrect positions
- The dashed lines show the constraint distances are violated (showing 0.375, 0.5, etc. instead of maintaining 0.25)

## Implementation Review

### Current Flow
1. **Rotation Applied** ([`rotateFeatureFromReference`](../src/store/projectStore.ts:940))
   - Rotates feature profile and origin around `referenceStart` pivot
   - Angle computed via `atan2(cross, dot)` from start/end vectors

2. **Angle Calculation** ([`completePendingTransform`](../src/store/slices/pendingCompletionSlice.ts:398))
   ```typescript
   const startVector = {
     x: pendingTransform.referenceEnd.x - pendingTransform.referenceStart.x,
     y: pendingTransform.referenceEnd.y - pendingTransform.referenceStart.y,
   }
   const endVector = {
     x: previewPoint.x - pendingTransform.referenceStart.x,
     y: previewPoint.y - pendingTransform.referenceStart.y,
   }
   const cross = startVector.x * endVector.y - startVector.y * endVector.x
   const dot = startVector.x * endVector.x + startVector.y * endVector.y
   const angle = Math.atan2(cross, dot)
   ```

3. **Constraint Propagation** ([`propagateConstraintsOnRotate`](../src/sketch/constraintSolver.ts:390))
   - Clears constraints on rotated features
   - Rotates reference points in dependent features' constraints
   - Solves for translation of dependent features using `solveFeatureTranslation`
   - Translates dependent features (they are NOT rotated, only translated)

## Identified Issues

### Issue 1: Anchor Point Not Rotated ⚠️
**Location:** [`propagateConstraintsOnRotate`](../src/sketch/constraintSolver.ts:390)

**Problem:** When a feature is rotated, its constraint's `anchor_point` should also be rotated to reflect the new position on the rotated feature. Currently, only the `reference_point` is rotated, but the `anchor_point` remains in its original position.

**Impact:** The solver receives an anchor point that doesn't match the actual position on the rotated dependent feature, causing incorrect translation calculations.

**Example:**
```
Before rotation:
- Feature A at (100, 100) with anchor at (110, 100)
- Feature B references A with reference_point at (110, 100)
- Distance: 50 units

After rotating A by 90° around (100, 100):
- Feature A's anchor should move to (100, 110) [rotated]
- Currently: anchor stays at (110, 100) [WRONG]
- Reference point correctly rotates to (100, 110)
- Solver sees: anchor (110, 100) → reference (100, 110)
- This creates wrong distance vector!
```

### Issue 2: Solver Direction Preservation Logic
**Location:** [`solveFeatureTranslation`](../src/sketch/constraintSolver.ts:42)

**Problem:** The solver uses the "original direction vector" (lines 69-77) to preserve the relationship between anchor and reference. However, after rotation, this original direction is no longer valid because the reference point has been rotated.

**Impact:** The solver tries to maintain distance in the original direction, but the reference point has moved to a new direction, causing the dependent feature to move incorrectly.

**Code:**
```typescript
// Calculate original direction vector from the initial anchor->reference
const origVx = c.anchor.x - c.reference.x
const origVy = c.anchor.y - c.reference.y
const origLen = Math.hypot(origVx, origVy)

// This direction is now wrong after reference point rotation!
```

### Issue 3: Missing Anchor Rotation in Propagation
**Location:** [`propagateConstraintsOnRotate`](../src/sketch/constraintSolver.ts:412-421)

**Current Code:**
```typescript
const nextConstraints = feature.sketch.constraints.map((c) => {
  if (c.type !== 'fixed_distance' || c.segment_ids.length === 0) return c
  const rotation = movedRotations.get(c.segment_ids[0])
  if (!rotation) return c
  changed = true
  return rotateReferenceFieldsIfMatches(c, c.segment_ids[0], rotation.pivot, rotation.angle)
})
```

**Missing:** No rotation of `anchor_point` for constraints on features that are NOT being rotated but reference rotated features.

## Root Cause Analysis

The fundamental issue is a **conceptual mismatch** in how constraints are updated:

1. **For Translation:** Both anchor and reference points move together (via `translateAnchorFields` and `translateReferenceFieldsIfMatches`), maintaining their relative positions.

2. **For Rotation:** Only reference points are rotated, but anchor points are NOT rotated. This breaks the constraint geometry.

### Why This Matters

When Feature B has a constraint referencing Feature A:
- `anchor_point`: A point on Feature B's profile
- `reference_point`: A point on Feature A's profile (or derived from it)

When Feature A rotates:
- Feature A's profile rotates → `reference_point` should rotate
- Feature B hasn't moved yet → `anchor_point` stays in place
- Solver calculates translation needed to restore distance
- **BUT:** If `anchor_point` isn't updated to reflect where it is on B's profile after B is translated, subsequent iterations will fail

## Proposed Solutions

### Solution 1: Rotate Anchor Points (Recommended)
When a dependent feature's constraint references a rotated feature, we need to consider that the dependent feature itself may need to rotate its anchor point if the feature moves.

**However**, this is complex because:
- The dependent feature is only translated, not rotated
- The anchor point is in the dependent feature's coordinate space
- We only need to translate the anchor point when the dependent feature translates

**Actual Fix:** The anchor point should be translated (not rotated) when the dependent feature is translated. This is already done in line 473:
```typescript
const nextConstraints = feature.sketch.constraints.map((c) => translateAnchorFields(c, dx, dy))
```

### Solution 2: Fix Solver Direction Logic
The solver's "original direction preservation" logic (lines 69-81 in `solveFeatureTranslation`) may be causing issues after rotation.

**Proposed Change:** For rotation scenarios, the solver should use the **current** direction from anchor to reference, not the "original" direction.

**Rationale:** After rotation, the reference point has moved to a new position. The constraint should maintain distance in the **new** direction, not the old one.

### Solution 3: Two-Phase Approach
1. **Phase 1:** Rotate reference points in all dependent constraints
2. **Phase 2:** For each dependent feature:
   - Calculate where its anchor point should be to maintain distance
   - Solve for translation
   - Apply translation to both profile AND anchor points

This is essentially what the current implementation does, but the solver logic may need adjustment.

## Debugging Steps

1. **Add Logging:** Insert console.log statements in `propagateConstraintsOnRotate` to track:
   - Rotation angle and pivot
   - Reference point before/after rotation
   - Anchor point position
   - Solver output (dx, dy)
   - Final translated position

2. **Verify Angle Calculation:** Ensure the angle computed in `completePendingTransform` matches the angle used in `rotateFeatureFromReference`.

3. **Test Solver Independently:** Create a unit test with known anchor/reference positions after rotation and verify solver output.

4. **Check Coordinate Systems:** Ensure all points are in the same coordinate system (world space, not local feature space).

## Recommended Fix

The most likely issue is **Solution 2** - the solver's direction preservation logic. After rotation, the "original direction" is no longer valid.

### Root Cause Confirmed

The solver in [`solveFeatureTranslation`](../src/sketch/constraintSolver.ts:42) uses "original direction preservation" logic (lines 67-81):

```typescript
// Calculate original direction vector from the initial anchor->reference
const origVx = c.anchor.x - c.reference.x
const origVy = c.anchor.y - c.reference.y
const origLen = Math.hypot(origVx, origVy)

// Normalize the original direction vector
const origUx = origVx / origLen
const origUy = origVy / origLen

// Calculate current signed distance in the direction of the original vector
const currentSignedDist = vx * origUx + vy * origUy
const residual = currentSignedDist - c.distance
```

**The Problem:** After rotation, the `reference_point` has moved to a new position. The "original direction" from `anchor` to the **old** reference position is no longer meaningful. The solver should maintain distance in the **new** direction (from anchor to the **rotated** reference point).

**Why This Causes Random Movement:**
1. Reference point rotates to new position
2. Solver calculates direction from anchor to **old** reference position (before rotation)
3. Solver tries to maintain distance in this **wrong** direction
4. Result: constrained feature moves in an incorrect direction

### Proposed Code Change

**File:** [`src/sketch/constraintSolver.ts`](../src/sketch/constraintSolver.ts:42)

**Change:** In the `solveFeatureTranslation` function, for point constraints, use the **current** direction instead of the "original" direction:

```typescript
// BEFORE (lines 61-92):
if (c.kind === 'point') {
  const ax = c.anchor.x + dx
  const ay = c.anchor.y + dy
  const vx = ax - c.reference.x
  const vy = ay - c.reference.y
  
  // For point constraints, preserve the original direction relationship
  // Calculate original direction vector from the initial anchor->reference
  const origVx = c.anchor.x - c.reference.x
  const origVy = c.anchor.y - c.reference.y
  const origLen = Math.hypot(origVx, origVy)
  
  if (origLen < 1e-12) continue
  
  // Normalize the original direction vector
  const origUx = origVx / origLen
  const origUy = origVy / origLen
  
  // Calculate current signed distance in the direction of the original vector
  const currentSignedDist = vx * origUx + vy * origUy
  const residual = currentSignedDist - c.distance
  
  // Use the original direction vector for derivatives (Jacobian)
  const jx = origUx
  const jy = origUy
  
  A00 += jx * jx
  A01 += jx * jy
  A11 += jy * jy
  b0 -= jx * residual
  b1 -= jy * residual
  contributed++
}

// AFTER (simplified - use current direction):
if (c.kind === 'point') {
  const ax = c.anchor.x + dx
  const ay = c.anchor.y + dy
  const vx = ax - c.reference.x
  const vy = ay - c.reference.y
  const currentLen = Math.hypot(vx, vy)
  
  if (currentLen < 1e-12) continue
  
  // Use CURRENT direction (from anchor to reference)
  const ux = vx / currentLen
  const uy = vy / currentLen
  
  // Calculate residual (current distance - target distance)
  const residual = currentLen - c.distance
  
  // Jacobian uses current direction
  const jx = ux
  const jy = uy
  
  A00 += jx * jx
  A01 += jx * jy
  A11 += jy * jy
  b0 -= jx * residual
  b1 -= jy * residual
  contributed++
}
```

**Rationale:**
- After rotation, the reference point is in a new position
- The constraint should maintain distance in the **new** direction (from anchor to rotated reference)
- The "original direction preservation" was designed for translation, where both anchor and reference move together
- For rotation, only the reference moves, so we need to use the current direction

### Alternative: Keep Original Direction for Translation, Use Current for Rotation

If we want to preserve the original behavior for translation while fixing rotation, we could add a flag to the constraint input:

```typescript
export interface PointDistanceInput {
  kind: 'point'
  anchor: Point
  reference: Point
  distance: number
  preserveDirection?: boolean  // NEW: default true for translation, false for rotation
}
```

However, the simpler fix (always use current direction) should work for both cases.

## Implementation Plan

### Step 1: Modify `solveFeatureTranslation`
Replace the "original direction preservation" logic with current direction calculation for point constraints.

### Step 2: Test with Rotation Scenario
1. Create two features with a fixed-distance constraint
2. Rotate the reference feature
3. Verify the constrained feature maintains proper distance
4. Check that the constrained feature moves in the correct direction

### Step 3: Verify Translation Still Works
Ensure that translation constraint propagation still works correctly after the change.

### Step 4: Add Unit Tests
Create tests for:
- Rotation with point-to-point constraints
- Rotation with point-to-segment constraints
- Multiple constrained features
- Chained constraints (A → B → C)

## Next Steps

1. ✅ Analyze the issue and identify root cause
2. ✅ Document the fix strategy
3. **Switch to Code mode** to implement the solver fix
4. Test and verify the fix works correctly
5. Update or add tests if needed
