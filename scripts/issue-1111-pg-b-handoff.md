# #1111 slice pg-b: timing behind a flag, larger rotary hang guard

Approved plan: the plan comment on issue #1111 (approved by Frank 2026-10-31; this is its "DSH slice B"). Slice pg-a already made the default square playback test assert on counted schedule derivations.

## What to do

- `src/engine/simulation/squarePlayback.test.ts`: the CPU-time ratio check (`cpuRatio`, limit 5×) runs only when `PURECUT_SQUARE_PLAYBACK_PERF=1` is set. Correctness and counted-work assertions stay unconditional. Print a one-line note when timing is skipped.
- `src/engine/toolpaths/rotaryWorkBudget.test.ts`: raise every child `spawnSync` hang-guard timeout from 10 s to 120 s. Keep the child error, exit status, warning and empty-motion assertions.
- `docs/PERF_ASSERTIONS.md`: document the opt-in timing command for this test and why it is not in the default build (load-sensitive, issue #1111). Do not change the shared `src/test/cpuRatio.ts` or other performance tests.
- Simulation `INDEX.md` if it describes the test.

## Measurement

Serially, on a quiet machine (check `ps` first; nothing else heavy running): five full invocations with `PURECUT_SQUARE_PLAYBACK_PERF=1` on this branch, and five with a regression restored (a per-frame schedule rebuild, e.g. bypass the cache). Report raw times and ratios. Keep 5× only if the numbers separate; otherwise report what they show and do not invent a threshold.

## Tests that must bite

- Without the flag the test passes and never calls `cpuRatio`; with it, timing runs.
- Mutations, each one caught: remove the emission-budget refusal in rotary rough (must fail through wrong output or the timeout); remove the cancellation polls (existing count assertions fail).

## Rules

- Test and docs only; no engine, simulation output, UI or format change.
- **One heavy process at a time.** Finish with `npm run build` and its exit code.
- Measured numbers only.

## Report

Changes per file; mutations and results; commands with exit codes; the measurement table; RISKS.
