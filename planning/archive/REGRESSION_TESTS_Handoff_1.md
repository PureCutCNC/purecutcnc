# Regression Tests — Handoff 1: Geometry-fidelity + Lifecycle

Implementation handoff. Read `AGENTS.md`, root `planning/INDEX.md`, and
`planning/REGRESSION_TESTS_Plan.md` first (this implements its **Phase 1 + Phase 2**). Follow
Plan → confirm scope → Implement. You own ONLY this slice's worktree; finish with ONE simple commit
and a report. Do not merge, open a PR, or run browser validation.

## Branch / base / worktree

- Integration branch: `feature-references-v2` (base `85530b…` → use the current tip of
  `origin/feature-references-v2`).
- Slice branch: **`regression-tests-1-geometry-lifecycle`**
- Worktree: `/Users/frankp/Projects/worktrees/purecutcnc/regression-tests-1-geometry-lifecycle`
- Setup (no `npm install`):
  ```bash
  git -C /Users/frankp/Projects/purecutcnc worktree add \
    /Users/frankp/Projects/worktrees/purecutcnc/regression-tests-1-geometry-lifecycle \
    -b regression-tests-1-geometry-lifecycle origin/feature-references-v2
  cd /Users/frankp/Projects/worktrees/purecutcnc/regression-tests-1-geometry-lifecycle
  ln -s /Users/frankp/Projects/purecutcnc/node_modules node_modules
  ```

## Why this exists

Two recent bugs — circle-radius edit producing a huge circle, and composite **arcs being flattened to
splines** — were pure-function failures in `resolveProfile` / `transformProfileAffine` that no test
caught. This handoff builds the systematic matrix that would have caught them, plus the basic feature
lifecycle. **Tests only** — do not change product code (if a test reveals a real bug, STOP and report
it; do not "fix" it to make the test pass).

## Conventions (match existing suites)

Model the files on `src/store/editInPlace.test.ts`:
- Local `assert(cond, msg)`, `approx(a,b,eps=1e-6)`, `pointEq(a,b,eps)`, a `resetStore(project?)`,
  `let passed/failed`, `function test(name, fn)`, top-level `test(...)` calls, and a final
  `console.log(\`\n${passed} passed, ${failed} failed\`)` + `if (failed>0) process.exit(1)`.
- No test-framework import. Tests are auto-discovered by `scripts/run-tests.ts` and run in `npm test`.
- Determinism only: fixed coordinates, epsilon compares, no `Date.now()`/random.

## Store/helper surface to drive (real actions — verify signatures in `src/store/types.ts`)

- Create: `addRectFeature(name,x,y,w,h,depth)`, `addCircleFeature(name,cx,cy,r,depth)`,
  `addEllipseFeature(name,cx,cy,rx,ry,depth)`, `addPolygonFeature(name,points,depth)`,
  `addSplineFeature(name,points,depth)`. For `composite`(with an `arc`), `text`, `stl`: build a
  `SketchFeature` literal and call `addFeature(feature)` (see the arc-composite example in
  `editInPlace.test.ts` and the slice-10 tests).
- Edit: `enterSketchEdit(id)`, `moveFeatureControl(id, control, point)`, `applySketchEdit()`,
  `cancelSketchEdit()`.
- Transform: `selectFeature(id)` + `startMoveFeature`/`startResizeFeature`/`startRotateFeature`/
  `startMirrorFeature` → `setPendingMoveFrom(p)` → `completePendingMove(toPoint)` (move); for
  rotate/resize/mirror check the pending-* completion actions in `types.ts`/`pendingCompletionSlice.ts`.
- References: `startCopyFeature(id)` / `completePendingMove` (duplicate), `makeUnique(id)`,
  `deleteFeatures(ids)`, `undo()`, `redo()`.
