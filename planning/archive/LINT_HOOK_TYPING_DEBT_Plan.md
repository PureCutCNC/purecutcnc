---
status: Done
created: 2026-06-11
---

# Lint Hook & Typing Debt Plan

## Goal

Design (not yet implement) the cleanup of the remaining non-mechanical `src` lint debt — after the mechanical cleanup landed (approved Batches 2–4), the remaining baseline is **51 errors / 23 warnings**: React hook/ref hygiene in interactive UI, `setState`-in-effect patterns in toolbar/dialog components, production `any` at three geometry/import/text boundaries, plus the items declined from the mechanical plan (test-fixture `any`, `_`-prefixed unused vars). Each batch below is sized to be one reviewable PR with its own verification.

## Inventory of remaining debt

| Category | Rule | Sites |
|---|---|---|
| Effect deps | `react-hooks/exhaustive-deps` (20 warn) | `SketchCanvas.tsx` ×19, `App.tsx:411` |
| setState in effect | `react-hooks/set-state-in-effect` (8 err) | `Toolbar.tsx` ×3, `ExportDialog.tsx`, `ToolRail.tsx`, `TopCommandBar.tsx`, `TextToolDialog.tsx` |
| Render-time ref writes | `react-hooks/refs` (3 err) | `FeatureTree.tsx:679-680`, `useAxisLock.ts:28` |
| Production `any` | `@typescript-eslint/no-explicit-any` (20 err) | `text/index.ts` ×11, `store/helpers/clipping.ts` ×3, `store/helpers/derivedFeatures.ts` ×3, `profilePrimitives.ts`, `import/dxf.ts:501`, `import/normalize.ts:86` |
| Test-fixture `any` | `@typescript-eslint/no-explicit-any` (10 err) | `sketch/constraintSolver.test.ts` ×9, `store/second_cut_test.ts` (declined Batch 5 of the mechanical plan) |
| `_`-prefixed unused vars | `@typescript-eslint/no-unused-vars` (11 err) | `projectStore.ts` ×6 (rest-sibling destructuring), `SketchCanvas.tsx`, `gpuMesh.ts`, `finishSurfaceWaterline.ts`, `platform/browser.ts`, `pendingActionsSlice.ts` (declined Batch 1 rule-option change) |
| Masked compiler errors | `react-hooks/immutability` ×13, `react-hooks/refs` ×2 (latent) | Suppressed today by the three "unused" `eslint-disable react-hooks/exhaustive-deps` directives (`SketchCanvas.tsx:2316`, `SimulationViewport.tsx:1263`, `Viewport3D.tsx:1067`) — any react-hooks disable directive makes the compiler-backed rules bail on the file. Removing the directives during Batch C will surface them; budget accordingly. |

## Approach — implementation batches

### Batch A — typed boundaries (low risk, no UI behavior)

1. **`segmentEndPoint(seg, profileStart)` helper** in `src/components/canvas/profilePrimitives.ts` or `src/engine/toolpaths/geometry.ts`: returns `seg.to` for line/arc segments and `profileStart` for circles, with a proper discriminated-union narrow instead of `(seg as any).to`. Fixes `profilePrimitives.ts:25`, `import/dxf.ts:501`, `import/normalize.ts:86`, and any future copies of the pattern.
2. **Typed Clipper open-path wrapper.** `clipping.ts`/`derivedFeatures.ts` cast because `clipper-lib` typings omit the open-path overload of `AddPath` and `Clipper.OpenPathsFromPolyTree`. Add a small module (e.g. `src/engine/clipperOpenPaths.ts`) that declares these two signatures once (`addOpenSubject(clipper, path)`, `openPathsFromPolyTree(tree): IntPoint[][]`) and use it at all 6 sites. One honest `as` cast inside the wrapper, documented; zero `any` at call sites.
3. **Typed font parser wrapper.** `text/index.ts` calls `fontLoader.parse(json as any)` ×11 because Three's `FontLoader.parse` expects `FontData` and the imported JSON modules are untyped. Add `parseFontJson(data: unknown): Font` in `src/text/fontData.ts` that does the single documented cast. Call sites become clean.

