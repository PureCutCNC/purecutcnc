# Feature References Handoff 02: Resolver Contract

## Assignment

Implement the resolver contract for the feature references model introduced in slice 01. This slice should create the explicit boundary that turns persisted definitions + instance rows into resolved world-space sketch features for current consumers.

This is an implementation-agent task. The management session owns review, browser validation, merging into the integration branch, ledger updates, and pushing the integration branch.

## Branch and Worktree

- Integration branch: `feature-references`
- Integration base commit: `b0fa801`
- Slice branch: `feature-references-02-resolver`
- Slice worktree: `/Users/frankp/Projects/worktrees/purecutcnc/feature-references-02-resolver`

Create the worktree from the current pushed integration branch:

```bash
cd /Users/frankp/Projects/purecutcnc
git fetch origin
git worktree add /Users/frankp/Projects/worktrees/purecutcnc/feature-references-02-resolver origin/feature-references -b feature-references-02-resolver
cd /Users/frankp/Projects/worktrees/purecutcnc/feature-references-02-resolver
```

Before editing, verify:

```bash
git branch --show-current
git status --short --branch
git rev-parse --short HEAD
```

Stop if the branch/worktree does not match this assignment, or if the base is not `b0fa801` or a management-approved newer `feature-references` commit.

## Worktree Environment Setup

Before running tests/build, create a `node_modules` symlink to the main project checkout if the worktree does not already have one:

```bash
ln -s /Users/frankp/Projects/purecutcnc/node_modules node_modules
```

Run this from the slice worktree root. Do not run `npm install` unless the symlink is unavailable or broken and management/user approval is obtained. This slice should not change dependency files.

## Required Reading

Read these first from the slice worktree:

- `INDEX.md`
- `planning/INDEX.md`
- `planning/FEATURE_REFERENCES_Plan.md`
- `planning/FEATURE_REFERENCES_Ledger.md`
- `planning/FEATURE_REFERENCES_Handoff_01_Model_Migration.md`
- `src/INDEX.md`
- `src/store/INDEX.md`
- `src/types/project.ts`
- `src/store/projectStore.ts` around `normalizeProject()` and existing transform helpers
- `src/store/projectStoreTransform.test.ts`
- `src/store/featureReferencesMigration.test.ts`

Use codebase-memory-mcp graph tools first for code discovery. Fall back to text search only for docs/config/literals or when graph results are insufficient.

## Current Model State

Slice 01 is merged into integration. It added:

- `Matrix2D`
- `FeatureDefinition`
- `FeatureInstance`
- `IDENTITY_MATRIX`
- `Project.version: '1.0' | '2.0'`
- `Project.featureDefinitions`
- migration tests in `src/store/featureReferencesMigration.test.ts`

Important transitional constraint: `Project.features` is still typed and stored as `SketchFeature[]` for compatibility, even though the target model treats every feature row as an instance. Do not widen this slice into replacing all `SketchFeature` consumers or changing the persisted feature array to `FeatureInstance[]`.

## Scope

Allowed scope:

- Add resolver helpers, preferably under `src/store/helpers/resolveFeatures.ts` unless code discovery shows a better existing helper boundary.
- Define a resolved feature shape that is compatible with today's `SketchFeature` consumers but has an explicit source definition/instance relationship.
- Add matrix/profile transform helpers needed by the resolver, reusing or extracting existing transform logic where practical.
- Implement identity, translate, rotate, uniform scale, and mirror resolution for profiles.
- Implement circle-preservation classification for transforms that keep circles representable as circles.
- Add focused resolver tests.
- Route a very small, low-risk read path through the resolver only if it helps prove the contract without broad behavioral migration.
- Update nearest `INDEX.md` files for any new source/test files.

Out of scope:

- Broad canvas, hit-testing, toolpath, import, or operation read-path migration. That is slice 03.
- Transform commands writing matrices. That is slice 04.
- UI actions for Duplicate as Reference, Make Unique, linked badges, or Properties panel grouping.
- Sketch edit mutation through definitions. That is slice 05.
- Join/cut/offset snapshot behavior. That is slice 06.
- Changing `Project.features` to `FeatureInstance[]`.
- Browser validation.
- Integration-branch merge or push.
- Final PR creation.

