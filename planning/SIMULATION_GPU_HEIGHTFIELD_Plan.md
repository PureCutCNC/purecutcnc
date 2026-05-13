# Simulation GPU Heightfield Plan

Status legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete

## Goal

Replace the CPU-side mesh rebuild pipeline in the simulation viewport with a
GPU-driven heightfield renderer. The current approach rebuilds the entire stock
mesh from JavaScript arrays every frame during playback and produces visibly
coarse flat-shaded surfaces at the supported grid resolutions (240-720 cells).

After this work:
- The stock mesh is a static plane whose vertices are displaced by a GPU texture
  read from `grid.topZ`.
- During playback only the changed region of that texture is re-uploaded, not the
  full geometry.
- Grid resolution can increase well beyond 720 without proportional CPU cost.
- Surface normals are computed per-fragment from finite differences on the
  heightfield texture, producing smooth shading at any resolution.

## Problem Analysis

### Performance bottleneck

`buildSimulationGeometry()` in `src/engine/simulation/mesh.ts` is called every
frame during playback (`rebuildPlaybackGeometry` in `SimulationViewport.tsx:672`).
It iterates every cell, pushes position/normal floats into JS arrays, and
constructs new `Float32BufferAttribute`s. At 500x500 cells this is ~250K cells x
up to 6 quads x 6 vertices = millions of array operations per frame.

The old geometry is `.dispose()`d and replaced on the `Mesh` object each frame,
creating GC pressure and preventing any GPU-side caching.

### Quality bottleneck

The mesh uses `flatShading: true` with one quad per cell. Surface quality is
directly proportional to cell count, and the current max of 720 cells across the
longest axis produces visible staircase artifacts on diagonal cuts and curved
pockets.

Normals are computed per-face in `addQuad()` — neighboring faces with different
heights create hard edges everywhere.

## Design

### Static plane geometry

Create the grid plane geometry once when the simulation grid is initialized. The
geometry is a regular subdivided plane with `cols x rows` quads. Vertex positions
are set to their XY grid coordinates with Y (vertical) set to 0. The vertex
shader will displace Y from the heightfield texture.

```ts
// Created once, never rebuilt
const geometry = new THREE.PlaneGeometry(
  grid.cols * grid.cellSize,
  grid.rows * grid.cellSize,
  grid.cols,
  grid.rows,
)
```

The geometry stays on the GPU for the lifetime of the simulation session.

### Heightfield DataTexture

Store `grid.topZ` as a single-channel float `DataTexture`:

```ts
const texture = new THREE.DataTexture(
  grid.topZ,       // Float32Array, one value per cell
  grid.cols,
  grid.rows,
  THREE.RedFormat,
  THREE.FloatType,
)
texture.needsUpdate = true
```

On each playback frame, instead of rebuilding geometry, upload only the changed
rows/region via `renderer.copyTextureToTexture()` or partial `texSubImage2D`.

### Custom ShaderMaterial

A `ShaderMaterial` replaces `MeshStandardMaterial`:

**Vertex shader:**
- Sample the heightfield texture at the vertex's grid UV
- Displace the vertex Y by the sampled height value
- Pass UV to the fragment shader

**Fragment shader:**
- Sample the heightfield at the current fragment UV and its 4 neighbors
  (up/down/left/right offset by one texel)
- Compute the surface normal from finite differences:
  `dzdx = (right - left) / (2 * cellSize)`
  `dzdy = (top - bottom) / (2 * cellSize)`
  `normal = normalize(vec3(-dzdx, 1.0, -dzdy))`
- Apply standard lighting (directional + ambient) using the computed normal
- This produces smooth per-pixel normals without any CPU normal computation

**Side walls:**
- Keep a separate geometry for the 4 stock boundary walls and the bottom face
- These are static quads from `stockBottomZ` to `stockTopZ` — they don't change
  during simulation and are created once

### Dirty-region tracking

During playback, `applyMoveToGrid` already computes `[colStart, colEnd]` and
`[rowStart, rowEnd]` for each move. Accumulate a per-frame dirty rectangle:

```ts
interface DirtyRegion {
  colMin: number
  colMax: number
  rowMin: number
  rowMax: number
}
```

After `controller.advance()` returns, if the grid changed, upload only the dirty
rows of the `DataTexture` to the GPU. For a typical move this is a band a few
cells wide — orders of magnitude less data than rebuilding the full mesh.

`applyMoveToGrid` should return the dirty region bounds (currently it returns
only a changed-cell count). The `PlaybackController.advance()` method should
accumulate these into a union bounding box and expose it to the caller.

### Resolution increase

With the GPU path the main cost of higher resolution is:
- More texels in the heightfield texture (GPU memory, trivial)
- More vertices in the static plane (GPU vertex processing, still one draw call)
- More cells to iterate in `applyMoveToGrid` per move (CPU, but proportional to
  tool footprint, not total grid)