Risk: very low — pure typing. Verification: `npm run build` (structural tests cover toolpath/import engines), plus open one DXF/SVG import and one text feature in the browser as a sanity check.

### Batch B — event-listener & callback-ref hygiene (medium risk)

Shared helpers (new `src/hooks/` or `src/utils/react/`):

- **`useStableEvent(fn)`** — returns a stable identity wrapper whose `.current` is updated in a `useInsertionEffect`/`useLayoutEffect` (not during render). Replaces the hand-rolled `ref.current = fn` render-write pattern.
- **`useWindowEvent(type, handler)` / `useDocumentEvent(type, handler)`** — subscribe once, route through `useStableEvent`, so effects stop depending on unstable handlers.

Apply to:
- `useAxisLock.ts:28` (`onLockChangeRef.current = onLockChange` during render → `useStableEvent`); its window keydown listener → `useWindowEvent`.
- `FeatureTree.tsx:679-680` (`moveUpRef/moveDownRef` render writes → `useStableEvent`).
- `SketchCanvas.tsx:2382/2398` (`handleCanvasPointerMove`, `handleWheelEvent` missing-dep warnings) — listeners become `useWindowEvent`/element-scoped equivalents with stable wrappers.

Risk: medium — pointer/keyboard interaction paths. Verification: build + manual browser pass over sketch drag, axis-lock cycling (Alt), feature-tree reorder; **tablet check required** for pointer interactions on SketchCanvas (touch drag, pinch zoom).

### Batch C — RAF scheduling and SketchCanvas effect deps (highest risk, do last)

`SketchCanvas.tsx`'s 19 warnings cluster around `scheduleDraw`, snap/preview-ref setters, and edit-state effects with complex dependency expressions (`dimensionEdit`, `constraintEdit`, `operationDimEdit`, …).

