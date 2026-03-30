# Simulation Implementation Plan

Status legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete

## Goal

Add a third center view, `Simulation`, that shows the machined result of the selected or visible operations by replaying toolpaths against stock.

This phase is for 2.5D stock-removal simulation, not full physics or machine simulation.

The first useful outcome should let the user:
- open a dedicated `Simulation` tab beside `Sketch` and `3D View`
- see the stock after material is removed by tool motion
- compare the simulated result to the intended model
- validate operations, tabs, islands, and preserved material visually before G-code export exists

## Core Decision

Do **not** implement first-pass simulation as repeated 3D booleans of swept tool solids.

Use a **heightfield stock model** instead.

Reason:
- this app is currently focused on 2.5D machining
- for 2.5D, stock can be represented as one remaining top-surface Z per XY sample
- this is much faster and simpler than swept-solid CSG subtraction
- debugging will be far easier
- tabs already work naturally if the toolpath avoids them

## UI Direction

Add a third center tab:
- `Sketch`
- `3D View`
- `Simulation`

Keep simulation separate from normal `3D View`.

Reason:
- `3D View` represents intended part/model geometry
- `Simulation` represents remaining stock after selected operations are replayed
- those are different questions and should not be conflated

### First-pass simulation scope

Support:
- selected operation only
- optionally later: all visible/enabled operations in tree order

Recommended first pass:
- selected operation only
- because it is much easier to validate and compare against the existing toolpath preview

## Existing Assets We Can Reuse

Already in place:
- generated toolpaths in `src/engine/toolpaths/`
- current 3D rendering pipeline in `src/components/viewport3d/Viewport3D.tsx`
- current CSG/model generation in `src/engine/csg.ts`
- stock/profile/unit data in `src/types/project.ts` and `src/utils/units.ts`

Important constraint:
- simulation should **not** reuse the finished-part CSG result as the simulation engine
- it may reuse view/layout patterns, but the simulation data model should be separate

## Simulation Model

Use a regular XY grid over stock bounds:

```ts
interface SimulationGrid {
  originX: number
  originY: number
  cellSize: number
  cols: number
  rows: number
  stockBottomZ: number
  stockTopZ: number
  topZ: Float32Array
}
```

Meaning:
- each cell stores the remaining top surface Z at that XY location
- initialize all cells to `stock.thickness`
- stock bottom is `0`

This matches current assumptions:
- stock starts as a top block from `Z 0` to `Z stock.thickness`
- 2.5D operations only remove downward from the top

## Tool Replay Strategy

Replay generated toolpaths into the heightfield.

Use only these move kinds initially:
- `cut`
- `plunge`

Ignore for first pass:
- `rapid`
- `lead_in`
- `lead_out`

Reason:
- only actual material-contact moves should remove stock
- preview can still show full motion elsewhere, but simulation should only remove with cutting moves

### Per-move replay

For each cutting move:
1. compute the XY bounding box of the move expanded by tool radius
2. iterate simulation cells inside that bounding box
3. compute distance from cell center to the move segment in XY
4. if the cell lies within the cutter footprint, compute cutter-implied surface Z at that point
5. lower the cell's stored Z if the move cuts deeper there

This requires a cutter-shape function.

## Tool Shape Model

### First pass

Support only:
- `flat_endmill`

For a flat endmill:
- if XY distance from tool centerline sweep is within tool radius
- cut down to the move Z

### Later

Add support for:
- `ball_endmill`
- `v_bit`

Design helper:

```ts
function cutterSurfaceZ(
  tool: NormalizedTool,
  toolCenterZ: number,
  radialDistance: number,
): number | null
```

Where:
- return `null` if outside cutter footprint
- otherwise return the surface Z imposed by the cutter at that radial distance

## Rendering Strategy

Render the simulation as a 3D mesh derived from the heightfield.

### First-pass mesh

Build a triangulated top surface from the grid:
- one vertex per cell corner/sample
- triangles per quad
- Y-up/Z-up transform should match current viewport convention

Also add:
- simple side walls down to stock bottom
- bottom cap for readability if needed

This is enough for a convincing simulation result.

### Viewport behavior

Recommended first pass:
- reuse the existing viewport interaction style from `Viewport3D`
- create a dedicated `SimulationViewport` component rather than overloading `Viewport3D`
- allow clamp/tab overlays later if useful, but do not block the first implementation on them

## Operation Scope

### First pass

Simulate:
- selected operation only

### Second pass

