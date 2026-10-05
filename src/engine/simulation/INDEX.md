# INDEX — src/engine/simulation/

Heightfield-based material-removal simulation. A `SimulationGrid` stores a
`topZ` heightfield; toolpath moves lower cells the cutter passes over, and the
result is rendered as a GPU-driven heightfield mesh. Pure logic + Three.js mesh
builders — no React.

## Core
- `types.ts` — `SimulationGrid`, `DirtyRegion`, `SimulationBuildOptions`, `SimulationStats`
- `grid.ts` — grid spec resolution and `createSimulationGrid` allocation
- `tools.ts` — `cutterSurfaceZ`: the cutter's lower-surface profile used to lower cells
- `replay.ts` — applies toolpath moves to the grid (`applyMoveToGrid`, `simulateReplayItemsHeightfield`); plasma is excluded from cutter replay; the cell loop is allocation-free with per-move cutter dispatch (see `replay.test.ts` for the reference-parity contract)
- `playback.ts` — playback state: poses, options, grid cloning for stepped playback. Forward seeks advance incrementally (cuts are monotonic); the dirty region accumulates until the caller uploads and clears it

## Rendering (Three.js)
- `gpuMesh.ts` — builds a `DataTexture` over the grid's `topZ` array and an instanced row-strip surface with one flat top per cell (no shared corners that can collapse narrow tab bridges); bounds cover the shader-displaced Y range; `uploadHeightfieldRegion` pushes only the dirty rectangle to the GPU via `texSubImage2D`
- `instancedBoundary.ts` — boundary walls + stock underside as instanced row-strips whose geometry the vertex shader derives from `gl_InstanceID` + the heightfield texture (GLSL3 `texelFetch`); O(cols) template memory at any detail, no CPU rebuilds while cutting. The sole boundary path for both static and playback views. A step gets a wall lit by its own normal; a riser inside a slope is drawn too, but lit as the surface it belongs to
- `heightfieldShader.ts` — the heightfield surface shader material (`createHeightfieldMaterial`) plus the GLSL both meshes share: the `LIGHTING_GLSL` light rig, the `STEP_GLSL` step/slope predicate (`edgeIsStep`), and the smoothed surface normal (`SLOPE_GRADIENT_GLSL` + `SURFACE_NORMAL_GLSL`). The surface takes a lighting gradient only across an edge `edgeIsStep` calls a slope, interpolated across the cell so it is continuous over cell borders and widened when a cell is under a pixel; `instancedBoundary.ts` lights the steps it leaves flat, so the two meshes cannot disagree about which of them shades an edge
- `toolMesh.ts` — builds/disposes the moving cutter mesh group; plasma has no milling cutter mesh

## Supporting
- `index.ts` — barrel export

## Tests
- `gpuMesh.test.ts` — heightfield texture/mesh construction and per-cell top geometry
- `tabbedEdgeSimulation.test.ts` — real rectangle/Edge Out/auto-tab toolpath replay at two detail levels, including playback and through-cut neighbors
- `instancedBoundary.test.ts` — strip template scaling, instance counts, group wiring, and the step predicate and surface normal the surface and walls share
- `heightfieldShader.test.ts` — the step/slope predicate and the lighting gradient's scalar helpers, run from the GLSL source: a ball scallop at ~3 cells per pass is a slope, tab bridges and cut-through rims stay steps, a step at or below half a cell is a slope, the gradient is continuous across cell borders and takes nothing from a step. The texture lookups and wiring around those helpers are restated in the test; the assembled shaders are covered by the rendered checks in `e2e/viewportViews.smoke.spec.ts`
- `glslScalar.testSupport.ts` — test support that compiles the shaders' scalar GLSL functions to JavaScript, so those tests call the text the GPU compiles rather than a TypeScript copy
- `replay.test.ts` — optimized cut-kernel parity against the `cutterSurfaceZ` reference

## Related plan
- [`planning/SIMULATION_GPU_HEIGHTFIELD_DESIGN.md`](../../../planning/SIMULATION_GPU_HEIGHTFIELD_DESIGN.md)
