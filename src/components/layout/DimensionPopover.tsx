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
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import type { DimensionType } from '../../types/project'

const DIMENSION_TYPES: { type: DimensionType; icon: string; hintKey: MessageKey }[] = [
  { type: 'aligned', icon: 'dim-aligned', hintKey: 'shell.measure.dimAligned' },
  { type: 'horizontal', icon: 'dim-horizontal', hintKey: 'shell.measure.dimHorizontal' },
  { type: 'vertical', icon: 'dim-vertical', hintKey: 'shell.measure.dimVertical' },
  { type: 'radius', icon: 'dim-radius', hintKey: 'shell.measure.dimRadius' },
  { type: 'diameter', icon: 'dim-diameter', hintKey: 'shell.measure.dimDiameter' },
  { type: 'angle', icon: 'dim-angle', hintKey: 'shell.measure.dimAngle' },
]

export function DimensionPopover() {
  const { t, tPlural } = useI18n()
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
          aria-label={t('shell.measure.aria')}
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          <Icon id="measure" />
        </button>
        <span className="toolbar-tooltip toolbar-tooltip--bottom" role="tooltip">
          {t('shell.measure.tooltip')}
        </span>
      </div>
      {open && (
        <div className="snap-popover" role="menu">
          <div className="snap-popover-grid snap-popover-grid--icon-only" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <button
              className={`snap-popover-item ${tapeActive ? 'snap-popover-item--active' : ''}`}
              type="button"
              aria-label={t('shell.measure.tapeMeasure')}
              aria-pressed={tapeActive}
              title={tapeActive ? t('shell.measure.stopTapeMeasure') : t('shell.measure.tapeMeasure')}
              onClick={toggleTape}
            >
              <Icon id="tape-measure" />
            </button>
            <button
              className={`snap-popover-item ${showDimensions ? 'snap-popover-item--active' : ''}`}
              type="button"
              aria-label={t('shell.measure.showOrHideAria')}
              aria-pressed={showDimensions}
              title={dimensionCount > 0
                ? (showDimensions
                    ? tPlural(dimensionCount, 'shell.measure.hideDimensionsCount.one', 'shell.measure.hideDimensionsCount.other')
                    : tPlural(dimensionCount, 'shell.measure.showDimensionsCount.one', 'shell.measure.showDimensionsCount.other'))
                : t('shell.measure.showHideDimensions')}
              onClick={() => setShowDimensions(!showDimensions)}
            >
              <Icon id={showDimensions ? 'eye' : 'eye-off'} />
            </button>
            <button
              className={`snap-popover-item ${dimensionDeleteArmed ? 'snap-popover-item--active' : ''}`}
              type="button"
              aria-label={t('shell.measure.deleteDimension')}
              aria-pressed={dimensionDeleteArmed}
              disabled={dimensionCount === 0}
              title={dimensionDeleteArmed ? t('shell.measure.deleteDimensionClickOne') : t('shell.measure.deleteDimension')}
              onClick={() => setDimensionDeleteArmed(!dimensionDeleteArmed)}
            >
              <Icon id="trash" />
            </button>
            {DIMENSION_TYPES.map(({ type, icon, hintKey }) => {
              const active = dimType === type
              return (
                <button
                  key={type}
                  className={`snap-popover-item ${active ? 'snap-popover-item--active' : ''}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  aria-label={t(hintKey)}
                  title={t(hintKey)}
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
