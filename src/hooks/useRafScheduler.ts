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

import { useCallback, useEffect, useRef } from 'react'
import { useStableEvent } from './useStableEvent'

/**
 * React-free core of {@link useRafScheduler}, extracted so the coalescing /
 * cancellation invariants can be unit-tested without a DOM or React renderer.
 *
 * `schedule()` requests a single animation frame; further `schedule()` calls
 * while a frame is pending are no-ops, so any number of calls within one frame
 * coalesce into exactly one `run()`. `cancel()` drops a pending frame.
 */
export function createRafScheduler(
  run: () => void,
  raf: (callback: FrameRequestCallback) => number,
  caf: (handle: number) => void,
) {
  let frame: number | null = null

  const schedule = (): void => {
    if (frame !== null) {
      return
    }
    frame = raf(() => {
      frame = null
      run()
    })
  }

  const cancel = (): void => {
    if (frame !== null) {
      caf(frame)
      frame = null
    }
  }

  return { schedule, cancel }
}

/**
 * Returns a **stable** `schedule()` that coalesces repeated calls into a single
 * `requestAnimationFrame`, runs the latest `callback` on that frame, and cancels
 * any pending frame on unmount.
 *
 * Replaces ad-hoc `scheduleDraw` closures that were re-created every render: the
 * returned `schedule` never changes identity, so it can be listed in (or safely
 * omitted from) effect dependency arrays. The callback is routed through
 * {@link useStableEvent}, so the freshest closure runs without re-subscribing.
 */
export function useRafScheduler(callback: () => void): () => void {
  const run = useStableEvent(callback)
  const schedulerRef = useRef<ReturnType<typeof createRafScheduler> | null>(null)
  if (schedulerRef.current === null) {
    schedulerRef.current = createRafScheduler(
      () => run(),
      (cb) => window.requestAnimationFrame(cb),
      (handle) => window.cancelAnimationFrame(handle),
    )
  }

  useEffect(() => () => schedulerRef.current?.cancel(), [])

  // Stable identity via useCallback([]); the scheduler instance never changes.
  return useCallback(() => schedulerRef.current!.schedule(), [])
}
