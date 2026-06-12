---
status: In progress   # Draft → Approved → In progress → Done | Abandoned (approved 2026-06-12; drawer migration included)
created: 2026-06-12
---

# Lint Batch D — `set-state-in-effect` (portal positioning + dialog state) Plan

> Batch D of the accepted design in
> [`LINT_HOOK_TYPING_DEBT_Plan.md`](LINT_HOOK_TYPING_DEBT_Plan.md) §"Batch D".
> Stacks on Batches A/B/C (already merged into `feat/lint-cleanup`). Reuses the
> shared hooks B/C introduced (`useStableEvent`, `useRafScheduler`, …) under
> `src/hooks/`.

## Goal

Clear the **7 `react-hooks/set-state-in-effect` errors** without new suppressions
and without changing behavior. Each site sets React state synchronously inside an
effect to a value that is really *derivable during render* (the rule's exact
complaint). Two distinct shapes:

1. **Portal positioning** — popover/tooltip components run a `useLayoutEffect` that
   calls `setCoords(null)` / `setTooltipCoords(null)` in the "closed" branch. The
   closed→null case is render-derivable; only the *measurement* (DOM rect → coords)
   genuinely belongs in an effect.
2. **Prop-driven state reset** — four components reset a piece of state in an
   effect when an input changes (project name, font fallback, export preview).
   These become React-recommended "adjust state during render" / derive patterns.

## The 7 sites (verified against current source on `feat/lint-cleanup`)

`npm run lint` could not be re-run in the worktree (no `node_modules` yet — the
user installs those to run the app), so sites were located by reading source. All
7 match the design-doc enumeration (the doc's "8 err" header is stale; its own
list enumerates 7):

| # | File | Line | setState call | Shape |
|---|------|------|---------------|-------|
| 1 | [`Toolbar.tsx`](../src/components/layout/Toolbar.tsx:93) | 93 | `setTooltipCoords(null)` (ToolbarAction tooltip) | portal |
| 2 | [`Toolbar.tsx`](../src/components/layout/Toolbar.tsx:1210) | 1210 | `setCoords(null)` (PopoverMenu) | portal |
| 3 | [`Toolbar.tsx`](../src/components/layout/Toolbar.tsx:266) | 266 | `setNameVal(project.meta.name)` when not editing | reset |
| 4 | [`ToolRail.tsx`](../src/components/layout/ToolRail.tsx:101) | 101 | `setCoords(null)` (RailFlyout) | portal |
| 5 | [`TopCommandBar.tsx`](../src/components/layout/TopCommandBar.tsx:74) | 74 | `setNameVal(project.meta.name)` when not editing | reset |
| 6 | [`TextToolDialog.tsx`](../src/components/project/TextToolDialog.tsx:42) | 42 | `setFontId(defaultFontIdForStyle(style))` fallback | reset |
| 7 | [`ExportDialog.tsx`](../src/components/export/ExportDialog.tsx:74) | 74 | `setPreviewResult(null)` when no active definition | reset |

**Not flagged / out of scope:** `Toolbar.tsx:869` (the drawer/`CreationToolbar`
popover `setDrawerCoords({top,left})`) is the *same positioning shape* but is **not**
a lint error — it only sets a measured (non-render-derivable) value, never
`setState(null)` in the closed branch, so the rule doesn't fire. It will be
migrated to the new helper anyway for consistency and to drop the triplicated
positioning effect (see "Open questions").

## Approach

### 1. New shared hook `usePortalPosition` (sites 1, 2, 4 — and the drawer)

New file `src/hooks/usePortalPosition.ts`. Encapsulates the
"position a portaled floating element from its anchor's bounding rect, recomputing
on scroll/resize while open" pattern that is currently copy-pasted across
`ToolbarAction`, `PopoverMenu`, `CreationToolbar` (Toolbar) and `RailFlyout`
(ToolRail).

```ts
export interface PortalCoords { top: number; left: number }

export function usePortalPosition(
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  open: boolean,
  measure: (anchor: DOMRect, floating: DOMRect) => PortalCoords,
): PortalCoords | null
```

