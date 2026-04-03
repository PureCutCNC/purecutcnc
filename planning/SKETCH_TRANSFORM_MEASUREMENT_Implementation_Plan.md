# Sketch Transform Measurement Implementation Plan

Legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete

## Goal
Add live measurement overlays to sketch transform tools so move/copy/offset/resize/rotate previews communicate the exact transform before commit.

## Scope
First pass should cover:
- `Move`
- `Copy`
- `Offset`
- `Resize`
- `Rotate`

These overlays should be preview-only and match the visual style of the existing sketch measurement labels.

## Interaction Rules
### Move / Copy
- Show travel distance on the move guide.
- Copy uses the same distance overlay as move.

### Offset
- Show the active offset distance on the nearest-point-to-preview guide.
- Inward/outward direction is already shown by the preview geometry; the label only needs the magnitude.

### Resize
- Show the original reference length.
- Show the current preview length during the third-point stage.

### Rotate
- Show the signed rotation angle during the third-point preview stage.
- The angle label should sit near the chosen rotation origin.

## Work Breakdown
### STM1 Shared transform measurement helpers
- [x] Add guide-distance and angle label helpers.

### STM2 Move / Copy / Offset
- [x] Move preview shows travel distance.
- [x] Copy preview shows travel distance.
- [x] Offset preview shows offset distance.

### STM3 Resize / Rotate
- [x] Resize preview shows reference length and current preview length.
- [x] Rotate preview shows angle.

### STM4 Review
- [~] Verify the labels remain readable during dense previews.
- [~] Check inch/mm formatting and angle formatting.
- [~] Trim any redundant labels that make multi-copy previews too noisy.

## Notes
- Reuse the existing `drawMeasurementLabel()` visual language.
- Keep these overlays transient; they should not persist after commit.
- Prefer measuring the actual preview points already used by the transform tool instead of recomputing from unrelated state.
