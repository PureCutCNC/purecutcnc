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
import type { Tab, TabShape } from '../../types/project'
import { tabShape } from '../../types/project'
import { useProjectStore } from '../../store/projectStore'
import { convertLength } from '../../utils/units'
import { useI18n } from '../../i18n/i18nContext'
import { DraftNumberInput } from './DraftNumberInput'
import { ZRangeSlider } from './ZRangeSlider'
import { commonNumber, commonBoolean, commonValue, zDomainMax, validateZEdits } from './mixedValue'

interface BulkTabPropertiesProps {
  selectedTabs: Tab[]
  units: 'mm' | 'inch'
  stockThickness: number
  onClose: () => void
}

export function BulkTabProperties({ selectedTabs, units, stockThickness, onClose }: BulkTabPropertiesProps) {
  const { t } = useI18n()
  const updateTabs = useProjectStore((s) => s.updateTabs)
  const deleteTabs = useProjectStore((s) => s.deleteTabs)

  const ids = useMemo(() => selectedTabs.map((tab) => tab.id), [selectedTabs])

  const commonW = commonNumber(selectedTabs, (tab) => tab.w)
  const commonH = commonNumber(selectedTabs, (tab) => tab.h)
  const commonZTop = commonNumber(selectedTabs, (tab) => tab.z_top)
  const commonZBottom = commonNumber(selectedTabs, (tab) => tab.z_bottom)
  const commonVisible = commonBoolean(selectedTabs, (tab) => tab.visible)
  const commonShape = commonValue(selectedTabs, (tab) => tabShape(tab))

  const allZTops = selectedTabs.map((tab) => tab.z_top)
  const allZBottoms = selectedTabs.map((tab) => tab.z_bottom)

  const effectiveDomainMax = zDomainMax([...allZTops, ...allZBottoms], stockThickness)
  const minimumSize = convertLength(0.1, 'mm', units)

  const mixedPlaceholder = t('featureTree.properties.select.mixedValues')

  const selectionKey = useMemo(() => `bulk-tabs-${ids.join(',')}`, [ids])

  const handleZCommit = useCallback(
    (patch: { top?: number; bottom?: number }): boolean => {
      if (!validateZEdits(selectedTabs, (t) => t.z_top, (t) => t.z_bottom, patch)) return false
      const storePatch: Partial<Tab> = {}
      if (patch.top !== undefined) storePatch.z_top = patch.top
      if (patch.bottom !== undefined) storePatch.z_bottom = patch.bottom
      if (Object.keys(storePatch).length > 0) {
        updateTabs(ids, storePatch)
      }
      return true
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
        <label className="properties-field">
          <span>{t('featureTree.properties.tabShape')}</span>
          <select
            value={commonShape ?? ''}
            onChange={(event) => {
              const next = event.target.value as TabShape
              if (next) updateTabs(ids, { shape: next })
            }}
            data-testid="bulk-tab-shape"
          >
            {commonShape === null ? (
              <option value="" disabled>{mixedPlaceholder}</option>
            ) : null}
            <option value="rect">{t('featureTree.properties.tabShape.rect')}</option>
            <option value="smooth">{t('featureTree.properties.tabShape.smooth')}</option>
          </select>
        </label>
        <span className="properties-hint">{t('featureTree.properties.tabShape.hint')}</span>
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
