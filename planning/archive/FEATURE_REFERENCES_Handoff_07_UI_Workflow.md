# Slice 07 — UI Workflow (Feature References)

Implementation handoff. Read `AGENTS.md` and the root `planning/INDEX.md` first. Follow
Plan → confirm scope → Implement. You own ONLY this slice's worktree; finish with ONE simple commit
and a report. Do not merge, do not touch other worktrees, do not open a PR, do not archive any plan.

## Branch / base / worktree

- Integration branch: `feature-references-v2` at base commit **`3111192`** (creation-definition gap closed).
- Slice branch: **`feature-references-07-ui-workflow`**
- Worktree: `/Users/frankp/Projects/worktrees/purecutcnc/feature-references-07-ui-workflow`
- Setup (no `npm install`):
  ```bash
  git -C /Users/frankp/Projects/purecutcnc worktree add \
    /Users/frankp/Projects/worktrees/purecutcnc/feature-references-07-ui-workflow \
    -b feature-references-07-ui-workflow origin/feature-references-v2
  cd /Users/frankp/Projects/worktrees/purecutcnc/feature-references-07-ui-workflow
  ln -s /Users/frankp/Projects/purecutcnc/node_modules node_modules
  ```

## Context — what already exists (DO NOT rebuild)

The model + store layer is done (slices 01–06.5). Every feature row is an instance that points to a
`FeatureDefinition`; `instance.definitionId` + `instance.transform` are populated for ALL features
(migrated, created, imported, snapshot). Slice 07 is the **UI + a thin set of store actions** on top.

Already available — reuse, don't reinvent:
- `makeUnique(instanceId: string) => void` — store action (`src/store/slices/featureGeometrySlice.ts:640`,
  declared `src/store/types.ts:404`). Clones the definition and repoints the one instance. **Just wire UI.**
- `getDefinitionId(feature)` and `getInstanceIdsForDefinition(project, definitionId): string[]`
  (`src/store/helpers/featureDefinitions.ts`) — use for the linked badge and "Select Linked Instances".
- `createDefinitionForFeature(project, feature)` and the `makeUnique`/clone helpers
  (`src/store/helpers/featureDefinitions.ts`) — reuse for "Duplicate Independent".
- `selectFeatures(ids: string[])` + `selectedFeatureIds` (`src/store/types.ts`) — selection.
- `buildCopiedFeatures(...)` (`src/store/helpers/copyFeatures.ts`) — current copy builder. NOTE it spreads
  `...sourceFeature` (carrying `definitionId`) AND re-bakes a translated `sketch.profile` AND sets a new
  `transform`. That double-bakes geometry for the reference case — see "Required store work" below.
- Action bridge layer: `src/app/useFeatureTreeActions.ts` (context menu calls `actions.*`; `copyFeature`
  is defined at line 139 and currently drives a placement/duplicate gesture).
- UI homes: `src/components/feature-tree/FeatureContextMenu.tsx`,
  `src/components/feature-tree/FeatureTree.tsx`, `src/components/feature-tree/PropertiesPanel.tsx`.
- `nextUniqueGeneratedId` advances a module-level counter, so repeated calls are unique even within one
  `set()` — safe to mint multiple definitions/instances in a loop.

## Scope (build exactly this — Plan §"UI surface" and the operation-semantics matrix)

### 1. Project `copyMode` setting
- Add `copyMode: 'reference' | 'independent'` to `ProjectMeta` (`src/types/project.ts:541`), default `'reference'`.
- Normalize it for legacy loads (default when absent) in the project normalization path
  (`src/store/helpers/normalize.ts` / `normalizeProject`). Do not bump `Project.version`.
- Add a setter store action (e.g. `setCopyMode(mode)`), declared in `src/store/types.ts` and implemented
  in the appropriate settings/meta slice (match how existing `meta` toggles like `showDimensions` are set).

### 2. Duplicate semantics (store) — two explicit actions
- **Duplicate as Reference** — create new instance(s) that point at the **same `definitionId`** as each
  source, with a fresh instance id, a fresh name, and the source's `transform` (optionally offset).
  Do **not** create a new definition. Do **not** re-bake a translated `sketch.profile` independently of
  the transform — the resolved geometry must equal the source's resolved geometry composed with any offset
  (no double translation). If keeping a compatibility `sketch.profile`, bake it from
  `resolveProfile(instance, definition)` so it stays consistent with the resolver.
- **Duplicate Independent** — clone each source's definition (new `definitionId`) and create new instance(s)
  pointing at the clones (reuse the `createDefinitionForFeature`/clone helpers). Result must be fully
  decoupled: later edits to the source definition must not affect the independent copy.
