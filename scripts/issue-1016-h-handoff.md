# #1016 C2 — square blank simulated like the round bar (handoff, all slices)

Follow the Session rules in #962. DSH writes code, COMMIT: none. Format 3.3. The approved plan is the amendment comment on #1016 (Frank approved 2026-10-17): a square blank is simulated EXACTLY like the round bar — same radial heightfield (one radius per cell), same cutting kernel (`applyMoveToGrid`), same playback (`PlaybackController`), same GPU renderer, same synchronous app path. The ONLY difference is the starting radius per cell (`seedSquareTopZ` in `grid.ts`). Toolpaths, G-code, motion guards, workholding, square UI/dialogs, `csg.ts`/3D preview: unchanged. Round and flat simulation output byte-identical.

Each dispatch names ONE slice below. Do only that slice's files. The full independent Codex audit (inventory, injection points, uniform-radius assumptions, test dispositions) follows the slice list and is the reference for what to remove/keep.

## Slice A — state, initialization, replay, playback
Own: `src/engine/simulation/types.ts`, `grid.ts`, `replay.ts`, `playback.ts`, `index.ts` (exports); delete `squareMaterial.ts`, `squareReplay.ts`, `squareMaterialConvergence.test.ts`, `squareMaterialWindow.test.ts`; `squareGrid.test.ts`; replace `squareReplay.test.ts` with shared-heightfield tests; `replay.test.ts`, `playback.test.ts`.
- Drop `SimulationGrid.squareMaterial` and `squareBar` as a runtime model switch. Square start enters only through `createSimulationGrid` (options), filling `topZ` from `seedSquareTopZ`; keep an optional immutable per-cell starting baseline (`initialTopZ`) used ONLY for stats.
- Cutting/playback for a square grid goes through the round path with no square branch. Stats: removed-cell count, `minTopZ`, `maxRemovedDepth` measured against each cell's own starting height when a baseline exists; round/flat stats byte-identical.
- FROZEN interface for slices B/C/D (do not deviate; report if impossible): `SimulationBuildOptions.squareBar?: SquareBarDescriptor` stays as the initialization input (same name/shape); `SimulationGrid` keeps `stockTopZ` (for a square grid = pivot-relative corner radius, as today), `wrap`, `topZ`, optional `initialTopZ`; `SimulationGrid.squareBar` and `.squareMaterial` are removed. Keep exporting `seedSquareTopZ`/whatever helper computes a square cell's starting radius if other code imports it.
- Other code (app, components, renderer) will not compile against removed fields until B/C/D land: for this slice ONLY, make the minimum compile-preserving shims outside your files impossible — instead list every external compile error after your change in the report (manager integrates in order). Your own files' tests must pass.
- Tests that must bite: square grid starts at r(theta) per cell and ends stay square after a real square rough replay (use `src/test/squareSimulationFixture.ts` paths if importable, else an inline equivalent); a cut lowers corner cells above nominal radius; never raises; playback batch == subdivided; reset restores base; stats against baseline (virgin square reports 0 removed); round/flat replay/playback outputs byte-identical (existing tests unchanged). Mutations that must fail: square start filled uniformly; stats against uniform stockTopZ; kernel raising a cell.

## Slice B — renderer (after A)
Own: `aroundWrap.ts`, `gpuMesh.ts`, `instancedBoundary.ts`, `heightfieldShader.ts` and their tests; delete `squareMaterialGeometry.ts/.test.ts`, `squareMaterialMesh.ts/.test.ts`. Bounds/framing use the grid's radial envelope (`grid.stockTopZ`) so corners are not clipped; shader arithmetic unchanged; round/flat geometry byte-identical.

## Slice C — app path (after A)
Own: `src/app/simulationSetup.ts`, `simulationCompute.ts`, `useSimulationModel.ts`, their tests, `src/app/squareSimulation.test.ts`, `src/test/squareSimulationFixture.ts`, `src/plasmaTool.test.ts`; delete `src/app/simulationWorker/`. Square uses the same synchronous memo and lazy prior replay as round (as before P2). Keep path-acquisition cancellation.

## Slice D — viewport and browser (after B, C)
Own: `src/components/simulation/SimulationViewport.tsx`, `aroundView.ts/.test.ts`, delete `squarePreview.ts/.test.ts`, replace `simulationObserver.ts` (delete if the round bar needs none) and its `src/main.tsx` seam, `e2e/rotaryModel.smoke.spec.ts` square playback test rewritten to the round bar's checks.

## Slice E — docs
INDEX files and `planning/SIMULATION_GPU_HEIGHTFIELD_DESIGN.md`.

Checks for every slice: `node --import tsx` on owned tests and existing round/flat simulation tests (`aroundReplay`, `aroundWrap`, `replay`, `playback`, `grid`); eslint on changed files; `node_modules/.bin/tsc -p tsconfig.app.json --noEmit` (report external errors for A); no browser/full build/pools. Report: STATUS, COMMIT: none, CHANGED_FILES, deletions, each mutation and result, commands with exit codes, RISKS.

---

# Independent Codex audit (reference)