- Helpers: `resolveFeatureInstance(project, id)`, `resolveProfile(definition, transform)`,
  `getInstanceIdsForDefinition`, `getDefinitionId` (`src/store/helpers/...`); matrix builders in
  `instanceTransforms.ts` (`translateMatrix`, `rotateMatrix`, `scaleMatrix`, `multiplyMatrix`),
  `IDENTITY_MATRIX` from `types/project`.

## Phase 1 — `src/store/geometryFidelity.test.ts`

Transform classes to cover: `identity`, `translate(100,50)`, `rotate(30°)`, `uniformScale(2)`,
`mirror` (across an axis), `nonUniform(2,1)`.

For each `FeatureKind` (`rect`, `circle`, `ellipse`, `polygon`, `spline`, `composite`-with-arc,
`text`, `stl`):

1. **resolveProfile fidelity.** Build the definition, call `resolveProfile(def, M)` for each class.
   Assert:
   - A known reference point maps to the expected world coordinate (compute expected via the matrix).
   - **Segment kinds:** `circle` stays `'circle'` and `arc` stays `'arc'` under the *similarity*
     classes (identity/translate/rotate/uniformScale/mirror); both become `'bezier'` under
     `nonUniform`. `line`/`bezier` segments stay their kind. Under `mirror`, `clockwise` flips.
   - (`text`/`stl`: assert kind preserved and `text`/`stl` data carried; skip segment-geometry.)
2. **Edit round-trip.** Create via the store; `enterSketchEdit`; make a representative edit
   (`moveFeatureControl` a non-defining point; for `circle`, move the radius anchor index 0; for
   `composite`, edit a line vertex and leave the arc); `applySketchEdit`. Assert the resolved
   segment-kinds + geometry are intact and the **definition** holds the canonical untransformed shape.
3. **Duplicate-as-reference.** `startCopyFeature(id)` → `completePendingMove({x:offset,y:0})`. Assert
   the copy shares `definitionId`, preserves segment-kinds, and resolves at the offset.
4. **Per-kind transforms.** move / rotate / resize / mirror via the store actions; assert the
   instance `transform` is right and the resolved kind is preserved (e.g. resized circle stays a
   circle; moved arc-composite keeps its arc).

## Phase 2 — `src/store/featureLifecycle.test.ts`

- **Create→definition:** each kind mints a `FeatureDefinition` + identity instance (`transform`
  present, `definitionId` set).
- **Save/load round-trip:** `JSON.stringify(project)` → `openProjectFromText(text, null)` →
  re-serialize; assert byte-equivalent for (a) each kind individually and (b) a mixed project with a
  linked pair + an independent copy + a made-unique instance; assert `meta.copyMode` and the linked
  relationships (shared `definitionId`) survive.
- **Undo/redo:** create → `undo()` (gone) → `redo()` (back); an edit → `undo()` restores pre-edit
  geometry; a transform → `undo()` restores position.
- **Delete→GC:** delete the last instance of a definition → the definition is removed from
  `project.featureDefinitions`; `undo()` restores both the instance and its definition. Deleting one of
  two linked instances keeps the definition.

## Out of scope
- No product-code changes (tests only). No browser tests (Phase 4). No audit-fill of editing/boolean/
  CAM suites (that's Handoff 2). Don't touch other worktrees or non-test files except the nearest
  `INDEX.md`.

## Acceptance criteria
- New suites `geometryFidelity.test.ts` + `featureLifecycle.test.ts` exist, are deterministic, and
  print `N passed, 0 failed`.
- They genuinely exercise the **real** store actions/helpers (not re-implementations).
- `npm run build` (tsc -b + full `npm test` + vite) green.
- If any assertion reveals a real product bug, the test is left failing/`.skip`-documented and the bug
  is reported — NOT worked around.
- Nearest `INDEX.md` updated.

## Final report (report back to management; do NOT merge)
```
Branch:
Worktree:
Commit(s):
Files changed:
Coverage added:   (kinds × transforms matrix; lifecycle cases)
Any real bugs surfaced:   (list, with the failing assertion — do not fix)
Verification run:   (suite counts + npm run build)
Known gaps / deferred:
```
