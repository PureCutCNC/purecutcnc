# Sketch Measurement Implementation Plan

Legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete

## Goal
Add lightweight live measurement overlays in the sketch so geometry can be drawn and edited more precisely without opening numeric properties.

## Scope
First pass should show:
- line lengths while drawing rectangles
- radius while drawing circles
- radius while previewing and editing arcs
- line lengths while previewing multiline-style creation (`polygon`) and `composite` line segments
- adjacent line lengths while moving a feature point

First pass should not try to solve:
- persistent dimensions after commit
- editable numeric dimension widgets
- constraint-driven dimensions
- text collision avoidance for every dense case
- bezier curve length display

## Interaction Rules
### Preview-only measurements
Measurements in this pass are transient overlays.

They appear:
- during add/preview flows
- while dragging an editable anchor or arc handle

They disappear after commit/cancel.

### Formatting
- Use current project units.
- Line labels should read as plain lengths.
- Radius labels should use `R ...`.
- Labels should sit close to the related geometry and stay readable on dark backgrounds.

### Placement
- Line lengths should sit inline with the relevant segment.
- Circle radius should sit on the center-to-preview radius direction.
- Arc radius should sit near the arc midpoint.
- Edit-mode adjacent lengths should only show for line segments touching the active anchor.

## Work Breakdown
### SM1 Shared measurement drawing helpers
- [x] Add canvas helpers for:
  - line length extraction
  - arc radius extraction
  - rotated inline label drawing
  - radius label drawing

### SM2 Rectangle and circle preview
- [x] Rectangle preview shows all four side lengths.
- [x] Circle preview shows radius.

### SM3 Multiline and composite preview
- [x] Polygon/open multiline preview shows line lengths.
- [x] Composite preview shows line lengths on line segments.
- [x] Composite arc preview shows radius.

### SM4 Arc edit and feature edit
- [x] Dragging an arc handle shows current radius.
- [x] Dragging a feature anchor shows adjacent line lengths.

### SM5 Review and polish
- [~] Verify labels stay legible at common zoom levels.
- [~] Verify inch/mm formatting feels reasonable.
- [~] Trim any noisy overlays that appear in invalid edge cases.

## Notes
- Reuse existing sketch preview draw paths instead of creating a separate overlay layer.
- Prefer measuring actual preview geometry rather than reconstructing measurements from UI state where possible.
- For edited features, derive labels from the already-mutated live profile during drag so the displayed value always matches the visible geometry.
