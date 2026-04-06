# V-Carve Implementation Review Report

**Date:** 2026-04-04  
**Scope:** Review of `planning/VCARVE_Implementation_Plan.md` against current code in `src/engine/toolpaths/vcarve/`, `src/engine/toolpaths/vcarve.ts`, and `src/engine/toolpaths/vcarveSkeleton.ts`

---

## Summary

The implementation is substantially further along than the plan's phase checklist reflects. Three distinct solver strategies now coexist in the codebase — the original contour-parallel fallback, a raster-thinning skeleton (an approach the plan explicitly rejects), and a true geometric straight-skeleton solver that is structurally complete but not yet wired into the primary operation path. The geometric solver is the correct end-state target and the bulk of its pieces are present and well-structured. The main gap is that it is not yet connected as the live `v_carve` operation.

---

## Current Code Inventory

| File | Role |
|---|---|
| `vcarve.ts` | Contour-parallel fallback — the current live `v_carve` operation |
| `vcarveSkeleton.ts` | Raster-thinning skeleton — registered as `v_carve_skeleton`, explicitly rejected by the plan |
| `vcarve/skeleton.ts` | True geometric straight-skeleton solver (wavefront + events) |
| `vcarve/wavefront.ts` | Initial wavefront ring construction |
| `vcarve/geometry.ts` | 2D vector math primitives |
| `vcarve/prepare.ts` | Region preprocessing: winding normalization, degenerate edge removal |
| `vcarve/cleanup.ts` | Graph post-processing: dedup, collinear merge, short arc/radius filter |
| `vcarve/depth.ts` | Radius-to-depth conversion and arc branch sampling |
| `vcarve/traverse.ts` | Skeleton graph to ordered polyline branches |
| `vcarve/toolpath.ts` | Branch points to `ToolpathMove[]` with rapid/plunge/cut |
| `vcarve/pipeline.ts` | Internal orchestrator: prepare → solve → cleanup → sample → moves |
| `vcarve/geometricToolpath.ts` | Full `ToolpathResult` generator for the geometric solver |
| `vcarve/types.ts` | All shared types for the geometric pipeline |
| `vcarve/index.ts` | Exports from the `vcarve/` module |

---

## Findings by Area

### 1. Three solvers exist; only the wrong two are wired up

`vcarve.ts` (contour-parallel) is the live `v_carve` operation.  
`vcarveSkeleton.ts` (raster thinning) is the live `v_carve_skeleton` operation.  
`vcarve/geometricToolpath.ts` (`generateGeometricVCarveToolpath`) is fully built but not called by anything in `toolpaths/index.ts` and not dispatched from the main operation router.

The plan explicitly identifies the raster-thinning approach as rejected and contour-parallel as a temporary fallback. The operation the plan wants to ship is `generateGeometricVCarveToolpath`, and it is the only one not connected to anything.

**Action needed:** Wire `generateGeometricVCarveToolpath` as the handler for `v_carve` (or `v_carve_skeleton`), replacing or gating the current handlers.

---

### 2. The geometric solver's pipeline is complete end-to-end

Walking the call chain in `vcarve/pipeline.ts`:

```
prepareVCarveRegion       ← winding normalize, degenerate removal
  → solveSkeletonGraph    ← wavefront events, edge + split, ring splitting
  → cleanupSkeletonGraph  ← dedup arcs, merge collinear, filter short/zero-radius
  → skeletonGraphToPolylines  ← adjacency graph traversal, depth-first branch walk
  → skeletonGraphToRadiusBranches  ← arc interpolation with radius at each point
  → radiusBranchesToToolpathMoves  ← depth = radius/tan(halfAngle), rapid/plunge/cut
```

All six stages are implemented. The types flow correctly through each stage. This is a working pipeline in isolation.

---

### 3. The skeleton solver's edge-event handling has a structural issue

In `skeleton.ts`, `collapseEdgeCluster` processes edge events but emits arcs in a way that does not correctly track all skeleton branches at a collapse:

```ts
appendArc(graph, vertex.point, moved.point, ring.offset, ring.offset + time)
if (previousMoved) {
  appendArc(graph, previousMoved.point, moved.point, ring.offset + time, ring.offset + time)
}
if (nextMoved) {
  appendArc(graph, nextMoved.point, moved.point, ring.offset + time, ring.offset + time)
}
```

The zero-length arcs appended for `previousMoved` and `nextMoved` (same start and end radius) are skeleton nodes, not arcs. They encode the collapse point correctly, but they do not emit the skeleton branch from the previous position of the collapsed vertex's neighbors to the collapse point. For a simple rectangle, the four corner bisectors should each contribute an arc to the center cross. For more complex shapes, missing these branches means the skeleton graph will have gaps where branches should exist, and `traverse.ts` will produce disconnected or short polylines rather than continuous skeleton arms.

This is the most likely cause of incomplete toolpaths on real geometry.

---

### 4. Split-event ring rebuilding does not carry forward reflex detection

In `splitRingAtEvent`, after the ring is split into two new loops, both loops are rebuilt via `rebuildActiveRingFromPoints`. This calls `buildWavefrontRing` → `buildVertices` → `angleBisector`, which re-derives reflex status from the new polygon winding. This is correct in principle. However, the two new loops include the split point `event.point` twice (once as the last vertex of `firstLoop` and once as the first vertex of `secondLoop`), then `rebuildActiveRingFromPoints` calls `removeCollinearVertices` on those. If the split point lands exactly on a near-collinear edge, it may be silently dropped, potentially producing a ring with a missing vertex and incorrect topology.

