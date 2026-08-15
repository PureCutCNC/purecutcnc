/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Performance assertions, measured as a ratio against invariant work.
 *
 * Absolute millisecond budgets do not survive in a required status check. Two
 * earlier attempts (#383, #386) both decayed, and #508 explains why: wall clock
 * counts time spent descheduled, and `process.cpuUsage()` — which fixes that —
 * still measures *time on CPU*, not work done. Time on CPU moves with the
 * effective clock rate, so turbo limits, thermal throttling and SMT contention
 * all inflate it. Measured on the fixture in `classifier.test.ts`, against this
 * project's own `npm test` pool:
 *
 *     wall clock          569ms -> 942ms   (the #383/#386 failure)
 *     CPU time            156ms -> 325ms   (2.1x — the #508 failure)
 *     ratio vs invariant work        1.16x
 *
 * So measure the guarded work against **the same code path on a fixture that
 * cannot benefit from the optimization being guarded**. Both halves then share
 * machine, clock rate, allocator and microarchitecture, and only the
 * optimization itself moves the number. A ratio between two *input sizes* is a
 * different instrument: it sees a complexity change but is blind to a constant
 * factor, so it does not fit here — see `AGENTS.md` for which to reach for.
 *
 * Minimum rather than mean, since contention and GC can only ever add cost.
 * Build fixtures outside the callbacks so allocation stays out of the measured
 * region, and call each once beforehand to warm the JIT.
 */

export interface CpuWork {
  /** The measured region. Keep fixture allocation out of it. */
  run: () => void
  /** Runs before each rep, outside the measured region — store resets and such. */
  setup?: () => void
  reps?: number
}

/** Lowest CPU time, in ms, that `work.run` takes across its reps. */
export function bestCpuMs(work: CpuWork, defaultReps = 5): number {
  const reps = work.reps ?? defaultReps
  let best = Infinity
  for (let rep = 0; rep < reps; rep += 1) {
    work.setup?.()
    const before = process.cpuUsage()
    work.run()
    const delta = process.cpuUsage(before)
    best = Math.min(best, (delta.user + delta.system) / 1000)
  }
  return best
}

/**
 * Cost of `subject` expressed in units of `reference`.
 *
 * `reference` must exercise the same code path as `subject` on a fixture that
 * provably bypasses the optimization under test, so that removing the
 * optimization moves `subject` and leaves `reference` alone. Verify that by
 * deleting the optimization and re-measuring: if both columns move, the
 * reference is contaminated and the ratio understates the regression.
 */
export function cpuRatio(
  subject: CpuWork,
  reference: CpuWork,
): { ratio: number; subjectMs: number; referenceMs: number } {
  const subjectMs = bestCpuMs(subject, 5)
  const referenceMs = bestCpuMs(reference, 3)
  return { ratio: subjectMs / referenceMs, subjectMs, referenceMs }
}
