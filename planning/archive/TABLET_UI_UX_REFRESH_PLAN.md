# Tablet UI/UX Refresh Plan

## Status

`[x]` Superseded. This document is retained as strategic background only. Its architectural
direction has been merged into the combined implementation plan, which is now the source of
truth for tablet work.

Current plan: [TABLET_UX_COMBINED_PLAN.md](TABLET_UX_COMBINED_PLAN.md)

## Goal

Make PureCutCNC usable on 10-inch tablets first, with a credible compact-tablet path for
7-8 inch devices. The product should feel like a CNC workbench: dense, precise, and
task-focused, but not a shrunken desktop app.

The core change is not "make buttons bigger." The app needs a tablet shell with deliberate
command surfaces, drawers, touch gestures, and non-keyboard editing flows.

## Target Devices

### Primary Target: 10-inch Tablet

- Landscape is the main supported orientation.
- CSS viewport target: roughly `900px` to `1199px` wide, `650px+` tall, coarse pointer.
- Expected hardware: iPad 10-inch class, Android 10-inch class, Surface-style touch tablet.
- Required workflows: sketch, edit, define CAM operations, preview, simulate, export.

### Secondary Target: 7-8 inch Tablet

- Landscape only for full editing.
- CSS viewport target: roughly `740px` to `899px` wide, coarse pointer.
- This should use a more focused shell: canvas first, every panel as a drawer or sheet.
- The goal is "usable for focused edits," not full desktop-equivalent productivity.

### Phones

- Continue blocking phone-sized touch layouts for now.
- If we later support phones, that should be a separate read-only/review mode, not this plan.

### Desktop

- Desktop may adopt the same command architecture if it improves clarity.
- Large desktop can still show docked left and right panels.
- Laptop desktop should benefit from the tablet work by reducing toolbar wrapping and chrome.

## Current Problems

### Shell And Layout

- The desktop three-column layout is compressed onto tablet instead of switching modes.
- The right CAM panel is intended to become a drawer, but the drawer opener is not reliable:
  `.tablet-drawer-toggle` is set to `display: inline-flex` inside a media query, then later
  reset to `display: none` with equal specificity.
- Layout preferences such as workspace layout and toolbar orientation are desktop controls,
  but they remain visible in the workspace header on constrained layouts.
- The status bar, legends, tab headers, and side panels permanently consume space that the
  canvas needs.

### Toolbar

- `Toolbar` combines project/file/history/view/snap/creation/edit/alignment/backdrop actions
  into one wrapping strip.
- On tablet this wraps unpredictably and takes vertical space from the canvas.
- Existing `GlobalToolbar` and `CreationToolbar` already point toward the right split, but
  the shell does not consistently select that model for tablet.
- Snap controls occupy seven persistent buttons. These should be a popover on tablet.

### Panels

- The left project tree and properties panel are stacked in a resizable split.
- This works on a large desktop but is cramped on tablet.
- CAM operations and tool library are a right dock on desktop and should be a discoverable
  drawer on tablet.
- There is no clear tablet mental model for "where do I edit this thing?"

### Interaction

- Several core operations still depend on mouse and keyboard patterns: hover, Tab, Esc,
  right-click, double-click, Shift/Ctrl multi-select, and HTML drag-and-drop.
- Sketch, 3D, and simulation navigation need touch-native gestures.
- Stylus input should behave as precise drawing/edit input, not as generic finger navigation.

## Design Principles

1. **Canvas first.** The stock/canvas/preview is the primary workspace. Persistent chrome must
   justify its space.
2. **Modes should be visible.** Sketching, selecting, editing, CAM, simulation, and export
   need obvious entry and exit points.
3. **Commands should be contextual.** Creation and edit tools should live near the canvas and
   appear when useful, not compete with file actions.
4. **No hover-only or keyboard-only paths.** Every primary command must have a touch path.
5. **Drawers over compressed sidebars.** Tablet panels should overlay or slide, not crush the
   workspace.
6. **Keep precision.** Touch UI must not make the CAD/CAM workflow feel vague. Numeric entry,
   snapping, constraints, and exact dimensions remain first-class.
7. **Desktop should not be sacred.** If the tablet shell clarifies the product, apply the same
   architecture to desktop with larger/docked variants.

## Proposed Product Model

### App Regions

The app should be organized around stable regions:

- **Top command bar:** project name, save state, file actions, undo/redo, workspace view tabs,
  zoom controls, export/open operations entry.
