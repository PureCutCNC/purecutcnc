# STL Import and 3D Surface Operations Review

## Scope

Reviewed the current STL import path and the new 3D rough/finish operations:

- `src/import/stl.ts`
- `src/components/project/ImportGeometryDialog.tsx`
- `src/components/canvas/SketchCanvas.tsx`
- `src/engine/csg.ts`
- `src/engine/toolpaths/roughSurface.ts`
- `src/engine/toolpaths/finishSurface.ts`
- operation targeting in `src/store/projectStore.ts` and `src/components/cam/CAMPanel.tsx`

The current result is visually useful, but several parts of the geometry pipeline are still prototype-grade. The main risks are incorrect STL bounds/profiles for axis-swapped imports, fragile mesh slicing, rough/finish target mismatches, and repeated expensive STL parsing/slicing.

## Findings

### 1. Axis swap is applied after STL Z bounds are computed

`extractStlProfileAndBounds()` computes `z_bottom` and `z_top` before applying `axisSwap`. For Y-up or X/Z swapped models, the imported feature can get the wrong Z range even though the projected footprint and mesh transform use the swapped coordinates later.

Impact:

- Imported STL height can be wrong.
- Rough/finish step levels can be wrong because they depend on feature Z bounds after import.
- User may see correct-looking footprint but incorrect model thickness.

Fix:

- Apply axis swap before computing the bounding box in `extractStlProfileAndBounds()`.
- Use one shared STL parse/axis-swap helper so import, top-view rendering, preview, and toolpaths cannot drift.

### 2. STL import parses and decodes the same file multiple times

Current import flow decodes/parses the STL once for profile extraction and again for top-view rendering. Later, 3D preview, CSG, rough surface, and finish surface each decode and parse from `feature.stl.fileData` again.

Impact:

- Large STL imports spend avoidable time in base64 decode and `STLLoader.parse()`.
- Toolpath recalculation repeats the same transform work.
- Memory spikes because base64 strings, binary strings, typed arrays, Three geometry, and generated PNG data URLs coexist.

Fix:

- Add a shared STL mesh cache keyed by `{ fileData identity/hash, axisSwap }`.
- Cache parsed indexed geometry in model units before feature placement.
- Cache transformed geometry keyed by feature id plus transform inputs: `scale`, `axisSwap`, `origin`, `orientationAngle`, `z_top`, `z_bottom`.
- Keep cache out of serialized project state.

### 3. Fallback silhouette projection can drop valid triangles

The non-manifold fallback in `extractStlProfileAndBounds()` projects triangles to XY and skips projected triangles whose 2D winding is clockwise. STL triangle winding is not reliable across arbitrary files, and projected winding can change with axis swaps and view direction.

Impact:

- Silhouette can be incomplete for non-manifold or inconsistently wound STLs.
- Some models may import as outline fragments or missing lobes.
- The roughing outer boundary inherits that bad silhouette.

Fix:

- Union all non-degenerate projected triangles regardless of winding.
- If performance becomes a problem, cull by triangle projected area/bounds, not by winding.
- Add a simple cube, mirrored cube, and intentionally mixed-winding STL test.

### 4. Import stores only one outer polygon and loses holes/islands

`extractStlProfileAndBounds()` selects the largest polygon from the projected result and converts only that polygon into the STL feature profile.

Impact:

- Models with top-view holes or multiple disconnected islands are reduced to a single outer shape.
- Rough surface uses the feature profile as the outer machining boundary, so missing holes/islands can become incorrect cut regions.
- The sketch feature cannot currently represent a compound STL silhouette.

Fix:

- Introduce an STL silhouette data shape separate from `SketchProfile`, e.g. `stl.silhouettePaths`.
- Store all projected paths with explicit outer/hole classification.
- Keep `sketch.profile` as a primary selection/profile fallback for now, but update roughing and drawing to use the full STL silhouette when available.

### 5. First implementation of the slicer is fragile on real meshes

`roughSurface.ts` and `finishSurface.ts` each duplicate a slicer that:

- scans every triangle for every Z level,
- hashes points with `toFixed(6)`,
- greedily walks the first available neighbor,
- treats branching/non-manifold graph cases poorly,
- ignores coplanar triangles on the slice plane,
- can emit duplicate or degenerate segments near vertices.

