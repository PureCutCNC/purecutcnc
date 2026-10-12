# Issue #393 slice B — an angle on toolpath points, and exporting it

You are the implementation worker for slice B of issue #393 (rotary axis
contract). Work only in your task worktree. Do not create, remove, merge, push
or switch branches or worktrees. Do not open a PR. Do not run `git add` or
`git commit`: leave your edits uncommitted and report `COMMIT: none`. `gh` may
be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md` (the CNC safety contract), `AGENTS.md`,
`src/engine/gcode/INDEX.md`, `ARCHITECTURE.md` §8, `scripts/gcode-conformance/README.md`.
Base branch is `integration/0.6.0`; project format stays `3.3`; no `process.`
or `globalThis` in engine code; absolute paths for every write, no `cd`.
Smallest change that does the job; no refactor.

## What exists (slice A, on your branch)

`src/engine/gcode/types.ts`: optional `rotary` block on `MachineDefinition`
(`about: 'x' | 'y'` the PROJECT axis the bar lies along; `drive: 'own' |
'borrowed'`; `reversed`; `inverseTimeFeed: { on, off } | null`) and the
helpers `rotaryWord(definition)` (`'A'`, or the machine letter of the borrowed
motor, or `null`), `rotaryBorrowedAxis(definition)` (the PROJECT axis whose
linear travel is gone, or `null`) and `rotaryDirection(definition)` (`1 | -1`).
Use them; do not re-derive the mapping. Read `rotaryDefinition.test.ts`.

A round bar (issue #392) is a `Stock` with `shape: 'round'`; in project
coordinates its centreline is at `roundStockCentre(stock)` across the bar and
at Z = `stock.thickness / 2`.

## Why

A rotary axis turns the bar while the tool cuts. No operation produces such
motion yet (that is #395). This slice makes the export pipeline able to carry
and emit it correctly, proven with hand-built toolpaths, so the feature that
follows only has to produce points.

## The contract

`src/engine/toolpaths/types.ts`: `ToolpathPoint` gains

```ts
  /** Degrees the stock is turned to, about the bar's axis, when the tool is at this point. Absent = no rotary component. */
  a?: number
