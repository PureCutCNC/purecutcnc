# Feature-as-Stock Design

## Goal

Allow any sketch feature to serve as the stock definition, instead of only supporting a plain rectangular block. The user selects an existing feature and the app adopts its 2D profile and Z extent as the stock boundary.

## Current Behavior

Stock is defined as a `Stock` object with a `SketchProfile`, `thickness`, `origin`, `material`, `color`, and `visible` flag. Today `defaultStock()` always creates a `rectProfile()`. The UI in PropertiesPanel only exposes width/height/thickness inputs and recreates a rectangle on every edit.

## Proposed Data Model Change

Add `sourceFeatureId` and `sourceFeature` fields to `Stock`:

```typescript
export interface Stock {
  profile: SketchProfile
  thickness: number
  material: string
  color: string
  visible: boolean
  origin: Point
  sourceFeatureId?: string | null   // NEW — links stock to a feature
  sourceFeature?: SketchFeature | null  // NEW — the full feature data, removed from the features array
}
```

When `sourceFeatureId` is set:
- The source feature is **removed from `project.features` and `project.featureTree`** — it no longer participates as a regular feature.
- The full `SketchFeature` is stored in `stock.sourceFeature` so it can be edited from the stock properties panel and restored to the tree later.
- `stock.profile` is kept in sync with the source feature's `sketch.profile` (transformed by the feature's `sketch.origin` and `orientationAngle`).
- `stock.thickness` is derived from the feature's z_top (assuming z_bottom = 0 for stock).
- Edits to the source feature's sketch automatically update the stock boundary.

When `sourceFeatureId` is null/undefined (default), behavior is identical to today — the stock is an independent rectangle or user-defined shape.

## Impact Analysis

### No changes needed (already profile-agnostic)

| Component | File | Why |
|-----------|------|-----|
| 3D CSG mesh | `src/engine/csg.ts:174-192` | `profileToShape()` handles any profile; `ExtrudeGeometry` extrudes any 2D shape |
| 3D wireframe | `src/engine/csg.ts:805-820` | Same `profileToShape()` path |
| 2D canvas rendering | `src/components/canvas/SketchCanvas.tsx:770-781` | `traceProfilePath()` is generic |
| View transforms | `src/components/canvas/viewTransform.ts` | Uses `stock.profile` directly |
| Snap candidates | `src/components/canvas/snappingHelpers.ts:231` | Generic profile snapping |
| Grid centering | `src/components/canvas/scenePrimitives.ts:213-264` | Uses `getStockBounds()` |
| Import/export | `src/store/projectStore.ts:2968-3029` | Preserves `stock.profile` as-is |
| Unit conversion | `src/utils/units.ts:193-200` | Converts any profile generically |
| Toolpath engine | `src/engine/toolpaths/*.ts` | Works with feature/region profiles, not stock shape |
| Safe Z calculation | `src/engine/toolpaths/geometry.ts:173-177` | Uses `stock.thickness` only |
| Depth levels | `src/engine/toolpaths/surface.ts:235` | Uses `stock.thickness` only |

### Changes required

#### 1. Stock type & defaults (`src/types/project.ts`)

- Add `sourceFeatureId?: string | null` to `Stock` interface.
- Keep `defaultStock()` as-is for the rectangle path.
- Add a helper `stockFromFeature(feature: SketchFeature): Stock` that builds a Stock from a feature's profile and Z span.
- Add `getEffectiveStockProfile(project: Project): SketchProfile` — returns the derived profile when `sourceFeatureId` is set, or `stock.profile` otherwise.

**Complexity: Low**

#### 2. Store actions (`src/store/projectStore.ts`)

- Add a `setStockSourceFeature(featureId: string | null)` action that:
  - Sets `stock.sourceFeatureId`.
  - Syncs `stock.profile` and `stock.thickness` from the feature.
  - **Removes the feature from `features`, `featureTree`, and its folder** — it now lives only as the stock source. The feature data is preserved in a new `stock.sourceFeature` field (see data model).
  - Updates origin if needed.
  - Pushes to undo history.
- When calling `setStockSourceFeature(null)` (resetting to rectangle):
  - If a previous source feature exists, **restore it back into `features` and `featureTree`** at its original position (or end of tree).
  - Reset `stock.profile` to a `rectProfile` matching the previous bounds.
- When calling `setStockSourceFeature(newId)` while another feature is already the source:
  - **Restore the old source feature** back into the tree first.
  - Then remove the new source feature from the tree.
- Modify feature mutation actions (move, resize, edit profile, delete) to re-sync stock when the mutated feature is the stock source:
  - On profile/position/Z change: update `stock.profile` and `stock.thickness`.
  - On delete: clear `sourceFeatureId`, restore to rectangle.

**Complexity: Medium-High**

#### 3a. Feature context menu — "Use as Stock" (`src/components/feature-tree/FeatureTree.tsx`)

The primary way to assign a feature as stock. The feature tree's right-click context menu already exists for features. Add a new item:

- **"Use as Stock"** — visible only for features with `operation === 'add'` and `sketch.profile.closed === true`. Calls `setStockSourceFeature(featureId)`. The feature disappears from the tree.
- The stock node itself does not need a context menu for this — "Reset to Rectangle" lives in the properties panel.

**Complexity: Low**

#### 3b. Stock properties panel (`src/components/feature-tree/PropertiesPanel.tsx:510-600`)

Currently hard-codes rectangular editing via `defaultStock(width, height, thickness)`.

New layout when stock node is selected:

```
Stock
  -- When Rectangle (sourceFeatureId is null) --
  Width:  [____]
  Height: [____]
  Thickness: [____]
  
  -- When sourced from a feature --
  Source: "Feature Name"  (read-only label)
  Thickness: [____]  (derived from feature z_top, editable → updates feature z_top)
  Bounding Size: 120 x 85  (read-only info)
  [Edit Sketch]  button — enters sketch editing mode for the source feature
  [Reset to Rectangle]  button — calls setStockSourceFeature(null), restores feature to tree
```

- Width/Height inputs are hidden when a feature source is active (shape is controlled by the feature's sketch).
- "Edit Sketch" activates the same sketch editing flow used for regular features, but targeted at the source feature stored in `stock.sourceFeature`.
- Color, material, visible remain unchanged in both modes.

**Complexity: Medium**

#### 4. Simulation grid (`src/engine/simulation/grid.ts`)

The voxel grid is rectangular and fills every cell with `stockTopZ`. For non-rectangular stock, cells outside the stock profile should start empty (Z = 0).

Changes to `createSimulationGrid()`:
- After filling `topZ`, iterate each cell and test whether its center point is inside `stock.profile` using a point-in-polygon test.
- Cells outside the profile get `topZ[i] = stockBottomZ` (empty).
- Use `sampleProfilePoints()` to get the polygon boundary and a standard ray-casting PIP test.

The grid spec (`resolveSimulationGridSpec`) remains unchanged — it uses bounding box dimensions which is correct (the grid must cover the full extent; individual cells are masked).

**Complexity: Low-Medium** — straightforward PIP test, but must be efficient since cell counts can reach 30k+.

#### 5. Bounds validation (`src/types/project.ts:959-968`)

`profileExceedsStock()` currently does a bounding-box-only check. For non-rectangular stock this is overly permissive — a feature could be inside the bounding box but outside the actual stock profile.

For now, keep the bbox check. It remains correct as a quick conservative test (if a feature exceeds the stock bbox, it definitely exceeds the stock). False negatives (feature reported as "within stock" when it's actually outside a concave stock boundary) are acceptable in the first iteration — the simulation and CSG will correctly handle the geometry regardless.

A tighter point-in-polygon validation can be added later if users request visual warnings for features extending past non-rectangular stock edges.

**Complexity: None (defer)**

#### 6. CSG scene building (`src/engine/csg.ts:833-893`)

No special exclusion logic needed. Since the source feature is already removed from `project.features` by the store action, `buildScene()` will naturally not include it in the feature mesh list. The stock mesh — built from `stock.profile` — represents the source feature's volume.

**Complexity: None**

#### 7. Sketch editing from stock panel

The "Edit Sketch" button in the stock properties panel must enter the same sketch editing mode used for regular features, but operating on `stock.sourceFeature` instead of a feature from the `features` array.

- Reuse the existing sketch editing infrastructure (selection, vertex dragging, segment manipulation).
- On commit, update both `stock.sourceFeature` and `stock.profile`/`stock.thickness` in a single undo-able action.
- The 2D canvas renders the stock profile with the stock's dashed-line style during editing, overlaid with the sketch editing handles.

**Complexity: Medium**

## Implementation Order

1. **Data model** — Add `sourceFeatureId` and `sourceFeature` to Stock interface and helpers.
2. **Store actions** — `setStockSourceFeature` (remove/restore feature from tree, sync profile). Handle swap and reset flows.
3. **Context menu** — "Use as Stock" in feature right-click menu.
4. **PropertiesPanel** — Conditional rendering: rectangle fields vs. feature-source display with "Edit Sketch" and "Reset to Rectangle".
5. **Sketch editing from stock** — Wire "Edit Sketch" button to existing sketch editor targeting `stock.sourceFeature`.
6. **Simulation masking** — Point-in-polygon cell initialization for non-rectangular stock.
7. **Testing** — Create projects with circular, polygon, and freeform stock profiles. Verify swap, reset, undo/redo, and file save/load.

## Edge Cases

- **Feature with holes/subtract children**: Stock profile should use only the outer boundary of the source feature, ignoring any subtract operations. Stock is the raw material block shape.
- **Feature moved off-origin**: The stock profile must account for the feature's `sketch.origin` offset. Transform the profile to project coordinates before assigning to stock.
- **Open profiles**: Only closed profiles can be stock. The context menu item should only appear for features with `sketch.profile.closed === true`.
- **STL features**: STL features have a `silhouettePaths` that could serve as the stock profile. Support this in a later iteration.
- **Swapping stock source**: When a second feature is declared as stock while one already is, the old source feature is restored to the feature tree first, then the new one is removed. This is a single undo-able action.
- **Reset to rectangle**: "Reset to Rectangle" restores the source feature to the tree and sets `stock.profile` to a `rectProfile` matching the previous stock bounds. Single undo-able action.
- **Undo/redo**: `setStockSourceFeature` captures the full before/after state (feature array, feature tree, stock) as one undo entry. Undoing restores the feature to the tree and reverts stock to its previous profile.
- **File save/load**: `stock.sourceFeature` is serialized as part of the `.camj` file. On load, no migration needed — old files without the field load as rectangle stock. New files with `sourceFeature` restore correctly since the feature data is self-contained in the stock object.

## What This Does NOT Change

- The `Stock` interface keeps its existing `profile` field as the source of truth for stock shape. When `sourceFeatureId` is set, the profile is *derived* from the feature but still stored explicitly — downstream code never needs to know about the source linkage.
- Toolpath generation is unaffected — it works with feature profiles and regions, not stock shape.
- G-code export is unaffected — it uses operation clearance Z and feature Z spans, not stock profile geometry.
- File format remains backward-compatible — old files without `sourceFeatureId` load exactly as before.
