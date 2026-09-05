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

import { useId, useState } from 'react'
import { spacingToScallopHeight } from '../../engine/toolpaths/scallopHeight'
import { parseLengthInput, type Units } from '../../utils/units'
import { useI18n } from '../../i18n/i18nContext'
import { OperationParameterReference } from './OperationParameterReference'

interface ScallopHeightFieldProps {
  height: number | undefined
  radius: number
  legacySpacing: number
  units: Units
  onCommit: (height: number) => void
}

/** The legacy conversion is display-only: viewing or blurring must not opt in. */
export function ScallopHeightField({ height, radius, legacySpacing, units, onCommit }: ScallopHeightFieldProps) {
  const { t } = useI18n()
  const hintId = useId()
  const errorId = useId()
  const [invalid, setInvalid] = useState(false)
  const displayedHeight = height === undefined || height === 0
    ? spacingToScallopHeight(radius, legacySpacing)
    : height
  const displayValue = displayedHeight === null ? '' : String(Number(displayedHeight.toPrecision(8)))
  const unitLabel = units === 'inch' ? 'in' : 'mm'

  function reset(input: HTMLInputElement) {
    input.value = displayValue
    setInvalid(false)
  }

  function commit(input: HTMLInputElement) {
    // In particular, never persist a rounded legacy height on focus/blur.
    if (input.value.trim() === displayValue) {
      setInvalid(false)
      return
    }
    const next = parseLengthInput(input.value, units)
    if (next === null || !Number.isFinite(next) || next <= 0 || next >= radius) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    if (next !== displayedHeight) onCommit(next)
  }

  return (
    <>
      <label className="properties-field">
        <span>{t('cam.operation.scallopHeight')} ({unitLabel})</span>
        <input
          type="text"
          inputMode="decimal"
          defaultValue={displayValue}
          spellCheck={false}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${hintId} ${errorId}` : hintId}
          onBlur={(event) => commit(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') reset(event.currentTarget)
            if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
          }}
        />
        <OperationParameterReference kind="scallopHeight" />
      </label>
      <span id={hintId} className="properties-hint">{t('cam.operation.scallopHeightHint')}</span>
      {invalid ? (
        <span id={errorId} className="properties-hint" role="alert">
          {t('cam.operation.scallopHeightInvalid', { radius, units: unitLabel })}
        </span>
      ) : null}
    </>
  )
}
