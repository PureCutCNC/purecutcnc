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

/** Transient detail suppression; never changes a user's visibility settings. */
export function createNavigationActivity(
  redraw: () => void,
  schedule: (callback: () => void, delay: number) => number,
  cancel: (handle: number) => void,
) {
  const pointers = new Set<number>()
  let timer: number | null = null
  let active = false

  const cancelIdle = () => {
    if (timer !== null) cancel(timer)
    timer = null
  }
  const finish = () => {
    cancelIdle()
    if (!active) return
    active = false
    redraw()
  }

  return {
    get active() { return active },
    changed() {
      active = true
      cancelIdle()
      timer = schedule(() => {
        timer = null
        // A stationary finger/mouse still belongs to the current gesture.
        if (pointers.size === 0) finish()
      }, 150)
    },
    pointerDown(id: number) { pointers.add(id) },
    pointerUp(id: number) {
      pointers.delete(id)
      if (pointers.size === 0) finish()
    },
    blur() { pointers.clear(); finish() },
    dispose() { cancelIdle(); pointers.clear(); active = false },
  }
}
