# Design: Constraint Preservation during Feature Editing and Moving

## Goal
Preserve `fixed_distance` and other constraints when features are moved or edited. Currently, these constraints are aggressively removed to avoid complexity, but this breaks parametric relationships (e.g., a circle's distance from a rectangle edge).

## Current Behavior
- When a feature is moved or rotated rigidly, its own `fixed_distance` constraints are deleted.
- When a feature is edited (e.g., via `updateFeaturePoint`), all its `fixed_distance` constraints are deleted.
- When a feature is moved, any *other* features that refer to it have their constraints updated (translated/rotated) or deleted if the movement is not rigid.

## Proposed Changes

### 1. Stable Semantic References
Constraints currently store absolute `Point` coordinates for `anchor_point`, `reference_point`, and `reference_segment`. These become stale after non-rigid edits.

We should extend `LocalConstraint` to support index-based references:
- `anchor_index`: Index of the anchor point in the owning feature's profile.
- `anchor_type`: `'anchor'` or `'midpoint'`.
- `reference_index`: Index of the segment or anchor in the reference feature.
- `reference_type`: `'anchor'`, `'midpoint'`, or `'segment'` (for perpendicular distance to the line).

**Midpoints:**
- If `anchor_type` is `'midpoint'`, the constraint is tied to the center of segment `anchor_index`.
- If `reference_type` is `'midpoint'`, the reference point is the center of segment `reference_index`.

For special shapes like Circles, we should support semantic indices:
- `-1`: Center of a circle (standardized across shape types where applicable).
- `0...N`: Standard anchor indices.

### 2. Update `LocalConstraint` Interface
```typescript
export interface LocalConstraint {
  id: string
  type: LocalConstraintType
  segment_ids: string[]
  value?: number
  
  // Absolute points (kept for backwards compatibility and caching)
  anchor_point?: Point
  reference_point?: Point
  reference_segment?: { a: Point; b: Point }
  
  // Semantic references (new)
  anchor_index?: number
  anchor_type?: 'anchor' | 'midpoint'
  reference_index?: number
  reference_type?: 'anchor' | 'midpoint' | 'segment'
}
```

### 3. Smart Propagation on Edit
Introduce `propagateConstraintsOnEdit` in `constraintSolver.ts`. This function will be called after a non-rigid edit (like resizing a circle or moving a rectangle edge).

**Algorithm:**
1. Collect all features that were edited (the "seeds").
2. Find all dependent features (those with constraints referring to seeds).
3. For each dependent feature:
   - **Re-derive `anchor_point`:**
     - If `'anchor'`: Use `anchorPointForIndex(profile, anchor_index)`.
     - If `'midpoint'`: Use `lerp(start, end, 0.5)` for segment `anchor_index`.
   - **Re-derive `reference_point` or `reference_segment`:**
     - Similar logic using `reference_index` and `reference_type` in the seed feature.
   - Build a list of `ConstraintInput` for the solver, using the **original `value`** (the constrained distance).
   - Call `solveFeatureTranslation` to find the best `dx, dy` for the dependent feature.
   - Apply the translation and update the absolute points in its constraints.
   - Recurse to its own dependents.

### 4. Policy: Auto-Dimension vs. Strict Enforcement
We need to decide what happens when a user *manually* moves a feature that is constrained.

- **Option A (Strict):** The feature "snaps back" to satisfy the constraint after the move.
- **Option B (Auto-update):** The constraint's `value` is updated to the new distance.
- **Option C (Contextual):** If the user drags the feature, update the value. If a reference moves, keep the value and move the feature.

**Recommendation:**
- If the **owner** of the constraint is moved/edited: Update the constraint `value` (behave like a persistent dimension).
- If the **reference** of the constraint is moved/edited: Keep the `value` and move the owner (behave like a dependency).

### 5. Specific Shape Handling
- **Circles:** The center should be a stable reference point (index `-1`). If a circle is resized, its center doesn't move, so center-based constraints remain valid.
- **Rectangles & Multi-lines:** 
  - Indices `0...N` are stable for corners/anchors.
  - Midpoints of segments (edges) can be referenced to center features within boundaries.
  - Even if the rectangle is resized (e.g., stretching the right edge), the midpoint of the top edge moves predictably, and the constrained feature will follow.

### 6. Invalidation Handling
What happens if the geometry changes so that a semantic reference is no longer resolvable?
- **Scenario:** A segment is deleted, or a profile is changed from a 4-vertex rectangle to a 3-vertex triangle.
- **Action:** If `rederiveConstraintPoints` fails to find the index:
  1. **Flag as Invalid:** Add an `is_invalid: boolean` and `error_message?: string` to the `LocalConstraint`.
  2. **Notification:** Show a badge or warning icon on the constraint line in the canvas.
  3. **Auto-Cleanup (Optional):** We may choose to remove invalid constraints automatically if they stay invalid after a "repair" attempt, but initially, it's safer to keep them and let the user delete or re-bind them.
- **User Message:** Use the existing (or a new) notification system to alert: *"Constraint 'c1' on 'Circle 1' is no longer valid because the reference edge was deleted."*

### 7. User Interaction: Editing and Deletion
The canvas should support direct interaction with persistent constraints.

**Editing Constraint Values:**
- **Trigger:** User clicks on the constraint distance label (the text box showing "0.500 in") on the canvas.
- **Action:**
  1. The label transforms into a `DraftNumberInput` overlay (similar to how dimensions are edited during placement).
  2. User types a new value and presses `Enter`.
  3. `updateConstraintValue(featureId, constraintId, newValue)` is called.
  4. The solver runs immediately to reposition the feature based on the new value.

**Deleting Constraints:**
- **Option A (Keyboard):** If a constraint label is clicked/selected, pressing `Delete` or `Backspace` removes it.
- **Option B (Context Menu):** Right-clicking the constraint label shows a "Delete Constraint" option.
- **Option C (Toolbar):** While a feature is selected, its constraints could be listed in the Properties Panel with "X" buttons next to them.

**Visual Feedback:**
- Hovering a constraint should highlight the anchor point and the reference (edge/point) it is bound to.

## Implementation Steps

1. **Phase 1: Data Model**
   - Update `LocalConstraint` in `src/types/project.ts`.
   - Update `addConstraint` in `projectStore.ts` to store indices.

2. **Phase 2: Solver Enhancement**
   - Implement `rederiveConstraintPoints(feature, constraint, referenceFeature)` helper.
   - Implement `propagateConstraintsOnEdit` in `src/sketch/constraintSolver.ts`.

3. **Phase 3: Integration**
   - Call `propagateConstraintsOnEdit` in `updateFeaturePoint` and other edit actions.
   - Modify `clearStaleConstraints` and `propagateRigidTransforms` to preserve constraints instead of filtering them.

4. **Phase 4: Validation**
   - Test resizing a circle inside a constrained rectangle.
   - Test moving a rectangle edge and ensuring a constrained circle follows.
