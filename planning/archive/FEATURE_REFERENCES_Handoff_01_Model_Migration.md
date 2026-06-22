# Feature References Handoff 01: Model, Versioning, and Migration

## Assignment

Implement the first foundation slice for feature references: add the definition/instance/matrix data model, choose the real project migration marker, and migrate existing projects so every legacy feature becomes one definition plus one instance with resolved geometry equivalent to the current project.

This is an implementation-agent task. The management session owns review, browser validation, merging into the integration branch, ledger updates, and pushing the integration branch.

## Branch and Worktree

- Integration branch: `feature-references`
- Slice branch: `feature-references/01-model-migration`
- Slice worktree: `/Users/frankp/Projects/worktrees/purecutcnc/feature-references-01-model-migration`
- Base commit: current pushed `feature-references` at assignment time

Before editing, verify:

```bash
git branch --show-current
git status --short --branch
```

Stop if the branch or worktree does not match the assignment.

## Worktree Environment Setup

After creating the slice worktree and before running tests/build, create a `node_modules` symlink to the main project checkout if the worktree does not already have one:

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
- `src/INDEX.md`
- `src/store/INDEX.md`
- `src/types/project.ts`
- `src/store/projectStore.ts` migration/normalization area

Use codebase-memory-mcp graph tools first for code discovery. Fall back to text search only for docs/config/literals or when graph results are insufficient.

## Scope

Allowed scope:

- Add feature definition, feature instance, and 2D affine matrix types.
- Add `Project.featureDefinitions`.
- Update `SketchFeature`/feature instance typing as needed for this slice.
- Choose and implement the real migration marker. Current `Project.meta.schemaVersion` does not exist, so do not write code or tests that assume it does without adding it intentionally.
- Update `newProject()` defaults.
- Update `normalizeProject()` / load normalization so legacy projects migrate to:
  - one `FeatureDefinition` per old feature,
  - one instance per old feature,
  - identity transforms,
  - preserved IDs where appropriate for operation targets and feature tree entries.
- Preserve current operation target behavior: operations continue to target instance IDs.
- Preserve `modelAssets` handling and imported model references.
- Add focused unit tests for migration and round-trip shape.
- Update nearest `INDEX.md` files for any new source files.

Out of scope for this slice:

- UI actions for Duplicate as Reference, Make Unique, badges, or Properties panel grouping.
- Transform command conversion.
- Canvas/toolpath read-path migration beyond what is required to keep tests/build compiling.
- Join/cut/offset snapshot behavior.
- Browser validation.
- Integration-branch merge or push.
- Final PR creation.

## Design Constraints

- Every feature tree row should be treated as an instance in the target persisted model.
- There should be no special long-term standalone feature mode.
- Definition geometry is canonical and untransformed.
- Instance transform is the durable placement state.
- V1 stores only the final matrix, not transform history.
- If compatibility fields are temporarily kept to make this slice buildable, document the exact transitional shape in the final report and leave clear tests around migration invariants.
- Avoid broad opportunistic refactors. Keep changes scoped to model/versioning/migration.

## Acceptance Criteria

- New projects include `featureDefinitions` and feature instances in the chosen target shape.
- Legacy project normalization creates one definition per legacy feature and one instance pointing at it.
- Existing feature IDs used by feature tree entries and operation targets remain valid instance IDs.
- Definition IDs are unique and stable after normalization.
- Re-running normalization does not duplicate definitions or re-migrate already-migrated projects.
- Save/load round trip preserves definitions, instances, transforms, operations, feature tree, and model asset references.
- The implementation records the chosen migration marker clearly in code/tests and final report.
- `npm run build` passes from the slice worktree, unless blocked by an unrelated pre-existing failure that is documented with evidence.
- The final step is a simple commit on `feature-references/01-model-migration`.

## Required Tests

Add focused tests covering:

- `newProject()` has the new model shape.
- A legacy single-feature project migrates to one definition plus one instance.
- A legacy multi-feature project migrates with unique definitions and preserved instance IDs.
- Operation targets still reference valid migrated instance IDs.
- Feature tree entries still reference valid migrated instance IDs.
- Re-normalizing an already-migrated project is idempotent.
- Imported STL/model asset references survive migration.
- Save/load or clone/normalize round trip preserves the migrated shape.

Use the repo's existing test style and locations. If the tests need a new file, include the Apache 2.0 header and update the nearest `INDEX.md`.

## Browser Validation

Reserved for management. Do not start or attach to a Chrome debug/browser automation instance for this slice unless management explicitly revises this handoff.

## Definition of Done

1. Changes are implemented within the assigned scope.
2. Focused tests are added/updated.
3. `npm run build` is run from the slice worktree.
4. New source files are indexed in the nearest `INDEX.md`.
5. The slice branch has one simple final commit.
6. Report back to management using the format below.

## Final Report Format

```md
Branch:
Worktree:
Commit(s):
Files changed:
Behavior implemented:
Migration marker chosen:
Verification run:
Browser validation: Not run; reserved for management.
Known gaps:
Manual/browser/tablet validation needed:
```
