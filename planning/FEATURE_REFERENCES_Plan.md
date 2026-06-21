---
status: In progress
created: 2026-06-08
---

# Feature References (Linked Copies) Plan

> **Status (updated 2026-06-21).** All implementation slices are merged on the integration branch
> **`feature-references-v2`** and have passed management browser validation; the final PR to `main` is
> pending user sign-off (plan stays *In progress* until the user confirms). **Live, authoritative
> status is [`FEATURE_REFERENCES_Ledger.md`](FEATURE_REFERENCES_Ledger.md).** The *implemented*
> architecture (definition/instance model, dual-storage compatibility, versioning) is documented in
> [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §4 — read that for "how it works"; this file is the design
> rationale and history.
>
> Delivered scope extends the original 8-slice sequence below with: **06.5** Creation definitions
> (all creation/import paths mint a definition), **09** Edit Sketch in place (transformed/unique
> instances edit at their real location), **10** Linked constraint re-solve (dependents of a sibling
> re-solve after a linked edit); plus UI refinements (linked badge, context-menu placement, desktop
> kebab hidden) and a forward-compat warning when loading a `.camj` newer than `LATEST_PROJECT_VERSION`.
> **Decisions:** *Copy = linked by default* via project `meta.copyMode` (no UI toggle; Make Unique
> unlinks). Copying a feature's *constrained child* alongside it is **out of scope** here — deferred to
> a future "constraints + references" effort.

## Goal

Let users create linked copies of features: editing the shared sketch definition updates every instance, while moving, rotating, resizing, mirroring, naming, visibility, and Z placement remain per-instance. The user-visible result is SketchUp-style components for 2.5D CAD/CAM: "Duplicate as Reference", "Duplicate Independent", "Make Unique", linked-instance badges in the feature tree, and predictable propagation of source-shape edits across repeated parts.

This is a foundational model migration, not a small UI feature. The core invariant is:

> Every feature tree row is an instance. Every instance points to a feature definition. The definition stores canonical, untransformed shape data; the instance stores placement as an affine matrix plus per-instance metadata.

## Approach

### Core model

Today `SketchFeature` is monolithic: geometry, kind, operation, sketch data, placement-ish fields, Z bounds, tree metadata, and visibility all live in one object. This plan splits that into definitions and instances.

There are no special standalone features in the target model. A normal rectangle is one `FeatureDefinition` plus one `FeatureInstance`. A linked duplicate is another instance pointing at the same definition. "Make Unique" clones the definition and repoints only the selected instance.

```ts
export interface FeatureDefinition {
  id: string
  kind: FeatureKind
  profile: SketchProfile
  dimensions: LocalDimension[]
  text?: TextFeatureData | null
  stl?: STLFeatureData | null
  operation: FeatureOperation
}

export interface Matrix2D {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export interface FeatureInstance {
  id: string
  name: string
  definitionId: string
  transform: Matrix2D
  constraints: LocalConstraint[]
  z_top: DimensionRef
  z_bottom: DimensionRef
  folderId: string | null
  visible: boolean
  locked: boolean
}

export interface Project {
  // existing fields...
  featureDefinitions: Record<string, FeatureDefinition>
  features: FeatureInstance[]
}
```

`Matrix2D` is the durable placement state for an instance. It maps definition-local geometry into project/world coordinates. We intentionally do **not** persist transform history in v1. Move/rotate/resize/mirror commands update the matrix, and normal app undo/redo handles immediate mistakes.

### Definition vs instance data

**Definition (shared):**
- `kind` — current canonical feature kind.
- `profile` — canonical/local profile geometry.
- `dimensions` — local numeric sketch dimensions. Current `LocalDimension` is local-only (`value`, `segment_ids`), so it belongs on the definition in v1.
- `text` — text content/font/size for text definitions.
- `stl` — STL scale/import data/mesh asset reference for model definitions.
- `operation` — add/subtract/region/model/line. In v1, operation is definition-level. If a user needs the same outline as both add and subtract, that is a separate definition.

**Instance (per placed copy):**
- `id`, `name`, `folderId`, `visible`, `locked`.
- `definitionId`.
- `transform` — affine transform from definition-local to project/world space.
- `constraints` — per-instance, because constraints can reference external geometry or stock/project positions.
- `z_top`, `z_bottom` — per-instance. Z placement is analogous to XY placement; users who want linked depth can use shared named dimensions.

Per-instance overrides of definition fields are out of scope for v1. An instance is either linked to a definition or made unique by cloning the definition.

### Resolver boundary

All consumers that need world geometry must go through a resolver. The resolver composes the instance and definition into a current `SketchFeature`-like resolved view for canvas, hit testing, toolpaths, imports, constraints, properties, and export.

Expected helper shape:

```ts
resolveFeatureInstance(project, instance): ResolvedSketchFeature
resolveSketch(instance, definition): Sketch
resolveProfile(instance, definition): SketchProfile
isCirclePreservingTransform(matrix): boolean
```

The current codebase has many direct `feature.sketch.profile` reads/writes. This migration is only safe if those paths are routed deliberately. The plan should not assume consumers "just keep working" after the persisted shape changes.

### Transform semantics

Instance transforms are matrix updates:

```ts
move:   M = T(dx, dy) * M
rotate: M = T(pivot) * R(angle) * T(-pivot) * M
scale:  M = T(pivot) * S(sx, sy) * T(-pivot) * M
mirror: M = Mirror(axis) * M
```

Rotation pivots can vary per command. This is why v1 stores the final affine matrix rather than `{ position, rotation }` fields. A raw matrix is harder to display, but it is the correct storage for repeated rotations/scales around arbitrary reference points.

Transform history is out of scope. If a future version needs editable transform stacks, that becomes a separate parametric-history feature. v1 only stores the resulting matrix.

### Operation semantics matrix

| Action | Behavior |
|---|---|
| Create rect/circle/ellipse/polygon/spline/text/STL | Create one definition and one instance with identity transform |
| Duplicate as Reference | Create a new instance pointing at the same definition |
| Duplicate Independent | Clone the definition and create a new instance |
| Make Unique | Clone the definition and repoint the selected instance |
| Delete instance | Remove the instance; if it was the last instance, remove the definition in the same undoable action |
| Move selected feature(s) | Update selected instance matrix only |
| Rotate selected feature(s) | Update selected instance matrix around the chosen pivot |
| Resize selected feature(s) | Update selected instance matrix |
| Circle resize command | Uniform instance scale; resolved instance remains a circle |
| Mirror selected feature(s) | Update selected instance matrix; resolver must normalize winding/orientation |
| Align/distribute selected features | Update selected instance matrices |
| Edit Sketch | Open the canonical untransformed definition |
| Edit circle radius in sketch edit | Mutate the definition; every linked instance updates |
| Add point to a circle / break circle shape | Convert the shared definition from circle to editable profile/composite; every linked instance updates |
| Insert/delete/move sketch points, fillet, disconnect, profile edit | Mutate the definition |
| Rename/folder/visible/locked | Instance only |
| `z_top`/`z_bottom` | Instance only |
| Constraint create/edit/delete | Instance only unless a future feature explicitly adds shared constraints |
| Join/Cut | Resolve selected instances to world geometry, compute boolean, create a new snapshot definition + instance |
| Offset | Resolve selected instances to world geometry, create new snapshot definition(s) + instance(s) |
| Use as stock / feature-based stock | Resolve instance to world geometry and snapshot/link according to stock-source semantics defined by that feature area |
| Toolpaths/simulation/G-code | Consume resolved world geometry |
| Save/load | Persist definitions, instances, matrices, and version/migration marker |

### Circle and scale handling

Current circle behavior maps cleanly to this model:

- In sketch edit, changing radius edits the shared definition.
- The selected-feature resize command is a uniform instance-scale operation.
- A circle under translate/rotate/uniform scale remains a circle in resolved geometry.
- A circle edited by adding points is no longer a circle; the definition becomes an editable profile/composite and all linked instances reflect that change.

Non-uniform scale is the risky case. A non-uniformly scaled circle becomes an ellipse; arcs and dimensions may also become ambiguous. v1 should either:

1. allow non-uniform scale only where the resolver can honestly represent the result, or
2. disallow/force "Make Unique" for cases that cannot be resolved without lying about the feature kind.

Because current circle resize is uniform, circle resize itself is not a blocker.

### Join / cut / offset snapshots

Join, cut, and offset do not mutate source definitions. They are destructive snapshot operations:

1. Resolve input instances into world-space geometry.
2. Run the boolean/offset operation.
3. Create a fresh `FeatureDefinition` from the result.
4. Create one or more `FeatureInstance`s pointing at the new definition(s).
5. Delete or preserve input instances according to the existing command's `keepOriginals` behavior.
6. Leave linked siblings of any consumed instance untouched.

This avoids introducing live parametric history. If future work wants smart booleans that re-evaluate from source instances, that belongs in a separate design.

### Definition lifetime

In v1, definitions are internal implementation objects, not user-manageable library assets. When the last instance of a definition is deleted, the definition is removed in the same undoable store action.

Future option: keep unused definitions as a project component library, similar to SketchUp components. That would require UI for browsing unused definitions, inserting new instances, renaming definitions, and pruning unused definitions. Out of scope for v1.

### Migration and serialization

`.camj` gains a top-level `featureDefinitions` map. Every existing file migrates by creating one definition per existing feature and replacing that feature with one instance pointing at the new definition.

Existing absolute profiles can initially migrate as canonical definition profiles with identity transforms. Later transform commands then operate on instance matrices. If a slice changes the coordinate convention beyond identity migration, it must include byte-equivalence tests for resolved geometry.

Important: current `Project.meta.schemaVersion` does not exist. The implementation must first choose the real version/migration marker:

- bump `Project.version`, or
- add and normalize a new project schema field, or
- migrate based on structural detection (`featureDefinitions` missing, legacy `feature.sketch` present).

This decision is a required first-slice deliverable.

### UI surface

- Feature tree row: small link badge when an instance's definition has more than one instance.
- Hover/focus affordance: "Select linked instances" command; optional sibling highlight.
- Context menu:
  - "Duplicate" / "Duplicate Independent" creates a fresh definition.
  - "Duplicate as Reference" creates another instance of the same definition.
  - "Make Unique" clones the definition and repoints the selected instance.
  - "Select Linked Instances" selects all instances with the same `definitionId`.
- Copy/paste default: project-level `copyMode: 'reference' | 'independent'`, default `'reference'`, with explicit context-menu overrides.
- Properties panel separates:
  - **Shape** fields: definition-backed, shared with N instances.
  - **Instance** fields: placement/Z/name/tree/visibility/lock.
- Edit Sketch launched from a transformed instance opens the canonical untransformed definition. This may look different from the placed instance, but it is the clearest model: edit sketch edits the shared source shape.

## Implementation workflow

This feature should use a managed integration branch, with implementation slices isolated in worktrees and merged back only after review.

### Branch and worktree model

```text
main
  -> feature-references
       -> feature-references-01-model-migration
       -> feature-references-02-resolver
       -> feature-references-03-read-paths
       -> feature-references-04-transform-commands
       -> feature-references-05-definition-editing
       -> feature-references-06-snapshot-ops
       -> feature-references-07-ui-workflow
```

- **Update:** the integration branch is now **`feature-references-v2`** (off current `main`). The
  original `feature-references` branch was built on a pre-core-arch-refactor base and was *ported*
  onto `main`'s decomposed store; see `FEATURE_REFERENCES_PORT_Plan.md` and the ledger. The slice tree
  below also gained `06.5`, `09`, and `10` (see the status note at the top).
- The original `feature-references` branch was the integration branch off `main`.
- Slice branches are created from the current integration branch.
- Slice branches use hyphenated names because `feature-references/...` cannot coexist with the integration branch ref named `feature-references`.
- Slice worktrees live under `/Users/frankp/Projects/worktrees/purecutcnc/`.
- Slice branches merge only into the integration branch.
- After every accepted slice merge, the integration branch must be pushed.
- No slice PRs target `main`.
- The final PR targets `main` from the integration branch after all slices are implemented and verified.

### Management session responsibilities

Management is separate from implementation. The management session owns:

- creating and updating the integration branch/worktree,
- maintaining the ledger,
- creating handoff tasks,
- verifying returned branch/worktree state before review,
- reviewing real diffs,
- running focused tests/builds where practical,
- running browser validation unless a handoff explicitly delegates a specific browser check to an implementation agent,
- asking the user for tablet/manual validation when needed,
- stopping any Chrome debug/browser automation instance immediately after browser validation finishes,
- merging accepted slice branches into the integration branch,
- keeping this plan accurate as the source of truth throughout the project,
- updating the ledger and plan before or in the same management commit as each merge,
- pushing the integration branch after each accepted merge so remote state never lags local management state,
- deciding the next slice or parallel batch.

Implementation agents own only the assigned handoff scope. They should not broaden the program, run browser validation unless the handoff explicitly delegates it, merge themselves into the integration branch, archive the plan, or open the final PR unless the management handoff explicitly says so. Each implementation task's final definition-of-done step is a simple commit on that task's worktree branch, followed by a report back to management.

Slice worktrees should reuse the main checkout dependencies by default. Each future implementation handoff should include a worktree setup step that symlinks `node_modules` from `/Users/frankp/Projects/purecutcnc/node_modules` into the slice worktree root before tests/build are run. Implementation agents should not run `npm install` in slice worktrees unless the symlink is unavailable or broken and management/user approval is obtained.

Browser/debug Chrome teardown is mandatory. Any slice that starts or attaches to a controlled Chrome/debug instance for browser validation must stop that instance as soon as the validation step is done. A slice is not considered fully verified until the debug browser teardown is confirmed or the teardown failure is recorded as a blocker/risk for the management session.

### Durable management artifacts

Use durable planning artifacts so work can be resumed across sessions:

```text
planning/FEATURE_REFERENCES_Plan.md
planning/FEATURE_REFERENCES_Ledger.md
planning/FEATURE_REFERENCES_Handoff_01_Model_Migration.md
planning/FEATURE_REFERENCES_Handoff_02_Resolver.md
...
```

The ledger tracks:

```md
| Slice | Branch | Worktree | Status | Owner | Base Commit | Result Commit | Verification | Merge Commit | Notes |
```

Suggested statuses:

```text
Planned
Assigned
In progress
Returned
Reviewing
Needs changes
Accepted
Merged
Blocked
```

Each handoff should include:

- exact integration branch/base commit,
- exact slice branch and worktree path,
- worktree environment setup, including the `node_modules` symlink rule,
- role boundary,
- files/areas expected to change,
- files/areas not allowed to change,
- acceptance criteria,
- required tests,
- whether browser validation is explicitly delegated or reserved for management,
- required final report format.

Implementation reports back with:

```md
Branch:
Worktree:
Commit(s):
Files changed:
Behavior implemented:
Verification run:
Browser validation:
Known gaps:
Manual/browser/tablet validation needed:
```

### Slice sequencing

Serial foundation:

1. **Model/versioning/migration**
   - Add definition/instance/matrix types.
   - Decide migration marker.
   - Migrate legacy projects to one definition + one instance per old feature.
   - Keep resolved geometry byte-equivalent with identity transforms.

2. **Resolver contract**
   - Add resolver helpers.
   - Add focused resolver tests.
   - Define resolved feature shape.
   - Route a small set of low-risk read paths through the resolver.

3. **Core read-path migration**
   - Route canvas/hit testing/toolpath read paths through resolved world geometry.
   - Keep behavior unchanged before enabling linked duplicates.

Parallelizable after resolver contract stabilizes:

4. **Transform commands**
   - Move/rotate/resize/mirror/align/distribute update instance matrices.
   - Preserve uniform circle resize behavior.
   - Add matrix helper tests.

5. **Definition editing**
   - Sketch edit mutates definitions.
   - Circle radius edit propagates.
   - Adding points to circles converts shared definitions.
   - Make Unique prevents propagation when needed.

6. **Snapshot operations**
   - Join/cut/offset resolve inputs and create new snapshot definitions/instances.
   - Preserve existing `keepOriginals` behavior.

7. **UI workflow**
   - Duplicate as reference.
   - Duplicate independent.
   - Make Unique.
   - Select linked instances.
   - Linked badge.
   - Properties panel shared-vs-instance grouping.
   - Project `copyMode` setting.

Final hardening:

8. **Integration verification**
   - Full `npm run build`.
   - Save/load fixtures.
   - Toolpath and operation regression coverage.
   - Browser/manual validation for affected UI surfaces.
   - Tablet validation if tree/context-menu/properties flows materially change tablet behavior.
   - Archive plan only after user confirms the integrated behavior is acceptable.
   - Open final PR from `feature-references` to `main`.

## Files affected

- `src/types/project.ts` — add definitions/instances/matrix types; update project shape; choose version/migration marker; keep/replace compatibility `Sketch` shape as needed.
- `src/store/projectStore.ts` and relevant `src/store/slices/*` — migration, definition/instance creation, duplicate/reference/make-unique, transform commands, definition-editing commands, deletion/GC, undo/redo-compatible mutations.
- *(new)* `src/store/featureDefinitions.ts` or `src/store/helpers/featureDefinitions.ts` — definition/instance helpers, reference counting, cloning, GC, make-unique helper logic.
- *(new)* `src/store/helpers/instanceTransforms.ts` or equivalent — matrix helpers, pivoted rotate/scale/mirror composition, transform classification.
- *(new)* `src/store/helpers/resolveFeatures.ts` or equivalent — resolve definition + instance into world-space feature/sketch/profile views.
- `src/components/canvas/*` — route drawing, hit testing, edit entry, snapping, dimensions, and controls through resolved geometry where appropriate.
- `src/components/feature-tree/FeatureTree.tsx` — linked badge, linked selection, duplicate/reference/make-unique context actions.
- `src/components/feature-tree/PropertiesPanel.tsx` — shared shape vs instance grouping; effective radius/placement display; make-unique affordance.
- `src/engine/toolpaths/**` — consume resolved world geometry instead of persisted `feature.sketch.profile`.
- `src/engine/gcode/**` — should mostly remain downstream of resolved toolpaths; verify no direct geometry assumptions remain.
- `src/import/**` — imported shapes create definitions + instances; `.camj` import merges definitions without ID collisions.
- `src/store/helpers/derivedFeatures.ts` and boolean/cut/join helpers — snapshot operations create fresh definitions/instances.
- `src/store/helpers/normalize.ts` and project normalization paths — normalize/migrate definitions and instances.
- `ARCHITECTURE.md` — document definitions vs instances after implementation is approved and underway.
- `src/**/INDEX.md` files — update nearest indexes when new files/folders land.
- `planning/FEATURE_REFERENCES_Ledger.md` — management ledger.
- `planning/FEATURE_REFERENCES_Handoff_*.md` — implementation handoffs.

## Tests

- **Migration:** legacy project loads into one definition + one instance per old feature; resolved geometry is equivalent to pre-migration geometry.
- **Versioning:** chosen schema/version marker prevents repeated migration and handles already-migrated projects.
- **Resolver:** identity transform returns today's sketch-shaped data; translate/rotate/uniform-scale/mirror produce expected world geometry.
- **Circle preservation:** translate/rotate/uniform-scale circle resolves as a circle with effective radius; adding a point converts the definition to a non-circle profile.
- **Link propagation:** editing definition profile/dimensions/text/STL through one instance updates all linked instances.
- **Instance independence:** move/rotate/resize/mirror/Z/name/folder/visible/locked changes affect only selected instances.
- **Make Unique:** clone and repoint one instance; later definition edits do not affect the unique copy; undo restores linkage.
- **Delete/GC:** deleting the last instance removes the definition; undo restores both.
- **Round-trip:** mixed linked/unique projects save and reload exactly.
- **Operation targets:** operations continue to reference instance IDs and resolve correct geometry/Z spans.
- **Toolpaths:** linked instances with different transforms produce expected toolpaths from resolved world geometry.
- **Join/Cut snapshots:** boolean operations create new definitions and do not mutate linked source definitions.
- **Offset snapshots:** offset creates new definitions/instances and preserves current behavior.
- **Copy mode:** default copy/paste follows project `copyMode`; explicit context actions override.
- **Import:** SVG/DXF/STL/CAMJ import creates definitions/instances and avoids definition ID collisions.
- **UI:** feature tree badges/actions and properties grouping render correctly; tablet flows validated if affected.

`npm run build` remains the final required gate before integration branch PR. Focused `npx tsx ...` tests should be added per slice so management can review smaller branches without relying only on the full build.

## Open questions / risks

1. **Migration marker.** Current project types do not have `Project.meta.schemaVersion`. The first implementation slice must choose the real schema/version mechanism.

2. **How much compatibility shape remains.** We need to decide whether persisted instances keep any `sketch` compatibility field during migration, or whether all call sites move to explicit resolver helpers in the same slice sequence.

3. **Non-uniform scale.** General profile non-uniform scale may be acceptable, but circles/arcs/dimensions/text/STL need clear handling. v1 can restrict non-uniform scale where needed.

4. **Mirror winding/orientation.** Mirrored profiles can invert winding and inside/outside semantics. Resolver or downstream geometry normalization must make this explicit before mirror is fully enabled.

5. **Edit Sketch entry from transformed instance.** Opening the canonical untransformed definition is the chosen model, but it may feel visually surprising. UI should clearly state when a shared definition is being edited.

6. **Operation at definition vs instance level.** v1 keeps `operation` on the definition. If users need one linked outline used as both add and subtract, they should use independent definitions or Make Unique.

7. **Feature-based stock interaction.** Stock-source behavior needs an explicit slice-level decision: resolve and snapshot vs retain a reference to an instance. V1 should avoid invisible live dependencies unless deliberately designed.

8. **Performance.** Resolver calls may be hot in canvas/toolpath paths. Start simple, but be ready to memoize by `(instanceId, definitionId, definitionVersion, transform)` if profiling shows cost.

9. **Parallel work coordination.** Parallel slices are only safe after the resolver contract is stable. Management should avoid assigning overlapping areas until the foundation has merged into the integration branch.

10. **UI capacity.** Feature tree and Properties panel are the main homes for this feature. Avoid adding global toolbar clutter; use contextual actions and clear grouping.

## Out of scope

- Editable transform history / parametric transform stack.
- Live parametric join/cut/offset graphs.
- Per-instance overrides of definition fields.
- Standalone component/definition library UI.
- Keeping unused definitions for manual reinsertion.
- Cross-project references.
- Importing definitions as reusable library components.
- Linked operations; operations continue to target instances.
- Full non-uniform transform support for every feature kind if honest geometry resolution is not ready.
- Opening slice PRs to `main`; only the final integration branch opens the main PR.
