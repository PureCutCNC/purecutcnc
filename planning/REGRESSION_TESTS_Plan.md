---
status: In progress
created: 2026-06-21
---

# Regression Test Suite — Basic App Functions

## Goal

A cohesive regression layer over the app's basic user functions, led by the gap that let the
recent **circle-radius** and **arc-flattening** bugs through: nothing systematically verified that
*every shape kind survives every transform / edit / round-trip with its geometry and segment kinds
intact*. Both were pure-function failures in `resolveProfile` / `transformProfileAffine` — catchable
at the store/helper level with no browser.

This plan adds to the existing **58** `*.test.ts` suites (it does not restart them). It targets the
**gaps**, not re-coverage.

## Approach & conventions

- **Primary: store-level integration tests** (`npx tsx`). They are auto-discovered by
  `scripts/run-tests.ts` (`src/**/*.test.ts`) and run in `npm test` (the build gate). Drive the
  **real store actions** (`addCircleFeature`, `enterSketchEdit`, `completePendingMove`,
  `startCopyFeature`, `makeUnique`, …) and the real helpers (`resolveProfile`, `resolveFeatureInstance`).
- **Test style:** match the existing suites (e.g. `src/store/editInPlace.test.ts`): a local
  `assert()` + `test(name, fn)` with `passed`/`failed` counters, top-level execution, `process.exit(1)`
  on failure, a final `console.log(\`${passed} passed, ${failed} failed\`)`. No test framework import.
- **Reset between tests** via a `resetStore(project?)` helper (see `editInPlace.test.ts`).
- **Determinism:** no `Date.now()`/random; use fixed coordinates and `approx()`/`pointEq()` with an
  epsilon for float compares.
- **Browser smoke** (canvas renders, tree/badge/properties, save→reload, no console errors) needs a
  running dev server + Chrome — it does NOT fit the `npx tsx` runner. Treated as **management manual
  validation** for now; a real automated browser harness (Playwright) is a separate, optional future
  effort (see Phase 4).

## What's already covered (audit — do NOT duplicate)

- Transforms/instances: `instanceTransforms.test.ts`, `projectStoreTransform.test.ts`.
- References model: `featureReferencesMigration`, `featureResolver`, `creationDefinitions`,
  `duplicateReference`, `definitionEditing`, `editInPlace`, `linkedConstraintResolve`, `snapshotOps`.
- Editing/profile: `profileEdit`, `polygonSplit`, `openProfileJoin`, `offsetSimplify`, `hitTest`.
- Constraints/sketch: `constraintSolver`, `dimensions`, `useAxisLock`.
- CAM/engine: `toolpaths`, `roughSurface`, `finishSurface(+Cleanup)`, `vcarveRecursive`,
  `meshSlicing`, `clamps`, `resolverReadPath`, `toolSelection`, `operationValidity`,
  `operationBooklet`, `postprocessor` (gcode), `modelExport/stl`, simulation.
- Import: `camj`, `obj`, `stl`. Misc: `units`, `fontData`, `project.test.ts`.

The **gaps** below are not systematically covered today.

## The matrix (gaps, priority order)

### Phase 1 — Geometry-fidelity matrix  ⟵ highest value (handoff 1)
For each `FeatureKind` = `rect | circle | ellipse | polygon | spline | composite(with arc) | text | stl`:

1. **resolveProfile fidelity** under each transform class:
   `identity`, `translate`, `rotate`, `uniform-scale`, `mirror`, `non-uniform`.
   Assert (a) a known reference point maps to the expected world coordinate, and (b) **segment kinds
   are preserved correctly**: `circle`→`circle` and `arc`→`arc` under similarity (identity/translate/
   rotate/uniform/mirror), but →`bezier` under non-uniform/shear; `line`/`bezier` preserved; mirror
   flips `clockwise`. (This is exactly what the circle + arc bugs violated.)
2. **Edit round-trip** through the real pipeline: create → `enterSketchEdit` → a representative edit
   (move a point; for circle, move the radius anchor; for composite, leave the arc untouched) →
   `applySketchEdit`. Assert the feature's resolved kind/segment-kinds and geometry are intact, and the
   definition stores the canonical (untransformed) shape.
3. **Duplicate-as-reference**: copy preserves kind & segment-kinds and shares `definitionId`.
4. **Per-kind transforms** (`move`/`rotate`/`resize`/`mirror` via store actions): instance `transform`
   correct and resolved kind preserved; resized circle stays a circle; etc.