Impact:

- Slice contours can be broken, self-crossing, or incomplete.
- Roughing may cut into model islands or fail to create expected pockets.
- Finish paths may skip contours on noisy/non-manifold STLs.
- The same bug exists twice because the slicer is duplicated.

Fix:

- Move STL slicing into one shared module, e.g. `src/engine/mesh/slicing.ts`.
- Replace greedy node walking with edge-visited contour assembly.
- Deduplicate segment endpoints with an explicit quantization grid and preserve original coordinates.
- Add cleanup: remove zero-length segments, merge collinear edges, reject tiny contours.
- Add tests for sphere/cube/saddle/multiple-island slices.

### 6. Rough surface assumes the first target feature is the STL model

`generateRoughSurfaceToolpath()` uses `target.featureIds[0]` as the model. UI/store targeting allows selected features containing a model, and rough surface hints only require at least one STL model.

Impact:

- Selecting a region first and then a model can create an operation that fails with “Model feature must be an imported STL model”.
- Rough surface currently ignores selected region features even though default targeting can include them.

Fix:

- Match finish surface behavior: find `targetFeatures.find(f => f.operation === 'model' && f.kind === 'stl')`.
- Collect region features with `operation === 'region'`.
- Decide rough semantics:
  - no region: use STL silhouette offset as current behavior;
  - one or more regions: clip the roughing area to region boundaries.

### 7. Rough surface outer boundary and path classification need more robust polygon handling

Roughing offsets the STL silhouette and then picks the “largest” path by signed area. Depending on Clipper output winding, signed area may not reliably identify the intended outer path. It also discards holes and secondary islands.

Impact:

- Wrong outer boundary can be selected.
- Multi-island models can rough only one island.
- Holes in the model footprint are not respected.

Fix:

- Use absolute area for primary path selection if a single path is still required.
- Prefer full PolyTree handling so outers and holes remain classified.
- Use the full STL silhouette data from Finding 4 once available.

### 7a. Rough surface can cut away model material under overhangs

The first rough implementation used only the model slice at the current Z as the protected island. For inverted tapers, overhangs, or any model where upper Z levels occupy XY space that lower Z levels do not, lower roughing levels could cut inside the upper model footprint and destroy material that should remain.

Impact:

- Inverted cone/frustum shapes can be hollowed out or destroyed by roughing.
- Any top-visible overhang is unsafe because the operation treats lower, smaller slices as free machining space.
- This is especially risky because the generated path can look plausible level-by-level.

Fix:

- For each roughing Z level, protect the union of the current slice and all higher slices.
- Sample just below the model top so coplanar top faces still contribute to the protected shadow.
- Keep this conservative until a true 3-axis reachability/visibility model exists.

### 8. Finish surface is not yet true surface-following finishing

Current finish surface slices the mesh at Z levels, intersects those closed contours with XY scanlines, sorts all resulting points by scanline X, then connects them as 3D open moves. This produces waterline-contour intersection points, not a continuous top-surface raster sampled from the actual surface.

Impact:

- Toolpaths may connect points from unrelated Z levels/contours on the same scanline.
- Moves can jump through the model or through air while marked as cuts.
- It is closer to a hybrid contour/waterline experiment than a reliable 3D raster finish.
- Gouge protection raises points using a top-height map, but the base path points are still not sampled from the top surface.

Fix:

- Define two distinct operations/strategies:
  - `finish_surface_parallel`: raster over XY, sample top surface Z at regular spacing, then apply ball-end gouge protection.
  - `finish_surface_waterline`: slice by Z and follow contours at each level for steep walls.
- For the current “parallel” UI, switch to height-field sampling:
  - build a top-surface height map or triangle spatial index,
  - generate scanline intervals from silhouette/regions,
  - sample XY points at a max chord length,
  - query Z directly from intersected triangles,
  - emit ordered 3D cut moves along each scanline.

### 9. Height map gouge protection needs bounds and resolution controls

`finishSurface.ts` builds a height map with `cellSize = tool.radius / 3` across the entire model XY bounds.

Impact:

- Small tools over large models can create huge grids and freeze the UI.
- A topmost-height map cannot support undercuts, vertical walls, or overhang-aware finishing.
- There is no warning when the height map is too coarse or too large.

