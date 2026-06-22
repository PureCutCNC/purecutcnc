# Feature References Handoff 06.5: Creation Paths Create Definitions

## Assignment

Make **every feature-creation path mint a `FeatureDefinition`** (one definition + one
identity-transform instance per created feature), closing the cross-slice "creation gap" so
that Slice 07 (Duplicate as Reference) has a definition to reference for *any* feature, not
just migrated/snapshot ones.

This is an implementation-agent task. Management owns review, browser validation, merging,
ledger updates, and pushing the integration branch.

## Why this slice is needed

Today (after the port of 01–06 onto `main`):

- Only two paths create definitions: the slice-01 **migration** (`normalizeProject`, on load)
  and slice-06 **snapshot ops** (`createSnapshotDefinition`).
- All **runtime creation** — drawing a rect/circle/polygon/spline, adding text, importing
  SVG/DXF/STL/CAMJ — produces compatibility rows with **no `definitionId`**. They render only
  via the slice-03 **raw fallback** (transitional rows fall back to `feature.sketch.profile`).
- Slice 07 "Duplicate as Reference" requires the source feature to **have a definition** — you
  cannot reference what doesn't exist. So general creation must mint definitions first.

## Branch and Worktree

- Integration branch: **`feature-references-v2`** (this is the live branch — NOT the old
  `feature-references`).
- Integration base commit: `85530d4`
- Slice branch: `feature-references-065-creation-definitions`
- Slice worktree: `/Users/frankp/Projects/worktrees/purecutcnc/feature-references-065-creation-definitions`

Create the worktree from the current pushed integration branch:

```bash
cd /Users/frankp/Projects/purecutcnc
git fetch origin
git worktree add /Users/frankp/Projects/worktrees/purecutcnc/feature-references-065-creation-definitions origin/feature-references-v2 -b feature-references-065-creation-definitions
cd /Users/frankp/Projects/worktrees/purecutcnc/feature-references-065-creation-definitions
ln -s /Users/frankp/Projects/purecutcnc/node_modules node_modules
git branch --show-current && git rev-parse --short HEAD
```

Stop if the branch/worktree does not match this assignment or the base is not `85530d4` (or a
management-approved newer `feature-references-v2` commit). Do not `npm install` unless the
symlink is broken.

## Required Reading

