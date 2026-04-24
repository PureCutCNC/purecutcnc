# Machining Order — Level-First vs Feature-First

## Problem

When an operation targets multiple features, the current toolpath generator
processes **one depth level at a time across all features** (level-first):
it cuts one stepdown in every feature, retracts, moves to the next feature,
and only once every selected feature has been cut at the current depth does
it drop to the next level.

Users also want the option to **finish each feature completely before moving
on** (feature-first): machine all levels in feature A, then retract and go
machine feature B from top to bottom, etc.

Feature-first is preferable when:

- Features are far apart — fewer long rapids between repeated depth passes.
- The user wants to be able to eject a finished part/pocket early.
- Chip evacuation / dust collection per pocket matters.

Level-first is preferable when:

- Features are close together — minimises total depth of cut per pass on a
  stiff setup, reducing deflection.
- Overlapping targets should be resolved as one merged region per band (the
  resolver already does this today).

This plan adds a per-operation toggle while keeping **level-first as the
default** (current behaviour).

## Scope

The toggle applies to the following operation kinds (they all currently do
level-first across multiple selected features):

| Kind                | Current | Needs feature-first path |
|---------------------|---------|--------------------------|
| `pocket`            | level-first | yes |
| `v_carve`           | level-first | yes |
| `v_carve_recursive` | level-first | yes |
| `edge_route_inside` | level-first | yes |
| `edge_route_outside`| **already feature-first** (per-target loop) — plus a "combined union" optimisation when depths match | toggle must also suppress the combined-union path |
| `surface_clean`     | single stock target, not feature-driven | n/a |
| `follow_line`, `drilling`, `tabs` | path-per-feature by nature | n/a |

## User-facing design

- New dropdown on the operation properties panel labelled **Machining order**
  with options:
  - **Level first** (default) — "Cut all features at each depth before
    stepping down." (current behaviour)
  - **Feature first** — "Finish each feature fully before moving on."
- Shown only for operation kinds where the toggle is meaningful:
  `pocket`, `v_carve`, `v_carve_recursive`, `edge_route_inside`,
  `edge_route_outside`.
- For `edge_route_outside` the hint text below the dropdown should note that
  **Feature first also disables the combined-union outside cut** (otherwise
  touching outlines are cut as one perimeter even in feature-first mode).

## Schema

Add to `Operation` in `src/types/project.ts`:

```ts
export type MachiningOrder = 'level_first' | 'feature_first'

export interface Operation {
  // ...
  machiningOrder?: MachiningOrder   // defaults to 'level_first' when absent
}
```

Optional rather than required so existing `.camj` files stay valid on load.
Generators treat `undefined` as `'level_first'`.

Default for new ops (in `makeOperation` in `src/store/projectStore.ts`):
`machiningOrder: 'level_first'`.

## Generator changes

All feature-first implementations follow the same recipe: **run the existing
per-operation generator once per selected target feature, concatenating the
resulting moves**. A single helper keeps this consistent.

### 1. Helper — split by feature

Add to `src/engine/toolpaths/geometry.ts` (or a new `multiFeature.ts`):

```ts
export function perFeatureOperations(operation: Operation): Operation[] {
  if (operation.target.source !== 'features') return [operation]
  if (operation.target.featureIds.length <= 1) return [operation]
  return operation.target.featureIds.map((featureId) => ({
    ...operation,
    target: { source: 'features', featureIds: [featureId] },
  }))
}
```

Important: this splits at the **user-selected feature id** level. Text
features that expand internally via `expandFeatureGeometry` still expand
normally inside each synthetic single-feature op — the user's mental model
("one entry in the target list = one feature") is preserved.

### 2. Wrapper — concatenate sub-toolpaths

Each generator gets a small front-matter that:

1. Short-circuits to the existing implementation for `level_first`.
2. For `feature_first`, calls itself on each single-feature synthetic op and
   merges the results (concat `moves`, union `stepLevels`, unify `bounds`,
   concat `warnings`).

Concretely, the existing generator body is renamed to e.g.
`generatePocketToolpathSingle` and `generatePocketToolpath` becomes a thin
dispatcher:

```ts
export function generatePocketToolpath(project, operation): PocketToolpathResult {
  if ((operation.machiningOrder ?? 'level_first') === 'level_first'
      || operation.target.source !== 'features'
      || operation.target.featureIds.length <= 1) {
    return generatePocketToolpathSingle(project, operation)
  }

  const subResults = perFeatureOperations(operation)
    .map((subOp) => generatePocketToolpathSingle(project, subOp))
  return mergeToolpathResults(operation.id, subResults)
}
```