The change can be confined to simulation. The existing square grid already seeds the requested radius function; the work is to remove the separate material model and route that grid through the round bar’s replay, playback and GPU renderer.

Audit basis: branch `codex/issue-1016-c2-combined-review`, HEAD **`6fcea7baa661db870802e6444ef618a3d39b3749`**, integration base `origin/integration/0.6.0`. All symbols below refer to that HEAD. This is an inventory and implementation-scope audit, with no acceptance or merge recommendation.

## 1. Exact-model inventory and disposition

Paths below are relative to `/Users/frankp/Projects/worktrees/purecutcnc/rotary-c2-combined-review`.

### Simulation state and initialization

**`src/engine/simulation/types.ts` — simplify.**

- **Remove `SimulationGrid.squareMaterial`**, including its missing-key-means-virgin semantics and canonical `[lo, hi]` endpoint arrays.
- **Remove `SimulationGrid.squareBar` as a runtime model discriminator.** The cutting, playback and rendering paths should not need to know that a heightfield started square.
- **Keep `SimulationGrid.initialTopZ`, generalized as an optional immutable initial-height baseline.** Variable initial radii require it for meaningful removal statistics. It is not inherently an interval-model field.
- **Simplify `SquareBarDescriptor { side, frame }` to initialization metadata only.** Its information is still needed to seed the square, but should not travel through the mutable grid as an alternate-model selector.
- `SimulationBuildOptions.squareBar` can retain its current name for minimal churn, provided it means *initialization only*. Alternatively, rename it with the initialization contract; neither choice requires a separate simulation implementation.
- Keep `topZ`, `wrap`, `stockBottomZ`, `stockTopZ`, dimensions, origins, `DirtyRegion`, `SimulationStats`, replay-item and result types.

**[`grid.ts`](/Users/frankp/Projects/worktrees/purecutcnc/rotary-c2-combined-review/src/engine/simulation/grid.ts:29) — keep the seeding, simplify the returned state.**

- `resolveSimulationGridSpec`: keep normal grid sizing. Preserve a conservative square radial maximum for rendering, while keeping the actual pivot at `side/2`.
- `seedSquareTopZ`: **keep**. It already computes the requested function at each across-cell centre:
  ```text
  theta = (acrossCoordinate - frame.zero) * 2π / frame.circumference
  radius = (side/2) / max(|sin(theta)|, |cos(theta)|)
  ```
  It repeats that cross-section along the bar.
- `createSimulationGrid`: keep square initialization and its immutable baseline; remove allocation of `squareMaterial` and propagation of the runtime square descriptor.
- `pointInPolygon` and flat-stock profile masking: keep unchanged.
- Move the seed formula and descriptor validation out of the soon-to-be-deleted exact kernel. `barSurfaceRadius` already expresses the same geometry in **degrees**; the existing simulation helper takes **radians**, so substituting it requires explicit conversion.

### Exact cutting kernel

**`src/engine/simulation/squareMaterial.ts` — remove the entire file after relocating initialization geometry/validation.**

Remove its exported simulation API:

- `applySquareMoveToGrid`
- `squareMaterialIntervals`
- `setSquareMaterialIntervals`
- `cloneSquareMaterial`
- `squareToolSupported`
- `SquareApplyResult`
- `SquareSearchOptions`, including `legacyFullLoop` and `testedCells`
- `TestedCellStats`, including `tested` and `withBand`

Relocate or replace these initialization-only functions before deletion:

- `squareSurfaceRadius`
- `validateSquareBarDescriptor`

Remove all supporting exact-model types, constants and functions:

- `SquareBarDescriptorLike`, `LoopControl`, `MoveGeometry`, `AcrossRange`.
- `TWO_PI`, `CONVERGE_ITERATIONS`, `AXIAL_EPSILON`, `ULP`, `ZERO_RESULT`, `ANGLE_WINDOW_EPSILON`, `INDEX_SOLVE_ERROR_FACTOR`, `MAX_WRAP_COPIES`.
- `clamp`, `wrapPi`, `rawThetaAt`, `thetaAt`, `angleIsConstant`.
- `angleWindowBound`, `acrossCellCentre`, `acrossWindow`.
- `maximizeConcave`, `minimizeConvex`, `bisectCrossing`, `concaveDomain`, `reachableWindow`.
- `constantAngleBands` and its nested cutter-body/contact calculations.
- `removedBandsForCell`, `mergeIntervals`, `subtractBand`, `compactIntervals`, `materialDiffers`, `finitePoint`, `pointToCellRange`.

That removes the contact-window solver, convergence machinery, angle-window optimization, cylindrical-shank/interior-band model, and square-only supported-motion regime. In particular, **do not retain its below-envelope changing-angle refusal in simulation**: the requested replacement uses the round kernel. Production motion/output guards remain separate and unchanged.

**`src/engine/simulation/squareReplay.ts` — remove the entire compatibility wrapper.**

Remove its forwarding functions and re-exports:

- `squareSurfaceRadius`, `validateSquareBar`, `applySquareMoveToGrid`
- `squareMaterialIntervals`, `setSquareMaterialIntervals`, `cloneSquareMaterial`, `squareToolSupported`, `SquareApplyResult`

