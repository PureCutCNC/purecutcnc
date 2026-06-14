---
status: Done
created: 2026-06-13
---

# Lint Batch E — Leftovers Plan

Implements **Batch E** of the parent design [`LINT_HOOK_TYPING_DEBT_Plan.md`](LINT_HOOK_TYPING_DEBT_Plan.md)
(see its "Batch E — leftovers" and "Suppression policy" sections). This is the **final code
batch**; after it merges into `feat/lint-cleanup` the `src` lint baseline should be **0**, or only
individually-documented line-level suppressions.

Stacks on Batches A–D (already merged into `feat/lint-cleanup`). This worktree is based on
`origin/feat/lint-cleanup` (verified: `git log` top = `Merge Batch D: set-state-in-effect`).

## Goal

Clear the remaining 23 `src` lint problems (21 errors, 2 warnings) that were declined from the
mechanical cleanup plan: test-fixture `any` casts, `_`-prefixed unused vars, and two stale
`eslint-disable react-hooks/exhaustive-deps` directives. No new `any` in production code; no blanket
suppressions. Behaviour-preserving — these are typing/dead-binding fixes, not logic changes.

## Current lint inventory (re-run 2026-06-13, line numbers current)

| # | File:line | Rule | Binding |
|---|---|---|---|
| 1 | `sketch/constraintSolver.test.ts` :31,35,279,315,517,607,872,1186,1251 (×9) | `no-explicit-any` | fixture/segment casts |
| 1 | `store/second_cut_test.ts` :40 | `no-explicit-any` | `fakeFeature` cast |
| 2 | `components/canvas/SketchCanvas.tsx` :4976 | `no-unused-vars` | `_field` |
| 2 | `engine/simulation/gpuMesh.ts` :159 | `no-unused-vars` | `_dirtyRegion` |
| 2 | `engine/toolpaths/finishSurfaceWaterline.ts` :1553 | `no-unused-vars` | `_point` |
| 2 | `platform/browser.ts` :183 | `no-unused-vars` | `_path` |
| 2 | `store/slices/pendingActionsSlice.ts` :72 | `no-unused-vars` | `_get` |
| 2 | `store/projectStore.ts` :1094,1102 (×6) | `no-unused-vars` | `_mesh`,`_fileData`,`_filePath` (rest-sibling) |
| 3 | `components/canvas/SketchCanvas.tsx` :2190 | unused-disable (warn) | stale directive? |
| 3 | `components/viewport3d/Viewport3D.tsx` :1076 | unused-disable (warn) | stale directive? |

Total: 21 errors + 2 warnings.

## Approach

### Item 1 — test-fixture `any` (test-only files; `npm test` runs in build and must stay green)

- **`second_cut_test.ts:40`** — `fakeFeature` returns an object cast `as any` because it omits
  `visible` (required by `SketchFeature`). Fix: add `visible: true` and **drop the cast** — the
  object then satisfies `SketchFeature` honestly.
- **`constraintSolver.test.ts:31,35`** — `transformProfile(profile: any, …)` and `s: any` in the
  `.map`. Type `profile: SketchProfile` and `s: Segment` (from `../types/project`). The existing
  `s.type === 'circle' || s.type === 'arc'` guard narrows to the `center`-bearing members; the else
  branch reads `s.to`, present on every `Segment` member. No cast needed.
- **`constraintSolver.test.ts:279`** — `{ type: 'circle', … } as any` segment literal inside a typed
  profile. The literal is a valid `CircleSegment`; replace `as any` with `satisfies Segment` (or drop
  the cast if the enclosing literal already checks it). Verified by build.
- **`constraintSolver.test.ts:315,517,607,872,1186,1251`** (×6) — `(segments[0] as any).center`
  reads. Add one small test-local helper near the top of the file:
  `function segmentCenter(seg: Segment): Point { if ('center' in seg) return seg.center; throw new Error('expected arc/circle segment') }`
  (both `ArcSegment` and `CircleSegment` carry `center`). Replace all six reads with `segmentCenter(seg)`.
  This removes every `any` honestly and is DRY.

Fallback per parent plan: if completing a type is disproportionate at any single site, use an
explicit narrow `as unknown as X` so the cast is intentional — but the fixes above avoid needing it.

### Item 2 — `_`-prefixed unused vars (fix in code; the rule-option route was declined)

Genuinely removable bindings — delete the param and update the (single, verified) call site:

