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

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWindowEvent } from '../../hooks/useEventListener'
import { evaluateThemeContrast } from '../../theme/contrast'
import {
  builtinTheme,
  resolveCustomTheme,
  THEME_NAME_MAX_LENGTH,
  type CustomThemeData,
} from '../../theme/registry'
import { useTheme } from '../../theme/themeContext'
import { THEME_TOKEN_GROUPS, THEME_TOKENS, type ThemeTokenKey } from '../../theme/tokens'
import { ThemeColorRow } from './ThemeColorRow'
import { ThemePreviewSamples } from './ThemePreviewSamples'

export interface ThemeEditorDialogProps {
  theme: CustomThemeData
  /** Called with the edited theme when Apply passes validation. */
  onApply: (theme: CustomThemeData) => void
  /** Cancel/Escape/close — the provider preview is cleared on unmount. */
  onClose: () => void
}

/**
 * The always-readable recovery styles: hardcoded so a garbage preview can
 * never make the escape hatch itself unreadable.
 */
const RECOVERY_BAR_STYLE: React.CSSProperties = {
  background: '#f6f1e7',
  color: '#253039',
  border: '1px solid #a99a84',
}

const RECOVERY_BUTTON_STYLE: React.CSSProperties = {
  background: '#253039',
  color: '#f6f1e7',
  border: '1px solid #253039',
  borderRadius: 7,
  padding: '6px 12px',
  font: 'inherit',
  fontSize: 13,
  fontWeight: 650,
  cursor: 'pointer',
}

/**
 * Guided custom-theme editor: semantic color groups with live preview,
 * base comparison and per-field reset, representative preview states, and a
 * contrast gate that blocks Apply while critical combinations are unreadable.
 * Nothing is persisted until Apply — Cancel, Escape, or closing restores the
 * previously active theme.
 */