- Wire both to the existing duplicate/placement flow: the default duplicate path (current `copyFeature`)
  follows project `copyMode`; the two context-menu items force a specific mode regardless of `copyMode`.
- Add focused store helpers if cleaner (e.g. extend `copyFeatures.ts`), but keep `buildCopiedFeatures`
  behavior coherent — fix the double-bake for the reference case.

### 3. Context menu items (`FeatureContextMenu.tsx` + `useFeatureTreeActions.ts`)
On the feature section, alongside the existing Copy/Move/Resize/Rotate/Mirror group, add:
- **Duplicate as Reference** → new instance(s), same definition.
- **Duplicate Independent** → cloned definition(s).
- **Make Unique** → call existing `makeUnique` for the selected instance(s); only show/enable when the
  selected instance's definition has more than one instance (use `getInstanceIdsForDefinition`).
- **Select Linked Instances** → `selectFeatures(getInstanceIdsForDefinition(project, getDefinitionId(feature)))`.
- Respect multi-selection where the existing items do (the menu already branches on `menuHasMultipleSelection`).

### 4. Feature tree linked badge (`FeatureTree.tsx`)
- Render a small link badge on a row when its definition has more than one instance
  (`getInstanceIdsForDefinition(project, defId).length > 1`). Keep it subtle and tablet-friendly; reuse
  existing tree row styling conventions. No global toolbar additions.

### 5. Properties panel shared-vs-instance grouping (`PropertiesPanel.tsx`)
- Visually separate **Shape** fields (definition-backed, shared — note "shared with N instances" when N>1)
  from **Instance** fields (name, folder, visibility, lock, placement, Z range/`z_top`/`z_bottom`).
- Editing a Shape field continues to route through the existing definition-editing store actions (which
  already propagate to linked instances). Editing an Instance field stays per-instance. Do not add new
  geometry-editing semantics here — only grouping/labeling + a "Make Unique" affordance.

## Out of scope (do NOT touch)
- Resolver/transform/definition-editing/snapshot store internals (done in 01–06.5) beyond the thin
  duplicate actions and the `copyMode` setting above.
- Per-instance overrides of definition fields; component-library UI; copy across projects.
- Canvas geometry/toolpath/G-code paths.
- Browser/tablet validation (reserved for management — slice 08). Do not start a controlled Chrome.
- Any `planning/*` files, `git merge`, pushing the integration branch, or the final PR.

## Acceptance criteria
- Duplicate as Reference: new row shares the source's `definitionId`; editing the shared definition (e.g.
  via sketch edit / radius) updates BOTH the source and the reference copy.
- Duplicate Independent: new row has a distinct `definitionId`; editing the source definition does NOT
  affect the copy.
- Make Unique: a previously-linked instance becomes independent; the badge updates accordingly.
- Select Linked Instances: selects exactly the instances sharing the definition.
- Linked badge shows iff the definition has >1 instance, and updates after duplicate/make-unique/delete.
- `copyMode` persists in the project, round-trips through save/load, defaults to `'reference'` for legacy
  files, and governs the default duplicate path.
- Properties panel renders Shape vs Instance groups without regressing existing editing.
- `npm run build` (tsc -b + full `npm test` + vite) is green.

## Required tests (focused, `npx tsx`)
Add a focused suite (e.g. `src/store/duplicateReference.test.ts`) covering:
- `copyMode` default `'reference'` for a legacy/normalized project; setter updates it; survives normalize.
- Duplicate as Reference → both rows share one definition; a definition edit propagates to both; resolved
  geometry of the copy equals source-resolved composed with the offset (no double translation).
- Duplicate Independent → distinct definitions; source edit does not affect the copy.
- Select-linked query returns all-and-only siblings.
- (Make-unique propagation is already covered by `definitionEditing.test.ts`; add a regression only if you
  change that path.)
Run, and confirm no regressions, the existing FR suites:
```
npx tsx src/store/creationDefinitions.test.ts
npx tsx src/store/definitionEditing.test.ts
npx tsx src/store/snapshotOps.test.ts
npx tsx src/store/featureResolver.test.ts
npx tsx src/store/instanceTransforms.test.ts
npx tsx src/store/featureReferencesMigration.test.ts
npm run build
```
Update the nearest `INDEX.md` for any new file.

## Final report format (report back to management; do NOT merge)
```
Branch:
Worktree:
Commit(s):
Files changed:
Behavior implemented:
  - copyMode setting + default/normalize
  - duplicateAsReference / duplicateIndependent semantics (and how the default path uses copyMode)
  - context menu items wired
  - linked badge
  - properties shared-vs-instance grouping
Verification run:   (paste focused test results + npm run build outcome)
Browser validation: Not run; reserved for management.
Known gaps:
Manual/browser/tablet validation needed:   (list the flows for management to validate)
```
