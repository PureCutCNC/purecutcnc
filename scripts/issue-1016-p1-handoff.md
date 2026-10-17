# #1016 C2 slice P1 — square-material searches stop at a tolerance

Follow the Session rules in #962 (base `integration/0.6.0` lineage, own worktree,
format 3.3, tests must bite, no `process.`/`globalThis` in engine code). DSH
writes code, COMMIT: none. Approved by Frank on 2026-10-17 ("early-stop the
searches") as part of the approved #1016 C2.

## Why (measured by the manager)

A CPU profile of the headless browser (seeded square blank side 12, length 30,
Around setup, rotary rough then rotary finish, finish selected, Simulation tab
at its default detail) shows the main thread busy for **66 s to open the
simulation** and **86 s after a 30→40 mm length resize**. Practically all of it
is `src/engine/simulation/squareMaterial.ts`:
`applySquareMoveToGrid → removedBandsForCell → constantAngleBands`, inclusive
~98 %; inside it `maximizeConcave` (~85 %, self ~23 %), `concaveDomain`
(~70 %), and the per-sample closures `discAt`, `reachAt`, `dxAt`, `tipAt`,
`centreAt`, `sphereLow/High`. `maximizeConcave` (golden section) and
`bisectCrossing` (bisection) both run a fixed `CONVERGE_ITERATIONS = 96`
loop for every cell under every move. 0.618^96 ≈ 1e-20, far below float64
resolution, and the intervals end up stored at Float32 precision
(`ULP = 2 ** -23` already exists in the file).

## What to build

File: `src/engine/simulation/squareMaterial.ts` only (plus tests below).

1. `maximizeConcave` and `bisectCrossing` (and any other fixed-count search in
   the file — search for `CONVERGE_ITERATIONS` and for other loops of the same
   shape; list each one in your report) stop as soon as further iterations
   cannot change the stored result: when the bracket width is below a
   tolerance derived from the bracket scale and Float32 resolution, keeping
   `CONVERGE_ITERATIONS` as the hard upper bound. Choose the tolerance so the
   value at a concave maximum (error is quadratic in the argument error) and
   the crossing positions are both resolved past one Float32 ulp of the
   stored quantity. Explain the choice in a short comment.
2. Remove repeated evaluation where it is free to do so (e.g. a closure that
   recomputes `centreAt`/`dxAt` already computed for the same `s` in the same
   call). Do not restructure the algorithm, change what an interval means, or
   change grid resolution. No caching across cells or moves.
3. Public signatures unchanged. Format 3.3; no schema, store, UI, locale or
   app changes.

## Output must not move

Stored material must be the same after Float32 rounding. Add a test (new
`src/engine/simulation/squareMaterialConvergence.test.ts`) that runs a seeded
set of square moves (asymmetric: stepped, angled, ball and flat end, axial and
non-axial, both rotation senses, a move that crosses the corner envelope)
through the module once with the old fixed-96 behaviour and once with the new
one, and asserts every stored interval endpoint is equal after `Math.fround`
(or differs by at most one Float32 ulp — if any differ, report how many and
by how much; zero is the goal). Expose the old behaviour only through a
test-only parameter or an internal options object defaulting to the new
behaviour; no environment switches.

Also keep green, unchanged: `squareGrid.test.ts`, `squareMaterialGeometry.test.ts`,
`squareReplay.test.ts`, `squareMaterialMesh.test.ts`, `aroundReplay.test.ts`,
`src/app/squareSimulation.test.ts`.

## Timing (report numbers you measured, exit codes)

Write a scratch probe under `work/` (gitignored, not committed) that builds the
fixture from `src/app/squareSimulation.test.ts` (`squareRotaryProject`, valid
default chuck, production `computeOperationToolpath`) and times
`computeSimulationResult` in `selected` mode for the rough, before (fixed 96)
and after, three runs each, median, plus the count of `maximizeConcave` /
`bisectCrossing` iterations. Buffer output and print once at the end (stdout of
a busy tsx probe may not flush on macOS).

## Mutations that must fail (apply each alone, revert)

- tolerance 1000× too loose → the convergence test fails;
- early exit removed from `maximizeConcave` only → convergence test still
  passes but the iteration count assertion (add one: mean iterations per call
  below a stated bound) fails;
- `bisectCrossing` returns the negative side → an existing or new test fails.

## Off limits

`src/components/**`, `src/app/**` (another worker owns it), `src/main.tsx`,
`e2e/**`, every other engine file, schema/store/UI/locales. No primary checkout,
`.env.agent`, credentials, git writes, push, PR, cleanup.

## Checks

`node --import tsx` each changed/listed test file, `node_modules/.bin/eslint` on
changed files, `node_modules/.bin/tsc -p tsconfig.app.json --noEmit`. No
browser, no full build, no test pools.

## Report

STATUS, COMMIT: none, CHANGED_FILES, every search loop changed, the tolerance
and why, timings before/after (median of 3) and iteration counts, each mutation
and whether it failed, commands with exit codes, RISKS.
