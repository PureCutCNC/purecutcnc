---
status: Done
created: 2026-06-12
decisions: App.tsx:411 keep toolpathMap + line suppression; SimulationViewport 4 line-level immutability suppressions (both confirmed 2026-06-12)
---

# Lint Batch C — RAF scheduler + SketchCanvas exhaustive-deps cleanup Plan

> Implements **Batch C** of [LINT_HOOK_TYPING_DEBT_Plan.md](LINT_HOOK_TYPING_DEBT_Plan.md)
> (the accepted parent design — Batch C section is the source of truth). Stacks on
> Batches A and B (already merged into `feat/lint-cleanup`). Reuses the Batch B hooks
> in [`src/hooks/`](../src/hooks/) (`useStableEvent`, `useEventListener`).

## Goal

Clear the `react-hooks/exhaustive-deps` warnings on `SketchCanvas.tsx` (×17) and
`App.tsx:411`, and remove the three load-bearing `eslint-disable react-hooks/exhaustive-deps`
directives in `SketchCanvas.tsx`, `SimulationViewport.tsx`, and `Viewport3D.tsx` —
**fixing the 15 latent compiler-rule errors** (13 `react-hooks/immutability`, 2
`react-hooks/refs`) that those directives currently mask (any react-hooks disable on a
file makes the compiler-backed rules bail on the whole file). Strictly behavior-preserving:
the entire sketch interaction surface must behave identically.

## Current baseline (re-measured on this branch)

`npm run lint`, relevant lines only:

- **`App.tsx:411`** — `useMemo` "unnecessary dependency: `toolpathMap`".
- **`SketchCanvas.tsx`** exhaustive-deps warnings: `1118`, `1122`, `1164` (missing `scheduleDraw`);
  `1149` (missing `setHoveredEditControl`); `1300` (large missing-dep list); `2108`
  (`canvasRef.current` cleanup); `2168`/`2177`/`2186`/`2233` (complex dep expressions +
  their paired missing-dep warnings); `2195` (missing `constraintEdit`); `2258`/`2307`
  (missing `setPendingMovePreviewPointRef` / `setPendingTransformPreviewPointRef`);
  `2322` (the load-bearing directive, currently flagged "unused" yet still suppressing the
  compiler rules file-wide).

Removing the three directives surfaces exactly **15** errors (verified by experiment, then reverted):

| File | Rule | Count | Sites |
|---|---|---|---|
| `SketchCanvas.tsx` | `react-hooks/immutability` ("accessed before declared") | 9 | `631` (`scheduleDraw`), `1244` (`editableFeature`), `1248` (`endpointFromSketchExtension`), `1249` (`findOpenEndpointHit`), `1274` (`findSketchSegmentHit`), `1283` (`hitEditableControl`), `2380` (`handleCanvasPointerMove` + `canvasCoordinates`), `2385` (`handleWheelEvent`) |
| `SimulationViewport.tsx` | `react-hooks/immutability` ("value cannot be modified") | 4 | `760` (`rendererRef`), `763` (`sceneRef`), `775` (`cameraRef`), `828` (`camera.aspect` via `cameraRef`) |
| `Viewport3D.tsx` | `react-hooks/refs` ("cannot update ref during render") | 2 | `687` (`zoomWindowActiveRef`), `688` (`zoomWindowBoxRef`) |

## Approach

Change effects **one at a time, with a build + manual re-test between meaningful steps** (this is
the highest-risk batch). The work decomposes into seven independent moves:

### 1. New hook: `useRafScheduler()`

New file `src/hooks/useRafScheduler.ts`. Returns a **stable** `schedule()` that coalesces
repeated calls into a single `requestAnimationFrame`, runs the latest callback, and cancels any
pending frame on unmount. Implemented on top of the Batch B `useStableEvent` so the wrapped
callback always sees the latest closure while `schedule` keeps a stable identity:

```ts
export function useRafScheduler(callback: () => void): () => void {
  const run = useStableEvent(callback)
  const frameRef = useRef<number | null>(null)
  const schedule = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      run()
    })
  }, [run])
  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
  }, [])
  return schedule
}
```