Update initialization callers before deleting it.

### Shared replay, statistics and playback

**[`replay.ts`](/Users/frankp/Projects/worktrees/purecutcnc/rotary-c2-combined-review/src/engine/simulation/replay.ts:164) — simplify.**

- Remove the `squareMaterial` import.
- Remove `applyMoveToGrid`’s `if (grid.squareBar)` dispatch.
- Keep `applyMoveKernel` and periodic seam-copy logic unchanged.
- Keep `moveIsMaterialRemoving`, `replayItemIntoGrid`, `simulateOperationHeightfield` and `simulateReplayItemsHeightfield`.
- Replace `computeStats`’ interval-map branch with an optional-baseline heightfield calculation:
  - removed cell: `topZ[i] < initialTopZ[i] - tolerance`;
  - minimum top: minimum current `topZ`;
  - maximum removed depth: maximum `initialTopZ[i] - topZ[i]`.
- Preserve the existing flat/round statistics path verbatim when no baseline exists.

**`src/engine/simulation/playback.ts` — simplify.**

- Remove `cloneSquareMaterial` import.
- `cloneSimulationGrid`: copy mutable `topZ`; sharing immutable `initialTopZ` is appropriate.
- `PlaybackController.reset`: remove interval-map restoration/clearing. Keep `topZ.set(baseGrid.topZ)` and full-grid dirty marking.
- Keep subdivision, interpolation, feed scaling, forward advance, seek/back-seek, pose and dirty-region behavior.
- Reset must restore **the prior-operation base grid**, not necessarily virgin stock.

### Exact boundary geometry and resources

**`src/engine/simulation/squareMaterialGeometry.ts` — remove the entire file.**

Remove all fields of these exact-model types:

- `SquareMaterialAlongBounds`
- `SquareMaterialGeometryOptions`
- `SquareMaterialLayout`
- `SquareMaterialChunkBuffer`
- private `Vec3`, `RadialBand`, `DiffBand`, `CellInfo`, `MeshAccumulator`, `BuildContext`

This includes exact axial bounds, angular/axial edge partitions, interval bands, corner knots, signatures, chunk buffers and emitted normals/positions.

Remove its public constants/functions:

- `DEFAULT_SQUARE_ANGULAR_SEGMENT_RADIANS`
- `DEFAULT_SQUARE_MAX_ANGULAR_SEGMENTS`
- `DEFAULT_SQUARE_ANGULAR_CELLS_PER_CHUNK`
- `resolveSquareMaterialLayout`
- `squareMaterialLayoutSignature`
- `squareMaterialChunkCount`
- `squareMaterialChunkAngularRange`
- `squareMaterialChunkIndicesForDirtyRegion`
- `buildSquareMaterialChunk`
- `squareMaterialEnvelope`

Remove all private geometry machinery:

- `clamp`, `blankRadius`, `world`, `radialDirection`, `thetaDirection`, `alongDirection`, `sub`, `cross`.
- `createAccumulator`, `pushVertex`, `emitQuad`, `emitTriangle`, `emitOrientedTriangle`, `finishChunk`.
- `segmentCount`, `readCell`, `cellBreakPoints`, `solveBlankCrossing`, `columnPartition`, `cornerKnots`.
- `clipBands`, `findBand`, `differenceBands`.
- `emitRadialFaces`, `emitRadialArc`, `emitFlatOuter`, `emitAngularFaces`, `emitAngularEdge`, `emitAxialFaces`, `emitAxialEdge`, `edgeKnots`, `emitStrip`, `samePoint`, `sortUnique`.

No interval gap surfaces, conforming partitions, triangular collapsed caps or manifold boundary construction are needed for a one-radius-per-cell model.

**`src/engine/simulation/squareMaterialMesh.ts` — remove the entire file.**

Remove:

- `SquareMaterialMeshOptions`, including `angularCellsPerChunk`.
- `SquareMaterialMeshStats`: `chunkCount`, `triangleCount`, `geometriesCreated`, `geometryDisposals`, `materialDisposals`.
- `SquareMaterialMeshResource`: `object`, `bounds`, `stats`, `disposed`, `update`, `dispose`.
- `createSquareMaterialMesh`, `bufferToGeometry`.
- Nested `refreshCounts`, `applyEnvelope`, `releaseGeometry`, `rebuildAll`, `rebuildChunk`, update and disposal implementations.

Its dirty-chunk rebuilding is replaced by the existing heightfield texture upload.

**`src/components/simulation/squarePreview.ts` — remove the entire exact-resource adapter.**

Remove:

- `squarePreviewAlongBounds`
- `squarePreviewKey`
- `SquarePreviewSurface`, including its object/resource/key/disposal fields and methods
- `createSquarePreviewSurface`, its update implementation and owned disposal

The **shape-invalidation requirement survives**; this particular resource key does not.

### Application computation and worker

**`src/app/simulationSetup.ts` — simplify, retaining the existing coordinate pipeline.**

Keep:

- `SimulationBar { frame, stock, clamps, origin }`
- `buildSimulationBar`
- `aroundSimulationFrame`
- `unrolledSimulationProject`
- `buildSimulationSetupInput`
- setup selection/membership functions

