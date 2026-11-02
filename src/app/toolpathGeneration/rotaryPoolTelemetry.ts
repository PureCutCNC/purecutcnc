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
 * What the last rotary generation reported about its angle pool (#1115 p-d3),
 * and what the worker said about the ones it cancelled.
 *
 * The pool runs *between* the generation worker and the angle workers, so the
 * main thread cannot see its batches directly. The generation worker therefore
 * reports them on its completed message, and the executor records the report
 * here. `batches > 0` with more than one worker is the evidence that angle
 * workers really sampled and answered — not merely that threads started.
 *
 * A plain module value rather than a store slice: nothing renders it, it is not
 * project state, and the only reader is the DEV-only Playwright seam in
 * `main.tsx` (see `__pcTest.getRotaryPoolStats`). Keeping the record here rather
 * than in the reactivity path is what stops it becoming a second source of
 * generation state.
 */

import type { RotaryPoolReport } from './protocol'

export interface RotaryPoolTelemetry {
  /** The most recent rotary generation's pool, or null before one has run. */
  readonly last: RotaryPoolReport | null
  /** How many rotary generations have reported since the page loaded. */
  readonly generations: number
  /**
   * How many superseded rotary generations have reported that they stopped
   * (#1115 p-d3 fix 2). A cancellation that is abandoned mid-batch never
   * increments this, which is the difference between "cancelled" and "still
   * holding the previous operation's data".
   */
  readonly cancelled: number
}

let last: RotaryPoolReport | null = null
let generations = 0
let cancelled = 0

export function recordRotaryPoolReport(report: RotaryPoolReport): void {
  last = report
  generations += 1
}

export function recordRotaryCancelled(): void {
  cancelled += 1
}

export function readRotaryPoolTelemetry(): RotaryPoolTelemetry {
  return { last, generations, cancelled }
}
