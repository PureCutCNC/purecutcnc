# Issue #1156 slice ny-a: an own-A round-bar program never writes the cross axis

One slice of two. Branch `feat/issue-1156-no-cross-axis`, based on
`integration/0.6.0` at 428a285e. Read issue #1156 first: the plan comment
(approved by Frank on 2026-11-05) is the plan of record. Slice ny-b, the header
and comment wording, comes after this slice and is out of scope here.

## Cause (read in the code, 2026-11-05)

- gSender refuses the whole file, not single lines. It flags it as 4-axis when
  the text, with only `( … )` comments removed, matches an A regex **and** a Y
  regex anywhere (gSender `src/server/controllers/Grbl/GrblController.js:1599-1635`,
  regexes in `src/server/controllers/constants.js:54-55`). Writing Y once is
  already enough to be refused.
- `emitMotionLine` (`src/engine/gcode/postprocessor.ts:594-660`) writes X, Y and
  Z whenever the axes object defines them (`:614-622`). Only the rotary word is
  modal (`emitRotaryAxisWord`, `:575-580`).
- `emitPlannedMove` (`:812-845`) always passes `x, y, z`. `splitRapid`
  (`src/engine/gcode/motionPipeline.ts:1623-1665`) writes `{x, y}` together on
  the XY block (`:1651`, `:1661`). `placeAtStart` (`postprocessor.ts:1021-1044`)
  restates X and Y after every tool change, through `restartAfterToolChange`
  (`:1079-1116`).
- The only coordinate dropped today is a borrowed motor's:
  `suppressBorrowedAxisInSteps` (`motionPipeline.ts:963-990`), applied in
  `planOperationMotion` at `:1530-1533` and keyed on `rotaryBorrowedAxis`
  (`src/engine/gcode/types.ts:425`). On an own-drive machine
  (`rotaryWord` = `A`, `types.ts:415`) Y is kept.
- Both bar shapes put the default origin on the centreline
  (`src/types/project.ts:1854-1866`), so the emitted cross coordinate is 0 on
  every line: 2,080 `Y0.0000` words in Frank's inch export.

## What to build

A program **holds the cross axis by touch-off** only when all four conditions
below hold. The cross axis is Y for a bar along X and X for a bar along Y.

1. `definition.rotary?.drive === 'own'`.
2. The stock is a bar. The program writes A (`programTurns`,
   `postprocessor.ts:427`). It is not a manual-index Top/Bottom program
   (`setupPlan.manualIndexAngle === null`).
3. For every operation in the program, every move endpoint and every drill-cycle
   point has a machine-frame cross coordinate that formats as zero with the
   machine's decimals (`Y0.0000` or `Y-0.0000`). Map project points through
   `projectToMachinePoint`, as `borrowedAxisRange` (`motionPipeline.ts:942`)
   reads project moves. If any planned step is an arc, the condition fails.
4. None of the machine's templates that this program writes contains the cross
   letter as an axis word, or `G28`/`G30`. That covers the program header,
   operation header, tool-change commands and pause, footer and program end.
   Use `lineCarriesAxisWord` (`postprocessor.ts:155`) on the definition's
   template text.

Build:
- A pure exported decision `crossAxisHeldByTouchOff(...)` in
  `motionPipeline.ts`, returning `'x' | 'y' | null`. It is evaluated once per
  program in `emitGcodeProgram`, next to `programTurns`.
- Generalise `suppressBorrowedAxisInSteps` to `suppressAxisInSteps` and keep its
  behaviour. Apply it in `planOperationMotion` for the held axis too, so
  `placeAtStart`, `splitRapid` and `emitPlannedMove` write no cross word, as they
  already do for a borrowed motor.
- When the rule holds, drill operations are expanded instead of written as
  canned cycles, as on a borrowed machine (`postprocessor.ts:1319`).
- When any condition fails, output is byte-identical to today's.
- No new machine option, UI, schema field or format change. Do not touch X/Z
  repetition.

## Acceptance

