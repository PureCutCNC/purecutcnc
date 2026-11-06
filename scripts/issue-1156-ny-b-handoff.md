# Issue #1156 slice ny-b: header line and Y-free comments for held-cross-axis programs

Second of two slices. Assumes slice ny-a is merged on
`feat/issue-1156-no-cross-axis`. Read issue #1156 first: the plan comment
(approved by Frank on 2026-11-05) is the plan of record.

## Cause (read in the code, 2026-11-05)

- After ny-a, a program that holds the cross axis by touch-off
  (`crossAxisHeldByTouchOff`, `src/engine/gcode/motionPipeline.ts`) writes no Y
  (or X) word in motion. The operator is not yet told that Y must stay where it
  was zeroed.
- gSender strips only `( … )` comments before its file-wide Y-and-A test
  (gSender `src/server/controllers/Grbl/GrblController.js:1599-1631`). A `;`
  comment that contains `Y` followed by a digit, or by a space and a digit,
  therefore still marks the file as 4-axis. The regexes are in gSender
  `src/server/controllers/constants.js:55`.
- The touch-off fallback writes `X<dx> Y<dy> MM FROM THE FRONT-LEFT CORNER`
  (`src/engine/gcode/setupPrograms.ts:210`). It is used whenever the origin's X
  is not at the left end, right end or centre, even when Y sits on the
  centreline.
- The borrowed-motor header line is the model to follow
  (`setupPrograms.ts:373-375`).

## What to build

- In a program where the rule holds, add one header line after the touch-off
  line. Example wording, final text is the worker's choice:
  `Y IS NOT WRITTEN: ZERO Y ON THE BAR'S CENTRELINE AND LEAVE IT THERE`.
  Use X for a bar along Y.
  - Pass the decision into `setupHeaderLines` (or its caller) as an argument;
    do not recompute it in `setupPrograms.ts`.
  - Comment text goes through `safeCommentText` as the other header lines do.
- In those programs only, reword the touch-off fallback so it contains no
  `Y<digit>`, `Y <digit>` or `Y-<digit>`. For example:
  `12.7 MM FROM THE LEFT END, ON THE CENTRELINE`.
  - The rule guarantees the cross coordinate is on the centreline.
  - Every other program keeps today's wording byte for byte.
- Engine-written comment text in rule programs must match neither gSender regex.
  User text (notes, operation, tool and program names) is not sanitised; state
  that in the report.

## Acceptance

1. Committed test: for each ny-a rule program fixture (inch and mm round bar,
   square blank, along-the-bar), the whole program text with `( … )` removed
   matches neither `/Y-?\d/` nor `/Y \d/`. Use fixtures whose project names and
   notes have no Y followed by a digit.
   - Mutation: put `Y0` into the new header line; the test must fail.
2. Committed test: an origin with X off the named positions on the centreline
   gives the reworded touch-off line in a rule program. A block-stock program
   with the same origin keeps today's `X… Y… FROM THE FRONT-LEFT CORNER` text.
   - Mutation: apply the rewording to every program; the block control must
     fail.
3. Committed test: the header line appears exactly once per rule program and
   never in a program the rule does not hold for. Check a borrowed-Y program, a
   Top/Bottom manual-index program, an origin off the centreline, and a
   non-rotary program on every bundled machine.
4. Byte-identical controls stay green without editing their expected values:
   `templateByteIdentity`, `legacyMachineParity.json`, `setupExport`, and the
   borrowed-Y and non-rotary corpus cases.
5. Goldens: only the own-A rule-program expectations gain the header line. Name
   each test touched. Any other changed golden is a stop-and-report.
6. `npm run check:gcode` passes.
7. Probe: re-run ny-a's probe on Frank's `work/bolt-test-02-x.camj` and
   `work/bolt-mm-test-01.camj`.
   - Read them from the primary checkout's `work/`
     (`/home/frankp/Projects/purecutcnc/work/`); never copy them into the repo.
   - Report the header lines and the count of gSender-regex matches, which must
     be 0.
8. e2e: run the own-A specs `around3d`, `aroundModel`, `rotaryModel` and
   `aroundFace` with the isolated e2e port.
9. `npm run build` is green. Report the exit code on its own line.

## Rules

- Scope: `src/engine/gcode/setupPrograms.ts`, the call site in
  `src/engine/gcode/postprocessor.ts` that passes the decision, their tests,
  the goldens in (5) and `src/engine/gcode/INDEX.md`.
- No change to the ny-a rule itself, machine definitions, generators, schema,
  format, UI, locale or manual.
- The PR's Manual impact section is the manager's. In the report, list the two
  operator facts it needs:
  - zero Y on the centreline and leave it there;
  - gSender's Settings → Rotary → "Use A-axis for grbl" must be on for a real A
    axis on a Grbl fork.
- Report: what changed (file:line), the final header wording, the mutation
  results, the goldens touched, the probe output and the build exit code.
