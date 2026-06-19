# Feature References Handoff 04: Transform Commands

## Assignment

Make the feature transform commands (move / rotate / resize / mirror / align / distribute)
record the change on the **instance transform matrix** so resolver-based read paths
(introduced in slice 03) reflect the new placement, while preserving existing behavior for
non-linked / identity-migrated features.

This is an implementation-agent task. The management session owns review, browser
validation, merging into the integration branch, ledger updates, and pushing the
integration branch.

## Why this slice is needed (current state)

After slices 01–03:

- Persisted rows are still compatibility `SketchFeature` objects (`Project.features` is still
  `SketchFeature[]`), carrying optional `definitionId?` / `transform?` fields read by
  `resolveDefinitionAndTransform()` in `src/store/helpers/resolveFeatures.ts`.
- Core read paths (canvas hit testing, snapping/dimensions, CAM/toolpath target geometry)
  now read **resolved** world geometry: `definition.profile` mapped through the row's
  `transform` (defaulting to `IDENTITY_MATRIX` for transitional rows).
- **But the transform commands have not changed.** `moveFeature` / `rotateFeatureFromReference`
  / `resizeFeatureFromReference` / `mirrorFeatureFromReference` in `src/store/projectStore.ts`
  bake the transform into `feature.sketch.profile` and leave `transform` at identity.

Net effect today: a move/rotate/resize/mirror updates the baked `sketch.profile` but **not**
the instance `transform`, so the resolver-based read paths from slice 03 would render the
feature at its definition-local (pre-move) position. Slice 04 closes that gap by writing the
matrix.

## Branch and Worktree

- Integration branch: `feature-references`
- Integration base commit: `946e3b3`
- Slice branch: `feature-references-04-transform-commands`
- Slice worktree: `/Users/frankp/Projects/worktrees/purecutcnc/feature-references-04-transform-commands`

Create the worktree from the current pushed integration branch:

```bash
cd /Users/frankp/Projects/purecutcnc
git fetch origin
git worktree add /Users/frankp/Projects/worktrees/purecutcnc/feature-references-04-transform-commands origin/feature-references -b feature-references-04-transform-commands
cd /Users/frankp/Projects/worktrees/purecutcnc/feature-references-04-transform-commands
```

Before editing, verify:

```bash
git branch --show-current
git status --short --branch
git rev-parse --short HEAD
```

Stop if the branch/worktree does not match this assignment, or if the base is not `946e3b3`
or a management-approved newer `feature-references` commit.

## Worktree Environment Setup

Before running tests/build, create a `node_modules` symlink to the main project checkout if
the worktree does not already have one:

```bash
ln -s /Users/frankp/Projects/purecutcnc/node_modules node_modules
```

Run this from the slice worktree root. Do not run `npm install` unless the symlink is
unavailable or broken and management/user approval is obtained. This slice should not change
dependency files.

## Required Reading

Read these first from the slice worktree:

- `INDEX.md`
- `planning/INDEX.md`
- `planning/FEATURE_REFERENCES_Plan.md` (especially **Transform semantics** and
  **Circle and scale handling**)
- `planning/FEATURE_REFERENCES_Ledger.md`
- `planning/FEATURE_REFERENCES_Handoff_02_Resolver.md`
- `planning/FEATURE_REFERENCES_Handoff_03_Read_Paths.md`
- `src/INDEX.md`
- `src/store/INDEX.md`
- `src/store/helpers/resolveFeatures.ts`
- `src/store/featureResolver.test.ts`
- `src/store/projectStoreTransform.test.ts`

Use codebase-memory-mcp graph tools first for code discovery. Fall back to text search only
for docs/config/literals or when graph results are insufficient.

## Current Model State

Relevant types in `src/types/project.ts`:

- `Matrix2D` `{ a, b, c, d, e, f }` and `IDENTITY_MATRIX`.
- `FeatureDefinition` — canonical untransformed `profile`, `dimensions`, `text`, `stl`,
  `operation`, `kind`.
