# Issue #395 slice F — fixes from the first browser run

You are the implementation worker for slice F of issue #395 (wrapped rotary,
part A: an "Around" face on a round bar). Work only in your task worktree. Do
not create, remove, merge, push or switch branches or worktrees. Do not open a
PR. Do not run `git add` or `git commit`: leave your edits uncommitted and
report `COMMIT: none`. `gh` may be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `e2e/README.md`, then the
three specs `e2e/aroundFace.smoke.spec.ts`, `e2e/aroundSketch.smoke.spec.ts`,
`e2e/around3d.smoke.spec.ts`, and `src/engine/aroundFrame.ts`. Absolute paths
for every write, no `cd`. Smallest change that does the job; no refactor;
match the surrounding code. No `process.` or `globalThis` in engine code.
`node_modules` is a symlink: type-check with
`npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

All five build slices of #395 are merged on your branch. The manager ran the
three new browser specs and looked at screenshots. Results: 5 of 7 tests
pass; the Sketch view shows the unrolled sheet and the unwrapped toolpath
correctly; the 3D view draws a wrapped pocket path on the bar. What is wrong
is below. You cannot run a browser: the manager will run the specs again, so
write them carefully against what the page really does, as described here.

## 1. `e2e/around3d.smoke.spec.ts` tests nothing

a. Its fixture gives the operation `toolRef: 't1'`, but the seeded project's
   only tool has another id (`tool-1`, a 0.25 inch flat endmill), so the
   operation generates **no moves** (`noToolAssigned`) and both tests are
   empty: the "3D view draws the wrapped pass" test passes with no path on
   screen, and the simulation never removes a cell. Fix the fixture: a 3 mm
   flat endmill in mm, referenced by its real id.
b. Neither test waits for generation or asserts that a path exists. After
   seeding, wait for the generation gear to report "up to date"
   (`ui.generation.gearStatus(page)`, as `aroundFace.smoke.spec.ts` does),
   then read the project's generated result the way an existing spec does
   (for example `plasmaKerfPreview.smoke.spec.ts` computes the operation's
   toolpath in the page with `computeOperationToolpath`) and assert: it has
   moves, every point has `a`, and every point's across coordinate is the
   bar's centreline.
c. Add a second Around feature and operation that goes **all the way round**:
   an open line from `(20, sheetStart + 5)` to `(180, sheetStart + 1.5 · C)`
   engraved with the same tool (follow how another spec seeds a follow-line /
   engrave operation). Assert on its generated toolpath that the angles span
   more than 360° and that the stock-space points
   (`stockSpacePoint`, imported in the page like `computeOperationToolpath`)
   include points on the underside of the bar (`z` below the centreline
   height) all at the cut radius. Keep the two screenshots (default view and
   low angle); for the low angle drag **down** as well as sideways
   (about −60 px in x and −120 px in y moves the camera low on this view;
   +y went under the floor) and zoom in.
d. The Simulation test expects the setup picker to list "Around", but the
   picker is not rendered for a project with a single setup (the same as for
   a single Top setup). Give the fixture a Top setup as well, with one small
   Top pocket and operation on the bar, so the picker exists; assert it lists
   both, choose Around, and then assert material is removed
   (`data-simulation-removed-cells > 0`) and the viewport's
   `data-simulation-setup` is the Around setup. Look at how the existing
   simulation specs make an operation count (the toolbar has `Selected` /
   `Visible` modes; with nothing selected the manager's screenshot showed an
   uncut sheet and `Play tool` disabled) and do the same.

## 2. `e2e/aroundFace.smoke.spec.ts` asserts the tree layer too early

`expect(ui.face.layer(page, 'around')).toHaveAttribute('data-face-state',
'active')` runs right after switching to Around on a project with no feature.
The feature tree shows its empty message, not face layers, until the project
has a feature (the same on Bottom). Move that assertion to after the
rectangle is added, where the layer shows `Around 1 ACTIVE`. Everything
before it in that test passed.

## 3. Product defect: "First 2.5D feature must be Add" on an Around feature

With only an Around pocket in the project, the feature tree shows the
warning "First 2.5D feature must be Add. The 3D model will not build until
this is fixed." Around features take no part in the 3D solid (slice E
excludes them in `csg.ts` `buildScene`), so that rule must look only at
flat-face features. Find every place that applies the "first feature must be
add" rule or picks a default operation from it (the tree warning, the solid
build, the default `operation` of a newly drawn feature, any validity check)
and make each ignore features with `authoringFace: 'around'`:

- an Around feature never triggers or satisfies the warning;
- a feature newly drawn on Around defaults to **subtract** (it is a cut into
  the bar's surface), whatever else the project holds;
- Top and Bottom behaviour is unchanged (existing tests untouched).

Add unit tests next to the helper(s) you change, and one assertion in
`aroundFace.smoke.spec.ts` that the warning is absent after the rectangle is
added on Around and that the new feature's `operation` is `subtract`.

## 4. Two small export corrections (`src/engine/gcode/postprocessor.ts`)

- The closing unwind rapid (`G0 A0`, slice C) is written without leaving
  inverse-time mode first. Call the same `leaveInverseTime()` the other
  non-turning blocks use before it, and add a case to
  `src/engine/gcode/aroundExport.test.ts`: a program whose last motion is a
  turning cut writes `G94` before the unwind.
- A comment in `src/engine/gcode/setupPrograms.ts` says "an operator stands
  at the lathe". This is a rotary axis on a router, not a lathe: reword it.

## 5. Print and design SVG export from a flat face

Rule: from Top or Bottom, Print and the design SVG export draw the flat
faces only; features with `authoringFace: 'around'` are left out (their
coordinates are the unrolled sheet's and mean nothing on the bar's
rectangle). Check `src/engine/designPrint/svg.ts` (`buildWorldContent`) and
`src/components/export/PrintDesignDialog.tsx`. If Around features are drawn
today, filter them out at the one place the feature list is chosen. Either
way add a test next to the existing design-print tests: a round bar with one
Top and one Around feature prints only the Top one.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
every test file you changed or added, plus
`src/engine/gcode/aroundExport.test.ts`, `rotaryOutput.test.ts`,
`legacyMachineParity.test.ts`, `src/store/helpers/aroundFace.test.ts`,
`src/engine/csgAroundFace.test.ts`;
`npx playwright test --list e2e/around3d.smoke.spec.ts
e2e/aroundFace.smoke.spec.ts` (it must list the tests without a load error:
do not import app modules that pull JSON into the runner; read
`src/engine/gcode/definitions/grbl.json` with `readFileSync` as the specs now
do); `npx tsx scripts/check-license-headers.ts`; `npm run docs:check`;
`npm run check:e2e-lanes`; `npm run check:i18n`. One test process at a time.
Do not run `npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, one line per
numbered item saying what you found and did (for 3: every site you changed;
for 5: whether Around features were being drawn), and `RISKS`: anything that
surprised you, anything in a spec you could not determine without a browser
(say exactly what you assumed), and anything you did not do.
