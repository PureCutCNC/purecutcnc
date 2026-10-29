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
import { lastUnitSwitchMode } from '../../store/helpers/unitSwitch'
import { Select } from '../Select'
import { formHasChanges } from '../common/formDraft'
import { convertLength, type Units } from '../../utils/units'
import { dialogsEn } from '../../i18n/locales/en/dialogs'
import type { MessageParams } from '../../i18n/catalog'
import { useI18n } from '../../i18n/i18nContext'

interface TextToolDialogProps {
  onClose: () => void
  onConfirm: (config: TextToolConfig) => void
  /**
   * Current values when Properties reopens the dialog to edit an existing run
   * (issue #1112). Absent for creation, which starts from the defaults.
   */
  initial?: TextToolConfig
  mode?: 'create' | 'edit'
}

/** The text a save stores: one line, with no surrounding whitespace. */
function normalisedText(raw: string): string {
  return raw.replace(/\s*\n+\s*/g, ' ').trim()
}

export function TextToolDialog({ onClose, onConfirm, initial, mode = 'create' }: TextToolDialogProps) {
  useRestoreCanvasFocus()
  const units = useProjectStore((state) => state.project.meta.units)
  const defaults = initial ?? defaultTextToolConfig(units)
  const [text, setText] = useState(defaults.text)
  const [style, setStyle] = useState<TextFontStyle>(defaults.style)
  const [fontId, setFontId] = useState(defaults.fontId)
  const [size, setSize] = useState(String(defaults.size))
  const [operation, setOperation] = useState<FeatureOperation>(defaults.operation)
  const fontOptions = getTextFontOptions(style)
  const { t } = useI18n()
  const isEdit = mode === 'edit'

  // What this save would store, compared with the run the dialog opened on
  // (issue #1112 F4). Reopening an existing run and applying without an edit
  // used to rewrite identical text as an empty undo step; the button says so
  // instead. Both sides are normalised the way a save stores them, so a height
  // typed as "12.0" or a line break between the same words is not an edit.
  // Only the fields this dialog edits are compared; a run's layout is not one.
  const parsedSize = Number(size)
  const valid = text.trim() !== '' && Number.isFinite(parsedSize) && parsedSize > 0
  const draft = { text: normalisedText(text), style, fontId, size: parsedSize, operation }
  const saved = {
    text: defaults.text,
    style: defaults.style,
    fontId: defaults.fontId,
    size: defaults.size,
    operation: defaults.operation,
  }

  // The run this dialog edits can be rewritten while it is open: converting the
  // project's units converts the stored height with every other length (#1112
  // F4). A unit switch follows the rewritten run **without** discarding what
  // the user has typed since (r4-4) — the pending height is moved by the fixed
  // mm/inch factor when the toggle **converted** the stored lengths and keeps
  // its number when it **reinterpreted** them, the mode the store recorded for
  // that toggle (r5-4). Reading the mode from the two stored heights
  // (`saved.size !== openedOn.size`) was wrong: any other edit to the run made a
  // reinterpret look like a conversion. The text, font, style and operation stay
  // because units do not touch them. Anything else that rewrites the run takes
  // its values whole, as reopening the dialog would. The writes are plain values
  // derived from this render's state: a repeated render queues the same result
  // instead of converting the pending height twice. React re-renders before
  // painting, so the button never shows the stale comparison; the check is by
  // value because the parent hands back a fresh object each render.
  const [openedOn, setOpenedOn] = useState(saved)
  const [unitsShown, setUnitsShown] = useState<Units>(units)
  if (isEdit && units !== unitsShown) {
    const from = unitsShown
    const converted = lastUnitSwitchMode(from, units) === 'convert'
    setUnitsShown(units)
    const typedSize = Number(size)
    // An untouched height is taken from the store itself, not recomputed from
    // the scale, so it holds exactly the number the project now stores.
    setSize(
      typedSize === openedOn.size
        ? String(saved.size)
        : converted && Number.isFinite(typedSize)
          ? String(convertLength(typedSize, from, units))
          : size,
    )
    setOpenedOn(saved)
  } else if (isEdit && formHasChanges(openedOn, saved)) {
    setOpenedOn(saved)
    setText(saved.text)
    setStyle(saved.style)
    setFontId(saved.fontId)
    setSize(String(saved.size))
    setOperation(saved.operation)
  }

  const canApply = valid && (!isEdit || formHasChanges(saved, draft))

  function td(key: keyof typeof dialogsEn, params?: MessageParams): string {
    return t(key, params)
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
    if (!canApply) return
    onConfirm({
      text: normalisedText(text),
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
          <h2 className="dialog-title">{td(isEdit ? 'dialogs.textTool.editTitle' : 'dialogs.textTool.title')}</h2>
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
          {/* Creation has no saved state to compare against, so its button keeps
              its own behaviour; reopening an existing run greys out an Apply
              that would write nothing (issue #1112 F4). */}
          <button className="feat-btn" type="button" onClick={handleCreate} disabled={isEdit && !canApply}>
            {td(isEdit ? 'dialogs.common.apply' : 'dialogs.textTool.placeText')}
          </button>
        </div>
      </div>
    </div>
  )
}