Fix:

- Add a max cell count and warn/refuse above it.
- Make cell size configurable or derived from operation tolerance.
- Build the height map only over selected regions when regions are present.
- For long term, replace or augment height-map lookups with triangle spatial queries.

### 10. Toolpath generation is synchronous and can block the UI

Import fallback yields between Clipper batches, but rough and finish generation do not yield. Rough scans all triangles per stepdown level, and finish may slice all levels repeatedly per region.

Impact:

- Large STLs can freeze the app during toolpath preview.
- User cannot cancel long toolpath generation.

Fix:

- Add cancellation/progress hooks to rough/finish generation.
- Move heavy mesh/toolpath computation to a worker if the architecture allows.
- Cache slice results per `{ mesh transform, z }` so multiple operations and redraws reuse them.

### 11. Non-uniform resize can desynchronize STL display, toolpaths, and mesh geometry

`resizeFeatureFromReference()` can non-uniformly transform the sketch profile, but STL data currently has a single scalar `stl.scale`. The top-view image will visually stretch with the profile, while `loadSTLTransformedGeometry()` still applies uniform mesh scale.

Impact:

- The sketch image/profile can diverge from the actual 3D mesh used for preview and toolpaths.
- Rough/finish may cut a different model than what the 2D sketch suggests.

Fix:

- Either block non-uniform resize for STL model features, or store full STL transform data (`scaleX`, `scaleY`, `scaleZ` or a 2D affine transform plus Z scale).
- Prefer blocking non-uniform resize initially unless there is a clear CNC use case for non-uniform STL distortion.

Status:

- Implemented the conservative path: STL model resize now applies a uniform scale factor to the stored silhouette profile, `stl.scale`, and the numeric Z span anchored at `z_bottom`.
- Regular sketch feature resize still supports the existing axis/non-uniform behavior.
- Added `src/store/projectStoreTransform.test.ts` to cover both cases.

### 12. Project serialization can become very large

STL `fileData` and `topViewDataUrl` are stored directly on the feature.

Impact:

- Project files can balloon quickly.
- Autosave/local persistence can slow down.
- History snapshots duplicate large strings.

Fix:

- Short term: avoid storing `silhouetteDataUrl` if `topViewDataUrl` supersedes it.
- Medium term: store generated preview images in a non-history cache and regenerate when missing.
- Long term: use asset references/blobs for STL files instead of embedding base64 in every project/history snapshot.

### 13. 3D surface operations do not honor tabs yet

The 2.5D edge/pocket pipeline has tab handling, but rough and finish surface operations currently ignore project tabs.

Impact:

- Users can place tabs and still have 3D rough/finish paths cut through them.
- This is especially surprising when an STL model is combined with an outside edge route that does honor tabs.
- The generated preview does not clearly communicate that tabs are unsupported for the 3D operations.

Fix:

- Add tab clipping/avoidance to rough and finish surface operations, or explicitly disable/show a warning for tabs while 3D operations are selected.
- Reuse the existing tab footprint/Z-range logic where possible, but adapt it to mesh-derived 3D paths rather than 2.5D closed contours.
- Add regression tests with tabs overlapping a 3D surface toolpath.

## Suggested Implementation Plan

### Phase 1: Correctness fixes with low blast radius

Status: implemented locally and checkpointed during STL import work. No push yet.

Done:

1. Applied axis swap before bounding-box/Z range calculation in `extractStlProfileAndBounds()`.
2. Updated rough surface target lookup to find the STL model anywhere in `target.featureIds`.
3. Stopped skipping clockwise projected triangles in the non-manifold silhouette fallback; projected triangle winding is normalized instead.
4. Changed rough `largestPolygon()` selection to absolute area until full PolyTree support lands.
5. Added `src/import/stl.test.ts` to verify axis-oriented STL bounds and profile creation using an in-memory frustum STL.
6. Added `src/engine/toolpaths/roughSurface.test.ts` to exercise the real `generateRoughSurfaceToolpath()` integration path using a synthetic imported STL model, including the `[region, model]` target-order regression.
7. Updated rough surface to protect the cumulative top-down model shadow at each Z level, preventing lower roughing passes from cutting under upper model overhangs. Added an inverted-taper regression test.