- **Left tool rail:** sketch creation, feature/region target toggle, selection/edit commands,
  and contextual tools for the active mode.
- **Canvas stage:** sketch/3D/simulation surface with lightweight overlay controls.
- **Left drawer:** Project Tree and Properties, shown as tabs or a sheet depending on width.
- **Right drawer:** Operations and Tools, with a persistent and discoverable opener.
- **Bottom strip:** compact status, coordinate/readout, active command confirmation/cancel,
  and optional warnings. This replaces the current always-on full status row on tablet.

### Tablet Navigation Model

On tablet, a user should be able to answer these questions immediately:

- What am I editing? Shown in the active context header or bottom strip.
- What can I do now? Shown in the left tool rail and active command strip.
- Where are operations? Persistent `Operations` button with count, not a hidden `CAM` button.
- How do I close a panel? Obvious close button, scrim tap, and optional edge handle.
- How do I enter exact values? Tap dimension label or a visible numeric chip, not Tab.

## Breakpoint Strategy

Use layout classes from JS, not only scattered CSS media queries. Suggested shell modes:

```ts
type ShellMode =
  | 'desktop-wide'
  | 'desktop-compact'
  | 'tablet'
  | 'tablet-compact'
  | 'unsupported-phone'
```

Suggested detection inputs:

- `window.innerWidth`
- `window.innerHeight`
- `matchMedia('(pointer: coarse)')`
- `matchMedia('(hover: none)')`
- optional user override for testing

Suggested behavior:

| Mode | Conditions | Shell |
| --- | --- | --- |
| `desktop-wide` | `>= 1400px`, pointer fine | docked left, center, right; split toolbar optional |
| `desktop-compact` | `1100-1399px`, pointer fine | docked or collapsible side panels; split toolbar preferred |
| `tablet` | `900-1199px`, pointer coarse | left tool rail, drawers for tree/properties/CAM, compact top bar |
| `tablet-compact` | `740-899px`, pointer coarse | canvas-first focus mode, bottom tool sheet, all panels drawers |
| `unsupported-phone` | `< 740px`, pointer coarse | blocked or read-only fallback |

Avoid `max-width: 960px` as the only tablet trigger. A 10-inch tablet can be wider than that,
and a desktop browser can be narrower than that.

## Phased Work

### Phase 0 - UX Inventory And Shell Contract

**Goal:** Define the workflows and layout contract before changing UI.

**Work:**

- Inventory the primary workflows:
  - create project
  - import geometry
  - create/edit sketch feature
  - exact dimension entry
  - create region
  - create tabs/clamps
  - create CAM operation
  - preview toolpath
  - simulate
  - export G-code
- Document every command that currently depends on hover, keyboard, right-click, double-click,
  modifier keys, or drag-and-drop.
- Add a shell mode helper, initially read-only, that reports `desktop-wide`,
  `desktop-compact`, `tablet`, `tablet-compact`, or `unsupported-phone`.
- Add a temporary debug readout behind `import.meta.env.DEV` so shell mode can be verified on
  real devices.
- Create a screenshot matrix for:
  - 1440x900 desktop
  - 1280x800 laptop
  - 1024x768 10-inch tablet landscape
  - 820x1180 tablet portrait, informational only
  - 800x600 compact tablet landscape

**Files likely touched:**

- `src/App.tsx`
- `src/components/layout/AppShell.tsx`
- `src/styles/tablet.css`
- optional new `src/components/layout/useShellMode.ts`

**Acceptance:**

- No visual redesign yet.
- The app can reliably identify tablet and compact-tablet modes.
- We have a written command inventory for touch-blocked workflows.

### Phase 1 - Tablet Shell Foundation

**Goal:** Stop compressing the desktop app onto tablet.

**Work:**

- Refactor `AppShell` around named regions:
  - top command bar
  - left command rail
  - center stage
  - left drawer/sheet
  - right drawer/sheet
  - bottom status/action strip
- Fix the tablet right drawer opener. Replace hidden `CAM` with a persistent
  `Operations` control that includes the operation count when available.
- On tablet, remove workspace layout and toolbar orientation controls from the workspace
  header. These are desktop configuration controls.
- Make the right drawer usable and discoverable:
  - clear `Operations` / `Tools` tabs
  - close button
  - scrim tap
  - optional right-edge reopen handle
- Keep desktop behavior mostly intact during this phase, but route tablet through the new
  shell regions.

**Files likely touched:**

