---
status: current
authoritative-for: GPU heightfield simulation rendering and playback update design
last-verified: 2026-09-23
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