This means the grid resolution can increase from the current max of 720 to
1500-2000+ without meaningful frame-rate impact, since the per-frame CPU work is
only the dirty region, not the full grid.

Raise `SIMULATION_DETAIL_MAX` to 1500 and adjust the default to ~600.

## Implementation Phases

### G1. Dirty-region tracking in replay engine

- `[x]` Change `applyMoveToGrid` return type from `number` to
  `{ changedCount: number, dirtyRegion: DirtyRegion | null }`
- `[x]` Add `DirtyRegion` type to `src/engine/simulation/types.ts`
- `[x]` Accumulate dirty region in `PlaybackController.advance()` and expose via
  `getDirtyRegion()` / `clearDirtyRegion()`
- `[x]` Existing callers that check `changed > 0` adapt to
  `result.changedCount > 0`

Files: `replay.ts`, `playback.ts`, `types.ts`

### G2. Heightfield DataTexture and static plane geometry

- `[x]` Create `src/engine/simulation/gpuMesh.ts` with:
  - `createHeightfieldTexture(grid)` — builds `DataTexture` from `grid.topZ`
  - `createStockPlaneGeometry(grid)` — builds the static subdivided plane
  - `updateHeightfieldTexture(texture, dirtyRegion)` — marks texture for re-upload
  - `createStockBoundaryGeometry(grid)` — static side walls and bottom face
- `[x]` Side-wall and bottom-face geometry built in same file

Files: `gpuMesh.ts`

### G3. Heightfield ShaderMaterial

- `[x]` Create `src/engine/simulation/heightfieldShader.ts` with:
  - Vertex shader: displace Y from heightfield texture sample
  - Fragment shader: per-pixel normals from finite differences, two-light
    Blinn-Phong with ambient
  - Uniforms: heightfield texture, cellSize, stockBottomZ, stockTopZ, stock color,
    texelSize
- `[x]` Support the existing stock color prop
- `[x]` Discard fragments where `topZ <= stockBottomZ + epsilon`
- `[x]` Clamp empty-neighbor heights to avoid false slopes at pocket edges
- `[x]` Subtle depth-based darkening for cut surfaces

Files: `heightfieldShader.ts`

### G4. Integrate into SimulationViewport

- `[x]` Replace `buildSimulationGeometry()` calls in the static (non-playback)
  render path with the GPU heightfield mesh
- `[x]` Replace `rebuildPlaybackGeometry()` with dirty-region texture upload
- `[x]` Remove per-frame `geometry.dispose()` / `new BufferGeometry()` cycle
- `[x]` Tool mesh pose update unchanged
- `[x]` Raise `SIMULATION_DETAIL_MAX` from 720 to 1500

Files: `SimulationViewport.tsx`

### G5. Side walls and bottom face

- `[x]` Render boundary side walls from `stockBottomZ` to `stockTopZ` as static
  geometry (4 walls + bottom face), built once per grid in `createStockBoundaryGeometry`
- `[x]` Both static and playback paths create and dispose boundary meshes
- `[~]` Interior wall case: the GPU heightfield shades height discontinuities as
  steep slopes via smooth normals. Empty-neighbor clamping in the fragment shader
  prevents false ramps into removed material. Visual evaluation needed for sharp
  pocket walls.

Files: `gpuMesh.ts`, `SimulationViewport.tsx`

### G6. Cleanup and remove old mesh builder

- `[x]` Delete `mesh.ts` entirely (no remaining callers)
- `[x]` Remove `export * from './mesh'` from barrel export
- `[x]` All imports in `SimulationViewport.tsx` now point to `gpuMesh.ts` and
  `heightfieldShader.ts`
- `[x]` Both static and playback paths use GPU mesh
- `[x]` Build passes clean

Files: `mesh.ts` (deleted), `index.ts`, `SimulationViewport.tsx`

## Testing and Validation

- Compare GPU-rendered result against current CPU mesh at the same resolution to
  verify correctness (heights should match, shading will differ due to smooth vs
  flat normals)
- Playback at high resolution (1200+ cells) should maintain 60fps on integrated
  GPU hardware
- Verify pocket walls, islands, tabs, and through-cuts render correctly
- Verify ball endmill and v-bit surface profiles look correct with smooth normals
- Profile dirty-region upload size during playback to confirm it stays small

## Risks and Fallbacks

- **WebGL float texture support**: `OES_texture_float` is required. All modern
  browsers/GPUs support it but we should check `renderer.capabilities` and fall
  back to the CPU mesh path if unavailable.
- **Pocket wall rendering**: The current CPU mesh explicitly draws vertical quads
  between cells at different heights. The GPU heightfield will shade these as
  steep slopes. If this looks wrong for sharp pocket walls we may need a
  post-process edge-detection pass or a separate wall geometry derived from the
  texture. Evaluate during G5.
- **Partial texture upload API**: `renderer.copyTextureToTexture()` requires
  Three.js r138+. Verify the project's Three.js version supports it. Fallback:
  re-upload the full texture (still faster than rebuilding geometry).