1. Committed test, own-A grbl definition: the bundled `grbl` definition plus
   `rotary: { about: 'x', drive: 'own' }`, with the default inverse-time
   commands. Use around rotary rough and finish programs on a round bar, in inch
   and mm, plus one square-blank around program and one along-the-bar program.
   - Each program's new text equals today's text with every ` Y-?[0-9.]+` word
     removed, byte for byte. Before changing any engine code, record today's
     exports of these programs as committed golden fixtures, written from the
     base commit. The test then strips the Y words from the golden and compares.
     Do not use an env switch or a test-only flag in engine code.
   - With `( … )` comments removed, the text matches neither `/Y-?\d/` nor
     `/Y \d/`.
   - Mutation: remove the suppression; the test must fail.
2. Committed test: `gcodeMotionParser` reads the same X, Y, Z and A after every
   block for the new and old text of the programs in (1).
3. Committed test: on a bar along Y with an own-A machine about Y, X is dropped
   and Y is kept.
4. Committed controls, each a mutation of one condition:
   - A tool-change template `G53 G0 Y-10` keeps today's output. Mutation: skip
     condition 4.
   - An origin moved off the centreline, so the cross coordinate is non-zero,
     keeps today's output. Mutation: skip condition 3.
   - A Top/Bottom manual-index program keeps today's output. Mutation: skip
     condition 2.
   - A program with an arc step keeps today's output. Mutation: remove the arc
     exclusion.
   - Each mutation must fail its test.
5. Byte-identical controls that must stay green without editing their expected
   values:
   - every bundled machine (`src/engine/gcode/definitions/*.json`, none has a
     rotary block) on its existing non-rotary programs: `templateByteIdentity`,
     `legacyMachineParity.json`, `setupExport`, `postprocessor.test.ts`;
   - borrowed-Y rotary programs.
6. Existing goldens that pin own-A Y words may be updated, and only in the Y
   words. Name each file and test in the report. Expected:
   `rotaryOutput.test.ts`, `aroundExport.test.ts`,
   `rotaryOperationHandoff.test.ts`, `setupPrograms.test.ts`,
   `squareRotaryProgramSafety.test.ts`, and users of
   `src/test/reportedRotaryMachines.ts`. Any other golden that changes is a
   stop-and-report.
7. `npm run check:gcode` passes. Only the own-axis cases may change:
   `rotary-own-axis-inverse-time`, `around-pocket-own-axis` and
   `rotary-model-rough-own-axis`, all on linuxcnc-rs274. Report which of them
   lost Y words.
8. Probe on Frank's files, using a node probe under this worktree's gitignored
   `work/`. Frank's projects live only in the primary checkout's `work/`
   (`/home/frankp/Projects/purecutcnc/work/`). Read them from there and never
   copy them into the repo.
   - Export the Around setup of `work/bolt-test-02-x.camj` (inch) and of
     `work/bolt-mm-test-01.camj` (mm) on the own-A grbl definition from (1).
   - Report each program's line count and Y-word count.
   - Report whether the output equals today's export of the same input with
     every Y word removed.
9. e2e: run the own-A specs `around3d`, `aroundModel`, `rotaryModel` and
   `aroundFace` with the isolated e2e port (`PURECUT_E2E_PORT`,
   `PURECUT_E2E_ISOLATED=1`, `--workers=2`). No spec is expected to change.
10. `npm run build` is green. Report the exit code on its own line.

## Rules

- Scope: `src/engine/gcode/motionPipeline.ts`, `src/engine/gcode/postprocessor.ts`,
  their tests, the goldens named in (6), and `src/engine/gcode/INDEX.md`
  (document the rule). No change to `setupPrograms.ts` header text, which is
  slice ny-b. No change to machine definitions, toolpath generators, schema,
  format, UI, locale or manual.
- Never loosen a guard or a refusal to make a test pass.
- If a condition cannot be decided before emission without restructuring the
  emitter, stop and report rather than redesign.
- Report: what changed (file:line), the condition table with each control's
  result, the mutation results, the goldens touched, the check:gcode cases that
  changed, the probe table and the build exit code.
