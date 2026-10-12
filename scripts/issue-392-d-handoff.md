# Issue #392 slice D — drawing the bar and its chuck

You are the implementation worker for slice D of issue #392 (cylindrical
stock). Work only in your task worktree. Do not create, remove, merge, push or
switch branches or worktrees. Do not open a PR. Do not run `git add` or
`git commit`: leave your edits uncommitted and report `COMMIT: none`. `gh` may
be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `src/engine/INDEX.md`,
`src/components/canvas/INDEX.md` if present. Base branch is
`integration/0.6.0`; project format stays `3.3`; no `process.` or `globalThis`
in engine code; absolute paths for every write, no `cd`. Smallest change that
does the job; no refactor; match the surrounding code.

## What exists (slices A–C, already on your branch)

- `src/types/project.ts`: a round bar is a `Stock` with `shape: 'round'` and
  `axis: 'x' | 'y'`; its `profile` is the rectangle it shows from above
  (length along `axis`, diameter across) and `thickness` IS the diameter.
  Helpers: `isRoundStock`, `roundStockDiameter`, `roundStockLength`,
  `roundStockCentre` (the centreline's coordinate across the bar). In project
  coordinates the bar occupies Z from 0 to the diameter, so its centreline is
  at Z = diameter / 2.
- `ClampType` has `'chuck'` and `'tailstock'`. On a bar these are round about
  the bar's axis: `src/store/helpers/roundWorkholding.ts` keeps their
  rectangle centred on the centreline and `height` = bar radius + own radius;
  their own diameter is their size across the axis (`h` for axis `'x'`, `w`
  for axis `'y'`), their extent along the axis is the rectangle's other side.
  The rectangle deliberately reaches past the bar's end.

Today the 3D view draws the bar as a square block and a chuck as a box. This
slice is drawing only. **No store, format, toolpath, G-code, simulation-grid
or locale change.** The 3D model built from features (`buildBooleanModel`) is
NOT changed: features are not cut into the bar.

## What to build

### 1. The bar in 3D — `src/engine/csg.ts`

`buildStockMesh` and `buildStockWireframe`: for a round bar draw a cylinder of
the bar's diameter and length, lying along its axis, on the centreline, with
its centre at Z = diameter / 2 (project coordinates). Same material, colour,
opacity and `visible` handling as the block. Block stock: exactly today's
geometry, untouched code path.

- Read how the block mesh maps project coordinates into the Three scene
  (`rotateX(-Math.PI / 2)` on the extrusion, then `mesh.scale.z = -1`) and
  make the cylinder land in the same frame: the cylinder's bounding box in the
  scene must equal the block mesh's bounding box for the same stock.
- 64 segments around. The wireframe for a bar is the two end circles plus four
  lines along the bar (top, bottom and the two sides), built explicitly; do
  not run `EdgesGeometry` over the faceted cylinder (it would draw every
  facet edge).

### 2. Chuck and tailstock in 3D — `buildClampMesh` in `src/engine/csg.ts`

Add an optional last parameter `stock?: Stock`. When the clamp's type is
`'chuck'` or `'tailstock'` AND `stock` is a round bar, draw a cylinder about
the bar's axis: its diameter is the clamp's own diameter, its extent along the
axis is the clamp rectangle's, its centre is on the bar's centreline at
Z = bar diameter / 2. Everything else (any other clamp type, a block, no
`stock` passed) draws exactly today's box. Material and `applyClampHighlight`
unchanged.

Pass the project's stock at both call sites: `buildScene` in `csg.ts` and
`src/components/simulation/SimulationViewport.tsx`. Do not change
`buildClampClearanceBox`: the wireframe box is the volume the engine checks
and must stay a box.

Do not import from `src/store/` into `src/engine/`: the axis rule (own
diameter = `h` for axis `'x'`, `w` for axis `'y'`) is two lines; write it in
`csg.ts` with a comment naming `roundWorkholding.ts` as the place that
enforces it.

### 3. The bar in the Sketch view — `src/components/canvas/scenePrimitives.ts`

`drawStockOutline`: for a round bar, also draw the centreline along the axis
(a dash-dot line across the whole length, in the stock outline's colour, thin)
and put `Ø` in front of the across-axis dimension label. Blocks unchanged.

## Do not touch

`src/engine/toolpaths/**`, `src/engine/gcode/**`, `src/engine/simulation/**`,
`src/machine/**`, `src/store/**`, `src/i18n/**`, `buildBooleanModel` and
`buildFeatureSolid` in `csg.ts`. If something there fails to compile, STOP and
report it.

## Tests

New `src/engine/csgRoundStock.test.ts` (plain `assert`, licence header; see
`src/engine/csgRenderHeight.test.ts` for how csg is tested in node and how a
palette is supplied). Apply the mesh's own transform (`updateMatrixWorld`,
`Box3().setFromObject`) before measuring.

- For `roundStock(20, 100, 'x', { x: 5, y: 7 })` and the `'y'` equivalent:
  the bar mesh's scene bounding box equals the scene bounding box of the block
  mesh built from the same stock with `shape`/`axis` removed (within 1e-6);
  every lateral vertex is one radius from the centreline (within 1e-6); the
  wireframe's bounding box is the same box.
- A block stock: `buildStockMesh` gives the same position array as before your
  change (build the expected array the way the current code does) and the same
  for `buildStockWireframe`.
- A chuck on that bar: its mesh's scene bounding box is the clamp's extent
  along the axis × its own diameter across × its own diameter in Z, centred on
  the centreline at half the bar's diameter. Same for axis `'y'` and for a
  tailstock.
- A `step_clamp` on a bar, a chuck with no `stock` passed, and a chuck on a
  block all give today's box (compare position arrays with a box built the
  current way).

If `scenePrimitives.ts` has a node test with a fake 2D context, add: a bar
draws one extra dash-dot line on the centreline and a `Ø` label; a block draws
neither. If it has none, say so and leave the Sketch part to the browser spec.

Browser spec: extend `e2e/roundStock.smoke.spec.ts` with one test that
switches to Round bar, opens the 3D view and asserts no console error and that
the scene built (whatever the existing 3D specs, e.g.
`e2e/viewportViews.smoke.spec.ts`, assert to prove a scene rendered). You
cannot run a browser; say it was not run.

Every existing test must pass unchanged; do not edit, weaken or regenerate an
existing fixture, golden file or assertion. If one fails, STOP and report it.

Mutations, one at a time, restored from a `cp` backup (never `git checkout`);
name the failing test or report a survivor:

- the bar's radius is the diameter;
- the bar is drawn along the wrong axis;
- the bar's centre is at Z = 0;
- the chuck's centre is at Z = 0;
- a `step_clamp` on a bar is drawn as a cylinder.

## Checks to run and report

`npx tsc -b`; `npx eslint` on changed files; `npx tsx` on each test you added
or changed plus `src/engine/csgRenderHeight.test.ts` and
`src/engine/viewport3dSelectionDecoupling.test.ts`;
`npx tsx scripts/check-license-headers.ts`; `npm run docs:check`. Never more
than one test process at a time. Do not run `npm run build`, `npm test` or any
browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, the mutation
table, and `RISKS`: anything that surprised you; whether the 3D camera fit or
the Sketch "fit" includes clamps (the chuck reaches past the bar) and what
that does to the default view; every other place that draws the stock or a
clamp as a box that you did NOT change (name file and function); anything you
did not do.