Behavior:
- Holds `coords` state. The **closed→null case is derived during render**:
  `return open ? coords : null` — no `setState` in the closed branch (this is what
  kills the lint error).
- `measure` is routed through **`useStableEvent`** (Batch B) so its identity is
  stable; the layout-effect dep array is effectively `[open]`, matching today's
  effects, and each call site keeps its own offset/side math.
- A single `useLayoutEffect` (runs only when `open`) does the initial
  `getBoundingClientRect` measurement and subscribes to `scroll`(capture)/`resize`.
  Setting state from those subscription callbacks — and from the one synchronous
  initial measure — is the **legitimate external-system pattern** the rule allows
  (the value is a DOM measurement, not render-derivable), exactly as the existing
  non-flagged drawer effect already does.
- Dedupe via the existing `prev.top===next.top && prev.left===next.left ? prev`
  guard so scroll events don't churn renders.
- Cleanup removes both listeners on close/unmount (unchanged from today).

**Stale-on-reopen is a non-issue:** on `open` false→true the render briefly returns
the previous `coords`, but `useLayoutEffect` re-measures and re-renders *before the
browser paints*, so the user never sees a stale position (same guarantee the
current code relies on; tooltips/popovers already start hidden until measured via
their `visibility`/`-9999` style fallback, which is preserved).

A React-free core is extracted for unit testing (the harness has no React
renderer — see `useStableEvent.test.ts` / `useRafScheduler.test.ts` precedent):
- `selectPortalCoords(open, measured)` → `open ? measured : null`
- `nextPortalCoords(prev, next)` → dedupe guard

Call-site changes (each just supplies its `measure` closure and swaps the state +
effect for one hook call; the JSX `coords?.top ?? -9999` style fallbacks stay):
- `ToolbarAction` (Toolbar): `open = tooltipVisible`, sides bottom/right, +8 offset.
- `PopoverMenu` (Toolbar): `open = effectiveOpen`, sides bottom/right, +6 offset.
- `CreationToolbar` drawer (Toolbar): `open = drawerOpen`, +6 offset (consistency
  migration; not itself a lint error).
- `RailFlyout` (ToolRail): `open` prop, right side, +6 offset.

### 2. Prop-driven resets (sites 3, 5, 6, 7) — "adjust state during render"

Replace each in-effect reset with the React-recommended "store previous input,
adjust during render" pattern (or plain derive), which the rule accepts.

- **Toolbar `nameVal` (site 3) & TopCommandBar `nameVal` (site 5)** — identical.
  The displayed name already reads `project.meta.name` directly when not editing;
  entering edit mode already seeds `setNameVal(project.meta.name)` in the click
  handler. The effect only matters when `project.meta.name` changes *externally*
  while not editing (load/new project), so:
  ```ts
  const [syncedName, setSyncedName] = useState(project.meta.name)
  if (!editingName && project.meta.name !== syncedName) {
    setSyncedName(project.meta.name)
    setNameVal(project.meta.name)
  }
  ```
  Faithful: same trigger (not-editing + name change), same result. Enter/leave edit
  flows are untouched (they already set `nameVal` in their handlers).

- **TextToolDialog font fallback (site 6)** — `fontOptions` derives only from
  `style`, so the only way `fontId` becomes invalid is a `style` change. Trigger
  the fallback on style change during render:
  ```ts
  const [prevStyle, setPrevStyle] = useState(style)
  if (style !== prevStyle) {
    setPrevStyle(style)
    if (!fontOptions.some((f) => f.id === fontId)) setFontId(defaultFontIdForStyle(style))
  }
  ```
  Faithful: switching style still falls back to a valid font for that style.

