# INDEX — src/engine/toolpaths/

Toolpath generators. Each file owns one strategy. `index.ts` re-exports everything.

## Operations (per-strategy files)
- `pocket.ts` — pocket clearing (offset-based clearing of an enclosed area)
- `carving.ts` — engrave / carve along a path
- `drilling.ts` — drill-cycle generation
- `edge.ts` — edge / profile-following cuts (outside/inside contour)
- `vcarve.ts` — V-bit carving from medial axis
- `vcarveRecursive.ts` — recursive v-carve with larger tools (clears bulk first)
- `roughSurface.ts` — 3D rough clearing of an imported mesh
- `finishSurface.ts` — 3D finish pass dispatcher
- `finishSurfaceParallel.ts` — parallel-line finish strategy
- `finishSurfaceWaterline.ts` — waterline (constant-Z) finish strategy
- `surface.ts` — shared surface-toolpath helpers
- `tabs.ts` — holding-tab generation on profile cuts
- `multiFeature.ts` — ops that span multiple features (e.g. combined clearing)

## Supporting modules
- `index.ts` — barrel export — add new files here when adding a strategy
- `types.ts` — shared toolpath types (segments, passes, parameters)
- `geometry.ts` — toolpath-specific geometric helpers
- `regions.ts` — region computation (which area belongs to which op)
- `resolver.ts` — resolves features+operations into clipper input regions
- `restRegions.ts` — rest-machining region computation (what a prior tool missed)
- `silhouette.ts` — extracts 2D silhouette from 3D mesh for sketch projection
- `meshSlicing.ts` — slices a mesh at Z heights (used by surface strategies)
- `modelProtection.ts` — keeps cuts from violating the imported model
- `clamps.ts` — clamp clearance / avoidance regions

## Tests
- `toolpaths.test.ts` — broad smoke tests across strategies
- `roughSurface.test.ts` / `finishSurface.test.ts` / `meshSlicing.test.ts` / `vcarveRecursive.test.ts` — strategy-specific

## Adding a new strategy
1. New file `myStrategy.ts` exporting a generator function.
2. Add `export * from './myStrategy'` to `index.ts`.
3. Add a sibling `myStrategy.test.ts` with unit tests (required by `AGENTS.md`).
4. Update this INDEX.