Still pending:

1. Add basic fixtures/tests:
   - mixed-winding STL,
   - rough operation target order: `[model, region]` if rough starts honoring region filters.

### Phase 2: Shared mesh pipeline and caching

Status: implemented locally and checkpointed during STL import work. No push yet.

Done:

1. Added a small in-memory LRU cache for transformed STL geometry returned by `loadSTLTransformedGeometry()`.
2. Cache key includes feature id, axis swap, scale, XY origin, orientation, resolved Z range, and STL data length; the cached entry also compares the actual `fileData` string before reuse.
3. This reduces repeated STL base64 decode, `STLLoader.parse()`, merge/indexing, and transform work for rough/finish recalculation when the STL feature transform has not changed.
4. Added an import-local parsed STL mesh cache used by both profile extraction and top-view image rendering, so the import dialog no longer decodes/parses/orients the same STL twice during a single import flow.
5. Added a CSG-local parsed geometry cache shared by `loadSTLTransformedGeometry()`, `buildFeatureMesh()`, and `buildFeatureSolid()`. The cache preserves the previous behavior by keeping separate raw and merged geometry entries and returning clones to callers that mutate geometry for preview.
6. Replaced the import-local and CSG-local parser/cache implementations with a shared `src/engine/importedMesh.ts` module. The module exposes STL-backed imported mesh loading now, but uses format-neutral names/types (`ImportedTriangleMesh`, `ModelAxisOrientation`) so OBJ/PLY/glTF/3DM tessellation can be added behind the same internal mesh contract later.
7. Added `src/engine/importedMesh.test.ts` to cover axis orientation bounds, triangle mesh cache reuse, and cloned buffer geometry cache behavior.
8. Added generic imported-model dispatch entry points (`loadImportedTriangleMesh()` and `loadImportedBufferGeometry()`) with STL as the first implementation.
9. Added optional `stl.format` metadata for new imports and routed CSG through that field, defaulting missing legacy data to STL. `roughSurface.test.ts` covers both explicit and legacy missing-format model data.

Still pending:

1. Create a shared STL mesh module:
   - done for STL parsing, axis orientation, merged/raw geometry caching, triangle mesh extraction, and bounds,
   - support data URL and raw base64 inputs,
   - done for initial parser dispatch by model format.
2. Replace persisted feature data naming from `stl` to a generic `model` shape with project-load backward compatibility.
3. Expand transformed mesh caching if needed after profiling real projects.
4. Stop writing `silhouetteDataUrl` for new STL imports:
   - done; new imports store the rendered `topViewDataUrl` only,
   - removed the unused `renderSilhouetteToDataUrl()` helper,
   - the optional field remains in the type as legacy project-load compatibility.

### Phase 3: Robust silhouette representation

Status: started locally. Multiple projected paths are now preserved, but explicit outer/hole classification is still pending.

Done:

1. Added `stl.silhouettePaths` to imported STL metadata.
2. `extractStlProfileAndBounds()` now returns all projected silhouette paths while still mirroring the largest path into `sketch.profile` for compatibility/selectability.
3. New STL imports persist `silhouettePaths`.
4. STL silhouette paths now follow feature copy, move, rotate, and uniform resize in the main transform paths.
5. Outside edge routing uses all stored model silhouette paths when present, allowing multi-island imported model outlines.
6. Rough surface uses all stored model silhouette paths when building the expanded outer machining boundary.
7. Added regression coverage for import path metadata, STL transform path scaling, and outside edge routing with multiple stored model silhouette paths.
8. Added shared filtering for insignificant silhouette paths so tiny projection artifacts are not stored on new imports and are not treated as model islands/contours by edge-out, rough, or finish coverage.

Still pending:

1. Preserve explicit outer/hole classification instead of storing path lists without topology.
2. Draw the top-view image clipped by all silhouette paths, not only the mesh-rendered top view.
3. Audit less common constraint/align translation paths for `silhouettePaths` parity if those workflows become important for STL models.
4. Replace relative-area artifact filtering with explicit topology once silhouette paths carry outer/hole/island roles.

### Phase 4: Shared robust slicing

Status: implemented locally and checkpointed during STL import work. No push yet.

