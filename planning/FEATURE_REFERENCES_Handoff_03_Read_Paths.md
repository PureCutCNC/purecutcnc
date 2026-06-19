# Feature References Handoff 03: Core Read-Path Migration

## Assignment

Route the first core geometry read paths through the resolver introduced in slice 02. This slice should make selected canvas and CAM/toolpath consumers read resolved world-space geometry without changing mutation behavior or enabling linked-copy UI.

This is an implementation-agent task. The management session owns review, browser validation, merging into the integration branch, ledger updates, and pushing the integration branch.

## Branch and Worktree

- Integration branch: `feature-references`
- Integration base commit: `e4aab26`
- Slice branch: `feature-references-03-read-paths`
- Slice worktree: `/Users/frankp/Projects/worktrees/purecutcnc/feature-references-03-read-paths`

Create the worktree from the current pushed integration branch:

```bash
cd /Users/frankp/Projects/purecutcnc
git fetch origin
git worktree add /Users/frankp/Projects/worktrees/purecutcnc/feature-references-03-read-paths origin/feature-references -b feature-references-03-read-paths
cd /Users/frankp/Projects/worktrees/purecutcnc/feature-references-03-read-paths
```

Before editing, verify:

```bash
git branch --show-current
git status --short --branch
git rev-parse --short HEAD
```

Stop if the branch/worktree does not match this assignment, or if the base is not `e4aab26` or a management-approved newer `feature-references` commit.

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
- `planning/FEATURE_REFERENCES_Handoff_02_Resolver.md`
- `src/INDEX.md`
- `src/store/INDEX.md`
- `src/store/helpers/resolveFeatures.ts`
- `src/store/featureResolver.test.ts`
- `src/components/INDEX.md`
- `src/engine/INDEX.md`

Use codebase-memory-mcp graph tools first for code discovery. Fall back to text search only for docs/config/literals or when graph results are insufficient.

## Current Model State

Slice 01 added the data model and migration. Slice 02 added resolver helpers:

- `resolveFeatureInstance`
- `resolveFeatureInstances`
- `resolveFeatureDefinition`
- `resolveProfile`
- `resolveSketch`
- matrix helpers such as `applyMatrixToPoint`, `isIdentityMatrix`, and `isCirclePreservingTransform`

Important transitional constraint: `Project.features` is still `SketchFeature[]`, and most store mutation paths still edit compatibility feature rows directly. This slice is read-only migration work. Do not change how sketch edits, transform commands, join/cut/offset, or feature creation mutate project data.

## Scope

Allowed scope:

- Add small read-path adapter helpers if needed, for example `resolvedProjectFeatures(project)` or `resolvedFeatureMap(project)`, built on the slice 02 resolver.
- Route bounded core read paths through resolved features:
  - canvas hit testing and selection geometry,
  - canvas snapping/dimension read helpers where they consume other feature geometry,
  - CAM/toolpath operation target resolution where selected/project features are read for geometry.
- Update type signatures where needed so existing consumers can accept `ResolvedSketchFeature` or a minimal `SketchFeature`-compatible geometry shape.
- Add focused tests proving transformed instance rows are consumed through the resolver in these read paths.
- Keep identity-migrated projects behavior-equivalent.
- Update nearest `INDEX.md` files if new files/tests are added.

Out of scope:

- Mutating feature definitions or instance transforms.
- Changing transform commands to write matrices.
- Changing `Project.features` to `FeatureInstance[]`.
- Sketch edit using definitions.
- Join/cut/offset snapshot behavior.
- UI actions for Duplicate as Reference, Make Unique, linked badges, or Properties panel grouping.
- Broad refactors of `SketchCanvas.tsx`, toolpath generators, or store mutation paths beyond what this read-path migration requires.
- Browser validation.
- Integration-branch merge or push.
- Final PR creation.

## Target Read Paths

Use code discovery to confirm the exact current call sites, but start from these known direct geometry consumers:

- `src/components/canvas/hitTest.ts`
  - `findHitFeatureId()`
  - `featureFullyInsideRect()`
- `src/components/canvas/snappingHelpers.ts`
  - snapping against feature profiles
- `src/sketch/dimensions.ts`
  - dimension anchor/profile read helpers
- `src/engine/toolpaths/resolver.ts`
  - operation target collection and region/target geometry reads
- shared geometry helpers used by those paths, such as:
  - `src/store/helpers/clipping.ts` / `flattenFeatureToClipperPath()`
  - `src/engine/toolpaths/regions.ts` / `buildRegionMask()`
  - `src/engine/toolpaths/modelProtection.ts` footprint helpers, only if required by the resolver path you touch

Do not attempt to eliminate every `feature.sketch.profile` read in the codebase. Some direct reads are still correct in mutation/editing code until later slices move definitions and transform commands.

## Design Constraints

- Read paths that represent placed/world geometry should receive resolved features.
- Store mutation paths should continue using persisted compatibility rows until their later assigned slices.
- Operation targets still identify instances by feature/instance ID.
- Resolved features must preserve IDs, operation, visibility, Z span, text/STL data, and folder metadata expected by downstream code.
- Missing definitions should follow the slice 02 resolver behavior: skip/null, not crash.
- Identity transforms must not change existing geometry output.
- Avoid duplicate geometry transform logic. Use `src/store/helpers/resolveFeatures.ts` helpers rather than reimplementing transforms in each consumer.

## Acceptance Criteria

- Canvas hit testing uses resolved world-space feature geometry for feature hits.
- Snapping and/or dimension read helpers use resolved world-space geometry where they read other feature profiles.
- CAM/toolpath target resolution uses resolved world-space features for operation geometry reads in the touched path.
- Identity-migrated projects continue to pass existing tests.
- At least one focused test proves a feature row with `definitionId` + non-identity `transform` is hit/resolved at its transformed world position, not its definition-local position.
- At least one focused CAM/toolpath/resolver test proves operation target geometry uses resolved world geometry for a transformed instance.
- Missing-definition behavior remains non-crashing and is covered either by existing resolver tests or by the new read-path tests.
- `npm run build` passes from the slice worktree, unless blocked by an unrelated pre-existing failure that is documented with evidence.
- The final step is a simple commit on `feature-references-03-read-paths`.

## Required Tests

Prefer focused tests close to the code touched. Candidate tests:

- `src/components/canvas/hitTest.test.ts` if you add canvas hit-test coverage.
- `src/store/featureResolver.test.ts` if the adapter is resolver-adjacent.
- `src/engine/toolpaths/toolpaths.test.ts` or a new focused resolver test if operation target geometry changes are easiest to validate there.

Cover at minimum:

- identity migrated feature read path remains equivalent,
- transformed instance hit testing uses resolved world-space profile,
- transformed instance operation target geometry is consumed in resolved world coordinates,
- missing definition is skipped/null without throwing in the migrated read path,
- existing operation target IDs remain instance IDs.

Use the repo's existing direct `npx tsx ...` test style.

## Browser Validation

Reserved for management. Do not start or attach to a Chrome debug/browser automation instance for this slice unless management explicitly revises this handoff.

## Definition of Done

1. Changes are implemented within the assigned scope.
2. Focused read-path tests are added/updated.
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
Read paths routed through resolver:
Verification run:
Browser validation: Not run; reserved for management.
Known gaps:
Manual/browser/tablet validation needed:
```