Representative construction: use `addRectFeature`/`addCircleFeature`/`addEllipseFeature`/
`addPolygonFeature`/`addSplineFeature` where they exist; for `composite`(with an `arc`), `text`, and
`stl`, build a `SketchFeature` literal and call `addFeature` (see the arc example in
`editInPlace.test.ts` / the slice-10 work). `text`/`stl` carry no editable profile — assert kind +
`text`/`stl` data survive round-trip/copy instead of segment geometry.

### Phase 2 — Feature lifecycle (handoff 1, same suite or sibling)
- **Create** each kind → mints a `FeatureDefinition` + identity instance (extends `creationDefinitions`).
- **Save/load round-trip**: `JSON.stringify(project)` → `openProjectFromText` is byte-equivalent for
  each kind, and for a **mixed linked/unique/independent** project; `meta.copyMode` and links survive.
- **Undo/redo**: create / edit / transform / delete each push history and restore correctly.
- **Delete → GC**: deleting the last instance of a definition removes the definition; undo restores both.

### Phase 3 — Audit-and-fill (handoff 2)
Audit the existing editing / boolean-snapshot / constraint / CAM suites against the basic-function
checklist and add tests ONLY for identified holes. Candidates likely thin today:
- Each sketch-edit op (insert/delete point, fillet, disconnect, arc handle, profile break, open-join)
  asserted to **preserve segment kinds** and propagate to linked instances.
- Each CAM operation type (`pocket`, profile/edge in/out, `vcarve`, drill, surface rough/finish) has a
  **smoke test**: generates a toolpath for a basic feature without throwing, and the result posts to
  G-code. Cross-check the operation-type list in `src/types/project.ts` (~line 425) against existing
  toolpath tests; add the missing ones.
- Stock / tabs / clamps basic create+edit; align/distribute on ≥3 features.

### Phase 4 — Browser smoke (Playwright) (handoff: Phase 4)
**Decided (2026-06-21, user): build a thin Playwright smoke.** Not part of `npm test` — a separate
`npm run test:e2e` the user runs before each manual session. Covers the one layer the store suites
can't reach: DOM render + menu→action wiring (the class that produced the blank-badge and row-overflow
bugs). Seeds project state through a minimal dev/test-guarded `window.__pcTest` seam, asserts through
the **real DOM** (badge visibility/placement, context-menu items, Make Unique / Select Linked,
duplicate, Edit Sketch enter/exit, Properties grouping, save→load, version warning), fails on any
console error. Explicit non-goals: **no** geometry/coordinate assertions (store suites own that), **no**
pixel/screenshot diffing, **no** WebGL canvas-content checks. Gated by STEP 0 feasibility — if the app
can't boot in plain Chromium without heavy Tauri mocking, the harness is dropped for a manual checklist.
See `REGRESSION_TESTS_Handoff_Phase4_Browser_Smoke.md`.

## Files

- New suites under `src/store/` (store-level) following the existing naming, e.g.
  `geometryFidelity.test.ts`, `featureLifecycle.test.ts`, plus audit-fill suites near the code they
  cover. Auto-discovered — no runner changes. Update the nearest `INDEX.md`.

## Gate

`npm run build` (tsc -b + full `npm test` + vite) must stay green; new suites print
`N passed, 0 failed` and `process.exit(1)` on any failure.

## Handoffs

- **Handoff 1 — Geometry-fidelity + lifecycle** (Phases 1–2): `REGRESSION_TESTS_Handoff_1.md`.
- **Handoff 2 — Audit-and-fill** (Phase 3): `REGRESSION_TESTS_Handoff_2.md` (authored 2026-06-22 after
  H1 landed). Areas A (per-operation CAM smoke — confirmed holes: pocket `parallel`/`waterline`, drill
  cycle types, thin `v_carve`/`surface_clean`/`follow_line`), B (sketch-edit op segment-kind + linked
  propagation for insert/delete/disconnect/arc-handle/profile-break/open-join), C (stock/tabs/
  align-distribute lifecycle — no existing coverage). Audit-first, tests-only, STOP+report on bugs.
- **Handoff Phase 4 — Browser smoke (Playwright)**: `REGRESSION_TESTS_Handoff_Phase4_Browser_Smoke.md`
  (authored 2026-06-21). Independent of H1/H2; may run in parallel (disjoint files — `e2e/` +
  `playwright.config.ts` + a package.json devDep vs H1's `src/store/*.test.ts`) or after H1 to keep the
  package.json edit conflict-free.
