# Issue #395 slice D2 — the Sketch view on the Around face

You are the implementation worker for slice D2 of issue #395 (wrapped rotary,
part A: an "Around" face on a round bar). Work only in your task worktree. Do
not create, remove, merge, push or switch branches or worktrees. Do not open a
PR. Do not run `git add` or `git commit`: leave your edits uncommitted and
report `COMMIT: none`. `gh` may be blocked; everything you need is in this file
and in `scripts/issue-395-audit.md`.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`,
`src/components/canvas/INDEX.md`, then the section "`src/components/canvas/`"
of `scripts/issue-395-audit.md`, `src/engine/aroundFrame.ts` in full,
`src/store/helpers/activeFace.ts`, `src/components/canvas/viewTransform.ts`,
`src/components/canvas/faceOverlay.ts`,
`src/components/canvas/renderSketchToolpaths.ts`,
`src/components/canvas/operationSnapshot.ts`, and how `SketchCanvas.tsx`
draws the stock outline, clamps, tabs and the origin marker. Absolute paths
for every write, no `cd`. Smallest change that does the job; no refactor;
match the surrounding code. `node_modules` is a symlink: type-check with
`npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

## Where things stand

The model layer knows a third face, `'around'`, on a round bar
(`activeFace(project) === 'around'`). A feature drawn on it has
`authoringFace: 'around'`, and its plan coordinates are those of **the bar's
surface unrolled flat** (see the header of `aroundFrame.ts`):

- along the bar it keeps the bar's own extent;
- across, the sheet runs from `sheetStart` (the bar's minimum across
  coordinate) for one circumference `C = π · diameter`;
- X and Y are never swapped: a bar along X gives a sheet as long as the bar
  and one circumference tall; a bar along Y gives one circumference wide and
  as tall as the bar is long;
- geometry may lie beyond one circumference: more distance is more rotation.

`aroundFrame(stock)` gives `sheetStart` and `circumference`. An Around
operation's stored toolpath is **wrapped**: every point is
`{ along, across = the centreline, z, a }`; `unwrapPoint` /
`unwrapToolpath` give it back on the sheet.

The Sketch canvas knows none of this: with Around active it still draws the
bar's own rectangle (one diameter across) and treats the view as Top or as a
Bottom mirror. **This slice makes the Sketch view show and edit the unrolled
sheet.**

Other workers are changing these at the same time, **do not touch them**:
`src/components/layout/**`, `src/components/feature-tree/**`,
`src/components/cam/**`, `src/components/export/**`,
`src/components/viewport3d/**`, `src/components/simulation/**`,
`src/app/**`, `src/store/**`, `src/engine/**` (read only, including
`aroundFrame.ts`), every locale file, `e2e/selectors.ts`. Yours:
`src/components/canvas/**` and its tests, and a new browser spec file. If you
need a string, a store helper or a selector, STOP and report it.

## Approved behaviour (Frank, 2026-10-12)

With Around as the active face:

1. **The stock outline is the sheet**, not the bar: the rectangle
   `[bar extent along] × [sheetStart, sheetStart + C]`. Fit-to-view fits the
   sheet. The view is never mirrored (Around is not a flip): every
   mirror/handedness helper behaves as for Top.
2. **Turn lines.** A thin line across the sheet at every full turn
   (`sheetStart + k · C`, every integer `k` in view, including beyond the
   sheet), in the stock outline's colour at reduced opacity, dashed. The two
   at `k = 0` and `k = 1` coincide with the sheet's edges; `k = 0` (the top of
   the bar when the rotary is at zero) is drawn solid so it reads as the start
   line. No text label.
3. **Only Around features are drawn.** Features of Top and Bottom are not
   shown on Around at all, also with "other side" on, and are not hit, snapped
   to or offered as references. On Top and Bottom, Around features are not
   drawn either (no ghost): a flat face and Around share no plane.
