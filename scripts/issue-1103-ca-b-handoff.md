# #1103 slice ca-b: bounded helix sampling

Plan slice 2. Build the helix path but do not wire it into the generators yet (slice ca-c and ca-d do that).

- New module `src/engine/toolpaths/rotaryContinuous.ts` (+ its test, + the nearest `INDEX.md` entry). Given a band along the bar, the stepover and the existing sampling workspace, produce a forward helix whose axial advance per revolution is at most the stepover, plus **complete boundary rings at both axial ends** so no triangular strip stays uncut. Keep cutter-radius pull-in at retained ends.
- Sample the surface at the actual helix positions (combined axial and A), using the existing sampler and workspace. Refine segments where the surface error exceeds the operation tolerance. Respect the existing cancellation checks and work/sample budgets; when a budget runs out, report it so the caller can fall back to rings.
- Commanded A grows monotonically (no modulo).

## Tests that must bite
- A narrow ridge that falls between two ring positions is protected by the helix.
- Mutations, each caught: interpolate heights between ring positions instead of sampling the helix; remove refinement; omit an end ring; pitch larger than the stepover; bypass the budget.

## Rules (every slice)

- Approved plan: the plan comment on issue #1103 and Frank's approval comment (helix for uninterrupted full rings; forward-only arcs with safe gaps on square blanks and partial rings; keep constant-A links only where their exact conditions still hold; along-the-bar mode unchanged). Read both whole. Its line numbers refer to an older commit; `rotaryModel.ts` has changed since (#1115 split sampling into modules, #1117 added at-layer rough links), so find `generateRotaryFinish`, `generateRotaryRough`, `emitRotaryRuns`, `linkRowAt`, `linkAtLayer` and `linkAcrossAngle` by name.
- Baselines are the post-#1117 output of this branch's base (integration/0.6.0 at 6498aaf5), not older numbers.
- Along-the-bar rough (#1098), engrave, and any path this slice does not touch stay **byte-identical** (moves and posted G-code, normalising only the date).
- Commanded A is never wrapped modulo 360 inside an operation; no closing unwind (#1091; A range is the controller's job).
- No new setting, UI, locale or format change; format stays 3.3.
- Fixtures: `../feat-issue-1103-continuous-a/work/` holds busto-round-stock.camj, busto-rect-stock.camj, square-to-round-test-01.camj and the probe `rl-e-probe.ts` (usage: `npx tsx work/rl-e-probe.ts <fixture> <op> [warmRuns] [around|along]`; ops: busto-round op0025, busto-rect op0021, square-to-round op0028). Copy them into this worktree's ignored `work/`; never commit them.
- **One heavy process at a time** (no benchmark or probe beside a test pool). Measured numbers only, saying which you measured.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.
