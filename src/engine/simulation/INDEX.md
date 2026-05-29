# INDEX — src/engine/simulation/

Heightfield-based material-removal simulation. A `SimulationGrid` stores a
`topZ` heightfield; toolpath moves lower cells the cutter passes over, and the
result is rendered as a GPU-driven heightfield mesh. Pure logic + Three.js mesh
builders — no React.

## Core
- `types.ts` — `SimulationGrid`, `DirtyRegion`, `SimulationBuildOptions`, `SimulationStats`
- `grid.ts` — grid spec resolution and `createSimulationGrid` allocation
- `tools.ts` — `cutterSurfaceZ`: the cutter's lower-surface profile used to lower cells
- `replay.ts` — applies toolpath moves to the grid (`applyMoveToGrid`, `simulateReplayItemsHeightfield`)
- `playback.ts` — playback state: poses, options, grid cloning for stepped playback

## Rendering (Three.js)
- `gpuMesh.ts` — builds a `DataTexture` over the grid's `topZ` array and the heightfield mesh; region updates push changes to the GPU
- `heightfieldShader.ts` — shader materials for the heightfield surface and stock boundary walls (static, dynamic, and shader-driven variants)
- `toolMesh.ts` — builds/disposes the moving cutter mesh group

## Supporting
- `index.ts` — barrel export

## Tests
- `gpuMesh.test.ts` — heightfield texture/mesh construction

## Related plan
- [`planning/SIMULATION_GPU_HEIGHTFIELD_Plan.md`](../../../planning/SIMULATION_GPU_HEIGHTFIELD_Plan.md)
