---
status: current
authoritative-for: GPU heightfield simulation rendering and playback update design
last-verified: 2026-10-03
---

# Simulation GPU Heightfield Design

## Purpose

Simulation keeps material-removal state in a CPU height grid and renders that
state through a GPU heightfield. Playback updates texture regions instead of
rebuilding a full JavaScript mesh after every move.

The shipped implementation plan and playback experiments are preserved in
[`archive/SIMULATION_GPU_HEIGHTFIELD_Plan.md`](archive/SIMULATION_GPU_HEIGHTFIELD_Plan.md).

## Responsibilities

- The CPU grid is the canonical simulation state and owns removal math.
- Playback reports the dirty grid region changed by applied moves.
- A texture mirrors height values for rendering.
- An instanced row template supplies an independent flat top quad for each
  heightfield cell; boundary walls and the underside use the same texture.
- The shader places each top at its own cell height and derives lighting
  normals from neighboring height samples. Cut-through cells discard their
  top quad. Adjacent tops cannot share corners because a one-cell-wide tab
  would otherwise slope down into a removed neighbor and look like a hole.
- Boundary slope smoothing keeps every wall next to a cut-through cell. A tab
  can form a descending stock-to-tab-to-cut sequence whose outer step must
  still render as a wall.
- One shared step/slope predicate decides which mesh shades an edge: the surface
  sheet takes a lighting gradient only across a slope, and the wall mesh lights
  the steps it leaves flat. A step is classified by whether it continues the
  gradient beyond it, so a V-flank or ball roundover still shades smoothly while
  a tab's 17 mm drop stays a wall. Both meshes asking the same predicate is what
  keeps "wall drawn" and "top stays flat" from drifting apart — when they
  disagreed, the surface painted the riser's normal onto the flat top beside it
  as a dark band across the tab (issue #829).
- A height change of at most half a cell is always a slope. The Detail slider
  sets cells along the stock's long axis, so on large stock a ball finish is
  sampled with only two or three cells per pass; its gradient then reverses at
  nearly every edge, nothing "continues" it, and the finished surface used to
  render as flat squares outlined by wall-lit risers (issue #939). A cut-through
  rim is still a wall however thin the skin beside it, and a cut-through cell
  beyond an edge is never counted as a gradient that edge continues.
- The surface normal is interpolated, not one per cell. Along an axis it blends
  the height change across the cell's two edges by position; across the axis it
  blends the three neighboring lines. The lighting is therefore continuous over
  cell borders. Step edges contribute nothing and hide the cells beyond them, so
  a flat top stays flat up to its rim. Only the cell's own four edges get the
  full predicate; the rest of the stencil is used where it is shallow and
  otherwise repeats the cell's own edge, which keeps the per-fragment cost near
  that of the single-normal shader it replaced.
- When a cell is smaller than a pixel the stencil widens along each axis (four
  edges under a tent weight), so scallops narrower than a pixel average out
  instead of aliasing into moiré.
- The wall mesh draws the small risers inside a slope as well, lit with the
  surface's own normal code. Collapsing them leaves a slit between two flat
  tops that shows the stock underside; lighting them as walls draws the cell
  grid. Silhouettes and angled walls stay stair-stepped.
- Static and playback views use the same rendering contract.

Implementation is centered in `src/engine/simulation/` and
`src/components/simulation/SimulationViewport.tsx`.

## Invariants

- GPU data is derived render state; it never becomes the simulation source of
  truth.
- Texture updates use the smallest valid dirty rectangle when practical.
- Empty/cut-away cells do not create false top surfaces or invalid normals.
- Stock top, bottom, units, grid transforms, and tool pose use one coordinate
  convention.
- GPU resources are disposed when grids or viewports are replaced.
- Detail controls remain bounded by memory, upload, and rendering cost; higher
  nominal resolution is not automatically safe on every device.
- Playback correctness must not depend on frame rate.

## Fallback and compatibility

WebGL capability failures should produce a clear fallback or error rather than
silently showing an incorrect stock model. Rendering optimizations must preserve
the CPU simulation result and may be disabled independently of toolpath
generation.

## Verification

Simulation rendering changes should include focused grid/playback/GPU helper
tests, lifecycle and disposal review, `npm run build`, and manual playback at
low and high supported detail. Changes to rendered controls or browser boot
paths also require the relevant e2e smoke.
