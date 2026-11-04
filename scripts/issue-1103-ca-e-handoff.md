# #1103 slice ca-e: export, parity and timing

Plan slice 5.

- Tests (`rotaryOutput.test.ts`, `squareRotaryOutput.test.ts`, `rotaryMerge.test.ts`): long multi-turn G1 moves post correctly; G93 inverse-time feed is positive and present on every block that needs it; own, borrowed and reversed rotary words are right; turning moves are never fitted into G2/G3; no closing unwind. Compare feeds with an independent numerical integration of the combined axial/radial/rotary path length.
- Mutations, each caught: drop the axial length from the feed; suppress a repeated F; admit turning moves into arc fitting.
- Unchanged paths (along rough, engrave, non-rotary operations) keep byte-identical motion and output, normalising only the date.
- Run `npm run check:gcode` once.
- **Timing:** serially on a quiet machine, using the rotary fixture in `rotaryModel.test.ts`, a fixed cylinder case and the three `work/` fixtures: one warm-up, five baseline runs (the ca-a base) and five candidate runs, same parameters. Report median generation and export time; target no worse than 1.2× baseline. Report A reversals and rapids per fixture against the ca-a table. Update `scripts/issue-1103-baseline.md` with the candidate columns.

## Rules (every slice)

- Approved plan: the plan comment on issue #1103 and Frank's approval comment (helix for uninterrupted full rings; forward-only arcs with safe gaps on square blanks and partial rings; keep constant-A links only where their exact conditions still hold; along-the-bar mode unchanged). Read both whole. Its line numbers refer to an older commit; `rotaryModel.ts` has changed since (#1115 split sampling into modules, #1117 added at-layer rough links), so find `generateRotaryFinish`, `generateRotaryRough`, `emitRotaryRuns`, `linkRowAt`, `linkAtLayer` and `linkAcrossAngle` by name.
- Baselines are the post-#1117 output of this branch's base (integration/0.6.0 at 6498aaf5), not older numbers.
- Along-the-bar rough (#1098), engrave, and any path this slice does not touch stay **byte-identical** (moves and posted G-code, normalising only the date).
- Commanded A is never wrapped modulo 360 inside an operation; no closing unwind (#1091; A range is the controller's job).
- No new setting, UI, locale or format change; format stays 3.3.
- Fixtures: `../feat-issue-1103-continuous-a/work/` holds busto-round-stock.camj, busto-rect-stock.camj, square-to-round-test-01.camj and the probe `rl-e-probe.ts` (usage: `npx tsx work/rl-e-probe.ts <fixture> <op> [warmRuns] [around|along]`; ops: busto-round op0025, busto-rect op0021, square-to-round op0028). Copy them into this worktree's ignored `work/`; never commit them.
- **One heavy process at a time** (no benchmark or probe beside a test pool). Measured numbers only, saying which you measured.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.
