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

import { useRef, useState } from 'react'
import { Icon } from '../Icon'
import { useProjectStore } from '../../store/projectStore'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import type { DimensionType } from '../../types/project'

const DIMENSION_TYPES: { type: DimensionType; icon: string; hint: string }[] = [
  { type: 'aligned', icon: 'dim-aligned', hint: 'Aligned dimension' },
  { type: 'horizontal', icon: 'dim-horizontal', hint: 'Horizontal dimension' },
  { type: 'vertical', icon: 'dim-vertical', hint: 'Vertical dimension' },
  { type: 'radius', icon: 'dim-radius', hint: 'Radius dimension' },
  { type: 'diameter', icon: 'dim-diameter', hint: 'Diameter dimension' },
  { type: 'angle', icon: 'dim-angle', hint: 'Angle dimension' },
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
  const dimensionDeleteArmed = useProjectStore((s) => s.dimensionDeleteArmed)
  const setDimensionDeleteArmed = useProjectStore((s) => s.setDimensionDeleteArmed)

  const tapeActive = tapeMeasure !== null
  const dimType = pendingDimension?.type ?? null
  const anyActive = tapeActive || pendingDimension !== null || dimensionDeleteArmed

  useOutsideDismiss({ open, refs: containerRef, onDismiss: () => setOpen(false) })

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
          <div className="snap-popover-grid snap-popover-grid--icon-only" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <button
              className={`snap-popover-item ${tapeActive ? 'snap-popover-item--active' : ''}`}
              type="button"
              aria-label="Tape measure"
              aria-pressed={tapeActive}
              title={tapeActive ? 'Stop tape measure' : 'Tape measure'}
              onClick={toggleTape}
            >
              <Icon id="tape-measure" />
            </button>
            <button
              className={`snap-popover-item ${showDimensions ? 'snap-popover-item--active' : ''}`}
              type="button"
              aria-label="Show or hide dimensions"
              aria-pressed={showDimensions}
              title={dimensionCount > 0
                ? `${showDimensions ? 'Hide' : 'Show'} dimensions (${dimensionCount})`
                : 'Show/hide dimensions'}
              onClick={() => setShowDimensions(!showDimensions)}
            >
              <Icon id={showDimensions ? 'eye' : 'eye-off'} />
            </button>
            <button
              className={`snap-popover-item ${dimensionDeleteArmed ? 'snap-popover-item--active' : ''}`}
              type="button"
              aria-label="Delete dimension"
              aria-pressed={dimensionDeleteArmed}
              disabled={dimensionCount === 0}
              title={dimensionDeleteArmed ? 'Click a dimension to delete' : 'Delete dimension'}
              onClick={() => setDimensionDeleteArmed(!dimensionDeleteArmed)}
            >
              <Icon id="trash" />
            </button>
            {DIMENSION_TYPES.map(({ type, icon, hint }) => {
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
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