4. **Clamps.** A chuck or tailstock is drawn as a band: its extent along the
   bar, the whole sheet across. Other clamp types and all tabs are not drawn.
5. **Origin marker** at the origin's along coordinate, on the start line
   (`across = sheetStart`).
6. **Toolpaths.** An Around operation's toolpath is drawn unwrapped, on the
   sheet, with the same colours, emphasis and muting rules as any other.
   Toolpaths of Top/Bottom setups are not drawn while Around is active, and
   Around toolpaths are not drawn on Top or Bottom (wrapped, they would be a
   single line along the centreline).
7. **Drawing, editing, snapping, dimensions, box selection, the context
   menu, text placement, SVG/DXF placement** all work in sheet coordinates
   exactly as on Top. Imported-model top views are not drawn on Around.
8. **Feature info labels** show an Around feature's heights the way Top's
   are shown.
9. **The operation snapshot** (`operationSnapshot.ts`, used by the setup
   booklet) of an Around operation shows the sheet and the unwrapped
   toolpath, not the bar's rectangle.
10. `EditSketchPanel`'s linked-copy warning must not call another face "Top"
    when the active face is Around: reuse the wording keys that exist; if none
    fits without a new string, leave the warning out on Around and report it.

For every site in the audit's canvas section classed B, or N with "unroll
frame here" or "unclear": apply the audit's recommendation, read through the
rules above. Sites marked "same as Top is actually correct" need a check that
they in fact take the Top path for Around, and a line in the report.

Keep one rule for where the sheet comes from: a small pure helper in
`src/components/canvas/` (for example `aroundSheet.ts`) that, given the
project, returns `null` unless the active face is Around on a round bar, and
otherwise the sheet rectangle, the turn-line positions for a visible range,
the clamp bands and the origin marker position. Everything above reads from
it. Unit-test it.

## Tests

- `aroundSheet` helper: both bar axes, an off-origin bar, an inch bar; turn
  lines for a visible range that starts before the sheet and ends two turns
  after; clamp bands; origin marker; `null` on Top, on Bottom and on a block
  stock.
- `viewTransform` tests: Around is unmirrored and fits the sheet; Top and
  Bottom results unchanged (existing assertions untouched).
- Whatever pure pieces you add for feature filtering and toolpath
  unwrapping, tested next to them.
- A browser spec `e2e/aroundSketch.smoke.spec.ts`, registered in the lane
  file `npm run check:e2e-lanes` checks, following the existing canvas specs
  and seeding the project through the page's store the way they do (do not
  depend on a face-switch button: another worker is adding it; set the active
  face through the store helper `switchWorkspaceFace('around')` exposed the
  way existing specs reach the store): a round bar with a rotary machine,
  Around active → the canvas shows a sheet one circumference tall (assert
  through the same test hooks or exposed view state the existing canvas
  specs use, not pixels); draw a rectangle by pointer → the feature is
  stamped `'around'` with sheet coordinates; a Top feature present in the
  project is not hit when clicking where it would be; switch to Top → the
  Around rectangle is not hit there. You cannot run a browser; say it was not
  run.

Mutations, one at a time, restored from a `cp` backup (never `git checkout`);
name the failing test or report a survivor: the sheet one diameter tall
instead of one circumference; the view mirrored as for Bottom; turn lines
only inside the sheet; Top features drawn or hit on Around; an Around
toolpath drawn without unwrapping; the clamp band keeping its own across
extent.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
every test file you changed or added and the existing tests of every canvas
module you changed; `npx tsx scripts/check-license-headers.ts`;
`npm run docs:check`; `npm run check:e2e-lanes`. One test process at a time.
Do not run `npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, **the audit
table** for `src/components/canvas/` (one line per site:
`file — function — what it does for Around now`), the mutation table, and
`RISKS`: anything that surprised you, anything you needed from another
worker's files, any rule above you think is wrong (say so rather than work
around it), any face-dependent canvas site the audit missed, and anything you
did not do.
