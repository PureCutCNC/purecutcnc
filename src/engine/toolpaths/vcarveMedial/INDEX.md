# INDEX — src/engine/toolpaths/vcarveMedial/

Geometric medial-axis V-carve generator (`v_carve_medial`, "V-Carve medial") —
the robust successor to the offset-stepping skeleton experiments (issue #177).

## Files
- `medialAxis.ts` — pure geometry: boundary resampling, Delaunay (delaunator),
  interior-circumcenter medial graph, exact clearance via a segment grid,
  contact-spread filtering of curve-flattening spokes (λ-medial axis on the
  exact boundary), micro-edge contraction, spur pruning, small-component
  cleanup, and inward-bisector tip extension into sharp convex corners.
- `toolpath.ts` — graph → chains (junction-to-junction paths, cycles, plunge
  points), depth-aware Douglas-Peucker simplification, greedy chain ordering
  with junction continuation, ToolpathMove emission.
- `index.ts` — `generateVCarveMedialToolpath(project, operation)` entry point
  mirroring the other v-carve generators (bands/regions via
  `resolvePocketRegions`, v-bit validation, per-region sample budget and
  empty-result auto-refinement). Re-exports the module surface.
- `resolution.ts` — pure region-scale sampling resolver: targets 160 boundary
  samples across the shorter XY span and enforces the per-region sample budget
  without an absolute project-unit ceiling.
- `resolution.test.ts` — scale, unit-equivalence, large-shape, degenerate-region,
  and sample-budget coverage for the automatic resolver.
- `vcarveMedial.test.ts` — canonical-shape suite: rectangle spine + exact
  clearances, square diagonals, circle spoke filtering, ring with island,
  L-shape junction/reflex behavior, acute-corner preservation, scale-stable
  lowercase-`g` filtering, generator depth math (60°/90°), clamping,
  determinism, and multi-feature separation.
- `noiseRegression.test.ts` — loads the user-reported linked small/large `gA`
  project fixture and locks its automatic resolution, corner count, leaves,
  and chain topology against flattened-font noise.

## Parameters
- Boundary sampling resolution is internal and derived independently from each
  resolved region's size; legacy `operation.stepover` values remain serialized
  for compatibility but do not affect medial toolpaths.
- `operation.maxCarveDepth` — depth clamp for wide areas
- `operation.debugToolpath` — tags cut moves with `source: 'medial-axis'`
