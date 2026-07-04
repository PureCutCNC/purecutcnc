# INDEX — src/engine/

Pure-logic CAM core. No React, no DOM. Everything here is testable in isolation. New features here **must** have unit tests.

## Top-level files
- `clipperOpenPaths.ts` — typed seam for clipper-lib's open-path API (`addOpenSubject`, `openPathsFromPolyTree`); confines the casts the local clipper-lib typings force
- `clipperOpenPaths.test.ts` — tests for the above
- `csg.ts` — manifold-3d CSG wrappers, STL transformed-geometry cache. Feature input is gated through `store/helpers/featureRoles.modelFeatures()` — construction geometry never reaches the model (issue #199).
- `constructionExclusion.test.ts` — guard test: construction geometry can never become a machining target, region mask, or CSG input; fails the build if the exclusion regresses
- `importedMesh.ts` — STL/OBJ triangle mesh handling: parsing, axis swaps, silhouette extraction, serialization
- `importedMesh.test.ts` — tests for the above

## Subfolders
- [toolpaths/](toolpaths/INDEX.md) — toolpath generation (pocket, profile, v-carve, surface rough/finish, drill, edge…). **The heart of CAM.**
- `test-fixtures/` — committed engine-test assets such as `.camj` regression files shared by engine tests
- `gcode/` — G-code post-processors and emission
  - `index.ts` — public API
  - `postprocessor.ts` — post-processor runner
  - `definitions/` — bundled machine definitions (Marlin, GRBL flavors, etc.)
  - `types.ts` — `MachineDefinition` and validation
  - `utils.ts` — formatting helpers
- `modelExport/` — 3D model export (STL today; pluggable format registry)
  - `index.ts` — public API and `MODEL_EXPORT_FORMATS` registry
  - `types.ts` — format/option interfaces
  - `assemble.ts` — manifold union → standard Z-up right-handed export mesh
  - `stl.ts` — binary + ASCII STL writers and the `stlExportFormat` entry
- [operationBooklet/](operationBooklet/INDEX.md) — per-operation report model and PDF booklet generation
- [simulation/](simulation/INDEX.md) — heightfield-based material removal sim (grid, replay/stepping, GPU heightfield mesh + shaders)

## Conventions
- All public exports flow through each subfolder's `index.ts`.
- Clipper integer-scaling and profile↔path conversion are wrapped in `store/helpers/clipping.ts`; arc/curve reconstruction of Clipper output lives in `toolpaths/arcReconstruction.ts`.
- Coordinates here are **internal** (Y-down). G-code export inverts to Cartesian.
