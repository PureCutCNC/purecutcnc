# Feature References Handoff 05: Definition Editing

## Assignment

Make sketch/shape editing operate on the **shared `FeatureDefinition`** so that edits
propagate to every linked instance, following the canonical target model in the plan with no
shortcuts:

- Entering sketch edit on an instance opens the **canonical untransformed definition**
  (definition-local space), even when the instance has a non-identity transform.
- All profile/shape edits mutate `definition.profile` / `definition.dimensions` /
  `definition.kind` (and `text`/`stl` where relevant).
- After any definition edit, **re-bake the compatibility `sketch.profile`** of every instance
  that references that definition, each through its own instance `transform`, so all linked
  instances and un-migrated direct readers stay correct.
- Provide a `makeUnique(instanceId)` **store helper** that clones the definition and repoints
  the selected instance so subsequent definition edits no longer affect it. (Wiring this into
  UI/context-menu is slice 07; this slice only provides and tests the store mechanism.)

This is an implementation-agent task. Management owns review, browser validation, merging,
ledger updates, and pushing the integration branch.

This is a larger slice than 04: it touches the sketch-edit interaction in
`src/components/canvas/SketchCanvas.tsx` as well as the store. Stay strictly within the scope
below; do not opportunistically refactor the canvas.

## Why this slice is needed (current state)

After slices 01–04:

- `FeatureDefinition` holds the canonical, untransformed `profile` / `dimensions` / `text` /
  `stl` / `kind` / `operation`. Persisted rows are still compatibility `SketchFeature` objects
  carrying optional `definitionId?` / `transform?` (read by `resolveDefinitionAndTransform()`).
  Transitional rows without an explicit `definitionId` resolve by `feature.id`.
- Read paths (slice 03) resolve `definition.profile × transform`.
- Transform commands (slice 04) compose onto `instance.transform` and re-bake the
  compatibility `sketch.profile`.
- **But shape edits still mutate the instance row's `sketch.profile` directly.** The
  profile-edit store actions in `src/store/projectStore.ts` (built on pure helpers
  `insertPointIntoProfile`, `deleteAnchorFromProfile`, `deleteSegmentFromProfile`,
  `disconnectProfileAtAnchor`, `filletFeatureFromRadius`/`filletFeatureFromPoint`, circle
  radius edit, etc.) write the compatibility row, not the definition. So an edit does not
  propagate to linked instances, and for a transformed instance the edit is authored in world
  space rather than definition-local space.

Slice 05 closes this by making the definition the edit target.

## Branch and Worktree

- Integration branch: `feature-references`
- Integration base commit: `c070fa6`
- Slice branch: `feature-references-05-definition-editing`
- Slice worktree: `/Users/frankp/Projects/worktrees/purecutcnc/feature-references-05-definition-editing`

Create the worktree from the current pushed integration branch:

```bash
cd /Users/frankp/Projects/purecutcnc
git fetch origin
git worktree add /Users/frankp/Projects/worktrees/purecutcnc/feature-references-05-definition-editing origin/feature-references -b feature-references-05-definition-editing
cd /Users/frankp/Projects/worktrees/purecutcnc/feature-references-05-definition-editing
```

Before editing, verify:

```bash
git branch --show-current
git status --short --branch
git rev-parse --short HEAD
```

Stop if the branch/worktree does not match this assignment, or if the base is not `c070fa6`
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
- `planning/FEATURE_REFERENCES_Plan.md` — especially **Resolver boundary**,
  **Operation semantics matrix**, **Circle and scale handling**, **Definition lifetime**,
  and **UI surface** (the "Edit Sketch opens the canonical untransformed definition" rule).
- `planning/FEATURE_REFERENCES_Ledger.md`
- `planning/FEATURE_REFERENCES_Handoff_03_Read_Paths.md`
- `planning/FEATURE_REFERENCES_Handoff_04_Transform_Commands.md`
- `src/INDEX.md`, `src/store/INDEX.md`, `src/components/INDEX.md`
- `src/store/helpers/resolveFeatures.ts` (resolver + `resolveProfile`/`resolveSketch`/matrix helpers)
- `src/store/helpers/instanceTransforms.ts` (matrix helpers from slice 04)
- `src/store/featureResolver.test.ts`