export function ThemeEditorDialog({ theme, onApply, onClose }: ThemeEditorDialogProps) {
  const { setPreview } = useTheme()
  const [name, setName] = useState(theme.name)
  const [overrides, setOverrides] = useState(theme.overrides)

  const base = builtinTheme(theme.baseThemeId)

  const working = useMemo<CustomThemeData>(
    () => ({ ...theme, name: name.trim() === '' ? theme.name : name.trim(), overrides }),
    [theme, name, overrides],
  )
  const resolved = useMemo(() => resolveCustomTheme(working), [working])
  const contrast = useMemo(() => evaluateThemeContrast(resolved.values), [resolved])

  // Live preview: presentation-only, never written to storage. Every close
  // path clears the preview in the same commit (so the saved theme is back
  // on screen the moment the dialog goes), and the unmount cleanup is the
  // safety net for any unexpected teardown.
  useEffect(() => {
    setPreview(resolved)
  }, [resolved, setPreview])
  useEffect(() => () => setPreview(null), [setPreview])

  const handleClose = () => {
    setPreview(null)
    onClose()
  }

  useWindowEvent('keydown', (event) => {
    if (event.key === 'Escape') handleClose()
  })

  const changeToken = (key: ThemeTokenKey, nextValue: string) => {
    setOverrides((previous) => {
      const next = { ...previous }
      if (nextValue === base.values[key]) {
        delete next[key]
      } else {
        next[key] = nextValue
      }
      return next
    })
  }

  const resetToken = (key: ThemeTokenKey) => {
    setOverrides((previous) => {
      if (previous[key] === undefined) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })
  }

  const restoreSaved = () => {
    setName(theme.name)
    setOverrides(theme.overrides)
  }

  const nameInvalid = name.trim() === ''
  const blocked = contrast.blockers.length > 0
  const dirty = name.trim() !== theme.name
    || JSON.stringify(overrides) !== JSON.stringify(theme.overrides)

  const handleApply = () => {
    if (blocked || nameInvalid) return
    onApply(working)
  }

  return createPortal(
    <div className="dialog-backdrop" onClick={handleClose}>
      <div
        className="dialog dialog--theme-editor"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Edit theme ${theme.name}`}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">Edit Theme</h2>
          <button className="dialog-close" onClick={handleClose} aria-label="Close" type="button">
            ✕
          </button>
        </div>

        <div className="theme-editor-recovery" style={RECOVERY_BAR_STYLE}>
          <span>
            Previewing your edits live.
            {dirty ? ' Colors look wrong?' : ''}
          </span>
          <button
            type="button"
            style={RECOVERY_BUTTON_STYLE}
            onClick={restoreSaved}
            disabled={!dirty}
          >
            Restore saved colors
          </button>
        </div>

        <div className="dialog-body dialog-body--theme-editor">
          <div className="theme-editor-fields">
            <div className="theme-editor-name">
              <label className="theme-editor-name__label" htmlFor="theme-editor-name-input">
                Theme name
              </label>
              <input
                id="theme-editor-name-input"
                className={`theme-editor-name__input ${nameInvalid ? 'theme-editor-row__value--invalid' : ''}`}
                type="text"
                value={name}
                maxLength={THEME_NAME_MAX_LENGTH}
                onChange={(event) => setName(event.target.value)}
              />
              <span className="theme-editor-name__base">
                Based on {base.name} · {resolved.overriddenKeys.length} color{resolved.overriddenKeys.length === 1 ? '' : 's'} changed
              </span>
            </div>

            {THEME_TOKEN_GROUPS.map((group) => {
              const tokens = THEME_TOKENS.filter((token) => token.group === group.id)
              return (
                <section key={group.id} className="theme-editor-group">
                  <h3 className="theme-editor-group__title">{group.label}</h3>
                  <p className="theme-editor-group__hint">{group.description}</p>
                  {tokens.map((token) => (
                    <ThemeColorRow
                      key={token.key}
                      label={token.label}
                      value={resolved.values[token.key]}
                      baseValue={base.values[token.key]}
                      overridden={overrides[token.key] !== undefined}
                      onChange={(nextValue) => changeToken(token.key, nextValue)}
                      onReset={() => resetToken(token.key)}
                    />
                  ))}
                </section>
              )
            })}
          </div>

          <aside className="theme-editor-side">
            <ThemePreviewSamples values={resolved.values} />

            <section className="theme-editor-contrast" aria-label="Contrast checks">
              <h4 className="theme-editor-contrast__title">Readability checks</h4>
              {contrast.blockers.length === 0 && contrast.warnings.length === 0 ? (
                <p className="theme-editor-contrast__ok">
                  All {contrast.findings.length} checks pass.
                </p>
              ) : null}
              {contrast.blockers.map((finding) => (
                <p key={finding.id} className="theme-editor-contrast__item theme-editor-contrast__item--block">
                  <strong>Blocked:</strong> {finding.label} — {finding.kind === 'ratio'
                    ? `${finding.measured}:1, needs ${finding.required}:1`
                    : `ΔE ${finding.measured}, needs ${finding.required}`}
                </p>
              ))}
              {contrast.warnings.map((finding) => (
                <p key={finding.id} className="theme-editor-contrast__item theme-editor-contrast__item--warn">
                  <strong>Warning:</strong> {finding.label} — {finding.kind === 'ratio'
                    ? `${finding.measured}:1, recommended ${finding.required}:1`
                    : `ΔE ${finding.measured}, recommended ${finding.required}`}
                </p>
              ))}
              <p className="theme-editor-contrast__note">
                Automated spot checks of representative states — not full WCAG coverage.
              </p>
            </section>
          </aside>
        </div>

        <div className="dialog-footer">
          {blocked ? (
            <span className="theme-editor-footer-blocked" role="status">
              {contrast.blockers.length} readability check{contrast.blockers.length === 1 ? '' : 's'} failing
            </span>
          ) : null}
          <button className="btn-secondary" type="button" onClick={handleClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            type="button"
            onClick={handleApply}
            disabled={blocked || nameInvalid}
            title={blocked
              ? 'Fix the blocked readability checks before applying'
              : nameInvalid
                ? 'Give the theme a name'
                : undefined}
          >
            Apply theme
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
