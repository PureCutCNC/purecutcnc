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

import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../../store/projectStore'
import type { DimensionType } from '../../types/project'

const DIMENSION_TYPES: { type: DimensionType; label: string; hint: string }[] = [
  { type: 'aligned', label: 'Aligned', hint: 'Parallel distance between two points' },
  { type: 'horizontal', label: 'Horizontal', hint: 'Horizontal distance (Δx)' },
  { type: 'vertical', label: 'Vertical', hint: 'Vertical distance (Δy)' },
  { type: 'radius', label: 'Radius', hint: 'Radius of an arc/circle' },
  { type: 'diameter', label: 'Diameter', hint: 'Diameter of an arc/circle' },
  { type: 'angle', label: 'Angle', hint: 'Angle at a vertex between two points' },
]

/** Small inline ruler glyph so we don't depend on the icon sprite pipeline. */
function RulerGlyph() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
      <rect x={2.5} y={7} width={19} height={10} rx={1.5} />
      <path d="M6.5 7v3M10 7v4M13.5 7v3M17 7v4" />
    </svg>
  )
}

export function DimensionPopover() {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const tapeMeasure = useProjectStore((s) => s.tapeMeasure)
  const pendingDimension = useProjectStore((s) => s.pendingDimension)
  const startTapeMeasure = useProjectStore((s) => s.startTapeMeasure)
  const clearTapeMeasure = useProjectStore((s) => s.clearTapeMeasure)
  const startDimensionTool = useProjectStore((s) => s.startDimensionTool)
  const cancelPendingDimension = useProjectStore((s) => s.cancelPendingDimension)

  const tapeActive = tapeMeasure !== null
  const dimType = pendingDimension?.type ?? null
  const anyActive = tapeActive || pendingDimension !== null

  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  function toggleTape() {
    if (tapeActive) clearTapeMeasure()
    else startTapeMeasure()
  }

  function pickType(type: DimensionType) {
    if (dimType === type) cancelPendingDimension()
    else startDimensionTool(type)
  }

  return (
    <div className="snap-popover-host" ref={containerRef}>
      <div className="toolbar-action">
        <button
          className={`toolbar-icon-btn ${anyActive ? 'toolbar-icon-btn--active' : ''}`}
          type="button"
          aria-label="Measure and dimensions"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          <RulerGlyph />
        </button>
        <span className="toolbar-tooltip toolbar-tooltip--bottom" role="tooltip">
          Measure &amp; dimensions
        </span>
      </div>
      {open && (
        <div className="snap-popover" role="menu">
          <div className="snap-popover-header">
            <button
              className={`snap-popover-enable-btn ${tapeActive ? 'snap-popover-enable-btn--active' : ''}`}
              type="button"
              onClick={toggleTape}
            >
              {tapeActive ? 'Tape measure on' : 'Tape measure'}
            </button>
          </div>
          <div className="snap-popover-grid">
            {DIMENSION_TYPES.map(({ type, label, hint }) => {
              const active = dimType === type
              return (
                <button
                  key={type}
                  className={`snap-popover-item ${active ? 'snap-popover-item--active' : ''}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  aria-label={hint}
                  title={hint}
                  onClick={() => pickType(type)}
                >
                  <span className="snap-popover-item-label">{label}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
