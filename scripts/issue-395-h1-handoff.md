# Issue #395 slice H1 — review fixes in the engine

You are the implementation worker for a fix slice of issue #395 (an "Around"
face on a round bar). Work only in your task worktree. Do not create, remove,
merge, push or switch branches or worktrees. Do not open a PR. Do not run
`git add` or `git commit`: leave your edits uncommitted and report
`COMMIT: none`. `gh` may be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `src/engine/INDEX.md`, then
in full `src/engine/aroundFrame.ts`, `src/engine/rotaryFrame.ts`,
`src/engine/toolpaths/generateOperation.ts`, `src/engine/setupTargets.ts`
(`setupGenerationBlock`), `src/import/camj.ts` (`setupIdFor` and the merge
intake around it), `src/components/canvas/aroundSheet.ts`,
`src/app/simulationSetup.ts`, `src/store/helpers/aroundFace.test.ts`.
Absolute paths for every write, no `cd`. Smallest change that does the job;
no refactor; match the surrounding code. No `process.` or `globalThis` in
engine code. `node_modules` is a symlink: type-check with
`npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

An independent review of the #395 branch found the defects below; each was
read against the code by the manager. Fix all of them, each with a test that
fails before the fix. Top and Bottom output must stay byte-identical for a
project with no Around content (`legacyMachineParity.test.ts`, the existing
setup tests, unmodified).

Another worker is changing `src/components/viewport3d/**`,
`src/store/helpers/activeFace.ts`, `src/components/feature-tree/**`,
`src/components/cam/**`, `e2e/**`, the `cam`/`featureTree`/`dialogs` locale
files and `src/store/helpers/aroundFace.test.ts`'s last lines at the same
time: **do not touch those** (add your store-level tests in a new file
`src/store/helpers/aroundReview.test.ts` if you need the store).

## 1. Chuck and tailstock bands stop after one circumference

`unrolledProject` spreads a chuck or tailstock across
`[sheetStart, sheetStart + C]` only. Geometry may lie on any turn: on a 40 mm
bar starting at Y30 the band ends at Y155.664, and an engraving at Y175.664
over the tailstock's footprint is the same physical place one turn later, but
lies outside the keep-out. Negative turns likewise.

Rule: a fixture band covers every turn the job can reach. In
`unrolledProject`, the band's across extent runs from one circumference below
the lowest across coordinate of anything on the sheet to one circumference
above the highest (the sheet itself and every Around feature's transformed
bounds), so cutter clearance and lead moves are inside it too. In the Sketch
view (`aroundSheet.ts`) the band is drawn and snapped across the whole
visible range, like the turn lines. Tests: real generation
(`computeOperationToolpath`) of an engrave one turn above and one turn below
the first circumference over a tailstock is kept out / warned exactly as the
same engrave inside the first circumference is; the helper's band for a
visible range that spans three turns.

## 2. The centreline refusal misses depths the operation works out itself

`setupGenerationBlock` refuses when a target feature's stored bottom is at or
below the centreline. But some operations set their own depth: an Engrave
with `carveDepth: 20` on a 40 mm bar cuts at the centreline although its line
is stored 5 deep; a 90° countersink with a 12 mm mouth on a 10 mm bar plunges
6 mm, below the centreline, although its circle is stored 2 deep.

Rule: in the Around branch of `computeOperationToolpath`, after generating on
the flat block and before wrapping, if any **cutting** move (every kind
except `rapid`) of the result reaches flat height `<= 0` (the centreline),
the operation produces no motion and one warning, new code
`aroundCutReachesCentreline`, English: `{operation}: the cut would reach the
bar's centreline. Reduce its depth so it stops short of the middle of the
bar.` Declare it next to `aroundCentreline`; messages in all five locales next
to it (only new keys, each file's own quote style, no existing value
changed); `src/i18n/warningsCoverage.test.ts` must pass. Apply the same check
to the `raw` envelope's refusal (no raw path when refused). Tests: the two
cases above are refused; the same operations one step shallower generate; the
existing stored-bottom refusal still fires first with its own message.

## 3. Around artwork can change a Top or Bottom cut

A Top or Bottom operation is generated on the whole project, Around features
included. Their coordinates are sheet coordinates that can numerically
overlap flat geometry, so pocket island/subtract discovery
(`resolver.ts` `discoverNonTargetSubtracts`, `resolvePocketRegions` and the
like) can fold an Around shape into a Top pocket that never targeted it.

Rule: a flat face and Around exchange nothing. In `computeOperationToolpath`,
an operation that is not in an Around setup is generated on the project
**without** its Around features. One small exported helper (in
`aroundFrame.ts`), which returns the **same object** when the project has no
Around feature, so a project without Around content takes exactly the path it
always did. Use the same helper wherever else a flat face reads the project's
features for geometry: check `src/app/simulationSetup.ts` (a flat setup's
simulation input), and replace the private copy in
`src/engine/designPrint/layout.ts` (`flatFaceProject`) with it if they are the
same thing. Tests: a Top pocket's toolpath and exported program are identical
with and without an overlapping Around subtract and an overlapping Around add
in the project (no Around operation); the helper returns the same object for
a project with no Around feature.

## 4. `.camj` merge re-axes imported Around work

`setupIdFor` gives an imported Around setup the destination bar's axis (and
reuses an existing Around setup whatever its axis) while the imported
features keep their coordinates. Merging a Y-bar engraving into an X-bar
project turns its along-the-bar travel into rotation, silently.

Rule: never re-axis. Around content from the source (its Around setup, the
operations in it and the features with `authoringFace: 'around'`) is imported
only when the destination stock is a round bar lying along the same axis as
the source's Around setup. Otherwise that content is left out, with a warning
through the same mechanism the merge uses when it skips an operation whose
source setup is missing; if that mechanism needs a new message, add it where
those messages live, in all five locales (say which file in the report). The
rest of the source merges as before. Tests: X into X (imported, existing
Around setup reused), Y into X and X into Y (left out, warned, nothing
else lost), an Around source into a block-stock project (left out, warned).

## 5. A stray blank line

`git diff --check` reports a blank line at the end of
`src/store/helpers/aroundFace.test.ts` (line 290). The other worker owns that
file; leave it.

## Mutations

One at a time, restored from a `cp` backup (never `git checkout`); name the
failing test or report a survivor: the band limited to one circumference
again; the motion centreline check removed; the check counting rapids; Around
features left in a flat operation's project; the helper copying a project
that has no Around feature; the merge re-axing instead of leaving out.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
every test file you changed or added, plus `src/engine/aroundFrame.test.ts`,
`src/store/helpers/aroundFace.test.ts`,
`src/engine/gcode/aroundExport.test.ts`, `legacyMachineParity.test.ts`,
`setupExport.test.ts`, `setupPrograms.test.ts`, `src/import/camj.test.ts`,
`src/components/canvas/aroundSheet.test.ts`,
`src/app/aroundSimulation.test.ts`, `src/engine/designPrint/designPrint.test.ts`,
`src/i18n/warningsCoverage.test.ts`, `registry.test.ts`, `catalog.test.ts`;
`npm run check:i18n`; `npx tsx scripts/check-license-headers.ts`;
`npm run docs:check`. One test process at a time. Do not run
`npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, one line per
numbered item saying what you did, the mutation table, the locale keys added
per file, and `RISKS`: anything that surprised you, any rule above you think
is wrong (say so rather than work around it), and anything you did not do.
