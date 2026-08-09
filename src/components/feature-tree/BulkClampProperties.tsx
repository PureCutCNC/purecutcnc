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

import { useMemo, useCallback } from 'react'
import type { Clamp } from '../../types/project'
import { useProjectStore } from '../../store/projectStore'
import { convertLength } from '../../utils/units'
import { useI18n } from '../../i18n/i18nContext'
import { DraftNumberInput } from './DraftNumberInput'
import { ZRangeSlider } from './ZRangeSlider'
import { commonNumber, commonBoolean, clampDomainMax, validateZEdits } from './mixedValue'

interface BulkClampPropertiesProps {
  selectedClamps: Clamp[]
  units: 'mm' | 'inch'
  onClose: () => void
}

export function BulkClampProperties({ selectedClamps, units, onClose }: BulkClampPropertiesProps) {
  const { t } = useI18n()
  const updateClamps = useProjectStore((s) => s.updateClamps)
  const deleteClamps = useProjectStore((s) => s.deleteClamps)

  const ids = useMemo(() => selectedClamps.map((c) => c.id), [selectedClamps])

  const commonW = commonNumber(selectedClamps, (c) => c.w)
  const commonH = commonNumber(selectedClamps, (c) => c.h)
  const commonHeight = commonNumber(selectedClamps, (c) => c.height)
  const commonVisible = commonBoolean(selectedClamps, (c) => c.visible)

  const allHeights = selectedClamps.map((c) => c.height)
  const clampFloor = convertLength(5, 'mm', units)
  const clampHeadroom = convertLength(5, 'mm', units)
  const effectiveDomainMax = clampDomainMax(allHeights, clampFloor, clampHeadroom)
  const minimumSize = convertLength(0.1, 'mm', units)

  const mixedPlaceholder = t('featureTree.properties.select.mixedValues')

  const selectionKey = useMemo(() => `bulk-clamps-${ids.join(',')}`, [ids])

  const handleZCommit = useCallback(
    (patch: { top?: number; bottom?: number }): boolean => {
      // Clamp Z top = height (physical height above zero).
      // Clamp Z bottom is fixed at 0 — validate against it, ignore bottom commits.
      if (!validateZEdits(selectedClamps, (c) => c.height, () => 0, patch)) return false
      if (patch.top !== undefined) {
        updateClamps(ids, { height: patch.top })
      }
      return true
    },
    [ids, selectedClamps, updateClamps],
  )

  return (
    <div className="properties-panel">
      <div className="properties-group">
        <label className="properties-field">
          <span>{t('featureTree.properties.selection')}</span>
          <span className="properties-readonly-field">{t('featureTree.properties.multi.clampsCount', { count: ids.length })}</span>
        </label>
        <label className="properties-field">
          <span>{t('featureTree.properties.width')}</span>
          <DraftNumberInput
            key={`bulk-clamps-w-${ids.join(',')}-${commonW ?? 'mixed'}`}
            value={commonW}
            units={units}
            min={minimumSize}
            placeholder={commonW === null ? mixedPlaceholder : undefined}
            onCommit={(next) => updateClamps(ids, { w: next })}
          />
        </label>
        <label className="properties-field">
          <span>{t('featureTree.properties.height')}</span>
          <DraftNumberInput
            key={`bulk-clamps-h-${ids.join(',')}-${commonH ?? 'mixed'}`}
            value={commonH}
            units={units}
            min={minimumSize}
            placeholder={commonH === null ? mixedPlaceholder : undefined}
            onCommit={(next) => updateClamps(ids, { h: next })}
          />
        </label>
        <ZRangeSlider
          selectionKey={selectionKey}
          zTop={commonHeight}
          zBottom={0}
          domainMin={0}
          domainMax={effectiveDomainMax}
          units={units}
          bottomLocked
          mixedPlaceholder={mixedPlaceholder}
          onCommit={handleZCommit}
        />
        <label className="properties-check">
          <input
            type="checkbox"
            ref={(el) => {
              if (!el) return
              el.indeterminate = commonVisible === null
              el.checked = commonVisible === true
            }}
            onChange={(event) => updateClamps(ids, { visible: event.target.checked })}
          />
          <span>{t('featureTree.properties.visible')}</span>
        </label>
      </div>
      <div className="properties-actions">
        <button className="feat-btn feat-btn--delete" type="button" onClick={() => { deleteClamps(ids); onClose() }}>
          {t('featureTree.properties.deleteSelected')}
        </button>
      </div>
    </div>
  )
}
