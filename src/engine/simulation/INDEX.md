# INDEX — src/engine/simulation/

Heightfield-based material-removal simulation. A `SimulationGrid` stores a
`topZ` heightfield; toolpath moves lower cells the cutter passes over, and the
result is rendered as a GPU-driven heightfield mesh. Pure logic + Three.js mesh
builders — no React.

## Core
- `types.ts` — `SimulationGrid`, `DirtyRegion`, `SimulationBuildOptions`, `SimulationStats`
- `grid.ts` — grid spec resolution and `createSimulationGrid` allocation
- `tools.ts` — `cutterSurfaceZ`: the cutter's lower-surface profile used to lower cells
- `replay.ts` — applies toolpath moves to the grid (`applyMoveToGrid`, `simulateReplayItemsHeightfield`); the cell loop is allocation-free with per-move cutter dispatch (see `replay.test.ts` for the reference-parity contract)
- `playback.ts` — playback state: poses, options, grid cloning for stepped playback. Forward seeks advance incrementally (cuts are monotonic); the dirty region accumulates until the caller uploads and clears it

## Rendering (Three.js)
- `gpuMesh.ts` — builds a `DataTexture` over the grid's `topZ` array and the heightfield mesh; `uploadHeightfieldRegion` pushes only the dirty rectangle to the GPU via `texSubImage2D`
- `instancedBoundary.ts` — boundary walls + stock underside as instanced row-strips whose geometry the vertex shader derives from `gl_InstanceID` + the heightfield texture (GLSL3 `texelFetch`); O(cols) template memory at any detail, no CPU rebuilds while cutting. Primary boundary path for both static and playback views
- `heightfieldShader.ts` — shader materials for the heightfield surface and the legacy stock boundary walls (static, dynamic, and shader-driven variants; kept for the `USE_INSTANCED_BOUNDARY = false` A/B path in SimulationViewport)
- `toolMesh.ts` — builds/disposes the moving cutter mesh group

## Supporting
- `index.ts` — barrel export

## Tests
- `gpuMesh.test.ts` — heightfield texture/mesh construction
- `instancedBoundary.test.ts` — strip template scaling, instance counts, group wiring
- `replay.test.ts` — optimized cut-kernel parity against the `cutterSurfaceZ` reference

## Related plan
- [`planning/SIMULATION_GPU_HEIGHTFIELD_Plan.md`](../../../planning/SIMULATION_GPU_HEIGHTFIELD_Plan.md)