- `src/components/layout/AppShell.tsx`
- `src/App.tsx`
- `src/styles/layout.css`
- `src/styles/tablet.css`

**Acceptance for 10-inch tablet:**

- There is an obvious way to open Operations.
- Closing Operations leaves an obvious way to reopen it.
- Canvas is not squeezed by a right dock.
- Workspace layout/orientation controls are not visible in tablet mode.

### Phase 2 - Command Bar And Tool Rail Redesign

**Goal:** Replace the one-strip toolbar with purpose-built command surfaces.

**Work:**

- Split toolbar architecture into:
  - `TopCommandBar`
  - `ToolRail`
  - `CommandPopover`
  - optional `CommandSheet` for compact tablet
- Top command bar contains:
  - project name
  - save state
  - New/Open/Import/Save
  - Undo/Redo
  - workspace tabs: Sketch, 3D, Simulation
  - Zoom/Fit
  - Operations entry
- Left tool rail contains:
  - selection tool
  - feature/region target toggle
  - rectangle/circle/ellipse/polygon/spline/composite/text
  - selected-feature transform actions
  - sketch-edit tools when in edit mode
- Move snap modes into a popover:
  - top-level snap enabled button
  - grid/point/line/midpoint/center/perpendicular inside popover
  - active snap mode indicator on the snap button
- Move alignment/distribution into contextual popovers shown only when multi-selection makes
  them valid.
- On compact tablet, use a bottom `CommandSheet` instead of a permanent left rail if the rail
  would leave too little canvas.

**Files likely touched:**

- `src/components/layout/Toolbar.tsx`
- new `src/components/layout/TopCommandBar.tsx`
- new `src/components/layout/ToolRail.tsx`
- new `src/components/layout/CommandPopover.tsx`
- `src/styles/layout.css`
- `src/styles/tablet.css`

**Acceptance:**

- At 1024x768 tablet landscape, the top bar is one row.
- Creation and edit tools do not wrap.
- Snap controls do not permanently occupy seven button widths.
- Desktop can optionally use the same split toolbar if it improves laptop layout.

### Phase 3 - Panel System Refresh

**Goal:** Make project structure, properties, operations, and tools accessible without
permanent side-panel pressure.

**Work:**

- Replace tablet left stacked split with a drawer containing tabs:
  - Project
  - Properties
- Add explicit open buttons:
  - `Project` or tree icon for the left drawer
  - `Properties` shown when a selection exists
  - `Operations` with count for the right drawer
- In tablet mode, opening a tree row should expose relevant actions without requiring the
  properties panel to always be visible.
- In CAM drawer:
  - keep Operations and Tools tabs
  - make Add/Export persistent in the drawer header
  - ensure row actions are 44px hit targets
  - keep selected operation properties in the same drawer, either below the list or as a
    secondary detail sheet
- In desktop mode, decide whether to keep current docked panels or adopt the same drawer
  model with dock/undock capability.

**Files likely touched:**

- `src/components/layout/AppShell.tsx`
- `src/components/feature-tree/FeatureTree.tsx`
- `src/components/feature-tree/PropertiesPanel.tsx`
- `src/components/cam/CAMPanel.tsx`
- `src/styles/layout.css`
- `src/styles/tablet.css`

**Acceptance:**

- On 10-inch tablet, the canvas can be used with no side panels open.
- The user can still open Project, Properties, Operations, and Tools with one tap.
- The Operations drawer is self-contained enough to create and edit an operation.

### Phase 4 - Touch Editing Reachability

**Goal:** Remove mouse and keyboard dependencies from sketch and tree editing.

**Work:**

- Migrate sketch canvas interaction from mouse events to pointer events.
- Define pointer semantics:
  - mouse keeps desktop behavior
  - finger uses touch gestures and larger hit targets
  - pen uses precise draw/select/edit behavior
- Add explicit multi-select mode:
  - visible toggle in tool rail or bottom strip
  - stays on until turned off
  - supports tap-to-add/remove selection
- Replace hover-plus-Tab dimension entry:
  - tap a dimension label or selected segment to show a numeric chip
  - chip opens the existing dimension input
  - keep keyboard Tab as desktop shortcut
- Replace right-click and double-click-only paths:
  - visible More buttons in rows
  - explicit Edit actions for selected features/tabs/clamps
  - optional long-press context menu as secondary, not primary
- Add drag-and-drop fallbacks:
  - Move up/down buttons for feature rows
  - Move up/down buttons for CAM operations

**Files likely touched:**