Simulate:
- all enabled operations with `showToolpath = true`
- or all enabled operations up to the selected operation in operation-tree order

Order matters, so multi-operation simulation must respect operation order.

## Tabs and Clamps

### Tabs

Tabs should work automatically if the underlying toolpath already preserves them.

That means:
- simulation does **not** need a special tab model initially
- if the toolpath leaves material, the heightfield will leave material too

### Clamps

Clamps do not remove or add part material.

So in simulation:
- clamps are optional visual overlays only
- they do not affect the stock-removal mesh directly

## Resolution / Performance

This will need a quality setting.

### First pass

Use one derived resolution rule, for example:
- longer stock axis gets around `160-220` cells
- shorter axis scales proportionally

This avoids premature UI complexity.

### Later

Expose a setting:
- `Low`
- `Medium`
- `High`

or a numeric `cellSize`

## Caching

Do not recompute simulation unnecessarily.

Recommended first pass:
- compute in `useMemo` from:
  - project revision / project object
  - selected operation id
  - simulation settings

Later:
- add explicit cache keys if recomputation becomes expensive

## Files To Add

Suggested new modules:
- `src/engine/simulation/types.ts`
- `src/engine/simulation/grid.ts`
- `src/engine/simulation/replay.ts`
- `src/engine/simulation/tools.ts`
- `src/engine/simulation/mesh.ts`
- `src/components/simulation/SimulationViewport.tsx`

Likely touch points:
- `src/App.tsx`
- `src/components/layout/AppShell.tsx`
- `src/styles/layout.css`

## Implementation Phases

### S1. Simulation tab shell
- `[x]` add `Simulation` as a third center tab
- `[x]` add empty `SimulationViewport`
- `[x]` wire selected operation into that view

### S2. Heightfield grid model
- `[x]` define `SimulationGrid` and simulation result types
- `[x]` initialize a grid from stock bounds and stock top/bottom Z
- `[x]` derive a first-pass default resolution

### S3. Tool replay engine
- `[x]` replay `cut` and `plunge` moves into the grid
- `[x]` support `flat_endmill`
- `[x]` ignore non-cutting moves in first pass

### S4. Simulation mesh rendering
- `[x]` convert heightfield to a renderable 3D mesh
- `[x]` add side walls / bottom cap as needed
- `[x]` render the simulated stock result in the new viewport

### S5. Pocket validation pass
- `[x]` render full-depth pocket cuts as underside openings when material is removed to stock bottom
- `[x]` validate pocket simulation against current pocket toolpaths
- `[x]` confirm islands and preserved material remain visible in simulation
- `[x]` confirm tabs survive through simulation when toolpaths preserve them

### S6. Edge-route and surface-clean support
- `[x]` replay `lead_in` / `lead_out` as material-removing moves where applicable
- `[x]` validate edge-route replay
- `[x]` validate surface-clean replay
- `[x]` fix move-type edge cases where replay semantics differ from pocket

### S7. Multi-operation simulation
- `[x]` simulate all enabled operations in operation-tree order
- `[x]` add a mode switch for `Selected` vs `Visible/Enabled`
- `[x]` keep selected-operation-first workflow simple

### S8. Refinement / backlog candidates
- `[ ]` support `ball_endmill`
- `[ ]` support `v_bit`
- `[x]` add simulation quality controls
- `[ ]` add stock comparison / deviation view
- `[x]` optional clamp/tab overlays in simulation viewport
- `[ ]` optional tool animation / scrubber

## Recommended Build Order

1. `S1` simulation tab shell
2. `S2` heightfield model
3. `S3` flat-endmill replay
4. `S4` simulation mesh render
5. `S5` pocket validation
6. `S6` edge/surface validation
7. `S7` multi-operation simulation
8. `S8` refinement

Reason:
- prove the simulation architecture on the simplest useful path
- keep it aligned with existing toolpath work
- defer richer tooling and UI controls until the base model is trustworthy

## Exit Criteria For First Pass

Simulation is useful for the POC when:
- the user can switch to a `Simulation` tab
- the selected operation removes material from stock in a visibly correct way
- flat-endmill pocket results look plausibly correct
- islands/tabs preserved by toolpaths remain in the simulated result
- the simulation view is stable enough to compare against the design model

## Notes

- This is **stock-removal simulation**, not machine simulation.
- Do not block the first pass on G-code generation.
- Do not block the first pass on non-flat tools.
- Keep the engine separate from finished-part CSG even if both render in Three.js.
