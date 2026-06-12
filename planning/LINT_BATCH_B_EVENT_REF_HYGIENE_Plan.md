---
status: In progress   # Draft → Approved → In progress → Done | Abandoned
created: 2026-06-12
parent: LINT_HOOK_TYPING_DEBT_Plan.md
---

# Lint Batch B — Event-listener & Callback-ref Hygiene Plan

Implements **Batch B** of the accepted design in
[LINT_HOOK_TYPING_DEBT_Plan.md](LINT_HOOK_TYPING_DEBT_Plan.md) (§ "Batch B —
event-listener & callback-ref hygiene"). Stacks on Batch A (already merged into
`feat/lint-cleanup`). The parent plan is the source of truth; this plan pins the
concrete sites, the final hook API, and the verification matrix.

## Goal

Clear the React-hook ref/dep lint errors in the interactive UI **without
suppressions and without changing behavior**, by replacing two hand-rolled
anti-patterns with small shared hooks:

1. Render-time ref writes (`react-hooks/refs`) in `useAxisLock.ts` and
   `FeatureTree.tsx` — `ref.current = fn` executed *during render*.
2. Window/element event-listener effects that list unrelated state in their
   dependency arrays (`react-hooks/exhaustive-deps`) in `SketchCanvas.tsx`,
   because the native handler closures capture non-memoized component
   functions.

User-visible outcome: none. Axis-lock cycling (Alt), feature-tree row reorder
(move up/down), and sketch-canvas pointer drag + wheel zoom behave exactly as
today; the lint baseline drops by the targeted findings.

## Background — current lint sites

Line numbers verified against this worktree (reset onto `origin/feat/lint-cleanup`,
tip `Merge Batch A: typed boundaries`). Re-run `npm run lint` at implementation
start to confirm — they may shift.

- `react-hooks/refs` — render-time writes:
  - [`src/sketch/useAxisLock.ts:28`](../src/sketch/useAxisLock.ts) — `onLockChangeRef.current = onLockChange`
  - [`src/components/feature-tree/FeatureTree.tsx:679-680`](../src/components/feature-tree/FeatureTree.tsx) — `moveUpRef.current = onMoveUp` / `moveDownRef.current = onMoveDown`
- `react-hooks/exhaustive-deps` — listener effects with state in deps instead of the captured handler:
  - [`src/components/canvas/SketchCanvas.tsx:2358-2383`](../src/components/canvas/SketchCanvas.tsx) — `pointermove` effect calling `handleCanvasPointerMove`
  - [`src/components/canvas/SketchCanvas.tsx:2385-2399`](../src/components/canvas/SketchCanvas.tsx) — `wheel` effect calling `handleWheelEvent`

## Approach

### New shared hooks — `src/hooks/` (new folder, with `INDEX.md`)

The parent plan's "Files affected" names `src/hooks/useStableEvent.ts` etc. These
are cross-cutting React primitives (not util/units-style helpers), so they get a
dedicated folder registered in [`src/INDEX.md`](../src/INDEX.md). New folder ⇒ new
`src/hooks/INDEX.md`. Apache header on every new `.ts`.

1. **`src/hooks/useStableEvent.ts`**
   - `useStableEvent(fn)` returns a **stable-identity** wrapper. The wrapper's
     `.current` (latest `fn`) is refreshed in `useInsertionEffect`, **not during
     render** — this is exactly the React-recommended replacement for the
     `ref.current = fn` render-write pattern.
   - Designed around a **React-free core** so it is testable in the plain-tsx
     harness (no DOM): an internal `createStableEvent(initial)` returns
     `{ invoke, setLatest }` where `invoke` has a fixed identity and always
     forwards to the latest stored fn. The hook holds one `createStableEvent`
     instance in a ref and calls `setLatest(fn)` from `useInsertionEffect`,
     returning `invoke`. Both `createStableEvent` (exported for tests) and
     `useStableEvent` live in this file.
   - Generic over args/return: `useStableEvent<A extends unknown[], R>((...a: A) => R): (...a: A) => R`. No `any`.

