---
status: Approved   # Draft → Approved → In progress → Done | Abandoned
created: 2026-06-17
approved: 2026-06-17
---

# P7.4 — Reactive fillet panel (state-driven step + "Radius" button) Plan

> Follow-up to **P7 (workflow-panel migration)** — see the P7 row + "Follow-up tasks" section in [CORE_STATE_CANVAS_REFACTOR_Plan.md](CORE_STATE_CANVAS_REFACTOR_Plan.md). Runs as a round in its own worktree off the cumulative `feat/core-arch-simplification` branch, merged back with `--no-ff` (no direct-to-`main`).

## Goal

After picking a fillet corner in sketch-edit, let the user enter a radius **without a keyboard**, and make the panel reflect the corner-pick **immediately**. Today the only way to open the radius field is pressing **Tab** (or clicking a second point), and the panel step text doesn't update until the next mouse move. On tablet — the form factor the whole P7 panel migration was meant to serve — there is no Tab key, so filleting by radius is impossible. This closes that gap.

This is an **additive UX change**, deliberately *not* part of P7's faithful migration (P7 only moved the radius input's render location from a floating overlay into `CanvasWorkflowPanel`; the Tab trigger is byte-for-byte identical to `main`). It therefore gets its own round + review + tablet-verify cycle.

## Approach

Root cause: the fillet step text in `SketchCanvas.tsx` (the `editModeActive` panel `step=` expression) reads `pendingSketchFilletRef.current` — a **ref**. Setting that ref on corner-click does not trigger a React re-render, so the panel only reflects the new state on the next render (a mouse move). The same ref-only signal is why no button can appear on corner-click.

- **Mirror the fillet-pending signal into state.** Add a small state flag (or mirror `pendingSketchFilletRef` into `useState`) updated wherever that ref is set/cleared, so the panel re-renders the instant a corner is picked or the fillet is cleared/committed/cancelled. Use it for the step text.
- **Add a "Radius" button** to the `editModeActive` panel actions, shown only when a fillet corner is picked and not yet in radius-edit (`pendingSketchFillet && !editFilletActive`). This mirrors the existing **"Dimensions"** button in the creation panel (`creationCanDimEdit && !creationDimEditActive`).
- **Share one radius-entry helper.** The button's `onClick` must invoke the *same* logic the Tab handler in `useCanvasKeyboard.ts` runs today (compute radius via `filletRadiusFromPoint`, then `fillet.setFilletDimensionEdit(...)` → `editFilletActive` shows the Radius input). Factor that into a single helper (on `useFilletWorkflow` or passed via ctx) so the button and Tab can't drift.
- **Keep Tab working** unchanged for desktop parity. **Freeze** `SketchCanvasProps` / `SketchCanvasHandle`.

## Files affected

- `src/components/canvas/SketchCanvas.tsx` — add the state mirror for the fillet-pending signal; use it (not the ref) in the panel `step` expression; render the new "Radius" button in the `editModeActive` panel actions gated on corner-picked-and-not-editing.
- `src/components/canvas/useFilletWorkflow.ts` — expose a single `enterFilletRadiusEdit()` (or similarly named) helper that performs the radius-entry trigger, for both the button and the keyboard handler to call.
- `src/components/canvas/useCanvasKeyboard.ts` — re-point the existing `Tab` fillet branch (lines ~482–507) at the shared helper instead of inlining the `filletRadiusFromPoint` + `setFilletDimensionEdit` logic. Behavior must stay identical.

## Tests

UI/interaction change — no engine logic, so no new unit tests (per [AGENTS.md](../AGENTS.md), the unit-test requirement is for engine work). Verification is **manual browser + tablet** (this is the load-bearing check for a tablet-sensitive surface):

- Pick a fillet corner → panel step updates to "Click second point or enter radius" with **no mouse move**.
- A **"Radius"** button is visible the instant the corner is picked; clicking it opens the panel Radius field.
- Enter a value → **Apply** commits a fillet; **Cancel/Esc** aborts; live preview still calls `scheduleDraw()` on input change.
- **Tab** still opens/closes the radius field exactly as before (desktop parity).
- Repeat the full flow in **tablet** layout (`statusbar-shell-mode = tablet`) with no keyboard — filleting by radius must be fully reachable.
- `npm run build` green; lint clean; both `max-lines` guards (`src/components/canvas/**` 1200, `SketchCanvas.tsx` 3800) still pass.

## Open questions / risks

- **Tablet is the whole point** — must be verified on the tablet form factor, not just desktop.
- Mirroring a ref into state adds a render on corner-pick; confirm it doesn't introduce a per-frame re-render during the subsequent mouse-move radius preview (the preview should keep running through `scheduleDraw()`/refs, not state).
- Keep the Tab and button paths sharing one helper so they can't diverge later.

## Out of scope

- The dimension-edit (P7 R1) and constraint-value (P7 R3) panels — already migrated and verified; not touched here.
- Removing or changing the **Tab** keyboard behavior (it stays).
- Any other canvas banner/panel migration or the `pendingSketchFilletRef` → full-state refactor beyond what's needed for the step text + button.
- `SketchCanvasProps` / `SketchCanvasHandle` changes (frozen contract).
