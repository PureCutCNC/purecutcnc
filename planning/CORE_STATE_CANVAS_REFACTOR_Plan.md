---
status: In progress   # Draft → Approved → In progress → Done | Abandoned
created: 2026-06-14
approved: 2026-06-14
---

# Core State / Canvas / App Architecture Simplification Plan

> Planning-only deliverable for the task in `work/core-state-canvas-refactor-agent-task-2026-06-11.md`
> (that file lives in the **main checkout**, not in the worktree). No source code is changed by this
> plan. It is built solely from that task brief; the baseline sizes below match the brief's own
> figures (`projectStore.ts` ~7k, `SketchCanvas.tsx` ~6k), confirmed by measurement.

## Goal

Reduce PureCutCNC's *structural* complexity — not raw line counts. Concretely: cut the number of
**unrelated reasons to edit the same hotspot file**, collapse repeated app/workflow mechanics into one
shared pattern, and make module ownership obvious. The user-visible behavior must not change at any
point, `.camj` compatibility is preserved, and every project mutation continues to go through
`projectStore` actions. The output is a sequence of independently reviewable/revertible phases that
separate implementation agents can pick up one at a time. Success is **durable**: each in-scope hotspot
ends small and cohesive with a clear owner, and a mechanical guard (see *Definition of done &
anti-regrowth guardrails*) keeps it that way — so "that file is too big, changing it is risky" stops
being a valid excuse for any file in scope.

## Phase status ledger

Management view for the `feat/core-arch-simplification` branch. Updated as each phase lands.

