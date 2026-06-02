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
import { Icon } from '../Icon'
import { useProjectStore } from '../../store/projectStore'
import type { DimensionType } from '../../types/project'

const DIMENSION_TYPES: { type: DimensionType; icon: string; label: string; hint: string }[] = [
  { type: 'aligned', icon: 'dim-aligned', label: 'Aligned', hint: 'Parallel distance between two points' },
  { type: 'horizontal', icon: 'dim-horizontal', label: 'Horizontal', hint: 'Horizontal distance (Δx)' },
  { type: 'vertical', icon: 'dim-vertical', label: 'Vertical', hint: 'Vertical distance (Δy)' },
  { type: 'radius', icon: 'dim-radius', label: 'Radius', hint: 'Radius of an arc/circle' },
  { type: 'diameter', icon: 'dim-diameter', label: 'Diameter', hint: 'Diameter of an arc/circle' },
  { type: 'angle', icon: 'dim-angle', label: 'Angle', hint: 'Angle at a vertex between two points' },
]

export function DimensionPopover() {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const tapeMeasure = useProjectStore((s) => s.tapeMeasure)
  const pendingDimension = useProjectStore((s) => s.pendingDimension)
  const startTapeMeasure = useProjectStore((s) => s.startTapeMeasure)
  const clearTapeMeasure = useProjectStore((s) => s.clearTapeMeasure)
  const startDimensionTool = useProjectStore((s) => s.startDimensionTool)
  const cancelPendingDimension = useProjectStore((s) => s.cancelPendingDimension)
  const showDimensions = useProjectStore((s) => s.project.meta.showDimensions)
  const setShowDimensions = useProjectStore((s) => s.setShowDimensions)
  const dimensionCount = useProjectStore((s) => s.project.annotations.length)

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
          <Icon id="measure" />
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
            <button
              className={`snap-popover-enable-btn ${showDimensions ? 'snap-popover-enable-btn--active' : ''}`}
              type="button"
              aria-pressed={showDimensions}
              title={dimensionCount > 0 ? `${dimensionCount} dimension${dimensionCount === 1 ? '' : 's'}` : 'No dimensions yet'}
              onClick={() => setShowDimensions(!showDimensions)}
            >
              {showDimensions ? 'Dimensions shown' : 'Dimensions hidden'}
            </button>
          </div>
          <div className="snap-popover-grid">
            {DIMENSION_TYPES.map(({ type, icon, label, hint }) => {
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
                  <Icon id={icon} />
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
