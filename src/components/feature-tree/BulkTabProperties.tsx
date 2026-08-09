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
import type { Tab } from '../../types/project'
import { useProjectStore } from '../../store/projectStore'
import { convertLength } from '../../utils/units'
import { useI18n } from '../../i18n/i18nContext'
import { DraftNumberInput } from './DraftNumberInput'
import { ZRangeSlider } from './ZRangeSlider'
import { commonNumber, commonBoolean, zDomainMax } from './mixedValue'

interface BulkTabPropertiesProps {
  selectedTabs: Tab[]
  units: 'mm' | 'inch'
  onClose: () => void
}

export function BulkTabProperties({ selectedTabs, units, onClose }: BulkTabPropertiesProps) {
  const { t } = useI18n()
  const updateTabs = useProjectStore((s) => s.updateTabs)
  const deleteTabs = useProjectStore((s) => s.deleteTabs)

  const ids = useMemo(() => selectedTabs.map((tab) => tab.id), [selectedTabs])

  const commonW = commonNumber(selectedTabs, (tab) => tab.w)
  const commonH = commonNumber(selectedTabs, (tab) => tab.h)
  const commonZTop = commonNumber(selectedTabs, (tab) => tab.z_top)
  const commonZBottom = commonNumber(selectedTabs, (tab) => tab.z_bottom)
  const commonVisible = commonBoolean(selectedTabs, (tab) => tab.visible)

  const allZTops = selectedTabs.map((tab) => tab.z_top)
  const allZBottoms = selectedTabs.map((tab) => tab.z_bottom)

  const effectiveDomainMax = zDomainMax([...allZTops, ...allZBottoms], convertLength(5, 'mm', units))
  const minimumSize = convertLength(0.1, 'mm', units)

  const mixedPlaceholder = t('featureTree.properties.select.mixedValues')

  const selectionKey = useMemo(() => `bulk-tabs-${ids.join(',')}`, [ids])

  const handleZCommit = useCallback(
    (patch: { top?: number; bottom?: number }) => {
      const storePatch: Partial<Tab> = {}
      if (patch.top !== undefined) {
        // Validate z_bottom <= z_top for every selected tab.
        const top = patch.top
        storePatch.z_top = top
        for (const tab of selectedTabs) {
          if (top < tab.z_bottom) return
        }
      }
      if (patch.bottom !== undefined) {
        const bottom = patch.bottom
        storePatch.z_bottom = bottom
        for (const tab of selectedTabs) {
          if (bottom > tab.z_top) return
        }
      }
      if (Object.keys(storePatch).length > 0) {
        updateTabs(ids, storePatch)
      }
    },
    [ids, selectedTabs, updateTabs],
  )

  return (
    <div className="properties-panel">
      <div className="properties-group">
        <label className="properties-field">
          <span>{t('featureTree.properties.selection')}</span>
          <span className="properties-readonly-field">{t('featureTree.properties.multi.tabsCount', { count: ids.length })}</span>
        </label>
        <label className="properties-field">
          <span>{t('featureTree.properties.width')}</span>
          <DraftNumberInput
            key={`bulk-tabs-w-${ids.join(',')}-${commonW ?? 'mixed'}`}
            value={commonW}
            units={units}
            min={minimumSize}
            placeholder={commonW === null ? mixedPlaceholder : undefined}
            onCommit={(next) => updateTabs(ids, { w: next })}
          />
        </label>
        <label className="properties-field">
          <span>{t('featureTree.properties.height')}</span>
          <DraftNumberInput
            key={`bulk-tabs-h-${ids.join(',')}-${commonH ?? 'mixed'}`}
            value={commonH}
            units={units}
            min={minimumSize}
            placeholder={commonH === null ? mixedPlaceholder : undefined}
            onCommit={(next) => updateTabs(ids, { h: next })}
          />
        </label>
        <ZRangeSlider
          selectionKey={selectionKey}
          zTop={commonZTop}
          zBottom={commonZBottom}
          domainMin={0}
          domainMax={effectiveDomainMax}
          units={units}
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
            onChange={(event) => updateTabs(ids, { visible: event.target.checked })}
          />
          <span>{t('featureTree.properties.visible')}</span>
        </label>
      </div>
      <div className="properties-actions">
        <button className="feat-btn feat-btn--delete" type="button" onClick={() => { deleteTabs(ids); onClose() }}>
          {t('featureTree.properties.deleteSelected')}
        </button>
      </div>
    </div>
  )
}