Use codebase-memory-mcp graph tools first for code discovery. Fall back to text search only
for docs/config/literals or when graph results are insufficient.

## Current Model Reference

- Types in `src/types/project.ts`: `FeatureDefinition`, `FeatureInstance`, `Matrix2D`,
  `IDENTITY_MATRIX`, `SketchFeature` (compatibility row).
- `resolveDefinitionAndTransform(project, feature)` resolves the definition (explicit
  `definitionId`, else by `feature.id`) and the `transform` (default identity).
- `resolveProfile(definition, transform)` / `resolveSketch(definition, transform)` map
  definition-local geometry to world space; `applyMatrixToPoint` is the shared point map.
- Sketch-edit mode: `selection.mode === 'sketch_edit'`, `selection.selectedFeatureId`,
  and `sketchEditSession` (`{ entityType, entityId, snapshot, pastLength }`) in the store.
- Profile-edit pure helpers in `src/store/projectStore.ts`:
  `insertPointIntoProfile`, `deleteAnchorFromProfile`, `deleteSegmentFromProfile`,
  `disconnectProfileAtAnchor`, `filletFeatureFromRadius`, `filletFeatureFromPoint`,
  plus the circle-radius edit path. These are invoked by store actions inside
  `useProjectStore`. Confirm exact action names and call sites with graph tools before editing.
- `normalizeProject()` builds definitions only when none exist; once definitions exist they
  are preserved. Feature rows pass through normalization via spreads, so extra fields persist.

## Required Design (plan-faithful, no shortcuts)

1. **Edit target = definition.** Every shape/profile edit resolves the selected instance to
   its `definitionId` (explicit, or `feature.id` for transitional rows) and mutates
   `project.featureDefinitions[definitionId]` in **definition-local** space. Do not author
   edits on the instance's world-space `sketch.profile`.

2. **Edit-sketch entry is definition-local.** When `sketch_edit` mode is active for an
   instance, the canvas edits the canonical untransformed definition geometry. For an instance
   with a non-identity transform this intentionally shows the unplaced shape (per the plan:
   "this may look different from the placed instance"). Hit testing, preview points, snapping,
   and dimension anchors used during sketch edit operate in definition-local space. Do not
   bake the instance transform into the edited geometry while editing.

3. **Propagation / re-bake.** Add a single shared helper (e.g.
   `src/store/helpers/featureDefinitions.ts`) that, given a `definitionId`, re-bakes every
   referencing instance row's compatibility geometry:
   `feature.sketch.profile = resolveProfile(definition, feature.transform ?? IDENTITY)` and the
   matching `kind` / `origin` / `orientationAngle` / `stl` silhouette. Call it after every
   definition edit so all linked instances and un-migrated direct readers update together.

4. **Circle handling (per plan).**
   - Editing a circle's radius in sketch edit mutates the definition's circle radius and
     propagates to every instance (each instance stays a circle at its own transform).
   - Adding a point to / breaking a circle converts the **shared definition** from circle
     `kind` to an editable profile/composite; every linked instance reflects the converted
     definition. Do not convert only the instance.

5. **Make Unique store helper.** Add `makeUnique(instanceId)` (store action + helper): clone
   the definition under a fresh definition id, set the instance's explicit `definitionId` to
   the clone, and re-bake. After Make Unique, edits to the original definition must not affect
   the now-unique instance, and undo must restore the linkage. Expose it on the store for
   slice 07 to wire into UI; **do not add UI / context-menu / badges here.**

6. **Definition lifetime is unchanged here.** Deleting instances / GC of unused definitions is
   not part of this slice (slice 01 handles deletion-time GC; do not expand it).

7. **Undo/redo.** Definition edits and Make Unique must be ordinary undoable store mutations
   consistent with existing history handling (the `sketchEditSession.snapshot` / history model).

## Scope

Allowed scope:

- `src/store/projectStore.ts` — route profile/shape-edit actions (insert/delete point, delete
  segment, disconnect, fillet, move point, circle radius, circle→profile conversion) to mutate
  the definition + call the re-bake helper; add `makeUnique`; adjust sketch-edit entry/exit so
  editing is definition-local.
- *(new)* `src/store/helpers/featureDefinitions.ts` — definition mutation helpers, instance
  re-bake, definition clone, `makeUnique` logic, reference lookup (instances of a definition).
  Reuse `resolveProfile` / `applyMatrixToPoint` from `resolveFeatures.ts`; do not duplicate.
- `src/components/canvas/SketchCanvas.tsx` (and the minimal canvas edit/snapping/dimension
  helpers it calls) — source editable geometry from the definition in `sketch_edit` mode and
  commit edits to the definition. Make only the changes required for definition-local editing.
- `src/store/types.ts` — extend `SketchEditSession` or add selectors only if needed.
- Focused tests + nearest `INDEX.md` updates.

Out of scope (do not touch):

- Duplicate as Reference / Duplicate Independent / Select Linked Instances / linked badges /
  Properties panel shared-vs-instance grouping / project `copyMode` (slice 07). Only the
  `makeUnique` store mechanism belongs here, with no UI.
- Join / cut / offset snapshot behavior (slice 06).
- Changing `Project.features` from `SketchFeature[]` to `FeatureInstance[]`.
- Removing the compatibility `sketch.profile` cache or migrating remaining direct readers.
- Transform commands (slice 04 is done) beyond what re-bake composition requires.
- Backdrop/stock-image editing.
- Browser validation, integration merge/push, final PR.

## Acceptance Criteria

- Entering sketch edit on a feature edits the canonical untransformed definition; the edit
  mutates `project.featureDefinitions[definitionId]`, not just the instance row.
- All profile-edit commands (insert point, delete anchor, delete segment, disconnect, fillet,
  move point, circle radius) write the definition and re-bake every referencing instance.
- A definition shared by ≥2 instances (constructed in a test) propagates a single edit to the
  resolved geometry of **all** its instances, each at its own transform.
- Adding a point to a circle converts the shared definition's `kind` from circle to an
  editable profile/composite; all linked instances reflect the conversion.
- Editing a transformed instance's shape composes correctly: resolved geometry equals
  `definitionEdit` mapped through the instance `transform` (definition-local edit, then placement).
- `makeUnique(instanceId)` clones the definition and repoints the instance; subsequent edits to
  the original definition do not affect the unique instance; undo restores the link.
- Identity-migrated single-instance features remain behavior-equivalent for the same edits
  (resolved geometry matches pre-slice behavior).
- `npm run build` passes from the slice worktree, unless blocked by an unrelated pre-existing
  failure documented with evidence.
- Final step is a single simple commit on `feature-references-05-definition-editing`.

## Required Tests

Use the repo's existing direct `npx tsx ...` test style. Prefer focused tests close to the
code touched. Add e.g. `src/store/definitionEditing.test.ts` covering at minimum:

- editing a definition profile propagates to two instances sharing that `definitionId`
  (resolved geometry of both updates), each respecting its own transform;
- a profile edit through a transformed instance writes definition-local geometry such that
  `resolveProfile(definition, transform)` equals the expected world-space result;
- circle radius edit propagates to all instances and keeps them circles;
- adding a point to a circle converts the shared definition kind for all instances;
- `makeUnique` breaks propagation (original-definition edit no longer affects the unique
  instance) and undo restores linkage;
- identity-migrated single-instance edit remains equivalent to the pre-slice result.

Run and record:

```bash
npx tsx src/store/definitionEditing.test.ts
# plus any other focused tests you add/extend
npm run build
```

## Browser Validation

Reserved for management. Do not start or attach to a Chrome debug/browser automation instance
for this slice unless management explicitly revises this handoff.

## Definition of Done

1. Changes implemented within the assigned scope.
2. Focused definition-editing tests added and passing.
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
Edit-sketch definition-local approach:
Propagation / re-bake approach:
makeUnique approach:
Verification run:
Browser validation: Not run; reserved for management.
Known gaps:
Manual/browser/tablet validation needed:
```
