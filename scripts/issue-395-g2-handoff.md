# Issue #395 slice G2 — the Around simulation: the bar, turning under the tool

You are the implementation worker for one slice of issue #395 (an "Around"
face on a round bar). Work only in your task worktree. Do not create, remove,
merge, push or switch branches or worktrees. Do not open a PR. Do not run
`git add` or `git commit`: leave your edits uncommitted and report
`COMMIT: none`. `gh` may be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `src/engine/INDEX.md`,
`src/engine/simulation/INDEX.md`, then in full `src/engine/aroundFrame.ts`,
`src/engine/rotaryFrame.ts`, `src/app/simulationSetup.ts`,
`src/app/useSimulationModel.ts`, `src/app/aroundSimulation.test.ts`,
`src/engine/simulation/{types,grid,replay,playback,gpuMesh,heightfieldShader,instancedBoundary}.ts`,
`src/engine/simulation/heightfieldShader.test.ts` and
`glslScalar.testSupport.ts`, `src/components/simulation/SimulationViewport.tsx`,
the simulation props in `src/App.tsx`, and the last test of
`e2e/around3d.smoke.spec.ts`. Absolute paths for every write, no `cd`.
Smallest change that does the job; no refactor; match the surrounding code. No
`process.` or `globalThis` in engine code. `node_modules` is a symlink:
type-check with `npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

Another worker is adding Around features to the 3D model at the same time.
**Do not touch** `src/engine/csg.ts`, `src/engine/lineBatcher.ts`,
`src/engine/csgAroundFace.test.ts`, `src/components/viewport3d/**`,
`src/engine/aroundFrame.ts`, `src/engine/rotaryFrame.ts`, or any new file named
`aroundFeatureSolid*` / `e2e/aroundModel*`. If you think one of them must
change, stop and say so in the report.

## What the user asked for

Today the Simulation tab shows an Around setup unrolled: a flat sheet one
circumference across and one radius thick, cut from above
(`buildSimulationSetupInput`). The maintainer: "we need to have a real
simulation with 3D view and rotation." So:

1. For an Around setup the Simulation tab shows the **bar as a cylinder**,
   cut. It is the same height map as today, drawn wrapped. No new simulator.
2. **Play tool:** the tool stays vertical over the bar's centreline and the
   **bar turns under it** by each move's angle. The camera does not move.
   Scrubbing and speed work as now.
3. **Multi-turn cuts land in the right place.** Today a move past the first
   turn of the sheet cuts nothing.
4. Chuck and tailstock are drawn as the real round fixtures at the bar's ends.
5. One toggle, **Unrolled**, keeps today's flat sheet view. Default is the bar.
6. Walls are drawn pointing at the centre. Display only.

A flat (Top or Bottom) setup's simulation must not change in any way: same
grid, same shader source, same frame cost.

## Background you need

- `aroundFrame(stock)`: `axis`, `centre` (the centreline's across coordinate),
  `radius` R, `sheetStart`, `circumference` C. On the sheet, along is the
  bar's axis and across is the other one (Y for an X bar, X for a Y bar).
- The unrolled project lowers every height by R: the sheet's top is `z = R`,
  its bottom is `z = 0`, the centreline. So a heightfield value `h` is already
  the **radius** of the remaining material at that cell.
- The frozen sign (`rotaryFrame.ts`, header of `aroundFrame.ts`): with
  `a = 360·(across − sheetStart)/C`, a sheet point at radius `r` is the point
  of the unturned stock `across' = centre + r·sin a`, `z' = R + r·cos a`,
  along unchanged; and with the stock turned to `a_p`, that stock point is
  drawn where `toolSpacePoint(stockPoint, a_p, stock)` says. Derive every
  position through these; do not invent a sign. The simulation viewport's
  world is `(x, z, y)`: world Y is up (see `updateToolMeshPose`).

## Build

### a. Fold — new file `src/engine/aroundFold.ts`

`foldToolpath(result, frame)`: a sheet toolpath (the output of
`unwrapToolpath`) with every move brought onto the first circumference
`[sheetStart, sheetStart + C]`:

- A move whose across coordinate crosses `sheetStart + k·C` is split there
  (linear in along, across and z), and each piece is shifted by a whole number
  of circumferences. Along-only and vertical moves are just shifted.
- A point exactly on a seam belongs to the piece it ends or starts: a piece
  arriving from below ends at `sheetStart + C`, the next starts at
  `sheetStart`. No zero-length pieces. A move that ends exactly on the seam is
  not split.
- Each piece keeps the move's `kind`, `feedScale` and other fields.
  `collidingMoveIndices` are remapped to the pieces; `bounds` recomputed. A
  toolpath already inside the first circumference comes back with equal moves.

Apply it in `buildSimulationSetupInput` right after `unwrapToolpath`, in both
views.

### b. A cut next to the seam removes material on both sides of it

Folding fixes where the tool's centre is. The cutter also has a radius: a
cut at `sheetStart + 0.5` with a 3 mm tool must also lower the cells just
below `sheetStart + C`. Do this where moves meet the grid, without touching
the optimized cell loop:

- `SimulationGrid` gains an optional `wrap?: { axis: 'x' | 'y'; period: number }`
  (the grid axis that is across, and C). `SimulationBuildOptions` gains the
  same optional field; `createSimulationGrid` copies it onto the grid;
  `cloneSimulationGrid` already spreads it.
- `applyMoveToGrid` keeps its name and signature. Its current body becomes
  the kernel. When `grid.wrap` is set and the move's extent ± `toolRadius`
  reaches past the low or the high edge of the grid on that axis, the kernel
  is also run on the move shifted by `+period` or `−period`, and the results
  are merged (`changedCount` summed, dirty regions united). With no
  `grid.wrap` the function does exactly what it does today.
- `useSimulationModel` passes `wrap` for an Around setup (both views) in
  every place it passes `targetLongAxisCells`.

`replay.test.ts` and `tabbedEdgeSimulation.test.ts` must pass unmodified.

### c. What the model hands the viewport

`useSimulationModel` already returns the unrolled `simulationStock` and
`simulationClamps`. Add one optional value, `simulationBar`, present only for
an Around setup: the `AroundFrame`, the project's real round stock, and the
real project's visible clamps (so `buildClampMesh` draws chuck and tailstock
as cylinders about the bar, as it does in the 3D view). Thread it through
`App.tsx` to a new optional `bar` prop of `SimulationViewport`. Nothing else
in `App.tsx` changes.

### d. The bar view — shaders

The wrap is a vertex transform in the existing row-strip renderer, selected at
**compile time** by a material define (for example `AROUND_WRAP`), with a few
uniforms (centre, R, sheetStart, C, which grid axis is across). Reasons, from
earlier work on this renderer (#939): a per-vertex runtime conditional is not
skipped on the GPU, and shader size is compile time on software rendering. So:

- Every added line sits inside `#ifdef AROUND_WRAP`. A material created
  without the option has no such define and its behaviour is unchanged.
- Three materials need it: the surface (`heightfieldShader.ts`), the instanced
  walls and the floor (`instancedBoundary.ts`). A cell of height `h` at sheet
  position (along, across) is drawn at the stock point given above, in the
  viewport's `(x, z, y)` world.
- **Lighting follows the curve:** a cell's "up" is its radial direction, and
  wall normals turn with the cell's angle. A bar lit as if it were flat is a
  defect.
- **Bounds:** `createStockPlaneGeometry` and the boundary group set bounding
  boxes for the flat layout. In bar view they must enclose the cylinder, or
  the bar is culled at some camera angles and the first auto-frame is wrong.
- The grid's last row across may be a partial cell past `sheetStart + C`.
  It must not be drawn over the first row.
- Put the wrap formula in one GLSL function, exported as a string like the
  other shared chunks, so the test can run the shader's own text through
  `glslScalar.testSupport.ts` (or extend that support minimally if it cannot
  compile what you need; say so).

### e. The bar view — viewport

In `SimulationViewport.tsx`, when `bar` is given and the Unrolled toggle is
off:

- The heightfield meshes are built with the wrap materials, in the static
  view and in the playback view.
- Fixtures are built from `bar.clamps` with `bar.stock`; the origin triad is
  drawn at the real project origin (pass what the viewport needs through
  `bar`; the `origin` prop today is the real project's, whose `z` is not
  lowered by R, so check which one the unrolled view needs and keep it right).
- Turning: the wrapped meshes (surface, walls, floor, and the fixtures) sit
  under one group that is rotated about the bar's centreline. With no
  playback the angle is 0. During playback the angle is the pose's
  `a = 360·(pose across − sheetStart)/C`, applied so that the cell being cut
  is at the top under the tool, per `toolSpacePoint`.
- The tool is drawn vertical at the wrapped pose: along from the pose, across
  = `centre`, tip height = `R + pose.z` (what `wrapPoint` returns), in the
  viewport's `(x, z, y)` world. The coordinate readout is left as it is.
- The camera does not follow the turn. Toggling the view re-frames once.
- Publish on the `.simulation-viewport` element, next to the existing
  `data-simulation-*` attributes: `data-simulation-view` = `bar`, `unrolled`
  or `flat` (a non-Around setup), and `data-simulation-bar-angle` = the
  current turn in degrees with three decimals, updated where the pose readout
  is updated.
- The toggle: one button in the simulation toolbar beside "Play tool", shown
  only for an Around setup, styled like `simulation-playback-toggle`, active
  when the unrolled view is on. It is view state local to the viewport;
  nothing is stored in the project. New keys in the `viewport` locale file of
  **all five** locales (`en`, `de`, `fr`, `es`, `zh-CN`):
  `viewport.sim.unrolled` (English `Unrolled`) and
  `viewport.sim.unrolledTitle` (English
  `Show the bar's surface unrolled flat, all of it at once`). Only new keys,
  placed after `viewport.sim.playToolToggle` in every file, each file's own
  quote style, no existing value changed.
- With the toggle on, the view is today's sheet: the unrolled stock and
  clamps, the flat materials, no turning.

## Tests

`npx tsx`-style test files like their neighbours.

New `src/engine/aroundFold.test.ts`:

- A line 2.5 turns long folds into three pieces, all inside the first
  circumference, whose summed length equals the original's and whose seams
  meet (end of one at `sheetStart + C`, start of the next at `sheetStart`,
  same along and z).
- A move ending exactly on the seam is one piece; a move starting exactly on
  it and going up starts at `sheetStart`.
- Negative turns fold the same way. Both bar axes.
- `kind` and `feedScale` survive; `collidingMoveIndices` point at the pieces
  of the colliding move.
- A toolpath inside the first circumference is returned with equal moves.

Engine (in `src/engine/simulation/` next to `replay.test.ts`):

- The 2.5-turn line cuts the same cells (identical `topZ`) as its three
  folded pieces replayed one by one on a grid with `wrap`.
- A cut centred `toolRadius/2` above `sheetStart` lowers cells at both ends
  of the across axis; with no `wrap` on the grid it lowers one end only.
- A grid with no `wrap`: `topZ` after a fixture of moves is identical before
  and after your change (use an existing fixture's expected values).
- Playback: a `PlaybackController` advanced to the end over the folded line
  leaves the same `topZ` as the static replay.

Wrap (shader text through the scalar support, compared with the TypeScript
functions): a cell of height `h` at angle `θ` is drawn at radius `h` from the
centreline at that angle; the result equals
`stockSpacePoint(wrapPoint({…}, frame), stock)` mapped to the viewport world,
for both bar axes and for angles in all four quadrants; the turn applied at
pose angle `a_p` brings the cell at `a_p` to the top, equal to
`toolSpacePoint`.

`src/app/aroundSimulation.test.ts` (extend): an Around input's toolpaths are
folded; a pocket placed on the second turn of the sheet removes material
(today it removes none); the model's `simulationBar` contents if you can
reach them without React, otherwise the pure helper that builds them.

Browser spec — the last test of `e2e/around3d.smoke.spec.ts` (you cannot run
it; the manager will, and will fix it against the real page, so say what you
assumed): after selecting the Around setup, `data-simulation-view` is `bar`
and material is removed; during playback `data-simulation-bar-angle` leaves
zero; the Unrolled button switches `data-simulation-view` to `unrolled` and
back; the Top setup reads `flat` and shows no Unrolled button. Screenshots
with `testInfo.outputPath`: the bar from the default camera, from the side
(left-drag about −60 px on the canvas), and end-on (use the view presets in
the simulation toolbar if one looks along the bar; say which). Add what you
need to `e2e/selectors.ts`.

## Mutations

One at a time, restored from a `cp` backup (never `git checkout`); name the
failing test or report a survivor: fold not applied in
`buildSimulationSetupInput`; the seam split putting both pieces on the same
side; `wrap` ignored in `applyMoveToGrid`; the shifted copy applied with the
wrong sign; sine and cosine swapped in the GLSL wrap; the turn applied with
the opposite sign; the tool drawn at the sheet pose instead of over the
centreline; the Y-bar branch using the X-bar's axes; the define also set for
a flat setup.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
every test file you changed or added, plus every `*.test.ts` under
`src/engine/simulation/`, `src/app/aroundSimulation.test.ts`,
`src/app/simulationSetup.test.ts`, `src/app/useSimulationModel.test.ts`,
`src/app/simulationSetupModel.test.ts`, `src/engine/aroundFrame.test.ts`;
`npm run check:i18n`; `npx tsx scripts/check-license-headers.ts`;
`npm run docs:check` (update `src/engine/INDEX.md` and
`src/engine/simulation/INDEX.md`). One test process at a time. Do not run
`npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, one line per
build section saying what you did, the mutation table, the locale keys added
per file, what the browser spec assumes about the page, and `RISKS`: anything
that surprised you, any rule above you think is wrong (say so rather than
work around it), anything you did not do, and every place where the bar view
can still differ from the flat view's behaviour (selection of a clamp,
zoom-to-model, the zoom window, context loss and restore).