2. **`src/hooks/useEventListener.ts`**
   - `useWindowEvent(type, handler, options?)` and
     `useDocumentEvent(type, handler, options?)` — subscribe **once** to
     `window`/`document`, routing `handler` through `useStableEvent` so the
     effect no longer depends on the handler's identity (deps become `[type]`
     plus serialized options).
   - `useEventListener(ref, type, handler, options?)` — the element-scoped
     variant the canvas needs (`window`/`document` wrappers delegate to a shared
     core or are thin siblings). Accepts a `RefObject<T | null>`; subscribes in
     an effect that reads `ref.current`. The `<canvas>` is rendered
     unconditionally, so its ref is attached by commit time — behavior matches
     today's "read `canvasRef.current`, bail if null" effects. Typed via DOM
     `*EventMap` lookups so `type` narrows the event; no `any`.

### Apply to the sites

- **`useAxisLock.ts`** — replace `const onLockChangeRef = useRef(onLockChange); onLockChangeRef.current = onLockChange`
  (render write, line 27-28) with `const emitLockChange = useStableEvent(() => onLockChange?.())`,
  called from `setLock` as `emitLockChange()`. The window `keydown` listener
  (lines 42-45) moves to `useWindowEvent('keydown', ...)`. `handleKeyDown`'s body
  (Alt-guard + `setLock(cycleLockMode(...))`) is preserved verbatim; `setLock`
  still reads `lockModeRef.current`, so cycling semantics are unchanged. The
  `useCallback`/`useEffect`/`useRef(onLockChange)` for keydown are removed in
  favor of the hook.

- **`FeatureTree.tsx`** — remove the two render writes (lines 677-680). The
  `moveUpRef`/`moveDownRef` exist so the pointer-grip drag handler can call the
  latest `onMoveUp`/`onMoveDown` without re-binding. Replace with
  `const moveUp = useStableEvent(() => onMoveUp?.())` /
  `const moveDown = useStableEvent(() => onMoveDown?.())` (guarding the optional
  props), and call `moveUp()`/`moveDown()` wherever `moveUpRef.current?.()` /
  `moveDownRef.current?.()` are used today. Grip-drag reorder behavior unchanged.
  *(Confirm at implementation: locate the existing `moveUpRef.current` call
  sites in the grip-drag handler and swap them 1:1.)*

- **`SketchCanvas.tsx`** — the two listener effects become:
  - `const onCanvasPointerMove = useStableEvent((event: PointerEvent) => { …existing handleNativePointerMove body verbatim… })`
    then `useEventListener(canvasRef, 'pointermove', onCanvasPointerMove)`.
  - `const onCanvasWheel = useStableEvent((event: WheelEvent) => handleWheelEvent(event))`
    then `useEventListener(canvasRef, 'wheel', onCanvasWheel, { passive: false })`.
  - The native-handler bodies (coalesced-event selection, long-press cancel,
    `handleCanvasPointerMove`/`handleWheelEvent` dispatch) are preserved exactly.
    Because the stable wrapper always forwards to the latest closure, the effects
    can subscribe once and the previous state-list deps are dropped — this is
    behavior-equivalent (the old effect re-subscribed on those state changes
    purely to recapture fresh closures; the wrapper now does that without
    re-subscribing).

### Explicitly NOT touched

- The three load-bearing `eslint-disable react-hooks/exhaustive-deps` directives
  (`SketchCanvas.tsx`, `SimulationViewport.tsx`, `Viewport3D.tsx`) — removing
  them unmasks Batch C's compiler-backed errors. Left intact.
- The other 17 `SketchCanvas.tsx` exhaustive-deps warnings (RAF/edit-state) —
  Batch C.
- No lint rule severity changes; no new suppressions.

## Files affected

