---
status: Done
created: 2026-05-27
---

# .camj Folder Import Plan

## Goal

Allow users to import selected feature folders from another `.camj` project into the current project. Today the only way to bring `.camj` content into an existing project is to open the file as a whole (replacing the current project). This plan adds a partial-import flow: pick a `.camj`, see its folders, select which folders to bring in, and merge them into the current project — together with their features, referenced model assets, dimensions, tools, and operations that target them.

The user-visible outcome: the existing **Import Geometry** dialog accepts `.camj` files. When one is loaded, the right-hand panel that normally lists DXF layers instead lists the source project's feature folders with checkboxes. Clicking **Import** merges the selected folders' contents into the current project; loose (un-foldered) features in the source are not selectable.

## Approach

Extend the existing `ImportGeometryDialog` rather than building a new dialog. The folder list reuses the styling/layout of the DXF layer list.

High-level steps:

1. **Source typing.** Add `'camj'` to `ImportSourceType` and to the file-picker `accept` list (`.svg,.dxf,.stl,.obj,.camj`). Add a `detectSourceType` branch and a `sourceTypeLabel` entry.
2. **Loading a `.camj`.** Read the file as text, `JSON.parse` it, and validate the shape minimally (must be an object with `features`, `featureFolders`, and `featureTree` arrays). Do **not** run the full `normalizeProject` on it — we want the data shape as it sits on disk, with later normalization applied to the merged result. Store the parsed `Project` in a new `loadedFile.camjProject` field alongside an `inspection` object whose `layers` array holds the **folder ids** (display name from `featureFolders[i].name`).
3. **Folder selection UI.** When `sourceType === 'camj'`, reuse the existing layers column to render the source project's folders. Show only folders that contain at least one feature reachable through the source `featureTree` (folder section + nested feature entries). Initially all folders selected. Provide a "Select all / Deselect all" toggle. Units selector and join-tolerance/axis-swap controls are hidden for camj imports — units are read from the source project meta, with a read-only display row showing source vs. project units.
4. **Unit conversion.** If `sourceProject.meta.units !== project.meta.units`, scale point coordinates and Z values during the merge (mm↔inch using the same factor as the geometry importers, 25.4). Tool diameters, feeds, etc. are scaled as part of the tool-import step. Named dimensions' numeric `value` field gets scaled; `formula` strings are imported verbatim.
5. **Merge logic.** Add a new `importCamjFolders(input)` action to `projectStore`. The action:
   - Generates a fresh id for every imported folder/feature/dimension/tool/operation/model asset.
   - Uses the existing `uniqueFolderName` / `uniqueName` / `nextUniqueGeneratedId` helpers for collision-free naming and ids (suffix-rename, IDs always regenerated).
   - Maps `old id → new id` for: folders, features, dimensions, model assets, tools.
   - Brings in `modelAssets` referenced by any imported STL feature's `meshAssetId`, remapping the key.
   - Brings in `dimensions` referenced by any imported feature's `z_top`/`z_bottom` (DimensionRef strings).
   - Brings in `tools` referenced by `operation.toolRef` of imported operations.
   - Brings in `operations` whose `target.source === 'features'` and **all** target feature ids are inside the imported folder set. Operations targeting `stock` or partially missing features are skipped. Imported operations' `target.featureIds` and `toolRef` are remapped to new ids.
   - `global_constraints`: skip for now (cross-feature constraints are out of scope — see below).
   - Appends entries to `featureTree` in the same order they appeared in the source (folder entry followed by the folder's feature children where applicable). Loose features in the source are intentionally not surfaced.
   - Recomputes `meta.modified`, runs `syncFeatureTreeProject` and `dedupeProjectIds`, and pushes onto undo history (same pattern as `importShapes`).
6. **Wire dialog → action.** On Import, the dialog calls `importCamjFolders({ fileName, camjProject, selectedFolderIds })`. The store returns the created folder ids; the dialog calls `onImportComplete?.()` and closes.

### New file structure

A new helper module isolates the `.camj`-specific parsing and the merge math from the store, keeping `projectStore.ts` slim:

- `src/import/camj.ts` — `inspectCamjString(text): CamjInspection` (folders + warnings + source units + raw `Project`), `mergeCamjFolders(currentProject, sourceProject, selectedFolderIds): MergeResult` (pure, returns the post-merge `Project` shape plus the created folder/feature ids). The store action thin-wraps this in a `set(...)` call so undo history is captured.

The pure-function split makes the merge unit-testable without touching the store.

## Files affected

- *(new)* `src/import/camj.ts` — `.camj` parsing, folder inspection, and pure merge function.
- `src/import/index.ts` — re-export `inspectCamjString` (and `importCamjFolders` if surfaced here for symmetry).
- `src/import/types.ts` — extend `ImportSourceType` with `'camj'`.
- `src/store/projectStore.ts` — add `importCamjFolders` action (thin wrapper around `mergeCamjFolders` from `src/import/camj.ts`); declare it on the store type interface.
- `src/components/project/ImportGeometryDialog.tsx` — accept `.camj` in the file picker, detect it, populate the right-hand list with folder names (reusing the layer-list styling), hide units/join-tolerance/axis-swap controls in camj mode, call the new store action on Import.
- `src/components/project/INDEX.md` — note the new behaviour of the dialog (if that file exists; otherwise skip).
- `src/store/INDEX.md` and `src/import/INDEX.md` — note the new action and module.

## Tests

Unit tests for the pure merge function in `src/import/camj.test.ts`:

- Imports a single folder with two features; verifies new ids, folder added to `featureFolders`/`featureTree`, features added to `features` with remapped `folderId` and unique names.
- Name collision: importing a folder whose name matches an existing folder yields a suffixed name; same for feature names.
- `meshAssetId` remap: STL feature whose `meshAssetId` references a mesh in the source `modelAssets` ends up referencing a fresh key in the merged `modelAssets`, with the mesh data copied; an unused mesh in the source is not copied.
- Dimension remap: feature with `z_top` as a dimension key (string) brings the named dimension across with a remapped id and updated `z_top` ref; unreferenced source dimensions are not copied.
- Tool + operation co-import: an operation targeting only features inside the selected folder is imported with remapped `target.featureIds` and `toolRef`; the referenced tool is imported.
- Operation **not** imported when it targets a feature outside the selected folders, or when its target is `stock`.
- Unit scaling: source project in mm imported into an inch project scales point coords, dimension values, tool diameters/feeds, and z_top/z_bottom literal numbers by 1/25.4 (and the reverse).
- Loose features (in `featureTree` but with `folderId: null`) are not exposed by `inspectCamjString` and never merged.

No new structural canvas/rendering tests are needed — once features are inserted via the normal `features`/`featureFolders`/`featureTree` arrays, existing rendering covers them.

## Open questions / risks

- **Backdrop, stock, origin, grid, machine definitions, global_constraints**: not imported. Open question — surface a small note in the dialog explaining what does **not** come across, so users aren't surprised when stock/origin stay as they were.
- **Tool name dedup**: a re-imported tool with identical params to an existing one could in theory be coalesced; this plan instead always creates a fresh tool entry (renamed on collision) to keep merge logic simple. Confirm that's acceptable.
- **Unit scaling for formulas**: `NamedDimension.formula` strings are imported verbatim. If a formula references `stock_thickness` or another name that doesn't exist in the target project, the dimension will evaluate against its literal `value`. Documenting this as a known limitation.
- **Large model assets**: a `.camj` with several large STL meshes can be tens of MB. Reading the whole file into memory and JSON-parsing is consistent with the existing open-project path, so no new constraint here, but worth flagging.

## Out of scope

- Importing whole-project settings (origin, grid, backdrop, machine definitions, AI history, project meta).
- Importing `global_constraints` — cross-feature constraints reference feature ids and would need a remap + validation pass; we'll add this only if users ask for it.
- Surfacing loose (un-foldered) features in the picker — folders-only per UX decision.
- Conflict-resolution UI (rename/skip/replace prompts) — auto-rename only.
- Importing operations whose `target.source === 'stock'`, or operations partially covering imported features — silently skipped.
- Re-using tool/dimension entries that are byte-identical to existing ones — always copy as new.
- Importing rectangular (non-feature-based) stock — out of scope; we don't want to silently overwrite a user's stock when the source is just a default rectangle.

## Addendum: feature-based stock import (2026-05-27)

### Goal

When the source `.camj`'s `stock.sourceFeatureId` is set (stock is derived from a feature), allow the user to opt in to replacing the current project's stock with that feature-based stock during the same import.

### UI

A new checkbox in the **Settings** group, above the folders panel:

> ☐ Import stock from source (replaces current stock)

The checkbox is:
- **Hidden** when the source stock is not feature-based.
- **Unchecked by default** when shown — opt-in to avoid surprise overwrites.
- Accompanied by a one-line note: `Current stock and origin will be replaced.`

The checkbox lives in the same Settings group as the units row, beneath the "Stock, origin, backdrop, grid, and global constraints are not imported." note (which gets re-worded — see below).

### Behaviour

When **Import stock** is checked:
1. Build a new `SketchFeature` from the source `stock.sourceFeature` with a fresh id, mm↔inch converted via `convertFeature` (or `convertProjectUnits` if we keep the unified path).
2. Build a new `Stock` via `stockFromFeature(newFeature)`. Material/color/visible/origin (the stock origin point, not MachineOrigin) come from the source stock.
3. Recompute `MachineOrigin` via `defaultOrigin(newStock)` so it sits on the new stock's bounds.
4. The imported stock feature is **not** added to `features` — it lives inside `stock.sourceFeature` per the existing convention (`Stock.sourceFeature` comment in `src/types/project.ts`).
5. The merge proceeds normally; folder selection is independent of the stock import (the user can import only stock, or stock + folders, or just folders).

When the checkbox is **unchecked**, current behaviour is preserved — stock stays as-is.

The note text becomes: `Backdrop, grid, machine definitions, and global constraints are not imported.` (drops "stock" and "origin" since those are now conditionally imported).

### Data flow

`MergeCamjFoldersInput` gains a new boolean field `importStock` (default `false`). `mergeCamjFolders` validates: if `importStock` is true and the source stock is not feature-based, the function ignores the flag and emits a warning instead of throwing (so the dialog handles "checkbox shouldn't have been enabled" gracefully).

`CamjInspection` gains `stockIsFeatureBased: boolean` so the dialog can decide whether to show the checkbox.

### Files affected (delta from main plan)

- `src/import/camj.ts` — extend `CamjInspection` with `stockIsFeatureBased`; extend `MergeCamjFoldersInput`/`Result` and implement the stock-import branch.
- `src/components/project/ImportGeometryDialog.tsx` — show the checkbox conditionally; pass `importStock` through to `importCamjFolders`.
- `src/store/projectStore.ts` and `src/store/types.ts` — `importCamjFolders` action signature gains the `importStock` flag.

### Tests (delta)

Add to `src/import/camj.test.ts`:

- `inspectCamjString` reports `stockIsFeatureBased: true` when source stock has `sourceFeatureId` + `sourceFeature`, `false` otherwise.
- `mergeCamjFolders` with `importStock: true` replaces the current stock with a feature-derived stock; the new `stock.sourceFeature.id` is a fresh id; the `MachineOrigin` is recomputed from the new bounds.
- `mergeCamjFolders` with `importStock: true` but a non-feature-based source stock leaves the current stock untouched and emits a warning.
- mm→inch unit scaling applies to the imported stock feature's profile and thickness.

### Open question

Material colour and `stock.visible` — copy verbatim from source. Material string is just a label so no conversion is needed. Confirmed via the existing `convertStock` (it preserves these fields).
