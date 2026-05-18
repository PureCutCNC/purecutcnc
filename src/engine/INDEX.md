# INDEX — src/engine/

Pure-logic CAM core. No React, no DOM. Everything here is testable in isolation. New features here **must** have unit tests.

## Top-level files
- `csg.ts` — manifold-3d CSG wrappers, STL transformed-geometry cache
- `importedMesh.ts` — STL/OBJ triangle mesh handling: parsing, axis swaps, silhouette extraction, serialization
- `importedMesh.test.ts` — tests for the above

## Subfolders
- [toolpaths/](toolpaths/INDEX.md) — toolpath generation (pocket, profile, v-carve, surface rough/finish, drill, edge…). **The heart of CAM.**
- `gcode/` — G-code post-processors and emission
  - `index.ts` — public API
  - `postprocessor.ts` — post-processor runner
  - `definitions/` — bundled machine definitions (Marlin, GRBL flavors, etc.)
  - `types.ts` — `MachineDefinition` and validation
  - `utils.ts` — formatting helpers
- `simulation/` — voxel-based material removal sim (state, stepping, voxel grid)

## Conventions
- All public exports flow through each subfolder's `index.ts`.
- Use clipper-lib via `store/helpers/clipping.ts` (integer scaling already handled).
- Coordinates here are **internal** (Y-down). G-code export inverts to Cartesian.
