# CAMCAM TODO / Issue Log

This file tracks follow-up work, open issues, and design questions that come up during implementation.

## Open Issues

### 3D preview material control
- Status: Open
- Priority: Medium
- Summary: Add a user-facing color option for the final 3D preview body material.
- Notes:
  - This is separate from per-feature color.
  - The current combined boolean result uses a neutral material in the viewport.

### 3D preview rendering polish
- Status: Open
- Priority: Medium
- Summary: Review viewport lighting and material tuning after more geometry features are added.
- Notes:
  - Flat shading fixed the worst artifacts.
  - The final look likely still needs another pass once the modeling flow stabilizes.

### 3D grid alignment does not match sketch view
- Status: Open
- Priority: Medium
- Summary: Align the 3D viewport grid orientation and positioning with the sketch view so both views share the same spatial reference.
- Notes:
  - Current 3D grid reference still feels inconsistent relative to the sketch plane.
  - Recheck this after the recent sketch-to-3D axis mapping changes.

### Sketch legend review / removal
- Status: Open
- Priority: Low
- Summary: Remove or redesign the sketch depth legend, which is no longer useful in its current form.
- Notes:
  - Current legend text overlaps visually and adds little value.
  - Revisit whether feature coloring/labels already communicate enough without a legend.

## Backlog

### Per-feature display color
- Status: Deferred
- Priority: Low
- Summary: Add a `color` property to each feature and use it in sketch rendering and 3D feature overlays.
- Notes:
  - Do not add this yet.
  - If implemented later, keep the final booleaned result neutral unless we also add proper multi-material support.

### Final model face coloring from feature history
- Status: Deferred
- Priority: Low
- Summary: Preserve feature identity through boolean evaluation so the final combined mesh can show per-feature colors.
- Notes:
  - This is more complex than adding feature colors alone.
  - Likely requires tracking original IDs or material groups through the manifold output.

### Coordinate system / reference plane review
- Status: Open
- Priority: Medium
- Summary: Revisit whether the current `Z=0` sketch/design plane model is the right long-term approach.
- Notes:
  - Current implementation treats features as CSG volumes spanning `z_top..z_bottom`.
  - Stock is currently reference-only for semantics.

### Undo / Redo
- Status: Open
- Priority: High
- Summary: Add undo and redo across project edits, including feature creation, deletion, reorder, property changes, and sketch edits.
- Notes:
  - Needs to cover both model edits and sketch control-point edits.
  - Should integrate cleanly with toolbar shortcuts and future menu actions.

### Copy / Duplicate
- Status: Open
- Priority: High
- Summary: Add copy/duplicate support for features so users can quickly reuse and reposition existing geometry.
- Notes:
  - Should preserve sketch geometry, operation, and Z range on duplicate.
  - Likely needs both toolbar/menu action and keyboard shortcut support.

### Move / Translate
- Status: Open
- Priority: High
- Summary: Add a move/translate tool so users can reposition existing features without entering low-level sketch point editing.
- Notes:
  - Should support precise numeric offsets and direct manipulation in the sketch view.
  - Needs to move the whole feature profile while preserving its Z range and operation.

### Marquee multi-selection
- Status: Open
- Priority: Medium
- Summary: Allow selecting multiple features in the sketch by dragging a rectangular window around them.
- Notes:
  - Should complement the current modifier-click multi-select flow.
  - Need to define whether window selection means fully enclosed only or any overlap.

### Pocket toolpath ordering and linking
- Status: Open
- Priority: Medium
- Summary: Improve pocket toolpath ordering so disconnected regions are grouped sensibly and long back-and-forth jumps are reduced.
- Notes:
  - Finish one connected region before jumping to another when possible.
  - Add nearest-entry or region-aware contour ordering later.

### Pocket linking without unnecessary safe-Z retracts
- Status: Open
- Priority: Medium
- Summary: Reduce conservative retract-to-safe behavior between contours and levels when a local in-material link or direct stepdown is safe.
- Notes:
  - Current first pass retracts too often for disconnected and connected regions alike.
  - This should be coordinated with smarter contour ordering.

### Pocket finish refinement
- Status: Open
- Priority: Medium
- Summary: Refine finish-pocket strategy beyond the current first pass.
- Notes:
  - Current finish supports separate wall and floor toggles.
  - Future improvements include smarter floor-finish patterns, better finish ordering, and richer finish linking.

## Done

### Ordered 3D boolean evaluation
- Status: Done
- Summary: 3D preview now applies `add` and `subtract` in feature tree order.

### Two-click feature placement
- Status: Done
- Summary: First click sets anchor, second click sets size, with live preview during placement.

### Left tree / properties / right tabs layout
- Status: Done
- Summary: Feature tree moved left, properties panel added below, right panel now uses `Operations` and `AI Chat` tabs.
