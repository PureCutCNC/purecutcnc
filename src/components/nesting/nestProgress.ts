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

// Timing and progress helpers for the Nest panel's running line (#869).

/** Elapsed time as m:ss, or h:mm:ss from an hour on. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

/**
 * Passes on the first call and then at most one call per `intervalMs`, so a
 * worker placing hundreds of copies a second does not flood the main thread.
 */
export function throttle<A extends unknown[]>(
  call: (...args: A) => void,
  intervalMs: number,
  now: () => number = () => Date.now(),
): (...args: A) => void {
  let last = -Infinity
  return (...args: A) => {
    const time = now()
    if (time - last < intervalMs) return
    last = time
    call(...args)
  }
}
