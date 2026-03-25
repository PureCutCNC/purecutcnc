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