- `src/components/canvas/SketchCanvas.tsx`
- `src/components/feature-tree/FeatureTree.tsx`
- `src/components/cam/CAMPanel.tsx`
- `src/store/projectStore.ts`
- `src/store/slices/selectionSlice.ts`
- `src/styles/layout.css`
- `src/styles/tablet.css`

**Acceptance:**

- A tablet user can create and dimension a rectangle without a keyboard.
- A tablet user can edit a selected feature without double-clicking.
- A tablet user can multi-select without Shift/Ctrl.
- A tablet user can reorder features and operations without drag-and-drop.

### Phase 5 - Canvas, 3D, And Simulation Gestures

**Goal:** Make every viewport navigable on touch.

**Work:**

- Sketch canvas:
  - one finger: active tool input or selection
  - two fingers: pan
  - pinch: zoom around midpoint
  - optional two-finger tap: zoom to model or undo only if tested and intentional
- 3D viewport:
  - one finger: orbit
  - two fingers: pan
  - pinch: zoom
  - double tap or fit button: zoom to model
- Simulation viewport:
  - match 3D gestures
  - make playback controls touch-sized and avoid covering the model
- Do not rely on `touchAction = 'none'` without matching pointer handlers. Use it only on
  active gesture regions.
- Add gesture conflict rules for stylus:
  - pen contact edits/selects
  - finger gesture navigates
  - simultaneous pen plus finger should not corrupt active sketch state

**Files likely touched:**

- `src/components/canvas/SketchCanvas.tsx`
- `src/components/viewport3d/Viewport3D.tsx`
- `src/components/simulation/SimulationViewport.tsx`
- `src/components/canvas/viewTransform.ts`
- `src/styles/layout.css`

**Acceptance:**

- 3D and simulation can be panned, zoomed, and rotated without mouse wheel or modifier keys.
- Sketch canvas can be zoomed and panned without exiting the active tool unexpectedly.
- Gestures are tested on real tablet hardware, not only desktop emulation.

### Phase 6 - Tablet Workflow Polish

**Goal:** Make the common CAD/CAM flow feel coherent, not just technically reachable.

**Work:**

- Add an active command strip:
  - current tool or operation
  - primary confirmation action
  - cancel action
  - numeric entry shortcut when available
- Make selection state obvious:
  - selected feature name
  - selected operation name
  - lock/visibility status
- Improve operation creation flow:
  - target selection is clear
  - tool selection is accessible in drawer
  - warnings are visible but not permanently blocking canvas
- Make import workflow tablet-friendly:
  - import dialog touch targets
  - post-import "fit to model" and "create operation" affordances
- Review all dialogs for 10-inch and compact tablet dimensions.

**Files likely touched:**

- `src/components/layout/AppShell.tsx`
- `src/components/project/ImportGeometryDialog.tsx`
- `src/components/project/NewProjectDialog.tsx`
- `src/components/project/TextToolDialog.tsx`
- `src/components/export/ExportDialog.tsx`
- `src/components/cam/CAMPanel.tsx`
- `src/styles/dialog.css`
- `src/styles/tablet.css`

**Acceptance:**

- The end-to-end path from sketch to G-code export can be completed on a 10-inch tablet.
- Dialogs fit without clipped controls.
- The user always has a visible way to confirm or cancel an active command.

### Phase 7 - Compact Tablet Mode

**Goal:** Support 7-8 inch tablets without pretending they are desktops.

**Work:**

- Add `tablet-compact` shell mode.
- Use a canvas-first focus layout:
  - top bar reduced to project/view/operations
  - no permanent left panel
  - tools in a bottom sheet or collapsible rail
  - Project/Properties/Operations all drawers or full-height sheets
- Reduce simultaneous panel count:
  - only one drawer/sheet open at a time
  - opening Operations closes Project/Properties
  - active command strip remains available
- Define portrait behavior:
  - either show rotate-device hint for full editing
  - or allow review/simple selection only

**Acceptance:**

- At 800x600 landscape, the user can select, inspect, make small edits, and open Operations.
- Full CAM editing is possible, but not optimized.
- No view relies on horizontal scrolling for primary controls.

### Phase 8 - Desktop Harmonization

**Goal:** Avoid maintaining two unrelated apps.

**Work:**

- Decide which tablet shell improvements become desktop defaults:
  - split top command bar and tool rail
  - snap popover
  - Operations opener with count
  - dockable drawers instead of fixed right panel
