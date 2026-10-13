# Issue #393 slice E1 — review fixes in the export pipeline

You are the implementation worker for a fix slice of issue #393 (rotary axis
contract). Work only in your task worktree. Do not create, remove, merge, push
or switch branches or worktrees. Do not open a PR. Do not run `git add` or
`git commit`: leave your edits uncommitted and report `COMMIT: none`. `gh` may
be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `src/engine/gcode/INDEX.md`
(if present), then in full `src/engine/rotaryFrame.ts`, the "Rotary axis
(#393)" part of `src/engine/gcode/motionPipeline.ts`, the rotary parts of
`src/engine/gcode/postprocessor.ts`, and `src/engine/gcode/rotaryOutput.test.ts`.
Absolute paths for every write, no `cd`. Smallest change that does the job; no
refactor; match the surrounding code. No `process.` or `globalThis` in engine
code. `node_modules` is a symlink: type-check with
`npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

An independent review of the #393 branch found the defects below. Each was
checked against the code by the manager. Fix all of them, each with a test
that fails before the fix. **A machine with no `rotary` block and a toolpath
with no angle must still export byte-identically**
(`legacyMachineParity.test.ts` and the conformance corpus stay green and
untouched, except for output that carries a rotary word).

Another worker is fixing `src/app/toolpathGeneration/moveTransport.ts`,
`src/engine/toolpaths/clamps.ts`, `tabs.ts`, `tabSmoothing.ts`,
`finishSurfaceWaterline.ts`, `gcodeMotionParser.ts`, `motionDebug.ts` and
their tests at the same time: **do not touch those files.**

## 1. The borrowed axis can still receive linear travel

Today `rotaryRefusal` checks, per operation, that the borrowed project axis
does not move within that operation's `moves`. Missed:

a. **Between operations.** Two operations each constant on the borrowed axis,
   at different values, both pass, and the travel between them is silently
   dropped. Rule: on a borrowed-motor machine the borrowed coordinate is one
   value for the whole program. Keep the first exported operation's value;
   refuse (`postRotaryBorrowedAxisTravel`) every later operation that is not
   at it, within `exportGeometryTolerance`.
b. **Canned drill cycles.** Cycle positioning and `G81`-style blocks write
   the borrowed letter as a linear coordinate, and an operation with empty
   `moves` and populated `drillCycles` skips the check. Rule: an operation is
   written with canned cycles only when the machine has no borrowed motor
   **and** its toolpath carries no angle anywhere; otherwise its expanded
   `moves` are used, exactly as on a machine with canned cycles off. The
   borrowed-axis check must also cover `drillCycles` positions. An operation
   on such a machine with `drillCycles` but no moves to expand is refused.
c. **Templates.** A header, footer, tool-change or other template line that
   contains the borrowed machine letter as an axis word (for example
   `G0 X0 Y0`, `G53 G0 Y0`, `G92 Y0` on a machine whose rotary borrows Y)
   would turn or re-zero the bar. Rule: on a borrowed-motor machine, if any
   rendered template line outside a comment carries that letter as a word,
   every operation is refused with a new warning code
   `postRotaryTemplateUsesBorrowedAxis` whose message names the letter and
   says to remove it from the machine's templates. Add the code where the
   other `postRotary*` codes are declared and its message in all five locales
   next to theirs (only new keys, each file's own quote style, no existing
   value changed; `src/i18n/warningsCoverage.test.ts` must pass).

## 2. The angle the controller is at is never reconciled

The emitter writes the angle word from each move's end point but nothing
checks the start. Failing cases: a constant-angle operation of fitted arcs at
`a = 45` never writes `A45` at all (`emitArcLine` writes no angle), so it cuts
at whatever angle the bar is at; an operation whose first feed move starts and
ends at `a = 90` after the previous operation ended at `a = 0` turns the bar
90° inside an ordinary `G94` cut, and with `inverseTimeFeed: null` that turn
escapes the no-inverse-time refusal.

Rule: plan with the angle the controller is at, across the whole program,
unknown at program start.

- A **rapid** establishes the angle: it writes the angle word whenever its end
  angle differs from the tracked one or the tracked one is unknown.
- A **feed move or arc** whose start angle (`from.a`) is not the tracked angle
  (or the tracked one is unknown) makes the operation refused with a new
  warning code `postRotaryAngleNotEstablished` (message: the operation starts
  cutting before the bar has been turned to its angle; locales as in 1c).
  Never insert a turn at cutting depth to make it fit.
- An operation with no angle anywhere after one that left the bar at a
  non-zero angle is fine: it writes no angle word and the bar stays put.

## 3. Inverse-time feed must be on the motion block

With `feedSpeed.inlineWithMotion: false` a turning cut is written as `G93`,
then `F…` on its own line, then `G1 … A90` with no `F`. LinuxCNC requires the
`F` word on every `G1` block in inverse-time mode. Rule: an inverse-time feed
word is always written on the motion block itself, whatever the definition's
ordinary feed formatting says. Test with a non-inline definition.

## 4. The inverse-time number uses a mean radius

`inverseTimeFeedValue` takes the mean of the two end radii. For a move that
changes radius while turning this is not the path length. Worked case, to use
as a test: centreline at Y10 / Z10, bar along X, move from
`{x:0,y:10,z:20,a:0}` to `{x:0,y:10,z:10,a:90}` at feed 600. Mean radius gives
length 12.716 and `F47.186`; the true length of the path the tip draws on the
stock is 13.2365235, so the word must be `F45.329`.

Rule: `length` is the length of the path the tool tip draws **in the stock's
own frame** while the tool moves in a straight line and the angle changes
linearly: at parameter `t` the tip is at `stockSpacePoint(lerp(from, to, t))`
in the sense of `rotaryFrame.ts`. Compute it exactly or by quadrature to a
relative error under 1e-9; a constant-radius move (pure turn, or turn plus
travel along the bar, tool over the centreline) must still format to the
same word it does today. In the test, check the function against an
independent brute-force polyline of 100 000 chords built from
`stockSpacePoint`, for the case above, a constant-radius helix, a tool off
the centreline, both bar axes and a negative sweep. Replace the two existing
assertions that repeat the mean-radius arithmetic as their expected value
(`rotaryOutput.test.ts` near lines 437 and 564) with hand-derived numbers.

## 5. `G94` is not restored before a rapid or an operation's header commands

After a turning cut the program stays in `G93` through a following rapid, and
a next operation's dwell or positioning template is written before the mode
is restored. Rule (the approved plan: "`G94` is restored for moves that do not
turn"): leave inverse-time mode before any block that is not a turning feed
move — rapids included — and before any operation-header, tool-change, dwell,
canned-cycle or program-end output. Do not write a redundant `G94` when the
mode is already ordinary. Test cut → rapid, cut → dwell, cut → tool change.

## 6. Tests that pass with the rule broken (fix each)

- `rotaryOutput.test.ts` ~334: the constant-angle circle must also require the
  angle to be established before the arcs (see 2).
- ~687: it checks that `A90` is absent on a borrowed-**Y** machine, which a
  wrong `Y90` also satisfies. Assert the exact expected lines.
- ~483: the rapid it checks comes before `G93` begins; add the rapid after a
  turning cut (see 5).
- `rotaryDefinition.test.ts` ~256: "format stays 3.3" compares the decoded
  version with `newProject`'s, so both becoming 3.4 would pass. Compare with
  the literal `'3.3'`.
- `scripts/gcode-conformance/corpus.ts` ~495: the comment "only
  borrowed-motor case" is stale; correct it. If your changes alter the text of
  the rotary conformance programs, regenerate them the way that directory's
  INDEX/README says and say so in the report.

## Do not touch

The files listed above as the other worker's; `src/engine/rotaryFrame.ts`
(read only); `src/types/**`; `src/store/**`; `src/components/**`; bundled
machine JSON; `legacyMachineParity.json`. If something there needs a change,
STOP and report it.

## Mutations

One at a time, restored from a `cp` backup (never `git checkout`); name the
failing test or report a survivor: the between-operations check removed;
canned cycles allowed on a borrowed-motor machine; the template scan removed;
a feed move with an unestablished start angle allowed; the inverse-time `F`
left off the motion block for a non-inline definition; the mean radius put
back; `G94` not restored before a rapid.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
`src/engine/gcode/rotaryOutput.test.ts`, `rotaryDefinition.test.ts`,
`motionPipeline.test.ts`, `legacyMachineParity.test.ts`,
`src/engine/rotaryFrame.test.ts`, `scripts/gcode-conformance/corpus.test.ts`,
`src/i18n/warningsCoverage.test.ts`, `src/i18n/registry.test.ts`,
`src/i18n/catalog.test.ts`; `npm run check:i18n`;
`npx tsx scripts/check-license-headers.ts`; `npm run docs:check`. One test
process at a time. Do not run `npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, one line per
numbered finding saying what you did, the mutation table, the locale keys
added per file, and `RISKS`: anything that surprised you, any rule above you
think is wrong (say so rather than work around it), and anything you did not
do.
