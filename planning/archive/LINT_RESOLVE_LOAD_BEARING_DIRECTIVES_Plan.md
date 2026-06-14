---
status: Done   # Draft → Approved → In progress → Done | Abandoned (approved + completed 2026-06-13)
created: 2026-06-13
---

# Lint — Resolve the two load-bearing `exhaustive-deps` directives (true-0 `src` baseline) Plan

Completes the work **deferred** by [`LINT_BATCH_C_RAF_SKETCHCANVAS_DEPS_Plan.md`](LINT_BATCH_C_RAF_SKETCHCANVAS_DEPS_Plan.md)
and [`LINT_BATCH_D_SET_STATE_IN_EFFECT_Plan.md`](LINT_BATCH_D_SET_STATE_IN_EFFECT_Plan.md), and flagged as the
follow-up in the **OUTCOME** note of [`LINT_BATCH_E_LEFTOVERS_Plan.md`](LINT_BATCH_E_LEFTOVERS_Plan.md).

Worktree `lint-resolve-load-bearing-directives` is based on `feat/lint-cleanup`
(HEAD = `0256be8 Merge Batch E: leftovers`). Baseline re-measured here on 2026-06-13:
`npm run lint` → **2 problems (0 errors, 2 warnings)**, both "Unused eslint-disable directive".

## Goal

Reach a **true-0** `src` lint baseline by removing the two surviving
`eslint-disable react-hooks/exhaustive-deps` directives and fixing the React-Compiler errors they
mask. Behaviour-preserving — no logic changes, only effect→render-time conversion and a
declaration-order move.

Why they exist: **any** `react-hooks` `eslint-disable` makes the React-Compiler-backed rules
(`react-hooks/immutability`, `react-hooks/refs`, `react-hooks/set-state-in-effect`) bail on the
**whole file**. So each directive simultaneously (a) reports as an "unused directive" warning and
(b) actually hides real errors elsewhere in its file. Removing a directive surfaces those errors,
which is why the underlying fix must land in the same change.

## Current lint inventory (re-run 2026-06-13, line numbers current)

| File:line | Problem | Masks |
|---|---|---|
| `components/viewport3d/Viewport3D.tsx` :1080 | Unused-directive warning | 1× `react-hooks/set-state-in-effect` (the zoom-window reset effect at :1088–1093) |
| `components/canvas/SketchCanvas.tsx` :2194 | Unused-directive warning | 3× `react-hooks/immutability` "accessed before declared" (forward refs at :2252 / :2257) |

These two are the **only** `src` lint problems. (The line-level suppressions kept intentionally in
`App.tsx:415` and `SimulationViewport.tsx` produce **no** lint problem and are out of scope — see below.)

## Approach

Do the two files **independently and sequentially** — removing one directive only un-bails its own
file. Each follows the Batch E empirical protocol: *remove the directive, run `npm run lint`, confirm
exactly the expected masked errors surface, then apply the fix and confirm 0.*

### Item 1 — `Viewport3D.tsx` (LOW RISK): set-state-in-effect → adjust-state-during-render

The masked effect (currently :1088–1093):

```ts
useEffect(() => {
  if (!zoomWindowActive) {
    zoomWindowBoxRef.current = null
    setZoomWindowBox(null)
  }
}, [zoomWindowActive])
```

Convert to the React-recommended adjust-state-during-render reset (the Batch D pattern). A
`useLayoutEffect` already mirrors the ref after commit (:690–693:
`zoomWindowBoxRef.current = zoomWindowBox`), so the render-time reset only needs to touch state — the
ref nulls itself via that mirror on the resulting re-render.

Steps:
1. **Delete** the `useEffect` at :1088–1093.
2. **Add** an adjust-during-render reset immediately after the ref-mirror `useLayoutEffect`
   (after :693), before any conditional logic:
   ```ts
   // Reset the zoom-window box during render when the tool deactivates (React-
   // recommended adjust-state-during-render; the ref mirror above nulls
   // zoomWindowBoxRef after commit).
   if (!zoomWindowActive && zoomWindowBox !== null) {
     setZoomWindowBox(null)
   }
   ```
   The `zoomWindowBox !== null` guard makes this self-terminating (no render loop).
3. **Remove** the directive and its now-inaccurate comment block (:1072–1080); the `projectKey`
   fit-bounds effect keeps its body and `}, [projectKey])`.
4. `npm run lint` → expect `Viewport3D.tsx` clean (the `refs` errors here were already fixed in
   Batch C; only this one `set-state-in-effect` was deferred).

