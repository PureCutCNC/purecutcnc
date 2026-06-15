# INDEX — src/store/

Zustand store. The single source of truth for the current `.camj` project. **All project mutations must go through actions on `projectStore` — never mutate state directly.**

## Files
- `projectStore.ts` — main store: project state, feature tree, undo/redo, persistence, tool/operation/stock actions. The big one.
- `types.ts` — store-internal types (state shape, action signatures)

## Subfolders
- `slices/` — focused slices of store behavior
  - `selectionSlice.ts` — which features/segments are currently selected
  - `pendingActionsSlice.ts` — queue of deferred ops awaiting user confirmation
  - `pendingAddSlice.ts` — in-progress feature being drawn but not yet committed
  - `pendingCompletionSlice.ts` — partially-completed sketches awaiting closure
  - `dimensionsSlice.ts` — persistent dimension annotations (`project.annotations`): add/update/delete + selection (history-tracked)
  - `dimensionToolSlice.ts` — transient measure tools: tape measure + in-progress permanent-dimension placement (not persisted, not in history)
  - `featureSlice.ts` — feature CRUD, tree/folder management, primitive constructors, arrange (align/distribute), and boolean ops (merge/cut/offset)
  - `featureGeometrySlice.ts` — feature sketch/profile geometry edits: moving controls, inserting/deleting/disconnecting points/segments, joining open endpoints, and corner fillets
  - `toolsSlice.ts` — tool CRUD: add/import/update/delete/duplicate tool definitions
  - `clampsSlice.ts` — clamp CRUD: add/update/delete/duplicate clamp, set visibility, move control point
  - `tabsSlice.ts` — tab CRUD: update/delete tab, set visibility, move control point, auto-place for operation
  - `backdropSlice.ts` — backdrop CRUD: load/set/update/delete backdrop image
  - `machineDefsSlice.ts` — machine definition CRUD: set selected, add/remove/refresh machine definitions
  - `operationsSlice.ts` — operation CRUD, rest-operation creation, toolpath visibility, duplication, and ordering
  - `projectLifecycleSlice.ts` — project lifecycle and persistence actions: create/load/open/save, metadata display settings, and export path markers
  - `importMergeSlice.ts` — shape import and `.camj` folder merge actions
  - `constraintsSlice.ts` — persistent fixed-distance constraint placement, value updates, cancellation, and deletion
  - `treeVisibilitySlice.ts` — feature-tree visibility toggles for all regions, folders, region folders, and folder selection
- `helpers/` — pure helpers used by the store
  - `clipping.ts` — clipper-lib wrappers (handles the integer scaling factor): profile↔Clipper-path conversion, boolean/offset execution, and overlap predicates. Arc/curve reconstruction of Clipper output lives in `engine/toolpaths/arcReconstruction.ts`.
  - `derivedFeatures.ts` — computes derived features from the feature tree
  - `geometry.ts` — geometric utilities (bounds, transforms)
  - `profileEdit.ts` — pure profile and segment-editing helpers used by sketch editing and pending composite drafts
  - `ids.ts` — ID generation/uniqueness
  - `normalize.ts` — normalizes incoming/legacy project data
  - `polygonSplit.ts` — splits polygons (e.g. for boolean ops)

## Tests
- `createRestOperation.test.ts` — rest-machining operation creation
- `openProfileJoin.test.ts` — open-profile joining behavior
- `profileEdit.test.ts` — profile and segment-editing helper behavior
- `polygonSplit.test.ts` — polygon splitting
- `projectStoreTransform.test.ts` — project transform actions
- `second_cut_test.ts` — multi-pass cutting behavior

## Gotchas
- The store owns history — call actions, do not bypass them.
- Clipper math is integer-scaled; helpers in `clipping.ts` handle the factor. Don't roll your own.
