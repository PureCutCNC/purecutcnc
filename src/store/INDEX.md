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
  - `historySlice.ts` — undo/redo and history transaction lifecycle
  - `workpieceSlice.ts` — stock, stock-source sketch editing, grid/units, origin placement, and creation target actions
  - `importMergeSlice.ts` — shape import and `.camj` folder merge actions
  - `constraintsSlice.ts` — persistent fixed-distance constraint placement, value updates, cancellation, and deletion
  - `treeVisibilitySlice.ts` — feature-tree visibility toggles for all regions, folders, region folders, and folder selection
- `helpers/` — pure helpers used by the store
  - `clipping.ts` — clipper-lib wrappers (handles the integer scaling factor): profile↔Clipper-path conversion, boolean/offset execution, and overlap predicates. Arc/curve reconstruction of Clipper output lives in `engine/toolpaths/arcReconstruction.ts`.
  - `derivedFeatures.ts` — computes derived snapshot features from the feature tree; also previewOffsetFeatures, joinOpenProfiles, and clearStaleConstraints
  - `featureDefinitions.ts` — definition creation, orphan collection, instance rebaking, and make-unique support for feature references
  - `geometry.ts` — geometric utilities (bounds, transforms)
  - `transform.ts` — point/profile/clamp/tab translation, rotation, mirroring, and affine transforms; arc→bezier conversion
  - `referenceTransforms.ts` — feature/backdrop resize, rotate, mirror from reference geometry; corner fillet radius and application
  - `modelAssets.ts` — imported model (STL) asset normalization, storage deduplication, and feature classification
  - `naming.ts` — unique-name generation for features, clamps, tabs, folders, and text features; text-feature creation
  - `operationDefaults.ts` — operation defaults: target validation, tool matching, kind labels, fallback targets, and default operation construction
  - `copyFeatures.ts` — build rotated, mirrored, and linear copies of features, clamps, and tabs; reference-vs-independent duplicate semantics with extractClonedDefinitions
  - `instanceTransforms.ts` — affine matrix builders and transform-delta composition for feature instances
  - `resolveFeatures.ts` — resolves definition and instance rows into world-space feature geometry for read paths
  - `profileEdit.ts` — pure profile and segment-editing helpers used by sketch editing and pending composite drafts
  - `ids.ts` — ID generation/uniqueness
  - `normalize.ts` — normalizes incoming/legacy project data; project cloning, deduplication, cache clearing, equality checks, and feature tree/sync helpers
  - `polygonSplit.ts` — splits polygons (e.g. for boolean ops)

## Tests
- `createRestOperation.test.ts` — rest-machining operation creation
- `openProfileJoin.test.ts` — open-profile joining behavior
- `profileEdit.test.ts` — profile and segment-editing helper behavior
- `polygonSplit.test.ts` — polygon splitting
- `projectStoreTransform.test.ts` — project transform actions
- `featureReferencesMigration.test.ts` — legacy project migration into definitions and instances
- `featureResolver.test.ts` — matrix resolution and definition lookup behavior
- `instanceTransforms.test.ts` — instance transform matrix composition
- `definitionEditing.test.ts` — shared-definition edit propagation and make-unique behavior
- `editInPlace.test.ts` — edit-sketch-in-place for transformed linked instances; inverse-transform round-trip; make-unique-then-edit
- `snapshotOps.test.ts` — definition/instance snapshot boolean and offset operations
- `creationDefinitions.test.ts` — definition minting across all creation paths (addFeature, imports, .camj merge); idempotency
- `duplicateReference.test.ts` — copyMode default/normalize, Duplicate as Reference / Duplicate Independent semantics, no-double-bake invariant, select-linked query
- `linkedConstraintResolve.test.ts` — linked constraint re-solve after definition edit propagates to sibling instances; direct-edit regression; no-drift idempotency
- `second_cut_test.ts` — multi-pass cutting behavior

## Gotchas
- The store owns history — call actions, do not bypass them.
- Clipper math is integer-scaled; helpers in `clipping.ts` handle the factor. Don't roll your own.