Simplify:

- `SimulationSetupInput.squareBar` and `squareBarFor` to initialization metadata.
- Remove dependency on `squareReplay.validateSquareBar`; validate through the initialization helper instead.
- Keep square axis/frame validation and refusal rather than silently drawing an unrelated flat fallback. This protects input correctness, not the exact material model.

Do not change unwrapping, folding, setup-local paths, real stock, fixtures or origin.

**`src/app/simulationCompute.ts` — keep the shared computation; remove square-job machinery.**

Keep:

- `simulationBuildOptions`
- `SimulationResultInput`
- `computeSimulationResult`
- `buildPriorReplayItems`
- `priorReplayGrid`

Simplify:

- `simulationBuildOptions`: pass wrap and square initialization data.
- `emptySimulationStats`: use the optional initial baseline, without testing for a runtime square model.

Remove:

- `SquareSimulationJob`
- `SquareSimulationDeliverable`, including worker-produced `startingStock`
- `runSquareSimulationJob`
- comments describing square replay as a separate expensive worker computation

Keeping this pure module avoids unnecessary movement and preserves existing consumers, including `plasmaTool.test.ts`.

**`src/app/useSimulationModel.ts` — restore one synchronous simulation path.**

Remove:

- worker/client imports and square-job types;
- `squareJob`, `squareDelivered`, `squareFailure`, `squareDelivery`, `squareError`;
- square-job execution/cancellation effect;
- square-result selection in `simulationResult`;
- square-job contribution to `simulationInputPending`;
- worker-error throwing;
- `squareStartingStock` and worker-backed `getBaseGrid`.

Keep:

- asynchronous **toolpath acquisition** and its cancellation/stale-input protection;
- setup resolution;
- synchronous `computeSimulationResult` memo for every stock shape;
- `lazyOnce(() => priorReplayGrid(...))` for every playback base;
- tool-policy checks, units/feed/tool dimensions, setup picker and returned bar/stock/clamps.

Removing the simulation worker must not accidentally remove the separate toolpath-generation service or its pending state.

**Remove the complete `src/app/simulationWorker/` folder:**

- `squareSimulation.worker.ts`
  - `SquareSimulationWorkerRequest`, `SquareSimulationWorkerResponse`, `SquareSimulationWorkerScope`
  - `handleSquareSimulationMessage`, `squareSimulationTransfer`, worker message registration
- `squareSimulationClient.ts`
  - `SquareSimulationCancelledError`
  - `SquareSimulationWorkerLike`, `SquareSimulationWorkerFactory`, `SquareSimulationOptions`
  - `createDefaultSquareSimulationWorker`, `startWorker`, `runSquareSimulation`
  - settlement, termination, abort/error/message handling and fallback
- `squareSimulationClient.test.ts`
- `INDEX.md`

### Viewport and DEV evidence tooling

**[`SimulationViewport.tsx`](/Users/frankp/Projects/worktrees/purecutcnc/rotary-c2-combined-review/src/components/simulation/SimulationViewport.tsx:846) — simplify to the shared heightfield resource lifecycle.**

Remove the exact-resource imports and state:

- `SquarePreviewSurface`/factory imports.
- `squareStaticRef`, `squarePlaybackRef`.
- `squareStaticGridRef`, `squarePlaybackGridRef`.
- `squareResourceBounds`.
- `releaseSquareSurface` and its calls.

Remove or replace these square branches:

- static material construction before heightfield allocation;
- playback material construction instead of heightfield allocation;
- dirty-chunk update before the texture branch in `flushPlaybackGridToGpu`;
- exact-resource bounds in `zoomToModel`, initial framing and project-change framing;
- square-resource cleanup on disable, replacement, deferred-build cancellation and unmount;
- `data-simulation-square` derived from `grid.squareBar`.

Use the existing surface, boundary, texture, upload and disposal path for both bar shapes. Keep playback controls, turn group, tool pose/readout, fixture rendering, origins, pending overlay and WebGL handling.

**`src/components/simulation/aroundView.ts` — keep.**

- Keep `aroundFrameKey(frame, stock)`’s shape/thickness contribution. Round and square can share frame numbers while requiring different initial heights; conversion must invalidate material resources.
- Keep `sameAroundFrame`, `createBarTurnGroup`, `turnSimulationBar`, `simulationToolPoint`, `simulationBarAngle`, `barReadout`, `BarReadout`.
- Update comments that imply different renderer implementations.

**`src/components/simulation/simulationObserver.ts` — replace exact-resource observation with minimal shared-heightfield observation if retaining mounted playback coverage.**

Its current implementation is entirely coupled to exact-square resources. Remove all exact types/fields:

- `SquareResourceBounds`, `SquareMeshStats`, `SquareGridSummary`, `SquareResourceSummary`.
- `MaterialInterval`, `SquareCellWitness`, `SimulationGeometryWitness`, `SimulationWitnessRequest`.
- Interval-map counts, `baseMaterialCells`/`liveMaterialCells`, gap widths, ray intersections, chunk statistics and position-buffer digests.
- Square-resource references in `SimulationObserverAccess`, lifecycle weak maps, runtime and provider types.

