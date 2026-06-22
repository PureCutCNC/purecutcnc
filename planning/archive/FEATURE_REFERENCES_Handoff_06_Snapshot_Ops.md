# Feature References Handoff 06: Snapshot Operations

## Assignment

Make the destructive snapshot operations — **join / cut / offset** (and any boolean
combine/union that shares the same derived-feature path) — plan-faithful in the
definition/instance model:

1. **Resolve inputs** to world-space geometry through the resolver, instead of reading raw
   `feature.sketch.profile`.
2. **Create fresh snapshot definitions + instances** for the results: one new
   `FeatureDefinition` per result (profile = the world-space snapshot geometry), and one
   `FeatureInstance` per result with an **identity** transform and an explicit `definitionId`.
3. **Preserve existing `keepOriginals` behavior** (delete vs keep consumed inputs).
4. **Leave linked siblings untouched** — consuming one instance of a shared definition must
   not alter other instances of that definition.

This is an implementation-agent task. Management owns review, browser validation, merging,
ledger updates, and pushing the integration branch.

No shortcuts (consistent with slice 05): snapshot results become real definitions + instances,
not raw definition-less rows.

## Why this slice is needed (current state)

After slices 01–05:

- `createDerivedFeature` (`src/store/projectStore.ts`) builds derived features as compatibility
  `SketchFeature` rows with **no definition** and no explicit `definitionId`. They render only
  via the slice-03 **raw fallback** (transitional rows without a `definitionId` fall back to
  `feature.sketch.profile`).
- The snapshot inputs are gathered with `selectedClosedFeaturesFromIds`
  (`src/store/helpers/derivedFeatures.ts`), which reads **raw** `feature.sketch.profile`. For
  migrated/transformed features the baked compatibility profile happens to equal world space
  (dual-write), so it works today — but it is not routed through the resolver, which is the
  source of truth.

Slice 06 makes inputs resolver-sourced and outputs real definitions/instances.

## IMPORTANT — known cross-slice gap (read before scoping)

No runtime creation path (`createDerivedFeature`, draw/text/import) currently creates a
`FeatureDefinition`; only the slice-01 migration does. New features rely on the raw fallback.

For THIS slice: create definitions for the **snapshot outputs only**, via a small shared
helper you add (see Design). **Do not** convert unrelated creation paths (plain rectangle/
circle/text draw, import) in this slice — that is a separate concern flagged to management for
sequencing before slice 07. Keep your changes scoped to the join/cut/offset/combine result
paths.

## Branch and Worktree

- Integration branch: `feature-references`
- Integration base commit: `ef95941`
- Slice branch: `feature-references-06-snapshot-ops`
- Slice worktree: `/Users/frankp/Projects/worktrees/purecutcnc/feature-references-06-snapshot-ops`

Create the worktree from the current pushed integration branch:

```bash
cd /Users/frankp/Projects/purecutcnc
git fetch origin
git worktree add /Users/frankp/Projects/worktrees/purecutcnc/feature-references-06-snapshot-ops origin/feature-references -b feature-references-06-snapshot-ops
cd /Users/frankp/Projects/worktrees/purecutcnc/feature-references-06-snapshot-ops
```

Before editing, verify:

```bash
git branch --show-current
git status --short --branch
git rev-parse --short HEAD
```

Stop if the branch/worktree does not match this assignment, or if the base is not `ef95941`
or a management-approved newer `feature-references` commit.

## Worktree Environment Setup

```bash
ln -s /Users/frankp/Projects/purecutcnc/node_modules node_modules
```

Run from the slice worktree root if `node_modules` is missing. Do not run `npm install` unless
the symlink is unavailable/broken and management/user approval is obtained. This slice should
not change dependency files.

## Required Reading

From the slice worktree:

- `INDEX.md`, `planning/INDEX.md`
- `planning/FEATURE_REFERENCES_Plan.md` — especially **Join / cut / offset snapshots**,
  **Operation semantics matrix**, **Definition lifetime**.