## Resolver Contract

Implement helpers with this conceptual shape. Exact names may differ if the codebase points to a better local convention, but the final report must document the names:

```ts
resolveFeatureInstance(project, instanceOrFeatureId): ResolvedSketchFeature | null
resolveFeatureInstances(project, ids?): ResolvedSketchFeature[]
resolveFeatureDefinition(project, definitionId): FeatureDefinition | null
resolveProfile(definition, transform): SketchProfile
resolveSketch(definition, transform): Sketch
isIdentityMatrix(matrix): boolean
isCirclePreservingTransform(matrix): boolean
```

The resolved feature should:

- preserve today's `SketchFeature`-like fields needed by current consumers,
- expose the source `definitionId`,
- expose the source instance/feature ID,
- use world-space `sketch.profile`,
- preserve per-instance metadata such as name, folder, visible, locked, `z_top`, and `z_bottom`,
- preserve definition-owned fields such as kind, operation, profile, text, and STL in resolved form.

Because slice 01 kept compatibility `SketchFeature[]`, the resolver must tolerate the transitional shape:

- If a feature row has `definitionId`, resolve from `project.featureDefinitions[definitionId]`.
- If a feature row does not have `definitionId` but a matching definition exists by feature ID, resolve from `project.featureDefinitions[feature.id]`.
- If no definition exists, return a sensible null/skip result rather than throwing in normal read helpers; tests should pin the chosen behavior.

## Geometry Rules

- Identity transform must return geometry equivalent to the current feature profile.
- Translation moves all relevant profile points.
- Rotation must rotate line endpoints, arc centers, bezier controls, and circle centers around the matrix-implied transform.
- Uniform scale must keep circles as circles with scaled radius/diameter where the existing profile representation supports it.
- Mirror must transform profile geometry and preserve usable winding/arc handedness according to existing app conventions. Reuse existing mirror/transform helpers if possible.
- Non-uniform circle scale should not falsely return a circle unless the representation is honest. If the resolver cannot represent it as a circle, it should document and test the fallback behavior.

## Acceptance Criteria

- Resolver helpers exist behind a clear module boundary and are exported for future slices.
- Identity transform resolution returns a `SketchFeature`-compatible resolved object equivalent to current migrated features.
- Translation, rotation, uniform scale, and mirror transform tests pass for representative line/rect/profile geometry.
- Circle-preserving transform classification is tested.
- Missing definition behavior is explicit and tested.
- The resolver supports the slice 01 transitional compatibility shape without requiring broad call-site migration.
- No broad app behavior changes are introduced.
- `npm run build` passes from the slice worktree, unless blocked by an unrelated pre-existing failure that is documented with evidence.
- The final step is a simple commit on `feature-references-02-resolver`.

## Required Tests

Add a focused test file, for example:

```text
src/store/featureResolver.test.ts
```

Include the Apache 2.0 header and update `src/store/INDEX.md`.

Test at minimum:

- migrated identity feature resolves to the same world profile as the compatibility feature row,
- translated instance resolves profile points by the expected delta,
- rotated instance resolves profile points around the expected pivot/origin,
- uniform scaled circle is classified as circle-preserving and resolves consistently,
- mirrored profile resolves with valid transformed geometry and expected arc handedness or documented fallback,
- missing definition returns the chosen null/skip behavior,
- resolving by feature IDs preserves order and skips or reports missing IDs according to the chosen helper contract.

Use the repo's existing direct `npx tsx src/store/*.test.ts` style.

## Browser Validation

Reserved for management. Do not start or attach to a Chrome debug/browser automation instance for this slice unless management explicitly revises this handoff.

## Definition of Done

1. Changes are implemented within the assigned scope.
2. Focused resolver tests are added.
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
Resolver helper names:
Verification run:
Browser validation: Not run; reserved for management.
Known gaps:
Manual/browser/tablet validation needed:
```
