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
import { useLocalStorageState, type StorageCodec } from '../../hooks/useLocalStorageState'

// Persist the split fraction as a bare number string (`String(ratio)`), matching
// the prior hand-rolled format. deserialize rejects non-finite or out-of-(0,1)
// values by throwing, so the hook falls back to the panel's initial ratio —
// reproducing the original `parseFloat` + range-check guard exactly.
const RATIO_CODEC: StorageCodec<number> = {
  serialize: (ratio) => String(ratio),
  deserialize: (raw) => {
    const parsed = parseFloat(raw)
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
      throw new Error('panel-split ratio out of range')
    }
    return parsed
  },
}

interface PanelSplitProps {
  children: [React.ReactNode, React.ReactNode]
  /** localStorage key for persisting the split position */
  storageKey?: string
  /** Initial fraction (0–1) for the first panel. Default 0.5. */
  initialRatio?: number
  /** Minimum height in px for the first panel. Default 120. */
  minFirst?: number
  /** Minimum height in px for the second panel. Default 120. */
  minSecond?: number
  /** Extra class names applied to the outer container */
  className?: string
}

export function PanelSplit({
  children,
  storageKey,
  initialRatio = 0.5,
  minFirst = 120,
  minSecond = 120,
  className,
}: PanelSplitProps) {
  // Optional key → persist; no key keeps the split in-memory only (enabled:false),
  // preserving the prior `if (storageKey)` gate without a conditional hook.
  const [ratio, setRatio] = useLocalStorageState<number>(
    storageKey ? `panel-split:${storageKey}` : 'panel-split',
    initialRatio,
    { codec: RATIO_CODEC, enabled: Boolean(storageKey) },
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const activePointerRef = useRef<number | null>(null)

  const resizeAt = useCallback(
    (clientY: number) => {
      const container = containerRef.current
      if (!container) return

      const rect = container.getBoundingClientRect()
      const totalHeight = rect.height
      const offsetY = clientY - rect.top

      const minRatio = minFirst / totalHeight
      const maxRatio = 1 - minSecond / totalHeight
      const newRatio = Math.max(minRatio, Math.min(maxRatio, offsetY / totalHeight))

      // The hook persists `ratio` to `panel-split:${storageKey}` automatically.
      setRatio(newRatio)
    },
    [minFirst, minSecond, setRatio],
  )

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    activePointerRef.current = e.pointerId
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Window-level pointer tracking below keeps resizing working if capture is unavailable.
    }
  }, [])

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (activePointerRef.current !== e.pointerId && !e.currentTarget.hasPointerCapture(e.pointerId)) return
      resizeAt(e.clientY)
    },
    [resizeAt],
  )

  useEffect(() => {
    function handleWindowPointerMove(event: PointerEvent) {
      if (activePointerRef.current !== event.pointerId) return
      event.preventDefault()
      resizeAt(event.clientY)
    }

    function handleWindowPointerEnd(event: PointerEvent) {
      if (activePointerRef.current === event.pointerId) {
        activePointerRef.current = null
      }
    }

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: false })
    window.addEventListener('pointerup', handleWindowPointerEnd)
    window.addEventListener('pointercancel', handleWindowPointerEnd)
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handleWindowPointerEnd)
      window.removeEventListener('pointercancel', handleWindowPointerEnd)
    }
  }, [resizeAt])

  const classes = ['panel-split', className].filter(Boolean).join(' ')

  return (
    <div
      ref={containerRef}
      className={classes}
      style={{ display: 'grid', gap: 0, gridTemplateRows: `${ratio}fr 8px ${1 - ratio}fr` }}
    >
      {children[0]}
      <div
        className="panel-split__divider"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
      />
      {children[1]}
    </div>
  )
}
