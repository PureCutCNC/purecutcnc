# Performance Assertions (timing tests only)

> **Scope:** This document applies *only* when writing a timing assertion into a
> test. It is a recipe for one narrow act, not a house style. If the user asked a
> question, answer it in prose — see `AGENTS.md` § Scope Discipline.

`build` is a required status check, so any timing assertion that drifts blocks
merges for everyone. Three issues have now been spent here (#383, #386, #508).
Each of the first two fixed the *units* and left the *shape* of the assertion
alone, and each decayed within weeks. The rule below is the third answer; read
the whole of it before writing a timing assertion. #1111 is a fourth variant —
an assertion that measured machine load rather than the kernel, moved out of the
default build instead of re-tuned (see "Opt-in timing" below).

## No absolute millisecond budget survives

Not in wall clock, and not in CPU time either:

- **Wall clock** counts time the process spends descheduled while
  `scripts/run-tests.ts` runs its pool (`min(10, cores - 2)`), so it moves with
  unrelated load. This is what #383/#386 diagnosed, correctly.
- **`process.cpuUsage()`** fixes only that. It measures **time on CPU, not work
  done**, so it still moves with the effective clock rate — turbo limits, thermal
  throttling, SMT sibling contention. Measured for #508 on
  `classifier.test.ts`, against this project's own test pool: wall clock 569ms →
  942ms, CPU time 156ms → 325ms (**2.1x**), while a ratio against invariant work
  moved 1.16x. An allocation-free reference loop inflated 1.6x in lockstep over
  the same runs, which rules out GC as the cause.

The earlier claim that CPU time "is NOT contention dependent" was wrong, and both
budgets written under it had already drifted past their recorded baselines before
anyone noticed.

## Measure the guarded work against an invariant reference

**Measure the guarded work against the same code path on a fixture that provably
cannot benefit from the optimization being guarded, and assert the ratio.** Both
halves then share machine, clock rate, allocator and microarchitecture, so only
the optimization itself moves the number. Use `cpuRatio` from
[`src/test/cpuRatio.ts`](../src/test/cpuRatio.ts); it takes the **minimum**
across repetitions, since contention and GC can only ever add cost.

Finding the invariant half is the design work, and it is usually a fixture, not a
code change — never add a test-only toggle to production code for this, because
if the toggle breaks the ratio silently collapses to 1 and the test passes while
measuring nothing. Two worked examples:

| test | guards | subject | invariant reference |
|---|---|---|---|
| `classifier.test.ts` | bbox reject gating pairwise nesting | 2,980 **disjoint** rects — gate rejects nearly every pair | 200 **concentric** rects — every bbox pair overlaps, so the gate never rejects |
| `importBulk.test.ts` | suffix cursor in `createNameAllocator` | 2,980 **repeated** names — every one hits the suffix loop | 2,980 **unique** names — never `taken`, so they return before the loop |

## The CPU clock is coarse on Windows

`process.cpuUsage()` advances in 15.625ms scheduler ticks on Windows, against
about a microsecond on Linux and macOS. A single run shorter than a tick reads 0
on most reps, so a raw minimum collapses to 0 and the ratio to `Infinity` — the
Windows desktop build failed `entrySearchPerf.test.ts` and `meshSlicing.test.ts`
exactly this way (#903). `cpuRatio` handles it: each rep repeats the work until
its summed readings span 20 clock steps and reports the per-run mean, which
leaves Linux and macOS at one run per rep. Nothing to do in a new test beyond
using `cpuRatio`/`bestCpuMs` rather than reading `process.cpuUsage()` directly;
a hand-rolled size ratio (`arcReconstruction.test.ts`) must skip, loudly, when
its baseline is below the clock step.

## A ratio between two input sizes is a different instrument

A size ratio sees a complexity change but is blind to a constant factor: on the
classifier, dropping the bbox gate cost ~10x in absolute CPU but moved the size
ratio only 3.19x → 4.07x, inside the baseline's own spread. Use a size ratio
only when the property under test genuinely *is* the shape of the cost curve —
`bestNonFittingCpuMs` in `src/engine/toolpaths/arcReconstruction.test.ts` is the
correct use of it, and needs no change.

## Opt-in timing when the ratio cannot separate

A ratio is only a gate if it separates baseline from regression. The
square-to-round playback in `src/engine/simulation/squarePlayback.test.ts`
measures the wrapped replay against the same moves through the flat kernel on the
same starting stock, and on the machine it was written on that ratio separated
(3.87–4.35 baseline against 5.91–5.92 on the pre-correction branch). Its
reference alone was measured swinging 2.7–15.9 ms across runs, so
with the build's test pool loaded the ratio reached 5.25x, 7.00x, 5.01x, 5.27x
and 6.7x on branches that passed alone, and it failed `npm run build` four times
during 0.6.0 (issue #1111). It was measuring machine load.

Re-measured for #1111 slice pg-b (2026-11-02, Linux/node 22, five serial
invocations each) the separation is gone: baseline 4.89–5.09 against 4.94–5.55
with the per-frame rebuild restored, and the review of that slice measured a
healthy baseline at 5.15x. The ranges overlap and the baseline alone crossed 5,
so a threshold there fails running branches. The rebuild is cheap on that fixture
(only a move whose Z changes by more than a cell has a schedule at all), so the
numbers are dominated by the difference between the wrapped and flat kernels,
which is what the ratio measures rather than the cache.

That test's default guard is therefore **counted work** — schedules derived per
source move / cell size / cutter radius, which is a property of the path and
cannot move with load — and the CPU-time ratio is opt-in:

```bash
PURECUT_SQUARE_PLAYBACK_PERF=1 npx tsx src/engine/simulation/squarePlayback.test.ts
```

Without the flag the test runs every correctness and counted-work assertion,
prints one line saying the ratio was skipped, and never calls `cpuRatio`. With
it, the ratio and its raw times are printed; it **enforces no pass/fail
threshold**. The limit was removed rather than re-tuned to fit one machine's
overlap, because a constant fitted to noise is not a gate. `squarePlayback.test.ts`
carries a guard that reads this section and the test's own source and fails if a
threshold on the ratio comes back to either. This is not a general
exemption: an assertion that can only be measured by time does not belong in the
default build, and the flag exists only where a deterministic substitute already
covers the property. It also does not change `src/test/cpuRatio.ts` or any other
performance test.

## Record your numbers and verify by mutation

Whichever you write, record in the test the measured baseline row, the measured
regressed row, and the headroom either side, so the next reader can re-derive the
constant instead of guessing at it. Set the threshold at the geometric mid-point
of the *worst* pair — highest observed baseline against lowest observed
regression — not of the averages.

**Verify by mutation, not by a green run.** Temporarily delete the optimization,
confirm the assertion fails, and restore. A perf test that has never been shown
to fail against its own regression is not evidence of anything. Check the
reference column stayed put across that mutation too: if both columns moved, the
reference is contaminated and the ratio understates the regression.

## Worked examples (from the original AGENTS.md)

| test | guards | subject | invariant reference |
|---|---|---|---|
| `classifier.test.ts` | bbox reject gating pairwise nesting | 2,980 **disjoint** rects — gate rejects nearly every pair | 200 **concentric** rects — every bbox pair overlaps, so the gate never rejects |
| `importBulk.test.ts` | suffix cursor in `createNameAllocator` | 2,980 **repeated** names — every one hits the suffix loop | 2,980 **unique** names — never `taken`, so they return before the loop |
