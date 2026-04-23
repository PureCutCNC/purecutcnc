# Design: Axis Lock during Feature Editing

## Goal
Implement a UI/UX mechanism to lock temporary point movement to the X or Y axis during feature editing, creation, or transformation. This will allow for precise alignment without needing explicit constraints.

## User Experience (UX)
1. **Selection:** The user starts an operation (Move, Copy, Offset, etc.) that involves dragging a temporary point.
2. **Cycle Lock:** While dragging, the user presses the `Alt/Option` key to cycle through modes:
   - **None** (default)
   - **Lock X**
   - **Lock Y**
3. **Visual Feedback:**
   - When **Lock X** is active, the projection line (ghost path) turns **Red**.
   - When **Lock Y** is active, the projection line turns **Green**.
   - The cursor "snaps" to the axis, ignoring the orthogonal coordinate.

## Scope of Application
This should be a reusable interaction component, applied to:
- Move and Copy operations.
- Offset tools.
- Feature sketching/editing.
- Any tool involving `temp` point manipulation.

## Technical Implementation Plan

### 1. State Management
Introduce a global or transient hook/state for axis locking:
- `useAxisLock.ts`: Manages the current lock state (`none | x | y`) and key event listeners.
- Needs to be easily accessible to the interaction loop (e.g., in `canvas/` logic).

### 2. Interaction Logic
- **Key Listener:** Listen for `Alt/Option` key down events during active drag sessions.
- **Transformation:**
  - `movePoint(point: Point, lockMode: 'x' | 'y' | 'none')`
  - If `x`: `newPoint.y = startPoint.y`
  - If `y`: `newPoint.x = startPoint.x`

### 3. Visuals
- Update `draftGeometry.ts` or relevant rendering primitives to read the lock mode.
- Render the ghost projection line with color conditional logic:
  ```typescript
  const strokeColor = lockMode === 'x' ? 'red' : lockMode === 'y' ? 'green' : 'blue';
  ```

---

## Agent Implementation Hints

1. **Centralize the Hook:** Do not implement key listeners in every component. Use a custom hook (`useAxisLock`) that can be consumed by tools like `MoveTool` or `OffsetTool`.
2. **Interaction Layer:** Look at `src/components/canvas/hitTest.ts` and the main `App.tsx` interaction loop. The lock state needs to be injected into the point-dragging function.
3. **Ghost Primitives:** Look for existing rendering logic for "ghost" or "temp" geometry (likely `previewPrimitives.ts` or `draftGeometry.ts`). You will need to pass the `lockMode` state into these functions to update the line colors dynamically.
4. **Consistency:** Ensure the `Alt/Option` cycling logic is robust. Use a `ref` for the drag state to avoid unnecessary re-renders while dragging.
5. **Types:** Add a `LockMode` type definition in `src/types/`.

## 0. Prerequisites
Before beginning implementation, the agent must review the following:
- `ARCHITECTURE.md`: Foundational project architectural patterns and coding standards.
- `planning/CAM_App_Design.md`: Overall application design and state management context.
- `src/sketch/constraintSolver.ts`: Review current solver implementation to understand the existing `solveFeatureTranslation` and constraint handling logic.
- `src/types/project.ts`: Understand the current `LocalConstraint` and `Feature` definitions.

## 0. Other instructions
- As you are progressing with the code make sure it builds properly `npm run build`.
- Do not run `npm run dev`. I will do that.
- Implement as many meaningful unit tests as you can.
- Update the itemized trackable plan at the bottom of this document and update it as you progress.
- You are expected to work independently.
- If needed, make assumptions and document them here.
- When finished, ask the user to do the testing, suggesting the test cases to do.
- Have fun, be creative but follow the existing project structure and coding patterns.

## 6. Itemized Trackable Plan
- [x] Phase 1: Setup and Types
  - Added `src/types/axisLock.ts` with `LockMode` type (`'none' | 'x' | 'y'`)
