# Tablet UX Implementation Plan

## Context

This plan is based on a code review of the current shell, responsive CSS, and input handling.
The app is responsive in the narrow sense but not tablet-ready: the layout still compresses a
desktop workflow, and several core interactions assume mouse + keyboard.

Supported tablet target: landscape >= 900–960 px, optimized for 1024–1366 px.
Phones remain blocked (< 900 px).

This is based on code review, not live device testing.

---

## Items

### 1 — Explicit tablet shell layout

**Status:** `[x] done`

**Problem:**
Below 920 px the right panel is pushed under the canvas instead of switching to drawers or
sheets. The app still reserves fixed left/center/right columns tuned for desktop.

**References:**
- `src/styles/layout.css` line 337, line 2296
- `src/App.tsx` line 49
- `src/components/AppShell.tsx` line 94

**Work:**
- Define a `tablet` breakpoint class (landscape >= 900 px) separate from the existing narrow
  desktop fallback.
- Switch right panel to a slide-in drawer or bottom sheet at tablet widths instead of
  reflowing under the canvas.
- Ensure the center canvas always gets the majority of available width.

---

### 2 — Split toolbar into primary and contextual layers

**Status:** `[ ] todo`

**Problem:**
The combined toolbar renders file, view, snap, creation, edit, alignment, and backdrop actions
in one wrapping strip. On tablets this eats vertical space and wraps unpredictably.

**References:**
- `src/components/Toolbar.tsx` line 1252, line 1157
- `src/styles/layout.css` line 40

**Work:**
- Keep file / view / global actions in a persistent top bar.
- Move creation / edit / alignment tools to a contextual rail or bottom sheet that appears
  near the canvas when a sketch is active.
- Backdrop and snap controls can live in a collapsible overflow menu.

---

### 3 — Raise touch targets to 40–44 px

**Status:** `[x] done`

**Problem:**
Current interactive targets are desktop-density: toolbar icons 32 px, tree rows 28 px, tree
action buttons 20 px, properties inputs 32 px, CAM buttons 28–32 px. Too small for reliable
touch.

**References:**
- `src/styles/layout.css` line 165, line 1236, line 1380, line 1476, line 1837, line 1948

**Work:**
- Under the tablet breakpoint, set a CSS custom property `--touch-target: 44px` and apply it
  to toolbar buttons, tree rows, tree action buttons, tab handles, inspector inputs, and CAM
  row buttons.
- Slightly increase font size in trees, tabs, and inspectors at tablet widths.

---

### 4 — Remove mouse-only workflow dependencies

**Status:** `[~] partial`

**Done:**
- Added `triggerDimensionEdit()` function that exposes the Tab-open logic so buttons can call it
- All sketch canvas banners now use clickable `<kbd>` elements for Enter/Esc/Tab actions — banners look identical on desktop, tap-friendly on touch (44 px hit area via `pointer: coarse`)
- Keyboard shortcuts (Enter/Esc/Tab) are fully preserved for desktop users

**Remaining:**
- Pointer event migration (`onMouseDown` → `onPointerDown`)
- Double-click edit entry → explicit Edit button / long-press
- Multi-select modifier key dependency
- Right-click context menus on tree rows → More (…) button

**Problem:**
- Sketch canvas uses `onMouseDown`, `onMouseUp`, `onDoubleClick`, `onContextMenu`.
- Edit entry depends on double-click.
- Multi-select depends on modifier keys (Shift/Ctrl).
- Row actions rely on right-click context menus.

**References:**
- `src/sketch/SketchCanvas.tsx` line 3418, line 1808, line 2667, line 2632
- `src/components/FeatureTree.tsx` line 159, line 168

**Work:**
- Migrate canvas event handlers to pointer events (`onPointerDown`, `onPointerUp`).
- Replace double-click edit entry with an explicit **Edit** button / long-press gesture.
- Add a **Select multiple** toggle mode so multi-select does not require modifier keys.
- Replace right-click context menus on tree rows with a visible **More (…)** action button
  per row.

---

### 5 — Add real touch gestures for sketch, 3D, and simulation

**Status:** `[ ] todo`

**Problem:**
3D and simulation views map pan to middle/right-click or Shift+drag and zoom to the mouse
wheel. Both set `touchAction = 'none'` without providing a touch replacement, so tablets get
no usable navigation.

**References:**
- `src/components/Viewport3D.tsx` line 422, line 657
- `src/components/SimulationViewport.tsx` line 264, line 582

