# INDEX — src/store/

Zustand store. The single source of truth for the current `.camj` project. **All project mutations must go through actions on `projectStore` — never mutate state directly.**

## Files
- `projectStore.ts` — main store: project state, feature tree, undo/redo, persistence, tool/operation/stock actions. The big one.
- `types.ts` — store-internal types (state shape, action signatures)

## Subfolders
- `slices/` — focused slices of store behavior
  - `selectionSlice.ts` — which features/segments are currently selected
  - `pendingActionsSlice.ts` — queue of deferred ops awaiting user confirmation
  - `pendingAddSlice.ts` — in-progress feature being drawn but not yet committed, including multi-step gear placement
  - `pendingCompletionSlice.ts` — partially-completed sketches awaiting closure
  - `dimensionsSlice.ts` — persistent dimension annotations (`project.annotations`): add/update/delete + selection (history-tracked)
  - `dimensionToolSlice.ts` — transient measure tools: tape measure + in-progress permanent-dimension placement (not persisted, not in history)
  - `featureSlice.ts` — feature CRUD, tree/folder management, primitive constructors including gear+bore grouping, arrange (align/distribute), and boolean ops (merge/cut/offset)
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
  - `treeVisibilitySlice.ts` — feature-tree visibility toggles for all regions/construction, folders, region/construction folders, and folder selection
