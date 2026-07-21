# INDEX — src/engine/toolpaths/

Toolpath generators. Each file owns one strategy. `index.ts` re-exports everything.

## Operations (per-strategy files)
- `pocket.ts` — pocket clearing (offset-based clearing of an enclosed area)
- `carving.ts` — engrave / carve along a path
- `drilling.ts` — drill-cycle generation
- `edge.ts` — edge / profile-following cuts (outside/inside contour)
- `vcarve.ts` — V-bit carving via inset-contour offset stepping (`v_carve`, "V-Carve offset")
- `vcarveMedial/` — geometric medial-axis v-carve (`v_carve_medial`): Voronoi-of-boundary skeleton with exact clearances, corner tips, and contact-spread curve filtering (see its `INDEX.md`). Replaced the retired `v_carve_recursive` skeleton op (issue #279); saved projects using it migrate to this on load.
- `roughSurface.ts` — 3D rough clearing of an imported mesh
- `finishSurface.ts` — 3D finish pass dispatcher
- `finishSurfaceCleanup.ts` — cleanup-style 3D imported-mesh finishing that emits deepest retained wall/floor paths from rough-surface-style levels
- `finishSurfaceParallel.ts` — parallel-line finish strategy
- `finishSurfaceWaterline.ts` — waterline (constant-Z) finish strategy with bounded, user-tunable adaptive shallow-slope refinement
- `surface.ts` — shared surface-toolpath helpers
- `surfaceStepdown3d.ts` — shared imported-mesh stepdown resolver used by rough-surface and cleanup-surface operations
- `tabs.ts` — holding-tab generation on profile cuts
- `multiFeature.ts` — ops that span multiple features (e.g. combined clearing)

## Supporting modules
- `index.ts` — barrel export — add new files here when adding a strategy
- `types.ts` — shared toolpath types (segments, passes, parameters)
- `geometry.ts` — toolpath-specific geometric helpers; owns the shared `DEFAULT_FLATTEN_*` sampling constants
- `offsetSmoothing.ts` — emit-time corner fillet for offset clearing rings (`roundContourCorners`, `cornerSmoothingRadius`); shared by pocket + surface clearing via the offset-tree emitter when `roundOutsideCorners` is enabled. Bounds the setback so acute corners leave no crescent, and the emitter keeps each region's boundary-adjacent (root) ring sharp so no corner stock stacks into a chip; interior rings self-clean.
- `arcReconstruction.ts` — recovers arcs/circles/beziers from flattened Clipper output: known-circle reconstruction, segment-preserving boolean reconstruction (annotation map), and the Clipper-offset simplification pipeline (Kasa fit + RDP)
- `regions.ts` — region computation (which area belongs to which op)
- `resolver.ts` — resolves features+operations into clipper input regions; V-carve accepts closed Subtract and Line features (S2), Pocket remains Subtract-only; Line paths use even-odd fill semantics for nested contour holes
- `restRegions.ts` — rest-machining region computation (what a prior tool missed)
- `silhouette.ts` — extracts 2D silhouette from 3D mesh for sketch projection
- `meshSlicing.ts` — slices a mesh at Z heights (used by surface strategies)
- `modelProtection.ts` — keeps cuts from violating the imported model
- `clamps.ts` — clamp clearance / avoidance regions

## Tests
- `toolpaths.test.ts` — broad smoke tests across strategies
- `resolverReadPath.test.ts` — resolved instance geometry and missing-definition behavior in toolpath resolution
- `vcarveLineResolver.test.ts` — S2 closed-Line V-carve resolver tests: single Line, open-Line rejection, nested even-odd holes, disjoint Lines, mixed Subtract + Line, Subtract-only regression
- `clamps.test.ts` — clamp collision warnings, rapid auto-lift, per-move collision tagging
	- `camOperationSmoke.test.ts` --- per-operation-kind smoke: pocket parallel/waterline patterns, drill-type differentiation (simple/peck/dwell/chip_breaking), post smoke for thin ops (v_carve, surface_clean, follow_line, v_carve_medial; closed-Line V-carve smoke); also documents the stock-target resolver gap
- `roughSurface.test.ts` / `finishSurface.test.ts` / `finishSurfaceCleanup.test.ts` / `meshSlicing.test.ts` / `vcarveMedial/vcarveMedial.test.ts` — strategy-specific
- arc-reconstruction coverage lives with its store-level callers: `store/helpers/offsetSimplify.test.ts` (offset simplification) and `store/second_cut_test.ts` (segment-preserving boolean reconstruction)

## Adding a new strategy
1. New file `myStrategy.ts` exporting a generator function.
2. Add `export * from './myStrategy'` to `index.ts`.
3. Add a sibling `myStrategy.test.ts` with unit tests (required by `AGENTS.md`).
4. Update this INDEX.
