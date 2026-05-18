# Mesh Waterline Slicing Repair

## Problem

Imported STL and OBJ meshes are expected to produce clean waterline contours at each Z level, but real files often contain small cracks, duplicated-but-not-identical vertices, T-junctions, or non-manifold edges. A horizontal slice may therefore return open segment chains even when the visual model looks continuous.

The slicer must repair small numerical gaps without inventing large shortcut edges. A previous behavior closed every open chain, which could create long diagonal shortcuts across the model. The opposite behavior, rejecting every open chain, is too strict and can remove valid contours that only need a small stitch.

## Desired Behavior

At one Z level:

- Treat triangle intersections as an undirected set of segment chains.
- Emit every naturally closed loop.
- Stitch only endpoints of open chains to endpoints of other open chains.
- Consider both ends of every open chain. Reverse a chain before joining when needed so the connected path direction remains continuous.
- Use 3D distance for the stitch test: `sqrt(dx^2 + dy^2 + dz^2)`.
- Stitch only when the endpoint gap is below a strict model-scale tolerance.
- Close a single open chain only when its start/end endpoints are within that same 3D tolerance.
- Never connect into the middle of a chain or a closed loop.
- Never bridge a large gap. Large gaps remain open and downstream operations must treat that slice level as unreliable or conservative.
- Return multiple closed loops when a level has multiple offsets, islands, or valley/pond contours. Do not force them into one contour.

## Algorithm

1. Intersect candidate triangles with the requested slice plane.
2. Build exact segment chains from endpoints that already share the same rounded 3D key.
3. Split results into closed loops and open chains.
4. Compute a stitch tolerance from the slice bounds:

   ```text
   tolerance = max(slice_diagonal * 1e-5, 2e-6)
   ```

   The tolerance is intentionally small. It should repair numeric cracks, not visible missing geometry.

5. Repeatedly find the closest valid endpoint pair under tolerance:
   - open chain end -> another open chain start
   - open chain end -> another open chain end, with reversal
   - open chain start -> another open chain start, with reversal
   - open chain start -> another open chain end
   - same-chain start/end only when that closes the chain
6. Promote newly closed chains to output loops.
7. Leave remaining open chains un-emitted and report their count in `MeshSliceResult.openChainCount`.

## Operation Semantics

Roughing and waterline finish should consume the same repaired closed-loop output. If `openChainCount > 0`, the slicer is reporting that some geometry at that level could not be trusted without inventing a shortcut. Roughing should remain conservative for those levels because missing protection can become an unsafe cut.

Waterline finish can still skip unrepairable open chains because it follows contour rings rather than clearing the area between them.

## Tests

The slicer needs regression coverage for:

- normal watertight box slices
- separated islands at the same Z level
- small open-chain endpoint gaps are stitched into a closed loop
- long open-chain gaps are not shortcut-closed
- multiple separate loops stay separate