- **`useRafScheduler()`** — returns a stable `schedule()` that coalesces redraws into one `requestAnimationFrame`; replaces ad-hoc `scheduleDraw` closures so it can be listed as a dep (or omitted safely because stable).
- Extract complex dep expressions (`xxxEdit ? xxxEdit.key : null`) to named locals so the rule can check them (`2161`, `2170`, `2179`, `2226`).
- Add genuinely missing deps where the effect logic is idempotent; where re-running would re-trigger interaction state, restructure to refs via `useStableEvent` rather than suppress.
- `App.tsx:411` — drop the unnecessary `toolpathMap` dep from the `useMemo` (verify the memo body really doesn't read it).
- `2101` ref-cleanup warning — copy `canvasRef.current` to a local inside the effect.

Risk: high — this is the core drawing/interaction surface. Each effect is changed individually with before/after testing. Verification: full sketch workflow in browser (draw, move, offset, transform, dimension edit, constraint edit, fillet, snap) and **the same pass on a tablet** (coarse pointer, no hover).

### Batch D — portal/tooltip positioning and dialog state (`set-state-in-effect`)

Two distinct shapes:

1. **Portal positioning** (`Toolbar.tsx:93,1210`, `ToolRail.tsx:101`): `useLayoutEffect` computes popover coords and calls `setCoords(null)` when closed. Proposed **`usePortalPosition(anchorRef, open)`** helper: derive "closed → null" during render (`const coords = open ? measured : null`) and only measure in the layout effect, calling `setState` from resize/scroll subscriptions (legitimate external-system pattern). One helper, three call sites — this is also a step toward the `TOOLBAR_REVISIT.md` structural split, not a conflict with it.
2. **Prop-driven state reset** (`Toolbar.tsx:266`, `TopCommandBar.tsx:74` — `setNameVal(project.meta.name)` when not editing; `TextToolDialog.tsx:42` — font fallback; `ExportDialog.tsx:74` — `setPreviewResult(null)`): replace with the React-recommended patterns — derive the value during render where possible (name display can derive from `editingName ? nameVal : project.meta.name`), or key-based reset / `if (prev !== x) setState` during render. Each site is small but **changes when state resets**, so each needs its dialog/toolbar flow exercised manually.

Risk: medium. Verification: build + manual pass over project rename (Toolbar + TopCommandBar), export dialog preview, text dialog style/font switching, toolbar popovers/tooltips on desktop **and tablet** (ToolRail/Toolbar are tablet-critical per `TABLET_UX_COMBINED_PLAN.md`).

### Batch E — leftovers declined from the mechanical plan (low risk, needs one decision)

The two batches declined at the mechanical-plan approval land here so they have an owner:

1. **Test-fixture `any` (10 err).** `sketch/constraintSolver.test.ts` ×9 and `store/second_cut_test.ts` build fixtures via `as any`. Fix by completing the fixtures to satisfy `SketchFeature`/related types (preferred — fits naturally alongside Batch A's typing work), falling back to an explicit `as unknown as X` only where completing the type is disproportionate.
2. **`_`-prefixed unused vars (11 err).** The rule-options approach (`varsIgnorePattern: '^_'` etc.) was declined, so these must be fixed in code: delete the genuinely removable bindings (`_field`, `_get`, `_path`, `_dirtyRegion`, `_point`) or fold them into the signature/logic. The 6 `projectStore.ts` errors are rest-sibling omission destructuring (`const { mesh: _mesh, ...rest } = stl`), which *cannot* be fixed without restructuring — the realistic code-level options are (a) build `rest` via explicit `delete` on a shallow copy, or (b) a tiny typed `omit(obj, keys)` helper. **Decision needed at implementation time**: pick (a)/(b), or revisit the rule-option change for `ignoreRestSiblings` only (narrower than what was declined).

Risk: low (tests + state-normalization helper; `npm test` covers both). Verification: `npm run build`.

## Suppression policy

- No blanket disables. A line-level suppression is acceptable only where the rule is wrong about a verified-safe pattern, and must carry a `-- reason` comment (e.g. an effect that intentionally runs only on mount for a one-time subscription whose deps are stable wrappers).
- Expected end state: 0 errors; warnings either fixed or individually annotated. Any surviving suppression is listed in the implementing PR description.

## Files affected

(per batch, see above; new files)
- *(new)* `src/hooks/useStableEvent.ts`, `useWindowEvent.ts`, `useRafScheduler.ts`, `usePortalPosition.ts` (final naming/location to match repo convention; `src/hooks/INDEX.md` if a new folder is created)
- *(new)* `src/engine/clipperOpenPaths.ts`, `src/text/fontData.ts`, `segmentEndPoint` helper location TBD at implementation

## Tests

- Batch A: unit tests for `segmentEndPoint` (line/arc/circle) and the Clipper open-path wrapper (open path clipped by closed polygon — count survivors). Font wrapper is exercised by existing text tests if present, otherwise a parse smoke test.
- Batches B–D are UI hooks; structural tests don't cover them — verification is the manual browser/tablet matrix above. `useRafScheduler` gets a unit test with a mocked RAF.

## Open questions / risks

- Order: A (typing) can land any time; B before C (C builds on `useStableEvent`); D independent; E can ride along with A or land standalone. OK to interleave with feature work?
- Batch E item 2 needs a decision on the `projectStore.ts` rest-destructuring sites: explicit copy/`omit` helper in code, or a narrow `ignoreRestSiblings: true` rule option (the broad `^_` ignore patterns were declined).
- Should the helpers live in a new `src/hooks/` folder (needs an `INDEX.md`) or under `src/utils/`?
- `usePortalPosition` overlaps with the planned `Toolbar.tsx` structural split (`TOOLBAR_REVISIT.md`) — implementing it here is intentionally a partial step; flag if you'd rather batch D wait for that UX pass.

## Out of scope

- Mechanical fixes (separate plan, `LINT_SRC_MECHANICAL_CLEANUP_Plan.md`).
- The full `Toolbar.tsx` structural split and toolbar UX revisit.
- Any change to lint rule severity for the hook rules.