In `SketchCanvas.tsx`: declare `const schedule = useRafScheduler(() => drawRef.current())`
near the top (after `drawRef` at L299), replace every `scheduleDraw()` call with `schedule()`,
delete the hand-rolled `function scheduleDraw` (L2090) and the `scheduleDrawRef` (L497, and its
self-assignment) — pass `schedule` directly to `useAxisLock(schedule)` (replacing
`() => scheduleDrawRef.current()`). The cleanup effect at L2102 keeps its canvas-reset logic but
no longer cancels the frame (the hook owns it).

> Fixes immutability `631` (`scheduleDraw` is now a stable top-declared value) and warnings
> `1118`/`1122`/`1164` (add the stable `schedule` to those dep arrays).

### 2. Relocate the two Batch-B native-listener wrappers

`onCanvasPointerMove` / `onCanvasWheel` (`useStableEvent` + `useEventListener`, currently
L2368–2387) call `handleCanvasPointerMove` (L2856), `canvasCoordinates` (L2408) and
`handleWheelEvent` (L3935) — all declared **below** them, which is what trips the "accessed
before declared" rule. Move these four hook lines to **after** `handleWheelEvent`'s declaration.
Hook call order stays stable across renders (they remain unconditional), so this is safe.

> Fixes immutability `2380` (×2) and `2385`.

### 3. Extract the live-pointer-preview effect body into a stable wrapper

The big effect at L1166–1300 references `editableFeature` (L2413), `endpointFromSketchExtension`
(L2434), `findOpenEndpointHit` (L2453), `findSketchSegmentHit` (L2501) and `hitEditableControl`
(L2597) — all declared below it. Extract its body verbatim into
`const runLivePointerPreview = useStableEvent(() => { …body… })` placed **after** `hitEditableControl`
(≈L2600). The effect at L1166 becomes `useEffect(() => { runLivePointerPreview() }, [<the existing
dep list>])`. The dep list is unchanged, so the effect still re-runs on exactly the same state
changes; the body now reads everything via the stable wrapper (lexically below all declarations).

> Fixes immutability `1244`/`1248`/`1249`/`1274`/`1283` **and** warning `1300` in one move.

### 4. Stabilise the small transient-preview setter cluster

Convert these component-body helpers from plain `function` declarations to `useStableEvent`
wrappers (same call signatures, same bodies; they only touch refs, `schedule`, and the
`onActiveSnapModeChange` prop): `updateActiveSnap`, `setPendingPreviewPointRef`,
`setPendingMovePreviewPointRef`, `setPendingTransformPreviewPointRef`,
`setPendingOffsetPreviewPointRef`, `setPendingOffsetRawPreviewPointRef`, `setHoveredEditControl`.
All call sites are below their declaration, so the `function`→`const` change is safe. Being
stable, they can now be listed as deps.

> Clears warnings `1149` (`setHoveredEditControl`), `2258` (`setPendingMovePreviewPointRef`),
> `2307` (`setPendingTransformPreviewPointRef`) by adding the now-stable setters to those dep
> arrays.

### 5. Extract complex dep expressions to named locals (focus-management effects)

For the RAF-focus effects at L2155–2233, replace the inline boolean/optional-chain dep
expressions with named render-scope locals and use them as the sole dep, rewriting the guard to
match so the paired "missing dependency" warning also clears:

| Effect | New local | Dep |
|---|---|---|
| `2168` dimension focus | `const dimensionEditActiveField = dimensionEdit?.activeField ?? null` | `[dimensionEditActiveField]` |
| `2177` fillet focus | `const filletDimensionEditActive = filletDimensionEdit != null` | `[filletDimensionEditActive]` |
| `2186` constraint-distance focus | `const hasConstraintDistanceInput = constraintDistanceInput != null` | `[hasConstraintDistanceInput]` |
| `2195` constraint-edit focus | `const constraintEditId = constraintEdit?.constraintId ?? null` | `[constraintEditId]` |
| `2233` operation-dim focus | `const operationDimEditKind = operationDimEdit?.kind ?? null` | `[operationDimEditKind]` |

