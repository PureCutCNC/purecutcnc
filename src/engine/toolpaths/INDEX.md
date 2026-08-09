# INDEX — src/engine/toolpaths/

Toolpath generators. Each file owns one strategy. `index.ts` re-exports everything.

## Operations (per-strategy files)
- `pocket.ts` — pocket clearing (offset-based clearing of an enclosed area)
- `carving.ts` — engrave / carve along a path (`'direct'` centreline or `'trochoidal'` overlapping-orbit slot)
- `drilling.ts` — drill-cycle generation
- `edge.ts` — edge / profile-following cuts (outside/inside contour)
- `vcarve.ts` — V-bit carving via inset-contour offset stepping (`v_carve`, "V-Carve offset")
- `vcarveMedial/` — geometric medial-axis v-carve (`v_carve_medial`): Voronoi-of-boundary skeleton with exact clearances, corner tips, and contact-spread curve filtering (see its `INDEX.md`). Replaced the retired `v_carve_recursive` skeleton op (issue #279); saved projects using it migrate to this on load.
- `roughSurface.ts` — 3D rough clearing of an imported mesh
- `finishSurface.ts` — 3D finish pass dispatcher
- `finishSurfaceCleanup.ts` — cleanup-style 3D imported-mesh finishing that emits deepest retained wall/floor paths from rough-surface-style levels
- `finishSurfaceParallel.ts` — parallel-line finish strategy
- `finishSurfaceWaterline.ts` — waterline (constant-Z) finish strategy with bounded, user-tunable adaptive shallow-slope refinement, mesh-safe projected bands, and terminal peak coverage
- `surface.ts` — shared surface-toolpath helpers
- `surfaceStepdown3d.ts` — shared imported-mesh stepdown resolver used by rough-surface and cleanup-surface operations
- `tabs.ts` — holding-tab generation on profile cuts
- `trochoidalEdge.ts` — pure bounded overlapping-orbit sampling around a validated Edge Route guide; generation integration owns entry, fragments, and safety validation
- `multiFeature.ts` — ops that span multiple features (e.g. combined clearing)

## Supporting modules
- `index.ts` — barrel export — add new files here when adding a strategy
- `types.ts` — shared toolpath types (segments, passes, parameters)
- `feed.ts` — shared `effectiveFeed` helper: applies a move's `feedScale` (for slot-feed pocket cuts) to the cut feed, and returns the plunge feed unmodified for plunge moves; used by the postprocessor, booklet time estimator, simulation playback, and the live-feed readout
- `entry.ts` — clearance-aware plunge, helical, and zig-zag ramp entry synthesis for pocket, surface-clean, and rough-surface clearing operations, including deterministic fallback warnings and plunge-feed limiting
- `geometry.ts` — toolpath-specific geometric helpers; owns the shared `DEFAULT_FLATTEN_*` sampling constants
- `trochoidalPath.ts` — shared trochoidal entry synthesis (helix/plunge points, move-count budgeting, and the per-operation point budget type) used by both Edge Route and Engrave
- `guideFragments.ts` — cyclic closed-guide fragmentation against pre-unioned keep-outs; preserves every safe span before entry-bearing motion is generated
- `tabs.ts` also owns the shared tab footprint geometry (`expandedTabFootprints`) and `applyEdgeRouteTabs`, the edge-route tab pass that deliberately returns trochoidal results untouched — see `planning/TROCHOIDAL_EDGE_DESIGN.md`
- `offsetSmoothing.ts` — emit-time corner fillet for the outer/wall clearing rings (`roundContourCorners`, `smoothClosedContours`, `cornerSmoothingRadius`); shared by pocket + surface clearing when `roundOutsideCorners` is enabled. Bounds the setback so acute corners leave no crescent; the offset-tree emitter keeps each region's wall-adjacent (root) outer ring sharp so no corner stock stacks into a chip (interior rings self-clean). Islands are rounded the opposite way — via `jtRound` Clipper offsets (see `buildInsetRegions` island join), so the tool wraps convex island corners smoothly without gouging.
- `linearMoveOptimization.ts` — pure generation-stage finalizer that removes zero-length duplicate moves and merges contiguous, direction-preserving, collinear XY moves; applied after tabs but before clamp warnings. Zero-length **rapids** are kept: they are each operation's entry-positioning marker for the postprocessor, not noise
- `arcReconstruction.ts` — recovers arcs/circles/beziers from flattened Clipper output: known-circle reconstruction, segment-preserving boolean reconstruction (annotation map), and the Clipper-offset simplification pipeline (Kasa fit + RDP)
- `regions.ts` — region computation (which area belongs to which op)
- `resolver.ts` — resolves features+operations into clipper input regions; V-carve accepts closed Subtract and Line features (S2), Pocket remains Subtract-only; Line paths use even-odd fill semantics for nested contour holes
- `restRegions.ts` — rest-machining region computation (what a prior tool missed)
- `silhouette.ts` — extracts 2D silhouette from 3D mesh for sketch projection
- `meshSlicing.ts` — slices a mesh at Z heights (used by surface strategies)
- `modelProtection.ts` — keeps cuts from violating the imported model
- `clamps.ts` — clamp clearance / avoidance regions

## Tests
- `linearMoveOptimization.test.ts` — zero-length removal, entry-marker (zero-length rapid) preservation, collinear merge, and boundary preservation
- `trochoidalEdge.test.ts` — deterministic closed/open orbit sampling, seam closure, direction, normalized duplicate vertices, and fail-closed budgets. Integrated cut-direction parity (trochoidal vs contour, inside and outside), circular/multi-target guides, and overlapping tabs live in `toolpaths.test.ts`
- `feed.test.ts` — shared effectiveFeed helper: cut/plunge/lead-in/lead-out move kinds, feedScale present/absent, and plunge ignores-feedScale invariance
- `entry.test.ts` — helix pitch/direction, region/island clearance, no-core diameter bounds, bottom flattening, ramp fallback, and plunge-feed limiting
- `geometry.test.ts` — shared nearest-neighbour ordering and squared-XY-distance behavior
- `guideFragments.test.ts` — cyclic span splitting across disjoint, seam-crossing, and concave forbidden regions
- `toolpaths.test.ts` — broad smoke tests across strategies
- `resolverReadPath.test.ts` — resolved instance geometry and missing-definition behavior in toolpath resolution
- `vcarveLineResolver.test.ts` — S2 closed-Line V-carve resolver tests: single Line, open-Line rejection, nested even-odd holes, disjoint Lines, mixed Subtract + Line, Subtract-only regression
- `clamps.test.ts` — clamp collision warnings, rapid auto-lift, per-move collision tagging
- `carving.test.ts` — direct-mode regression, open/closed guide orbits, swept envelope, region polarity, fail-closed width/V-bit/budget guards, and open-guide cut-direction parity
- `camOperationSmoke.test.ts` --- per-operation-kind smoke: pocket parallel/waterline patterns, drill-type differentiation (simple/peck/dwell/chip_breaking), post smoke for thin ops (v_carve, surface_clean, follow_line, v_carve_medial; closed-Line V-carve smoke); also documents the stock-target resolver gap
- `roughSurface.test.ts` / `finishSurface.test.ts` / `finishSurfaceCleanup.test.ts` / `meshSlicing.test.ts` / `vcarveMedial/vcarveMedial.test.ts` — strategy-specific
- `surfaceOperationValidation.test.ts` — real cone and hard-edge fixture matrix across Rough, Parallel, Waterline, and Cleanup, using an independently rasterized target surface plus swept-cutter simulation to validate stock, peak coverage, projected passes, determinism, and stable-interior gouging
- `pocketTessellationConsistency.test.ts` — regression for circle/arc sampling consistency (issue #359): full-circle and broken-circle pockets must have identical chord sagitta
- `arcReconstruction.test.ts` — direct partial-run arc-search coverage: greedy longest valid runs, sweep direction, and the bounded large non-fitting path (issue #369)
- additional arc-reconstruction coverage lives with its store-level callers: `store/helpers/offsetSimplify.test.ts` (offset simplification) and `store/second_cut_test.ts` (segment-preserving boolean reconstruction)

## Adding a new strategy
1. New file `myStrategy.ts` exporting a generator function.
2. Add `export * from './myStrategy'` to `index.ts`.
3. Add a sibling `myStrategy.test.ts` with unit tests (required by `AGENTS.md`).
4. Update this INDEX.