```

Absent everywhere today. Every existing generator, test and fixture stays
valid, and a toolpath with no `a` anywhere must export **byte-identically**
on every machine, including one with a `rotary` block when its motion is
allowed (see rule 3).

## Rules the output must follow (safety-relevant; implement exactly)

1. **Direction and carry.** A point's `a` reaches the program multiplied by
   `rotaryDirection(definition)`, under the letter `rotaryWord(definition)`,
   formatted like any coordinate. The angle is never reduced to 0–360: a move
   from 350 to 370 is emitted as 370. The word is emitted only when the angle
   changes from the last emitted one (modal, like X/Y/Z), and the first
   turning point of a program emits it.
2. **A move whose angle changes is never an arc.** It is emitted as a
   straight feed (or rapid) move and is never merged into `G2`/`G3`, whatever
   the operation's arc-fitting setting. Moves with a constant angle fit arcs
   exactly as today.
3. **A borrowed motor's linear axis is gone.** When `rotaryBorrowedAxis` is
   not `null`, the machine letter `rotaryWord` returns carries the ANGLE, and
   the linear coordinate on that axis is never emitted. An operation whose
   moves differ on that PROJECT axis by more than the export tolerance
   (`exportGeometryTolerance`) cannot run on this machine: it is not exported
   and a warning says why. This applies to every operation on such a machine,
   turning or not.
4. **Feed on a turning move is inverse time.** For a feed move (not a rapid)
   whose angle changes: before it, emit `definition.rotary.inverseTimeFeed.on`
   once (it is modal); on the move, emit the feed word with the value
   `feed / length` in 1/min, where `feed` is the feed the move would have had
   (including `feedScale`) and `length` is the true path length at the cutter
   tip: `sqrt(linear² + (r × Δθ)²)`, `linear` = the straight-line distance over
   the linear axes that move, `Δθ` in radians, `r` = the mean over the move's
   two ends of the tip's distance from the bar's centreline (measured in the
   plane across the bar: the across-axis offset and the height above the
   centreline). `length` is never taken below the export tolerance. **Every**
   inverse-time move carries its own feed word, whatever `modalFeedSpeed`
   says. Before the next feed move whose angle does not change, emit
   `inverseTimeFeed.off` and re-emit the normal feed word. The program never
   ends, changes tool or runs a canned cycle in inverse-time mode: switch off
   first.
5. **Refusals instead of approximations.** An operation is not exported, and a
   warning names it and the reason, when: its toolpath has any `a` and the
   machine has no `rotary` block; it has a feed move whose angle changes and
   `inverseTimeFeed` is `null`; rule 3 is violated; or the project's stock is
   not a round bar while the toolpath has `a` (there is no centreline to
   measure from). Find how an operation is skipped with a warning today
   (`postPlasmaCutSkipped` in `postprocessor.ts`) and use that mechanism with
   new warning codes: `postRotaryNoAxis`, `postRotaryNoInverseTime`,
   `postRotaryBorrowedAxisTravel`, `postRotaryNeedsRoundStock`, each with the
   operation name as its parameter. Add their messages in all five locales
   where warning messages live (find where `postPlasmaCutSkipped` is
   translated); plain wording, e.g. English: "{operation} was not exported:
   this machine has no rotary axis."; "{operation} was not exported: this
   machine's controller has no inverse-time feed, which a turning cut needs.";
   "{operation} was not exported: it moves along {axis}, but that motor
   drives the rotary on this machine."; "{operation} was not exported: a
   turning cut needs round bar stock." Only new keys; no existing value
   changed; each file's own quote style; edit with the edit tool.
6. **ShopBot (`opensbp`) output never carries an angle.** A definition with a
   `rotary` block cannot be `opensbp` (slice A validates that); make the SBP
   emitter path unreachable for `a` by the rule-5 refusal, and leave
   `opensbpEmitter.ts` unedited.

## Where

- `src/engine/gcode/utils.ts` `projectToMachinePoint`: carries `a` through
  (times `rotaryDirection`); for a point with no `a` it returns exactly what
  it returns today (same keys, no `a: undefined`).
- `src/engine/gcode/arcFitting.ts`: rule 2 only (a turning move breaks a run).
  The linear descriptor's `point` keeps `a`.
- `src/engine/gcode/motionPipeline.ts`: the refusal checks and whatever plan
  data the emitter needs for rule 4 (keep the arithmetic in one exported pure
  function, e.g. `inverseTimeFeedValue(from, to, feed, centre, tolerance)`,
  so it can be tested alone).
- `src/engine/gcode/postprocessor.ts`: emitting the word and the feed-mode
  switches. Do not restructure the emitter; follow how X/Y/Z words and the
  feed word are written and suppressed today.
- `src/engine/toolpaths/warningCodes.ts` (or wherever codes are declared) and
  the locale files for the four new warnings.
- `scripts/gcode-conformance/corpus.ts`: add exported rotary cases following
  the existing pattern, so the real controller parsers read them: a
  borrowed-`Y` program with `G93` for the Grbl-family validators, and an `A`
  program with `G93` for the LinuxCNC validator only (plain Grbl rejects `A`).
  Read how a case is restricted to a controller; if it cannot be, say so and
  add only what every validator accepts. Do not run the harness.

## Do not touch

`src/engine/gcode/gcodeMotionParser.ts`, `motionDebug.ts`, `opensbpEmitter.ts`
(slice C reads the word back), any strategy under `src/engine/toolpaths/`
other than the type and the warning codes, `src/components/**`,
`legacyMachineParity.json`, any bundled machine JSON. If one of those needs a
change to compile, STOP and report it.

## Tests (plain `assert` + `npx tsx <file>.test.ts`)

New `src/engine/gcode/rotaryOutput.test.ts` (licence header). Build projects,
machines and toolpaths the way `postprocessor.test.ts` and
`plasmaGcodeOutput.test.ts` do; use a round bar (`roundStock(20, 100, 'x')`),
the bundled `grbl` definition plus a `rotary` block, and hand-built
`ToolpathResult`s. Assert on the emitted program text line by line.

1. **Unchanged:** for every bundled machine, a toolpath with no `a` exports
   the same text with and without the new code path (compare against the
   export of the same input with the `rotary` block absent), and
   `legacyMachineParity.test.ts` passes untouched.
2. Own axis: `G1 X.. A..` words, degrees as given; `reversed` flips the sign;
   the word is modal; 350 → 370 emits `A370`.
3. Borrowed motor: the angle is under `Y`; no linear Y value is ever emitted;
   with `coordinateSystem.yAxis: '-Y'` the sign flips.
4. No arc across a turning move: a toolpath whose points lie on a circle in
   XY and whose angle changes exports only linear moves even with arc fitting
   on and `arcInterpolation: true`; the same points with a constant angle
   still fit an arc.
5. Inverse time: `G93` once before the first turning feed move; every turning
   move has its own `F`; the value equals a hand calculation for (a) a pure
   rotation of 90° with the tip 10 mm from the centreline at feed 600 (compute
   the expected value in the test from first principles: arc length = radius ×
   angle; do not call the implementation), (b) the same at 5 mm, (c) a mixed
   move; `G94` and the
   normal `F` come back before the next non-turning feed move; the program
   ends in `G94`; a rapid turning move has no `F`.
6. `inverseTimeFeedValue` alone: zero rotation equals `feed / linear`; zero
   linear and zero radius is finite (the tolerance floor).
7. Refusals: each of the four cases skips the operation, emits none of its
   motion, and returns its warning code with the operation's name; the other
   operations in the same export are emitted.
8. A flat operation on a borrowed-motor machine: allowed when it never moves
   on the borrowed axis, refused when it does.
9. Mutations, one at a time, restored from a `cp` backup (never
   `git checkout`); name the failing test or report a survivor:
   - the angle is reduced modulo 360;
   - `rotaryDirection` is not applied;
   - a turning move may join an arc;
   - `r` uses only the height (ignores the across-axis offset);
   - the feed word is suppressed as modal in inverse-time mode;
   - `inverseTimeFeed.off` is not emitted before a non-turning feed move;
   - the borrowed axis's linear value is emitted;
   - the no-inverse-time refusal is removed.

Every existing test must pass unchanged. Do not edit, weaken or regenerate an
existing fixture, golden file or assertion; if one fails, STOP and report it.

## Checks to run and report

`npx tsc -b`; `npx eslint` on changed files; `npx tsx` on each test you added
or changed plus `src/engine/gcode/postprocessor.test.ts`,
`motionPipeline.test.ts`, `arcFitting.test.ts`, `legacyMachineParity.test.ts`,
`plasmaGcodeOutput.test.ts`, `setupExport.test.ts`, `trochoidalArcExport.test.ts`,
`opensbpEmitter.test.ts`, `rotaryDefinition.test.ts`,
`src/i18n/registry.test.ts`; `npm run check:i18n`;
`npx tsx scripts/check-license-headers.ts`; `npm run docs:check`. Never more
than one test process at a time. Do not run `npm run build`, `npm test`,
`npm run check:gcode` or any browser test.

## Docs

`src/engine/gcode/INDEX.md` and `ARCHITECTURE.md` §8: the rules above in a
short paragraph. Nothing else.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, the mutation
table, the locale keys added per file, a sample of the emitted text for the
own-axis case and the borrowed-motor case (10 lines each), and `RISKS`:
anything that surprised you; every place besides the ones named that builds or
copies a `ToolpathPoint` field by field and would drop `a` (name file and
function; do not change the ones outside this slice's files); anything the
parser slice or a wrap strategy will trip over; anything you did not do.
