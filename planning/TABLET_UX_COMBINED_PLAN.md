# Tablet UX — Combined Implementation Plan

## Context

The app is non-functional on iPad — the sketch canvas doesn't respond to touch at all. CSS responsive foundations exist (right panel drawer, 44px touch targets, status bar wrapping — Phase 1/PR #53), and Phase 2A added Edit/More buttons and clickable kbd chips. But core interactions are still mouse+keyboard only.

Two prior plans exist:
- **[TABLET_UX_Implementation_Plan.md](TABLET_UX_Implementation_Plan.md)** — incremental bug inventory, items 2B-2E remain
- **[TABLET_UI_UX_REFRESH_PLAN.md](TABLET_UI_UX_REFRESH_PLAN.md)** — holistic redesign from Codex (shell modes, toolbar split, 9 phases)

This plan synthesizes both. It adopts the Codex plan's architectural ideas (shell mode
system, toolbar split, canvas-first principle) but sequences them pragmatically into 4 PRs
instead of 7, with implementation-level detail.

This revision also incorporates a review pass:
- Operations discoverability must land immediately, not as late polish.
- Pointer conversion and gestures should not be bundled into one high-risk mega-change.
- Touch controls should be named by user intent, not by keyboard shortcuts.
- 7-8" tablets and desktop harmonization can be implemented later, but their architectural
  constraints must influence the shell from PR 1.

