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

### Operation-specific cleanup strategies
- Status: Open
- Priority: Medium
- Summary: Add different cleanup pattern strategies for `Pocket` and `Surface Clean` instead of using the same concentric-offset style for both.
- Notes:
  - Pocket will likely want offset, raster, morph, and rest-machining options later.
  - Surface clean will likely want raster, zig-zag, one-way, and contour-parallel options.

### Segment-type conversion for any editable profile
- Status: Open
- Priority: Medium
- Summary: Allow converting an existing segment between `line`, `arc`, and `spline/bezier` on any editable closed profile, not just composite-created features.
- Notes:
  - Rectangles, polygons, splines, and composite features should all participate, since they are all editable profiles.
  - Example: convert one rectangle edge from a line into an arc without rebuilding the whole feature.
  - This likely needs explicit segment selection in sketch edit mode, not just point/handle selection.

### Clamp naming / type cleanup
- Status: Open
- Priority: Low
- Summary: Simplify clamp naming and clamp type handling now that first-pass clamp authoring is working.
- Notes:
  - Current clamp type is still mostly placeholder data.
  - Revisit whether multiple clamp types belong in the POC or whether a simpler clamp model is better until a clamp library exists.

### Per-clamp display color
- Status: Open
- Priority: Low
- Summary: Allow clamps to use their own display colors in sketch and 3D.
- Notes:
  - Current clamp rendering uses one shared visual language.
  - This is mainly setup readability polish.

### Clamp folders / setup groups
- Status: Open
- Priority: Low
- Summary: Add grouping for clamps so larger setups can organize workholding separately from features.
- Notes:
  - Likely similar to the feature-folder model.
  - Could later support setup-specific visibility or enable/disable behavior.

### XY reroute around clamps
- Status: Open
- Priority: Medium
- Summary: Add XY rerouting around clamp keep-out regions when a direct rapid/link crossing is unsafe or inefficient.
- Notes:
  - Current clamp handling only lifts rapids vertically when possible.
  - This is a later toolpath-optimization feature, not required for current clamp-aware processing.

### Pocket preserved-material handling
- Status: Open
- Priority: Medium
- Summary: Make pocket toolpaths respect included preserved material features the same way edge routes now respect relevant additive restorations.
- Notes:
  - Current pocket generation still ignores some included/internal preserved features during path generation.
  - This should be resolved in the pocket CAM resolver/toolpath stage, not by changing finished-part modeling.

### Combine multiple inside edge targets
- Status: Open
- Priority: Medium
- Summary: When multiple features are selected for an inside edge route, resolve them as one combined target region where appropriate, similar to pocket target union behavior.
- Notes:
  - Current inside edge routing still treats multiple targets too independently in some cases.
  - This should be addressed in the inside-edge resolver rather than as a display-only change.

### Combine multiple outside edge targets
- Status: Open
- Priority: High
- Summary: When multiple features are selected for an outside edge route, resolve them as one combined outer boundary where appropriate instead of cutting through the interior overlap.
- Notes:
  - Current outside edge routing can machine through the inside of overlapping selected add features.
  - This is a resolver/toolpath correctness issue, not just a preview issue.

### New operations visible by default
- Status: Open
- Priority: Low
- Summary: Newly created operations should default to `showToolpath = true` so the preview appears immediately without extra user action.
- Notes:
  - This is a CAM UI/default-behavior improvement.
  - It should apply consistently across rough, finish, and paired operation creation.

### Reduce irrelevant tab warnings
- Status: Open
- Priority: Medium
- Summary: Do not show per-tab warnings for tabs that are not meaningfully relevant to the current operation/toolpath.
- Notes:
  - Current tab validation is too noisy when many tabs exist elsewhere in the setup.
  - Prefer surfacing only tabs that intersect or are otherwise plausibly involved in the selected operation.

### Tab lift vs machine/clamp limits
- Status: Open
- Priority: Low
- Summary: Validate tab-raised contour motion against clamp clearance and project `Max Z`, and warn when a tab-crossing lift cannot be performed safely.
- Notes:
  - This is the deferred `TB7` work from the tab plan.
  - It matters for machine-safety validation, but is not blocking the current tab workflow.

### Tab presets / default dimensions
- Status: Open
- Priority: Low
- Summary: Add reusable default tab dimensions or simple tab presets to speed up manual placement.

### Automatic tab placement
- Status: Open
- Priority: Low
- Summary: Add automatic tab placement suggestions or generation for suitable edge-route operations.

### Non-rectangular tabs
- Status: Open
- Priority: Low
- Summary: Support tab shapes beyond simple rectangles.
- Notes:
  - This likely belongs under the same future profile-based approach as richer clamp geometry.

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
