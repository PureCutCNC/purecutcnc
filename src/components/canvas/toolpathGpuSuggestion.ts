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

export const GPU_SUGGESTION_STORAGE_KEY = 'purecutcnc.gpuSuggestionHandled'
export const GPU_SUGGESTION_CODEC = {
  serialize: (value: boolean) => String(value),
  deserialize: (raw: string): boolean => {
    if (raw !== 'true' && raw !== 'false') throw new Error('Invalid GPU suggestion preference')
    return raw === 'true'
  },
}

export interface CanvasDrawSample {
  durationMs: number
  now: number
  navigating: boolean
}

// UX heuristics, not a capacity limit or measured FPS. Tests supply samples;
// they never assert real execution time on the build machine.
const SLOW_DRAW_MS = 40
const REQUIRED_SLOW_DRAWS = 6
const MAX_SAMPLE_GAP_MS = 1500

/** A bounded gesture-local detector; emits only on the idle redraw. */
export function createSlowCanvasDetector() {
  let count = 0
  let previous: number | null = null
  const reset = () => { count = 0; previous = null }
  return {
    reset,
    observe({ durationMs, now, navigating }: CanvasDrawSample): boolean {
      if (!Number.isFinite(durationMs) || durationMs < 0 || !Number.isFinite(now)) {
        reset()
        return false
      }
      const gap = previous === null ? Infinity : now - previous
      // A very expensive draw is evidence, not an idle gap.
      const idleGap = gap - (navigating ? durationMs : 0)
      if (gap < 0 || idleGap > MAX_SAMPLE_GAP_MS) reset()
      if (!navigating) {
        const suggest = count >= REQUIRED_SLOW_DRAWS
        reset()
        return suggest
      }
      // Ignore the first navigation draw after result replacement/idle/gaps.
      if (previous !== null) count = durationMs >= SLOW_DRAW_MS ? Math.min(count + 1, REQUIRED_SLOW_DRAWS) : 0
      previous = now
      return false
    },
  }
}