Done:

1. Moved the duplicated rough/finish mesh slicing implementation into `src/engine/toolpaths/meshSlicing.ts`.
2. Added a precomputed mesh slice index that stores triangle vertices and Z ranges once per operation.
3. Updated rough and finish surface generation to build the slice index once and reuse it for each Z level.
4. This removes duplicated slicer code and avoids re-reading triangle vertices from raw interleaved buffers for every slice.
5. Added per-Z slice result caching on the mesh slice index.
6. Attached the slice index to the cached transformed STL data object, so repeated rough/finish recalculations for an unchanged STL transform can reuse both the triangle index and already-computed Z slices.
7. Added Z-range buckets to the mesh slice index so each slice checks only triangles that overlap the current Z bucket plus a side list of tall/wide triangles.
8. Avoided temporary candidate and per-triangle delta arrays in the hot slice loop.
9. Added focused slicer tests for cube mid-slices, cached slice reuse, and separated island slices.
10. Tried edge-visited contour assembly, but reverted it after rough surface regressed during app testing; the current local code keeps the prior contour chaining behavior.

Still pending:

1. Profile bucket count and wide-triangle thresholds against real imported models; tune if needed.
2. Replace greedy contour chaining only after we have a rough-surface regression fixture from a real model.
3. Add harder test coverage for non-manifold edge cases, coplanar slice-plane triangles, and noisy duplicate vertices.

### Phase 5: Rework finish surface into explicit strategies

Status: not fully reworked yet. Performance and safety passes have been applied locally to the existing finish implementation.

Done:

1. Finish surface now caches raw STL slices once per Z level before region clipping, instead of re-slicing the full STL for each selected region.
2. Finish surface still processes regions region-by-region and retracts between regions, preserving current behavior.
3. Finish surface uses clipped region contour bounds for scanline extents instead of scanning the entire model bbox for each region.
4. Finish surface height-map construction is bounded to selected region bounds plus one tool radius when regions are present, falling back to the full model bbox if the expanded region does not overlap the model.
5. Finish surface pre-rotates contours per scanline pass so contours are not re-rotated inside every scanline loop.
6. Added a maximum height-map cell budget; very large maps are automatically coarsened with a warning instead of allocating an unbounded grid.
7. Finish surface now emits separated visible intervals instead of stitching all Z-slice intersections on a scanline into one cut.
8. Finish surface samples the top height map along accepted intervals, reducing destructive straight-chord cuts through raised details such as external threads.
9. Finish parallel coverage now comes from the model's projected silhouette, clipped by selected regions, instead of from Z-slice contours. This restores coverage on broad lower top surfaces while preserving top-surface Z sampling.
10. Added a finish regression test for a stepped STL model to ensure lower top plateaus are covered.
11. Finish height maps are cached on the transformed STL data object by bbox/cell size, so repeated finish recalculations for an unchanged model can reuse the rasterized top surface.

Still pending:

1. Rename or internally separate current behavior as experimental waterline/contour logic.
2. Improve top-height sampling quality/resolution for detailed models.
3. Preserve explicit hole topology in silhouette/region coverage.
4. Apply more complete gouge protection after Z sampling.
5. Consider exposing the height-map tolerance/cell size in advanced operation settings.
6. Consider adding a separate waterline finish operation later for steep walls.

### Phase 6: Responsiveness and storage

1. Add progress/cancellation to rough and finish generation.
2. Move heavy STL toolpath work to a worker if feasible.
3. Introduce generated-asset caches outside project history.
4. Audit history snapshots for large embedded STL/top-view strings.
5. Add tab support or explicit tab-unsupported warnings for 3D rough/finish operations.

## Recommended First PR

The first PR should stay small and correctness-focused.

Implemented locally:

1. Fix axis-swap Z bounds.
2. Fix rough model target lookup.
3. Stop winding-based triangle dropping in fallback silhouette generation.
4. Use absolute area in rough outer-boundary fallback.

Remaining before PR is ready:

1. Add targeted tests/scripts for those cases.
2. User test the current local changes in the app.
3. Continue user testing against real imported models.

This reduces the chance of obviously wrong imports/toolpaths before investing in the larger shared mesh and true finishing rewrites.
