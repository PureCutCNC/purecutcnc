# #1111 slice pg-a: deterministic playback guard

Approved plan: the plan comment on issue #1111 (approved by Frank 2026-10-31; read it whole, this is its "DSH slice A"). The square-to-round playback test fails `npm run build` under load because it asserts a CPU-time ratio. Replace that default gate with a **count of schedule derivations**, which does not depend on load. Slice pg-b (next) moves the timing check behind an env flag and enlarges the rotary hang guard; do not do that here.

## What to do

- `src/engine/simulation/replay.ts`: add the smallest typed, opt-in diagnostic seam that counts real schedule derivations in `sweepScheduleFor` (cache misses that build a schedule). Disabled by default; it must not change cache decisions, and there is no test-only algorithm switch. Simulation grids must stay byte-identical with collection on versus off.
- `src/engine/simulation/squarePlayback.test.ts`: the default test runs the existing real square-to-round playback once, keeps its removal assertions and the library-ball case, and asserts on derivation counts. Add a small explicit ramp replayed across many frames, because the square job alone may not exercise a non-empty ramp schedule. Leave the existing `cpuRatio` timing code in place for now (pg-b moves it behind a flag); pg-b decides when it runs.
- Update the simulation `INDEX.md`.

## Tests that must bite

- At most one derivation per encountered source-move / cell-size / radius combination.
- The ramp demonstrably spans several frames and has a non-empty schedule.
- Changing cell size or cutter radius derives a new schedule.
- Playback still removes material.
- Mutations, each one caught: bypass cache reuse; pass fresh parent-move identities per frame; drop cell size or radius from cache matching. Use fresh fixture identities so a warmed cache cannot hide a regression.

## Rules

- No change to simulation output, machine output, motion, UI, locales or project format.
- Counts must be identical whether the test runs alone or inside the 10-job `npm test` pool. Show both.
- **One heavy process at a time**: never run a full build alongside another test pool.
- Measured numbers only.

## Report

Changes per file; tests; each mutation and whether it was caught; commands with exit codes; counts alone vs in the pool; RISKS.
