# Integration Handoff — Issue #270 SVG/DXF path and nesting semantics

> This tracked handoff is the implementation ledger for the approved plan in
> [GitHub issue #270](https://github.com/PureCutCNC/purecutcnc/issues/270).
> The issue remains the product plan and source of truth. Do not store tokens,
> raw environment values, or provider debug output here.

## Role and stop condition

The integration manager delegates the approved work as sequential slices,
reviews the actual commit and diff from every slice, and merges only accepted
work into the integration branch. After all slices pass repository and browser
verification, push the integration branch and open a PR with `Closes #270`.
Do not merge the PR into `main`.

## Integration state

- Integration branch: `feat/issue-270-svg-dxf-import-integration`
- Integration worktree: `/Users/frankp/Projects/worktrees/purecutcnc/issue-270-svg-dxf-import-integration`
- Base commit: `276245e7fcc462fac3c30fd4d51e60ca4178bf6d`
- Latest main merged: `fe6efb0` (worker progress reporting)
- Approved plan: GitHub issue #270
- Manager session: 2026-07-09 through 2026-07-10
- Status: `implementing S2`
- User authorization: plan and full implementation approved; credential read,
  outbound DeepSeek access, and bypass worker dispatch explicitly approved

## Approved product decisions

- `line` may hold open or closed geometry, is machinable path geometry, and
  never contributes material to the boolean model.
- Engrave follows open or closed Line geometry directly.
- V-carve and recursive V-carve accept Subtract features and closed Lines, but
  reject open Lines. Multiple selected closed Lines use even-odd topology.
- SVG Auto uses paint intent: stroke-only becomes Line; filled closed shapes
  use nesting-aware solid classification.
- DXF Auto defaults to Solid regions (infer nesting), preserving the established
  material-oriented DXF import behavior. Paths remains an explicit choice.
- Solid nesting is parent-before-child: depth 0 Add, depth 1 Subtract, then
  alternating by depth. Open profiles remain Line.
- Manual inference affects only a newly completed closed feature and never
  silently reclassifies existing work.
- The user-supplied Aztec files stay uncommitted; synthetic fixtures cover tests.

## Global rules

- One active implementation slice at a time.
- Every worker runs in its own task worktree branched from the current
  integration tip.
- The canonical credential remains only in the primary checkout
  `/Users/frankp/Projects/purecutcnc/.env.agent`.
- The manager owns review, verification, merge, cleanup, browser regression,
  push, issue status, and PR creation.
- Reject results without exactly one expected task commit, a clean worktree,
  scoped changes, and truthful check results.
- Preserve the public `ProjectStore` contract unless a slice explicitly
  requires a typed input extension already allowed by the contract.
- Use shared pure helpers for feature roles, V-carve eligibility, and nesting
  semantics; do not duplicate policy across UI/store/resolver call sites.
- New source and test files require the Apache 2.0 header.
- Update the nearest `INDEX.md` when files are added or responsibilities move.
- Final browser work must cover desktop and tablet-sized layouts. Close the
  controlled browser before stopping the dev server.

## Slice ledger

| Slice | Scope | Base | Worker | Manager review | Accepted merge | Required checks |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Closed Line role, UI availability, and model/3D semantics | `a6aea9b` | complete (`8afb7af`) | accepted; closed-overlay correction added | `17fb11f` | focused tests + manager `npm run build` passed (94 files) |
| S2 | Closed-Line V-carve eligibility and even-odd resolution | `17fb11f` | dispatching | pending | - | operation validity/default/resolver/V-carve tests; build |
| S3 | SVG/DXF import modes, paint intent, nesting classifier, dialog summary | S2 merge | not started | pending | - | import/store/UI tests; e2e smoke; build |
| S4 | Large-import bulk path and batched 3D Line rendering | S3 merge | not started | pending | - | bulk-import/CSG tests and benchmark; build |
| S5 | Nesting-aware defaults for newly drawn closed features | S4 merge | not started | pending | - | creation/store tests; build |

## S1 — Closed Line is a first-class non-solid feature

**Goal:** A closed profile can be Line without coercion, remains machinable, is
excluded from CSG/fallback extrusion, and appears as a 3D line overlay.

**Likely allowed files:**

- `src/store/helpers/featureRoles.ts` and focused tests
- `src/store/slices/featureSlice.ts`
- `src/components/feature-tree/FeatureTree.tsx`
- `src/components/feature-tree/PropertiesPanel.tsx`
- `src/engine/csg.ts` and focused tests
- nearest relevant `INDEX.md`

**Forbidden:** V-carve resolver changes, import modes/classifier, manual nesting
inference, broad UI redesign, line batching.

**Invariants:**

- Region, Construction, Model, and open-Line behavior remain unchanged.
- The first remaining solid feature must still be Add; a Lines-only project is
  valid.
- Single and bulk operation changes must not create a leading Subtract solid.

**Checks:** focused feature-role/store/CSG tests, then `npm run build`.

## S2 — Closed Lines as V-carve targets

**Goal:** Both V-carve strategies accept closed Lines with even-odd contour
topology while preserving existing Subtract/add-island and region-mask behavior.

**Likely allowed files:**

- `src/components/cam/operationValidity.ts` and tests
- `src/components/cam/CAMPanel.tsx`
- `src/store/helpers/operationDefaults.ts` and tests
- `src/engine/toolpaths/resolver.ts` and resolver/toolpath tests
- small shared feature-role/eligibility helper modules if justified

**Forbidden:** import dialog/modes, manual creation defaults, 3D batching.

**Invariants:**

- Open Lines remain invalid for V-carve and valid for Engrave.
- Persisted target validation, fallback target selection, compatible selection,
  UI hints, and actual resolution agree.
- Closed Line paths are not normalized into one same-winding non-zero fill.

**Checks:** operation validity/default/resolver/V-carve focused tests, then
`npm run build`.

## S3 — Import meaning, SVG intent, and nesting-aware creation

**Goal:** SVG/DXF import exposes Auto, Paths, and Solid regions; Auto follows the
approved SVG/DXF defaults; a pure classifier creates deterministic
parent-before-child Add/Subtract nesting and the dialog shows an analysis/result
summary.

**Likely allowed files:**

- `src/import/types.ts`, `src/import/svg.ts`, import tests
- a new focused nesting/import-classification helper and tests
- `src/store/slices/importMergeSlice.ts`, store types/tests as needed
- `src/components/project/ImportGeometryDialog.tsx`
- relevant dialog CSS
- `e2e/*.smoke.spec.ts` and helpers
- nearest relevant `INDEX.md`

**Forbidden:** workerization without measurement, committing the Aztec files,
manual drawing inference, unrelated import repair.

**Invariants:**

- SVG Auto: stroke-only Line; filled closed shapes nesting-aware solids.
- DXF Auto: nesting-aware solids. Paths is explicit.
- Classification spans the selected import batch across layers, uses strict
  smallest-container parentage, preserves sibling source order, and warns on
  ambiguity.
- Open imported profiles remain Line.

**Checks:** focused import/store tests, relevant e2e smoke, then
`npm run build`.

## S4 — Large-import performance and batched 3D Lines

**Goal:** The 2,980-contour workload avoids quadratic bulk creation patterns,
multi-thousand-item selection/expanded tree behavior, boolean work for Lines,
and thousands of 3D draw calls.

**Likely allowed files:**

- `src/store/slices/importMergeSlice.ts` and bulk-import tests
- naming/ID helpers only if a focused bulk API is needed
- `src/engine/csg.ts`
- `src/components/viewport3d/Viewport3D.tsx` if scene ownership changes
- focused 3D/bulk tests and nearest `INDEX.md`

**Forbidden:** changing CAM geometry tolerances, importing the private Aztec
files as fixtures, speculative parse worker.

**Invariants:**

- Large folders start collapsed and select the folder/representative item, not
  every child.
- Line overlay batching uses a small number of BufferGeometry/line draw calls
  and disposes GPU resources through the existing scene lifecycle.
- Selected/hovered feedback remains correct or uses a small overlay.
- Measure after bulk/CSG/batching changes; add a worker only with evidence.

**Checks:** focused bulk/CSG tests, a synthetic large-import benchmark/assertion,
then `npm run build`.

## S5 — Manual closed-feature nesting defaults

**Goal:** Newly completed closed features default outside → Add, inside Add →
Subtract, inside Subtract → Add using the shared classifier primitives.

**Likely allowed files:**

- shared nesting/containment helper from S3
- `src/store/helpers/buildShapeFeature.ts`
- `src/store/slices/pendingAddSlice.ts`
- `src/store/slices/pendingCompletionSlice.ts`
- primitive creation paths and focused store tests

**Forbidden:** retroactively changing existing features, a reclassify command,
changing explicit user-selected operations.

**Invariants:**

- Ignore Line, Region, Construction, and Model for inference.
- Explicit operation choice wins.
- Undo/redo and linked-definition behavior remain correct.
- Later outer shapes do not reclassify earlier inner shapes.

**Checks:** focused creation/store tests, then `npm run build`.

## Integration verification

- `npm run build`
- `npm run test:e2e`
- Browser import dialog smoke on desktop and tablet-sized viewports
- Import the supplied SVG in Auto/Paths and confirm no boolean-preview failure
- Import the supplied DXF with Auto and Paths; confirm the selected result
  summary and no multi-thousand-item selection
- Closed Line conversion plus Engrave/V-carve eligibility smoke
- 3D view interaction after large Paths import
- Close controlled browser, then stop the dev server

## User-review handoff

Final delivery is a PR from
`feat/issue-270-svg-dxf-import-integration` to `main`, with the accepted
slice list, exact verification commands, browser results, known limitations,
and `Closes #270`.
