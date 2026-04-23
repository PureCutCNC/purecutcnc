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
import type { LockMode } from '../types/axisLock'
import type { Point } from '../types/project'

/**
 * Manages axis lock state during drag operations.
 *
 * Pressing Alt/Option while dragging cycles through: none → x → y → none.
 * The lock is automatically reset when `active` becomes false.
 *
 * @param active - Whether a drag operation is currently in progress.
 * @returns Object with the current lock mode ref and a function to apply the lock to a point.
 */
/**
 * @param active - Whether a drag operation is currently in progress.
 * @param onLockChange - Called whenever the lock mode changes so the caller can redraw.
 */
export function useAxisLock(active: boolean, onLockChange?: () => void) {
  const lockModeRef = useRef<LockMode>('none')
  const onLockChangeRef = useRef(onLockChange)
  onLockChangeRef.current = onLockChange

  // Reset lock when drag ends
  useEffect(() => {
    if (!active) {
      lockModeRef.current = 'none'
    }
  }, [active])

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!active) return
    if (event.key !== 'Alt') return
    // Prevent browser default (e.g. focus menu bar on some platforms)
    event.preventDefault()
    lockModeRef.current = cycleLockMode(lockModeRef.current)
    onLockChangeRef.current?.()
  }, [active])

  useEffect(() => {
    if (!active) return
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [active, handleKeyDown])

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

  return { lockModeRef, applyLock }
}

/** Cycles through lock modes: none → x → y → none */
export function cycleLockMode(current: LockMode): LockMode {
  if (current === 'none') return 'x'
  if (current === 'x') return 'y'
  return 'none'
}

/** Returns the stroke color for the move guide based on lock mode. */
export function lockModeGuideColor(mode: LockMode): string {
  if (mode === 'x') return 'rgba(220, 60, 60, 0.85)'
  if (mode === 'y') return 'rgba(60, 180, 60, 0.85)'
  return 'rgba(239, 188, 122, 0.75)'
}
