# Issue #395 slice E — the Around face in the 3D view and the Simulation tab

You are the implementation worker for slice E of issue #395 (wrapped rotary,
part A: an "Around" face on a round bar). Work only in your task worktree. Do
not create, remove, merge, push or switch branches or worktrees. Do not open a
PR. Do not run `git add` or `git commit`: leave your edits uncommitted and
report `COMMIT: none`. `gh` may be blocked; everything you need is in this file
and in `scripts/issue-395-audit.md`.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`,
`src/components/viewport3d/INDEX.md`, `src/components/simulation/INDEX.md`,
`src/app/INDEX.md`, then `src/engine/aroundFrame.ts` and
`src/engine/rotaryFrame.ts` in full, `src/app/simulationSetup.ts` and its
test, how the 3D view builds the stock solid for a round bar
(`src/engine/csg.ts`, `csgRoundStock.test.ts`) and how it builds toolpath
lines (follow `Viewport3D.tsx` to the line builder), and the audit's sections
"`src/app/`", "CAM, export and simulation components" (simulation lines) and
"3D viewport and setup muting". Absolute paths for every write, no `cd`.
Smallest change that does the job; no refactor; match the surrounding code.
No `process.` or `globalThis` in engine code. `node_modules` is a symlink:
type-check with `npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

## Where things stand

On a round bar the model layer has a third face, `'around'`: features with
`authoringFace: 'around'` live in the coordinates of the bar's surface
unrolled flat (header of `aroundFrame.ts`), with heights stored like a Top
feature's. An operation in an Around setup (`setup.kind === 'around'`) stores
its toolpath **wrapped**: every point is the tool position over the bar's
centreline plus `a`, the angle the bar is turned to. `stockSpacePoint(point,
stock)` (`rotaryFrame.ts`) gives the point of the unturned bar under the tool;
`unrolledProject` / `unwrapToolpath` (`aroundFrame.ts`) give the flat job.

The 3D view and the Simulation tab know none of this. Today an Around feature
would be carved into the top of the bar as if it were a Top feature, an
Around toolpath would be drawn as a line along the centreline, and the
simulation would run wrapped points over the round stock. **This slice fixes
those three.**

Other workers are changing these at the same time, **do not touch them**:
`src/components/canvas/**`, `src/components/layout/**`,
`src/components/feature-tree/**`, `src/components/cam/**`,
`src/components/export/**`, `src/store/**`, `src/engine/gcode/**`,
`src/engine/setupReach.ts`, every locale file, `e2e/selectors.ts`. Yours:
`src/components/viewport3d/**`, `src/components/simulation/**`,
`src/components/toolpathSetupMuting.ts`, `src/app/simulationSetup.ts`,
`src/app/useSimulationModel.ts` and their tests, the 3D feature/solid build
in `src/engine/csg.ts` and the 3D toolpath line builder wherever it lives.

## Approved behaviour (Frank, 2026-10-12)

1. **3D view shows the real bar, always.** Switching the workspace to Around
   does not move the camera the way Bottom does: no preset is applied for
   Around. Remove the `as FlatFace` cast slice A left in `Viewport3D.tsx` by
   handling Around properly there.
2. **Around features are not carved into the 3D solid in this part.** A
   feature with `authoringFace: 'around'` takes no part in the stock solid,
   in feature meshes, in selection or hover highlighting in 3D, whatever face
   is active. (Showing them wrapped on the bar is later work.) Top and Bottom
   features on the same bar are drawn exactly as today.
3. **An Around toolpath is drawn around the bar.** Each point is drawn at
   `stockSpacePoint(point, stock)`. A move whose angle changes is a curve on
   the bar, so it is subdivided for display into pieces of at most 5° of turn
   (interpolating the tool position and the angle linearly, then mapping each
   piece end); a move with a constant angle stays one segment. Colours, move
   kinds, emphasis, selection, muting by setup and the debug markers behave as
   for any other toolpath. A toolpath with no angle is drawn exactly as today,
   from the same buffers (byte-identical line data).
4. **Check it from a low camera angle** in your reasoning and tests: the
   wrapped path must hug the bar all the way round, including underneath
   (`z` below the centreline height), not only look right from above.
5. **Simulation shows the job unrolled and flat.** For an Around setup the
   simulation input is the flat sheet: `unrolledProject(project, frame)` as
   the project (a block one circumference across and one radius thick) and
   `unwrapToolpath` of each of the setup's toolpaths. Everything downstream
   (the height-map cut, "Play tool", the setup picker, completed-stock
   colouring) then runs unchanged on a flat job. Top and Bottom simulation
   inputs are unchanged (same objects where they were the same objects).
   An Around setup whose bar is no longer a round bar on its axis
   (`aroundFrameForOperation` would throw) yields no simulation for that
   setup rather than an exception.

For every site of the audit in your files classed B, or N with "unroll frame
here" or "unclear": apply the audit's recommendation, read through the rules
above, and list it in the report.

## Tests

- `simulationSetup.test.ts`: an Around setup's input is the flat sheet
  (stock box, no `shape`, features lowered) and its toolpaths are unwrapped
  (no `a` on any point, across coordinates spread over the sheet); Top and
  Bottom inputs deep-equal what they are on this branch before your change;
  the picker lists the Around setup; a broken Around setup yields none and
  does not throw.
- The 3D line builder: a wrapped move from `a = 0` to `a = 180` at a constant
  radius becomes at least 36 pieces whose ends all lie at that radius from
  the bar's axis (to 1e-9) and whose last end is on the underside of the bar;
  a constant-angle move stays one segment; an angle-free toolpath produces
  exactly the line data it does on this branch before your change; both bar
  axes.
- The solid build: a project with a Top pocket and an Around pocket on a
  round bar produces the same solid as the same project without the Around
  pocket (compare what the existing round-stock CSG tests compare).
- A browser spec `e2e/around3d.smoke.spec.ts`, registered in the lane file
  `npm run check:e2e-lanes` checks, following the existing 3D and simulation
  specs and seeding the project through the page's store: a round bar, a
  rotary machine, an Around setup with a generated engrave → the 3D view
  renders with no console error and takes a screenshot from the default view
  and one from a low angle (left-drag the panel about −60 px, wheel to zoom);
  the Simulation tab lists the Around setup and runs to completion. You
  cannot run a browser; say it was not run.

Mutations, one at a time, restored from a `cp` backup (never `git checkout`);
name the failing test or report a survivor: the wrapped path drawn without
`stockSpacePoint`; turning moves not subdivided; the Around feature carved
into the solid; the simulation given the wrapped toolpath; the simulation
given the round stock; a camera preset applied for Around.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
every test file you changed or added, plus `src/engine/csgRoundStock.test.ts`,
`src/engine/aroundFrame.test.ts`, `src/engine/rotaryFrame.test.ts`,
`src/app/simulationSetup.test.ts`;
`npx tsx scripts/check-license-headers.ts`; `npm run docs:check`;
`npm run check:e2e-lanes`. One test process at a time. Do not run
`npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, the audit table
for your files (`file — function — what it does for Around now`), the
mutation table, and `RISKS`: anything that surprised you, anything you needed
from another worker's files, any rule above you think is wrong (say so rather
than work around it), any face-dependent site the audit missed, and anything
you did not do.
