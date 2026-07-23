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
- `importedMesh.ts` — STL/OBJ triangle mesh handling: parsing, axis swaps, silhouette extraction, serialization
- `importedMesh.test.ts` — tests for the above
- `importedModelTransform.ts` — shared strict instance-matrix adapter for imported-model preview, CSG, CAM, and export
- `importedModelTransform.test.ts` — imported-model affine transform and consumer-alignment regressions

## Subfolders
- [toolpaths/](toolpaths/INDEX.md) — toolpath generation (pocket, profile, v-carve, surface rough/finish, drill, edge…). **The heart of CAM.**
- `test-fixtures/` — committed engine-test assets such as `.camj` regression files shared by engine tests
- `gcode/` — G-code post-processors and emission
  - `index.ts` — public API
  - `postprocessor.ts` — post-processor runner (arc fitting, modal tracking, canned cycles)
  - `arcFitting.ts` — export-stage arc fitting: Kasa circle fit, direction detection, ≤90° splitting
  - `definitions/` — bundled machine definitions (Marlin, GRBL flavors, etc.)
  - `types.ts` — `MachineDefinition` (with `motion.arcInterpolation` and `arcFormat`) and validation
  - `utils.ts` — formatting helpers and `projectToMachinePoint` coordinate transform
- `modelExport/` — model/design export (pluggable format registry: 3D mesh formats and 2D vector formats)
  - `index.ts` — public API and `MODEL_EXPORT_FORMATS` registry
  - `types.ts` — format/option interfaces (`kind: '2d' | '3d'` gates mesh assembly)
  - `assemble.ts` — manifold union → standard Z-up right-handed export mesh
  - `stl.ts` — binary + ASCII STL writers and the `stlExportFormat` entry
  - `svg.ts` — `svgExportFormat`: 2D design SVG at true 1:1, backed by `designPrint/` (issue #257)
- [designPrint/](designPrint/INDEX.md) — vector renderer for the 2D design view: page/scale layout math + SVG/HTML generation for printing (issue #254) and the geometry-only SVG export (issue #257)
- [operationBooklet/](operationBooklet/INDEX.md) — per-operation report model and PDF booklet generation
- [simulation/](simulation/INDEX.md) — heightfield-based material removal sim (grid, replay/stepping, GPU heightfield mesh + shaders)

## Conventions
- All public exports flow through each subfolder's `index.ts`.
- Clipper integer-scaling and profile↔path conversion are wrapped in `store/helpers/clipping.ts`; arc/curve reconstruction of Clipper output lives in `toolpaths/arcReconstruction.ts`.
- Coordinates here are **internal** (Y-down). G-code export inverts to Cartesian.
