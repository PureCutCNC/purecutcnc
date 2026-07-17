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

import { useId, useRef, useState } from 'react'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { resolveCustomTheme } from '../../theme/registry'
import { THEME_PREFERENCES, type ThemePreference } from '../../theme/theme'
import { useTheme } from '../../theme/themeContext'
import { ThemeManagerDialog } from '../theme/ThemeManagerDialog'
import { ThemeSwatch } from '../theme/ThemeSwatch'
import { Icon } from '../Icon'

const THEME_LABELS: Record<ThemePreference, { label: string; detail: string }> = {
  dark: { label: 'Dark', detail: 'Low-light workshop' },
  light: { label: 'Light', detail: 'Drafting paper' },
  system: { label: 'System', detail: 'Match this device' },
}

export function AppearanceControl() {
  const { resolvedTheme, selection, customThemes, activeTheme, setPreference, activateTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const [managerOpen, setManagerOpen] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()

  useOutsideDismiss({ open, refs: hostRef, onDismiss: () => setOpen(false) })

  const currentLabel = selection.mode === 'system'
    ? THEME_LABELS.system.label
    : activeTheme.builtin
      ? THEME_LABELS[activeTheme.family].label
      : activeTheme.name

  const isQuickOptionSelected = (option: ThemePreference): boolean => {
    if (option === 'system') return selection.mode === 'system'
    return selection.mode === 'fixed' && selection.fixedThemeId === option
  }

  const chooseTheme = (apply: () => void) => {
    apply()
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }

  return (
    <div className="appearance-control" ref={hostRef}>
      <div className="toolbar-action">
        <button
          ref={triggerRef}
          className="toolbar-icon-btn appearance-control__trigger"
          type="button"
          aria-label={`Appearance: ${currentLabel}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          data-resolved-theme={resolvedTheme}
          onClick={() => setOpen((previous) => !previous)}
        >
          <Icon id="appearance" />
        </button>
        {!open && (
          <span className="toolbar-tooltip toolbar-tooltip--bottom" role="tooltip">
            Appearance
          </span>
        )}
      </div>

      {open && (
        <div className="appearance-menu" id={menuId} role="menu" aria-label="Appearance theme">
          <div className="appearance-menu__heading">Appearance</div>
          <div className="appearance-menu__options">
            {THEME_PREFERENCES.map((option) => {
              const selected = isQuickOptionSelected(option)
              const copy = THEME_LABELS[option]
              return (
                <button
                  key={option}
                  className={`appearance-menu__option ${selected ? 'appearance-menu__option--selected' : ''}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => chooseTheme(() => setPreference(option))}
                >
                  <span className={`appearance-menu__swatch appearance-menu__swatch--${option}`} aria-hidden="true" />
                  <span className="appearance-menu__copy">
                    <span className="appearance-menu__label">{copy.label}</span>
                    <span className="appearance-menu__detail">{copy.detail}</span>
                  </span>
                  <span className="appearance-menu__check" aria-hidden="true">{selected ? '✓' : ''}</span>
                </button>
              )
            })}

            {customThemes.length > 0 && (
              <>
                <div className="appearance-menu__heading appearance-menu__heading--section">Custom themes</div>
                {customThemes.map((custom) => {
                  const selected = selection.mode === 'fixed' && selection.fixedThemeId === custom.id
                  const resolved = resolveCustomTheme(custom)
                  return (
                    <button
                      key={custom.id}
                      className={`appearance-menu__option ${selected ? 'appearance-menu__option--selected' : ''}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      onClick={() => chooseTheme(() => activateTheme(custom.id))}
                    >
                      <ThemeSwatch values={resolved.values} />
                      <span className="appearance-menu__copy">
                        <span className="appearance-menu__label">{custom.name}</span>
                        <span className="appearance-menu__detail">
                          {custom.family === 'dark' ? 'Dark family' : 'Light family'}
                        </span>
                      </span>
                      <span className="appearance-menu__check" aria-hidden="true">{selected ? '✓' : ''}</span>
                    </button>
                  )
                })}
              </>
            )}

            <button
              className="appearance-menu__option appearance-menu__option--manage"
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                setManagerOpen(true)
              }}
            >
              <span className="appearance-menu__copy">
                <span className="appearance-menu__label">Manage themes…</span>
                <span className="appearance-menu__detail">Create, edit, import, export</span>
              </span>
            </button>
          </div>
        </div>
      )}

      {managerOpen && <ThemeManagerDialog onClose={() => setManagerOpen(false)} />}
    </div>
  )
}
