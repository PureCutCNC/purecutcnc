# INDEX — src/engine/toolpaths/vcarveMedial/

Geometric medial-axis V-carve generator (`v_carve_medial`, "V-Carve medial") —
the robust successor to the offset-stepping skeleton experiments (issue #177).

## Files
- `medialAxis.ts` — pure geometry: boundary resampling, Delaunay (delaunator),
  interior-circumcenter medial graph, exact clearance via a segment grid,
  contact-spread filtering of curve-flattening spokes (λ-medial axis on the
  exact boundary), micro-edge contraction, spur pruning, small-component
  cleanup, and zero-clearance tip extension into sharp convex corners.
- `toolpath.ts` — graph → chains (junction-to-junction paths, cycles, plunge
  points), depth-aware Douglas-Peucker simplification, greedy chain ordering
  with junction continuation, ToolpathMove emission.
- `index.ts` — `generateVCarveMedialToolpath(project, operation)` entry point
  mirroring the other v-carve generators (bands/regions via
  `resolvePocketRegions`, v-bit validation, per-region sample budget and
  empty-result auto-refinement). Re-exports the module surface.
- `vcarveMedial.test.ts` — canonical-shape suite: rectangle spine + exact
  clearances, square diagonals, circle spoke filtering, ring with island,
  L-shape junction/reflex behavior, corner classification, generator depth
  math (60°/90°), clamping, determinism, multi-feature separation.

## Parameters
- `operation.stepover` — boundary sampling step (skeleton resolution, project units)
- `operation.maxCarveDepth` — depth clamp for wide areas
- `operation.debugToolpath` — tags cut moves with `source: 'medial-axis'`
