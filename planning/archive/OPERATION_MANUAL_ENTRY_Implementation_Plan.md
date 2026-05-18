# Operation Manual Entry — Implementation Plan

## Goal

Extend the existing Tab-to-type workflow used during sketch creation/editing to transform operations, so users can enter exact values directly on the sketch instead of relying only on clicks.

## Status

Implemented in [src/components/canvas/SketchCanvas.tsx](/Users/frankp/Projects/camcam/.claude/worktrees/zealous-cray/src/components/canvas/SketchCanvas.tsx).

## Implemented Scope

The implementation stays local to `SketchCanvas.tsx` and adds a dedicated `OperationDimEdit` state for transform operations.

Supported operations:

- `Move`
- `Copy`
- `Resize`
- `Rotate`
- `Offset`

## Interaction Model

The operation entry fields are shown inline on the sketch, aligned with the current guide or measurement, matching the existing dimension-entry pattern used elsewhere in the canvas.

### Move / Copy

- Trigger: press `Tab` after the source point is set and before the destination is committed.
- Entry mode: a single positive `distance` field.
- Behavior: the typed distance is applied along the current preview direction, so the preview stays constrained to the current move/copy line.
- Commit:
  - `Move` commits immediately on `Enter`.
  - `Copy` commits the destination point on `Enter`, then falls through to the existing copy-count UI.

### Resize

- Trigger: press `Tab` after both reference points are defined.
- Entry mode: a single inline `scale factor` field.
- Behavior: typed factor updates the resize preview live.
- Commit: `Enter` applies the resize.

### Rotate

- Trigger: press `Tab` after rotation origin and reference direction are defined.
- Entry mode: a single inline `angle` field in degrees.
- Behavior: typed angle updates the rotate preview live.
- Commit: `Enter` applies the rotation.

### Offset

- Trigger: press `Tab` while offset mode is active.
- Entry mode: a single inline `distance` field.
- Behavior: typed signed distance updates the offset preview geometry live.
- Sign convention:
  - negative = inward
  - positive = outward
- Commit: `Enter` applies the offset.

## Keyboard Behavior

- `Tab`
  - enters manual entry for the current operation step
  - exits the current manual entry field back to canvas interaction
- `Enter`
  - commits the typed operation value
- `Esc`
  - cancels the whole pending operation, same as canvas-level escape

## Focus / Preview Rules

- entering manual entry moves focus to the inline field on the sketch
- while a field is active, canvas auto-focus is suppressed
- typed values drive the same preview refs used by mouse interaction, so previews update immediately

## UX Notes

- `Move` / `Copy` use distance-only entry rather than `Δx / Δy`, because the guide direction is already defined visually and scalar distance is more consistent with the rest of the sketch editing UX
- rotate preview only shows angle, not reference-line length
- the delete-point icon was adjusted to use a more prominent `X` over the point for clearer distinction from add-point

## Out of Scope

- store changes
- non-sketch property-panel equivalents for the same operation values
- additional numeric entry for other operations beyond the ones listed above
