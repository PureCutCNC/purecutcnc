# #1016 C2 slice P3 — each square move tests only the angle window its tool can reach

Follow the Session rules in #962 (own worktree, format 3.3, tests must bite, no
`process.`/`globalThis` in engine code). DSH writes code, COMMIT: none.
Approved by Frank on 2026-10-17 as part of the approved #1016 C2: "limit each
move's cell loop to the angle window the tool can reach, with a proven bound,
a test that it matches the full loop exactly, and before/after timings."

Base: this branch already contains P1 (early-stop searches in
`squareMaterial.ts`, `squareMaterialConvergence.test.ts`). Another worker (P2)
is changing `src/app/**`; do not touch it.

## Why (measured by the manager)

In the browser, opening the Simulation tab on a small square job froze the app
for 66 s, all in `applySquareMoveToGrid`. The manager instrumented the cell
loop (`src/engine/simulation/squareMaterial.ts`, the `for (let c = 0; c <
acrossCount; c += 1)` loop inside `applySquareMoveToGrid`) on the
`src/app/squareSimulation.test.ts` fixture (side 12, length 30, rotary rough,
detail 60): **834,060 cells searched, 39,434 (4.73 %) got a removal band,
15,350 (1.84 %) changed.** Bucketed by the angle between the cell's ray and the
tool (`|thetaAt(geometry, across, 0)|`): every band was within 20° (0–10°:
33,011; 10–20°: 6,423; 20–180°: 0), while the loop searched every cell all
the way round the bar for every move. Each rejected cell still runs the full
golden-section/bisection search before returning null.

## What to build

`src/engine/simulation/squareMaterial.ts` only (plus tests).

1. Derive, per move, a **provably safe** bound on `|θ|` outside which
   `removedBandsForCell` must return null (no band), and iterate only the
   across cells inside it. Sketch to check and make rigorous, not to copy
   blindly: a point of a cell's ray at radius `r` sits `r cos θ` along the tool
   axis and `r |sin θ|` across it. The flat cutter and the ball's shank are a
   cylinder of radius `rt`, and the ball (centre `tip + rt`) lies inside the
   same cylinder above `tip`; so a hit needs `r |sin θ| ≤ rt` and
   `r cos θ ≥ tipMin` (the lowest tip over the move's reachable `s` window).
   With `tipMin > 0` that forces `cos θ > 0` and `tipMin·tan|θ| ≤ rt`, i.e.
   `|θ| ≤ atan(rt / tipMin)`; the material's outer radius (corner radius) may
   tighten it further. When `tipMin ≤ 0` (tool at or below the axis) or any
   input is not finite, fall back to the full loop. Prove each step in the
   comment above the code; widen by at least one cell plus a Float64-safe
   epsilon on each side — never narrower than the proof.
2. Turn the angle window into across-cell indices using exactly the mapping
   `thetaAt` uses (explicit program angle `a` via `zero`/`anglePerAcross`, or
   the across coordinate otherwise). The bar is periodic: a window that crosses
   the seam is two index ranges. A window covering the whole circumference is
   the full loop. Cells visited keep the same `idx` and the same per-cell code
   path, so stored results cannot change.
3. Public signatures unchanged; production callers unchanged. You may extend
   the existing test-only `SquareSearchOptions` with a flag that forces the old
   full loop, and with a tested-cell counter, for the tests and probe below.

## Tests that must bite

New `src/engine/simulation/squareMaterialWindow.test.ts`:
- Seeded property test (a few hundred random constant-angle moves, fixed seed):
  flat and ball, several radii, tips well above, just above, at and below the
  axis, both rotation senses, explicit `a` and across-coordinate moves, moves
  whose window crosses the seam, plunges, long and short moves, on an
  asymmetric pre-cut grid. Replay each sequence with the window and with the
  forced full loop; every `topZ` value and every `squareMaterial` entry must be
  identical (exact equality, not a tolerance), and so must each call's
  `changedCount` and `dirtyRegion`.
- Independent check of the bound itself: for sampled moves, every cell outside
  the computed window run through the full per-cell search returns no band.
- The tested-cell count on the `squareSimulation.test.ts`-style fixture drops
  by a stated factor (assert a bound you measured, with margin).

Keep green and unchanged: `squareMaterialConvergence.test.ts`,
`squareGrid.test.ts`, `squareMaterialGeometry.test.ts`, `squareReplay.test.ts`,
`squareMaterialMesh.test.ts`, `aroundReplay.test.ts`,
`src/app/squareSimulation.test.ts`.

Mutations that must fail (each alone, reverted): window 2× too narrow; seam
case drops the wrapped range; sign of the explicit-angle mapping flipped;
fallback for `tipMin ≤ 0` removed.

## Timing (numbers you measured, exit codes)

Scratch probe under `work/` (gitignored, not committed), built like the
fixture in `src/app/squareSimulation.test.ts` (`squareRotaryProject`, valid
default chuck, production `computeOperationToolpath`): time
`computeSimulationResult` in `selected` mode for the rough, full loop vs
window, three runs each, median, plus tested cells and the share with a band.
Also time a ball-end finish over the rough if the fixture allows it. Buffer
output and print once at the end (macOS tsx stdout).

## Off limits

`src/app/**`, `src/components/**`, `src/main.tsx`, `e2e/**`, every other
engine file, schema/store/UI/locales. No primary checkout, `.env.agent`,
credentials, git writes, push, PR, cleanup.

## Checks

`node --import tsx` on each new/listed test file, `node_modules/.bin/eslint` on
changed files, `node_modules/.bin/tsc -p tsconfig.app.json --noEmit`. No
browser, no full build, no test pools.

## Report

STATUS, COMMIT: none, CHANGED_FILES, the bound and its proof in a few lines,
seam/fallback handling, timings before/after and tested-cell counts, each
mutation and whether it failed, commands with exit codes, RISKS.