Behaviour identical: render-time reset clears the box state before paint instead of just after; the
ref still ends up `null` post-commit via the existing mirror; the JSX (`zoomBoxStyle`, the
`{zoomWindowActive && …}` overlay) reads the same values.

### Item 2 — `SketchCanvas.tsx` (HIGH RISK): forward references → declaration-order move

The directive at :2194 sits on the `projectKey` fit-view effect (:2180–2195), but its bail hides 3
`react-hooks/immutability` "Cannot access variable before it is declared" errors in the native-listener
wrappers:
- :2252 `handleCanvasPointerMove(canvasCoordinates(sourceEvent))` → `handleCanvasPointerMove`
  (declared :2876) and `canvasCoordinates` (declared :2280)
- :2257 `handleWheelEvent(event)` → `handleWheelEvent` (declared :3955)

Fix per Batch C §2 — **move the small wrapper block down** below all three declarations (moving *down*
can only resolve forward refs, never create new ones; the opposite — hoisting the large handlers up —
would cascade new forward refs and is rejected). The wrappers are only consumed by their adjacent
`useEventListener`, so nothing references them in between.

Steps:
1. **Remove** the directive + comment block (:2185–2194) **first**; run `npm run lint`.
   **Checkpoint (go/no-go):** confirm *exactly* the 3 forward-ref `immutability` errors above and
   nothing else. If more surface (Batch C once measured 26+ before its own cleanup landed; Batch E
   re-measured 3 afterward) → **STOP, restore the directive, report to the user** — do not expand scope.
2. **Move** the native-listener block (currently :2236–2259: the two explanatory comment lines,
   `const onCanvasPointerMove = useStableEvent(…)`, its `useEventListener`, `const onCanvasWheel =
   useStableEvent(…)`, its `useEventListener`) to **immediately after `handleWheelEvent`'s closing
   brace** (≈ after :3981, before `handleDoubleClick`). They stay unconditional, so hook call order
   remains stable across renders.
3. `npm run lint` → expect `SketchCanvas.tsx` clean → whole-`src` 0 problems.

## Files affected

- `src/components/viewport3d/Viewport3D.tsx` — delete the zoom-window reset effect (:1088–1093); add
  the adjust-during-render reset after the ref-mirror `useLayoutEffect` (~:693); remove the directive
  + comment (:1072–1080).
- `src/components/canvas/SketchCanvas.tsx` — move the `onCanvasPointerMove` / `onCanvasWheel`
  `useStableEvent` wrappers + their `useEventListener` calls (:2236–2259) to after `handleWheelEvent`
  (~:3981); remove the directive + comment (:2185–2194).
- `planning/INDEX.md` — register this plan, then move to **In progress** on approval; archive on completion.

No new source files → no new Apache headers, no new `INDEX.md`.

## Tests

No new unit tests — this is React render/effect cleanup with no engine-logic change (consistent with
Batches C/D/E, which added none for their React-render moves and relied on the structural suite +
manual pass). The existing structural suite runs inside `npm run build` and must stay green.

Verification gate:
```
npm run lint    # target: 0 problems (both directives gone, no surfaced errors)
npm run build   # icons + tsc + tests + vite
git diff --check
```

Manual browser pass — **user runs the dev server; I will not start it**:
- **3D viewport zoom-window** (Item 1): activate the zoom-window tool, drag a box, release to zoom;
  deactivate the tool → the box clears and re-activating starts fresh (exercises the converted reset).
- **Full sketch-canvas set** (Item 2): draw / move / dimension-edit / snap, plus pan and wheel-zoom
  and live pointer hover/preview (exercises the relocated native pointermove + wheel listeners).
- **Tablet / coarse-pointer pass** (required per the Batch C/D verification notes) — confirm canvas
  pointer interaction and wheel/pinch zoom behave identically with no hover.

## Outcome (2026-06-13)

**Item 1 — Viewport3D: DONE.** Directive + comment removed; the masked `set-state-in-effect` was
confirmed empirically (removing the directive surfaced exactly 1 error at `:1082`) and converted to an
adjust-state-during-render reset (`if (!zoomWindowActive && zoomWindowBox !== null) setZoomWindowBox(null)`
after the ref-mirror `useLayoutEffect`). The pre-existing effect was deleted. `Viewport3D.tsx` is now
lint-clean. Verified: `npm run build` green; in the running app (3D View), drawing a zoom box then
**Escape**-mid-draw clears the box via the new reset, a full **drag→release** zooms (`fitToScreenRect`)
and auto-deactivates, and the console stays clean (no re-render loop / update-during-render warning)
across all flows. Sketch tab smoke-tested too (wheel-zoom + hover, no errors).