- `helpers/` — pure helpers used by the store
  - `clipping.ts` — clipper-lib wrappers (handles the integer scaling factor): profile↔Clipper-path conversion, boolean/offset execution, and overlap predicates. Arc/curve reconstruction of Clipper output lives in `engine/toolpaths/arcReconstruction.ts`.
  - `derivedFeatures.ts` — computes derived snapshot features from the feature tree; also previewOffsetFeatures, joinOpenProfiles, and clearStaleConstraints
  - `featureDefinitions.ts` — definition creation, orphan collection, instance rebaking, and make-unique support for feature references
  - `gearFeature.ts` — grouped gear+bore feature insertion helper used by the gear creation action
  - `featureRoles.ts` — single source of truth for feature roles (issue #199): isMachinable/isRegion/isConstruction/isSolid predicates, modelFeatures() CSG gate, and sectionForOperation tree sectioning. Use these instead of `operation !== 'region'` checks. `isSolid` (issue #270) returns true only for add/subtract/model — the base-solid invariant gate.
  - `geometry.ts` — geometric utilities (bounds, transforms)
  - `transform.ts` — point/profile/clamp/tab translation, rotation, mirroring, and affine transforms; arc→bezier conversion
  - `vcarveTargets.ts` — shared V-carve target eligibility predicate (issue #270 S2): `isVCarveCompatibleFeature` is the single source of truth for "can this feature be a V-carve machining target?"; used by UI hints, compatible selection, CAM panel validation, persisted target validation, and fallback target selection
  - `referenceTransforms.ts` — feature/backdrop resize, rotate, mirror from reference geometry; corner fillet radius and application
  - `modelAssets.ts` — imported model (STL) asset normalization, storage deduplication, and feature classification
  - `naming.ts` — unique-name generation for features, clamps, tabs, folders, and text features; text-feature creation
  - `operationDefaults.ts` — operation defaults: target validation, tool matching, kind labels, fallback targets, and default operation construction
  - `copyFeatures.ts` — build rotated, mirrored, and linear copies of features, clamps, and tabs; reference-vs-independent duplicate semantics with extractClonedDefinitions
  - `instanceTransforms.ts` — affine matrix builders and transform-delta composition for feature instances
  - `resolveFeatures.ts` — resolves definition and instance rows into world-space feature geometry for read paths
  - `profileEdit.ts` — pure profile and segment-editing helpers used by sketch editing and pending composite drafts
  - `buildShapeFeature.ts` — shared feature builder for the addRect/Circle/Ellipse/… constructors; consolidates duplicated shape-construction logic
  - `manualFeatureOperation.ts` — resolves existing world-space Add/Subtract instances and applies the shared strict-containment classifier to default a newly-created closed feature
  - `ids.ts` — ID generation/uniqueness
  - `normalize.ts` — normalizes incoming/legacy project data; project cloning, deduplication, cache clearing, equality checks, and feature tree/sync helpers
  - `polygonSplit.ts` — splits polygons (e.g. for boolean ops)

## Tests
- `constructionWorkflows.test.ts` — construction geometry (issue #199): creation target, conversions construction↔feature↔region, folder/section integrity, deferred constraints, save-version stamping, open-profile round trip
- `createRestOperation.test.ts` — rest-machining operation creation
- `creationDefinitions.test.ts` — definition minting across all creation paths (addFeature, imports, .camj merge); idempotency
- `definitionEditing.test.ts` — shared-definition edit propagation and make-unique behavior
- `duplicateReference.test.ts` — copyMode default/normalize, Duplicate as Reference / Duplicate Independent semantics, no-double-bake invariant, select-linked query
- `editInPlace.test.ts` — edit-sketch-in-place for transformed linked instances; inverse-transform round-trip; make-unique-then-edit
- `importRoles.test.ts` — importShapes with typed `classified` array: explicit roles honored in classifier order, fallback to legacy closed→add/open→line, definitions created, history recorded, layer grouping preserved; child-first source → parent-before-child, degenerate prefix, and cross-layer ordering regressions (issue #270 S3)
- `manualNestingDefaults.test.ts` — manual closed-feature defaults (issue #270 S5): Add/Subtract alternation, non-solid exclusion, explicit-operation precedence, no retroactive changes, and closed-composite completion
- `importBulk.test.ts` — synthetic bulk-import coverage (issue #270 S4): one 2,980-contour repeated-name stress case plus the 499/500 expanded-selection boundary, many-layer folder naming, definitions/order/history, and legacy small-import behavior
- `editOpFidelity.test.ts` — sketch-edit op segment-kind preservation + linked-instance propagation for insert/delete point, disconnect, and arc-handle edit (fills gaps editInPlace + H1 didn't cover)
- `featureLifecycle.test.ts` — create→definition, save/load round-trip, undo/redo, delete→GC per FeatureKind
- `featureLifecycleOps.test.ts` — stock/tabs/align-distribute lifecycle paths (no prior coverage): setStock, setStockSourceFeature, tab CRUD + auto-place + edit, alignFeatures/distributeFeatures + undo
- `gearCreation.test.ts` — gear creation store flow: radius placement, optional bore as a grouped subtract feature, validation, selection, and definitions
- `featureReferencesMigration.test.ts` — legacy project migration into definitions and instances
- `featureResolver.test.ts` — matrix resolution and definition lookup behavior
- `geometryFidelity.test.ts` — per-FeatureKind × transform-class resolveProfile fidelity, edit round-trip, duplicate-as-reference, per-kind store transforms
- `instanceTransforms.test.ts` — instance transform matrix composition
- `linkedConstraintResolve.test.ts` — linked constraint re-solve after definition edit propagates to sibling instances; direct-edit regression; no-drift idempotency
- `openProfileJoin.test.ts` — open-profile joining behavior
- `polygonSplit.test.ts` — polygon splitting
- `profileEdit.test.ts` — profile and segment-editing helper behavior
- `projectStoreTransform.test.ts` — project transform actions
- `second_cut_test.ts` — multi-pass cutting behavior
- `snapshotOps.test.ts` — definition/instance snapshot boolean and offset operations
- `textReference.test.ts` — issue #228: text-feature creation mints a definition, reference copies resolve (selectable), text edits propagate to definition + siblings, 16-char name truncation
- `updateFeatureOperationPropagation.test.ts` — P1b regression: operation change on a linked instance propagates to the definition + all siblings via updateFeature
- `vcarveTargets.test.ts` — `isVCarveCompatibleFeature` predicate: closed subtract/line valid, open/invalid operations rejected (issue #270 S2)

## Gotchas
- The store owns history — call actions, do not bypass them.
- Clipper math is integer-scaled; helpers in `clipping.ts` handle the factor. Don't roll your own.