- **`gpuMesh.ts:159`** — `updateHeightfieldTexture(texture, _dirtyRegion)`. Body ignores the region
  (whole-texture re-upload). Remove the 2nd param; update the lone caller
  `SimulationViewport.tsx:878` to `updateHeightfieldTexture(texture)`. **Verified safe**:
  `getDirtyRegion()` is a pure getter (`return this.frameDirtyRegion`); the actual clear is the
  separate `clearDirtyRegion()` on line 879, which stays. Lightly update the doc comment to note
  dirty-region tracking lives on the playback controller for a future partial-upload optimization.
- **`finishSurfaceWaterline.ts:1553`** — `(_point) => false` is the empty-union branch of a ternary
  whose value is later called as `fn(point)`. Drop the param → `(): boolean => false` (a zero-arg fn
  is assignable to the `(point) => boolean` slot and callable with an arg). No behaviour change.
- **`browser.ts:183`** — `revealInFileManager(_path: string)` is a no-op browser stub. Drop the
  param → `revealInFileManager(): Promise<void>`; a method with fewer params still satisfies the
  platform interface. (Confirm the interface signature doesn't force the arg; if it does, keep the
  param but reference it via `void _path` — decided at build time, removal preferred.)
- **`SketchCanvas.tsx:4976`** — `makeEditInputKeyDown(_field)` never reads `_field`; its three call
  sites pass `'radius'`/`'length'`/`'angle'`. Drop the param and the three args. Behaviour identical
  (Enter/Escape/Tab handling doesn't depend on the field).
- **`pendingActionsSlice.ts:72`** — `_get` is genuinely unused (sibling slices that keep `_get`
  actually reference it, so they aren't flagged). Drop the param; update the single call site
  `projectStore.ts:3126` `createPendingActionsSlice(set, get)` → `createPendingActionsSlice(set)`.

Rest-sibling destructuring — **needs a decision (see Open questions)**:

- **`projectStore.ts:1094,1102`** (×6) — `const { mesh: _mesh, fileData: _fileData, filePath: _filePath, ...rest } = stl`
  strips three transient fields when persisting an imported model. Renaming can't satisfy the rule
  (the bindings exist only to be excluded from `rest`). The chosen option (a/b/c) is applied at both
  sites once the user picks.

### Item 3 — two stale `eslint-disable react-hooks/exhaustive-deps` directives

Both carry "Load-bearing" comments (they claim to make the compiler-backed `react-hooks/refs` /
`react-hooks/immutability` rules bail on the whole file), but lint now reports them as *unused*. Batch C
fixed the underlying ref-mirror writes, so they **may** be genuinely stale now — same trap Batch C
handled. Treat empirically, one at a time:

For **each** directive (`SketchCanvas.tsx:2190`, `Viewport3D.tsx:1076`):
1. Remove the directive (and its now-inaccurate "Load-bearing" comment block).
2. Run `npm run lint` **and** `npm run build` (`tsc -b`).
3. If compiler-backed `react-hooks/immutability` or `react-hooks/refs` errors surface in that file →
   the directive is still load-bearing → **restore it** with a tightened `// … -- reason` comment per
   the suppression policy, and record it in the merge summary as a surviving documented suppression.
4. If lint + build stay clean → it was genuinely stale → leave it removed.

**OUTCOME (2026-06-13): both directives are LOAD-BEARING — restored + documented.**
Removing them surfaced 4 pre-existing masked errors:
- `SketchCanvas.tsx:2242,2247` — 3× `react-hooks/immutability` ("Cannot access variable before it is
  declared"): the `useStableEvent` wrappers reference `handleCanvasPointerMove` / `handleWheelEvent`,
  which are declared ~1700 lines later. Fixing = a declaration reorder in a 5000-line file → deferred
  **Batch C** work, out of scope here.
- `Viewport3D.tsx:1082` — 1× `react-hooks/set-state-in-effect` (`setZoomWindowBox(null)` zoom-window
  reset). Fixing = adjust-during-render conversion → deferred **Batch D** pattern, out of scope here.

Confirmed catch-22: any react-hooks `eslint-disable` makes the React-Compiler rules bail on the whole
file, so ESLint always reports a *kept* directive as an "unused directive" warning (it can't see what
the bail suppresses). A literal 0 baseline is therefore unreachable without doing the deferred Batch C
reorder. Per the suppression policy + the user's decision (2026-06-13: **land as-is, defer fixes**),
both directives are restored with precise `-- reason` comments. **Final `src` lint: 0 errors, 2
documented load-bearing warnings.** Resolving them to true-0 is a follow-up (Batch C/D completion).

(No effect *logic* is touched in either case — we only add/remove a comment directive — so no manual
UI pass is required unless step 3's restore work were to require touching an effect, which is out of
scope here.)

## Files affected

- `src/sketch/constraintSolver.test.ts` — type the 2 helper params, fix the 1 segment literal, add a
  `segmentCenter` helper and route the 6 `.center` reads through it. (test-only)
- `src/store/second_cut_test.ts` — add `visible: true`, drop the `as any`. (test-only)
- `src/engine/simulation/gpuMesh.ts` — drop `_dirtyRegion` param; tweak doc comment.
- `src/components/simulation/SimulationViewport.tsx` — drop the 2nd arg at the call site (line 878).
- `src/engine/toolpaths/finishSurfaceWaterline.ts` — drop `_point` param of the false-branch lambda.
- `src/platform/browser.ts` — drop `_path` param of `revealInFileManager`.
- `src/components/canvas/SketchCanvas.tsx` — drop `_field` param + 3 args (item 2); remove the
  stale directive at :2190 if build stays clean (item 3).
- `src/store/slices/pendingActionsSlice.ts` — drop `_get` param.
- `src/store/projectStore.ts` — drop `_get` arg at :3126; apply the chosen rest-sibling fix at
  :1094/:1102.
- `src/components/viewport3d/Viewport3D.tsx` — remove the stale directive at :1076 if build stays
  clean (item 3).
- `planning/INDEX.md` — register this plan, then move it to **In progress** on approval.

No new source files → no new Apache headers, no new `INDEX.md`. (The rest-sibling `omit` helper, if
the user picks option (b), lives inline in `projectStore.ts`, not a new file.)

## Tests

No new unit tests — this batch is typing/dead-binding cleanup with no engine logic change. Coverage
is the existing suite, which runs inside `npm run build`:

- `constraintSolver.test.ts` and `second_cut_test.ts` are themselves tests — they must continue to
  pass with the honest typing.
- `gpuMesh` / `finishSurfaceWaterline` / `projectStore` changes are behaviour-neutral and are exercised
  by existing structural tests.

Verification gate:
```
npm run lint    # target: 0 src problems (or only documented line-level suppressions)
npm run build   # icons + tsc + tests + vite
git diff --check
```

## Open questions / risks

1. **`projectStore.ts` rest-sibling destructuring (×6) — pick one** (parent plan flags this as the one
   decision for Batch E):
   - **(a) explicit shallow copy + `delete`** — `const rest = { ...stl }; delete rest.mesh; delete rest.fileData; delete rest.filePath;`. Local, no rule change, no new abstraction. Slightly more verbose at two sites.
   - **(b) tiny typed `omit(obj, keys)` helper** — one inline helper in `projectStore.ts`, both sites become `omit(stl, ['mesh','fileData','filePath'])`. DRY, but adds a small generic helper to maintain.
   - **(c) narrow `ignoreRestSiblings: true` on `@typescript-eslint/no-unused-vars` in `eslint.config.js`** — much narrower than the broad `^_` ignore that was declined; keeps the idiomatic
     rest-destructuring code untouched, but is a rule-option change (the category that was previously
     declined, albeit a far narrower one).

   **DECIDED (2026-06-13): option (c).** Add `ignoreRestSiblings: true` to the
   `@typescript-eslint/no-unused-vars` options in `eslint.config.js`; leave the rest-destructuring in
   `projectStore.ts:1094/1102` as-is (revert the `_`-prefix renames to plain `mesh`/`fileData`/`filePath`
   so the discarded keys read naturally). Scoped to exactly this legitimate pattern; materially narrower
   than the declined `^_` ignore.

2. **Item 3 directives may be load-bearing.** If removing either surfaces compiler-backed
   `immutability`/`refs` errors, the directive is restored with a documented reason (a surviving
   line-level suppression, listed in the merge summary). The build/lint run decides; no guesswork.

## Out of scope

- Everything in Batches A–D (typed boundaries, shared hooks, RAF/SketchCanvas deps, set-state-in-effect)
  — already merged.
- The underlying ref-mirror / immutability conversions in `SketchCanvas.tsx` / `Viewport3D.tsx` beyond
  removing the now-stale directives. If item 3 step 3 finds a directive still load-bearing, the fix is
  to keep the documented suppression, **not** to convert the masked errors here.
- Any change to lint rule *severity*. Option (c) above is a rule-*option* (ignoreRestSiblings) only,
  applied solely if the user picks it.
