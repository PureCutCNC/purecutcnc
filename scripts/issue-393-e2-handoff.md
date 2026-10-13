# Issue #393 slice E2 — review fixes outside the export pipeline

You are the implementation worker for a fix slice of issue #393 (rotary axis
contract). Work only in your task worktree. Do not create, remove, merge, push
or switch branches or worktrees. Do not open a PR. Do not run `git add` or
`git commit`: leave your edits uncommitted and report `COMMIT: none`. `gh` may
be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, then
`src/engine/toolpaths/types.ts` (`ToolpathPoint.a`) and
`src/engine/rotaryFrame.ts`. Absolute paths for every write, no `cd`. Smallest
change that does the job; no refactor; match the surrounding code. No
`process.` or `globalThis` in engine code. `node_modules` is a symlink:
type-check with `npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

Background: #393 added an optional `a` (degrees the stock is turned to) to
every toolpath point. Absent means no rotary component, and **absent is not
zero**. An independent review found places that drop or misread it. Fix all of
them, each with a test that fails before the fix. A toolpath with no angle
anywhere must behave and serialise exactly as before (byte-identical buffers,
identical results).

Another worker is changing `src/engine/gcode/motionPipeline.ts`,
`postprocessor.ts`, `rotaryOutput.test.ts`, `rotaryDefinition.test.ts`,
`scripts/gcode-conformance/**` and the locale files at the same time: **do not
touch those.**

## 1. Worker transport drops the angle

`src/app/toolpathGeneration/moveTransport.ts` (`packMoves` / `unpackMoves`)
carries only XYZ, so a toolpath generated in the worker reaches the app with
no angles: export then loses the rotation, the inverse-time feed and the
refusals. Carry both end points' `a` through, exactly: absent stays absent
(no `a` key), `0` stays `0`, negative values and values past 360 unchanged,
full double precision. A toolpath with no angle on any point must pack to the
same bytes and layout it does today (add the angle data only when at least
one point has one). Extend the transfer validation and
`moveTransport.test.ts`: an exact round trip for absent / 0 / −45 / 900 /
mixed within one toolpath, and the existing "every declared move kind
round-trips" case given angles.

## 2. Clamp lifts and tab splits drop the angle

- `src/engine/toolpaths/clamps.ts` (`liftRapidMove`, ~206–212): the lift and
  traverse points it synthesises have no `a`. Rule: lift at the start angle,
  traverse to the target angle at the safe height, descend at the target
  angle. Points gain `a` only when the move they come from has one.
- `src/engine/toolpaths/tabs.ts` (`pointAt` ~322, and ~416) and
  `tabSmoothing.ts` (`splitCutMoveWithSmoothTabs` ~446): a cut split at a tab
  gets end points with no `a`. Rule: interpolate the angle linearly at the
  split fraction (no reduction to 0–360); the vertical moves up and down a
  tab keep the angle of the point they stand on.

Tests: a turning rapid over a clamp (with and without a final descent) and a
turning cut across a rectangular and a smooth tab keep every angle and end at
the target angle; the same inputs with no angle produce exactly today's
output (`deepStrictEqual` against the result on this branch before your
change, with no `a` key on any point).

## 3. Waterline simplification would merge angles away

`src/engine/toolpaths/finishSurfaceWaterline.ts`
(`simplifyContiguousCutMoves`, ~1351) deletes zero-XYZ-length moves and
merges collinear cuts by XYZ only. Its generator produces no angles today;
make it safe anyway: a move whose two ends differ in `a` is never dropped as
zero-length, and two cuts are merged only when the angle is absent on all
their points. Add a test for both, and one showing an angle-free input
simplifies exactly as before.

## 4. Reading inverse-time feed back

`src/engine/gcode/gcodeMotionParser.ts` (~371) keeps the inverse-time `F`
modally, so this program is reported as verified with `F2` on both cuts:

```
G0 A0
G93
G1 A90 F2
G1 A180
```

A real controller rejects the second `G1`: in inverse-time mode every feed
block needs its own `F`. Rule: the feed mode (`G93`/`G94`) is modal; the
inverse-time `F` is not. A feed move (`G1`/`G2`/`G3`) in inverse-time mode
with no positive `F` on its own block is reported the way this parser reports
other unverifiable input (follow the existing downgrade path; do not invent a
new one), and an `F` on a line of its own before the move does not count.
Tests in `gcodeMotionParser.test.ts` for the program above, for a standalone
`F` line, and for a correct program still parsing as before.

Also in `src/engine/gcode/motionDebug.test.ts` (~261): the inverse-time case
only counts moves. Assert the `inverseTimeFeed` value read back on each
turning move against the exported number.

Do **not** add a feed or speed display to the exported-motion view: it shows
no feed for any move today, and that stays so.

## Do not touch

The other worker's files listed above; `src/engine/rotaryFrame.ts` (read
only); `src/types/**`; `src/store/**`; `src/components/**`. If something
there needs a change, STOP and report it.

## Mutations

One at a time, restored from a `cp` backup (never `git checkout`); name the
failing test or report a survivor: transport drops `to.a`; transport turns an
absent angle into `0`; the clamp traverse keeps the start angle; a tab split
copies the start angle instead of interpolating; the waterline merge ignores
angles; the parser reuses the previous block's inverse-time `F`.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
every test file you changed plus
`src/engine/toolpaths/clamps.test.ts`, `clampAvoidance.test.ts`, the tab
tests next to `tabs.ts` and `tabSmoothing.ts`,
`src/engine/gcode/gcodeMotionParser.test.ts`, `motionDebug.test.ts`,
`src/app/toolpathGeneration/moveTransport.test.ts`;
`npx tsx scripts/check-license-headers.ts`; `npm run docs:check`. One test
process at a time. Do not run `npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, one line per
numbered finding saying what you did, the mutation table, and `RISKS`:
anything that surprised you, any rule above you think is wrong (say so rather
than work around it), and anything you did not do.
