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

import { useId } from 'react'
import { useI18n } from '../i18n/i18nContext'
import { formatLength, type Units } from '../utils/units'

interface ToolpathLevelRailProps {
  levels: readonly number[]
  selectedLevel: number | null
  onChange: (level: number | null) => void
  units: Units
}

/**
 * A native range control presented vertically: it retains keyboard, drag, and
 * touch behaviour while the adjacent marks make every discrete Z stop visible.
 */
export function ToolpathLevelRail({ levels, selectedLevel, onChange, units }: ToolpathLevelRailProps) {
  const { t } = useI18n()
  const labelId = useId()
  const selectedIndex = selectedLevel === null ? 0 : Math.max(0, levels.indexOf(selectedLevel) + 1)
  const selectedLabel = selectedLevel === null
    ? t('appShell.toolpath.levelAll')
    : `Z ${formatLength(selectedLevel, units)}`
  const height = Math.min(Math.max((levels.length + 1) * 32, 112), 260)

  return (
    <div className="toolpath-level-rail" aria-labelledby={labelId}>
      <span id={labelId} className="sr-only">{t('appShell.toolpath.level')}</span>
      <span className="toolpath-level-rail__all" aria-hidden="true">{t('appShell.toolpath.levelAll')}</span>
      <div className="toolpath-level-rail__slider" style={{ height }}>
        <div className="toolpath-level-rail__marks" aria-hidden="true">
          {Array.from({ length: levels.length + 1 }, (_, index) => (
            <span key={index} className={index === selectedIndex ? 'toolpath-level-rail__mark--selected' : ''} />
          ))}
        </div>
        <input
          className="toolpath-level-rail__input"
          type="range"
          min={0}
          max={levels.length}
          step={1}
          value={selectedIndex}
          aria-label={t('appShell.toolpath.level')}
          aria-valuetext={selectedLabel}
          onChange={(event) => {
            const next = Number(event.currentTarget.value)
            onChange(next === 0 ? null : levels[next - 1] ?? null)
          }}
        />
      </div>
      <output className="toolpath-level-rail__value" aria-live="polite">{selectedLabel}</output>
    </div>
  )
}
