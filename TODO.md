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

### Origin placement preview responsiveness
- Status: Open
- Priority: Low
- Summary: Smooth out the temporary origin marker during sketch placement.
- Notes:
  - Current first pass origin placement works, but the preview point updates inconsistently and can appear to lag until mouse motion slows or stops.
  - Revisit the sketch-canvas preview update path so origin placement feels as responsive as other placement interactions.

### Sketch legend review / removal
- Status: Open
- Priority: Low
- Summary: Remove or redesign the sketch depth legend, which is no longer useful in its current form.
- Notes:
  - Current legend text overlaps visually and adds little value.
  - Revisit whether feature coloring/labels already communicate enough without a legend.

## Backlog

### Refactor UI to use SVG Sprite Icon system
- Status: Open
- Priority: Medium
- Summary: Replace all inline SVGs and character-based icons (like ◉, ○, ▸) with the unified `Icon` component.
- Notes:
  - Utilize the new `src/components/Icon.tsx` component which pulls from the `public/icons.svg` pool.
  - Target files for refactoring: `Toolbar.tsx`, `FeatureTree.tsx`, `CAMPanel.tsx`, and `Viewport3D.tsx`.
  - Standardize icon sizing (e.g., 18px for toolbar, 14-16px for panels).
  - Use CSS (`.icon-sprite` in `layout.css`) for global properties like `stroke-width`, `transition`, and `currentColor` inheritance.
  - Map current character icons (◉, ○) to professional sprite IDs like `eye` and `eye-off`.

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

### Multi-level tree presentation
- Status: Open
- Priority: Low
- Summary: Improve the way nested tree items and connectors are presented in the project tree.
- Notes:
  - Current tree is workable but still visually awkward for deeper nesting.
  - Revisit connector style and spacing once the tree structure stabilizes.

### Folder delete behavior
- Status: Open
- Priority: Low
- Summary: When deleting a feature folder, ask whether the contained features should also be deleted.
- Notes:
  - Current behavior should be made explicit before more folder-heavy projects appear.
  - This is mainly a safety/UX cleanup item.

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

### Configurable arc / chord tolerance for CAM flattening
- Status: Open
- Priority: Medium
- Summary: Replace the current hardcoded curve sampling and arc step settings with an explicit CAM flattening tolerance.
- Notes:
  - Toolpath preview and exported G-code currently share the same pre-flattened toolpath geometry.
  - The current CAM defaults are hardcoded in `flattenProfile(...)` (`curveSamples = 24`, `arcStepRadians = Math.PI / 36`).
  - This should become a named tolerance or resolution setting instead of an implicit sampling constant.
  - Longer term, machine definitions may want their own export tolerance if we keep linearized output for some controllers.

### Unit-specific G-code number formatting
- Status: Open
- Priority: Medium
- Summary: Make G-code numeric precision depend on export units instead of one fixed decimal count per machine definition.
- Notes:
  - The current `numberFormat.decimalPlaces` model is too coarse because inch and mm exports need different practical precision.
  - Example: bundled `grbl` is currently `3` decimals for both unit systems, which is acceptable for mm but too coarse for inch.
  - Update the machine-definition schema and formatter so unit-specific precision is explicit rather than implied.
  - Coordinate this with CAM flattening tolerance so exported point spacing is not finer than controller formatting can represent.

### Move machine selection into project settings
- Status: Open
- Priority: Medium
- Summary: Move machine/post selection out of the export dialog and into the project settings/origin setup area.
- Notes:
  - Machine choice is part of project CAM setup, not a per-export surprise setting.
  - The export dialog should focus on confirming/exporting with the already selected machine.
  - This should align with the broader direction of treating origin and machine configuration as setup objects rather than export-only controls.

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

### Clamp geometry upgrade
- Status: Open
- Priority: Low
- Summary: Upgrade clamps from simple rectangles to full profile-based geometry with richer editing.
- Notes:
  - This should eventually reuse the same profile/composite editing model as features.
  - That would allow non-rectangular clamps and better direct manipulation.

### Clamp library / presets
- Status: Open
- Priority: Low
- Summary: Add reusable clamp presets or a clamp library.
- Notes:
  - This pairs naturally with richer clamp geometry later.
  - First pass could still be simple named rectangular presets.

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
- Summary: Resolve the remaining pocket preserved-material edge cases in complex multi-target and nested additive/subtractive situations.
- Notes:
  - Basic preserved-material cases are now working:
    - overlapping additive features inside pockets
    - internal additive features inside pockets
    - tabs as temporary preserved material inside pockets
  - Remaining issues are narrower resolver edge cases, not a general pocket-preservation failure.
  - This should be resolved in the pocket CAM resolver/toolpath stage, not by changing finished-part modeling.

### Shallower enclosed pocket warning
- Status: Open
- Priority: Low
- Summary: Warn when a selected shallower subtract pocket is enclosed by a deeper pocket target and resolves like an unsupported island case.
- Notes:
  - This is not a general pocket bug, but a specific case that should not fail silently.
  - The warning should explain that the preserved/resulting behavior is limited in this configuration.

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
  - This is deferred `TB7` work from the tab plan.
  - It matters for machine-safety validation, but is not blocking the current tab workflow.

### Tab presets / default dimensions
- Status: Open
- Priority: Low
- Summary: Add reusable default tab dimensions or simple tab presets to speed up manual placement.

### Non-rectangular tabs
- Status: Open
- Priority: Low
- Summary: Support tab shapes beyond simple rectangles.
- Notes:
  - This likely belongs under the same future profile-based approach as richer clamp geometry.

