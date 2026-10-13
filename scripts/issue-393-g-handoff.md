# Issue #393 slice G — fixes from the re-review

You are the implementation worker for a fix slice of issue #393 (rotary axis
contract). Work only in your task worktree. Do not create, remove, merge, push
or switch branches or worktrees. Do not open a PR. Do not run `git add` or
`git commit`: leave your edits uncommitted and report `COMMIT: none`. `gh` may
be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `src/engine/gcode/INDEX.md`,
then in full `src/engine/rotaryFrame.ts`, the "Rotary axis (#393)" part of
`src/engine/gcode/motionPipeline.ts`, the rotary parts of
`src/engine/gcode/postprocessor.ts`, `src/engine/gcode/rotaryOutput.test.ts`,
and `src/app/toolpathGeneration/moveTransport.ts`. Absolute paths for every
write, no `cd`. Smallest change that does the job; no refactor; match the
surrounding code. No `process.` or `globalThis` in engine code. `node_modules`
is a symlink: type-check with `npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

An independent re-review of the #393 fixes found the defects below; each was
read against the code by the manager. Fix all of them, each with a test that
fails before the fix. **A machine with no `rotary` block and a toolpath with
no angle must still export byte-identically** (`legacyMachineParity.test.ts`
green and untouched).

## 1. The template check must judge what is actually written

`borrowedLetterInTemplates` scans the definition's **raw** template strings.
Missed: `G0 Y{feed}` renders to `G0 Y600` and turns the bar; `Y 0` (a space
between letter and value) is a valid word and escapes the regex; a line that
starts with a parenthesised comment, `(position) G0 Y0`, is skipped whole. And
it refuses on a command that is never written (a `pauseCommand` of `G0 Y0`
with `pauseAfterChange: false`).

It also covers only a borrowed motor. On a machine with its own axis, a
tool-change template that writes `G0 A0` turns the bar behind the planner's
back: operation one ends at `A90`, the tool change runs `G0 A0`, operation
two's opening rapid to `A90` writes no angle word because the emitter still
believes it is at `A90`, and the second operation cuts at the wrong angle.

Rule: **no line that comes from a machine template may carry the machine's
rotary word** (`rotaryWord(definition)`: `A`, or the borrowed motor's letter),
judged on the **rendered** text of the lines the program **actually writes**,
comments removed (a leading or embedded `( … )` comment and anything after
the line-comment prefix are prose; code after a parenthesised comment is
code), with optional whitespace between the letter and its value.

- Borrowed motor: any such line refuses the whole program
  (`postRotaryTemplateUsesBorrowedAxis`), as today.
- Own axis: such a line refuses the whole program when any exported operation
  carries an angle (same warning code; reword its message in all five locales
  so it reads right for both cases: "The machine's templates write {axis},
  the word that turns the rotary on this machine. Remove it from the
  machine's templates before exporting."). A program with no angle anywhere on
  an own-axis machine is exported as today.

Decide it from the program text the emitter produces, not from a second
guess at what it will produce: the emitter knows which lines it writes from
templates. If that means emitting first and refusing afterwards, the refused
result must contain no program text. Tests: the three missed spellings, the
inactive pause command (exported, no warning), the own-axis two-tool sequence
above (refused), an own-axis angle-free program with `G0 A0` in a template
(exported unchanged).

## 2. A feed move with an angle on one end only

After a rapid establishes `A90`, a cut from `{…, a: 90}` to a point with no
`a` passes angle tracking; feed planning then reads the absent angle as 0,
computes inverse-time feed for a 90° turn, and the emitter writes no angle
word: the bar stays at `A90` and the cut runs at the wrong speed.

Rule, one place, used by tracking, by "does this move turn" and by the
length: **a feed move or arc must carry `a` on both ends or on neither.** One
end only makes the operation refused with `postRotaryAngleNotEstablished`. A
rapid may still go from a point with no angle to one with an angle (that is
how the first angle is established). Do not change `tabs.ts`,
`tabSmoothing.ts` or `clamps.ts`. Tests: both one-end arrangements refused,
with inverse-time available and with `inverseTimeFeed: null`.

## 3. The path-length quadrature is wrong where the tip speed touches zero

`stockFramePathLength` uses a fixed 32-point Gauss-Legendre rule on
`sqrt(alpha·t² + beta·t + gamma)`. When the quadratic touches zero inside
(0, 1) the integrand has a corner and the rule is off by 8e-4. Case to use as
a test (bar along X, centreline at Y10 / Z10, feed 600):
from `{x:0, y:0, z: 10 − 10/π, a: 0}` to `{x:0, y:20, z: 10 − 10/π, a: 360}`.
The speed is `40π·|t − ½|`, the length exactly `10π = 31.4159265359`, so the
word is `F19.099`; today it writes `F19.084`.

Rule: relative error under 1e-9 for every move, including a zero or a
near-zero of the speed inside the move. Suggested: with
`t* = −beta / (2·alpha)` and `m = gamma − beta² / (4·alpha)` (the minimum of
the quadratic, clamped at 0), integrate `sqrt(alpha·u² + m)` in `u = t − t*`
with its closed form
`(u/2)·sqrt(alpha·u² + m) + (m / (2·sqrt(alpha)))·asinh(u·sqrt(alpha / m))`,
taking the `m → 0` limit `sqrt(alpha)·u·|u| / 2` when `m` is negligible
against `alpha·u²`, and keeping the existing constant-speed fast path when
`alpha` is zero (so constant-radius moves still write the word they write
today). Whatever you choose, test against the brute-force polyline built from
`stockSpacePoint` for: the cusp case above, the same case with the zero just
outside each end, a near-miss (minimum speed 1e-6 of the maximum), the
existing cases in the test, and a long move with 3600° of sweep.

## 4. `G94` before the spindle-stop and tool-change output

When the last motion of an operation is a turning cut, the program writes
the spindle-off command (and, before a tool change, the change sequence)
while still in `G93`, and restores `G94` after. Leave inverse-time mode
before that output. The existing tests filter to motion lines and do not see
`M5`: assert the order on the raw program lines, for the program end and for
a tool change.

## 5. Transport validation (`src/app/toolpathGeneration/moveTransport.ts`)

`isPackedMoves` accepts angle arrays whose slots are not strictly increasing,
repeat, or lie outside `0 … count·2 − 1`, and non-finite values; `unpackMoves`
then silently drops angles. Require strictly increasing, in-range slots and
finite values. Refuse to pack more than `2^31 − 1` moves with angles (the
slot would overflow a `Uint32`); a clear thrown error is enough. Tests for
each malformed shape.

## 6. Drill cycles with no expanded moves

On a borrowed-motor machine an operation with `drillCycles` and no `moves` is
refused with `postRotaryBorrowedAxisTravel`, whose message talks about travel
it does not have. Give it its own code `postRotaryDrillNotExpanded`, English:
`Operation "{operation}" was not exported: its drilling has no expanded
moves, and canned cycles cannot be used on a machine whose rotary borrows a
motor.` Declare it with the other `postRotary*` codes; messages in all five
locales next to theirs (only new keys, each file's own quote style, no
existing value changed apart from the rewording in 1);
`src/i18n/warningsCoverage.test.ts` must pass.

## 7. Tests that pass with the rule broken

`rotaryOutput.test.ts` constant-angle arc cases (near lines 385 and 1068)
check that arcs exist and the planner accepts them, not that the angle was
written first. Assert that an `A45` rapid precedes the first arc in the
program text, and that the program read back with `parseGcodeMotion` has
every arc at 45°. Mutation: drop the angle word from that rapid.

## Do not touch

`src/engine/rotaryFrame.ts` (read only), `src/engine/toolpaths/tabs.ts`,
`tabSmoothing.ts`, `clamps.ts`, `src/types/**`, `src/store/**`,
`src/components/**`, bundled machine JSON, `legacyMachineParity.json`. If
something there needs a change, STOP and report it.

## Mutations

One at a time, restored from a `cp` backup (never `git checkout`); name the
failing test or report a survivor: the template check scanning raw strings
again; whitespace between letter and value not recognised; the own-axis
template check removed; a one-end-only feed move accepted; the 32-point rule
put back; `leaveInverseTime` before the spindle stop removed; the
strictly-increasing check removed; the arc-establishing angle word dropped.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
`src/engine/gcode/rotaryOutput.test.ts`, `rotaryDefinition.test.ts`,
`motionPipeline.test.ts`, `legacyMachineParity.test.ts`,
`gcodeMotionParser.test.ts`, `motionDebug.test.ts`,
`src/engine/rotaryFrame.test.ts`,
`src/app/toolpathGeneration/moveTransport.test.ts`,
`scripts/gcode-conformance/corpus.test.ts`,
`src/i18n/warningsCoverage.test.ts`, `registry.test.ts`, `catalog.test.ts`,
and every other test file under `src/engine/gcode/`; `npm run check:i18n`;
`npx tsx scripts/check-license-headers.ts`; `npm run docs:check`. One test
process at a time. Do not run `npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, one line per
numbered item saying what you did, the mutation table, the locale keys added
or reworded per file, and `RISKS`: anything that surprised you, any rule above
you think is wrong (say so rather than work around it), and anything you did
not do.