**Work:**
- Implement pinch-to-zoom using `pointermove` distance delta between two active pointers.
- Implement two-finger pan.
- Map one-finger drag to orbit (3D) or canvas pan (sketch).
- Treat pen input as precise edit/select input (no orbit on pen contact).

---

### 6 — Replace drag-only ordering with explicit reorder controls

**Status:** `[ ] todo`

**Problem:**
Feature tree rows and CAM operations rely on HTML drag-and-drop, which is unreliable on touch
and has no fallback.

**References:**
- `src/components/FeatureTree.tsx` line 175
- `src/components/CAMPanel.tsx` line 1039

**Work:**
- Add visible **Move up / Move down** buttons to tree rows and CAM operation rows (shown on
  tablet, hidden or secondary on desktop).
- Keep HTML drag-and-drop as a desktop enhancement, not the only path.

---

### 7 — Reduce persistent chrome and enlarge tiny utility controls

**Status:** `[~] partial`

**Done:**
- Split divider hit area raised to >= 12 px via `padding: 8px 0` under `pointer: coarse`
- Status bar gets `flex-wrap: wrap` and `height: auto` on tablet so it doesn't clip
- Depth legend toggle and statusbar legend raised to 44 px hit area under `pointer: coarse`

**Remaining:**
- Status bar collapsible / auto-hide toggle
- Legend toggles on the sketch canvas (18–20 px) need the same treatment verified on device

**Problem:**
Status bar, legends, and split handles are tuned for desktop density. The split divider is a
3 px bar. Some legend toggles and status controls are 18–20 px — too small for touch.

**References:**
- `src/styles/layout.css` line 1779, line 1108, line 1895

**Work:**
- Make the status bar collapsible or auto-hide on tablet.
- Increase split divider hit area to >= 12 px (visual can stay narrow, hit area via padding).
- Raise legend toggle and status control hit areas to >= 40 px under the tablet breakpoint.

---

## Suggested Implementation Order

1. **Item 1** — Tablet shell layout (unblocks everything else)
2. **Item 3** — Touch target CSS (low risk, high impact, can land early)
3. **Item 4** — Pointer event migration + explicit Edit / More affordances
4. **Item 5** — Touch gestures for 3D and simulation
5. **Item 2** — Toolbar split (depends on shell being stable)
6. **Item 6** — Reorder controls
7. **Item 7** — Chrome reduction and hit area cleanup

---

## Notes

- All changes should be additive under the tablet breakpoint; desktop behavior must not regress.
- Live device testing on an actual tablet should follow each item before it is marked done.
- Pen input (Apple Pencil / stylus) should be validated separately from finger touch.

---

## Phase 2 Prioritization (tracks issue #56)

