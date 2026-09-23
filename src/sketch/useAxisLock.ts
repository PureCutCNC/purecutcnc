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

import { useCallback, useRef, useState } from 'react'
import type { LockMode } from '../types/axisLock'
import type { Point } from '../types/project'
import { useStableEvent } from '../hooks/useStableEvent'
import { useWindowEvent } from '../hooks/useEventListener'
import { canvasRgba } from '../components/canvas/canvasPalette'

/**
 * @param isActive - Whether the sketch view currently owns keyboard shortcuts.
 * @param onLockChange - Called whenever the lock mode changes so the caller can redraw.
 */
export function useAxisLock(isActive: boolean, onLockChange?: () => void) {
  const lockModeRef = useRef<LockMode>('none')
  const altTapPendingRef = useRef(false)
  const [lockMode, setLockMode] = useState<LockMode>('none')
  // Stable wrapper so the latest `onLockChange` is invoked without writing a ref
  // during render (react-hooks/refs).
  const emitLockChange = useStableEvent(() => onLockChange?.())

  function setLock(mode: LockMode) {
    lockModeRef.current = mode
    setLockMode(mode)
    emitLockChange()
  }

  useWindowEvent('keydown', (event) => {
    if (event.key !== 'Alt') {
      altTapPendingRef.current = false
      return
    }
    if (event.repeat) return
    altTapPendingRef.current = isActive && !isEditableKeyboardTarget(event.target) && !event.ctrlKey && !event.metaKey
      && !event.shiftKey && !event.getModifierState('AltGraph')
  })

  useWindowEvent('keyup', (event) => {
    if (event.key !== 'Alt') return
    const completedTap = altTapPendingRef.current && isActive && document.hasFocus()
      && !isEditableKeyboardTarget(event.target)
      && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.getModifierState('AltGraph')
    altTapPendingRef.current = false
    if (completedTap) setLock(cycleLockMode(lockModeRef.current))
  })

  useWindowEvent('blur', () => {
    altTapPendingRef.current = false
  })

  const reset = useCallback(() => {
    altTapPendingRef.current = false
    lockModeRef.current = 'none'
    setLockMode('none')
  }, [])

  /**
   * Applies the current lock mode to constrain `point` relative to `origin`.
   * - Lock X: keeps Y fixed at origin.y
   * - Lock Y: keeps X fixed at origin.x
   * - None: returns point unchanged
   */
  const applyLock = useCallback((point: Point, origin: Point): Point => {
    const mode = lockModeRef.current
    if (mode === 'x') return { x: point.x, y: origin.y }
    if (mode === 'y') return { x: origin.x, y: point.y }
    return point
  }, [])

  // useStableEvent (not useCallback) so this can call the non-memoized `setLock`
  // without a manual-memoization mismatch, while keeping a stable identity.
  const cycleLock = useStableEvent(() => {
    setLock(cycleLockMode(lockModeRef.current))
  })

  return { lockModeRef, lockMode, applyLock, cycleLock, reset }
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]') !== null
  )
}

/** Cycles through lock modes: none → x → y → none */
export function cycleLockMode(current: LockMode): LockMode {
  if (current === 'none') return 'x'
  if (current === 'x') return 'y'
  return 'none'
}

/** Returns the stroke color for the move guide based on lock mode. */
export function lockModeGuideColor(mode: LockMode): string {
  // Reuses the origin axis colours so an X/Y lock reads the same as the axis it
  // constrains to; the unlocked guide follows the draft accent.
  if (mode === 'x') return canvasRgba('originAxisX', 0.85)
  if (mode === 'y') return canvasRgba('originAxisY', 0.85)
  return canvasRgba('draft', 0.75)
}
