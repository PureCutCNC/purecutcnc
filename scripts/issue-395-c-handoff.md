# Issue #395 slice C — exporting an Around setup

You are the implementation worker for slice C of issue #395 (wrapped rotary,
part A: an "Around" face on a round bar). Work only in your task worktree. Do
not create, remove, merge, push or switch branches or worktrees. Do not open a
PR. Do not run `git add` or `git commit`: leave your edits uncommitted and
report `COMMIT: none`. `gh` may be blocked; everything you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `src/engine/INDEX.md`,
`src/engine/gcode/INDEX.md`, then in full `src/engine/aroundFrame.ts`,
`src/engine/rotaryFrame.ts`, `src/engine/gcode/setupPrograms.ts`, the
"Rotary axis (#393)" part of `src/engine/gcode/motionPipeline.ts`, the rotary
parts of `src/engine/gcode/postprocessor.ts`, and
`src/engine/gcode/rotaryOutput.test.ts` (how a rotary export is tested).
Project format stays `3.3`; absolute paths for every write, no `cd`. Smallest
change that does the job; no refactor; match the surrounding code. No
`process.` or `globalThis` in engine code. `node_modules` is a symlink:
type-check with `npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

## Where things stand

- #393 (on your branch): a toolpath point may carry `a` (degrees); export
  writes it under the machine's rotary word, turning cuts in inverse-time
  feed, never arcs; refusals for a machine with no rotary axis, no
  inverse-time command, a block stock, travel on a borrowed motor, a template
  that writes the borrowed letter, and a cut starting at an angle the bar was
  not turned to (`postRotaryAngleNotEstablished`: only a **rapid** establishes
  the angle).
- #395 slices A and B (on your branch): an operation in an Around setup
  (`setup.kind === 'around'`, `setupFace(setup) === 'around'`) is generated on
  the unrolled sheet and stored already wrapped: every point has `a`, the tool
  sits over the bar's centreline, `drillCycles` are removed.
  `setupFrameForOperation` returns `undefined` for it, so the export pipeline
  applies no setup turn. `src/store/helpers/aroundFace.test.ts` shows how to
  build such a project and generate its operations.

Nobody has yet exported an Around operation. **This slice makes an Around
setup export a correct program and proves it.**

Other workers are changing `src/components/**`, `src/styles/**`,
`src/app/**`, `src/store/**` and the `dialogs`/`ui` locale files at the same
time: **do not touch those.** Your files: `src/engine/gcode/**`,
`src/engine/operationBooklet/**`, `scripts/gcode-conformance/**`,
`src/engine/toolpaths/warningCodes.ts`, the five `warnings` locale files, and
tests. If `src/engine/aroundFrame.ts` needs a change, make it and say why.

## Rules (approved by Frank, 2026-10-12)

1. **One program per Around setup**, like Bottom today, with its own header,
   also when it is the project's only setup (`projectExportsPerSetup`).
2. **Header lines** (`setupHeaderLines`; plain upper-case English like the
   existing ones, not localised), for a bar along X:
   - `SETUP NN: <name> - AROUND THE BAR, BAR ALONG X`
   - instead of the `REGISTRATION:` line:
     `ROTARY ZERO: TURN THE BAR SO THE START LINE IS UP, THEN ZERO THE ROTARY`
   - `TOUCH OFF: <place> OF THE BAR SEEN FROM ABOVE, Z0 ON TOP OF THE BAR`
     where `<place>` and the height wording come from the same logic as Top
     (the origin is the same shared placement, read as on Top; the top of the
     bar is `stock.thickness`).
   - when the machine's rotary borrows a motor, one more line:
     `THE <letter> MOTOR DRIVES THE ROTARY: SET THE TOOL OVER THE BAR'S CENTRELINE BY HAND`
     (`<letter>` from `rotaryWord`).
   - `NOTE:` lines as usual.
   `describeSetupTurn` and `describeTouchOff` must not fall into their Bottom
   branch for Around. `setupLacksRegistration` is false for an Around setup:
   flip registration means nothing in a chuck.
3. **The bar and the machine must agree.** An operation with an angle on a
   machine whose `rotary.about` is not the bar's `axis` is refused with a new
   warning code `postRotaryAxisMismatch`. English: `Operation "{operation}"
   was not exported: the machine's rotary axis lies along {machineAxis} but
   the bar lies along {stockAxis}.` Declare it with the other `postRotary*`
   codes; messages in all five locales next to theirs (only new keys, each
   file's own quote style, no existing value changed).
4. **The angle is established by a rapid.** Generate real Around operations
   (pocket, engrave / follow-line, edge route, drilling) and export them. If
   any is refused with `postRotaryAngleNotEstablished`, find out why (most
   likely its first move is a feed move, or the planner positions the tool for
   an operation's first move without the angle) and fix it where the export
   positions the tool for an operation's first move, so the bar is turned to
   the first point's angle by a rapid at the safe height before any feed.
   Do not weaken the rule itself, and report what you found either way.
5. **Unwind once at the end.** After the last operation of a program that has
   turned the bar, with the tool at the retract height it ends on and before
   the footer, one rapid returns the rotary to angle 0 (`G0 A0`, or the
   borrowed letter). Not between operations; not written when the program
   ends at angle 0 or never used an angle. The angle is never reduced to
   0–360 anywhere else.
6. **No canned cycles and no arcs** in an Around program (#393 already gates
   both on a toolpath that carries an angle; prove it for real operations).
7. **Booklet** (`src/engine/operationBooklet/report.ts`): `setupRows` must not
   describe an Around setup as Bottom or as a flip; give it the wording of
   rule 2's first line in the report's own style. An Around toolpath's heights
   are already tool heights over the centreline, so depths from the top of the
   bar read as on Top: check that the report's numbers for an Around operation
   are right as they stand, and say so (or fix).

## Tests

New `src/engine/gcode/aroundExport.test.ts` (plain `npx tsx`, in the style of
`rotaryOutput.test.ts`): a 40 mm bar 200 mm long along X at an off-origin
position and a 2 in bar along Y; an Around setup; a pocket, an engrave, an
edge route and a drilling operation generated through
`computeOperationToolpath`; exported through the real post-processor for
(a) a machine with its own axis (`A`) and (b) a machine that borrows the
other horizontal motor. Assert, on the program text:

- the header lines of rule 2, exactly, for both machines and both bar axes,
  and for a project whose only setup is Around;
- every operation is exported, with no rotary refusal (rule 4);
- own axis: every motion block's across coordinate, when written, is the
  centreline; borrowed motor: the borrowed letter appears only as the angle,
  and the line count of angle words matches the moves;
- the first motion of each operation is a rapid that writes the angle, at the
  safe height, before any feed;
- turning cuts are `G1` in `G93` with `F` on the block, `G94` restored before
  anything else, no `G2`/`G3`, no canned cycle;
- a multi-turn engrave line (a slanted line 2.5 circumferences long) writes
  angles past 360 and one unwind rapid to 0 at the end (rule 5), and a program
  that ends at 0 writes none;
- the inverse-time number of one cut, checked by hand from the flat move's
  length on the surface (a constant-depth cut at flat height `r` over an arc
  `s` and travel `l` along the bar has length `sqrt(l² + (s·r/R)²)`);
- `postRotaryAxisMismatch` for a bar along Y on a machine set up along X;
- the exported program read back with `parseGcodeMotion` is `verified` and
  its points, unwrapped with `unwrapPoint`, lie on the flat toolpath;
- Top and Bottom programs of the same project are unchanged
  (`legacyMachineParity.test.ts` and the existing setup export tests pass
  unmodified).

Conformance (`scripts/gcode-conformance/`, read its INDEX/README first): add
a wrapped engrave and a wrapped pocket, each for the borrowed-motor case
through the Grbl parser and the own-axis case through the LinuxCNC parser,
following how the existing #393 rotary cases are declared. You cannot run the
real parsers; say so, and run `scripts/gcode-conformance/corpus.test.ts`.

Mutations, one at a time, restored from a `cp` backup (never `git checkout`);
name the failing test or report a survivor: the Around header falling into the
Bottom branch; the unwind removed; the unwind written between operations; the
axis-mismatch refusal removed; the establishing rapid removed (or whatever
your rule 4 fix was); `setupLacksRegistration` true for Around.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
the new test, `rotaryOutput.test.ts`, `motionPipeline.test.ts`,
`legacyMachineParity.test.ts`, the existing setup-program tests next to
`setupPrograms.ts`, the booklet report test, `corpus.test.ts`,
`src/engine/aroundFrame.test.ts`, `src/store/helpers/aroundFace.test.ts`,
`src/i18n/warningsCoverage.test.ts`, `registry.test.ts`, `catalog.test.ts`;
`npm run check:i18n`; `npx tsx scripts/check-license-headers.ts`;
`npm run docs:check`. One test process at a time. Do not run
`npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, one line per
rule saying what you did, a sample of the exported program (header and the
first 25 motion lines of the engrave, own-axis machine), the mutation table,
the locale keys added per file, and `RISKS`: anything that surprised you, any
rule above you think is wrong (say so rather than work around it), and
anything you did not do.