- `AGENTS.md`, `INDEX.md`, `src/store/INDEX.md`
- `planning/FEATURE_REFERENCES_Plan.md` — **Operation semantics matrix** ("Create … → one
  definition + one instance with identity transform"), **Definition lifetime**.
- `planning/FEATURE_REFERENCES_Ledger.md`, `planning/FEATURE_REFERENCES_PORT_Plan.md`
- `src/store/helpers/featureDefinitions.ts` — existing `createSnapshotDefinition`,
  `getDefinitionId`, `resolveProfile` usage.
- `src/store/helpers/resolveFeatures.ts` — resolver + `resolveDefinitionAndTransform`.
- `src/store/slices/featureSlice.ts` — the central `addFeature` action.
- `src/store/slices/importMergeSlice.ts`, `src/import/normalize.ts` (`createImportedFeature`),
  `src/import/camj.ts` — import creation/merge.
- `src/store/slices/pendingAddSlice.ts` — shape/text draw completion (calls `addFeature`).

Use codebase-memory-mcp graph tools first for code discovery.

## Current Creation Landscape (confirm with graph tools before editing)

- **`addFeature`** (`src/store/slices/featureSlice.ts`, ~line 348) is the central single-feature
  creation action. Shape draw (rect/circle/polygon/spline) and text creation in
  `pendingAddSlice.ts` funnel through `addFeature`, as do several `featureSlice` creators. It
  normalizes the feature (id, folder, `region→add` first-machining-feature flip,
  `normalizeFeatureZRange`, model-asset storage) before insertion.
- **Imports bypass `addFeature`**: `importMergeSlice.ts` bulk-inserts
  (`features: [...features, ...createdFeatures]`). `.camj` import may carry its own
  `featureDefinitions` map.
- **Already-have-definition paths** (do NOT double-create): snapshot results
  (`createDerivedFeature`/`createSnapshotDefinition`), and features loaded from file (migration).

## Required Design

1. **Mint at the chokepoint.** In `addFeature`, after the feature is normalized (final
   `profile` / `kind` / `operation` — i.e. after the `region→add` flip and
   `normalizeFeatureZRange`), if the feature has **no explicit `definitionId`**, mint a
   `FeatureDefinition` from the normalized feature, set the row's `definitionId` and
   `transform = IDENTITY_MATRIX`, and merge the definition into `project.featureDefinitions` in
   the same store mutation. Reuse/generalize the slice-06 helper — e.g. add
   `createDefinitionForFeature(project, feature)` (or generalize `createSnapshotDefinition`) in
   `featureDefinitions.ts` so snapshot and creation share one definition-minting helper. The
   definition's `kind`/`operation`/`profile`/`text`/`stl` must match the created feature.

2. **Idempotency.** If the incoming feature already has an explicit `definitionId` (snapshot
   results routed elsewhere, or any future caller), do NOT mint a second definition — leave it.

3. **Import bulk paths.** Ensure imported features (`importMergeSlice.ts`, and any `.camj`
   merge path) also get definitions:
   - SVG/DXF/STL imports → mint a definition per imported feature (identity transform).
   - `.camj` import: if the imported project already carries `featureDefinitions`, **merge them
     with collision-safe IDs** (preserve each imported instance's `definitionId` link, remapping
     IDs that collide with the current project — reuse the project id system). If an imported
     feature lacks a definition, mint one.
   - Prefer routing single imported features through `addFeature` where practical, or apply the
     same minting helper in the bulk path.

4. **Text/STL features.** Text and STL definitions carry `text`/`stl` data; ensure the minted
   definition copies those (not just `profile`). Keep `kind` for text/stl (do not re-infer).

5. **No change to migration or snapshot behavior.** `normalizeProject` migration and slice-06
   snapshot definition creation already work; do not alter their semantics. After this slice,
   `normalizeProject`'s `needsMigration` path remains the on-load fallback for any legacy
   definition-less rows.

6. **Undo/redo.** Definitions created at creation time appear/disappear with the creation's
   undo step (ordinary store mutation).

## Scope

Allowed:
- `src/store/slices/featureSlice.ts` — `addFeature` mints definitions.
- `src/store/slices/importMergeSlice.ts` (+ `src/import/normalize.ts` / `src/import/camj.ts` as
  needed) — imported features get definitions; `.camj` definitions merged collision-safe.
- `src/store/helpers/featureDefinitions.ts` — add/generalize the definition-minting helper.
- Focused tests + nearest `INDEX.md` updates.

Out of scope:
- Slice 07 UI (Duplicate as Reference/Independent, Make Unique UI, Select Linked, badges,
  Properties grouping, `copyMode`). `makeUnique` store helper already exists.
- Changing transform/edit/snapshot behavior (04/05/06).
- `Project.features` → `FeatureInstance[]`; removing the compatibility `sketch.profile` cache.
- Copy/paste reference-vs-independent semantics (slice 07 / `copyMode`).
- Browser validation, integration merge/push, final PR.

## Acceptance Criteria

- Drawing a rect/circle/polygon/spline creates a feature **with** an explicit `definitionId`
  and a matching `FeatureDefinition` in `project.featureDefinitions` (identity transform).
- Creating a text feature and an STL/imported-model feature likewise mint definitions carrying
  the `text`/`stl` data.
- SVG/DXF/STL import: each imported feature gets a definition.
- `.camj` import: imported `featureDefinitions` are merged without ID collisions and instances
  keep their definition links; definition-less imported rows get minted definitions.
- Idempotent: a feature that already has a `definitionId` does not get a second definition.
- `resolveFeatureInstance` returns correct world geometry for newly created features (they no
  longer depend on the raw fallback).
- Existing tests still pass; migration and snapshot behavior unchanged.
- `npm run build` passes from the slice worktree.
- Final step is one simple commit on `feature-references-065-creation-definitions`.

## Required Tests

Use `npx tsx ...`. Add e.g. `src/store/creationDefinitions.test.ts` covering:
- `addFeature` for a drawn shape creates a definition + sets `definitionId`/identity transform;
- text and STL creation mint definitions with `text`/`stl` carried;
- an SVG/DXF import path yields features each with a definition;
- `.camj` import merges definitions collision-safe and preserves links;
- idempotency: a feature with an existing `definitionId` is not double-defined;
- a newly created feature resolves via `resolveFeatureInstance` (not the raw fallback).

Run and record:

```bash
npx tsx src/store/creationDefinitions.test.ts
# plus any existing creation/import tests you touch
npm run build
```

## Browser Validation

Reserved for management. Do not start or attach to a Chrome debug/browser automation instance.

## Definition of Done

1. Changes within scope; all creation paths mint definitions idempotently.
2. Focused tests added and passing; existing tests still pass.
3. `npm run build` run from the slice worktree.
4. Nearest `INDEX.md` updated.
5. One simple final commit on the slice branch.
6. Report back using the format below.

## Final Report Format

```md
Branch:
Worktree:
Commit(s):
Files changed:
Behavior implemented:
addFeature minting approach:
Import / .camj handling:
Idempotency handling:
Verification run:
Browser validation: Not run; reserved for management.
Known gaps:
Manual/browser/tablet validation needed:
```