- *(new)* `src/hooks/useStableEvent.ts` — `useStableEvent` + React-free `createStableEvent` core (Apache header)
- *(new)* `src/hooks/useEventListener.ts` — `useEventListener` / `useWindowEvent` / `useDocumentEvent` (Apache header)
- *(new)* `src/hooks/useStableEvent.test.ts` — unit tests for `createStableEvent` (Apache header)
- *(new)* `src/hooks/INDEX.md` — folder index
- `src/INDEX.md` — add `hooks/` to the Subfolders list
- `src/sketch/useAxisLock.ts` — render-write ref → `useStableEvent`; keydown listener → `useWindowEvent`
- `src/components/feature-tree/FeatureTree.tsx` — two render-write refs → `useStableEvent`
- `src/components/canvas/SketchCanvas.tsx` — two listener effects → `useStableEvent` + `useEventListener`

## Tests

The plain-tsx `src/**/*.test.ts` harness has no DOM/React renderer, so the hooks
can't be mounted. Coverage targets the extractable core:

- `src/hooks/useStableEvent.test.ts` — exercises `createStableEvent`:
  - `invoke` identity is **stable** across `setLatest` calls (the property that
    makes the wrapper a valid stable dep / render-write replacement).
  - `invoke(...)` always calls the **latest** fn and forwards args + returns its
    value (covers "latest fn is called").
  - multiple `setLatest` in sequence ⇒ only the most recent fires.

The applied UI sites (axis-lock, feature-tree reorder, canvas pointer/wheel) are
verified by the manual browser + tablet matrix below — structural tests don't
cover React rendering. Existing `src/sketch/useAxisLock.test.ts` (pure
`cycleLockMode`/`applyLock` logic) is unaffected and must still pass.

## Verification

```bash
npm run lint    # targeted react-hooks/refs (useAxisLock, FeatureTree) +
                # the two SketchCanvas pointermove/wheel exhaustive-deps warnings gone
npm run build   # icons + tsc + tests (incl. new useStableEvent.test.ts) + vite
git diff --check
```

Manual browser pass (user runs the dev server — I will **not** start it):

- **Axis-lock cycling** — Alt cycles none → x → y → none during a sketch move; guide colour + constraint update each press.
- **Feature-tree reorder** — move a row up and down via the grip; order persists.
- **Sketch canvas** — pointer drag (move/select) and wheel zoom behave as before.
- **Tablet check (required)** — canvas pointer interactions on a coarse pointer / no-hover device per [TABLET_UX_COMBINED_PLAN.md](TABLET_UX_COMBINED_PLAN.md): touch drag + pinch/wheel zoom on `SketchCanvas`.

## Open questions / risks

- **Hook location** — placing the shared hooks in a **new `src/hooks/`** folder
  (per the parent plan's "Files affected") vs. dropping them beside the existing
  `src/utils/useRestoreCanvasFocus.ts`. Proposing `src/hooks/` + `INDEX.md`; flag
  if you'd rather they live under `src/utils/`.
- **Risk: medium** — pointer/keyboard interaction paths. Mitigated by preserving
  handler bodies verbatim and the explicit tablet pass. The subscribe-once change
  on the canvas effects is the only structural shift; it is behavior-equivalent
  as argued above but is the thing to watch in manual testing.
- `useInsertionEffect` runs before layout/paint and before passive effects — the
  correct place to refresh the latest fn so a listener firing between commit and
  passive-effect flush still sees the new fn. No SSR in this app, so the
  insertion-effect timing caveat doesn't apply.

## Out of scope

- Batch A typed boundaries (done), Batch C RAF scheduler + the remaining
  `SketchCanvas` exhaustive-deps + the three load-bearing directives, Batch D
  set-state-in-effect (Toolbar/dialogs), Batch E test-fixture `any` and
  `_`-prefixed unused vars.
- The full `Toolbar.tsx` structural split (`TOOLBAR_REVISIT.md`).
