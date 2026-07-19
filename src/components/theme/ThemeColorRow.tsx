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
import { useI18n } from '../../i18n/i18nContext'
import { formatColor, normalizeColorValue, opaqueHex, parseColor } from '../../theme/color'

export interface ThemeColorRowProps {
  label: string
  /** Current effective value (base or override). */
  value: string
  /** The base theme's value, shown for comparison. */
  baseValue: string
  /** True when the current value differs from the base. */
  overridden: boolean
  onChange: (nextValue: string) => void
  onReset: () => void
}

/**
 * One guided-editor color field: a native color input, a normalized text
 * value, a base-value comparison chip, and a per-field reset. Valid edits
 * propagate immediately (live preview); invalid text is held locally and
 * flagged without touching the theme.
 */
export function ThemeColorRow({ label, value, baseValue, overridden, onChange, onReset }: ThemeColorRowProps) {
  const { t } = useI18n()
  const inputId = useId()
  const [draft, setDraft] = useState(value)
  const [invalid, setInvalid] = useState(false)

  // Adopt external changes (reset, restore, picker edits) into the text field
  // via render-time state adjustment (the React-endorsed alternative to a
  // setState-in-effect for derived-from-props state). A change that merely
  // echoes the draft's own normalized form back (live typing) keeps the
  // user's text as typed instead of clobbering it mid-edit.
  const [adoptedValue, setAdoptedValue] = useState(value)
  if (adoptedValue !== value) {
    setAdoptedValue(value)
    if (normalizeColorValue(draft) !== normalizeColorValue(value)) {
      setDraft(value)
      setInvalid(false)
    }
  }

  const parsed = parseColor(value)

  const commitText = (raw: string) => {
    setDraft(raw)
    const normalized = normalizeColorValue(raw)
    if (normalized === null) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    if (normalized !== normalizeColorValue(value)) onChange(normalized)
  }

  const pickColor = (pickedHex: string) => {
    const picked = parseColor(pickedHex)
    if (!picked) return
    // The native input cannot express alpha — keep the token's current alpha.
    onChange(formatColor({ ...picked, a: parsed?.a ?? 1 }))
  }

  return (
    <div className={`theme-editor-row ${overridden ? 'theme-editor-row--overridden' : ''}`}>
      <label className="theme-editor-row__label" htmlFor={inputId}>{label}</label>
      <input
        className="theme-editor-row__picker"
        type="color"
        aria-label={t('themeEditor.colorPickerAria', { label })}
        value={parsed ? opaqueHex(parsed) : '#000000'}
        onChange={(event) => pickColor(event.target.value)}
      />
      <input
        id={inputId}
        className={`theme-editor-row__value ${invalid ? 'theme-editor-row__value--invalid' : ''}`}
        type="text"
        spellCheck={false}
        autoComplete="off"
        value={draft}
        aria-invalid={invalid}
        onChange={(event) => commitText(event.target.value)}
        onBlur={() => {
          if (invalid) {
            setDraft(value)
            setInvalid(false)
          }
        }}
      />
      <span
        className="theme-editor-row__base"
        title={t('themeEditor.baseValueTitle', { value: baseValue })}
        style={{ background: baseValue }}
        aria-hidden="true"
      />
      <button
        className="theme-editor-row__reset"
        type="button"
        aria-label={t('themeEditor.resetFieldAria', { label })}
        title={t('themeEditor.resetFieldTitle', { value: baseValue })}
        disabled={!overridden}
        onClick={onReset}
      >
        ↺
      </button>
    </div>
  )
}
