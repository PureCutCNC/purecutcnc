# #1103 slice ca-c: finish integration

Plan slice 3. Around-the-bar **finish** (`generateRotaryFinish`).

- Use the ca-b helix for each uninterrupted eligible band (full 360° rings with no region split, no model gap, no excluded region).
- Everywhere else, keep rings but make them **forward-only**: every ring turns A in the same direction; A advances to the next equivalent angle instead of rewinding. Keep #1093's surface-following links only where their exact constant-A preconditions still hold; otherwise use the existing safe transition.
- If helix sampling reports an exhausted budget, fall back to forward-only rings for that band.

## Tests (new continuous test, `rotaryRegion.test.ts`)
- The seeded swept reference from ca-a checks every emitted segment after run merging.
- Zero A reversals inside an eligible band.
- Mutations, each caught: restore alternating rings; wrap commanded A modulo 360; let a helix cross an excluded region; lower shoulder clearance on a transition.

## Rules (every slice)

- Approved plan: the plan comment on issue #1103 and Frank's approval comment (helix for uninterrupted full rings; forward-only arcs with safe gaps on square blanks and partial rings; keep constant-A links only where their exact conditions still hold; along-the-bar mode unchanged). Read both whole. Its line numbers refer to an older commit; `rotaryModel.ts` has changed since (#1115 split sampling into modules, #1117 added at-layer rough links), so find `generateRotaryFinish`, `generateRotaryRough`, `emitRotaryRuns`, `linkRowAt`, `linkAtLayer` and `linkAcrossAngle` by name.
- Baselines are the post-#1117 output of this branch's base (integration/0.6.0 at 6498aaf5), not older numbers.
- Along-the-bar rough (#1098), engrave, and any path this slice does not touch stay **byte-identical** (moves and posted G-code, normalising only the date).
- Commanded A is never wrapped modulo 360 inside an operation; no closing unwind (#1091; A range is the controller's job).
- No new setting, UI, locale or format change; format stays 3.3.
- Fixtures: `../feat-issue-1103-continuous-a/work/` holds busto-round-stock.camj, busto-rect-stock.camj, square-to-round-test-01.camj and the probe `rl-e-probe.ts` (usage: `npx tsx work/rl-e-probe.ts <fixture> <op> [warmRuns] [around|along]`; ops: busto-round op0025, busto-rect op0021, square-to-round op0028). Copy them into this worktree's ignored `work/`; never commit them.
- **One heavy process at a time** (no benchmark or probe beside a test pool). Measured numbers only, saying which you measured.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.