| Phase | Status | Branch / worktree | Notes |
|---|---|---|---|
| P0 — Stale-plan housekeeping | ✅ Done (`4b15583`) | this branch | 5 stale plans archived |
| P1 — Shared util hooks | ✅ Done (`3678ceb` + `d506c77`) | merged | `useLocalStorageState` + `useOutsideDismiss`; all 6 localStorage sites consolidated (incl. `updateCheck.ts` via the React-free cores); build + browser regression green |
| P2 — App orchestration | ✅ Done (`a1758d5`) | merged | P2a `useToolpathGeneration` (`3930c6d`), P2b `useSimulationModel` (`d9229be`), P2c `useTreeContextMenu`+`FeatureContextMenu` (`0b444ce`), P2d `useFeatureTreeActions` + `useSnapSettings`/`useZoomWindow`/`useEmptyStateEngagement` + `FeatureContextMenu` collapsed to one `actions` prop (`a1758d5`). **App.tsx 1457→506 lines.** `max-lines` guard active (530) on `src/App.tsx`+`src/app/**`. Build+lint green; browser-regressed each phase (toolpaths, sim tab, context-menu actions, snap/zoom/empty-state). **DoD note:** landed 506 vs the aspirational `< ~400`; the guard is ratcheted at the achieved count — reaching <400 would require splitting the `AppShell` composition JSX (deferred, optional). |
| P3 — Shared command model | ✅ Done (`be0d863`) | merged | `src/commands/{sketchCommands,creationShapes,fileCommands}.ts` — one source for every enable/disable/active/toggle rule; Toolbar 1982→1673, ToolRail 466→304, TopCommandBar 251→247 all re-pointed at `useSketchCommands`. Predicates verified identical to originals; unit-tested. **Dual-shell browser-regressed** (desktop toolbar Move active/label/banner; tablet ToolRail command set populates) — 0 console errors. Folded in: `DEFAULT_SNAP_SETTINGS` dedup (snapping.ts re-exports). Build+lint green. |
| P4 — Toolbar file-split | ✅ Done (`f114211`) | merged | Pure file-org split of `Toolbar.tsx` 1673→166 (barrel) into `src/components/layout/toolbar/*` (~12 action-group components + `useToolbarState` + `primitives`/`shared`/dialogs/popover + 3 shells). Zero behavior/JSX/CSS change; all 4 exports preserved (incl. dead `Toolbar`/`SnapToolbar` — kept per phase scope); `App.tsx` barrel import intact. Build+lint green (only the pre-existing `SketchCanvas.tsx:2202` warning). **Dual-shell browser-regressed** — desktop toolbar all action groups render; tablet shell + ToolRail unaffected; 0 console errors. |
| P5 — Store slice extraction | ✅ Done (R6 merge `b8c8804`) | merged | **Template slice:** `createFeatureSlice` extracted into `src/store/slices/featureSlice.ts` (1141 lines), deps-injection `(set, get, deps)`; `ProjectStore` interface in `types.ts` **frozen/unchanged**; `FeatureSlice = Pick<ProjectStore,…>` return type. **Round 1 (low-risk CRUD, 5 slices):** `toolsSlice`, `clampsSlice`, `tabsSlice`, `backdropSlice`, `machineDefsSlice` — 25 actions moved, one commit per slice; domain-only pure helpers moved *into* the slices (not injected/duplicated); each `Pick<ProjectStore,…>`-typed. `projectStore.ts` **7040→5095**. Build green (all 46 test files incl. store tests); lint clean (only pre-existing `SketchCanvas.tsx:2202` warning). Browser-regressed: `addTool`/`deleteTool` live, `autoPlaceTabsForOperation` (4 tabs) + clamps render, Badge parse — 0 console errors. **Round 2 (operations + import, 2 slices):** `operationsSlice` (addOperation, updateOperation, createRestOperation, setAllOperationToolpathVisibility, deleteOperation, duplicateOperation, reorderOperations) + `importMergeSlice` (importShapes, importCamjFolders); `importTools`/`mergeSelectedFeatures` correctly left in their owning slices. `projectStore.ts` **5095→4565**. Build green (all 46 test files incl. `createRestOperation.test`, `addOperationTool.test`); lint clean. Browser-regressed: `duplicateOperation`/`deleteOperation`/`setAllOperationToolpathVisibility` live with toolpath recompute — 0 console errors. **Round 3 (profileEdit.ts helper module, pulled earlier to unblock the geometry slice):** moved 25 pure profile/segment helpers (`cloneSegment` → `disconnectProfileAtAnchor`, arc primitives, draft resolvers + the helper-owned `ProfileBreakResult`) into `src/store/helpers/profileEdit.ts`; self-contained (imports only `./geometry` + types, no cycle back to projectStore); `pendingAddSlice` re-pointed to import them directly (5 injections dropped from its deps + the spread). New `profileEdit.test.ts` — 29 real assertions (insert/delete point, delete/disconnect segment, fillet, bezier split, 3-pt arc). `projectStore.ts` **4565→3866**. Build green (47 test files); lint clean. Browser smoke: sketch-edit mode arms all 5 point-edit tools, clean apply/cancel — 0 console errors. **Round 4 (highest-risk: geometry + constraints, 3 slices):** `featureGeometrySlice` (moveFeatureControl, insertFeaturePoint, joinOpenFeatureEndpoints, deleteFeaturePoint, deleteFeatureSegment, disconnectFeaturePoint, filletFeaturePoint), `constraintsSlice` (beginConstraint, setConstraintAnchor/Reference, commitConstraintDistance, cancelPendingConstraint, deleteConstraint, updateConstraintValue), `treeVisibilitySlice` (setAllRegionsVisible, toggleFolderVisible, toggleRegionFolderVisible, selectFolderFeatures). Pure modules imported directly (profileEdit, geometry, ids, constraintSolver); projectStore-resident helpers injected (cloneProject, projectsEqual, syncFeatureTreeProject, syncStockFromSourceFeature, translatePoint, translateProfile, transformProfile, joinOpenProfiles, inferFeatureKind, clearStaleConstraints, applyProfileBreak); no helper relocation. `projectStore.ts` **3866→2924**. Build green (47 test files incl. `openProfileJoin` + `projectStoreTransform`); lint clean. Runtime-verified sketch-edit mode (all 5 point-edit tools arm, geometry renders, 0 console errors); `moveFeatureControl` interactive drag not scriptable against the canvas hit-test — covered by byte-for-byte move + type-checked deps. **Round 5 (last action-extraction round — projectStore now has zero inline factory actions, 3 slices):** `projectLifecycleSlice` (createNewProject, setProjectName, setProjectClearances, setShowDimensions, setShowFeatureInfo, loadProject, saveProject, openProjectFromText, markSaved, markExported, markModelExported), `historySlice` (undo, redo, beginHistoryTransaction, commitHistoryTransaction, cancelHistoryTransaction), `workpieceSlice` (setCreationTarget, setStock, setStockSourceFeature, enterStockSketchEdit, setGrid, setUnits, setOrigin, startPlaceOrigin, placeOriginAt — `setCreationTarget` moved here to clear the last inline action). Correctness: `markSaved` uses injected `deps.rawSet({filePath,dirty:false})` (bypasses `withAutoDirty`); all other actions incl. undo/redo use the wrapped `set`; no slice imports `useProjectStore` (module-tail initial-project-repair stays in projectStore.ts); pure helpers imported directly (defaultStock/Origin/Grid, emptySelection, sanitizeSelection, convertProjectUnits, getStockBounds, rectProfile, stockFromFeature, nextPlacementSession), projectStore-resident injected (rawSet, cloneProject, projectsEqual, normalizeProject, instantiateProjectTemplate, clearProjectMemoryCaches, pruneUnusedModelAssets, syncFeatureTreeProject). `projectStore.ts` **2924→2326**. Build green (47 test files incl. `projectStoreTransform`, `createRestOperation`, `openProfileJoin`, `profileEdit`, `polygonSplit`, `addOperationTool`); `eslint src/store` clean; full lint only the pre-existing `SketchCanvas.tsx:2202` warning. Browser-regressed on the Badge example: `loadProject` (33 nodes/4 ops), `setUnits` (INCH↔MM with dirty+history), `undo`/`redo` round-trip, `setStock` (width 6→7, dirty+history), `createNewProject` (unsaved-changes guard → Blank Metric 100×80×20mm, Saved/dirty reset, history cleared) — 0 console errors. **Round 6 (final — helper homing + size guard, 9 commits):** relocated ~63 module-level helpers out of `projectStore.ts` into home modules, one cluster per commit: new `helpers/transform.ts` (translate/transform/mirror profile primitives, arc→bezier, translateClamp/Tab), `helpers/referenceTransforms.ts` (resize/rotate/mirror Feature+Backdrop FromReference, fillet*), `helpers/modelAssets.ts` (transformStl, modelAssetId, normalizeImportedModelStorage, pruneUnusedModelAssets, isImportedModelFeature), `helpers/naming.ts` (duplicate*Name, uniqueFolderName, textFolderBaseName, createTextFeatureAt), `helpers/operationDefaults.ts` (folderIdForOperation, toolMatchesTemplate, operationKindLabel, isOperationTargetValid, default*/fallback target), `helpers/copyFeatures.ts` (buildRotated/Mirrored/Copied Features/Clamps/Tabs); extended `helpers/normalize.ts` (dedupe/normalize Operation/Clamp/Tab/Machine, cloneProject, instantiateProjectTemplate, clearProjectMemoryCaches, projectsEqual, isFirstFeatureValid, syncFeatureTreeProject, syncStockFromSourceFeature) and `helpers/derivedFeatures.ts` (createDerivedFeature, previewOffsetFeatures, joinOpenProfiles, clearStaleConstraints). Slices re-pointed to import helpers directly (deps interfaces shrunk); external importers (SketchCanvas, store tests, commands) re-pointed; **`normalizeProject` deliberately stays in `projectStore.ts`** — it calls `normalizeBackdrop` (which lives in `backdropSlice.ts`), so homing it would force `normalize.ts → backdropSlice.ts → normalize.ts` (a helper→slice cycle); the composition root is allowed to import slices. No helper imports `projectStore`/any slice (verified). Final commit adds the `max-lines` eslint guard: `src/store/projectStore.ts` max 600, `src/store/**` max 1200 (current largest `featureSlice.ts` 1141 passes). `projectStore.ts` **2326→363** (composition root: imports + `normalizeProject` + `withAutoDirty` + factory + module-tail repair). Build green (47 test files incl. all load-bearing store tests); lint clean (both guards pass; only the pre-existing `SketchCanvas.tsx:2204` warning). Browser-regressed on the Badge example: `loadProject`→`normalizeProject` (33 nodes/5 ops after a duplicate, tabs+rest-regions+clamps), `duplicateOperation` (→ "Pocket Rough Copy" via operationDefaults/naming), 3D view full transform/geometry render (stock/clamps/toolpaths) — 0 console errors. **P5 store-slicing DoD met: `projectStore.ts` is a composition root < 600 lines, `ProjectStore` interface unchanged, guard in place.** Remaining refactor phases: **P6 (SketchCanvas hooks)**, **P7 (workflow-panel migration)** — not started. |
| P6 — SketchCanvas hooks | ✅ Done (guard round `a559e7f`; user-accepted 2026-06-17) | merged (Rounds 1–12 + guard) | **Approach:** shared refs/values (`canvasRef`, `drawRef`, `projectRef`, view transform, store actions) stay in the thin shell and are passed to each extracted hook via a single typed `ctx` object; each hook owns only its own machine's state/refs and returns what the shell JSX/keyboard/pointer handlers consume. Order set by risk; pointer-gesture core (pan/zoom/node-drag/marquee) last. **Round 1 (pattern-setter — `useDimensionEditWorkflow`):** extracted the feature sketch dimension-edit state machine into new `src/components/canvas/useDimensionEditWorkflow.ts` (254 lines): state `dimensionEdit`(+`dimensionEditRef` mirror via `useLayoutEffect`)/`armedForDimension`; refs `draggingDimensionIdRef`, `dimensionEditControlRef`, `dimensionEditFeatureIdRef`, `editDimStepsRef`, `editDimStepIndexRef`, `widthInputRef`/`heightInputRef`/`radiusInputRef`; handlers `computeEditStepsForControl`, `applyEditDimStep`, `advanceTabInEditMode`, `commitEditDimension`, `cancelEditDimension`, `handleEditDimLiveChange`. `ctx` = `{ projectRef, canvasRef, commitHistoryTransaction, cancelHistoryTransaction, moveFeatureControl }` — hook never reaches into the store independently. **Out of scope, left inline as-is:** `operationDimEdit` (scale/rotate/offset entry → future transform workflow) and `filletDimensionEdit` (→ future fillet workflow); creation-dimension flow (`triggerDimensionEdit`/`commit`/`cancelCreationDimensionEdit`) stays in the shell (creation machine) and calls the hook's returned members; the dimension-edit input-overlay JSX stays in the shell reading `dimEdit.*`. `SketchCanvas.tsx` **6167→6010** (−157). Build green (47 test files); lint clean (only the pre-existing `SketchCanvas.tsx:2198` warning). Browser-regressed desktop + tablet on Badge: dimension tool arms (`armedForDimension` → "Click points to anchor the dimension" overlay) in both shells, double-click sketch-edit (`handleDoubleClick` → extracted machine) works, 0 console errors. **Round 2 (`useConstraintWorkflow`):** extracted the constraint value-edit + pending-distance machinery into new `src/components/canvas/useConstraintWorkflow.ts` (200 lines): state `constraintEdit`(+`constraintEditRef` mirror via `useLayoutEffect`)/`constraintDistanceInput`; refs `constraintEditInputRef`, `constraintDistanceInputRef`; derived `constraintDistanceReady`; the `constraintWorkflowPanel = useCanvasWorkflowPanel(...)` call; handlers `commitConstraintFromPanel`→`ctx.commitConstraintDistance`, `cancelConstraintFromPanel`→`ctx.cancelPendingConstraint`, inline-edit `commitConstraintEdit`(Enter→`updateConstraintValue`)/`cancelConstraintEdit`, `handleConstraintKeyDown` (returns true when a constraint is active), focus effects. `ctx` (`ConstraintWorkflowCtx`) = `{ projectRef, canvasRef, containerRef, pendingConstraint, pendingConstraintRef, clearTransientCanvasState, commitConstraintDistance, cancelPendingConstraint, updateConstraintValue }` — hook never reaches into the store independently. **Out of scope, left in shell as specified:** `pendingConstraint` store state + `pendingConstraintRef`; all constraint *picking* (anchor/reference selection in pointer/keyboard handlers, `beginConstraint`/`setConstraintAnchor`/`setConstraintReference`); `beginConstraint` `c`-key shortcut; `constraintLabelRectsRef` (draw-write / click hit-test read); all constraint *rendering* in the draw fn; both JSX overlays (inline-edit input + workflow panel) now reading `constraint.*`. `SketchCanvas.tsx` **6010→5948** (−62). Build green (47 test files); lint clean (only the pre-existing `SketchCanvas.tsx:2163` warning). Browser-regressed desktop + tablet on Badge: enter feature sketch-edit → arm constraint (`c`) → "Pick anchor point / Tap a snap point on this feature." pick-hint overlay renders in both shells, Escape cancels cleanly (desktop), 0 console errors. **Round 3 (`useFilletWorkflow`):** extracted the sketch-fillet dimension-edit overlay machine into new `src/components/canvas/useFilletWorkflow.ts` (119 lines): state `filletDimensionEdit`(+`filletDimensionEditRef` mirror via `useLayoutEffect`); ref `filletRadiusInputRef`; derived `filletDimensionEditActive`; the focus effect (auto-focus + select the radius input when the overlay activates); consolidated handler `commitFilletDimension` (merges the two formerly-inline typed-radius commits — keyboard Enter + JSX overlay Enter: parse via `parseLengthInput`, if selected feature id + radius `>0` → `filletFeaturePoint`, then the shared clear-tail `pendingSketchFilletRef=null; sketchEditPreviewRef=null; setFilletDimensionEdit(null); scheduleDraw()`) and `cancelFilletDimension` (the clear-tail without commit — keyboard Escape + overlay cancel). `ctx` (`FilletWorkflowCtx`) = `{ projectRef, selectionRef, pendingSketchFilletRef, sketchEditPreviewRef, filletFeaturePoint, scheduleDraw }` — note `selectionRef` is a `useLayoutEffect` mirror of the reactive `selection` so the consolidated handlers read a live `selectedFeatureId`; hook never reaches into the store independently. **Out of scope, left in shell as specified:** `pendingSketchFilletRef` (picking state); the entire pointer/draw fillet-tool branch (corner-pick entry + the click-commit with `filletRadiusFromPoint` `pickedPoint` fallback — distinct semantics from the typed-radius commit, part of picking); the overlay-seeding entry (`setFilletDimensionEdit({...})` after corner pick); ALL fillet *rendering* in the draw fn (`drawPendingPoint`/`drawMoveGuide`/`filletFeatureFromRadius`/`filletFeatureFromPoint`); the keyboard Enter/Escape fillet branches (gate on shell-owned `pendingSketchFilletRef`, delegate their body to the hook's commit/cancel); the JSX radius-input overlay (reads `fillet.*`); the mode/tool-change cleanup effect. `SketchCanvas.tsx` **5948→5920** (−28). Build green (47 test files); lint clean (only the pre-existing `SketchCanvas.tsx:2159` warning). Browser-regressed desktop + tablet on Badge: enter feature sketch-edit → arm the fillet tool (hint "Drag nodes or click segments" → "Click a corner") in both shells, desktop cancel returns the hint to default, 0 console errors. (Radius-input overlay renders only after a canvas corner-pick — same unscriptable hit-test ceiling as R2's anchor pick; wiring covered by tsc + the arm-level evidence.) **Round 4 (`useMoveWorkflow` — first of the transform-family split):** the original "useTransformWorkflow" turned out to be THREE sub-workflows (move/copy, scale/rotate, offset) all sharing the `operationDimEdit` distance/factor/angle state, so by decision it is split into 3 sub-rounds; `operationDimEdit`(+`setOperationDimEdit`/`operationDimEditRef`) and `copyCountDraft`(+ref+`copyCountInputRef`) stay SHELL-OWNED shared infrastructure passed via `ctx` (R5/R6 need them). Extracted the move/copy distance-entry into new `src/components/canvas/useMoveWorkflow.ts` (201 lines): the `moveWorkflowPanel = useCanvasWorkflowPanel({...})` call; derived flags `moveDistanceEditActive`/`copyCountPromptActive`; handlers `cancelMoveFromPanel`, `beginMoveDistanceEntry`, `beginMoveDistanceEntryFromPreview`, `commitMoveDistanceEditFromPanel`; the copy-count focus effect (rAF-focuses `copyCountInputRef` when `copyCountPromptActive`); the move/copy preview `useEffect` (computes the preview point from the typed distance → `setPendingMovePreviewPointRef`). `ctx` (`MoveWorkflowCtx`) = `{ projectRef, operationDimEdit/setOperationDimEdit/operationDimEditRef (shared), setCopyCountDraft/copyCountInputRef (shared), pendingMove/pendingMoveRef/pendingMovePreviewPointRef/setPendingMovePreviewPointRef, cancelPendingMove/setPendingMoveTo/completePendingMove, containerRef/canvasRef/clearTransientCanvasState }`. Hook owns no mirrored state of its own (all refs arrive via ctx), so no `useLayoutEffect` this round. **Stayed in shell:** the shared `operationDimEdit`/`copyCountDraft` infra; `pendingMove`/`pendingMoveRef` (set by pointer handlers, read by draw); `pendingMovePreviewPointRef` (pointer-drag); the pointer-drag move logic (~2549–2563, ~2975–2998 reading `operationDimEditRef`+`pendingMoveRef`); the move draw rendering (~1517–1590); the move JSX `<CanvasWorkflowPanel>` (re-pointed to `move.*`); the `operationDimEdit` auto-focus effect (handles all kinds). Scale/rotate (`pendingTransform`) + offset (`pendingOffset`) sub-workflows + their panels UNTOUCHED. `SketchCanvas.tsx` **5920→5835** (−85). Build green (47 test files); lint clean (only the pre-existing `SketchCanvas.tsx:2074` warning). Browser-regressed desktop + tablet on Badge: select a feature → arm Move (panel "Select from point") in both shells, arm Copy (desktop, panel "Select from point"), desktop cancel clears the panel, 0 console errors. (Distance/copy-count entry renders only after canvas from/to picks — same unscriptable hit-test ceiling; wiring covered by tsc + the arm-level evidence.) **Round 5 (`useTransformExactWorkflow` — second transform sub-round, scale/rotate):** extracted into new `src/components/canvas/useTransformExactWorkflow.ts` (255 lines): the `transformWorkflowPanel = useCanvasWorkflowPanel({...})` call; derived flags `transformScaleEditActive`/`transformRotateEditActive`/`transformExactEditActive`/`rotateCopyCountPromptActive`; the rotate-copy overlay state `rotateCopyCountDraft`/`setRotateCopyCountDraft` + `pendingRotateCopyPoint`/`setPendingRotateCopyPoint` + `rotateCopyCountInputRef` (rotate-copy-specific, distinct from move's separate `copyCountDraft`); handlers `cancelTransformFromPanel`, `triggerDimensionFromTransformPanel`, `commitTransformExactEditFromPanel`, and a new consolidated `commitRotateCopyFromPanel` (merges the rotate-copy count commit inlined at two JSX sites); the rotate-copy focus effect; the scale/rotate preview `useEffect` (reads `operationDimEdit` kind scale/rotate + `pendingTransformRef`, writes `setPendingTransformPreviewPointRef`). `ctx` (`TransformExactWorkflowCtx`) = `{ operationDimEdit/setOperationDimEdit/operationDimEditRef (shared), pendingTransform/pendingTransformRef/pendingTransformPreviewPointRef/setPendingTransformPreviewPointRef (picking), cancelPendingTransform/completePendingTransform, triggerDimensionEdit, containerRef/canvasRef/clearTransientCanvasState }`. **Stayed in shell:** shared `operationDimEdit` infra; `pendingTransform`(+ref +preview ref) picking (135 refs); the pointer-drag transform logic incl. the rotate-copy anchor site (`setPendingRotateCopyPoint(constrainedPoint)` ~3607) + the keyboard Escape cleanup (~4346–47), both re-pointed to `transformExact.set*`; all scale/rotate draw rendering; the transform JSX `<CanvasWorkflowPanel>` (re-pointed to `transformExact.*`); `triggerDimensionEdit`. Move + offset sub-workflows UNTOUCHED. `SketchCanvas.tsx` **5835→5699** (−136). Build green (47 test files); lint clean (only the pre-existing `SketchCanvas.tsx:1950` warning). Browser-regressed desktop + tablet on Badge: select feature → arm Rotate (panel "Select origin") in both shells, arm Resize (desktop, panel "Select first reference"), desktop rotate-cancel clears the panel, 0 console errors. (Exact scale/angle + rotate-copy-count entry render only after canvas reference picks — same unscriptable hit-test ceiling; covered by tsc + arm-level evidence.) **Round 6 (`useOffsetWorkflow` — third/last transform sub-round):** extracted into new `src/components/canvas/useOffsetWorkflow.ts` (113 lines, the smallest sub-round): the `offsetWorkflowPanel = useCanvasWorkflowPanel({...})` call; derived flag `offsetDistanceEditActive` (= `!!pendingOffset && operationDimEdit?.kind === 'offset'`); handlers `cancelOffsetFromPanel`, `triggerDimensionFromOffsetPanel`, `commitOffsetDistanceEditFromPanel` (parses typed distance → `completePendingOffset`). `ctx` (`OffsetWorkflowCtx`) = `{ projectRef, operationDimEdit/setOperationDimEdit/operationDimEditRef (shared), pendingOffset, setPendingOffsetPreviewPointRef/setPendingOffsetRawPreviewPointRef, cancelPendingOffset/completePendingOffset, triggerDimensionEdit, containerRef/canvasRef/clearTransientCanvasState }`. Hook owns no state of its own → no useLayoutEffect. **Stayed in shell:** shared `operationDimEdit` infra; ALL `pendingOffset` picking/preview state (`pendingOffsetRef` + `pendingOffsetPreviewPointRef` + `pendingOffsetRawPreviewPointRef` + setters); the combined guard `useEffect` incl. `if (!pendingOffset) setOperationDimEdit(null)`; the session-reset effect; the pointer live-preview writing the offset preview refs (~2366–2368); the mousedown `if (pendingOffset) return` guard; all offset draw rendering (~1734–1766); the offset JSX `<CanvasWorkflowPanel>` (re-pointed to `offset.*`); `triggerDimensionEdit`. Move + scale/rotate sub-workflows UNTOUCHED. `SketchCanvas.tsx` **5699→5684** (−15). Build green (47 test files); lint clean (only the pre-existing `SketchCanvas.tsx:1935` warning). Browser-regressed desktop + tablet on Badge: select feature → arm Offset (panel "Preview distance" + the Distance/Cancel actions) in both shells, desktop cancel clears the panel, 0 console errors. (Typed distance entry renders only after a canvas preview-pick — same unscriptable hit-test ceiling; covered by tsc + arm-level evidence.) **TRANSFORM FAMILY COMPLETE (move ✓ scale/rotate ✓ offset ✓).** **Round 7 (`useCreationWorkflow` — feature-creation panels + handlers):** the original "placement" machine (`pendingAdd`, ~199 sites) reduces to ONE clean panel+handlers round because the shared `triggerDimensionEdit` stays shell-owned and the rest of `pendingAdd` (per-shape pointer point-adding + per-shape draw rendering + keyboard Tab) is inherently pointer/draw that folds into the keyboard + pointer-core rounds. Extracted into new `src/components/canvas/useCreationWorkflow.ts` (249 lines): the `creationWorkflowPanel` + `placementWorkflowPanel` `useCanvasWorkflowPanel` calls; the derived flags `creationPanelShape`/`creationPanelHasAnchor`/`creationPanelHasPoints`/`creationPanelHasStart`/`creationCanDimEdit`/`creationDimEditActive`/`placementPanelActive`; 8 panel handlers `triggerDimensionFromCreationPanel`, `commitCreationDimensionEdit`, `cancelCreationDimensionEdit`, `cancelCreationFromPanel`, `undoFromCreationPanel`, `finishOpenPathFromPanel`, `finishOpenCompositeFromPanel`, `setCompositeModeFromPanel`. `ctx` (`CreationWorkflowCtx`, 20 fields — widest yet) = `{ projectRef, pendingAdd/pendingAddRef, dimensionEdit/dimensionEditRef/setDimensionEdit (R1 hook), triggerDimensionEdit (shared), setPendingPreviewPointRef, store actions placePendingAddAt/cancelPendingAdd/addPendingPolygonPoint/addPendingCompositePoint/undoPendingPolygonPoint/undoPendingCompositeStep/completePendingOpenPath/completePendingOpenComposite/setPendingCompositeMode, containerRef/canvasRef/clearTransientCanvasState }`. **Stayed in shell:** `pendingAdd`(+ref) + `pendingPreviewPointRef`(+`setPendingPreviewPointRef`) + `originPreviewPointRef` picking/preview; the shared `triggerDimensionEdit` def; per-shape pointer placement (`placePendingAddAt` etc. in `handlePointerDown`); ALL per-shape creation draw rendering; the keyboard Tab creation-dimension logic; the sketch-EDIT panel + its handlers (`editWorkflowPanel`, `applyEditFromPanel`, `commitEditDimensionFromPanel`, …) — a DIFFERENT machine; `creationTarget`, `pendingDraftHasSelfIntersection`, `pendingDraftExceedsStock`. `SketchCanvas.tsx` **5684→5577** (−107). Build green (47 test files); lint clean (only the pre-existing `SketchCanvas.tsx:1828` warning). Browser-regressed desktop + tablet on a fresh project: arm "Add feature rectangle" → creation panel renders ("Click first corner") in both shells, desktop Cancel clears the panel + restores the tool button, 0 console errors. (The adding/drawing phases + undo/finish/composite-mode handlers need canvas point-picks — unscriptable hit-test ceiling; covered by tsc + arm-level evidence.) **Round 8 (`useCanvasKeyboard` — the keyboard dispatcher):** moved the canvas-level `handleKeyDown` (~510 lines) near-verbatim into new `src/components/canvas/useCanvasKeyboard.ts` (707 lines), returning `{ handleKeyDown }`; shell binds `onKeyDown={keyboard.handleKeyDown}`. Behavior-preserving single-function move — the handler is ref-based throughout, so the wide `ctx` (`CanvasKeyboardCtx`, ~54 fields: 23 refs incl. `projectRef`/`selectionRef`/`pendingAddRef`/`pendingMoveRef`/`pendingTransformRef`/`pendingOffsetRef`/`pendingSketchFilletRef`/`activeSnapRef`/`sketchEditPreviewRef`/etc.; the 5 already-extracted hook instances it delegates to — `dimEdit`/`constraint`/`move`/`transformExact`/`fillet`; ~21 store actions; ~10 shell helpers incl. `stopNodeDrag`/`resetLock`/`triggerDimensionEdit`/the preview-ref setters/`copyCountDraft`+`setCopyCountDraft`/`creationTarget`) is just plumbing. **Did NOT move** the input-level `onKeyDown` handlers (`makeEditInputKeyDown` + the ~22 inline JSX `<input>` handlers) — those stay in the shell. `SketchCanvas.tsx` **5577→5134** (−443). Build green (47 test files); lint clean (the pre-existing unused-directive warning stays at line 1828 — it sits *before* the removed handler so its line didn't shift). Browser-regressed desktop + tablet: enter feature sketch-edit → press `c` → constraint arms ("Pick anchor point" overlay) via the moved handler, desktop Escape cancels it — both shells, 0 console errors. **Round 9 (`useSnapPreview` — first of the 4 leaves-first pointer-cluster rounds; FOUNDATION):** extracted the snap-preview machine into new `src/components/canvas/useSnapPreview.ts` (162 lines): owns `activeSnapRef`; returns `updateActiveSnap` (the `useStableEvent` that writes `activeSnapRef` + fires `onActiveSnapModeChange` + `scheduleDraw`), `resolveCurrentSketchSnap(rawPoint, vt, options?)`, `isActiveSnapPoint(point)` (18 draw read-sites re-pointed), and `requiresResolvedSnapForPointPick()`; keeps `currentSnapReferencePoint()` INTERNAL (only caller is `resolveCurrentSketchSnap`). Hook imports `resolveSketchSnap`/`ResolvedSnap` + `pointsEqual` + `useStableEvent` directly. `ctx` (`SnapPreviewCtx`) = `{ snapSettingsRef, projectRef, selectionRef, pendingMoveRef, pendingTransformRef, pendingAddRef, pendingConstraintRef (read by the reference-point helper), scheduleDraw, onActiveSnapModeChange }`. Owns no mirrored state → no `useLayoutEffect`. **Purely additive at call sites — a foundation round:** every consumer stays in the shell and just calls `snap.*` (the `draw` renderer's `drawSnapIndicator(ctx, snap.activeSnapRef.current, vt)` + the 18 `snap.isActiveSnapPoint` sites; the pointer/click handlers' `snap.resolveCurrentSketchSnap`/`snap.requiresResolvedSnapForPointPick`; the lock-mode write `snap.activeSnapRef.current = {...}`; the `useCanvasKeyboard` ctx field `activeSnapRef: snap.activeSnapRef`). No pointer/click/menu/draw bodies moved this round. Shell removed 3 now-dead imports (`resolveSketchSnap`, `ResolvedSnap`, `pointsEqual`); hook wired once (~line 557). `SketchCanvas.tsx` **5134→5060** (−74). Build green (47 test files); lint clean (the pre-existing unused-directive warning shifted 1828→**1754** — code was removed above it; 0 new warnings). Browser-regressed desktop + tablet on Badge: snap-mode toolbar toggles dispatch (flow through `snapSettingsRef` into the hook), feature sketch-edit entered, 6 synthetic canvas pointermoves drove `resolveCurrentSketchSnap`/`updateActiveSnap`/`drawSnapIndicator` end-to-end, tablet shell confirmed (`statusbar-shell-mode` = "tablet"), 0 console errors in both shells. (Snap-indicator pixel render needs a real hover over snappable geometry — same unscriptable hit-test ceiling; wiring covered by tsc + the toggle/pointermove evidence.) **Round 10 (`useCanvasContextMenu` — long-press + context menu; second leaves-first round):** extracted the canvas context-menu / touch-long-press machine into new `src/components/canvas/useCanvasContextMenu.ts` (194 lines): owns `longPressTimerRef` + `longPressStartRef`; moved `triggerContextMenuAt(clientX, clientY)` (OUTBOUND-only — hit-tests via `findHitClampId`/`findHitTabId`/`findHitFeatureId` then calls the parent props `onClampContextMenu`/`onTabContextMenu`/`onFeatureContextMenu`; no local menu state) and `handleContextMenu(event)` VERBATIM. Returns `startLongPress(event)` (folds the handlePointerDown clear+arm block — clears any pending timer, then on `touch`+`button 0` sets `longPressStartRef` from the event/canvas rect and arms the 500ms `setTimeout` → `triggerContextMenuAt` + `suppressClickRef.current = true` + `stopPan()` + null, EXACTLY as before), `cancelLongPress()` (the clear+null tail — replaced 3 identical inline blocks), `handleLongPressMove(event)` (the >10px move-threshold cancel lifted from the top of `onCanvasPointerMove`), plus `handleContextMenu`/`triggerContextMenuAt`. **All six returned fns are PLAIN (not memoized)** — mirrors the shell's prior closure semantics over the reactive `zoomWindowActive` prop exactly; only the two refs are stable. Hit-test + view helpers (`findHit*`/`computeViewTransform`/`canvasToWorld`) imported DIRECTLY by the hook. `ctx` (`CanvasContextMenuCtx`) = `{ canvasRef, projectRef, selectionRef, viewStateRef, pendingAddRef, pendingMoveRef, pendingTransformRef, pendingOffsetRef, didPanRef, suppressClickRef, zoomWindowActive, stopPan, selectClamp, selectTab, selectFeature, onFeatureContextMenu, onTabContextMenu, onClampContextMenu }` — hook never reaches into the store independently. **Stayed shell-owned (gesture-side, for R12):** `suppressClickRef`/`didPanRef`/`stopPan` (passed via ctx, not moved); all pan/zoom/marquee/node-drag; `setPointerCapture` (untouched). Shell now calls `contextMenu.startLongPress`(×1)/`handleLongPressMove`(×1)/`cancelLongPress`(×3)/`handleContextMenu`(JSX binding); hook wired once. `SketchCanvas.tsx` **5060→4989** (−71). Build green (47 test files all passed); lint clean (the pre-existing unused-directive warning shifted 1754→**1774** — the ~20-line hook wiring was added above it while removals were below; 0 new warnings). Browser-regressed desktop + tablet on Badge: `handleContextMenu` confirmed wired in both shells (synthetic `contextmenu` → `event.defaultPrevented === true`, i.e. the `onContextMenu={contextMenu.handleContextMenu}` → `triggerContextMenuAt` path runs); touch `pointerdown` arms the long-press timer with 0 JS errors (verified in a clean run with `setPointerCapture` stubbed to neutralize the synthetic-pointer artifact). The full menu-open requires a real feature hit (unscriptable hit-test ceiling — a synthetic grid of right-clicks/long-presses landed on no feature); the only console error observed (`setPointerCapture: No active pointer with the given id`) is a synthetic-`PointerEvent` artifact on an UNCHANGED line, not a regression. **Round 11 (`useClickPlacement` — the click pick/place dispatcher; third leaves-first round, largest single move):** moved `handleClick` (~498 lines — the click router dispatching every `pending*` pick/place branch: dimension pick, constraint anchor/reference pick, move from/to pick, transform reference picks, offset preview pick, add-shape placement, sketch-edit segment/endpoint/fillet picks, tape-measure, annotation/feature/tab/clamp/backdrop selection) near-VERBATIM into new `src/components/canvas/useClickPlacement.ts` (789 lines), returning `{ handleClick }`; shell binds `onClick={clickPlacement.handleClick}`. Same R8-style ref-based single-function move — verified byte-faithful by token fingerprint (`if` 79=79, `else` 12=12, `.current` 50=50 between old body and new; the only deltas are the hook's own `return { handleClick }` and ctx type-decls/destructuring). `handleClick` kept a PLAIN function. `ctx` (`ClickPlacementCtx`, widest yet) plumbing: ~23 shell-owned refs incl. the picking refs (`pendingAddRef`/`pendingMoveRef`/`pendingTransformRef`/`pendingOffsetRef`/`pendingShapeActionRef`/`pendingConstraintRef`/`pendingDimensionRef`/`pendingSketchExtensionRef`/`pendingSketchFilletRef`/`sketchEditPreviewRef`/`originPreviewPointRef`) + the GESTURE refs `didPanRef`/`suppressClickRef`/`isDraggingNodeRef` (stay shell-owned for R12, passed not moved) + `projectRef`/`selectionRef`/`viewStateRef`/`canvasRef`/`tapeMeasureRef`/`selectedAnnotationIdRef`/`dimensionDeleteArmedRef`/`deleteHoverDimIdRef`/`constraintLabelRectsRef`; the 6 already-extracted hook instances it delegates to (`snap`/`dimEdit`/`move`/`transformExact`/`fillet`/`constraint` — e.g. `snap.resolveCurrentSketchSnap`, `dimEdit.applyEditDimStep`, `move.beginMoveDistanceEntry`, `transformExact.setPendingRotateCopyPoint`, `fillet.filletDimensionEditRef`, `constraint.setConstraintEdit`); ~30 store actions; shell closures `scheduleDraw`/`applyLock` + the preview-ref setters; and **6 SHELL-LOCAL helper functions passed via ctx as references** (`hitEditableControl`, `editableFeature`, `endpointFromSketchExtension`, `findSketchSegmentHit`, `findOpenEndpointHit`, `triggerDimensionEdit` — they are shared across the shell so they STAY there, confirmed still 1 each / 0 duplicated in the hook). Module-level geometry/hit-test/format helpers (`findHitFeatureId`/`findHitTabId`/`findHitClampId`/`hitBackdrop`/`addDimensionAnnotation`/`pickDimensionAt`/`tapeMeasureClick`/`offsetForCursor`/`isLoopCloseCandidate`/`resolveOffsetPreview`/`filletRadiusFromPoint`/`projectPointOntoLine`/`findSketchInsertTarget`/`findOpenProfileExtensionEndpoint`/`formatLength`/`parseLengthInput`, etc.) imported DIRECTLY by the hook; 5 imports now only used in the hook removed from the shell. Hook never reaches into the store independently. `SketchCanvas.tsx` **4989→4569** (−420). Build green (47 test files all passed); lint clean (the pre-existing unused-directive warning shifted 1774→**1773**; 0 new). Browser-regressed desktop + tablet on Badge: a canvas mouse-click routed through `clickPlacement.handleClick` → hit-test → `selectFeature` selected a feature (properties panel populated) on desktop, 0 console errors; tablet shell confirmed (`statusbar-shell-mode` = "tablet"), canvas taps dispatch through the handler with 0 errors (tap-to-select didn't land in a synthetic grid — same unscriptable hit-test ceiling; the `onClick` binding is identical JSX for both shells and demonstrably routed on desktop, so wiring is sound). **Round 12 (`usePointerGestures` — the pan/zoom/node-drag/marquee CORE; final + riskiest leaves-first round):** moved the 9 interleaved gesture handlers + the native-listener plumbing near-VERBATIM into new `src/components/canvas/usePointerGestures.ts` (1116 lines): `handlePointerDown`, `handleCanvasPointerMove`, `handlePointerUp`, `handlePointerLeave`, `handleWheelEvent`, `handleDoubleClick`, `canvasCoordinates`, plus the `onCanvasPointerMove`/`onCanvasWheel` `useStableEvent` wrappers and their `useEventListener(canvasRef, 'pointermove'|'wheel', …)` registrations (the hook owns its own native listeners now). Consumes R9 `snap` (16 calls) + R10 `contextMenu` (5 calls) via ctx — clean directional deps, no `clickPlacement` use. **Design (user-approved 2026-06-17):** the **11 gesture refs STAY shell-owned** (`isDraggingNodeRef`/`dragStartWorldRef`/`touchDragPendingRef`/`isPanningRef`/`didPanRef`/`lastPanPointRef`/`marqueeStartRef`/`marqueeCurrentRef`/`zoomWindowStartRef`/`zoomWindowCurrentRef`/`suppressClickRef` — already shared with useClickPlacement/useCanvasContextMenu + reset by `clearTransientCanvasState`) and pass via ctx; the hook owns the HANDLERS only. `runLivePointerPreview` + its effect (reactive, not gesture-driven) and the `useCanvasGestures` multi-touch wiring stay in the shell (`isGestureActiveRef` → ctx). Wide `ctx` (`PointerGesturesCtx`): the 11 gesture refs + the picking/shared refs + `snap`/`contextMenu` instances + `isGestureActiveRef` + the 7 shell-local helpers it shares with useClickPlacement (`hitEditableControl`/`editableFeature`/`endpointFromSketchExtension`/`findSketchSegmentHit`/`findOpenEndpointHit`/`openEndpointAnchor`/`triggerDimensionEdit`) + store actions (`setViewState`/`moveFeatureControl`/`begin`+`commitHistoryTransaction`/`completePendingOpenPath`/…) + shell closures (`scheduleDraw`/`applyLock` + the preview-ref setters). **`stopPan`/`stopNodeDrag` deliberately kept as hoisted function declarations in the shell** (not moved) to break a real cycle — `useCanvasContextMenu` (R10) needs `stopPan` in its ctx but `usePointerGestures` needs the `contextMenu` instance; keeping them shell-side is consistent with "gesture refs stay shell-owned" (they only reset shell-owned refs). They're passed via ctx to the hook and **re-exported** from the hook return; the non-gesture callers (`clearTransientCanvasState`, `applyEditFromPanel`, `cancelEditFromPanel`) re-point to `gestures.stopPan()`/`gestures.stopNodeDrag()`. Hook returns `handlePointerDown`/`handlePointerUp`/`handlePointerLeave`/`handleDoubleClick` (JSX), `stopPan`/`stopNodeDrag` (external callers), `canvasCoordinates` (imperative handle — re-pointed `canvasCoordinates: gestures.canvasCoordinates`, **handle shape unchanged**). **One accepted deviation:** the hook needed **4 `// eslint-disable-next-line react-hooks/immutability`** directives on the verbatim ref mutations through ctx instances (`snap.activeSnapRef.current = …` lock-mode write ×1; `dimEdit.draggingDimensionIdRef.current = …` ×3) — the rule fires only in the hook context (mutating a ref reached through the ctx-passed hook instance) and NOT in the prior shell; verified NECESSARY (stripping them → 4 `react-hooks/immutability` errors) and behavior-neutral (comments). Verbatim-ness verified: `handleCanvasPointerMove` body byte-identical old-vs-new (361=361 lines, diff-clean); 7 functions fully gone from the shell; agent per-function token fingerprint matched. `SketchCanvas.tsx` **4569→3809** (−760 — the single biggest round). Build green (47 test files all passed); lint clean (0 errors — the 4 immutability directives do their job; only the pre-existing unused-directive warning, now ~line 1776). Browser-regressed desktop + tablet on Badge — **the gesture core works end-to-end, not just wired:** desktop wheel-zoom changes the canvas view and 5-in/5-out returns to the EXACT original pixel hash (symmetric zoom math), middle-button drag pans the view, snap toggles, creation tool arms, 0 console errors; tablet shell confirmed (`statusbar-shell-mode` = "tablet"), wheel-zoom changes the view, single-finger touch-drag dispatches through the handlers cleanly, snap controls present, 0 errors. **ALL P6 INTERACTION MACHINES NOW EXTRACTED.** **Guard round (final P6 step — applied inline by the mgmt session, config-only):** added the `src/components/canvas/**` `max-lines` ESLint guard to `eslint.config.js`, mirroring the existing `src/store/**` two-block pattern: a `src/components/canvas/**/*.{ts,tsx}` block at **max 1200** (bounds each extracted hook — largest is `usePointerGestures.ts` at 987 effective lines, skipBlank+skipComments) and a `src/components/canvas/SketchCanvas.tsx` block at **max 3800** listed AFTER it (so it wins for the shell file — shell is 3526 effective). Thresholds are the user-approved "headroom" choice (2026-06-17): the shell limit reflects the achieved post-extraction landing (~3,800 raw / 3,526 effective), NOT the aspirational <600 — the shell legitimately retains the `draw` renderer (~787L) + the JSX return (~1,216L) + the imperative handle + refs/effects wiring, none of which are interaction machines. Build green (47 test files); lint clean (0 errors — both new guards pass; only the pre-existing unused-directive warning at ~line 1776). **P6 DoD met: every interaction state machine lives in its own `src/components/canvas/use*.ts` hook (R1 useDimensionEditWorkflow, R2 useConstraintWorkflow, R3 useFilletWorkflow, R4 useMoveWorkflow, R5 useTransformExactWorkflow, R6 useOffsetWorkflow, R7 useCreationWorkflow, R8 useCanvasKeyboard, R9 useSnapPreview, R10 useCanvasContextMenu, R11 useClickPlacement, R12 usePointerGestures); the shell is shell + draw + JSX + imperative handle; `max-lines` guard active on `src/components/canvas/**`. `SketchCanvas.tsx` 6167 → 3809 over the phase.** Status stays 🟡 (work complete) pending the user's final hands-on acceptance per the no-premature-archive rule. The coupling is *directional* (snap is read by draw + pointer + click; long-press refs are set inside the pointer handlers; `handleClick` reads only shell-owned `didPanRef`/`suppressClickRef`/`isDraggingNodeRef` from the gesture side), so instead of one ~1,200-line mega-extraction the cluster splits into 4 leaves-first rounds, each consuming the already-extracted leaves: **R9 `useSnapPreview`** (foundation — owns `activeSnapRef`, `resolveCurrentSketchSnap`, `updateActiveSnap`, `isActiveSnapPoint` [18 draw read-sites], `currentSnapReferencePoint`, `requiresResolvedSnapForPointPick`; ctx = snapSettingsRef/projectRef/selectionRef + the pending* refs read by the reference-point helper + scheduleDraw + `onActiveSnapModeChange`); **R10 `useCanvasContextMenu`** (long-press: owns `longPressTimerRef`/`longPressStartRef` + `triggerContextMenuAt` + `handleContextMenu`, exposes `startLongPress`/`cancelLongPress` that the still-in-shell pointer handlers call); **R11 `useClickPlacement`** (the ~498-line `handleClick` pick/place dispatcher, consumes R9 snap); **R12 `usePointerGestures`** (the riskiest CORE: `handlePointerDown`/`handleCanvasPointerMove`/`handlePointerUp`/`handlePointerLeave`/`stopPan`/`handleWheelEvent`/`handleDoubleClick` + pan/zoom/marquee/node-drag refs, consumes R9 snap + R10 context-menu). Then the **`src/components/canvas/**` `max-lines` guard** round, ratcheted at the achieved shell size (~3,800 — see DoD note; <600 deferred as optional post-P6). |
| P7 — Workflow-panel migration | ✅ Done (R3 merge `99ad7ca`; desktop browser-verified 2026-06-17). One UX follow-up logged (P7.4 below). | merged (`core-arch/p7-dim-edit-panel`, `core-arch/p7-fillet-panel`, R3 via `99ad7ca`) | **Round 1:** removed the duplicate inline sketch-edit dimension input overlay from `SketchCanvas.tsx` (the `dimEdit.dimensionEdit && selection.mode === 'sketch_edit' && !pendingAdd` `sketch-dim-input` block) so sketch-edit dimension entry uses the existing `CanvasWorkflowPanel` path only. `SketchCanvasProps`/`SketchCanvasHandle` unchanged; fillet radius inline edit, constraint value inline edit, and creation dimension entry deliberately untouched. Build green (47 test files); lint clean except the pre-existing unused `react-hooks/exhaustive-deps` directive warning in `SketchCanvas.tsx`. Browser-regressed on Badge: desktop + tablet (`statusbar-shell-mode` = `tablet`) enter sketch edit, render `CanvasWorkflowPanel` edit controls, show 0 inline `sketch-dim-input` overlays for normal sketch edit, Cancel returns focus to canvas, 0 JS console errors. **Round 2:** removed the inline fillet radius `sketch-dim-input` overlay and routed fillet radius entry through the existing edit `CanvasWorkflowPanel` path (`editFilletActive`, `fillet` phase key, panel Radius input, Apply/Cancel handlers delegating to `useFilletWorkflow`). Constraint value inline editing and creation dimension entry remain untouched. `SketchCanvasProps`/`SketchCanvasHandle` unchanged; the fillet hook still owns focus/select through `filletRadiusInputRef`, and live preview still calls `scheduleDraw()` on radius input changes. Build green (47 test files); lint clean except the same pre-existing unused directive warning. Browser-regressed on Badge: desktop + tablet enter sketch edit, arm Round corner / fillet, render `CanvasWorkflowPanel` as `Edit / Click a corner / Apply / Cancel`, show 0 inline `sketch-dim-input` overlays, Cancel returns focus to canvas, 0 JS console errors. **Round 3 (merge `99ad7ca`):** replaced the canvas-positioned `sketch-dim-input` overlay for **constraint value editing** with a draggable `CanvasWorkflowPanel` (`canvas-workflow-panel--constraint-edit`), reusing the existing `useConstraintWorkflow` state/handlers — added `constraintEditWorkflowPanel` (open on `!!constraintEdit`) + `commitConstraintEditFromPanel`/`cancelConstraintEditFromPanel` (delegating to `constraintEdit`/`constraintEditInputRef`/`commitConstraintEdit`/`cancelConstraintEdit`). `SketchCanvasProps`/`SketchCanvasHandle` unchanged. Build green; lint clean. **Browser-verified 2026-06-17 (desktop, this mgmt session):** built green, app loads with 0 console errors; drew a rectangle → Edit Sketch; **R2 fillet** radius entry renders in the Edit panel ("Enter radius" + Radius field + Apply/Cancel) with live preview; **R1 dimension** edit and **R3 constraint** value edit both render docked in the panel (not the old floating overlay) and commit — all three user-confirmed. Tab-to-enter fillet radius confirmed **identical to `main`** (P7 moved only the render location, not the trigger). |

## Follow-up tasks (post-P7 UX enhancements — separate from the faithful migration)

These are **additive UX changes** surfaced while browser-verifying P7. They are *not* P7 bugs: P7 only relocated the inline overlays into `CanvasWorkflowPanel` with behavior identical to `main`. These items change interaction, so they get their own round + review + tablet-verify cycle.

### P7.4 — Reactive fillet panel: state-driven step + "Radius" button (no Tab required)

**Status:** ✅ Done (merge `37541ca`, 2026-06-17; user-verified desktop). Implemented as a round in its own worktree off the cumulative branch, reviewed + merged `--no-ff`. **Review-found bug fixed in the same round:** `handlePointerLeave` (in `usePointerGestures.ts`) was cancelling a *picked* fillet + its preview whenever the pointer left the canvas — which broke the new button flow, since reaching the docked "Radius" button requires moving the cursor off the canvas onto the panel. Guarded so a pending fillet (and its preview) survives pointer-leave; preview still clears for the other sketch-edit tools; Esc/Cancel still clears. Shared `enterFilletRadiusEdit()` helper backs both the button and the Tab key. Build green, lint clean (only the pre-existing `SketchCanvas.tsx:1788` warning), both `max-lines` guards pass (SketchCanvas 3777/3800). **Separately surfaced during this test (NOT P7.4, NOT P7):** the feature-**create** "Dimensions" button does nothing — wiring reads correct on paper; the creation-dimension path was last touched in P6 R7 (`556d6fb`) and is untouched by P7/P7.4, so it's an older latent bug. Logged for its own investigation.
**Risk:** Low–medium; tablet-sensitive (this is the tablet command surface).

**Problem (observed in browser test):**
- After picking a fillet corner in sketch-edit, the radius value can only be entered by pressing **Tab** (or clicking a second point). Tab is keyboard-only, so on tablet — where the panel migration was supposed to help — there is **no way to enter a radius**.
- The panel step text also **lags**: it stays "Click a corner" after the corner click and only flips to "Click second point or enter radius" once the mouse moves.

**Root cause:** the fillet step text in `SketchCanvas.tsx` (`editModeActive` panel `step=`) reads `pendingSketchFilletRef.current` — a **ref**. Setting the ref on corner-click does not trigger a React re-render, so the panel only reflects the new step on the next render (the mouse move). The same ref-only signal is why no "Radius" button can appear on corner-click.

**Desired behavior:**
1. Clicking a fillet corner **immediately** updates the panel step (no mouse move needed).
2. A **"Radius"** button appears in the panel the instant the corner is picked — mirroring the existing **"Dimensions"** button in the creation panel (`creationCanDimEdit && !creationDimEditActive`). Pressing it opens the panel Radius input (same path Tab uses today: `fillet.setFilletDimensionEdit(...)` → `editFilletActive`).
3. **Tab keeps working** (do not remove the keyboard path — desktop parity).

**Implementation sketch:** drive the fillet-pending signal off **state** (or mirror the ref into state so the panel re-renders on corner-click), then (a) use it for the step text and (b) render the "Radius" button gated on "corner picked && not yet in radius-edit". The button's onClick reuses the existing fillet-radius trigger (the same code the Tab handler calls — factor it into one helper so Tab and the button share it). `SketchCanvasProps`/`SketchCanvasHandle` stay frozen.

**Acceptance criteria:**
- Corner click → panel step updates immediately (no mouse move) and a "Radius" button is visible.
- "Radius" button opens the panel Radius field; Apply commits, Cancel/Esc aborts; live preview still calls `scheduleDraw()`.
- Tab path unchanged; desktop + **tablet** both verified (tablet must be able to fillet with no keyboard).
- Build green; lint clean; `max-lines` guards still pass.

**Agent prompt (hand to the implementing agent in a round worktree off `feat/core-arch-simplification`):**
> In `src/components/canvas/SketchCanvas.tsx` (+ `useFilletWorkflow.ts` if needed), make the sketch-edit fillet panel reactive to the corner click without removing the existing Tab path. Today the panel `step` reads `pendingSketchFilletRef.current` (a ref), so after picking a corner the step text ("Click a corner" → "Click second point or enter radius") only updates on the next render (mouse move), and there is no on-screen way to enter a radius without pressing Tab. (1) Introduce a state signal that flips when a fillet corner is picked/cleared (mirror the existing `pendingSketchFilletRef` into state, updated wherever that ref is set/cleared) and use it for the panel step so the text updates immediately on corner-click. (2) Add a "Radius" button to the `editModeActive` panel actions, shown only when a fillet corner is picked and not yet in radius-edit (analogous to the creation panel's "Dimensions" button); its onClick must invoke the *same* fillet-radius-entry logic the Tab handler in `useCanvasKeyboard.ts` uses (factor that into a shared helper so they can't drift) → `fillet.setFilletDimensionEdit(...)` → `editFilletActive` shows the Radius input. (3) Do NOT remove or change the Tab behavior, and do NOT change `SketchCanvasProps`/`SketchCanvasHandle`. Verify: `npm run build` green, lint clean, both `max-lines` guards pass; then desktop + tablet browser check — pick a corner, confirm the step updates with no mouse move, the "Radius" button appears and opens the field, Apply commits a fillet, Cancel/Esc aborts, and Tab still works.

### Creation Dimensions cleanup fix

**Status:** ✅ Done (merge `89072e7`, 2026-06-17). Fixed the P6 extraction regression root-caused in `planning/archive/CREATION_DIMENSIONS_BUTTON_BUG.md`: the sketch-edit cleanup effect in `SketchCanvas.tsx` now depends only on `selection.mode`, matching `main`, instead of the recreated `dimEdit` hook-return object. The bug plan was archived as Done. Verified in the round worktree with `npm run build`, `npm run lint` (only the pre-existing unused `react-hooks/exhaustive-deps` warning), desktop browser flow (rectangle → first corner → Dimensions shows Width/Height fields), and DevTools tablet flow (`1366x1024x2,touch,landscape`, shell mode `tablet`, same Width/Height field check). Post-merge cumulative `npm run build` and `npm run lint` also passed with the same pre-existing lint warning.

**Dep-array audit (follow-up to the above):** ✅ Done (merge `cf2190b`, 2026-06-17; plan archived `planning/archive/CANVAS_HOOK_DEP_ARRAY_AUDIT_Plan.md`). Swept the extracted canvas hooks + `SketchCanvas.tsx` for the same unstable-hook-object-in-deps pattern. Fixed two more same-class effects: the fillet cleanup (`~1727`, had `fillet`) and the second dimension cleanup (`~1731`, had `dimEdit`) — both now depend on their primitives only, with documented `exhaustive-deps` disables; the second also reads reactive `selection.mode` instead of `selectionRef.current`. Behaviour-neutral (guarded so no creation-bug reintroduction). Static rerun: zero whole-object hook deps remain in the audited arrays. Build/lint green (pre-existing warning only); desktop + tablet browser-verified.

## Hotspot Map — large because they coordinate vs. large because junk accumulated

Current sizes (measured, not estimated):

| File | Lines | Why it's big | Verdict |
|---|---:|---|---|
| `src/store/projectStore.ts` | 7040 | Single Zustand store: lifecycle, history, feature/op/tool/clamp/tab CRUD, import, pending workflows, constraints **+ a block of module-level pure profile/segment-geometry helpers** | **Mixed.** A store *is* a coordination point, so one store is fine — but pure geometry helpers and many domain action bodies don't need to live in the same file. |
| `src/components/canvas/SketchCanvas.tsx` | 6165 | One `forwardRef` component owning view math, draw orchestration, **and** every pointer/gesture/workflow state machine | **Accumulated.** Render-only primitives were already extracted (see below); the remaining bulk is unrelated interaction state machines sharing one closure. |
| `src/components/cam/CAMPanel.tsx` | 2069 | Every per-operation editor in one file | Accumulated (UI-only). Out of primary scope — see Out of Scope. |
| `src/components/layout/Toolbar.tsx` | 2015 | Already internally split into `useToolbarState` + ~12 action-group components + 3 shells, all in one file | **Accumulated, but pre-decomposed.** Cheap to split into files *after* the command model lands. |
| `src/components/simulation/SimulationViewport.tsx` | 1491 | Three.js sim viewport + playback controls | Genuine domain coordination. Out of primary scope. |
| `src/components/feature-tree/PropertiesPanel.tsx` | 1480 | Per-node property UIs in one file | Accumulated (UI-only). Out of primary scope. |
| `src/App.tsx` | 1457 | Composition root **+** toolpath cache/scheduling engine **+** simulation-model derivation **+** tree context-menu state machine + ~22 near-identical action handlers | **Accumulated.** Classic god-component; the clearest, lowest-risk win. |
| `src/components/viewport3d/Viewport3D.tsx` | 1179 | Three.js preview + toolpath overlay | Genuine domain coordination. Out of primary scope. |
| `src/components/layout/AppShell.tsx` | 739 | Desktop/tablet shell wiring | Reasonable for a shell. Leave. |

Already-extracted helpers prove the direction works and are the precedent to follow:
- `store/slices/` — `selectionSlice` (717), `pendingAddSlice` (703), `pendingCompletionSlice` (687),
  `pendingActionsSlice` (529), `dimensionsSlice` (98), `dimensionToolSlice` (135).
- `store/helpers/` — `ids`, `geometry`, `clipping`, `derivedFeatures`, `normalize`, `polygonSplit`.
- `components/canvas/` pure modules — `viewTransform`, `hitTest`, `scenePrimitives`, `previewPrimitives`,
  `profilePrimitives`, `snappingHelpers`, `draftGeometry`, `draftHelpers`, `manualEntry`,
  `measurements`, `dimensionRendering`.
- `hooks/` app-generic primitives with React-free testable cores — `useStableEvent`, `useEventListener`
  (`useWindowEvent`/`useDocumentEvent`), `useRafScheduler`, `usePortalPosition`.
- `components/canvas/CanvasWorkflowPanel` + `useCanvasWorkflowPanel` — the shared draggable
  apply/cancel workflow panel (focus-handoff already centralized here).

## Consolidation candidates (measured duplication)

1. **Sketch command/action logic is forked desktop↔tablet.** `useToolbarState` (in `Toolbar.tsx`),
   `ToolRail.tsx` (tablet), and `TopCommandBar.tsx` each independently:
   - destructure the *same* ~25 store actions (`startMove/Copy/Resize/Rotate/MirrorFeature`,
     `startJoin/Cut/OffsetSelectedFeatures`, `alignFeatures`, `distributeFeatures`, `deleteFeatures`,
     `setSketchEditTool`, `beginConstraint`, every `cancelPending*`, the `startAdd*Placement` family);
   - re-derive the *same* predicates — `hasSelectedFeatures`, `hasLockedSelectedFeatures`,
     `hasClosedSelectedFeatures`, `hasOffsetEligibleSelectedFeatures`, `canAlign` (≥2), `canDistribute`
     (≥3), `featureSketchEditActive`;
   - re-implement the *same* toggle-or-cancel handlers
     (`handleMove/Copy/Resize/Rotate/Mirror/Join/Cut/Offset/Constraint` — byte-for-byte the
     `if (pending…) cancel(); else start()` shape in both `ToolRail` and `useToolbarState`).
   - `CREATION_SHAPE_OPTIONS` is duplicated verbatim in `Toolbar.tsx` and `ToolRail.tsx`.
   - `TopCommandBar` separately encodes undo/redo disable (`history.past.length === 0`) and file
     ops already living in `useToolbarState`. **This is the single highest drift risk in the app.**

2. **`localStorage`-backed preferences** are hand-rolled in 6 places (`App.tsx` ×2 — depth legend +
   snap settings, `PanelSplit.tsx`, `DisclosureSection`/`disclosureState.ts`, `AppShell.tsx`,
   `utils/updateCheck.ts`). No `useLocalStorageState` hook exists.

3. **Outside-click + Escape dismissal** is hand-rolled: 9 files wire `pointerdown` outside-dismiss and
   11 wire their own `keydown`/Escape (`App.tsx`, `ToolRail`, `Toolbar`, `SnapPopover`,
   `DimensionPopover`, `Select`, `CAMPanel`, the three project dialogs, `SimulationViewport`,
   `Viewport3D`). No `useOutsideDismiss`/`useEscapeKey` hook exists, even though `useEventListener`
   already provides the safe subscribe-once base.

4. **`App.tsx` toolpath engine + simulation model + context menu** are three self-contained subsystems
   wedged into the composition root (details under Phase 2).

5. **`App.tsx`'s ~22 `handleXxxFeature/Tab/Clamp` handlers** are the identical 3-line shape
   `startXxx(id); setCenterTab('sketch'); closeTreeContextMenu()`.

6. **Module-level profile/segment geometry in `projectStore.ts`** — `cloneSegment`,
   `splitBezierSegment`, `splitArcSegment`, `extendOpenProfileAtStart/End`, `reverseOpenProfile`,
   `closeOpenProfile`, `joinOpenProfiles`, `createFilletArcSegment`, `applyLineCornerFillet`,
   `insertPointIntoProfile`, `deleteAnchorFromProfile`, `deleteSegmentFromProfile`,
   `disconnectProfileAtAnchor`, `resolve(Open)CompositeDraftSegments`, `buildArcSegmentFromThreePoints`,
   `translateProfile`, … (~30 pure functions, lines ~135–907). They have no `set()`/store dependency
   and belong next to `src/sketch/` geometry, where they become unit-testable in isolation.

## Micro-function guidance (concrete to this codebase)

**Keep small — they name a real decision or domain invariant:**
- `viewTransform.ts` `worldToCanvas`/`canvasToWorld`/`computeViewTransform` — coordinate-system seam.
- `utils/units.ts` conversions, `store/helpers/clipping.ts` wrappers (integer-scale invariant),
  `hitTest.ts`, `snappingHelpers.ts`, the profile-edit geometry helpers above — all testable invariants.
- `App.tsx` `scheduleAfterPaint` (double-rAF) — one line, but it encodes a non-obvious
  "guarantee a paint between computations" decision; **keep** (move it into the toolpath hook).
- `App.tsx` `operationComputationEquals` — the load-bearing allowlist of computation-relevant
  `Operation` fields; **keep** (move with the cache, keep the "add new field here" comment).

**Inline / merge — indirection without a hidden decision:**
- `App.tsx`'s 22 `handleMove/Copy/Resize/Rotate/Mirror/Offset/Join/Cut/Constraint/...Tab/...Clamp`
  handlers → fold into the shared command descriptors (Phase 3) or one parameterized
  `runCanvasAction(start, { switchToSketch, closeMenu })`.
- `ToolRail.tsx` `startCreationShape`'s `if (shape==='rect')…else if…` ladder → a `{ shape → start }`
  lookup built from the shared `CREATION_SHAPE_OPTIONS`.
- `useCanvasWorkflowPanel`'s `stopActionPointerPropagation` (one-line) — borderline; leave unless the
  surrounding panel code is already being edited.
- Do **not** run a standalone "inline all the things" pass; inline only files a phase already touches.

## Target module boundaries

```
src/hooks/
  useLocalStorageState.ts     (new)  React-free core + hook; mirrors usePortalPosition style
  useOutsideDismiss.ts        (new)  pointerdown-outside + Escape, built on useEventListener

src/app/                      (new)  App-orchestration hooks (no JSX engine logic in App.tsx)
  useToolpathGeneration.ts    (new)  cache type, operationComputationEquals, isCacheHit,
                                     generateToolpathForOperation, needed/generating ids,
                                     one-per-frame async pipeline, visibleToolpaths, collidingClampIds
  useSimulationModel.ts       (new)  simulationResult / operationCount / playbackInput derivation
  useTreeContextMenu.ts       (new)  context-menu open/close/position state machine + clampMenuPosition

src/components/feature-tree/
  FeatureContextMenu.tsx      (new)  the menu JSX currently inlined in App.tsx (~190 lines)

src/commands/                 (new)  shared, surface-agnostic command model
  sketchCommands.ts           (new)  command descriptor type + useSketchCommands() (labels, iconIds,
                                     active, disabled, shortcut, onClick, tablet/desktop visibility)
  creationShapes.ts           (new)  single CREATION_SHAPE_OPTIONS source
  fileCommands.ts             (new)  new/open/import/export/save/undo/redo descriptors

src/components/layout/toolbar/ (new) presentational split of Toolbar.tsx, consuming useSketchCommands
  ToolButton.tsx, ProjectNameControl.tsx, GlobalActions.tsx, CreationActions.tsx,
  FeatureEditActions.tsx, AlignmentActions.tsx, ShapeToolActions.tsx, SketchEditActions.tsx,
  BackdropEditActions.tsx, SnapActions.tsx, MeasureActions.tsx

src/store/
  projectStore.ts             SHRINKS to a composition root: the create<ProjectStore>() call that
                              spreads the slice creators below + the shared history-aware `set`,
                              `cloneProject`, `normalizeProject`. Public surface unchanged.
  types.ts                    the public ProjectStore interface — the FROZEN contract (unchanged)
  slices/                     EXTEND the existing createXxxSlice(set, get, deps) pattern the store
                              already spreads (selection / pendingAdd / pendingActions /
                              pendingCompletion / dimensions* slices exist) — one slice per domain:
    projectLifecycleSlice.ts, historySlice.ts, featureCrudSlice.ts, featureTreeOrderSlice.ts,
    operationsSlice.ts, toolsSlice.ts, clampsSlice.ts, tabsSlice.ts, importMergeSlice.ts,
    backdropSlice.ts, machineDefsSlice.ts, pendingMoveTransformSlice.ts, pendingShapeOffsetSlice.ts,
    constraintsSlice.ts
  helpers/profileEdit.ts      (new) the ~30 module-level profile/segment geometry helpers (from store)

src/components/canvas/        (extend the existing pure-module set)
  usePointerGestures.ts, useSnapPreview.ts, usePlacementWorkflow.ts, useTransformWorkflow.ts,
  useDimensionEditWorkflow.ts, useConstraintWorkflow.ts, useCanvasContextMenu.ts (long-press),
  useCanvasKeyboard.ts        (new)  — SketchCanvas.tsx shrinks to a thin shell + imperative handle
```

The **store's public API does not change** in any phase: `Toolbar`, `ToolRail`, `App`, canvas, panels
keep calling the same `useProjectStore()` actions. Only the *implementation* moves into `store/slices/*`
creators that `projectStore.ts` spreads together at its `create<ProjectStore>()` call — exactly how
`createSelectionSlice` / `createPendingAddSlice` / … already work today.

## Execution model — cumulative feature branch + per-phase worktrees

This work ships as **one unit in the next release**, not as independent PRs to `main`. Mirror the
lint-cleanup model:

- Cut one long-lived **cumulative feature branch** off `main` (e.g. `feat/core-arch-simplification`).
- Implement each phase in its **own worktree branched off the cumulative branch** (so each phase builds
  on the prior phases), then merge it **back into the cumulative branch** — never into `main` directly.
  The cumulative branch is what finally merges to `main` for the release.
- Phases stay independently reviewable and revertible *within* the cumulative branch (revert the
  phase's merge commit), not as separate mainline PRs.
- `npm run build` must be green before a phase worktree merges into the cumulative branch.

**Phase ordering — revised from the task's suggested order, with rationale.** The task put
App-orchestration (3), store split (4), and canvas extraction (5) before the command model (7). This
plan moves shared utilities and the command model earlier because they (a) are the lowest-risk,
highest-leverage changes, (b) immediately kill the desktop↔tablet drift, and (c) make the later Toolbar
file-split land on already-thin components. Store and canvas — the two behavior-sensitive giants — come
last.

### Phase 0 — Stale-plan housekeeping  *(no app code; do first, on the cumulative branch)*
Retire planning docs that are stale so phase agents working off this branch aren't misled by superseded
or already-shipped guidance. Audit every active entry in `planning/INDEX.md`; for each plan whose work
has already shipped to `main`, and for any plan this effort supersedes, set its frontmatter `status`
(`Done` if shipped, `Abandoned`/superseded if replaced), `git mv` it into `planning/archive/`, and
remove its entry from the active sections of `planning/INDEX.md`. These are **closed, not certified
complete** — removed from the active set, not re-verified against their own acceptance criteria.
Confirmed-stale now (their features are already merged on `main`):
- `MEASURE_DIMENSIONS_Plan.md` (8 measure/dimensions commits on `main`) — close.
- `FEATURE_CREATION_PICKER_POC_Plan.md` (feature-creation picker + quick-ops shipped) — close.
- `REFACTORING_Plan.md` — superseded here for the store/canvas/app hotspots — close/supersede.

Verify-then-likely-close: `WATERLINE_ADAPTIVE_REFINEMENT_Plan.md`, `WATERLINE_CONTAINING_ADD_FIX_Plan.md`
(broad waterline work is merged, but confirm these specific refinements aren't still open first). Net
effect: when a phase agent opens `planning/INDEX.md`, this plan is the only active authority for the
state/canvas/app area.

### Phase 1 — Shared app-utility hooks  *(lowest risk; pure refactor)*
Add `useLocalStorageState` and `useOutsideDismiss` (React-free cores + unit tests, mirroring
`usePortalPosition`). Migrate the 6 localStorage sites and the popover/menu dismissal sites
(start with `App.tsx`, `SnapPopover`, `DimensionPopover`, `ToolRail` flyouts, `Toolbar` popover; leave
modal dialogs if their focus-trap differs). No behavior change.

### Phase 2 — `App.tsx` orchestration extraction  *(low risk; mostly move + test)*
Extract `useToolpathGeneration`, `useSimulationModel`, and `useTreeContextMenu` + `FeatureContextMenu`.
Collapse the 22 action handlers. `App.tsx` becomes a thin composition root (target **< ~400 lines**).
This is where the task's example `useToolpathGeneration` unit tests (cache invalidation + one-per-frame
scheduling) land.

### Phase 3 — Shared sketch command model  *(medium risk; behavior-sensitive UI parity)*
Introduce `useSketchCommands()` + `creationShapes.ts` + `fileCommands.ts`. Re-point `useToolbarState`,
`ToolRail`, and `TopCommandBar` at the shared descriptors and predicates. Goal: one source for every
enable/disable/active/toggle rule. **Requires desktop + tablet verification** (this is the core
tablet-affecting change).

### Phase 4 — `Toolbar.tsx` file split  *(low risk after Phase 3)*
Move the already-internal groups into `components/layout/toolbar/*`. With command logic in the shared
hook, these are thin presentational components. Closes the `TOOLBAR_REVISIT.md` structural-split item.

### Phase 5 — Store slice extraction → `projectStore.ts` becomes a composition root  *(higher risk; one domain per worktree)*
Continue the **existing** `store/slices/createXxxSlice(set, get, deps)` pattern (the store already
spreads `createSelectionSlice` / `createPendingAddSlice` / … at its `create<ProjectStore>()` call).
Carve the ~4000 lines of inline action bodies in `projectStore.ts` into one slice per domain — feature
CRUD first as the template, then operations, tools, clamps, tabs, import/merge, backdrop, machine defs,
pending move/transform/offset/shape, constraints, project lifecycle, history. The public `ProjectStore`
interface in `types.ts` is the **frozen contract** — call sites never change. When done,
`projectStore.ts` is only the composition root (the spread of slice creators + the shared history-aware
`set`, `cloneProject`, `normalizeProject`). Separately move the module-level profile/segment helpers
into `helpers/profileEdit.ts` with unit tests. One domain per worktree onto the cumulative branch, each
independently revertible.

### Phase 6 — Canvas workflow hook extraction from `SketchCanvas.tsx`  *(highest risk)*
Extract the interaction state machines (`usePointerGestures`, `useSnapPreview`, `usePlacementWorkflow`,
`useTransformWorkflow`, `useDimensionEditWorkflow`, `useConstraintWorkflow`, `useCanvasContextMenu`
long-press, `useCanvasKeyboard`). Keep the thin shell + `useImperativeHandle`. RAF scheduling already
uses `useRafScheduler` — preserve it. **Requires browser + tablet verification per extracted machine.**

### Phase 7 — Workflow-panel migration for remaining canvas UI  *(medium risk)*
Move remaining ad-hoc canvas banners (copy-count input, placement hints, apply/cancel) onto
`CanvasWorkflowPanel`/`useCanvasWorkflowPanel` so desktop and tablet share one apply/cancel + focus
handoff. **Tablet verification required.**

### Phase 8 — Opportunistic inlining
Not a standalone phase/worktree. Fold the noisy one-use wrappers listed above into whichever phase touches them.

## Files affected (by phase)

- **P0:** edit `planning/INDEX.md`; `git mv` stale plans into `planning/archive/` and set their `status`. **No `src/` changes.**
- **P1:** *(new)* `src/hooks/useLocalStorageState.ts`(+`.test.ts`), `src/hooks/useOutsideDismiss.ts`(+`.test.ts`); edit `App.tsx`, `PanelSplit.tsx`, `common/disclosureState.ts`, `AppShell.tsx`, `utils/updateCheck.ts`, `SnapPopover.tsx`, `DimensionPopover.tsx`, `ToolRail.tsx`, `Toolbar.tsx`.
- **P2:** *(new)* `src/app/useToolpathGeneration.ts`(+test), `src/app/useSimulationModel.ts`, `src/app/useTreeContextMenu.ts`, `src/components/feature-tree/FeatureContextMenu.tsx`; edit `App.tsx`.
- **P3:** *(new)* `src/commands/sketchCommands.ts`(+test), `creationShapes.ts`, `fileCommands.ts`; edit `Toolbar.tsx` (`useToolbarState`), `ToolRail.tsx`, `TopCommandBar.tsx`.
- **P4:** *(new)* `src/components/layout/toolbar/*`; edit `Toolbar.tsx` (now a shell).
- **P5:** *(new)* `src/store/slices/*Slice.ts` (extending the existing slice set), `src/store/helpers/profileEdit.ts`(+test); edit `projectStore.ts` (→ composition root, interface unchanged), `eslint.config.js` (`max-lines` override for `src/store/**`).
- **P6:** *(new)* `src/components/canvas/use*Workflow.ts` / `usePointerGestures.ts` / etc.; edit `SketchCanvas.tsx`, `eslint.config.js` (`max-lines` override for `src/components/canvas/**`).
- **P7:** edit `SketchCanvas.tsx` + the remaining banner components; reuse `CanvasWorkflowPanel`.

## Tests

- **P1:** unit-test the React-free cores (`useLocalStorageState` read/write/JSON-parse-fallback;
  `useOutsideDismiss` inside/outside/Escape decisioning) — same pattern as `usePortalPosition.test.ts`.
- **P2:** unit-test `useToolpathGeneration`'s cache layer — `operationComputationEquals` field
  coverage, `isCacheHit` identity rules, and the one-per-frame scheduler against a fake rAF (mirrors
  `useRafScheduler.test.ts`). This is the task's named acceptance example.
- **P3:** unit-test `useSketchCommands` predicate/disabled derivation (locked selection, closed-profile
  gating, align≥2 / distribute≥3, sketch-edit-active) so desktop and tablet can't drift.
- **P5:** the moved `profileEdit` helpers get direct unit tests (they were previously untestable inside
  the store). Existing store tests (`createRestOperation`, `openProfileJoin`, `projectStoreTransform`,
  `polygonSplit`, `second_cut`) must stay green unchanged — they are the behavior-preservation guard.
- **All phases:** `npm run build` (runs `npm test`) green before a phase worktree merges into the
  cumulative branch. Engine/pure-logic additions carry unit tests per `AGENTS.md`.

## Manual browser / tablet verification strategy

Behavior-sensitive phases and what to exercise (desktop **and** `tablet.css` touch mode):
- **P3 (command model):** every toolbar/rail/command-bar button — create shapes (feature + region
  targets), move/copy/resize/rotate/mirror, offset, join/cut, align/distribute, constraint,
  sketch-edit tools, undo/redo/save enable states, snap toggles. Confirm tablet rail and desktop
  toolbar agree on enabled/active state in identical selections.
- **P6 (canvas state machines):** pointer draw of each shape, pending-add placement + cancel, drag
  move/copy with copy-count, resize/rotate/mirror reference picking, dimension placement + edit,
  constraint anchor/reference pick, long-press context menu (touch) vs right-click (desktop), axis
  lock, snap preview, zoom-window. Verify focus returns to canvas after each workflow.
- **P7 (workflow panels):** apply/cancel + focus handoff for each migrated banner on both form factors.
- **P2:** toolpath spinner timing (spinner shows on first stale frame, not a frame late) and 3D/sim
  recompute on operation switch.

## Risk assessment

- **P5 (store) and P6 (canvas) are the real risk.** Mitigation: behavior-preserving moves only, one
  domain/state-machine per PR, public store API frozen, existing store/canvas tests as the guard, and
  required manual verification before each merge.
- **P3 can silently change tablet behavior** if a predicate is unified slightly differently than one
  side previously computed it. Mitigation: derive the shared predicates to *exactly* match the current
  `useToolbarState`/`ToolRail` logic, then diff button states on both form factors before merge.
- **Merge-conflict risk during a long sequence:** phases are scoped to disjoint files where possible
  (hooks/ and commands/ are new; store domain split is per-domain) so parallel agents collide less.
- **`.camj` compatibility:** no serialization or schema change in any phase — `types/project.ts` and
  `store/helpers/normalize.ts` are untouched. Call this out in each store-phase merge.

## Rollback strategy

Each phase merges into the cumulative branch as its own merge commit, so a phase can be backed out with
a single revert of that merge without disturbing earlier phases. Phase 5 is further subdivided per
domain (one worktree/merge per domain) so a single domain move can be reverted on its own. Because the
public store API and component prop contracts are invariant across phases, reverting any phase restores
prior behavior without cascading edits. If the whole effort needs to slip the release, the cumulative
branch simply isn't merged to `main` — nothing is on `main` yet. Independence: P1, P2, P4 are trivially
revertible; P3 revert restores per-surface command logic; P5/P6 revert per domain/per state machine.

## INDEX.md files to update during implementation

- `src/INDEX.md` — add `src/app/` and `src/commands/` folders.
- `src/hooks/INDEX.md` — `useLocalStorageState`, `useOutsideDismiss` (P1).
- `src/store/INDEX.md` — new `slices/*Slice.ts` modules, `helpers/profileEdit.ts` (P5).
- `src/components/INDEX.md` + a new `src/components/layout/toolbar/INDEX.md` (P4); note
  `FeatureContextMenu.tsx` under feature-tree (P2).
- `src/components/canvas/` — extend the canvas module list with the new workflow hooks (P6).
- `planning/INDEX.md` — move this plan Pending → In progress on approval; archive on completion.
- `planning/TOOLBAR_REVISIT.md` — close it when P4 lands (it calls for exactly the structural
  Toolbar split done there).

## Acceptance criteria (per phase)

- **P0:** `planning/INDEX.md` active/In-progress sections list no shipped-but-unarchived plans; closed
  plans moved to `planning/archive/` with `status` set; this plan is the sole active authority for the
  state/canvas/app area; **no app source touched**.
- **P1:** the two hooks exist with passing core tests; the 6 localStorage sites and migrated dismissal
  sites use them; no behavior change; build green.
- **P2:** `App.tsx` no longer contains the toolpath cache/pipeline, simulation-model derivation, or the
  context-menu JSX/handlers; `App.tsx` **< ~400 lines**; `useToolpathGeneration` cache+scheduler tests
  pass; spinner timing unchanged; build green.
- **P3:** one `useSketchCommands()` is the only place enable/disable/active/toggle rules live;
  `Toolbar`/`ToolRail`/`TopCommandBar` consume it; `CREATION_SHAPE_OPTIONS` has one definition; desktop
  and tablet button states verified identical; build green.
- **P4:** `Toolbar.tsx` is a thin shell importing `toolbar/*` (**< ~300 lines**); `TOOLBAR_REVISIT.md`
  split satisfied; build green.
- **P5:** `projectStore.ts` is a composition root (**< ~600 lines**); public `ProjectStore` interface
  byte-identical; every action body lives in a `store/slices/*` slice; `profileEdit` helpers
  unit-tested; all prior store tests green; `.camj` round-trips unchanged; `max-lines` guard active on
  `src/store/**`.
- **P6:** every interaction **state machine** lives in its own hook; the shell retains only the
  `draw` renderer (~787L), the JSX return (~1216L), refs/effects wiring, and the imperative handle.
  **Target revised (2026-06-17, user-approved):** the aspirational **< ~600 lines** is NOT reachable
  in P6 — survey showed draw + JSX dominate and are not interaction machines, so the shell lands
  **~3,800 lines** after the pointer cluster extracts. DoD = **all interaction machines extracted**;
  the `max-lines` guard on `src/components/canvas/**` is ratcheted at the achieved count (mirrors the
  P2 App.tsx 506-vs-<400 precedent). Pushing toward <600 (extracting a `useCanvasRenderer` for `draw`
  and the JSX panels) is deferred as optional post-P6 scope. Full manual canvas verification passes on
  desktop + tablet; build green.
- **P7:** remaining canvas banners use `CanvasWorkflowPanel`; focus handoff verified both form factors.

## Definition of done & anti-regrowth guardrails

The point of this work is that **"that file is too big / too risky to change" stops being true** — so
the plan commits to outcomes, not just code moves, and to a guard that keeps them true. (Per the task,
line count is **not** the success metric — cohesion and clear ownership are; the figures below are a
regression guardrail, not the goal.)

**Per-hotspot end state:**
- `projectStore.ts` → composition root only, every action body in a domain slice, public contract
  unchanged. Guardrail **< ~600 lines**.
- `SketchCanvas.tsx` → thin shell: refs, imperative handle, hook composition, canvas JSX; every
  interaction state machine in its own hook. Guardrail **< ~600 lines**.
- `App.tsx` → composition root, no toolpath/sim/context-menu logic inline. Guardrail **< ~400 lines**.
- `Toolbar.tsx` → shell importing `toolbar/*` presentational groups. Guardrail **< ~300 lines**.
- Every new slice/hook/module is cohesive (one concern) and, where pure, ships with unit tests — so
  future edits are guarded by tests, not by reviewer nerve.

**The anti-regrowth guard** (this is why April's extraction didn't stick — two months of feature work
quietly regrew the files): add an ESLint `max-lines` rule via `overrides` **scoped to the refactored
areas only** (`src/store/**`, `src/components/canvas/**`, `src/App.tsx`, `src/app/**`,
`src/components/layout/toolbar/**`) — **not** repo-wide, so legitimately large engine files (e.g.
`vcarveRecursive.ts`, `dxf.ts`) are untouched. Use a generous cap (≈700, `error`) added in the same
phase that brings each area under it, so it never flags already-clean code. A file silently regrowing
past the cap then fails `npm run lint` instead of surfacing months later. New behaviour has nowhere to
hide: it must land in the owning slice/hook/module.

**License-header guard:** `scripts/check-license-headers.ts` runs inside `npm test` (hence `npm run build`) and fails the gate if any `src/**/*.ts(x)` file lacks the Apache 2.0 header — compliance is now mechanical, not reviewer/agent diligence. Added during this effort as a sibling to the size guard (there was previously no eslint rule, build/test check, hook, or CI step enforcing it).

**Ownership is documented, not implied:** every new module is registered in the nearest `INDEX.md` (per
`AGENTS.md`) so the next agent knows where new code belongs without opening the large files.

## Out of scope

- **CAM/UI-only giants** `CAMPanel.tsx` (per-operation editors) and `PropertiesPanel.tsx` (per-node
  property UIs). They are large but *cohesive* — one file, one responsibility (operation/property
  editing) — and none of the task's seven refactor directions (store boundaries, canvas workflow,
  app orchestration, command/toolbar model, shared hooks/utilities) targets them. A registry-driven
  editor split is a separate UI concern; defer it unless a phase here happens to pass through them.
- **Engine internals** (`engine/toolpaths/*`, `engine/gcode/*`, `vcarveRecursive.ts`, `csg.ts`),
  `import/*`, `simulation`/`viewport3d` 3D internals — domain coordination, not the target.
- **`scripts/`** — diagnostics/tooling, explicitly out of scope.
- **Lint cleanup** — the separate lint agent's mechanical fixes are not combined here. (The `max-lines`
  *guardrail* in Definition of done is a structural regression guard added by this effort, not lint
  cleanup.)
- **Any data-model / `.camj` schema change** — none in this effort.

## Resolved decisions

Both previously-open questions are now decided (user delegated):

1. **Store granularity = one slice per domain (finest sensible grain), not coarse buckets.** Per-domain
   slices give each concern a single owner and isolate reverts; they are the only grain that actually
   removes "the store is too big to touch." A `featuresAndOps.ts` catch-all would just recreate a
   smaller monolith. This is also the pattern the store already uses, so it adds no new convention.
2. **Add `src/app/` for the orchestration hooks** (`useToolpathGeneration`, `useSimulationModel`,
   `useTreeContextMenu`), kept distinct from the generic `src/hooks/` primitives.