Each derived key changes **iff** the original dep tuple changed, so the focus timing is identical.

### 6. `canvasRef.current` cleanup (L2108)

In the unmount/reset effect, capture `const canvas = canvasRef.current` at the top of the effect
body and use that local in the returned cleanup (instead of re-reading `canvasRef.current` inside
cleanup). Clears the ref-in-cleanup warning.

### 7. `SimulationViewport.tsx` + `Viewport3D.tsx` directive removal

- **`Viewport3D.tsx`** (remove directive L1067): move the two render-time ref writes
  `zoomWindowActiveRef.current = zoomWindowActive` / `zoomWindowBoxRef.current = zoomWindowBox`
  (L687–688) out of render into a `useLayoutEffect(() => { … }, [zoomWindowActive, zoomWindowBox])`.
  These refs are only read inside the RAF render loop, so a post-commit (pre-paint) write keeps
  behavior identical. Clears both `react-hooks/refs` errors.
- **`SimulationViewport.tsx`** (remove directive L1263): the four "value cannot be modified" errors
  (L760/763/775/828) are the canonical three.js pattern — `rendererRef`/`sceneRef`/`cameraRef`
  populated in the mount effect and read in a sibling effect. There is no behavior-preserving
  restructure that satisfies the compiler rule without merging unrelated effects (risky, out of
  scope for a lint batch). Per the parent plan's **suppression policy**, apply **line-level**
  `// eslint-disable-next-line react-hooks/immutability -- three.js renderer/scene/camera live in
  refs across effects; populated in the mount effect, read in the resize/mesh effect` on each of
  the four sites, and list them in the merge summary. *(See open question — confirm this over a
  deeper refactor.)*

## Files affected

- *(new)* `src/hooks/useRafScheduler.ts` — `useRafScheduler(callback)` coalescing RAF scheduler (Apache header).
- *(new)* `src/hooks/useRafScheduler.test.ts` — unit test with mocked `requestAnimationFrame`.
- `src/hooks/INDEX.md` — add the new hook + test entries.
- `src/components/canvas/SketchCanvas.tsx` — moves 1–6 above (the bulk of the batch).
- `src/components/simulation/SimulationViewport.tsx` — remove directive; 4 documented line-level suppressions.
- `src/components/viewport3d/Viewport3D.tsx` — remove directive; render-time ref writes → `useLayoutEffect`.
- `src/App.tsx` — `useMemo` L411 dep change (see open question).

## Tests

- **`useRafScheduler.test.ts`** (mirrors the existing `useStableEvent.test.ts` harness style):
  with a mocked `requestAnimationFrame`, assert (a) multiple `schedule()` calls within one frame
  coalesce to a single rAF + single callback invocation; (b) the callback actually runs on the
  frame; (c) a fresh `schedule()` after the frame fires schedules again. If `useRafScheduler`
  exposes a React-free core like `createStableEvent` does, test that core directly; otherwise test
  the coalescing logic via the mocked-rAF path the repo already uses.
- The `SketchCanvas` / `SimulationViewport` / `Viewport3D` effects are React-render behavior that
  structural tests don't cover — verified by the manual matrix below.

## Verification

```
npm run lint     # SketchCanvas + App exhaustive-deps warnings cleared; 0 new immutability/refs errors
npm run build    # icons + tsc + tests + vite
git diff --check
```

Then a **full manual sketch-workflow pass** (user runs the dev server — I will not start it):
draw, move, offset, transform, dimension edit, constraint edit, fillet, snapping, pan + wheel
zoom; plus the simulation viewport (orbit/zoom/playback) and 3D viewport (zoom-window) since their
directives are touched. **Tablet check required** (coarse pointer, no hover) per
[TABLET_UX_COMBINED_PLAN.md](TABLET_UX_COMBINED_PLAN.md) — this batch is the most likely to regress
canvas interaction.

## Outcome — scope adjustment (2026-06-12)