**Item 2 — SketchCanvas: full refactor ATTEMPTED (user-directed), hit an architectural wall, reverted.**
On user instruction ("attempt full refactor now") the directive was removed and the work pushed past the
plan's stop condition. Findings, phase by phase:

- **Phase 1 — forward-refs (DONE, behavior-safe).** The "3 errors" were the first wave; the React-Compiler
  rules bail per scope, so the true set was **8 forward-referenced functions** (`clearTransientCanvasState`,
  `stopPan`, `stopNodeDrag`, `triggerContextMenuAt`, `applyEditDimStep`, `commitEditDimension`,
  `cancelEditDimension`, `triggerDimensionEdit`). All are hoisted `function` declarations, so reordering is
  runtime-neutral. Relocated all 8 (+`advanceTabInEditMode`) above their first uses via one scripted pass
  with a non-blank-line-multiset invariant (proved no code changed, only order). Forward-refs → 0.
- **Phase 2 — ref-during-render (the wall).** With forward-refs gone, **33 `Cannot access refs during
  render` errors** surfaced: **27 ref-WRITES** (the `:471–494` mirror block + `:323/326` + the `drawRef`
  closure at `:1450`) — these are mechanically convertible to a `useLayoutEffect` mirror — **plus ~6
  render-time ref-READS** that are *not* convertible without a redesign: `canvasRef.current` in two
  conditional overlays (`:4965/:5039`), `pendingSketchFilletRef.current` in a label (`:6005`), and
  `pendingPreviewPointRef.current` at `:4891` (building `pendingDraftProfile` for the self-intersection /
  exceeds-stock warnings). `pendingPreviewPointRef` is written on the **pointer-move hot path** (via
  `setPendingPreviewPointRef`, ~8 sites) specifically to avoid re-rendering the canvas every mouse move;
  lifting it (or canvas size — there is no size state, only a `ResizeObserver`) to React state to satisfy
  the rule risks a real per-move re-render / perf regression, and restructuring the derived computations
  into effects is a feature-sized change needing perf + full-interaction verification.
- **All-or-nothing constraint.** Any `react-hooks` issue makes the rules bail the whole file, so Phase 1 +
  the 27 write conversions yield **zero** lint benefit unless *every* render-time read is also resolved.
  Since the reads need an architectural redesign that can't be safely verified as a lint task, `SketchCanvas.tsx`
  was reverted to HEAD (directive retained). The Phase 1 reorder is fully reproducible from the saved script.

**Net result:** `src` lint **2 → 1 problem** (the one remaining warning is the kept SketchCanvas directive).
One of the two directives resolved (Viewport3D). True-0 remains blocked on the SketchCanvas render-time
hot-path ref reads — confirmed architectural, not mechanical.

**Decision (user, 2026-06-13): keep the SketchCanvas directive; correct its comment.** The directive's
comment was rewritten to document the true masked scope (8 forward-refs + ~27 ref-mirror writes + ~6
render-time hot-path ref reads) and to point at `LINT_HOOK_TYPING_DEBT_Plan.md` so the next person doesn't
re-run the investigation. The deferred redesign (lifting hot-path refs / restructuring derived computations
off the render path) stays tracked under that backlog plan. Final: lint 1 warning, `npm run build` green,
Viewport3D zoom-window verified in-app (Escape-mid-draw + drag→release, console clean).

## Open questions / risks

- **`SketchCanvas.tsx` is the interaction-critical ~6,150-line drawing surface.** Removing its
  directive un-bails the React-Compiler rules for the entire file. The expected masked set is 3
  forward-ref errors (Batch E's re-measurement), but the go/no-go checkpoint in Item 2 step 1 verifies
  this empirically before any fix is committed; if the inventory is larger, the change stops and is
  reported rather than ballooning into the deferred ref-mirror refactor.
- Both fixes are behaviour-preserving by construction, but React render behaviour isn't covered by the
  structural suite — the manual matrix (incl. tablet) is the safety net.

## Out of scope

- `App.tsx:415` `react-hooks/exhaustive-deps` line-level suppression — a **justified, documented** dep
  (the `toolpathMap`/`toolpathCacheRef` spinner sync, kept by Batch C). It produces **no** lint problem,
  so it doesn't affect the 0-baseline; not touched here.
- `SimulationViewport.tsx` line-level `react-hooks/immutability` suppressions (canonical three.js
  refs-across-effects pattern, kept by Batch C) — also produce no lint problem; not touched here.
- The broader `SketchCanvas.tsx` ref-mirror / immutability refactor beyond the declaration-order move
  needed for these 3 errors (the large deferred Batch C item).
