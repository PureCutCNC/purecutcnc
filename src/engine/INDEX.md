# INDEX — src/engine/

Pure-logic CAM core. No React, no DOM. Everything here is testable in isolation. New features here **must** have unit tests.

## Top-level files
- `clipperOpenPaths.ts` — typed seam for clipper-lib's open-path API (`addOpenSubject`, `openPathsFromPolyTree`); confines the casts the local clipper-lib typings force
- `clipperOpenPaths.test.ts` — tests for the above
- `csg.ts` — manifold-3d CSG wrappers, STL transformed-geometry cache. Feature input is gated through `store/helpers/featureRoles.modelFeatures()` — construction geometry never reaches the model (issue #199).
- `constructionExclusion.test.ts` — guard test: construction geometry can never become a machining target, region mask, or CSG input; fails the build if the exclusion regresses
- `profilePolyline.ts` — shared, acyclic profile-to-polyline flattening and contour-closing helpers used by CSG and batched 3D Line overlays
- `lineRendering.test.ts` — unit tests for `closeLinePolygonIfNeeded`: closed Line profiles append the first point for independent-segment closing; open profiles are unchanged
- `lineBatcher.ts` — converts every visible open profile and closed operation=line profile (including multi-profile text) into at most two `LineSegments2` draw objects, preserving green/default and blue/Subtract colours without connector segments
- `lineBatcher.test.ts` — value/object-level tests for independent segment geometry, colours, closed-solid exclusion, multi-profile text, 2,980-contour batching, and GPU resource disposal
- `importedMesh.ts` — STL/OBJ triangle mesh handling: parsing, axis swaps, post-import 3D orientation (`orientImportedMesh`), silhouette extraction, serialization
- `importedMesh.test.ts` — tests for the above
- `importedModelTransform.ts` — shared strict instance-matrix adapter for imported-model preview, CSG, CAM, and export; `modelDataTurnedOver` / `isModelTurnedOver`, the unserializable mark a Bottom setup's read model puts on a model so the mesh loader turns it over (issue #946); plus the post-import 3D orientation math (`ModelOrientation` → matrix, X→Y→Z order, cache key)
- `importedModelTransform.test.ts` — imported-model affine transform and consumer-alignment regressions
- `modelOrientation.test.ts` — post-import 3D orientation (issue #241): rotation order, exact 90° round-trips, rigid-rotation regression across preview/CSG/CAM, and the orientation cache key
- `setupOrientation.ts` — machining-setup orientation (issue #944), the one module that knows how a setup turns the stock: canonical stock point ↔ setup-local point (`canonicalToSetupPoint` / `setupToCanonicalPoint`) through a `SetupFrame` whose pivot is derived from the stock, the derived face (`setupFace`), where the shared origin lands in stock space, arc-direction reversal, the operation → setup lookup the export pipeline uses, and the face-local depth view of a feature's Z span (`depthFromFace` / `spanFromFaceDepth`). Accepts only 0° and 180°; at 0° the point is returned untouched
- `setupOrientation.test.ts` — the transforms in numbers on an off-origin, non-square stock: 0° identity, both half turns, other angles refused, round trips, the stock mapping onto itself, the shared origin on and off the flip centreline, arc direction, and face-local depth keeping floating and partial-depth spans intact. The header lists the mutations each assertion was checked against
- `setupFrameProject.ts` — the project as it sits on the machine for one setup (issue #946). `projectInSetupFrame` turns the whole project into a setup's frame — every feature (plan mirror composed onto its instance transform, Z span reflected through mid-thickness), the stock outline, tabs and clamps; the shared origin is left alone — so the unchanged generators can cut a Bottom operation top-down. `toolpathInStockFrame` carries the result back into stock space (moves, bounds, drill cycles, cut levels). Top returns the same objects, untouched. An imported model is turned over as well: its data is marked with `modelDataTurnedOver` and `loadSTLTransformedGeometry` (`csg.ts`) reflects the mesh inside its already reflected span, so a Bottom setup machines the model's back face
- `setupFrameProject.test.ts` — each piece in numbers on an off-origin stock: vertices, arc sense, circle centres, Z spans (blind, floating, through, named), stock box and outline, tabs, clamps, text glyphs mirrored, an imported model's mesh equal vertex for vertex to the half turn of the mesh as drawn, the plan mirror agreeing **exactly** with the point transform, and a toolpath carried back (moves, re-measured bounds, drill cycles, cut levels, indices)
- `setupTargets.ts` — which features a setup's operations may target (issue #946): same face; or, from the other face, a true through-feature (a subtract reaching both stock faces) or an imported 3D model, both reported as cross-face; else rejected with a reason. `isThroughFeature`, per-target verdicts with depth from the operation's face, `targetAllowedInSetup` (the store's question) and `setupGenerationBlock` (generation's: a wrong-face target produces no motion). Kept free of the store's target validator because it runs in the toolpath worker
- `setupOperationMove.ts` — `planOperationMove` / `applyOperationMove`: moving an operation to another setup re-judges its targets from the destination face, lists the ones it drops, and blocks the move when nothing valid would be left
- `setupReach.ts` — `operationCutRange` (the stock-Z range an operation cuts at a feature, read from its generated toolpath) and `throughFeatureCoverage` (for a through-feature targeted from both faces: meets / gap / unverified). Measured, never inferred: only ranges that were measured and meet are reported as meeting
- `setupReachGeometry.ts` — clips feeding segments to the resolved target contours expanded by a round cutter radius, preserving holes and reserving curve/integer error; interpolates Z only where actual motion intersects the footprint
- `setupReach.test.ts` — multi-target attribution regression from generated Top/Bottom paths, legitimate reach, geometry and unit/instance checks
- `setupTargets.test.ts` — the three modules above: through-feature tolerance, same-face / cross-face / rejected verdicts, the generation block, the Move plan (dropped, kept, blocked), cut ranges with their cutter footprint, and coverage both from hand-built paths and from real generated ones

## Subfolders
- [toolpaths/](toolpaths/INDEX.md) — toolpath generation (pocket, profile, v-carve, surface rough/finish, drill, edge…). **The heart of CAM.**
- [operations/camPlan/](operations/camPlan/INDEX.md) — deterministic CAM Plan: semantic feature/depth recognition, explainable tool planning, residual-backed rest proposals, dependency ordering, coverage, and shared edge-tab drafts. `operations/autoTabs.ts` is the pure tab-placement builder shared with the manual store action.
- `test-fixtures/` — committed engine-test assets such as `.camj` regression files shared by engine tests, including the issue #401 real cone finish project
- [gcode/](gcode/INDEX.md) — export: post-processing toolpaths into a program in the machine's output dialect (G-code, or ShopBot part files), the shared motion pipeline (machine transform, arc fitting), bundled machine definitions, and the exported-motion debug helpers
- `modelExport/` — model/design export (pluggable format registry: 3D mesh formats and 2D vector formats)
  - `index.ts` — public API and `MODEL_EXPORT_FORMATS` registry
  - `types.ts` — format/option interfaces (`kind: '2d' | '3d'` gates mesh assembly)
  - `assemble.ts` — manifold union → standard Z-up right-handed export mesh
  - `stl.ts` — binary + ASCII STL writers and the `stlExportFormat` entry
  - `svg.ts` — `svgExportFormat`: 2D design SVG at true 1:1, backed by `designPrint/` (issue #257)
- [designPrint/](designPrint/INDEX.md) — vector renderer for the 2D design view: page/scale layout math + SVG/HTML generation for printing (issue #254) and the geometry-only SVG export (issue #257)
- [operationBooklet/](operationBooklet/INDEX.md) — per-operation report model and PDF booklet generation
- [simulation/](simulation/INDEX.md) — heightfield-based material removal sim (grid, replay/stepping, GPU heightfield mesh + shaders)
- [nesting/](nesting/INDEX.md) — sheet nesting (#741): pure packer that places copies of part footprints on a sheet with a caller-supplied gap (no-fit polygons over convex pieces, bottom-left fill)

## Conventions
- All public exports flow through each subfolder's `index.ts`.
- Clipper integer-scaling and profile↔path conversion are wrapped in `store/helpers/clipping.ts`; arc/curve reconstruction of Clipper output lives in `toolpaths/arcReconstruction.ts`.
- Coordinates here are **internal** (Y-down). G-code export inverts to Cartesian.
