# Slice 09 — Edit Sketch In Place (transformed linked instances)

Implementation handoff. Read `AGENTS.md` and root `planning/INDEX.md` first. Follow
Plan → confirm scope → Implement. You own ONLY this slice's worktree; finish with ONE simple commit
and a report. Do not merge, do not open a PR, do not run browser validation (management does that),
do not touch other worktrees or `planning/` files.

## Problem (user-reported, browser-confirmed)

Opening **Edit Sketch** on a transformed linked instance (a copy that was moved/rotated/scaled)
yanks the shape to the definition's *untransformed/original* location: the edited copy visually
"disappears" from where it sits and is drawn on top of the original, returning to its place only
after the edit ends. Editing the **first** instance (identity transform) edits in place. The
behavior is therefore inconsistent and confusing.

Root cause: `enterSketchEdit` and the per-edit definition sync force the **edited** instance to the
**identity** transform so the canvas shows definition-local geometry (slice-05 model; Plan open
question #5). The fix is to edit **in place** — keep the clicked instance at its own transform during
editing, and map edits back into definition-local space when writing to the shared definition.

## Branch / base / worktree

- Integration branch: `feature-references-v2` (use the current tip of `origin/feature-references-v2`).
- Slice branch: **`feature-references-09-edit-in-place`**
- Worktree: `/Users/frankp/Projects/worktrees/purecutcnc/feature-references-09-edit-in-place`
- Setup (no `npm install`):
  ```bash
  git -C /Users/frankp/Projects/purecutcnc worktree add \
    /Users/frankp/Projects/worktrees/purecutcnc/feature-references-09-edit-in-place \
    -b feature-references-09-edit-in-place origin/feature-references-v2
  cd /Users/frankp/Projects/worktrees/purecutcnc/feature-references-09-edit-in-place
  ln -s /Users/frankp/Projects/purecutcnc/node_modules node_modules
  ```

## How editing currently flows (read these first)

- `enterSketchEdit(id)` — `src/store/slices/selectionSlice.ts` (~line 567). Calls
  `rebakeAllInstances(s.project, definitionId, { editingFeatureId: id })`, which bakes the edited
  feature's compatibility `sketch.profile` at **IDENTITY** (definition-local) while siblings bake at
  their real transforms. THIS is what moves the edited copy to the origin.
- `rebakeAllInstances(project, definitionId, { editingFeatureId })` —
  `src/store/helpers/featureDefinitions.ts` (~line 207). When `editingFeatureId` matches, that
  feature uses `IDENTITY_MATRIX`; otherwise `resolveProfile(definition, instance.transform)`.
- `syncEditedFeatureDefinition(project, featureId, editingFeatureId?)` —
  `src/store/slices/featureGeometrySlice.ts` (~line 90). The **central choke point**: every geometry
  edit (`moveFeatureControl`, `insertFeaturePoint`, `deleteFeaturePoint`, `filletFeaturePoint`,
  `disconnectFeaturePoint`, profile join/break, etc.) mutates the edited feature's
  `sketch.profile` then calls this. It copies `editedFeature.sketch.profile` **straight into**
  `definition.profile` and rebakes (currently passing `editingFeatureId`). Because the edited
  feature is identity-baked today, its `sketch.profile` is already definition-local, so the direct
  copy is correct **today** — but it will be world-space once we stop forcing identity.
- `applySketchEdit()` / `cancelSketchEdit()` — `src/store/slices/selectionSlice.ts` (~line 642/706).
  Apply already rebakes without `editingFeatureId`; cancel restores the pre-edit snapshot.
- Matrix helpers: `src/store/helpers/instanceTransforms.ts` (has `multiplyMatrix`, `scaleMatrix`,
  etc. but **no invert**). Affine profile mapping: `transformProfileAffine(profile, (p)=>Point)` in
  `src/store/helpers/transform.ts` (~line 136). Point×matrix: `applyMatrixToPoint(matrix, point)` in
  `src/store/helpers/resolveFeatures.ts` (used by the resolver; export/reuse it).

## Required change (edit in place)

1. **Add `invertMatrix(m: Matrix2D): Matrix2D`** to `src/store/helpers/instanceTransforms.ts`
   (standard 2×3 affine inverse; guard the near-zero determinant by returning identity). Add a focused
   unit test that `multiplyMatrix(m, invertMatrix(m)) ≈ identity` for translate/rotate/uniform-scale
   and a composed transform.

2. **`enterSketchEdit`**: stop forcing identity. Rebake normally (no `editingFeatureId`) — or skip the
   special rebake entirely since instances are already baked at their transforms. The edited instance
   must remain at its own transform so the editor opens **where the instance sits**.

3. **`syncEditedFeatureDefinition`**: before writing to the definition, convert the edited feature's
   now-world-space profile back to **definition-local** using the inverse of that instance's transform:
   ```ts
   const transform = (editedFeature as SketchFeature & { transform?: Matrix2D }).transform ?? IDENTITY_MATRIX
   const inv = invertMatrix(transform)
   const localProfile = transformProfileAffine(editedFeature.sketch.profile, (p) => applyMatrixToPoint(inv, p))
   // store localProfile (not editedFeature.sketch.profile) into nextDefinition.profile
   ```
   Then rebake **without** `editingFeatureId` so the edited instance re-derives
   `resolveProfile(definition, transform)` and stays in place (round-trips to the same world geometry).
   Keep `kind` inference based on the resulting definition-local profile.

4. **Remove the now-dead `editingFeatureId` path**: drop the param from `syncEditedFeatureDefinition`
   and its callers, and remove `RebakeOptions.editingFeatureId` + its branch in `rebakeAllInstances`
   (and the doc-comment). Confirm nothing else references it (`grep -rn editingFeatureId src`).

5. **`applySketchEdit` / `cancelSketchEdit`**: verify they still produce correct final state with the
   edited instance at its transform (apply already rebakes without `editingFeatureId`; cancel restores
   the snapshot). Adjust only if needed for consistency.

## Out of scope / leave alone
- Resolver, transform commands, duplicate/make-unique, snapshot ops, creation minting, the tree/badge
  and Properties panel (slices 01–08). Touch only the edit-entry + edit-sync + matrix-invert path above.
- Non-uniform-scale / mirror correctness for fillet radius, circle radius, and dimension *values* is a
  known v1 limitation (Plan §"Circle and scale handling"): inverse-mapping a radius/length under a
  non-uniform or mirrored transform is lossy. Do NOT try to fully solve it; keep behavior correct for
  translate / rotate / uniform-scale (the common cases) and note any rough edges in the report.
- Stock-source sketch edit (`enterStockSketchEdit`) — separate known gap, not part of this slice.

## Acceptance criteria
- Editing a **transformed** linked instance happens **in place** (the shape stays where the instance
  sits; it does NOT jump to the origin and does NOT disappear), identical in feel to editing the first
  instance.
- Edits still propagate to all linked instances (shared definition), and each instance keeps its own
  transform after the edit (offsets between instances unchanged).
- Editing the first/identity instance is unchanged.
- `cancelSketchEdit` restores pre-edit geometry; `applySketchEdit` commits; undo works.
- `makeUnique` then edit affects only the unique copy (no regression).
- `npm run build` (tsc -b + full `npm test` + vite) green.

## Required tests (focused, `npx tsx`)
Add a suite (e.g. `src/store/editInPlace.test.ts`) that, WITHOUT a browser, asserts:
- A definition shared by two instances (one with a non-identity transform, e.g. translate+rotate).
  Apply a profile edit (e.g. `moveFeatureControl`-equivalent or `filletFeaturePoint`) to the
  TRANSFORMED instance via the real store actions (`enterSketchEdit`→edit→`applySketchEdit`).
- Assert: the definition's profile changed; BOTH instances reflect the edit when resolved; the
  transformed instance's resolved geometry equals the edit applied **at its location** (i.e. the
  control you moved is at the world point you set, not at the origin); the A↔B world offset is
  preserved; resolved geometry round-trips (re-resolving is stable).
- `invertMatrix` round-trip unit test (see step 1).
Run and confirm no regressions in the existing FR suites:
```
npx tsx src/store/definitionEditing.test.ts
npx tsx src/store/duplicateReference.test.ts
npx tsx src/store/featureResolver.test.ts
npx tsx src/store/instanceTransforms.test.ts
npx tsx src/store/snapshotOps.test.ts
npm run build
```
Update the nearest `INDEX.md` for any new file.

## Final report (report back to management; do NOT merge)
```
Branch:
Worktree:
Commit(s):
Files changed:
Behavior implemented:   (enterSketchEdit change; syncEditedFeatureDefinition inverse-transform;
                         invertMatrix; editingFeatureId removal)
Verification run:       (focused test results + npm run build outcome)
Browser validation:     Not run; reserved for management.
Known gaps:             (esp. any non-uniform-scale / mirror / circle-radius rough edges)
Manual/browser validation needed:   (flows for management to validate in the app)
```
