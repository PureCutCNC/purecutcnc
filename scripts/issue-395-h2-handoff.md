# Issue #395 slice H2 — review fixes in the 3D view, defaults, wording and browser specs

You are the implementation worker for a fix slice of issue #395 (an "Around"
face on a round bar). Work only in your task worktree. Do not create, remove,
merge, push or switch branches or worktrees. Do not open a PR. Do not run
`git add` or `git commit`: leave your edits uncommitted and report
`COMMIT: none`. `gh` may be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `e2e/README.md`, then
`src/engine/aroundFrame.ts`, `src/components/viewport3d/toolpathOverlay.ts`
and its test, the toolpath part of `src/components/viewport3d/Viewport3D.tsx`,
`src/store/helpers/activeFace.ts` (`newFeatureSpan`), and the three specs
`e2e/aroundFace.smoke.spec.ts`, `e2e/aroundSketch.smoke.spec.ts`,
`e2e/around3d.smoke.spec.ts`. Absolute paths for every write, no `cd`.
Smallest change that does the job; no refactor; match the surrounding code.
`node_modules` is a symlink: type-check with
`npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

An independent review of the #395 branch found the defects below; each was
read against the code by the manager. Fix all of them.

Another worker is changing `src/engine/aroundFrame.ts`,
`src/engine/toolpaths/generateOperation.ts`, `src/engine/setupTargets.ts`,
`src/import/camj.ts`, `src/components/canvas/**`, `src/app/**`,
`src/engine/designPrint/**` and the `warnings` locale files at the same time:
**do not touch those.**

## 1. 3D level filter and rapid classes use the drawn height

A wrapped Around toolpath is drawn at `stockSpacePoint`, and
`buildToolpathOverlay` then applies `movesAtToolpathLevel` and the
retract / non-retract split (`toolpathLayerBuckets`, `moveMatchesZFilter`) to
those **drawn** points. On a 40 mm bar a cut at machining level Z36 is drawn
at Z20 a quarter turn round and Z4 underneath, so selecting level 36 hides
it; a retract underneath the bar goes down on screen and is classed as an
ordinary rapid. The endpoint and direction markers filter the same way.

Rule: classify and filter on the **generated** move (its own `z`: the tool
height over the centreline, which is the machining level), then draw the
stock-space pieces of the moves that remain. So for a wrapped toolpath:
bucket the generated moves (`toolpathLayerBuckets(toolpath)`), filter each
bucket by level on the generated moves, and only then map the surviving
moves through `stockSpaceMoves`. Keep it cached so a scene rebuild does not
redo the mapping (cache the mapped pieces per generated move list). The
markers follow the same order: choose moves by generated level, place them at
stock-space points. An angle-free toolpath must produce exactly the line data
it does today. Extend `toolpathOverlay.test.ts` at the function Viewport3D
calls: a wrapped cut at level 36 going all the way round stays in the `cuts`
bucket when level 36 is selected and every piece is at the cut radius; a
retract at `a = 180` is in `retractions`, not `rapids`; with level 30
selected the level-36 cut is gone. Mutation: filter after mapping again → the
test fails.

## 2. A shape drawn on Around goes to the bottom of the bar

`newFeatureSpan` gives a new Around shape the Top span, whose bottom is `0`:
through the whole bar, far below the centreline. Generation then refuses it
(`aroundCentreline`), so drawing a shape and adding a pocket produces
nothing, and the browser spec did not notice because it only waited for
"up to date".

Rule: a new shape on Around is `1 mm` deep (`0.04 in` in an inch project),
or half the bar's radius if that is less: `z_top = thickness`,
`z_bottom = thickness − depth`. Top and Bottom unchanged. Unit test in the
store test next to the other Around cases
(`src/store/helpers/aroundFace.test.ts`; also remove the stray blank line at
the end of that file that `git diff --check` reports).

## 3. Browser specs that assert too little

- `e2e/aroundFace.smoke.spec.ts`: after "Add to Around" → Pocket → Rough and
  the gear reading "up to date", assert the operation really generated: read
  the project and compute the operation in the page with
  `computeOperationToolpath` the way `e2e/around3d.smoke.spec.ts` does, and
  assert it has moves, no warning, and an angle on every point. In the export
  dialog assert the Around program card shows program text containing a `G1`
  line with the rotary word (find how the existing export specs read the
  preview text).
- `e2e/around3d.smoke.spec.ts`: its numbers come from regenerating the path
  in the test, not from what is drawn; deleting the overlay would not fail
  it. The simulation viewport already publishes `data-simulation-*`
  attributes for specs. Do the same for the 3D toolpath overlay, following
  that pattern exactly (same naming style, set where the overlay objects are
  built): on the 3D panel element, `data-toolpath-segments` (number of line
  segments drawn for toolpaths) and `data-toolpath-min-z` / `-max-z` (lowest
  and highest drawn toolpath point, 3 decimals). Assert in the spec that the
  segment count is at least 100 (the spiral alone is over 100 pieces) and
  that `min-z` is below the centreline height (the path really goes under
  the bar).
- `e2e/aroundSketch.smoke.spec.ts`: the fit test recomputes the transform in
  the test. Read the live view state the way the existing canvas specs do
  and assert the sheet (one circumference across) fits the canvas.

## 4. Wording

- `src/components/feature-tree/PropertiesPanel.tsx` (~1541): a Top feature
  whose linked copies are on Around is told they are on "Bottom". Whenever
  the selected feature's face or any linked copy's face is Around, use the
  generic "another face" keys that already exist
  (`featureTree.face.linkedOtherFace.around.*`).
- `cam.hint.otherFaceFromAround` (all five `cam` locale files; a key added in
  this PR, so its value may change): it says the flat target "is not a cut
  through the stock", but Around refuses through cuts too. English: `{features}
  is drawn on a flat face. An operation on the around face can only machine
  features drawn on the around face.`

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
`src/components/viewport3d/toolpathOverlay.test.ts`,
`src/store/helpers/aroundFace.test.ts`, `src/i18n/registry.test.ts`,
`src/i18n/catalog.test.ts` and any other test file you changed;
`npx playwright test --list e2e/aroundFace.smoke.spec.ts
e2e/aroundSketch.smoke.spec.ts e2e/around3d.smoke.spec.ts` (no load error; do
not import app modules that pull JSON into the runner);
`npm run check:i18n`; `npx tsx scripts/check-license-headers.ts`;
`npm run docs:check`; `npm run check:e2e-lanes`. One test process at a time.
Do not run `npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, one line per
numbered item saying what you did, the mutation result, locale values
changed per file, and `RISKS`: anything that surprised you, anything in a
spec you could not determine without a browser (say exactly what you
assumed), any rule above you think is wrong, and anything you did not do.
