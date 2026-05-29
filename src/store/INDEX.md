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
- `helpers/` — pure helpers used by the store
  - `clipping.ts` — clipper-lib wrappers (handles the integer scaling factor): profile↔Clipper-path conversion, boolean/offset execution, and overlap predicates. Arc/curve reconstruction of Clipper output lives in `engine/toolpaths/arcReconstruction.ts`.
  - `derivedFeatures.ts` — computes derived features from the feature tree
  - `geometry.ts` — geometric utilities (bounds, transforms)
  - `ids.ts` — ID generation/uniqueness
  - `normalize.ts` — normalizes incoming/legacy project data
  - `polygonSplit.ts` — splits polygons (e.g. for boolean ops)

## Tests
- `createRestOperation.test.ts` — rest-machining operation creation
- `openProfileJoin.test.ts` — open-profile joining behavior
- `polygonSplit.test.ts` — polygon splitting
- `projectStoreTransform.test.ts` — project transform actions
- `second_cut_test.ts` — multi-pass cutting behavior

## Gotchas
- The store owns history — call actions, do not bypass them.
- Clipper math is integer-scaled; helpers in `clipping.ts` handle the factor. Don't roll your own.
