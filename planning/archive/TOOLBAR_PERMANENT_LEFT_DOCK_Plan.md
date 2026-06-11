---
status: Done   # Draft → Approved → In progress → Done | Abandoned
created: 2026-06-10
---

# Toolbar Permanent Left Dock Plan

## Goal

Make the PureCutCNC toolbar permanently left-docked and remove the user's ability to
move it. The left arrangement (horizontal header strip + vertical left rail) already
exists and works on `main`; this task makes it the only mode and deletes the two
orientation-toggle buttons. No new flyouts, split-buttons, overflow menus, or CSS
extraction — match the diff to the request, not a refactor.

## Approach

- Remove all toolbar-orientation state, persistence, and the width breakpoint from
  `App.tsx`. There is no longer a "top" arrangement — the shell always renders the
  header `globalToolbar` plus the left-rail `creationToolbar`.
- Per the confirmed decision: **drop the 920px narrow-desktop fallback entirely**
  (`isToolbarForcedTop` / `TOOLBAR_LEFT_BREAKPOINT`). Narrow desktop uses the ~44px
  left rail like everything else. Tablet mode is unaffected (it uses `TopCommandBar` +
  `ToolRail`, a separate path).
- In `AppShell.tsx`, hard-code the left arrangement: drop the orientation props, delete
  the `.toolbar-orientation-controls` toggle-button block, and remove the now-dead
  `toolbar` prop (the top-variant `<Toolbar>`), which is only reachable in top mode.
- In `layout.css`, delete only the `.toolbar-orientation-*` rules. The shared
  first/last-child border-radius rule must keep its `.workspace-layout-btn` selectors
  (deleting it wholesale caused a white-button regression before).

## Files affected

- `src/App.tsx` — remove `ToolbarOrientation` type, `TOOLBAR_ORIENTATION_STORAGE_KEY`,
  `TOOLBAR_LEFT_BREAKPOINT`, the `toolbarOrientationPreference` + `isToolbarForcedTop`
  state, `effectiveToolbarOrientation`, the resize listener effect, and the persist
  effect. Stop passing `toolbar`, `toolbarOrientation`, `toolbarOrientationForced`,
  `onToolbarOrientationChange` to `AppShell`. Drop the now-unused top `<Toolbar>` JSX
  block and the `Toolbar` import (keep `GlobalToolbar`, `CreationToolbar`).
- `src/components/layout/AppShell.tsx` — remove `toolbar`, `toolbarOrientation`,
  `toolbarOrientationForced`, `onToolbarOrientationChange` from props/interface. Header
  always renders `globalToolbar` with class `app-toolbar--left`; `app-body` always gets
  `app-body--toolbar-left`; `railPrefix` is always `var(--left-toolbar-width)`; the
  left rail always renders (non-tablet). Delete the `.toolbar-orientation-controls`
  button block.
- `src/styles/layout.css` — delete the `.toolbar-orientation-controls`,
  `.toolbar-orientation-btn` (+ `:hover`, `:disabled`, `--active`), and
  `.toolbar-orientation-icon*` rules. In the shared
  `.workspace-layout-controls ... :first-child` / `:last-child` rule, drop only the
  `.toolbar-orientation-controls .toolbar-orientation-btn` selectors; keep the
  `.workspace-layout-btn` ones.

## Step 0 (already done)

The unrelated example rename (`T-53-body` → `t-style-body`) was restored by applying
`_example-rename-backup/example-rename.patch`. Working tree now has the renamed example
files staged for the next commit. (Verify in the running app that the example loads.)

## Tests

No engine changes — this is UI/layout removal. Verification is manual in the running
app (user runs the dev server): left rail + header present, no orientation toggle, the
workspace-layout preset buttons are styled (not white/unstyled), and the alignment
popover still opens. `npm run build` must pass before any commit.

## Open questions / risks

- Resolved: narrow desktop drops the fallback and stays left (confirmed).
- Risk: deleting the shared border-radius rule by range would un-style
  `.workspace-layout-btn` (prior white-button regression). Mitigation: edit by selector,
  keep the workspace-layout selectors.

## Out of scope

No splitting `Toolbar.tsx`, no new flyouts/split-buttons, no overflow/"More" menu, no
extracting toolbar CSS. `Toolbar.tsx` exports (`GlobalToolbar`/`CreationToolbar`/top
`Toolbar`), the popover code, and `FeatureEditActions` stay as-is — App just stops
rendering the top `Toolbar`.

## Addendum (2026-06-10) — rail scroll + popover portal

Making the toolbar permanently left surfaced two issues the original minimal scope did
not anticipate, so the change grew to cover them:

- **Cut-off rail buttons.** With a fixed left rail, a tall tool set (e.g. the guitar
  example with a multi-feature selection) ran past the viewport bottom and the lowest
  buttons were unreachable. Fixed by making `.app-left-rail` scroll (`overflow-y: auto`,
  hidden scrollbar) with top/bottom mask **fade hints** toggled by a small scroll/resize
  effect in `AppShell.tsx` (`leftRailRef` + `app-left-rail--can-scroll-up/-down`).
- **Clipped popover menus.** Once the rail scrolls, `overflow-y: auto` forces
  `overflow-x` to clip too, so the align/distribute (and dimension) popovers — which open
  to the right of the ~44px rail — were cut off. Fixed by rendering
  `ToolbarPopoverMenu`'s menu through a **`document.body` portal**, positioned `fixed`
  from the trigger's bounding rect, viewport-clamped, recomputed on scroll/resize
  (`Toolbar.tsx`, `.toolbar-popover--floating`). The same fix was applied to the **tablet**
  `ToolRail` flyouts via a new `RailFlyout` helper (`ToolRail.tsx`,
  `.tool-rail__popover--floating` in `tablet.css`).

Verified live (desktop + emulated tablet): rail scrolls with fade hints; bottom buttons
reachable; align/distribute menus portal out, stay fully on screen, apply, and close.

## ⚠️ Temporary solution — revisit the toolbar

This is **not** the final toolbar design — it stabilises the current one (always-left,
scroll, portaled popovers) so nothing is unreachable or clipped. The underlying
crowding/altitude problems remain and the toolbar should be revisited holistically. See
the live follow-up note: [`TOOLBAR_REVISIT.md`](../TOOLBAR_REVISIT.md).