During implementation the plan's central premise proved wrong: the React Compiler ESLint
rules **bail early per scope**, so the "9 SketchCanvas immutability errors" measured up front
were only the first wave. Each fix surfaced more behind it — after clearing the
"accessed before declared" chain, removing the SketchCanvas directive exposed **26+
`react-hooks/refs` render-time ref-mirror writes** (`xRef.current = x` during render) plus
refs read during render in JSX, and `set-state-in-effect` (Batch D's rule). Converting those
is a sprawling, high-regression-risk refactor of the core canvas — not the ~15-line fix this
batch budgeted, and not safely behavior-preserving as a lint batch.

**Decision (user-approved): ship the safe wins, defer the SketchCanvas ref-mirror refactor.**

Done in this batch:
- `useRafScheduler()` hook (+ passing unit test); replaced the ad-hoc `scheduleDraw`/`scheduleDrawRef`.
- **All** SketchCanvas `exhaustive-deps` warnings cleared (RAF scheduler dep, complex-dep keys,
  `useStableEvent` transient-preview setters, big live-preview effect extracted to a stable
  `runLivePointerPreview` wrapper, `canvasRef.current` cleanup local).
- `App.tsx:411` `toolpathMap` — **kept** with a documented `-- reason` line suppression (dropping it
  regresses the generating spinner; the memo depends on cache state updated in lockstep with the map).
- `Viewport3D.tsx` render-time ref writes → `useLayoutEffect` (the 2 `refs` errors genuinely fixed).
- `SimulationViewport.tsx` directive **removed**; its 4 `immutability` errors (canonical three.js
  renderer/scene/camera-in-refs pattern) carry documented line-level `-- reason` suppressions.

Deferred to a dedicated follow-up batch (kept directives, each documented with a `-- reason`):
- `SketchCanvas.tsx` directive — masks ~26 render-time ref-mirror writes + JSX ref-reads + set-state-in-effect.
- `Viewport3D.tsx` directive — masks one `set-state-in-effect` (Batch D's rule).

Net lint delta: warnings 21 → 2 (the two documented load-bearing directives); errors unchanged at
28 (all pre-existing Batch A/D/E debt — Batch C introduced none). The SketchCanvas immutability
*reorderings* explored during this work were reverted, so the SketchCanvas diff is exactly the
warning-clearing changes.

## Open questions / risks

1. **`App.tsx:411` `toolpathMap` dep — recommend KEEP with a documented suppression, not drop.**
   The memo body does not lexically read `toolpathMap`, but the existing comment (L396–399) is
   explicit that the dep is load-bearing: it forces `generatingOperationIds` to recompute when the
   async pipeline finishes (which updates `toolpathMap` *and* `toolpathCacheRef.current`, the latter
   a ref the rule can't see). `project` does not change identity when generation completes, so
   **dropping `toolpathMap` would leave the generating spinner stuck on**. Recommendation: replace
   with a line-level `// eslint-disable-next-line react-hooks/exhaustive-deps -- recompute must
   track toolpathMap; cache read via toolpathCacheRef is invisible to the rule` and keep the dep.
   The parent plan's wording ("drop the unnecessary dep") predates this comment — need your call.
2. **`SimulationViewport.tsx` 4 immutability errors → line-level suppressions** (three.js ref
   pattern). Confirm this is acceptable rather than a deeper effect refactor (which I'd consider
   out of scope and higher-risk than the lint debt it removes).
3. Moving the big pointer-preview effect body into a `useStableEvent` wrapper preserves its dep
   list exactly; the only behavioral risk is if any referenced helper currently relies on being
   re-created per render — audited as false (they read refs/props), but this is the single
   highest-risk move and gets its own build + manual test checkpoint.

## Out of scope

- Batch A (typed boundaries — done), Batch B (event/ref hooks — done, reused here),
  Batch D (`set-state-in-effect` in Toolbar/ToolRail/dialogs), Batch E (test-fixture `any`,
  `_`-prefixed unused vars — including the `SketchCanvas.tsx` `_`-prefixed unused var still in the
  baseline).
- Any change to hook-rule severity. No blanket disables.
- The `Toolbar.tsx` structural split / toolbar UX revisit.