Remove the exact witness machinery:

- `summarizeResource`, `summarizeGrid`, `summarizeController` in their current forms.
- `countTriangles`, `boundsOf`, `describeCell`, `clampIndex`.
- `findWidestGapCell`, `findMaterialCell`, `widestGap`, `pairsOf`, `intervalsAgree`.
- `rayIntervals`, `rayTriangle`, `geometryDigest`.

Provider registration/unregistration and snapshot APIs may be **simplified and retained**, but must observe the common mounted heightfield/texture/controller. There should be no square-only observer branch.

Correspondingly simplify/remove the viewport’s:

- `devObserverRef`, `devRuntimeRef`;
- `devObserverLifecycle`, `devPushLifecycleEvent`;
- `devNoteCreated`, `devNoteDisposed`;
- exact-resource observer registration and teardown bookkeeping.

**`src/main.tsx` — simplify the simulation-specific test seams only.**

- Remove exact witness imports and ambient signatures.
- Replace/remove `__pcTest.getSimulationWitness`.
- Retain `getSimulationObserver` only with a common-heightfield snapshot contract if needed by the rewritten e2e.
- Keep the rest of `__pcTest` unchanged.

Static `data-simulation-*` statistics alone still cannot prove which playback texture is mounted or whether reset/upload/disposal occurred.

## 2. Round heightfield pipeline and injection points

The current common route is:

1. `buildSimulationSetupInput` resolves the Around frame.
2. `unrolledProject` supplies a rectangular sheet one circumference across, with thickness `frame.radius`.
3. `unwrapPoint` subtracts **exactly one pivot radius** from machine Z and converts A into across-sheet distance.
4. `foldToolpath` folds across coordinates at circumference seams while retaining program angles.
5. `simulationBuildOptions` supplies periodic wrapping.
6. `createSimulationGrid` normally fills `topZ` uniformly with `stockTopZ`.
7. `applyMoveToGrid` invokes the common cutter kernel and periodic cutter copies.
8. `PlaybackController` clones that grid, incrementally applies moves, and reports dirty regions.
9. `SimulationViewport` builds `createHeightfieldTexture`, `createHeightfieldMaterial`, surface strips and `createInstancedBoundaryGroup`.
10. Playback uploads changed rectangles through `uploadHeightfieldRegion`, falling back to `updateHeightfieldTexture`.

**The material injection belongs in `createSimulationGrid`, replacing the uniform fill for square initialization only.** The existing `seedSquareTopZ` already supplies it.

It must reach all four grid-producing situations:

- empty/no-selected-result grid;
- selected-operation simulation;
- visible-operation replay;
- prior-operation playback base grid.

Keeping `simulationBuildOptions` as their common option builder prevents disagreement.

### Uniform-radius assumptions

- **Cut kernel:** no uniform initial-radius dependency. It reads each current cell independently.
- **`stockTopZ`:** currently means the uniform start for round/flat, but already means the square corner envelope for square grids. Keep these roles distinct from the pivot and per-cell baseline.
- **Removed-cell counting:** uniform comparison is wrong for square starts; it would classify virgin lower-radius cells as removed.
- **`stats.minTopZ`:** must be the actual minimum current radius. Empty results need the baseline minimum.
- **`stats.maxRemovedDepth`:** must use each cell’s baseline. `cornerMaximum - minTopZ` invents removal on virgin stock.
- **Shader storage:** `topZ` is stored directly in a floating-point RED texture. There is no radius normalization or clipping to the nominal round radius.
- **Shader wrapping:** `aroundWrap` uses sampled height as radius and adds `frame.radius` as pivot height. It supports heights above `frame.radius`.
- **Shading:** `depthDarken(height, stockTopZ)` uses a uniform reference maximum. Consequently, virgin square flats can shade darker than corners. It is depth shading, not a reliable removed-cell classifier. Keeping the existing common shader preserves the requested shared path; per-cell virgin-colour correction would be an additional shared-renderer feature.
- **Bounds:** `gpuMesh.createStockPlaneGeometry` and `instancedBoundary.createInstancedBoundaryGroup` call `aroundBounds(grid, frame)` with its default nominal radius. Both must supply the square-capable radial envelope through shared metadata, for example `grid.stockTopZ`.
- **Framing:** static, playback, zoom and project-reset framing must use those corrected shared bounds after the exact-resource branches disappear.
- **Cache keys:** keep shape/size invalidation, project-input identity, detail and topology dependencies. Remove interval-resource keys, not conversion invalidation.
- **Grid extent:** the common path rounds cell counts up. Across coordinates are shader-clamped to one circumference; axial geometry retains the round path’s grid extent. The old exact mesh instead clipped to physical axial ends. Removing it therefore also removes that stronger exact-endcap guarantee. Untouched end **cells** can retain square radii without reproducing those exact axial mesh boundaries.

The shader surface is a sampled radial heightfield, so its silhouette remains discretized. It will not recreate the analytic-flat/conforming geometry guarantees of the discarded mesh.

