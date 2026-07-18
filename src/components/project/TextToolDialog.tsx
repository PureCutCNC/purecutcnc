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

import { useEffect, useState } from 'react'
import type { FeatureOperation, TextFontStyle } from '../../types/project'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { defaultFontIdForStyle, defaultTextToolConfig, getTextFontOptions, type TextToolConfig } from '../../text'
import { useProjectStore } from '../../store/projectStore'
import { Select } from '../Select'
import { dialogsEn } from '../../i18n/locales/en/dialogs'
import { dialogsZhCN } from '../../i18n/locales/zh-CN/dialogs'
import { interpolate } from '../../i18n/catalog'
import type { MessageParams } from '../../i18n/catalog'
import { useI18n } from '../../i18n/i18nContext'

interface TextToolDialogProps {
  onClose: () => void
  onConfirm: (config: TextToolConfig) => void
}

export function TextToolDialog({ onClose, onConfirm }: TextToolDialogProps) {
  useRestoreCanvasFocus()
  const units = useProjectStore((state) => state.project.meta.units)
  const defaults = defaultTextToolConfig(units)
  const [text, setText] = useState(defaults.text)
  const [style, setStyle] = useState<TextFontStyle>(defaults.style)
  const [fontId, setFontId] = useState(defaults.fontId)
  const [size, setSize] = useState(String(defaults.size))
  const [operation, setOperation] = useState<FeatureOperation>(defaults.operation)
  const fontOptions = getTextFontOptions(style)
  const { localeId } = useI18n()

  function td(key: keyof typeof dialogsEn, params?: MessageParams): string {
    const catalog = localeId === 'zh-CN' ? dialogsZhCN : dialogsEn
    const template = (catalog as Record<string, string>)[key] ?? dialogsEn[key]
    return interpolate(template, params)
  }

  // `fontOptions` derives only from `style`, so the current font can only become
  // invalid when the style changes. Fall back to that style's default during
  // render — the React-recommended alternative to a setState-in-effect reset.
  const [prevStyle, setPrevStyle] = useState(style)
  if (style !== prevStyle) {
    setPrevStyle(style)
    if (!fontOptions.some((font) => font.id === fontId)) {
      setFontId(defaultFontIdForStyle(style))
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  function handleCreate() {
    const parsedSize = Number(size)
    if (!text.trim() || !Number.isFinite(parsedSize) || parsedSize <= 0) {
      return
    }

    onConfirm({
      text: text.replace(/\s*\n+\s*/g, ' ').trim(),
      style,
      fontId,
      size: parsedSize,
      operation,
    })
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog--import dialog--no-clip" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{td('dialogs.textTool.title')}</h2>
          <button className="dialog-close" onClick={onClose} aria-label={td('dialogs.common.close')} type="button">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="dialog-body dialog-body--import">
          <div className="dialog-section">
            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="text-tool-value">{td('dialogs.textTool.text')}</label>
              <div className="properties-field">
                <textarea
                  id="text-tool-value"
                  rows={2}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  spellCheck={false}
                  autoFocus
                />
              </div>
            </div>
            <div className="dialog-section-group">
              <label className="dialog-section-title">{td('dialogs.textTool.fontStyle')}</label>
              <div className="properties-field">
                <Select
                  value={style}
                  options={[
                    { value: 'skeleton' as TextFontStyle, label: td('dialogs.textTool.style.skeleton') },
                    { value: 'outline' as TextFontStyle, label: td('dialogs.textTool.style.outline') },
                  ]}
                  onChange={(v) => setStyle(v)}
                />
              </div>
            </div>
            <div className="dialog-section-group">
              <label className="dialog-section-title">{td('dialogs.textTool.font')}</label>
              <div className="properties-field">
                <Select
                  value={fontId}
                  options={fontOptions.map((font) => ({ value: font.id, label: font.label }))}
                  onChange={(v) => setFontId(v as typeof fontId)}
                />
              </div>
            </div>
            <div className="dialog-section-group">
              <label className="dialog-section-title" htmlFor="text-tool-size">{td('dialogs.textTool.height')}</label>
              <div className="properties-field">
                <input
                  id="text-tool-size"
                  type="number"
                  min="0.001"
                  step="any"
                  value={size}
                  onChange={(event) => setSize(event.target.value)}
                />
              </div>
            </div>
            <div className="dialog-section-group">
              <label className="dialog-section-title">{td('dialogs.textTool.operation')}</label>
              <div className="properties-field">
                <Select
                  value={operation}
                  options={[
                    { value: 'subtract' as FeatureOperation, label: td('dialogs.textTool.operation.subtract') },
                    { value: 'add' as FeatureOperation, label: td('dialogs.textTool.operation.add') },
                  ]}
                  onChange={(v) => setOperation(v)}
                />
              </div>
            </div>
            <div className="cam-field-message">
              {td('dialogs.textTool.helpText')}
            </div>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="feat-btn" type="button" onClick={onClose}>
            {td('dialogs.common.cancel')}
          </button>
          <button className="feat-btn" type="button" onClick={handleCreate}>
            {td('dialogs.textTool.placeText')}
          </button>
        </div>
      </div>
    </div>
  )
}
