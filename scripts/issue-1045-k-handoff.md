# #1045 slice K — square around-the-bar export check: regenerate and match

Base: the #1045 feature branch (slices A–I; slices J/J2 are NOT merged and must not be used). Read `scripts/issue-1045-c-handoff.md` and `scripts/issue-1045-e-handoff.md` for history, then this file. Off limits: `src/components/**`, `src/app/**` except tests, `src/engine/simulation/**`.

## Decision (Frank, 2026-10-20)
"Switch the square around-the-bar export check to regenerate-and-match, with generator safety proven by the independent-model tests."

Why: the standing-material export guard (`src/engine/gcode/squareSweepGuard.ts`, slices E–I) tried to re-prove engagement from the program alone; six review passes each found a new gap at cell edges, and it grew slow. The threat the export check exists for is a stale or hand-edited toolpath reaching the program; regenerating and comparing blocks that exactly. The generator's safety is a property of the generator, proven by tests.

## Build
1. **Export check:** for a square-blank operation in around mode (`rotaryPassDirection === 'around'`, admitted by `squareRotaryWorkAdmitted`), the motion pipeline regenerates the operation for the current project (`computeOperationToolpath` or the same entry the app uses) and requires the toolpath being posted to equal it move for move (same kinds, same points within a 1e-9 relative tolerance, same order). Mismatch → refuse with a new code `postSquareAroundToolpathStale` ("{operation}: the toolpath is out of date for this project; regenerate it before exporting"), five locales, coverage test. Cache the regenerated result per export so each operation is generated once.
2. **Remove the standing-material guard** for around mode: delete `squareSweepGuard.ts` and its tests (`squareSweepGuard.test.ts`, `squareSweepGuard.property.test.ts`, `squareRetainedEndOvercut.test.ts` if it only tests the guard), and the motion-pipeline wiring that calls it (`SquareSweepState`, fringe snapshot/rollback). Keep the code the along mode uses: the along-mode square output (turns below travel height refused, `squareRotaryWorkAdmitted`, physical workholding verdicts) must be **byte-identical** to `origin/integration/0.6.0` on the existing square fixtures, and must keep refusing everything it refused there. Around-mode turning **cuts** below travel height are admitted only through the regenerate-and-match path; turning **rapids** below travel height stay refused for every mode.
3. **Generator safety by independent model** (`src/engine/toolpaths/squareAroundGenerator.property.test.ts`, replacing `squareGeneratedPrograms.test.ts`): ≥ 300 seeded generator-emitted square around programs — flat and ball, Ø1–12, rough and finish, rough+finish and along-rough + around-finish, with and without retained ends, stepdowns from 0.5 to 3, default and custom stepover/sampling, square blanks from 10 to 60 side and 20 to 1000 long. An independent reference (dense polar slices of the blank per along position, the true cutter body including a ball's shank, written without using the generator's or the old guard's helpers, at least 4× finer than any cell the generator uses) replays each program in order and asserts: no cut engages more than its operation's bound (rough: stepdown + stated tolerance; finish: stockToLeave + the rough's scallop allowance + tolerance), no cutter body enters a retained end, no rapid turns A below the blank's corner radius plus clearance, and the finished surface is within tolerance of the model. Report the worst value for each assertion.
4. If the reference finds a real overcut, fix the **generator** (not the test), and report it.

## Tests that must bite
- A hand-edited around toolpath (one point moved 0.5 mm deeper), a stale one (generated before a stepdown change), and one from another operation → each refused with `postSquareAroundToolpathStale`; the freshly generated one → posted.
- Mutations (restore from `cp` backup): skip the comparison → stale test fails; compare only move counts → hand-edit test fails; generator mutation (drop the per-sample touch-radius check) → the property test fails.

## Checks
`npx tsx` on the new property test, both around suites, `rotaryModel.test.ts`, `rotaryMerge.test.ts`, the square rotary tests, `squareRotaryOutput`, `squareRotaryProgramSafety`, `exportRotarySafety`, every `src/engine/gcode/*.test.ts`; `npm run check:gcode`; `npx tsc -p tsconfig.app.json --noEmit`; `npm run lint`; exit codes. Report export time on the slice-G inputs (it now includes one regeneration per operation).

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, what was removed, the property-test worst values, any generator fix, timings, mutations, commands with exit codes, `RISKS`.