## 3. Cutting correctness and travel above the nominal radius

The common kernel computes a tool surface per cell, clamps only against `stockBottomZ`, and writes only when:

```text
max(toolSurface, stockBottomZ) < currentCellHeight - tolerance
```

It therefore:

- lowers taller corner cells even when they stand above nominal `stockTopZ`;
- never raises shorter cells to meet a higher tool;
- preserves untouched cells;
- works with variable initial heights for flat, ball and V profiles;
- requires no square-specific tool dispatch.

Its distance metric remains the round bar’s unrolled-sheet approximation. It does **not** preserve exact rotating cutter-body contact, disconnected radial material, surviving outer lips or the exact square oracle. Those losses follow directly from the selected model.

The common kernel uses unwrapped/folded XY coordinates. It does not reproduce the old square kernel’s special interpretation of explicit A independently of across coordinates.

For travel:

- The production generator already accounts for square corners.
- `rotaryTravelZ` uses:
  ```text
  barPivotZ(stock) + barMaxRadius(stock) + 1 mm in project units
  ```
- Rough and finish use that travel height; opening/final safe height is at least that high.
- `rotaryOperation` also avoids treating a saved low rapid radius as sufficient square clearance.

Keep all of that unchanged.

If a malformed or externally supplied rapid lies below a standing corner, the common simulator will **not cut or diagnose that rapid**: `moveIsMaterialRemoving` excludes rapids. A feed-classified link can lower cells it crosses. Production guards remain responsible for rejecting unsafe motion; the simplified simulator must not be presented as a replacement safety validator.

## 4. Non-simulation square 3D preview

The Around 3D blank preview does **not** depend on the exact simulation model.

- `csg.buildStockMesh`: round stock uses cylinder geometry; square stock uses the ordinary extruded rectangular profile.
- `csg.buildStockWireframe`: square stock likewise uses extrusion edges.
- Imported/generated target solids use the existing model/CSG pipeline.
- `viewport3d/toolpathOverlay.ts` uses `stockSpaceToolpath`/`stockSpaceMoves` and the frozen rotary transforms to display generated motion.
- Square chuck/tailstock rendering remains cylindrical about the true pivot.
- `buildAroundModelSolid`’s round Around-feature Boolean path is separate from square simulation.

Keep `csg.ts`, `Viewport3D.tsx`, toolpath overlays, square stock geometry, rotary solids, workholding and their tests unchanged.

## 5. Test inventory

### Delete tests of discarded algorithms/resources

Delete these complete suites, including their local fixtures, helper functions, test-only types and recorded expectations:

- **`squareMaterialConvergence.test.ts`**
  - `testCodexTwoCutCase`
  - `testOneCutCase`
  - `testSeededSweepDigest`

- **`squareMaterialWindow.test.ts`**
  - `testWindowMatchesFullLoop`
  - `testBoundIsNecessary`
  - `testFixtureCellCountDrop`
  - `testLargeProgramAnglePrecision`
  - `testLargeOriginTinyCells`
  - `testHugeFiniteProgramAngle`
  - `testHugeFiniteProgramAngleInChild`
  - `testExtremePrecisionSweep`

  These protect an optimization/solver that will no longer exist.

- **`squareMaterialGeometry.test.ts`**
  - virgin analytic square boundary;
  - interior-gap floor/ceiling/no-bridge;
  - generated A0 gap;
  - axial/angular difference faces;
  - both axes/off-origin geometry;
  - winding/volume;
  - seam/endcap/untouched-end geometry;
  - single seam-interface emission;
  - manifold closure;
  - kernel-generated groove;
  - triangular blank-crossing caps;
  - conforming crossings/corners;
  - stepped-wedge conformance;
  - multi-chunk Y conformance.

- **`squareMaterialMesh.test.ts`**
  - `testResourceStructure`
  - `testNullUpdateIsNoOp`
  - `testDirtyRegionRebuildsTouchedChunksOnly`
  - `testAngularNeighbourGeometryDependency`
  - `testSeamAndNeighbourRebuild`
  - `testFullRebuildPaths`
  - `testEmptyChunkAndBounds`
  - `testDisposeIsIdempotentAndExact`
  - `testResetRestoresVirginGeometry`
  - `testInvalidInputRefuses`

- **`squarePreview.test.ts`**, as an exact-resource suite.
  - Delete exact mesh/endcap/resource/disposal expectations.
  - Move shape/size invalidation coverage to the shared key/viewport tests.
  - Move corner-envelope coverage to shared GPU bounds tests.
  - Do not silently preserve its exact physical-end guarantee as a claimed property of the round renderer.

- **`simulationWorker/squareSimulationClient.test.ts`**
  - worker parity;
  - abort termination;
  - worker error/crash handling;
  - fallback;
  - round/flat synchronous routing;
  - superseded-job rejection.

  Replace its useful *synchronous-routing* protection in the shared hook tests; do not retain worker lifecycle tests after deleting the worker.

### Rewrite square replay tests around shared-heightfield behavior

**`squareReplay.test.ts` should be replaced or substantially rewritten, not retained as an exact-model oracle.**

Delete these exact-behavior expectations:

