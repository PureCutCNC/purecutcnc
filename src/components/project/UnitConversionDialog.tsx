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

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { Project } from '../../types/project'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { dialogsEn } from '../../i18n/locales/en/dialogs'
import { dialogsZhCN } from '../../i18n/locales/zh-CN/dialogs'
import { interpolate } from '../../i18n/catalog'
import type { MessageParams } from '../../i18n/catalog'
import { useI18n } from '../../i18n/i18nContext'

interface UnitConversionDialogProps {
  fromUnits: Project['meta']['units']
  toUnits: Project['meta']['units']
  onConvert: () => void
  onReinterpret: () => void
  onCancel: () => void
}

function shortUnitLabel(units: Project['meta']['units']): string {
  return units === 'inch' ? 'in' : 'mm'
}

function unitName(units: Project['meta']['units']): string {
  return units === 'inch' ? 'inches' : 'millimeters'
}

export function UnitConversionDialog({
  fromUnits,
  toUnits,
  onConvert,
  onReinterpret,
  onCancel,
}: UnitConversionDialogProps) {
  useRestoreCanvasFocus()
  const { localeId } = useI18n()

  function td(key: keyof typeof dialogsEn, params?: MessageParams): string {
    const catalog = localeId === 'zh-CN' ? dialogsZhCN : dialogsEn
    const template = (catalog as Record<string, string>)[key] ?? dialogsEn[key]
    return interpolate(template, params)
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const fromShort = shortUnitLabel(fromUnits)
  const toShort = shortUnitLabel(toUnits)
  const fromName = unitName(fromUnits)
  const toName = unitName(toUnits)
  const conversionExample = fromUnits === 'inch'
    ? td('dialogs.unitConversion.convertExample', { from: '1 in', to: '25.4 mm' })
    : td('dialogs.unitConversion.convertExample', { from: '25.4 mm', to: '1 in' })
  const reinterpretExample = fromUnits === 'inch'
    ? td('dialogs.unitConversion.keepExample', { from: '1 in', to: '1 mm' })
    : td('dialogs.unitConversion.keepExample', { from: '1 mm', to: '1 in' })

  return createPortal(
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        className="dialog dialog--unit-conversion"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="unit-conversion-title"
        aria-describedby="unit-conversion-description"
      >
        <div className="dialog-header">
          <div>
            <span className="unit-conversion-eyebrow">{td('dialogs.unitConversion.eyebrow')}</span>
            <h2 className="dialog-title" id="unit-conversion-title">{td('dialogs.unitConversion.title')}</h2>
          </div>
          <button className="dialog-close" onClick={onCancel} aria-label={td('dialogs.common.close')} type="button">
            ✕
          </button>
        </div>

        <div className="dialog-body dialog-body--unit-conversion">
          <div className="unit-conversion-route" aria-label={td('dialogs.unitConversion.ariaChanging', { from: fromName, to: toName })}>
            <span>{fromShort}</span>
            <span className="unit-conversion-route__arrow" aria-hidden="true">→</span>
            <span>{toShort}</span>
          </div>

          <p id="unit-conversion-description" className="unit-conversion-intro">
            {td('dialogs.unitConversion.intro')}
          </p>

          <div className="unit-conversion-options">
            <button
              className="unit-conversion-option unit-conversion-option--recommended"
              type="button"
              onClick={onConvert}
              autoFocus
            >
              <span className="unit-conversion-option__heading">
                <strong>{td('dialogs.unitConversion.convertHeading')}</strong>
                <span className="unit-conversion-option__badge">{td('dialogs.unitConversion.convertBadge')}</span>
              </span>
              <span>{td('dialogs.unitConversion.convertDescription')}</span>
              <code>{conversionExample}</code>
            </button>

            <button
              className="unit-conversion-option unit-conversion-option--reinterpret"
              type="button"
              onClick={onReinterpret}
            >
              <span className="unit-conversion-option__heading">
                <strong>{td('dialogs.unitConversion.keepHeading')}</strong>
              </span>
              <span>{td('dialogs.unitConversion.keepDescription')}</span>
              <code>{reinterpretExample}</code>
            </button>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" type="button" onClick={onCancel}>
            {td('dialogs.common.cancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