- `FeatureInstance` — `definitionId`, `transform: Matrix2D`, per-instance metadata.
- Persisted rows are still `SketchFeature`; the migration carries the reference fields as
  optional extras read by `resolveDefinitionAndTransform()`.

Existing resolver/matrix helpers in `src/store/helpers/resolveFeatures.ts`:

- `resolveFeatureInstance`, `resolveFeatureInstances`, `resolveSketch`, `resolveProfile`,
  `resolveDefinitionAndTransform`.
- `applyMatrixToPoint`, `isIdentityMatrix`, `isCirclePreservingTransform`, `isMirrorTransform`.
- There is **no** matrix builder / multiply (compose) helper in the resolver helpers yet.
  Matrix builders exist only in import code (`src/import/normalize.ts`, `src/import/dxf.ts`)
  and must not be reused/coupled here.

Current transform commands (pure helpers in `src/store/projectStore.ts`, called from
`src/components/canvas/SketchCanvas.tsx` drag interactions, then committed back to the store):

- move/translate: `translateProfile`, `translatePoint`, related move-commit path
- `rotateFeatureFromReference` (~1430)
- `resizeFeatureFromReference` (~1357), plus `featureResizeBasis`, `snappedResizeScales`,
  `scaleNumericZSpan`
- `mirrorFeatureFromReference` (~1466), plus `mirrorProfile`, `mirrorDirectionAcrossAxis`,
  `mirrorAngleAcrossLine`
- shared: `transformProfile`, `transformProfileAffine`, `transformStlFeatureData`,
  `rotatePointAround`

Confirm the exact current call/commit sites with graph tools before editing — do not assume.

## Required Design (read carefully)

The instance `transform` matrix is the **source of truth** for placement. Each transform
command must:

1. Build the affine delta matrix for the gesture using new local matrix helpers:
   - `move:   M' = T(dx,dy) · M`
   - `rotate: M' = T(pivot) · R(angle) · T(-pivot) · M`
   - `scale:  M' = T(pivot) · S(sx,sy) · T(-pivot) · M`
   - `mirror: M' = Mirror(axis) · M`
   where `M` is the instance's current `transform` (default `IDENTITY_MATRIX`).
2. Write the composed `M'` back onto the persisted row's `transform` field.
3. **Keep the compatibility `sketch.profile` in sync** as a derived projection so the many
   direct `feature.sketch.profile` readers not yet migrated by slice 03 keep working. The
   safe rule: after updating `transform`, set the row's compatibility geometry to the
   resolver's output for that row — i.e. `sketch.profile`, `sketch.origin`,
   `sketch.orientationAngle`, and `stl` silhouette equal `definition.profile`/`stl` mapped
   through `M'`. For identity-migrated features `definition.profile === sketch.profile`, so
   this stays byte-equivalent with today's incremental baking for a single instance.

This dual-write keeps resolver read paths (slice 03) and legacy direct readers in agreement.
A later slice can drop the compatibility `sketch.profile` cache once all readers are
resolver-based; do not attempt that removal here.

Circle/scale rules (from the plan):

- Uniform resize keeps circles circular: a uniform scale matrix must satisfy
  `isCirclePreservingTransform()` and resolve as a circle with effective radius. Preserve
  current uniform-circle-resize behavior exactly.
- Non-uniform scale of a circle is **not** introduced here; keep whatever restriction current
  circle resize already enforces. Do not loosen it.

Mirror:

- Compose a mirror matrix onto `transform`; the resolver already normalizes winding via
  `isMirrorTransform()` on the read side. Verify the resolved mirrored profile matches the
  previously baked mirror result for an identity-migrated feature (handedness / winding).

## Scope

Allowed scope:

- Add a new matrix-helper module, e.g. `src/store/helpers/instanceTransforms.ts`
  (per the plan's "Files affected"), with: matrix builders (translate/rotate/scale/mirror),
  `multiplyMatrix`/compose, pivoted composition, and any classification helpers needed. Reuse
  `applyMatrixToPoint` / `isIdentityMatrix` / `isCirclePreservingTransform` /
  `isMirrorTransform` from `resolveFeatures.ts`; do not duplicate them.
- Convert move / rotate / resize / mirror / align / distribute commands so they compose and
  persist `instance.transform` and dual-write the compatibility `sketch.profile` as defined
  above.
- Update `SketchCanvas`/store commit paths only as much as needed to thread the new matrix
  result through (no broad canvas refactor).
- Add focused matrix-helper and transform-command tests.
- Update nearest `INDEX.md` files for any new files/tests.

Out of scope (do not touch):

- Definition editing / sketch edit mutating definitions (slice 05).
- Circle-to-profile conversion, radius edit propagation (slice 05).
- Make Unique / Duplicate as Reference / Duplicate Independent / linked badges / Properties
  panel grouping (slice 07).
- Join / cut / offset snapshot behavior (slice 06).
- Changing `Project.features` from `SketchFeature[]` to `FeatureInstance[]`.
- Removing the compatibility `sketch.profile` cache or migrating remaining direct readers.
- Backdrop/stock-image transforms (`resizeBackdropFromReference`, `rotateBackdropFromReference`,
  `backdropResizeBasis`) — these are not feature instances; leave them unchanged.
- Browser validation.
- Integration-branch merge or push.
- Final PR creation.

## Acceptance Criteria

- Move / rotate / resize / mirror / align / distribute update the selected instance's
  `transform` matrix; the resolver reads the moved geometry at its new world position.
- The compatibility `sketch.profile` (and `origin`, `orientationAngle`, `stl` silhouette)
  stays consistent with the resolved geometry after each command, so un-migrated direct
  readers remain correct.
- Identity-migrated single-instance projects remain behavior-equivalent: existing
  `src/store/projectStoreTransform.test.ts` assertions still pass (extend, do not regress).
- Uniform circle resize still resolves as a circle; circle resize restrictions are unchanged.
- Mirror produces the same resolved winding/orientation as the previously baked behavior for
  an identity-migrated feature.
- Transforming one instance does **not** mutate the shared `FeatureDefinition` (verify with a
  feature row that has an explicit `definitionId`).
- New matrix helpers have focused unit tests (compose order, pivoted rotate/scale/mirror,
  identity/circle-preserving/mirror classification).
- `npm run build` passes from the slice worktree, unless blocked by an unrelated pre-existing
  failure documented with evidence.
- The final step is a simple commit on `feature-references-04-transform-commands`.

## Required Tests

Use the repo's existing direct `npx tsx ...` test style. Prefer focused tests close to the
code touched.

- Extend `src/store/projectStoreTransform.test.ts` (or a new
  `src/store/instanceTransforms.test.ts`) to cover at minimum:
  - move updates `transform` and leaves the definition profile unchanged;
  - rotate around a pivot composes correctly and resolves to the rotated world position;
  - uniform resize keeps a circle circular (`isCirclePreservingTransform` true) and scales
    the effective radius;
  - mirror flips winding/handedness in the resolved profile matching prior behavior;
  - identity-migrated feature remains byte-equivalent through a no-op / round-trip transform;
  - transforming an explicit-`definitionId` instance does not mutate
    `project.featureDefinitions[definitionId].profile`.
- Matrix-helper unit tests for the new builders/compose.

Run and record:

```bash
npx tsx src/store/projectStoreTransform.test.ts
# plus any new test file you add
npm run build
```

## Browser Validation

Reserved for management. Do not start or attach to a Chrome debug/browser automation
instance for this slice unless management explicitly revises this handoff.

## Definition of Done

1. Changes are implemented within the assigned scope.
2. Focused matrix-helper and transform-command tests are added/updated and pass.
3. `npm run build` is run from the slice worktree.
4. New source/test files are listed in the nearest `INDEX.md`.
5. The slice branch has one simple final commit.
6. Report back to management using the format below.

## Final Report Format

```md
Branch:
Worktree:
Commit(s):
Files changed:
Behavior implemented:
Transform commands routed onto instance.transform:
Compatibility profile sync approach:
Verification run:
Browser validation: Not run; reserved for management.
Known gaps:
Manual/browser/tablet validation needed:
```