- `planning/FEATURE_REFERENCES_Ledger.md`
- `planning/FEATURE_REFERENCES_Handoff_03_Read_Paths.md`,
  `planning/FEATURE_REFERENCES_Handoff_05_Definition_Editing.md`
- `src/INDEX.md`, `src/store/INDEX.md`
- `src/store/helpers/resolveFeatures.ts` — `resolveFeatureInstance`, `resolvedProjectFeatures`,
  `resolveProfile`.
- `src/store/helpers/featureDefinitions.ts` — slice-05 definition helpers (clone, rebake,
  `getDefinitionId`, `getInstanceIdsForDefinition`).
- `src/store/helpers/derivedFeatures.ts` — `createDerivedFeature` factory usage,
  `cutFeaturesByCutterGrouped`, `previewOffsetFeaturesWithFactory`,
  `collectDerivedFeaturesFromPolyTree`, `insertDerivedFeaturesAfterSources`,
  `selectedClosedFeaturesFromIds`.
- `src/store/projectStore.ts` — `createDerivedFeature`, `joinOpenProfiles`, the cut/offset/
  combine store actions (confirm exact action names with graph tools).

Use codebase-memory-mcp graph tools first for code discovery.

## Current Model Reference

- `FeatureDefinition` { id, kind, profile, dimensions, text, stl, operation }.
- `FeatureInstance` placement = `transform: Matrix2D` (use `IDENTITY_MATRIX` for snapshots —
  the result geometry is already world-space).
- Persisted rows are compatibility `SketchFeature` with optional `definitionId?` / `transform?`.
- `resolveFeatureInstance(project, id)` / `resolvedProjectFeatures(project)` give resolved
  world-space features; `getDefinitionId(feature)` resolves the definition id of a row.
- `normalizeProject` only builds definitions during initial migration; it preserves existing
  definitions otherwise, and feature rows pass through via spreads (extra fields persist).

## Required Design

1. **Resolve inputs.** Where snapshot ops gather source geometry (today
   `selectedClosedFeaturesFromIds` and the cut/offset input collection), source the geometry
   from the resolver (`resolveFeatureInstance` / `resolvedProjectFeatures`) so the boolean/
   offset runs on canonical world geometry. Keep operation-target identification by instance
   ID unchanged.

2. **Snapshot output = definition + instance.** Add a small helper (in
   `src/store/helpers/featureDefinitions.ts`, e.g. `createSnapshotDefinition(project, {
   profile, kind, operation }) → { definitionId, definition }`) that mints a new definition id
   (reuse the project id system — `nextUniqueGeneratedId` style — rather than a parallel
   counter) with `profile` = the world-space result. Then each derived/result row is created
   with an explicit `definitionId` pointing at that definition and `transform = IDENTITY`. Merge
   the new definitions into `project.featureDefinitions` in the same store mutation. The
   compatibility `sketch.profile` stays equal to the result geometry (identity bake).

3. **`keepOriginals`.** Preserve the existing delete-vs-keep behavior for consumed inputs
   exactly. Do not change how originals are removed or retained.

4. **Siblings untouched.** Consuming one instance must not mutate the definition of a different
   instance. Because snapshots create *new* definitions and only remove/keep the consumed
   instance rows, sibling instances of any shared input definition must remain byte-identical.
   Add a test for this.

5. **Definition GC on consumed inputs.** If `keepOriginals` is false and removing a consumed
   instance leaves its definition with zero remaining instances, the now-unused definition
   should be removed in the same undoable mutation (consistent with slice-01 deletion GC). If a
   removed instance's definition is still referenced by a surviving sibling, keep the
   definition. Do not over-engineer GC beyond this.

6. **Undo/redo.** Snapshot mutations remain ordinary undoable store actions; new definitions and
   instances appear/disappear together with undo/redo.

## Scope

Allowed:

- `src/store/projectStore.ts` — `createDerivedFeature` and the join/cut/offset/combine store
  actions: resolve inputs, create definitions for outputs, merge into `featureDefinitions`,
  GC consumed definitions, preserve `keepOriginals`.
- `src/store/helpers/derivedFeatures.ts` — thread definition creation through the derived-
  feature factory/collection helpers as needed.
- `src/store/helpers/featureDefinitions.ts` — add `createSnapshotDefinition` (and any small
  GC helper) reusing existing resolution/clone helpers.
- Focused tests + nearest `INDEX.md` updates.

Out of scope (do not touch):

- Converting unrelated creation paths (plain draw of rect/circle/polygon/spline, text, import)
  to create definitions — flagged separately for management/slice-07 sequencing.
- Duplicate as Reference / Independent / Make Unique UI / Select Linked / badges / Properties
  grouping / `copyMode` (slice 07). (`makeUnique` store helper already exists from slice 05.)
- Changing `Project.features` from `SketchFeature[]` to `FeatureInstance[]`.
- Removing the compatibility `sketch.profile` cache.
- Definition-editing/transform-command behavior (slices 04/05 are done).
- Browser validation, integration merge/push, final PR.

## Acceptance Criteria

- Join / cut / offset (and boolean combine if it shares the derived path) read input geometry
  through the resolver.
- Each snapshot result is a real `FeatureDefinition` + a `FeatureInstance` with an explicit
  `definitionId` and identity transform; `project.featureDefinitions` contains the new defs.
- `keepOriginals` behavior is unchanged (verified for both keep and delete).
- Sibling instances of a shared input definition are byte-identical after the operation
  (snapshot does not mutate other instances' definitions).
- When `keepOriginals` is false and a consumed instance was the last one referencing its
  definition, that definition is GC'd in the same undoable action; undo restores both the
  instances and the definitions.
- Existing join/cut/offset tests still pass (e.g. `src/store/openProfileJoin.test.ts`,
  `src/store/second_cut_test.ts`, `src/engine/toolpaths/toolpaths.test.ts`).
- A transformed input instance produces a snapshot whose definition profile equals the
  resolved world geometry of the input (not its definition-local profile).
- `npm run build` passes from the slice worktree, unless blocked by an unrelated pre-existing
  failure documented with evidence.
- Final step is a single simple commit on `feature-references-06-snapshot-ops`.

## Required Tests

Use the repo's `npx tsx ...` style. Add e.g. `src/store/snapshotOps.test.ts` covering:

- cut/offset/join result is a definition + instance (new `featureDefinitions` entry, instance
  has explicit `definitionId`, identity transform);
- `keepOriginals=true` keeps inputs; `keepOriginals=false` removes them (and GCs orphaned
  definitions);
- snapshotting one instance of a 2-instance shared definition leaves the sibling's resolved
  geometry and definition unchanged;
- snapshot of a transformed input uses resolved world geometry for the result definition;
- undo restores instances + definitions.

Run and record:

```bash
npx tsx src/store/snapshotOps.test.ts
npx tsx src/store/openProfileJoin.test.ts
npx tsx src/store/second_cut_test.ts
npm run build
```

## Browser Validation

Reserved for management. Do not start or attach to a Chrome debug/browser automation instance
for this slice unless management explicitly revises this handoff.

## Definition of Done

1. Changes implemented within the assigned scope.
2. Focused snapshot-op tests added and passing; existing join/cut/offset tests still pass.
3. `npm run build` run from the slice worktree.
4. New source/test files listed in the nearest `INDEX.md`.
5. One simple final commit on the slice branch.
6. Report back to management using the format below.

## Final Report Format

```md
Branch:
Worktree:
Commit(s):
Files changed:
Behavior implemented:
Inputs resolved through resolver:
Snapshot output definition/instance approach:
keepOriginals + definition GC approach:
Sibling-isolation handling:
Verification run:
Browser validation: Not run; reserved for management.
Known gaps:
Manual/browser/tablet validation needed:
```
