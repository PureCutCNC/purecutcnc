---
status: Done
created: 2026-06-22
---

# Chamfer Tool Plan

## Goal

Add an equal-distance chamfer to Sketch Edit so a user can replace a valid
straight-line corner with a bevel without manually moving points or leaving
PureCutCNC. Chamfer must be an exact sibling of the existing fillet workflow:
the same Sketch Edit command surface, corner-pick sequence, live preview,
numeric panel, Apply/Cancel behaviour, undo semantics, and tablet treatment.
It must not create a second context-menu or toolbar interaction model.

## Approach

- Add `chamfer` as a Sketch Edit tool next to `fillet` in the existing command
  and Sketch Edit action surfaces. It is available only while editing a sketch,
  exactly as fillet is today.
- Generalise the current fillet-specific transient workflow state only as far as
  needed to support both corner operations through the same `CanvasWorkflowPanel`:
  pick an anchor, preview from pointer movement, optionally enter a typed value,
  then Apply/Cancel. The panel wording and field label vary by operation
  (`Radius` for fillet, `Distance` for chamfer); the interaction sequence does
  not.
- Implement a pure `applyLineCornerChamfer(profile, anchorIndex, distance)`
  helper alongside the existing line-corner fillet helper. It will trim both
  adjacent straight segments by the same distance from the selected corner and
  insert a connecting line segment.
  - Initial scope accepts only a non-terminal anchor with two adjacent `line`
    segments, in open or closed profiles.
  - It rejects zero/negative values, straight or degenerate corners, and values
    that consume either adjoining segment. Invalid edits leave geometry
    unchanged and do not create history entries.
  - `distance` means the equal trim distance measured along each adjoining
    segment. Distance-plus-angle, unequal distances, and arc/bezier corner
    support are deliberately deferred.
- Add the feature-level/store action following the existing fillet edit path so
  editing an instance updates its definition and rebakes every linked instance.
  This is a deliberate, narrow extension of the frozen `ProjectStore` contract;
  it must live in `featureGeometrySlice` and preserve the existing edit-in-place,
  constraints, stock-source sync, history, Apply, and Cancel behaviour.
- Reuse the fillet preview/typed-input geometry pattern for chamfer so a pointer
  preview and a typed distance produce the same result. Do not refactor
  unrelated Sketch Edit tools while making this change.
- Reuse the existing `dim-angle` icon for the initial Chamfer action. It keeps
  the adjacent Fillet and Chamfer controls visually distinguishable without
  changing the editable icon project as part of this focused editing slice.

## Files affected

- `src/store/types.ts` — add the `chamfer` Sketch Edit tool and its narrow store
  action signature.
- `src/store/slices/featureGeometrySlice.ts` — apply a chamfer through the same
  edit-in-place, definition-sync, constraint, stock-sync, and history path used
  by fillet.
- `src/store/helpers/profileEdit.ts` — add the pure equal-distance,
  line-corner chamfer operation.
- `src/store/helpers/profileEdit.test.ts` — cover the chamfer geometry and all
  invalid-input no-op cases.
- `src/store/helpers/referenceTransforms.ts` — provide feature-level chamfer
  helpers and pointer-to-distance calculation parallel to the fillet helpers.
- `src/components/canvas/useFilletWorkflow.ts` — generalise or replace with a
  narrowly scoped shared corner-edit workflow while retaining fillet's current
  observable behaviour.
- `src/components/canvas/useClickPlacement.ts` — route `chamfer` through the
  same click/pick/commit state machine as fillet.
- `src/components/canvas/usePointerGestures.ts` and
  `src/components/canvas/useCanvasKeyboard.ts` — make preview, keyboard entry,
  and cancellation recognise the shared corner-edit state without altering
  existing fillet behaviour.
- `src/components/canvas/SketchCanvas.tsx` — wire the tool, preview, and the
  existing Edit `CanvasWorkflowPanel` with Chamfer labels/value handling.
- `src/commands/sketchCommands.ts` — expose the Chamfer command using the
  existing Sketch Edit command/toggle rules.
- `src/components/layout/toolbar/SketchEditActions.tsx` — place Chamfer beside
  Fillet in the existing Sketch Edit action group.
- `src/store/editInPlace.test.ts` — verify a chamfer on a transformed linked
  instance updates the shared definition, rebakes sibling instances correctly,
  and still honours Apply/Cancel.
- `src/commands/sketchCommands.test.ts` — extend command-surface coverage if the
  existing Sketch Edit command tests require an exhaustive tool list.

## Tests

- Extend `profileEdit.test.ts` with geometry assertions for:
  - open and closed line profiles, including anchor zero/closed-profile closure;
  - orthogonal and non-orthogonal corners;
  - correct trims and connecting bevel line;
  - terminal open anchors, arc/bezier neighbours, straight/degenerate corners,
    and distances at or beyond the shortest adjacent segment returning no edit.
- Add an edit-in-place regression test analogous to the existing fillet test:
  chamfer a transformed linked instance, apply, and verify its original and
  sibling instance share the updated definition while preserving transforms.
  Also verify Cancel restores the pre-edit definition and geometry.
- Verify tool selection, preview, typed distance, second-click commit, Apply,
  Cancel/Escape, and undo/redo manually on desktop.
- Verify the same existing Fillet-style panel flow on a real tablet: touch a
  corner, use the Distance input, Apply, Cancel, and ensure no hover-only or
  keyboard-only step is required. Do not start a dev server; use the user's
  existing local app session when it is time for browser validation.
- Run `npm run build` before committing.

## Open questions / risks

- The first release defines a chamfer by equal edge-trim distance. This is
  intentionally simpler and less ambiguous than distance-plus-angle or unequal
  distance modes; those modes require a separate approved plan.
- The shared-corner-workflow refactor must remain minimal. If it risks changing
  fillet's observable behaviour, retain fillet's existing implementation and
  add the smallest compatible chamfer branch instead; user-visible consistency
  is non-negotiable.
- Adding a focused action to `ProjectStore` is justified only because sketch
  edits must use the store's established edit-in-place/history pipeline. Do not
  use this work to reorganise the frozen interface or move unrelated helpers.

## Out of scope

- Distance-plus-angle, unequal-distance, multi-corner, and automatic “apply to
  all corners” chamfers.
- Chamfering arc, circle, spline, or bezier geometry; extending lines to create
  a chamfer; and a remove/restore-corner command.
- Trim, extend, split, join, slots, construction geometry, and broader numeric
  editing work from the CAD roadmap.
- Any toolbar redesign, new context menu, or generic CAD interaction framework.