This is a low-likelihood but hard-to-diagnose edge case worth noting.

---

### 5. `maxIterations = 64` cap is too low for complex glyphs

`solveSkeletonGraph` accepts a `maxIterations` parameter defaulting to 64. For a simple shape this is fine. For a glyph with many vertices — a realistic outline font letter might have 50–100+ vertices — each vertex is a potential event, and a single iteration of the solver may only process one event. The solver can silently terminate early on complex input without warning, producing a partial skeleton.

The pipeline in `pipeline.ts` calls this with no `maxIterations` override, so it always uses 64. This needs to either be raised substantially for real use (500–1000 is more defensible), or the loop should terminate on ring count = 0 rather than iteration count, with the cap acting only as an emergency safety valve.

---

### 6. `vcarveSkeleton.ts` (raster thinning) has a hardcoded resolution cap that the plan rejects

`buildSkeletonPaths` in `vcarveSkeleton.ts` caps the grid at 280 cells on its longest axis and silently relaxes the requested spacing if needed:

```ts
const maxCells = 280
const cellSize = Math.max(requestedSpacing, longAxis / maxCells, 1e-3)
if (cellSize > requestedSpacing + 1e-9) {
  warnings.push('Skeleton resolution was relaxed to keep the raster solve tractable')
}
```

The plan explicitly names this as a disqualifying property: *"the robust solver handles realistic text/artwork without requiring hidden internal resolution relaxation."* This file should be retired or removed once the geometric solver is wired. Keeping it active risks it being mistaken for the correct solver.

---

### 7. `depth.ts` slope parameter is correctly computed but tip-minimum clamp is missing

`radiusToDepth` implements:

```ts
return Math.min(maxDepth, radius / slope)
```

The plan specifies a tip-minimum clamp:

```
minDepth = tipDiameter / 2 / tan(halfAngle)
```

This ensures the bit is not commanded to cut shallower than the tip flat allows. Without it, very thin skeleton branches (small radius) produce near-zero-depth moves that the V-bit cannot physically execute correctly. The clamp is not implemented. For sharp-tip bits (`tipDiameter = 0`) this is harmless, but once tip diameter is a real parameter it will matter.

---

### 8. `traverse.ts` branch ordering is not depth-prioritized

`skeletonGraphToPolylines` starts from non-degree-2 nodes (branch points and endpoints) and does a neighbor walk. This is topologically correct but the ordering is arbitrary — branches are emitted in the order nodes happen to appear in the adjacency map. The plan notes that a depth-first traversal starting from the deepest point (largest radius) is preferred for minimizing air time and producing natural-looking toolpath ordering. Neither `traverse.ts` nor `toolpath.ts` sorts branches by depth.

This is a quality issue rather than a correctness issue — the toolpath will cut correctly, just not in optimal order.

---

### 9. `geometricToolpath.ts` uses `v_carve_skeleton` kind check incorrectly

```ts
const supportedKind = operation.kind === 'v_carve' || operation.kind === 'v_carve_skeleton'
```

The geometric orchestrator accepts both kinds. But `v_carve_skeleton` is currently dispatched to `vcarveSkeleton.ts` (the raster thinning path), not to this file. This `||` condition suggests an intention to eventually unify the kinds, but as-is it creates a latent confusion: if `generateGeometricVCarveToolpath` were dispatched for `v_carve_skeleton`, the raster solver in `vcarveSkeleton.ts` would be bypassed — which is desirable — but this is not currently wired.

When replacing the dispatch, the kind check here should be simplified to just `v_carve` and the `v_carve_skeleton` path retired.

---

### 10. Plan phase checklist is out of date

Several items marked `[~]` in the plan are more complete than indicated, and some `[ ]` items exist in finished code. Specifically:

- VC3 (profile flattening, winding, degenerate removal) is effectively complete in `prepare.ts`.
- VC4 (skeleton computation) is structurally complete in `skeleton.ts`, though the edge-event arc emission issue in finding 3 above means it is not yet producing correct output on all inputs.
- VC5 (depth assignment) is complete in `depth.ts`, minus the tip-minimum clamp.
- VC6 (traversal and toolpath generation) is complete in `traverse.ts` and `toolpath.ts`. The top-level orchestrator `geometricToolpath.ts` exists but is not wired.
- VC7, VC8, VC9 (view, simulation, G-code) remain not started, correctly marked.

---

## Priority Action List

These are listed in the order they need to be resolved to get the geometric solver producing correct, connected output on real text geometry:

1. **Fix `collapseEdgeCluster` arc emission** — ensure every skeleton branch terminating at a collapse point is emitted as a full arc from the vertex's pre-collapse position, not as a zero-length degenerate arc. This is the most likely source of missing skeleton branches.

2. **Raise or remove `maxIterations = 64`** — use a much larger cap (or iteration-count-based termination) so complex glyph outlines solve fully.

3. **Wire `generateGeometricVCarveToolpath` as the `v_carve` handler** — replace or gate the current contour-parallel dispatch in the operation router.

4. **Retire or hide `vcarveSkeleton.ts`** — the raster-thinning path is actively misleading and the plan explicitly rejects it. At minimum, remove it from `toolpaths/index.ts` exports and the operation dispatch.

5. **Add tip-minimum clamp to `radiusToDepth`** — even with a sharp-tip bit this is defensive; it will be needed once tip diameter becomes a real UI parameter.

6. **Sort branches by descending max-radius in `traverse.ts`** — start from the deepest branch for better toolpath ordering.

7. **Update plan phase checklist** — reflect actual completion state of VC3–VC6.