- **ExportDialog preview clear (site 7)** — split the two jobs the effect does.
  Keep the debounced `runPostProcessor` effect, but drop its synchronous
  `setPreviewResult(null)` line (just `if (!activeDefinition) return`). Clear the
  stale preview during render when the definition disappears:
  ```ts
  const hasDefinition = Boolean(activeDefinition)
  const [hadDefinition, setHadDefinition] = useState(hasDefinition)
  if (hadDefinition !== hasDefinition) {
    setHadDefinition(hasDefinition)
    if (!hasDefinition && previewResult !== null) setPreviewResult(null)
  }
  ```
  Faithful: deselecting the machine clears the preview immediately (disables the
  Export button via the unchanged `!previewResult` guard); re-selecting re-runs the
  debounced postprocessor as before.

## Files affected

- *(new)* `src/hooks/usePortalPosition.ts` — the hook + React-free
  `selectPortalCoords` / `nextPortalCoords` cores. Apache header.
- *(new)* `src/hooks/usePortalPosition.test.ts` — unit tests for the cores
  (closed→null, open→measured, dedupe). Apache header.
- `src/hooks/INDEX.md` — add the `usePortalPosition.ts` / `.test.ts` entries.
- `src/components/layout/Toolbar.tsx` — sites 1, 2, 3 (+ drawer migration); drop
  three/four duplicated positioning `useLayoutEffect`s.
- `src/components/layout/ToolRail.tsx` — site 4.
- `src/components/layout/TopCommandBar.tsx` — site 5.
- `src/components/project/TextToolDialog.tsx` — site 6.
- `src/components/export/ExportDialog.tsx` — site 7.

No new files under `src/components`, so no component-level INDEX changes beyond the
hooks index. `useLayoutEffect` import may drop from Toolbar/ToolRail if the only
remaining uses are the migrated ones (will verify and clean unused imports).

## Tests

- `usePortalPosition.test.ts` (run via existing `npx tsx` structural harness):
  `selectPortalCoords(false, {…}) === null`, `selectPortalCoords(true, m) === m`,
  `nextPortalCoords` returns the same ref when top/left unchanged and a new value
  otherwise.
- Sites 3/5/6/7 are React render logic; the structural harness can't cover them —
  verified manually (matrix below). No engine code is touched, so no engine tests.

## Verification

```bash
npm run lint    # the 7 set-state-in-effect errors gone; no new suppressions
npm run build   # icons + tsc + tests + vite
git diff --check
```

Manual browser pass (user runs the dev server — I will **not** start it):
- Rename project from **Toolbar** and from **TopCommandBar**: enter edit, type,
  Enter to commit, Escape to revert; confirm name field seeds/reverts correctly and
  reflects load/new-project name changes.
- **ExportDialog**: open, toggle the active machine definition off → preview clears
  and Export disables; toggle back on → preview re-renders after debounce.
- **TextToolDialog**: switch font style → font falls back to a valid one for the
  new style.
- **Toolbar** popovers + hover tooltips (align/distribute/dimensions, creation
  drawer) position correctly and reposition on rail scroll/resize.
- **Tablet check (required)** — `ToolRail` `RailFlyout` + `Toolbar` popovers
  position correctly with a coarse pointer / no hover (tablet-critical per
  `TABLET_UX_COMBINED_PLAN.md`).

## Open questions / risks

- **Migrating the non-flagged drawer effect (`Toolbar.tsx:845`) too** — proposed,
  to remove the triplicated positioning effect and keep one pattern. It's a
  behavior-neutral refactor of working code; say so if you'd rather I leave it and
  touch only the 3 flagged portal sites.
- Behavior-sensitivity: every reset change alters *when* state resets. The patterns
  above are designed to preserve the exact triggers, but these are the cases to
  scrutinize in the manual pass.
- `usePortalPosition` is intentionally a partial step toward the `TOOLBAR_REVISIT.md`
  structural split (extracting shared popover positioning), not a conflict with it.

## Out of scope

- Batches A (typed boundaries), B (event/ref hooks), C (RAF + SketchCanvas deps) —
  already merged.
- Batch E (test-fixture `any`, `_`-prefixed unused vars, the two "unused"
  `eslint-disable react-hooks/exhaustive-deps` at `SketchCanvas.tsx`/`Viewport3D.tsx`).
- The full `Toolbar.tsx` structural split / toolbar UX revisit (`TOOLBAR_REVISIT.md`).