`mergeToolpathResults` lives next to the helper and handles both the
`ToolpathResult` shape (edge, vcarve, vcarveRecursive) and the
`PocketToolpathResult` shape (pocket — it has an extra `stepLevels`).

### 3. Per-kind wiring

- **`generatePocketToolpath`** (`pocket.ts`): split as above.
- **`generateVCarveToolpath`** (`vcarve.ts`): split as above.
- **`generateVCarveRecursiveToolpath`** (`vcarveRecursive.ts`): split as
  above.
- **`generateEdgeRouteToolpath`** (`edge.ts`):
  - `edge_route_inside`: split as above.
  - `edge_route_outside`: in feature-first mode, skip the
    `shouldAttemptCombinedOutside` branch entirely and go straight to the
    existing per-target loop. Also run the per-target loop per synthetic
    single-feature op so the semantics match the other kinds exactly.

### 4. Behaviour around islands and `add`-features

`add` features acting as islands are resolved per-band inside the resolver.
Since every synthetic single-feature op still runs the full resolver with
the entire `project.features` list, islands and tabs that intersect each
target are still honoured correctly.

### 5. Overlapping targets

In level-first mode, overlapping pockets unify within a band. In
feature-first mode they will be cut twice (each feature's toolpath is
independent). This is intentional — feature-first is explicitly "each
feature on its own" — but it warrants a one-line warning when overlap is
detected. The resolver already produces enough information to detect
overlap, but shipping that warning is optional for v1; skip unless cheap.

## UI changes

In `src/components/cam/CAMPanel.tsx`, alongside the **Cut Direction** field,
add:

```tsx
{(selectedOperation.kind === 'pocket'
  || selectedOperation.kind === 'v_carve'
  || selectedOperation.kind === 'v_carve_recursive'
  || selectedOperation.kind === 'edge_route_inside'
  || selectedOperation.kind === 'edge_route_outside') ? (
  <label className="properties-field">
    <span>Machining Order</span>
    <select
      value={selectedOperation.machiningOrder ?? 'level_first'}
      onChange={(event) => updateOperation(selectedOperation.id, {
        machiningOrder: event.target.value as MachiningOrder,
      })}
    >
      <option value="level_first">Level first (all features per depth)</option>
      <option value="feature_first">Feature first (one feature at a time)</option>
    </select>
  </label>
) : null}
```

The field is shown even when a single feature is targeted (selecting "feature
first" there is a no-op — generator short-circuits — but avoids UI flicker
as the user edits target membership).

## Migration / persistence

- `.camj` files without `machiningOrder` load as `level_first` (generator
  default) — no migration needed.
- Writing back preserves the field (operation objects are saved verbatim).

## Tests

- Unit: `perFeatureOperations` returns a list of single-feature synthetic
  ops preserving all other fields.
- Unit: `mergeToolpathResults` concatenates moves, unions `stepLevels`,
  merges bounds, preserves operationId.
- Integration (one per kind — pocket, vcarve, vcarveRecursive,
  edge_route_inside, edge_route_outside):
  - With 2 disjoint target features:
    - Level-first output has interleaved Z levels.
    - Feature-first output has monotonically-decreasing Z within each
      feature's contiguous move range.
    - Total cut-move length is (approximately) the same between modes for
      disjoint features.
- Regression: single-feature ops produce byte-identical output across
  modes (short-circuit).

## Implementation order

1. Add `MachiningOrder` type + `machiningOrder?` field on `Operation`.
   Default in `makeOperation`.
2. Add `perFeatureOperations` + `mergeToolpathResults` helpers.
3. Refactor `generatePocketToolpath` → `Single` + dispatcher.
4. Same refactor for `vcarve`, `vcarveRecursive`, `edge` (both kinds).
5. Add the UI field in `CAMPanel.tsx`.
6. Add unit + integration tests.
7. Smoke-check simulator output for a 2-hole project in both modes.

## Non-goals

- Mixing modes across different bands within one operation.
- Re-ordering between features (feature-first uses the operation's
  `target.featureIds` order; no greedy shortest-travel between features —
  that can be a follow-up).
- Changing level-first semantics for overlapping features; those still
  merge in the resolver exactly as before.
