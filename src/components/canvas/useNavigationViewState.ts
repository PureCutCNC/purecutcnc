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

import { useCallback, useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { useStableEvent } from '../../hooks/useStableEvent'
import { createNavigationActivity } from './navigationActivity'
import type { SketchViewState } from './viewTransform'

/** All view changes (mouse, touch, wheel, fit) share one navigation lifecycle. */
export function useNavigationViewState(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  scheduleDraw: () => void,
) {
  const [viewState, updateViewState] = useState<SketchViewState>({ zoom: 1, panX: 0, panY: 0 })
  const redraw = useStableEvent(scheduleDraw)
  const [navigation] = useState(() => createNavigationActivity(
    redraw,
    (callback, delay) => window.setTimeout(callback, delay),
    (handle) => window.clearTimeout(handle),
  ))

  const setViewState: Dispatch<SetStateAction<SketchViewState>> = useCallback((next) => {
    // Keep side effects outside React's state updater: Strict Mode may replay it.
    navigation.changed()
    updateViewState(next)
  }, [navigation])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const down = (event: PointerEvent) => navigation.pointerDown(event.pointerId)
    const up = (event: PointerEvent) => navigation.pointerUp(event.pointerId)
    const blur = () => navigation.blur()
    canvas.addEventListener('pointerdown', down, true)
    canvas.addEventListener('lostpointercapture', up)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    window.addEventListener('blur', blur)
    return () => {
      canvas.removeEventListener('pointerdown', down, true)
      canvas.removeEventListener('lostpointercapture', up)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      window.removeEventListener('blur', blur)
      navigation.dispose()
    }
  }, [canvasRef, navigation])

  return { viewState, setViewState, navigation }
}
