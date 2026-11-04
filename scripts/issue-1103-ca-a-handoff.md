# #1103 slice ca-a: baseline and reference tests

Plan slice 1. No generator change in this slice.

**Baseline first:** on the unchanged branch, for the around-the-bar finish and rough operations in the three fixtures, record moves, rapids, A reversals (sign changes of A direction while cutting), generation time (one warm-up plus three runs, serially) and the posted-text hash. Commit the table as `scripts/issue-1103-baseline.md`; later slices compare against it.

## Reference tests (`rotaryAroundPasses.test.ts`, `squareAroundGenerator.property.test.ts`, `rotaryLayerDirection.test.ts`)
- Capture current generated-motion and posted-text controls for the paths that must stay byte-identical (along rough, engrave, a square rough case).
- Extend the independent swept cutter/material reference so it handles **diagonal moves where axial position and A change together** (sample the actual combined path, not the end points). Seed it across both axes directions, mm and inch, ball and flat cutters, retained ends and an asymmetric model.
- Mutations, each caught by the extended reference: axial sign error on a diagonal move; A sign error; omitted cutter-body reach (tip-only check); an interior gouge on a diagonal move.

## Rules (every slice)

- Approved plan: the plan comment on issue #1103 and Frank's approval comment (helix for uninterrupted full rings; forward-only arcs with safe gaps on square blanks and partial rings; keep constant-A links only where their exact conditions still hold; along-the-bar mode unchanged). Read both whole. Its line numbers refer to an older commit; `rotaryModel.ts` has changed since (#1115 split sampling into modules, #1117 added at-layer rough links), so find `generateRotaryFinish`, `generateRotaryRough`, `emitRotaryRuns`, `linkRowAt`, `linkAtLayer` and `linkAcrossAngle` by name.
- Baselines are the post-#1117 output of this branch's base (integration/0.6.0 at 6498aaf5), not older numbers.
- Along-the-bar rough (#1098), engrave, and any path this slice does not touch stay **byte-identical** (moves and posted G-code, normalising only the date).
- Commanded A is never wrapped modulo 360 inside an operation; no closing unwind (#1091; A range is the controller's job).
- No new setting, UI, locale or format change; format stays 3.3.
- Fixtures: `../feat-issue-1103-continuous-a/work/` holds busto-round-stock.camj, busto-rect-stock.camj, square-to-round-test-01.camj and the probe `rl-e-probe.ts` (usage: `npx tsx work/rl-e-probe.ts <fixture> <op> [warmRuns] [around|along]`; ops: busto-round op0025, busto-rect op0021, square-to-round op0028). Copy them into this worktree's ignored `work/`; never commit them.
- **One heavy process at a time** (no benchmark or probe beside a test pool). Measured numbers only, saying which you measured.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.