### Simulation zoom extent
- Status: Open
- Priority: Low
- Summary: Make `zoom extent` work in the `Simulation` view.
- Notes:
  - The simulation viewport should fit the current simulated stock/overlays the same way the other 3D viewports do.

### Preserve view direction on fit
- Status: Open
- Priority: Low
- Summary: Make viewport fit/zoom extent preserve the current camera direction instead of forcing iso.
- Notes:
  - This applies to both `3D View` and `Simulation`.
  - Current fit behavior resets orientation instead of only adjusting target/radius.

### Prevent view shift on show/hide
- Status: Open
- Priority: Low
- Summary: Prevent 3D framing/target from shifting when showing or hiding features, tabs, or similar overlays.
- Notes:
  - Visibility changes should not unexpectedly move the camera target.
  - This is separate from explicit fit/zoom extent behavior.

### Tool tab filtering
- Status: Open
- Priority: Low
- Summary: Add filtering/search to the Tools tab.
- Notes:
  - Likely first filters:
    - tool type
    - units
    - maybe text search by name
  - This becomes more important now that the bundled library can populate the project tool list quickly.

### Tool library loading enhancements
- Status: Open
- Priority: Low
- Summary: Extend tool library loading beyond the bundled static JSON.
- Notes:
  - Support loading from a user-provided/custom JSON file
  - Add per-tool import instead of import-all only
  - Add library-side filtering/search similar to the main Tools tab
  - Likely first filters:
    - tool type
    - units
    - text search by name

### Simulation stock comparison / deviation view
- Status: Open
- Priority: Low
- Summary: Add a comparison mode that shows deviation between the simulated stock result and the intended model.

### Simulation tool animation / scrubber
- Status: Open
- Priority: Low
- Summary: Add optional tool animation or a replay scrubber in the Simulation view.

### Offset carving operation
- Status: Open
- Priority: Medium
- Summary: Add an `Offset Carving` operation that widens a carved line by generating offset passes around open or closed target profiles.
- Notes:
  - Tracked in [planning/OFFSET_CARVING_Implementation_Plan.md](/Users/frankp/Projects/camcam/planning/OFFSET_CARVING_Implementation_Plan.md).
  - Intended as a separate carving mode from `Follow Line`.
  - First pass should support operation-defined width/depth, rough/finish behavior, and open/closed targets.

### Text feature planning
- Status: Open
- Priority: Low
- Summary: Add text features for carving, including skeleton fonts and outline fonts for constant-width carving.
- Notes:
  - This was deferred from the carving first pass.
  - Should integrate with carving operations rather than the solid-model CSG pipeline by default.

### Variable-width V-carve planning
- Status: Open
- Priority: Low
- Summary: Plan a variable-width V-carve mode where depth and width are derived from geometry rather than a fixed offset/follow-line depth.
- Notes:
  - This is a follow-on carving mode, not part of the current follow-line implementation.
  - It likely needs tool-shape-aware path generation rather than just simulation support.

### Follow-line ordering / linking refinement
- Status: Open
- Priority: Low
- Summary: Improve follow-line toolpath ordering and linking across multiple targets to reduce unnecessary jumps and retracts.
- Notes:
  - The current first pass traces targets in target order and retracts conservatively.
  - This should be coordinated with broader linking optimization across CAM operations.

### Multi-depth carving pass strategy
- Status: Open
- Priority: Low
- Summary: Revisit when multi-depth carving passes should be generated automatically and how rough/finish switching should normalize related fields.
- Notes:
  - Current follow-line rough now honors `stepdown`; finish is a single final-depth pass.
  - This should stay aligned with future pass-switch normalization work.

### Operation/simulation responsiveness
- Status: Open
- Priority: Medium
- Summary: Reduce UI lag when switching operations or rebuilding simulation.
- Notes:
  - The main remaining slowdown is in the `Simulation` tab where toolpaths, replay, and mesh generation rebuild together.
  - Likely follow-ups:
    - cache generated toolpaths per operation
    - cache simulation replay by operation set and detail level
    - throttle/debounce simulation rebuild while editing
    - consider moving simulation replay/mesh generation off the main thread

## Done

### Ball endmill / V-bit simulation
- Status: Done
- Summary: Added first-pass simulation support for `ball_endmill` and `v_bit`, including explicit V-bit angle support in the tool model.

### Carving operation with open-profile support
- Status: Done
- Summary: Added `Follow Line` carving with open-profile support plus rough/finish behavior and simulation support.

### Ordered 3D boolean evaluation
- Status: Done
- Summary: 3D preview now applies `add` and `subtract` in feature tree order.

### Two-click feature placement
- Status: Done
- Summary: First click sets anchor, second click sets size, with live preview during placement.

### Left tree / properties / right tabs layout
- Status: Done
- Summary: Feature tree moved left, properties panel added below, right panel now uses `Operations` and `AI Chat` tabs.

### Undo / Redo
- Status: Done
- Summary: Project history supports undo/redo across edits, with keyboard shortcuts wired in the app shell.

### Copy / Duplicate / Move
- Status: Done
- Summary: Features, tabs, and clamps support duplicate/copy/move workflows, including direct manipulation and context-menu entry points.

### G-code Export
- Status: Done
- Summary: Implemented machine-definition-driven post-processor with modal tracking, template substitution, and an Export Dialog featuring machine selection, debounced live preview, and G-code download.

### Machine Origin improvements
- Status: Done
- Summary: Added a persistent machine origin object to the project tree, with full property editing, axis triad visualization in 2D/3D, and quick-set presets (top-left, center-top, bottom-left).