**Target:** iPad-class tablets (10"+), landscape primary, 1024px+ width.
**Secondary target:** 7-8" tablets, landscape, canvas-first compact shell.
**User decisions:** Left panel -> collapsible drawer. Keyboard shortcuts -> touch command
surfaces. Phased PRs. Desktop can change if the tablet architecture is better.

---

## Cross-Cutting UX Rules

These rules apply to every PR:

- The canvas must remain the primary surface on tablet.
- The Operations drawer must always have a visible opener when closed.
- Keyboard shortcuts can remain, but they cannot be the only path for primary actions.
- Tablet buttons should use intent labels/icons: `Dimension`, `Line`, `Arc`, `Spline`,
  `Confirm`, `Cancel`, `Lock X/Y`, not raw keyboard labels like `Tab`, `L`, `A`, `S`.
- Double-click, right-click, hover, modifier keys, and drag-and-drop are desktop
  enhancements only.
- A 7-8" compact shell is not implemented first, but new components must be able to move
  from a left rail into a bottom command sheet later.
- Desktop should not be protected from improvement. If the split command model is clearer,
  laptop/desktop can adopt it in a later phase.

---

## PR 1 — Shell mode + drawer discoverability + basic pointer conversion

**Goal:** The app knows what shell mode it is in, the Operations drawer is discoverable, and
the sketch canvas receives pointer events on touch. This PR should be small enough to review
without also introducing full gesture behavior.

### 1a. Shell mode system

**New file:** `src/components/layout/useShellMode.ts`

Adopting from the Codex plan — a single source of truth for device class, replacing scattered media queries:

```ts
type ShellMode = 'desktop-wide' | 'desktop-compact' | 'tablet' | 'tablet-compact'
```

Detection inputs: `window.innerWidth`, `matchMedia('(pointer: coarse)')`, `matchMedia('(hover: none)')`. Returns a reactive value (re-evaluates on resize). Sets `data-shell-mode` attribute on the app shell root, enabling CSS to target `[data-shell-mode="tablet"]` instead of fragile `@media` combinations.

Breakpoints (from Codex plan, adjusted):
| Mode | Width | Pointer |
|------|-------|---------|
| `desktop-wide` | ≥1400px | fine |
| `desktop-compact` | 1100-1399px | fine |
| `tablet` | ≥900px | coarse |
| `tablet-compact` | 740-899px | coarse |

Phone (<740px coarse) remains blocked by existing `main.tsx` check. Keep the compact-tablet
mode even if it initially maps to the same UI as `tablet`; this prevents 10" assumptions
from leaking into the shell API.

Add dev-mode debug readout (`import.meta.env.DEV` only) showing current shell mode.

### 1b. Set shell mode on the app shell

**File:** `src/components/layout/AppShell.tsx`

- Consume `useShellMode`.
- Set `data-shell-mode` on `.app-shell`.
- Use shell mode to drive tablet behavior instead of only CSS media queries.
- Keep existing media queries as fallback during migration.

### 1c. Operations drawer discoverability

**Files:** `src/components/layout/AppShell.tsx`, `src/styles/tablet.css`

Fix the current right drawer opener immediately:
- The existing `.tablet-drawer-toggle` rule is hidden by a later equal-specificity
  `display: none`; correct the CSS order/specificity.
- Rename the opener from `CAM` to `Operations`.
- Include operation count when available, e.g. `Operations 4`.
- Keep the opener visible whenever the right panel is hidden in tablet/tablet-compact modes.
- Put the opener in a predictable top command area or workspace header, not at the end of a
  wrapping toolbar.
- Keep close button, scrim tap, and `Escape` close behavior.

This is not polish. If the drawer can close and cannot obviously reopen, the app is broken.

### 1d. Basic pointer event migration in SketchCanvas.tsx

**File:** `src/components/canvas/SketchCanvas.tsx`

The canvas (line 3964-3974) uses `onMouseDown`, `onMouseUp`, `onMouseLeave` — these don't fire on touch. `onClick`, `onDoubleClick`, `onContextMenu` already work on touch.

Changes:
- **`onMouseDown` → `onPointerDown`**: Rename `handleMouseDown` (line 2107) → `handlePointerDown`, param type → `React.PointerEvent<HTMLCanvasElement>`. All `event.button`/`event.shiftKey` checks remain valid. Add `setPointerCapture(event.pointerId)` for touch drags.
- **`onMouseUp` → `onPointerUp`**: Rename `handleMouseUp` (line 2566) → `handlePointerUp`, add `releasePointerCapture`. Add `onPointerCancel` wired to same handler.
- **`onMouseLeave` → `onPointerLeave`**: Rename `handleMouseLeave` (line 2636) → `handlePointerLeave`.
- **Import**: Update `type { MouseEvent }` (line 18) to include `PointerEvent`.
- Keep `onClick`, `onDoubleClick`, `onKeyDown`, `onContextMenu` unchanged.

Important constraint: do not rely on `onDoubleClick` or `onContextMenu` as primary tablet
interaction. This PR can keep them for compatibility, but later PRs must add visible touch
alternatives.

### 1e. Minimal touch panning

Currently pan requires Shift+click or middle/right button (line 2125-2126). For touch in `handlePointerDown`:
- When `event.pointerType === 'touch'` and no pending operation active, start panning immediately if no control/feature/clamp/tab is hit. Matches CAD tablet convention — tap selects, drag on empty pans.
- When a feature IS hit, proceed with normal logic.

### 1f. CSS foundation

**File:** `src/styles/layout.css` — Add `touch-action: none` to `.sketch-canvas`
**File:** `src/styles/tablet.css` — Migrate existing `@media (pointer: coarse)` rules to also support `[data-shell-mode="tablet"]` / `[data-shell-mode="tablet-compact"]` selectors (keep media queries as fallback for now, add attribute selectors as progressive enhancement).

### Files modified
- `src/components/canvas/SketchCanvas.tsx` — pointer events and minimal touch pan
- `src/components/layout/useShellMode.ts` — **new**, shell mode detection
- `src/components/layout/AppShell.tsx` — consume `useShellMode`, set `data-shell-mode` attribute
- `src/components/layout/Toolbar.tsx` if needed for opener placement
- `src/styles/layout.css` — `touch-action: none` on canvas
- `src/styles/tablet.css` — drawer opener fix and attribute selector support alongside media queries

### Verification
- iPad Safari: tap features to select, single-finger drag on empty pans
- Operations button visible when the right drawer is closed
- Operations drawer opens, closes, and reopens
- Apple Pencil: precise pointer, no accidental pan when touching a feature/control
- Desktop mouse: zero regression

---

## PR 2 — Sketch touch gestures + tablet command bar

**Goal:** Sketching and editing are actually usable on touch. Add pinch/pan gestures,
long-press as a secondary context-menu path, and a touch command bar with intent-based
actions.

### 2a. Pinch-to-zoom + two-finger pan

**New file:** `src/sketch/useCanvasGestures.ts`

Hook that:
- Tracks active touch pointers in `Map<number, {x, y}>`
- On two active pointers: computes center + distance, calculates delta for zoom (calls
  existing `setViewState`) and delta-center for pan
- Exposes `isGestureActive` ref so `handlePointerDown` skips single-pointer logic when the
  second finger lands
- Only tracks `pointerType === 'touch'` — mouse and pen pass through
- Attaches near the existing native `pointermove` listener (line 1804)

### 2b. Long-press context menu

In `handlePointerDown` for touch: start 500ms timer. If finger doesn't move >10px and
doesn't lift, open the same context menu as right-click. Cancel on move/up.

Long-press is a secondary path. Primary tablet actions must still be visible buttons.

### 2c. Floating tablet command bar

**Files:** `src/components/canvas/SketchCanvas.tsx` (JSX), `src/styles/tablet.css`

Context-sensitive floating bar, bottom-right of canvas, visible only in tablet shell modes.
Use the same callbacks already wired to existing `<kbd>` banner chips where possible, but do
not expose keyboard names as the primary UI.

Buttons by context:
| Context | Buttons |
|---------|---------|
| Composite drawing | **Line** / **Arc** / **Spline** mode buttons, **Undo point** |
| Polygon/spline drawing | **Undo point** |
| Any pending op | **Confirm**, **Cancel** |
| Sketch edit mode | **Dimension** when a node/segment is armed |
| Spatial operation (move/transform/drag) | **Axis lock** cycle button with X/Y state |
| Feature selection | **Multi-select** toggle |

Keyboard hints can appear in tooltips or secondary labels on desktop, but the visible tablet
commands should describe intent.

### 2d. Multi-select mode

Local `multiSelectMode` boolean in SketchCanvas. When true, taps in `handleClick` act as if `event.shiftKey` were true. Toggle in floating action bar. Auto-enabled during shape actions (Join/Cut).

Update banner text: "Shift-click" → "Tap" when in tablet shell mode.

### 2e. Axis lock toggle

**File:** `src/sketch/useAxisLock.ts`

Export `cycleLock` from the hook (the function `cycleLockMode` at line 78 already exists but the hook doesn't expose an imperative trigger):
```ts
const cycleLock = useCallback(() => {
  lockModeRef.current = cycleLockMode(lockModeRef.current)
  onLockChangeRef.current?.()
}, [])
```

Wire to action bar button. Display current mode with `lockModeGuideColor` coloring.

### 2f. Tap-to-arm nodes (sketch edit hover replacement)

Banner says "Hover a node and press Tab" — hover doesn't exist on touch.

In `handlePointerDown` when `pointerType === 'touch'` and a control is hit:
- Don't immediately start drag. Record potential drag start.
- In `handleCanvasPointerMove`: if move >5px, begin drag normally.
- In `handlePointerUp`: if <5px (no drag), treat as "tap-to-arm" — set `hoveredEditControl`, making Tab action bar button active.

### Files modified
- `src/components/canvas/SketchCanvas.tsx` — gesture integration, command bar JSX, multi-select, tap-to-arm
- `src/sketch/useCanvasGestures.ts` — **new**, pinch-to-zoom + two-finger pan
- `src/sketch/useAxisLock.ts` — expose `cycleLock`
- `src/styles/tablet.css` — command bar styles

### Verification
- Action bar buttons work for all pending operations
- Composite Line/Arc/Spline switch drawing modes
- Multi-select toggle: enable, tap features, accumulate selection
- Axis lock: during move, tap button, verify constraint + guide color
- Tap-to-arm: in sketch edit, tap node (don't drag), Tab button activates, tap it, dimension input opens
- Two-finger pinch zooms around midpoint
- Two-finger pan moves the sketch view
- Long-press opens context menu, but all primary context actions are also reachable via buttons
- Desktop: no regression

---

## PR 3 — Toolbar split + left drawer + command surfaces

**Goal:** Replace the wrapping one-strip toolbar with purpose-built command surfaces and
move left-side chrome into a tablet drawer.

### 3a. Top command bar

**New file:** `src/components/layout/TopCommandBar.tsx`

Contains: project name, save state, New/Open/Import/Save, Undo/Redo, workspace view tabs (Sketch/3D/Simulation), Zoom/Fit, Operations opener (with count).

On tablet: single non-wrapping row. Tight spacing, icon-only where possible, text labels for view tabs.

### 3b. Tool rail

**New file:** `src/components/layout/ToolRail.tsx`

Contains: selection tool, feature/region target toggle, creation tools (rect/circle/ellipse/polygon/spline/composite/text), edit tools (move/rotate/resize/mirror/offset/fillet/join/cut), alignment/distribution (shown only on multi-select).

On tablet: vertical left rail (48px wide) for 10" class layouts. The component must also be
able to render as a bottom command sheet later for 7-8" compact tablets.

On desktop: keep the current combined toolbar initially, but build `ToolRail` without
tablet-only assumptions so desktop can adopt it later.

### 3c. Snap popover

**New file:** `src/components/layout/SnapPopover.tsx`

Replace 7 persistent snap buttons with: one snap-enabled toggle button + popover showing grid/point/line/midpoint/center/perpendicular options. Active snap mode indicator on the toggle button.

### 3d. Wire into AppShell

**File:** `src/components/layout/AppShell.tsx`

In tablet shell modes, render `TopCommandBar` + `ToolRail` instead of the combined `Toolbar`. Desktop keeps current combined toolbar (can adopt split layout later in harmonization phase).

### 3e. Left panel drawer

**Files:** `src/components/layout/AppShell.tsx`, `src/styles/tablet.css`

Mirror the existing right panel drawer pattern:
- `leftDrawerOpen` state
- `data-left-open` attribute on `.app-shell`
- Left scrim element
- Tree/Project toggle button in the top command bar
- Close button inside left panel header

CSS: `.panel-left` becomes `position: fixed; inset: 0 auto 0 0; width: min(300px, 85vw);
transform: translateX(-100%)` in tablet modes. Grid drops the left panel column; center
fills the available width except for the tool rail.

The drawer should expose Project and Properties either as:
- the current stacked split for this PR, or
- tabbed Project / Properties if the stacked split is too cramped.

### 3f. Remove tablet-visible desktop controls

On tablet, hide workspace layout controls (lcr/lc/c/cr buttons) and toolbar orientation controls — these are desktop configuration that doesn't apply when the shell mode drives layout.

### Files modified
- `src/components/layout/TopCommandBar.tsx` — **new**
- `src/components/layout/ToolRail.tsx` — **new**
- `src/components/layout/SnapPopover.tsx` — **new**
- `src/components/layout/AppShell.tsx` — conditional rendering by shell mode
- `src/components/feature-tree/FeatureTree.tsx` if drawer header/action wiring needs it
- `src/styles/tablet.css` — top bar, tool rail, snap popover styles
- `src/styles/layout.css` — grid adjustments for tool rail column

### Verification
- iPad 1024x768: top bar is one non-wrapping row
- Creation and edit tools don't wrap (they're in the vertical rail)
- Snap controls: one button, popover shows all options
- Left drawer: hidden by default, toggle opens, scrim closes, Project/Properties are usable
- Desktop: existing toolbar unchanged
- All tool selections, snap modes, file operations work

---

## PR 4 — Reorder controls + 3D/simulation gestures + workflow polish

**Goal:** Remaining desktop-only patterns get touch alternatives, all viewports are
navigable by touch, and the end-to-end tablet workflow is credible.

### 4a. Reorder controls

**Files:** `src/components/feature-tree/FeatureTree.tsx`, `src/components/cam/CAMPanel.tsx`

Move Up / Move Down buttons on feature rows and CAM operation rows. Visible in tablet shell mode, hidden on desktop. Keep HTML drag-and-drop as desktop enhancement.

### 4b. Dialog audit

Review all dialogs for 10" tablet dimensions:
- `src/components/project/ImportGeometryDialog.tsx`
- `src/components/project/NewProjectDialog.tsx`
- `src/components/project/TextToolDialog.tsx`
- `src/components/export/ExportDialog.tsx`

Ensure touch targets, no clipping, scrollable content areas.

### 4c. 3D and simulation touch gestures

**Files:** `src/components/viewport3d/Viewport3D.tsx`,
`src/components/simulation/SimulationViewport.tsx`

Implement explicit touch gestures:
- One finger: orbit in 3D/simulation.
- Two fingers: pan.
- Pinch: zoom.
- Fit button remains available as a visible recovery action.
- Pen input should behave as precise pointer input, not camera orbit.

Do not treat sketch gestures as sufficient for 3D/simulation. These viewports have their own
camera state and need their own acceptance tests.

### 4d. Operations drawer polish

Operations discoverability lands in PR 1. This PR polishes the drawer:
- operation count badge styling
- active operation summary
- warning visibility
- Add/Export placement in drawer header
- row action hit targets

### 4e. Status bar compact mode

On tablet, status bar auto-collapses to a single-line readout. Tap to expand full status. Saves ~20px vertical space.

### 4f. Compact tablet and desktop check

No full compact-tablet implementation yet, but this PR should verify:
- at 800x600 landscape, the app does not have unrecoverable hidden controls
- the new command surfaces can be moved into a bottom sheet later
- desktop MacBook layout remains at least as usable as before

### Files modified
- `src/components/feature-tree/FeatureTree.tsx` — reorder buttons
- `src/components/cam/CAMPanel.tsx` — reorder buttons, operations badge
- `src/components/viewport3d/Viewport3D.tsx` — touch gestures
- `src/components/simulation/SimulationViewport.tsx` — touch gestures
- Dialog files — touch target audit
- `src/components/layout/AppShell.tsx` — drawer polish/status strip if needed
- `src/styles/tablet.css` — reorder buttons, status bar compact, operations badge

### Verification
- Reorder: move up/down buttons work on tablet
- Dialogs: all fit and usable at 1024x768
- Operations button: labeled, shows count, always visible
- 3D: one-finger orbit, two-finger pan, pinch zoom
- Simulation: one-finger orbit, two-finger pan, pinch zoom
- 800x600 landscape smoke pass: no unrecoverable controls
- Desktop full-size MacBook screenshot: no major regression
- End-to-end: create project → draw features → set dimensions → create operation → simulate → export G-code — all completable on iPad without keyboard

---

## Critique of both source plans

### Codex plan — what we're adopting
- Shell mode system (PR 1) — much better than scattered media queries
- Toolbar split (PR 3) — the wrapping toolbar is a real usability issue
- Snap popover — 7 buttons to 1 is a clear win
- Operations discoverability — "Operations" with count > hidden "CAM" button
- Canvas-first principle — guides every layout decision

### Codex plan — what we're deferring
- **Full Phase 0 inventory** — keep a lightweight command inventory inside each PR instead
  of making it a standalone phase.
- **Full compact tablet implementation** — premature until 10" is solid, but the shell API
  must include `tablet-compact` from PR 1.
- **Desktop harmonization rollout** — better as a follow-up project, but components should
  be desktop-ready from the start.
- **Standalone QA phase** — testing should be embedded in each PR, with screenshots and real
  tablet checks as acceptance criteria.
- **CommandSheet implementation** — deferred until compact tablet support, but `ToolRail`
  should be designed so it can become a sheet.

### Codex plan — critique
- 9 phases is too many sequential dependencies — delays the most impactful fix (pointer events)
- A standalone Phase 0 can become process overhead, but skipping all inventory is also risky.
  Each PR should include a small command/dependency audit for the surface it touches.
- Desktop harmonization should be a separate rollout decision, but not a separate
  architecture. New command components should be reusable on desktop.
- Some phases are underspecified on implementation (e.g., "migrate sketch canvas to pointer
  events" without addressing the mouse/click/doubleclick question).

### Original incremental plan — what changed
- Added shell mode system (was missing entirely)
- Added toolbar split as PR 3 (was not addressed)
- Moved left drawer into PR 3 with the command-surface work, where it fits the new shell
  layout.
- Moved Operations discoverability to PR 1 because hidden/reopenable panels are a blocker.
- Kept pointer event migration strategy (concrete and correct)
- Kept floating action bar design, but changed visible labels from keyboard shortcuts to
  intent-based tablet commands.
- Kept `useCanvasGestures` hook, but split it into PR 2 to reduce PR 1 risk.

---

## Alignment with existing planning docs

Updates `planning/TABLET_UX_Implementation_Plan.md`:
- **Phase 2B** (pointer events) → PR 1 (1d-1e) + PR 2 (2a-2f)
- **Phase 2C** (3D/sim gestures) → PR 4 (4c)
- **Phase 2D** (reorder) → PR 4 (4a)
- **Phase 2E** (toolbar/chrome) → PR 1 (Operations opener) + PR 3 (toolbar split,
  left drawer) + PR 4 (status bar compact)

## Not covered (future)
- Full compact tablet (7-8") UI — after 10" is solid, but `tablet-compact` shell mode exists
  from PR 1.
- Desktop harmonization rollout — separate project, but new command components are designed
  to be reused.
- Canvas dimension label tap-targets
- Portrait mode support
