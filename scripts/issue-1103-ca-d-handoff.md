# #1103 slice ca-d: rough integration

Plan slice 4. Around-the-bar **rough** (`generateRotaryRough`), round and square stock.

- Round stock, full uninterrupted rings within a layer: helix within the layer, clamped to that layer's depth. Layer changes retract (or use the existing at-layer rules) and resume at a forward-equivalent angle.
- Square stock and partial rings (corner arcs, region splits, model gaps): forward-only arcs with safe gaps. Keep the corner material gate and the rule for turning above the corner envelope; advance to the next equivalent angle without rewinding.
- **Keep #1117's at-layer ring links** (`linkAtLayer`, `linkAcrossAngle`, the square-stock stepdown rule) wherever their conditions still hold once alternation is removed. Measure with the probe that busto-rect and busto-round do not lose at-layer links or gain raised links versus the ca-a baseline; report the per-layer link counts.
- Preserve layer depth, stock allowance, the missing-model fallback and corner air-skipping.

## Tests (`rotarySquareAroundPasses.test.ts`, square property test, `rotarySquareRingLinks.test.ts`)
- Independently replay remaining stock in cutting order; no cut deeper than the layer allows.
- Mutations, each caught: remove the layer clamp on the helix; lower the turn height over a gap; join layers below clearance; drop #1117's at-layer links back to raised links.

## Rules (every slice)

- Approved plan: the plan comment on issue #1103 and Frank's approval comment (helix for uninterrupted full rings; forward-only arcs with safe gaps on square blanks and partial rings; keep constant-A links only where their exact conditions still hold; along-the-bar mode unchanged). Read both whole. Its line numbers refer to an older commit; `rotaryModel.ts` has changed since (#1115 split sampling into modules, #1117 added at-layer rough links), so find `generateRotaryFinish`, `generateRotaryRough`, `emitRotaryRuns`, `linkRowAt`, `linkAtLayer` and `linkAcrossAngle` by name.
- Baselines are the post-#1117 output of this branch's base (integration/0.6.0 at 6498aaf5), not older numbers.
- Along-the-bar rough (#1098), engrave, and any path this slice does not touch stay **byte-identical** (moves and posted G-code, normalising only the date).
- Commanded A is never wrapped modulo 360 inside an operation; no closing unwind (#1091; A range is the controller's job).
- No new setting, UI, locale or format change; format stays 3.3.
- Fixtures: `../feat-issue-1103-continuous-a/work/` holds busto-round-stock.camj, busto-rect-stock.camj, square-to-round-test-01.camj and the probe `rl-e-probe.ts` (usage: `npx tsx work/rl-e-probe.ts <fixture> <op> [warmRuns] [around|along]`; ops: busto-round op0025, busto-rect op0021, square-to-round op0028). Copy them into this worktree's ignored `work/`; never commit them.
- **One heavy process at a time** (no benchmark or probe beside a test pool). Measured numbers only, saying which you measured.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.