- Remove or simplify old preferences if they are now redundant:
  - toolbar orientation
  - workspace layout presets
- Keep desktop-specific advantages:
  - keyboard shortcuts
  - hover tooltips
  - right-click context menus as enhancements
  - docked multi-panel layouts for wide displays

**Acceptance:**

- Desktop is not worse than before on a full-size MacBook Pro.
- Laptop desktop gains vertical space and avoids toolbar wrapping.
- Tablet and desktop share component architecture.

### Phase 9 - QA, Rollout, And Regression Protection

**Goal:** Make tablet support testable and maintainable.

**Work:**

- Add a manual test script in `planning/` or `docs/` for:
  - 10-inch tablet landscape
  - compact tablet landscape
  - desktop full-size
  - laptop desktop
- Add Playwright or screenshot checks if the project already has a path for browser tests.
  If not, document a repeatable Chrome DevTools screenshot workflow.
- Add smoke tests for shell mode helper.
- Add CSS regression checks where practical:
  - top bar does not wrap at 1024x768 tablet
  - Operations opener visible when right drawer hidden
  - side panels hidden/drawer in tablet mode
- Run `npm run build` before merging each implementation PR.

**Acceptance:**

- Every phase has before/after screenshots.
- Tablet work cannot regress into a hidden Operations drawer again.
- Build passes before every merge.

## Suggested PR Breakdown

1. **PR 1: Shell mode helper and drawer opener fix**
   - Add shell mode detection.
   - Fix hidden tablet drawer opener.
   - Rename/reposition opener to `Operations`.
   - No broad visual redesign yet.

2. **PR 2: Top command bar and tool rail**
   - Introduce split command surfaces.
   - Tablet uses split layout.
   - Desktop can keep existing combined toolbar behind a transition flag if needed.

3. **PR 3: Tablet panel drawers**
   - Left Project/Properties drawer.
   - Right Operations/Tools drawer cleanup.
   - Remove tablet-visible desktop layout controls.

4. **PR 4: Touch editing reachability**
   - Pointer event migration.
   - Multi-select mode.
   - Dimension entry touch path.
   - More/Edit buttons audited.

5. **PR 5: Touch gestures**
   - Sketch pan/zoom.
   - 3D orbit/pan/pinch.
   - Simulation pan/pinch.

6. **PR 6: Compact tablet mode**
   - Bottom command sheet.
   - Single drawer/sheet policy.
   - 7-8 inch landscape pass.

7. **PR 7: Desktop harmonization**
   - Apply the improved command architecture to desktop where appropriate.
   - Remove redundant shell controls if they no longer carry their weight.

## Non-Goals For This Plan

- Phone editing support.
- A new visual brand or marketing-style redesign.
- Replacing the CAD/CAM engine or data model.
- Introducing a UI component library.
- Rewriting Zustand state architecture.

## Engineering Notes

- All project mutations still go through `src/store/projectStore.ts`.
- Keep React components typed; do not introduce `any`.
- Prefer component-level shell state over global store state unless the state is part of the
  project data or must persist across sessions.
- Use CSS variables for tablet dimensions:
  - `--touch-target: 44px`
  - `--tool-rail-width`
  - `--drawer-width`
  - `--bottom-strip-height`
- Avoid making tablet behavior depend on CSS order alone. Shell mode should be explicit in
  the DOM, for example `data-shell-mode="tablet"`.
- Keep keyboard shortcuts on desktop, but never make them the only path.

## Open Decisions

- Should 10-inch tablet portrait be supported for editing, or show a rotate-device prompt?
- Should desktop adopt the tool rail by default, or keep it as an optional layout at first?
- Should left Project/Properties be a drawer, a bottom sheet, or dockable tabs on 10-inch
  tablets?
- Should compact tablet support CAM operation editing, or only operation review and export?
- Should shell mode be user-overridable from settings for testing and accessibility?

## Definition Of Done

Tablet support is done when all of these are true on a real 10-inch tablet:

- The app opens into a usable canvas-first layout.
- The Operations panel is discoverable, opens, closes, and reopens.
- Sketch tools are reachable without toolbar wrapping.
- Exact dimension entry works without a hardware keyboard.
- Multi-select works without modifier keys.
- Feature/tree/CAM row actions work without right-click.
- Reordering works without drag-and-drop.
- Sketch, 3D, and simulation can be navigated with touch gestures.
- Export can be completed without switching to desktop.
- Desktop full-size layout remains professional and at least as efficient as before.