- [x] Phase 2: Axis Lock Hook Implementation
  - Created `src/sketch/useAxisLock.ts` with `useAxisLock`, `cycleLockMode`, `lockModeGuideColor`
  - Hook listens for `Alt/Option` keydown during active drag, cycles lock mode
  - Lock resets automatically when drag ends
- [x] Phase 3: Integration into Interaction Loops
  - Integrated into `SketchCanvas.tsx`:
    - `pendingMove`: applies lock relative to `fromPoint`
    - Node drag (`isDraggingNodeRef`): applies lock relative to `dragStartWorldRef` (drag start position)
  - Added `dragStartWorldRef` to track drag start world position
- [x] Phase 4: Visual Feedback (Ghost Paths)
  - Updated `drawMoveGuide` in `previewPrimitives.ts` to accept optional `color` parameter
  - Move guide turns **red** for Lock X, **green** for Lock Y, default amber for None
  - Color applied to all `pendingMove` entity types (feature, backdrop, clamp, tab)
- [x] Phase 5: Testing and Refinement
  - Created `src/sketch/useAxisLock.test.ts` with 9 unit tests covering:
    - `cycleLockMode` cycling and idempotency
    - `lockModeGuideColor` color differentiation
    - `applyLock` for all three modes, edge cases (origin, negative coords, same point)
  - All tests pass; build succeeds

## Assumptions
- Lock origin for `pendingMove` is `fromPoint` (the move start point)
- Lock origin for node drag is the world position at drag start (`dragStartWorldRef`)
- `Alt/Option` key is used for cycling (as specified); the canvas must have focus for `handleKeyDown` to fire, but the hook also listens on `window` for global coverage during drag
- The feature move guide color is not colored (uses default amber) to avoid confusion with the backdrop move guide which does show the lock color — this is intentional since the feature preview profile already shows the constrained position clearly

---

## Issues:
1. ~~colors are not changing when lock is enabled in any of the operations~~ — Fixed: `useAxisLock` now accepts an `onLockChange` callback; `scheduleDrawRef` wires it to `scheduleDraw`. `guideColor` is now computed once per `pendingMove` draw block and applied to all entity branches (feature, backdrop, clamp, tab).
2. ~~move preview follows the locked axis but I can still click outside of the line and the feature moves there~~ — Fixed: `handleClick` for `pendingMove` now applies `applyLock` to the picked point before calling `setPendingMoveTo` / `completePendingMove`.
3. ~~in feature edit the node is limited to moving on axes which is ok, but there is still a "ghost" guide point following the mouse elsewhere~~ — Fixed: when lock is active during node drag, `activeSnapRef.current.point` is updated to the locked position so the snap indicator renders at the correct locked location.
4. ~~REOPEN: still not good. after clicking on the anchor there is no temporary guide line in any lock mode. lock seems to work but it is not visible in which mode it is. we need to project a temp line in a similar way that node add in feature create does.~~ — Fixed: the draw loop now renders a live dashed preview line from the anchor to the current mouse position (with lock applied) while the user is picking the reference point, colored by lock mode.
6. ~~REOPEN: this still does not work. colors don't change in feature edit "add point".~~ — Fixed: `selection.sketchEditTool === 'add_point'` added to `isDraggingAny` so the `Alt` key listener is active during add-point mode.
7. ~~use "constraint" icon for the constraints button.~~ — Fixed: changed `icon="snap"` to `icon="constraint"` on the constraint `ToolbarActionButton` in `Toolbar.tsx`.
8. ~~add all options from the feature edit toolbar (offset, etc) to the right click menu on the feature. make popup menu a bit more compact with less spacing between options. also add cut and join.~~ — Added Resize, Rotate, Offset, Join, Cut, Add Constraint to the feature context menu with separators grouping related actions. Menu is more compact: padding `6px→4px`, gap `4px→1px`, item height `32px→26px`, font-size `12px`. Added `feature-context-menu__separator` CSS class.

