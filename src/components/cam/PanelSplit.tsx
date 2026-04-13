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
  const [ratio, setRatio] = useState<number>(() => {
    if (storageKey) {
      const stored = localStorage.getItem(`panel-split:${storageKey}`)
      if (stored !== null) {
        const parsed = parseFloat(stored)
        if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) {
          return parsed
        }
      }
    }
    return initialRatio
  })

  const containerRef = useRef<HTMLDivElement>(null)

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      const container = containerRef.current
      if (!container) return

      const rect = container.getBoundingClientRect()
      const totalHeight = rect.height
      const offsetY = e.clientY - rect.top

      const minRatio = minFirst / totalHeight
      const maxRatio = 1 - minSecond / totalHeight
      const newRatio = Math.max(minRatio, Math.min(maxRatio, offsetY / totalHeight))

      setRatio(newRatio)
      if (storageKey) {
        localStorage.setItem(`panel-split:${storageKey}`, String(newRatio))
      }
    },
    [minFirst, minSecond, storageKey],
  )

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
