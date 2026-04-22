# Constraint Propagation Bug Analysis

## Problem Description

When a parent feature (reference) is moved multiple times, child features (constrained) lose their constraints after 1-2 moves. The constraint visualization disappears and the child feature no longer follows the parent.

## Root Cause

The bug is in [`constraintSolver.ts`](../src/sketch/constraintSolver.ts:183) in the `propagateConstraintsOnTranslate` function.

### Current Behavior

1. User moves Rect 1 (parent feature)
2. `propagateConstraintsOnTranslate` is called with `movedOffsets = {Rect1: {dx, dy}}`
3. **Lines 195-201**: Rect 1's own constraints are cleared (correct behavior)
4. **Lines 203-214**: Circle 2's constraint reference points are updated to follow Rect 1's movement
5. **Lines 240-265**: Circle 2 is moved by the solver to satisfy its 0.5 distance constraint
6. **Lines 267-276**: Any features depending on Circle 2 would have their references updated

### The Bug

When Circle 2 is moved by the constraint solver (step 5), its new position is NOT tracked in any persistent way. On the **next move** of Rect 1:

1. `propagateConstraintsOnTranslate` is called again with `movedOffsets = {Rect1: {dx, dy}}`
2. Circle 2's constraint reference points are updated based on Rect 1's movement
3. BUT Circle 2's **anchor point** in its own constraint is now stale - it still points to where Circle 2 was BEFORE the previous solver move
4. The solver tries to move Circle 2 again, but the anchor point is wrong
5. After a few iterations, the constraint becomes unsolvable and is effectively lost

### Code Analysis

```typescript
// Line 195-201: Moved features lose their constraints
if (movedIds.has(id)) {
  const kept = feature.sketch.constraints.filter((c) => c.type !== 'fixed_distance')
  // This clears constraints on DIRECTLY moved features
  // But Circle 2 is moved by the SOLVER, not directly
}

// Line 257-265: Solver moves Circle 2
const { dx, dy } = solveFeatureTranslation(inputs)
const nextProfile = translateProfile(feature.sketch.profile, dx, dy)
const nextConstraints = feature.sketch.constraints.map((c) => translateAnchorFields(c, dx, dy))
// Circle 2's anchor point is updated HERE
// But this update is NOT persisted for the next move of Rect 1!
```

## Why It Works Initially

The first 1-2 moves work because:
- The anchor point starts in the correct position
- The reference point is updated correctly
- The solver can calculate the correct movement

But after multiple moves, the accumulated error in the anchor point position causes the constraint to fail.

## Solution Approaches

### Option 1: Track Solver-Moved Features (Recommended)

Modify `propagateConstraintsOnTranslate` to return or track which features were moved by the solver, and ensure their anchor points are properly maintained across multiple parent moves.

**Implementation**:
1. Keep a persistent record of which features have been moved by constraints
2. When updating reference points (lines 204-214), ALSO update anchor points for features that were previously moved by the solver
3. This ensures the anchor point always reflects the feature's actual current position

### Option 2: Store Constraints Relative to Reference

Instead of storing absolute anchor/reference points, store constraints as:
- Reference feature ID
- Offset vector from reference point to anchor point
- Distance value

This way, when the reference moves, the constraint automatically updates.

**Pros**: More robust, constraints naturally follow references
**Cons**: Requires refactoring the constraint data model

### Option 3: Re-solve All Constraints on Every Move

Instead of trying to incrementally update, re-solve all constraints from scratch on every move.

**Pros**: Simpler logic, always correct
**Cons**: Performance impact, may cause instability with complex constraint networks

## Recommended Fix

**Option 1** is the best approach because:
- Minimal changes to existing code
- Maintains performance
- Fixes the root cause without changing the data model

### Implementation Steps

1. In `propagateConstraintsOnTranslate`, track which features are moved by the solver
2. When a feature is moved by the solver, update its anchor points to reflect its new position
3. On subsequent calls, treat solver-moved features similarly to directly-moved features when updating reference points
4. Ensure anchor points are always synchronized with the feature's actual position

### Specific Code Changes Needed

In [`constraintSolver.ts`](../src/sketch/constraintSolver.ts:257):

```typescript
// After solving and moving a feature
const { dx, dy } = solveFeatureTranslation(inputs)
if (Math.hypot(dx, dy) < 1e-7) continue

const nextProfile = translateProfile(feature.sketch.profile, dx, dy)
const nextConstraints = feature.sketch.constraints.map((c) => translateAnchorFields(c, dx, dy))

// ADD: Track this feature as moved by solver
// This offset should be accumulated with any previous solver moves
// and used in the next iteration to update reference points correctly
```

The key insight is that **anchor points must be updated not just when the feature is moved by the solver, but also when its reference features are moved**.

## Testing Plan

1. Create two features: Rect 1 (parent) and Circle 2 (child with constraint)
2. Add a 0.5 distance constraint from Circle 2 to Rect 1
3. Move Rect 1 multiple times (5-10 moves)
4. Verify Circle 2 maintains the 0.5 distance throughout
5. Check that the constraint visualization remains visible
6. Verify the constraint is still present in the feature data after multiple moves

## Related Files

- [`src/sketch/constraintSolver.ts`](../src/sketch/constraintSolver.ts:183) - Main constraint solver
- [`src/store/slices/pendingCompletionSlice.ts`](../src/store/slices/pendingCompletionSlice.ts:190) - Calls propagateConstraintsOnTranslate
- [`src/types/project.ts`](../src/types/project.ts:97) - LocalConstraint data model