Phase 1 (PR #53) landed Items 1, 3, and the banner-kbd subset of Item 4. Issue #56 reports
that core interactions — particularly tab-into-distance-editing — are still unreachable on
tablet. Remaining work is re-ordered by user impact and split into five PRs. Each PR is
tablet-tested on device before the next begins.

Note: paths in Items 2–7 predate the feature-tree / canvas / viewport folder refactor. The
Phase 2 sub-items below use current paths.

### Phase 2A — Editing reachability *(addresses #56 directly)*

**Status:** `[~] partial` — landed in `distracted-panini-131628`, awaiting on-device tablet test.

**Goal:** Every edit entry point that today depends on Tab, double-click, or right-click has
a visible, tappable equivalent.

**Done:**
- `pendingAdd` banner gained a clickable **Tab** kbd chip (shown when
  `triggerDimensionEdit()` has something to act on: rect/circle/tab/clamp with anchor,
  polygon/spline with ≥1 point, composite with start set).
- Feature / tab / clamp tree rows gained a pencil **Edit** button that routes through the
  existing `handleEditSketch` / `handleEditTab` / `handleEditClamp` handlers, matching the
  "Edit Sketch" context-menu item.
- Feature / tab / clamp tree rows gained a **⋯ More** button that opens the same context
  menu right-click opens, anchored at the button's bottom-left rect.

**Remaining (follow-up):**
- Sketch-edit mode says "Hover a node and press Tab to type length/angle." — hover has no
  touch equivalent. Needs a tap-a-node-to-arm design so the banner can then show a clickable
  Tab chip for the armed node.
- Sketch dimension labels drawn on the canvas (as opposed to banner chips) still aren't
  tap-targets; the banner path is sufficient for pending operations but dimension-label
  taps would be a nicer future improvement.

**Acceptance:**
- On tablet, a user can enter a distance value for any pending add/move/transform without a
  keyboard. ✓ (pending device test)
- On tablet, every feature-tree row action available via right-click on desktop is reachable
  via tap. ✓ (pending device test)

### Phase 2B — Pointer events in sketch canvas

**Status:** `[ ] todo`

**Work:**
- Migrate `onMouseDown` / `onMouseUp` / `onDoubleClick` / `onContextMenu` on the sketch
  canvas to pointer events; keep mouse-button semantics (button 0 = select, button 2 =
  context) inside the handler.
- Long-press (configurable duration, ~500 ms) as the touch equivalent of right-click for any
  context-menu surface that remains after 2A.
- **Select multiple** mode toggle in the sketch toolbar so multi-select does not require
  Shift/Ctrl. Toggle is sticky until explicitly turned off.

**References:** [SketchCanvas.tsx](src/components/canvas/SketchCanvas.tsx) (look for all
`onMouse*` / `onContextMenu` / `onDoubleClick` props on the root canvas element)

### Phase 2C — 3D and simulation touch gestures

**Status:** `[ ] todo`

**Work:**
- Pinch-to-zoom, two-finger pan, one-finger orbit in
  [Viewport3D.tsx](src/components/viewport3d/Viewport3D.tsx) and
  [SimulationViewport.tsx](src/components/simulation/SimulationViewport.tsx), using
  `pointermove` with active-pointer tracking.
- Pen input (pointerType === 'pen') is treated as a precise pointer — no orbit on contact,
  same semantics as mouse hover + click.
- Remove the unconditional `touchAction = 'none'` once real touch handlers exist; keep it
  only on the gesture region.

### Phase 2D — Reorder controls

**Status:** `[ ] todo`

**Work:**
- Move up / Move down buttons on feature-tree rows and CAM operation rows, visible under
  `pointer: coarse`, secondary on desktop.
- Keep existing HTML drag-and-drop as a desktop enhancement.
- References: [FeatureTree.tsx](src/components/feature-tree/FeatureTree.tsx),
  [CAMPanel.tsx](src/components/CAMPanel.tsx)

### Phase 2E — Toolbar split + chrome cleanup

**Status:** `[ ] todo`

**Work:**
- Split [Toolbar.tsx](src/components/Toolbar.tsx) into a persistent top bar (file / view /
  global) and a contextual rail / bottom sheet (creation / edit / alignment) that appears
  when a sketch is active.
- Backdrop and snap controls move into a collapsible overflow menu.
- Status bar collapsible or auto-hide on tablet.
- Verify sketch-canvas legend toggles hit 44 px on device.

### Phase 2F — Graceful failure on unsupported devices

**Status:** `[x] done` — landed in `distracted-panini-131628`.

Out-of-band item: the tablet discussion surfaced that older desktops and tablets were
hitting a blank screen instead of an error (typically when WebGL context creation fails in
`Viewport3D` / `SimulationViewport` on mount). Rather than commit to a support baseline, we
now capture the failure and show a friendly screen.

**Done:**
- [src/components/errorFormat.ts](src/components/errorFormat.ts) — shared `formatError` +
  `renderErrorHTML` helpers (error message, first 3 stack frames, `navigator.userAgent`,
  timestamp).
- [src/components/ErrorScreen.tsx](src/components/ErrorScreen.tsx) — React component:
  apology, collapsible technical details, Reload / Downloads / Website actions.
- [src/components/AppErrorBoundary.tsx](src/components/AppErrorBoundary.tsx) — classic error
  boundary wrapping `<App />`, catches anything thrown during render / mount.
- [src/main.tsx](src/main.tsx) — `window.error` + `unhandledrejection` listeners installed
  before React mounts. A `reactMounted` flag gates them so they only inject static HTML into
  `#root` when React isn't alive yet; once mounted, the error boundary takes over.
- [src/index.css](src/index.css) — `.app-error-*` styles (red-tinted eyebrow, collapsible
  `<pre>` for tech details, wrap-friendly action row).

**Coverage:**
- WebGL context creation failure in viewport mount → error boundary.
- Missing Web API at init → global listener (pre-mount) or error boundary (post-mount).
- Unhandled promise rejection during startup → `unhandledrejection` listener.
- Late runtime error after app is running → error boundary.

### Suggested PR order

1. Phase 2A — unblocks issue #56
2. Phase 2F — bundled with 2A (one PR)
3. Phase 2B — prerequisite for reliable gestures in 2C
4. Phase 2C
5. Phase 2D
6. Phase 2E
