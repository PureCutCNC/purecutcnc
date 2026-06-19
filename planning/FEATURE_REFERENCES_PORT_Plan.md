# Feature References — PORT onto current `main`

## Why this exists

The `feature-references` integration branch (slices 01–06, all merged & tested) was built on a
**June-3 base** (`29d0d16`). Since then `main` advanced ~179 commits, dominated by the
**core-arch-simplification refactor**, which decomposed the ~7,000-line monolithic
`src/store/projectStore.ts` into a 363-line shell plus ~23 new slices/helpers. Every store
function the feature slices edited has **moved out of `projectStore.ts`** into new files.

A `git merge` is therefore not viable (it would conflict massively and duplicate the
FR-edited functions across the dead monolith and main's new slice files). **This is a PORT:
re-apply each slice's behavior onto the functions in their new homes on `main`.**

## Branch / worktree

- Port branch: `feature-references-v2` (off current `origin/main` = `9615e63`).
- Worktree: `/Users/frankp/Projects/worktrees/purecutcnc/feature-references-v2`
- `node_modules` is symlinked to the main checkout. Do not `npm install`.

## Source of truth for the FR changes

The old branch `origin/feature-references` holds the authoritative behavior. Extract exact
changes via git — do **not** guess. Useful references:

- Whole FR change set since the old base: `git diff 29d0d16 origin/feature-references -- <path>`
- Per-slice net diffs (first-parent of each merge commit):
  - Slice 01 migration — merge `69e14aa` (`git diff 69e14aa^ 69e14aa`)
  - Slice 02 resolver — merge `fa9bc45`
  - Slice 03 read-paths — merge `6f0506f`
  - Slice 04 transform commands — merge `278643c`
  - Slice 05 definition editing — merge `cb8a25a`
  - Slice 06 snapshot ops — merge `e48c1dc`
- Design intent & risks: `planning/FEATURE_REFERENCES_Plan.md`,
  `planning/FEATURE_REFERENCES_Ledger.md`, and the per-slice handoffs (all carried into this
  worktree under `planning/`).

## File classification

### A. Wholesale ports (brand-new files on FR; none exist on main)

Copy verbatim from `origin/feature-references`, then fix import paths/signatures to match
main (see reconciliations):

- `src/store/helpers/resolveFeatures.ts` (slice 02 — resolver + matrix helpers)
- `src/store/helpers/featureDefinitions.ts` (slices 05/06 — rebake/clone/makeUnique/snapshot/GC)
- `src/store/helpers/instanceTransforms.ts` (slice 04 — matrix builders) **← RECONCILE, see below**
- Tests: `src/store/featureReferencesMigration.test.ts`, `src/store/featureResolver.test.ts`,
  `src/components/canvas/hitTest.test.ts`, `src/engine/toolpaths/resolverReadPath.test.ts`,
  `src/store/instanceTransforms.test.ts`, `src/store/definitionEditing.test.ts`,
  `src/store/snapshotOps.test.ts`
- Planning docs under `planning/` (already brought into this worktree).

### B. Additive type changes

- `src/types/project.ts` — add `Matrix2D`, `IDENTITY_MATRIX`, `FeatureDefinition`,
  `FeatureInstance`, and the `Project.featureDefinitions` field. These auto-merged cleanly
  against main; apply the additions, keeping main's other changes to this file.

### C. Re-apply behavioral changes onto main's new homes

| FR change (slice) | On the old monolith | **Target on main** |
|---|---|---|
| Migration: build `featureDefinitions`, version `2.0` (01) | `projectStore.ts` `normalizeProject` | `src/store/projectStore.ts` `normalizeProject` (still here, line ~91) |
| Resolver read-paths (03) | `hitTest.ts`, `snappingHelpers.ts`, `dimensions.ts`, toolpaths `resolver.ts` | same paths on main — re-apply onto main's current versions |
| Transform: compose onto `instance.transform` + dual-write (04) | `rotate/resize/mirrorFeatureFromReference` in `projectStore.ts` | `src/store/helpers/referenceTransforms.ts` |
| Transform: copy builders (04) | `buildCopiedFeatures`/`buildRotatedCopies` | `src/store/helpers/copyFeatures.ts` |
| Transform: move/align/distribute (04) | `projectStore.ts` actions + `completePendingMove` | `src/store/slices/featureSlice.ts` (`alignFeatures`, `distributeFeatures`), `src/store/slices/pendingCompletionSlice.ts` (`completePendingMove`) |
| Definition editing: profile-edit → definition + rebake (05) | `projectStore.ts` profile-edit actions + helpers (`insertPointIntoProfile`, `deleteAnchor…`, `disconnect…`, fillet) | `src/store/helpers/profileEdit.ts` (helpers) + `src/store/slices/featureGeometrySlice.ts` (actions); fillet in `src/store/helpers/referenceTransforms.ts` |
| Definition editing: sketch-edit lifecycle profile swap (05) | `selectionSlice.ts` `enterSketchEdit`/`applySketchEdit` | `src/store/slices/selectionSlice.ts` (and stock variant in `workpieceSlice.ts` — note the stock known-gap) |
| Snapshot ops: resolve inputs + def/instance outputs + GC (06) | `createDerivedFeature`, `mergeSelectedFeatures`/`cutSelectedFeatures`/`offsetSelectedFeatures` in `projectStore.ts`; factory threading in `derivedFeatures.ts` | `src/store/slices/featureSlice.ts` (the actions) + `src/store/helpers/derivedFeatures.ts` (factory) |
| Action interface + signatures: `makeUnique`, changed returns (05/06) | `projectStore.ts` `types.ts` | `src/store/types.ts` |
| `SketchCanvas.tsx` small unpack/usage (03/06) | `SketchCanvas.tsx` | `src/components/canvas/SketchCanvas.tsx` (main rewrote this file — re-apply the few FR lines onto main's version) |
| INDEX.md updates | `src/store/INDEX.md`, `src/engine/toolpaths/INDEX.md`, `planning/INDEX.md` | same paths — merge entries |

## Reconciliations (do not create duplicates)

1. **`instanceTransforms.ts` vs main `helpers/transform.ts` / `helpers/referenceTransforms.ts`.**
   main already has `rotatePointAround`, `mirrorProfile`, `transformProfileAffine`,
   `translateProfile`, `transformStlFeatureData`, `arcToBezierSegments`, etc. in `transform.ts`,
   and the `*FromReference` functions in `referenceTransforms.ts`. The FR `instanceTransforms.ts`
   adds **matrix** builders/compose (`translateMatrix`, `rotateMatrix`, `scaleMatrix`,
   `multiplyMatrix`, `pivotTransform`, `moveDelta`/`rotateDelta`/`scaleDelta`/`mirrorDelta`).
   Keep `instanceTransforms.ts` as the matrix-helper module; do **not** duplicate point/profile
   helpers that already exist in `transform.ts` — import those from `transform.ts` instead.
2. **`syncIdCounter` def-id gap (port fix).** main's `src/store/helpers/ids.ts` `syncIdCounter`
   scans features/folders/tools/operations/tabs/clamps but **not** `featureDefinitions`. Slice
   06 mints `def-NNNN` ids via `nextUniqueGeneratedId`. Add `featureDefinitions` keys to the id
   scan in `syncIdCounter` (and to the `usedIds` set in `nextUniqueGeneratedId`) so def ids are
   collision-safe across save/reload. (This fixes the robustness gap recorded in the ledger.)
3. **`resolveDefinitionAndTransform` raw-fallback contract (slice 03).** Preserve the slice-03
   read-path contract: explicit-missing `definitionId` → skip/null (no raw fallback); transitional
   rows without `definitionId` → fall back to raw `feature.sketch.profile`. Verify main's
   read-path consumers honor this after re-application.
4. **`normalizeProject` ordering (slice 01).** Definitions are built AFTER legacy normalization +
   `dedupeProjectIds` + tree sync, and only when none exist (`needsMigration`). Preserve that
   ordering on main's `normalizeProject`.

## Verification

From the worktree:

```bash
# FR focused tests (must pass)
npx tsx src/store/featureReferencesMigration.test.ts
npx tsx src/store/featureResolver.test.ts
npx tsx src/components/canvas/hitTest.test.ts
npx tsx src/engine/toolpaths/resolverReadPath.test.ts
npx tsx src/store/instanceTransforms.test.ts
npx tsx src/store/projectStoreTransform.test.ts
npx tsx src/store/definitionEditing.test.ts
npx tsx src/store/snapshotOps.test.ts
# full gate (tsc -b + entire npm test suite + vite). MUST be green — proves main's
# existing tests still pass alongside the ported FR work.
npm run build
```

`npm run build` passing is the hard gate: it runs `tsc -b`, the full `npm test` suite
(main's tests + all ported FR tests), and `vite build`.

## Known risks to carry forward (validate in final integration / browser)

- Features with non-zero `sketch.origin`/`orientationAngle`: `src/engine/csg.ts` and
  `transformFeatureProfile` read these raw; rebake forces them to 0 (fine for normal 0/0
  features, unverified for stock-source/some imports).
- `enterStockSketchEdit`/stock-source sketch edit does not swap to definition-local (slice 05
  known gap) — `workpieceSlice.ts` on main.
- Transformed linked instance edited through the full store+canvas pipeline not yet
  browser-validated.
- The general **creation-definition gap** (draw/text/import don't mint definitions) is still
  open and must be addressed before slice 07 (Duplicate as Reference). NOT part of this port.

## Out of scope for the port

- Slice 07 (UI workflow) and 08 (integration verification) — resume after the port lands.
- The creation-definition gap (separate slice, decided before 07).
- Removing the compatibility `sketch.profile` cache / `Project.features` → `FeatureInstance[]`.

## Definition of done (port)

1. All Phase-A files present; Phase-B behavior re-applied to the mapped homes; reconciliations done.
2. `syncIdCounter` def-id fix applied.
3. All FR focused tests pass; `npm run build` green (main's suite + FR tests).
4. Nearest `INDEX.md` files updated; planning docs present.
5. One coherent commit (or a small, logical sequence) on `feature-references-v2`.
6. Report: files changed, where each slice's behavior landed, reconciliation decisions,
   verification output, and anything that could not be ported cleanly.