- `testJustTouchRemovesNothing`
- `testNaiveUnrolledKernelWouldHaveFailed` — it deliberately rejects the model Frank has now selected.
- `testOracleParityFlatCuts`, `testOracleParityBallCuts`
- `testPivotIsTheTrueTurningAxis`’s physical cutter-plane oracle
- `testUnsupportedAndInvalidInputsRefuse`’s square-kernel support regime
- `testMeasuredDefectsReproduce`
- `testActualGeneratedRoughInteriorGap`
- `testNarrowConstantAngleContactWindows`
- `testTrueObliqueTangentRemovesNothing`
- `testManagerBallPhysicalProbe`
- `testChangingAngleRefusedAtomically`
- `testSquareStatsCountInteriorRemoval`

Retain the **intent**, rewritten through `applyMoveToGrid`/shared replay, of:

- `testHighAngleMovingLinkRemovesNothing`
- `testUntouchedEndsKeepTheSquareSection`
- `testSeamAndMultiTurnIdentity`
- `testPlaybackMatchesBatchReplay`
- `testPlaybackPreservesDescriptorAndBaseline` — baseline survives; runtime descriptor no longer required.
- `testActualGeneratedFinishReplays`

Add explicit shared-kernel assertions for monotonic lowering, higher-tool no-op, cutting above the inscribed radius, baseline statistics and changing-angle moves following normal round behavior.

### Keep and adapt initialization/app coverage

**`squareGrid.test.ts` — keep, adapt interfaces.**

Keep all six intents:

- `testSeedMatchesSquareCrossSection`
- `testTopZMutationLeavesBaselineImmutable`
- `testRenderEnvelopeHoldsCornersButPivotStaysNominal`
- `testVirginSquareStatsAreZero`
- `testOldGridsKeepExactKeysAndValues`
- `testDescriptorValidation`, renamed/adapted to initialization validation

**`src/app/squareSimulation.test.ts` — rewrite, retaining its real production fixture.**

- `testSetupInputDescriptor`: assert initialization metadata, not alternate-model routing.
- `testEveryEntryPoint`: all four modes receive the same square initialization.
- `testActualGeneratedBand`: retain corner removal and unchanged square end cells; remove interval-only-gap assertions.
- `testPlaybackParity`: compare `topZ`, prior-stock base, reset and seeks; remove interval-map comparisons.
- `testAxesUnitsOffOrigin`: retain.
- Remove worker-await assumptions and test headers/mutation notes tied to the old model.
- Add synchronous square result/base-grid coverage with no simulation-worker construction.

**`src/test/squareSimulationFixture.ts` — keep and simplify.**

Keep `squareRotaryProject`, `generated`, `inputFor`, `resultArgs`, `SIDE`, `LENGTH`, `DETAIL`. Its actual production dispatch and valid default chuck are useful. Update exact-kernel/worker documentation and any changed input types.

**`src/plasmaTool.test.ts` — keep.**

It contains simulation policy-boundary tests that explicitly transpile/import `simulationCompute.ts`. Keeping that module avoids unnecessary harness changes. If computation is moved anyway, update those imports/mocks without weakening incompatible-tool refusal coverage.

### E2E disposition

**`e2e/rotaryModel.smoke.spec.ts` — keep the file and existing CI lane.**

Keep existing:

- rotary operation/generation checks;
- round-to-square and side-resize overlay cache tests;
- populated-Around axis-mismatch test;
- “square to round generates inside the band and removes material”;
- non-simulation low-angle/end-view checks and screenshots.

Rewrite:

> `square playback mounts the prior rough material, follows the finish and disposes on replacement`

Keep its behavioral sequence: prior rough at progress zero, finish advancement, end seek, reset, back-seek, resize/undo, resource replacement and playback teardown.

Remove/replace its exact-model support:

- `WitnessCell`, `ExpectedSquareState` interval fields and material-map signatures;
- interval portions of `GridShape`/expected state;
- `expectedSquareState`’s `squareMaterialIntervals` import, gap-cell search and interval hashing;
- `observerWitness`’s triangle/radial-interval contract;
- `expectMaterialMatches`;
- gap-width, disconnected-material, chunk-count, triangle-count and mesh-position-digest assertions.

Keep/adapt `squarePlaybackProject`, `seedSquarePlaybackProject`, `observerSnapshot`, `setPlaybackProgress` and useful grid-shape fields.

The replacement should examine the **common mounted heightfield/texture and controller**, not only static result props. Any GPU-upload claim needs upload/render evidence; reading the CPU array alone does not prove the GPU received it.

`rotaryModel.smoke.spec.ts` already belongs to `test:e2e:workflow-ui`; rewriting it requires no new lane.

### Tests that must remain unchanged in purpose

Preserve the round simulation contracts:

- `replay.test.ts`: reference cutter parity, exact pre-change wrapped seam behavior and absence of square keys on round grids.
- `playback.test.ts`: clone keys, wrapped round batch/playback parity, feeds, seeks and dirty regions.
- `aroundReplay.test.ts`.
- Round portions of `aroundWrap.test.ts`; adapt its square initialization fixture and extend it to exercise actual GPU builder bounds.
- `gpuMesh.test.ts`, `instancedBoundary.test.ts`, `heightfieldShader.test.ts`, `tabbedEdgeSimulation.test.ts`.
- `aroundView.test.ts`.
- `src/app/aroundSimulation.test.ts`, setup/model/hook simulation tests.
- Existing shared viewport/setup/WebGL e2e.

Preserve **round machine-output byte identity**, especially:

- `src/engine/gcode/squareRotaryOutput.test.ts`’s `ROUND_BASELINE` matrix and unchanged-square-output fingerprints.
- `squareRotaryProgramSafety.test.ts`, including round refusal precedence and no square unwind behavior on round stock.
- `rotaryOutput.test.ts`, `aroundExport.test.ts`, `rotaryDefinition.test.ts`.
- `rotaryOperation.test.ts`, `rotaryModel.test.ts`.

Keep all square generation/output, stock format/actions, UI policy, workholding, rotary-solid and preview tests. “Square” in a filename does not make it exact-simulation-only.

## 6. Proposed slices with exclusive file ownership

These are ownership boundaries, not permission to leave intermediate dangling imports. Freeze the initialization contract first and integrate dependencies in order.

**Slice A — state, initialization, common replay/playback**

Own:

- simulation `types.ts`, `grid.ts`, `replay.ts`, `playback.ts`;
- deletion of `squareMaterial.ts`, `squareReplay.ts`;
- `squareGrid.test.ts`, replacement `squareReplay.test.ts`;
- `replay.test.ts`, `playback.test.ts`;
- deletion of convergence/window suites.

Risk: baseline statistics, accidental round key/value drift, preserving reset to prior stock, initialization helper relocation.

**Slice B — shared GPU rendering and exact mesh removal**

Own:

- `aroundWrap.ts`, `gpuMesh.ts`, `instancedBoundary.ts`, `heightfieldShader.ts`;
- their corresponding tests;
- deletion of `squareMaterialGeometry.ts`/`.test.ts`;
- deletion of `squareMaterialMesh.ts`/`.test.ts`.

Risk: nominal-radius bounds clipping corners, incorrect pivot expansion, flat/round shader drift, confusing depth shading with removal. Existing shader arithmetic should remain unchanged unless a demonstrated shared-path requirement demands otherwise.

**Slice C — synchronous application computation**

Own:

- `simulationSetup.ts`, `simulationCompute.ts`, `useSimulationModel.ts`;
- their existing app/setup/model tests;
- `squareSimulation.test.ts`;
- `src/test/squareSimulationFixture.ts`;
- `src/plasmaTool.test.ts`;
- deletion of the complete `simulationWorker/` folder.

Risk: removing path-acquisition cancellation with the simulation worker, missing one grid entry point, losing lazy prior replay, stale-input or tool-policy regression.

**Slice D — viewport, shared evidence seam and browser specification**

Own:

- `SimulationViewport.tsx`;
- `aroundView.ts`, `aroundView.test.ts`;
- deletion of `squarePreview.ts`, `squarePreview.test.ts`;
- simplification/replacement of `simulationObserver.ts`;
- `src/main.tsx`;
- `e2e/rotaryModel.smoke.spec.ts`.

Risk: resource leaks/double disposal, missing dirty uploads, incorrect replacement on shape conversion, camera/framing regressions, e2e assertions that still demand intervals or only inspect static props.

**Slice E — documentation reconciliation**

Own only:

- `src/engine/simulation/INDEX.md`
- `src/app/INDEX.md`
- `src/components/INDEX.md`
- `src/test/INDEX.md`
- `planning/SIMULATION_GPU_HEIGHTFIELD_DESIGN.md`

Remove exact-model/worker descriptions and document square initialization through the shared path. Historical handoffs should remain historical; active issue planning should record Frank’s replacement decision. No generator, postprocessor, stock-format or UI expansion belongs in these slices.

## Checks run and limits

Passed:

- `node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
- `node --import tsx src/engine/simulation/replay.test.ts`
- `node --import tsx src/engine/simulation/playback.test.ts`
- `node --import tsx src/engine/simulation/aroundReplay.test.ts`
- `node --import tsx src/engine/simulation/aroundWrap.test.ts`

In-memory probes also passed:

- Variable-radius cells lower monotonically for flat/ball/V tools, including above nominal stock top; higher passes never raise cells; rapids are excluded.
- Playback/reset preserves variable initial heights.
- Confirmed the current GPU builder’s nominal-radius bounds exclude taller radial cells.
- Real production square rough paths routed through the common kernel **in memory**, on both axes:
  - X: 2,393 moves; 1,684 changed cells.
  - Y: 2,379 moves; 1,702 changed cells.
  - Each retained 240 sampled end cells unchanged.
  - Batch versus subdivided playback maximum height difference was **zero**; reset matched the base exactly.

Those probes establish feasibility, not a completed app change or universal physical cutter accuracy. No browser, full build, test pool, G-code baseline suite or mutation test was run. No `.env.agent` or legacy credentials were read. No files were edited, staged or committed.

**COMMIT: none.**

