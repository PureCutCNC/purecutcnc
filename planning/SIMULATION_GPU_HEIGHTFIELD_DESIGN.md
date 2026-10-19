---
status: current
authoritative-for: GPU heightfield simulation rendering and playback update design
last-verified: 2026-10-17
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
- A height change at or below half a cell is always a slope. The Detail slider
  sets cells along the stock's long axis, so on large stock a ball finish is
  sampled with only two or three cells per pass; its gradient then reverses at
  nearly every edge, nothing "continues" it, and the finished surface used to
  render as flat squares outlined by wall-lit risers (issue #939). A real step
  at or below half a cell cannot be told from a scallop, so it gets the same
  treatment: a pocket that shallow, or a tab within half a cell of the part's
  top, keeps its riser but loses its crisp wall lighting. A cut-through rim is
  still a wall however thin the skin beside it, and a cut-through cell beyond
  an edge is never counted as a gradient that edge continues.
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

## Square blanks

A square blank is simulated exactly like the round bar: the same radial
heightfield (one radius per cell), the same cutting kernel (`applyMoveToGrid`),
the same playback controller and GPU renderer, and the same synchronous app
path. There is no separate square material model or simulation worker.

The only difference is the starting radius per cell. `createSimulationGrid`
fills `topZ` from `seedSquareTopZ` in `src/engine/simulation/grid.ts`
(`halfSide / max(|sin θ|, |cos θ|)`, constant along the bar) instead of a
uniform `stockTopZ`, and snapshots that as the immutable `initialTopZ`.
Removal statistics compare each cell with its own `initialTopZ`, so a virgin
square reports zero removed. `grid.stockTopZ` remains the radial envelope — the
corner radius `side/√2` about the true pivot at `side/2` — and is used only for
render bounds and camera framing. Cutting, playback, reset, dirty uploads,
shaders and framing are the round bar's.

Decision: Frank, 2026-10-17, #1016 amendment — the exact square model was
removed in favour of this shared path.

## Round bars on flat setups

A rotary project keeps Top and Bottom setups, and those simulate on the same
top-down heightfield as a block (issue #1049). Seeding every cell from the
stock's bounding box drew the round bar as a square block, so
`buildSimulationSetupInput` also hands the grid the bar's real profile for a
flat setup (`flatRoundBar: { axis, pivot, radius, centre, length }`), and
`seedFlatRoundBarTopZ` fills each across cell with `pivot + sqrt(radius² − d²)`
— `d` is the cell centre's distance across the bar from its centreline — with
the grid's empty value where `|d| ≥ radius`. The result is snapshotted as
`initialTopZ` exactly as a square blank's is, so a virgin bar reports zero
removed; `grid.stockTopZ` stays the full stock thickness.

A Bottom setup needs no special case: `projectInSetupFrame` has already turned
the setup-local stock, and a round bar is symmetric about its axis, so Top and
Bottom describe the same profile. The limit is inherent to the heightfield — it
shows the bar's upper half only, and nothing below the equator is represented
(a cutter from above cannot reach it).

The lower half is drawn as a fixed surface instead (#1049 follow-up):
`createFlatRoundBarLowerHalf` builds a static half-cylinder of the bar's own
radius and length from the same descriptor — colour and light rig shared with
the heightfield. A round bar has no flat stock underside, so the boundary group
draws no underside quad for it: the half-cylinder is the bottom. The boundary
walls land on that cylinder instead of floating at the equator plane — at the
equator where the grid's edge is the radius, a little below it where a cell
boundary falls short — and the two along ends stop at the equator, where the
half-cylinder's flat end caps already are. The round-bar wall variant uses the
lower half's world-space normals and depth darkening, so the surfaces meet
under one continuous shade with no gap or z-fight. Empty cells outside the bar,
and cut-through cells with no material above the cylinder, collapse their walls
and discard; the lower half is cut by nothing: it is the surface the Top cutter
cannot reach. The machinable upper half remains the heightfield exactly as
before. Block and square blanks have no descriptor, so their boundary floor
stays the stock bottom, their walls keep the established normals and their
scenes are unchanged; cutting, playback, reset and uploads stay the shared ones.

## Invariants

- A stock shape never selects a different grid, cutting kernel or playback. A
  square blank or a flat round bar changes only the per-cell starting heights
  (`seedSquareTopZ` / `seedFlatRoundBarTopZ`); a square blank also changes the
  radial bounding envelope (`grid.stockTopZ`), and a flat round bar adds one
  static render-only mesh for the lower half the heightfield cannot represent,
  removes the flat underside quad, and lands its walls on that lower half, with
  no effect on simulation state.
- GPU data is derived render state; it never becomes the simulation source of
  truth.
- Texture updates use the smallest valid dirty rectangle when practical.
- Empty/cut-away cells do not create false top surfaces or invalid normals.
- Stock top, bottom, units, grid transforms, and tool pose use one coordinate
  convention.
- Simulation runs one machining setup at a time, in that setup's local frame:
  `src/app/simulationSetup.ts` turns the project and the stock-space toolpaths
  into it once, so the grid always sees a top-down stock and a Bottom setup
  cuts from the top of the turned stock. Each setup starts from fresh stock —
  an approximation, since the operator turns the same part over — and the
  panel says so whenever there is more than one setup (issue #947). Combined
  remaining-stock simulation across the flip is out of scope.
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
