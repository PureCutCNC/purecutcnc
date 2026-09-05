# Performance Assertions (timing tests only)

> **Scope:** This document applies *only* when writing a timing assertion into a
> test. It is a recipe for one narrow act, not a house style. If the user asked a
> question, answer it in prose — see `AGENTS.md` § Scope Discipline.

`build` is a required status check, so any timing assertion that drifts blocks
merges for everyone. Three issues have now been spent here (#383, #386, #508).
Each of the first two fixed the *units* and left the *shape* of the assertion
alone, and each decayed within weeks. The rule below is the third answer; read
the whole of it before writing a timing assertion.

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

## A ratio between two input sizes is a different instrument

A size ratio sees a complexity change but is blind to a constant factor: on the
classifier, dropping the bbox gate cost ~10x in absolute CPU but moved the size
ratio only 3.19x → 4.07x, inside the baseline's own spread. Use a size ratio
only when the property under test genuinely *is* the shape of the cost curve —
`bestNonFittingCpuMs` in `src/engine/toolpaths/arcReconstruction.test.ts` is the
correct use of it, and needs no change.

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
