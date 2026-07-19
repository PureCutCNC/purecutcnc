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

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWindowEvent } from '../../hooks/useEventListener'
import { useI18n } from '../../i18n/i18nContext'
import { platform } from '../../platform'
import {
  BUILTIN_THEMES,
  duplicateThemeAsCustom,
  duplicateThemeName,
  parseThemeImport,
  resolveBuiltinTheme,
  resolveCustomTheme,
  serializeThemeExport,
  THEME_NAME_MAX_LENGTH,
  type CustomThemeData,
  type ResolvedThemeDefinition,
} from '../../theme/registry'
import { useTheme } from '../../theme/themeContext'
import { ThemeEditorDialog } from './ThemeEditorDialog'
import { ThemeSwatch } from './ThemeSwatch'

export interface ThemeManagerDialogProps {
  onClose: () => void
}

/**
 * Theme manager: built-in and custom themes with representative previews,
 * activate/duplicate/rename/edit/delete/reset/export/import actions, and the
 * System light/dark pairing. Custom themes are application-local preferences;
 * nothing here touches project data.
 */
export function ThemeManagerDialog({ onClose }: ThemeManagerDialogProps) {
  const { t } = useI18n()
  const {
    selection,
    setSelection,
    customThemes,
    activeTheme,
    activateTheme,
    saveCustomTheme,
    deleteCustomTheme,
    systemPrefersDark,
  } = useTheme()

  const allThemes = useMemo<ResolvedThemeDefinition[]>(
    () => [
      ...BUILTIN_THEMES.map((definition) => resolveBuiltinTheme(definition.id)),
      ...customThemes.map((custom) => resolveCustomTheme(custom)),
    ],
    [customThemes],
  )

  const [selectedId, setSelectedId] = useState(activeTheme.id)
  const [editingTheme, setEditingTheme] = useState<CustomThemeData | null>(null)
  const [renameDraft, setRenameDraft] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)

  const selected = allThemes.find((theme) => theme.id === selectedId) ?? allThemes[0]
  const selectedCustom = customThemes.find((theme) => theme.id === selected.id) ?? null
  const existingNames = useMemo(() => allThemes.map((theme) => theme.name), [allThemes])

  // Escape closes the manager, unless the nested editor owns the key press.
  useWindowEvent('keydown', (event) => {
    if (event.key !== 'Escape' || editingTheme) return
    onClose()
  })

  const openEditor = (custom: CustomThemeData) => {
    setNotice(null)
    setRenameDraft(null)
    setEditingTheme(custom)
  }

  const handleDuplicate = (edit: boolean) => {
    const duplicated = duplicateThemeAsCustom(selected, existingNames)
    saveCustomTheme(duplicated)
    setSelectedId(duplicated.id)
    if (edit) openEditor(duplicated)
  }

  const handleDelete = () => {
    if (!selectedCustom) return
    deleteCustomTheme(selectedCustom.id)
    setSelectedId(selectedCustom.baseThemeId)
    setNotice(null)
  }

  const handleResetOverrides = () => {
    if (!selectedCustom) return
    saveCustomTheme({ ...selectedCustom, overrides: {} })
    setNotice({
      kind: 'info',
      text: t('themeManager.resetNotice', { name: selectedCustom.name, base: selectedCustom.baseThemeId }),
    })
  }

  const handleExport = () => {
    if (!selectedCustom) return
    void platform.saveTextFile(
      `${selectedCustom.name}.json`,
      serializeThemeExport(selectedCustom),
      'json',
    )
  }

  const handleImport = async () => {
    const content = await platform.pickJsonFile()
    if (content === null) return
    const result = parseThemeImport(content)
    if (result.error !== undefined) {
      setNotice({ kind: 'error', text: t('themeManager.importFailed', { error: result.error }) })
      return
    }
    const imported = existingNames.some((name) => name.toLowerCase() === result.ok.name.toLowerCase())
      ? { ...result.ok, name: duplicateThemeName(result.ok.name, existingNames) }
      : result.ok
    saveCustomTheme(imported)
    setSelectedId(imported.id)
    setNotice({ kind: 'info', text: t('themeManager.imported', { name: imported.name }) })
  }

  const commitRename = () => {
    if (!selectedCustom || renameDraft === null) return
    const trimmed = renameDraft.trim()
    if (trimmed !== '' && trimmed !== selectedCustom.name) {
      saveCustomTheme({ ...selectedCustom, name: trimmed })
    }
    setRenameDraft(null)
  }

  const handleEditorApply = (edited: CustomThemeData) => {
    saveCustomTheme(edited)
    activateTheme(edited.id)
    setSelectedId(edited.id)
    setEditingTheme(null)
  }

  const isActive = selected.id === activeTheme.id && selection.mode === 'fixed'
  const lightFamilyThemes = allThemes.filter((theme) => theme.family === 'light')
  const darkFamilyThemes = allThemes.filter((theme) => theme.family === 'dark')

  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog--theme-manager"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('themeManager.dialogAria')}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{t('themeManager.title')}</h2>
          <button className="dialog-close" onClick={onClose} aria-label={t('themeManager.close')} type="button">
            ✕
          </button>
        </div>

        <div className="dialog-body dialog-body--theme-manager">
          {/* Left: theme list */}
          <div className="theme-manager-list" role="listbox" aria-label={t('themeManager.listAria')}>
            {allThemes.map((theme) => (
              <button
                key={theme.id}
                type="button"
                role="option"
                aria-selected={theme.id === selected.id}
                className={[
                  'theme-manager-item',
                  theme.id === selected.id ? 'theme-manager-item--selected' : '',
                  theme.id === activeTheme.id ? 'theme-manager-item--active' : '',
                ].join(' ').trim()}
                onClick={() => {
                  setSelectedId(theme.id)
                  setRenameDraft(null)
                  setNotice(null)
                }}
              >
                <ThemeSwatch values={theme.values} />
                <span className="theme-manager-item-name">{theme.name}</span>
                <span className={theme.builtin ? 'machine-manager-badge machine-manager-badge--builtin' : 'machine-manager-badge machine-manager-badge--custom'}>
                  {theme.builtin ? t('themeManager.builtinBadge') : t('themeManager.customBadge')}
                </span>
              </button>
            ))}
          </div>

          {/* Right: detail + actions */}
          <div className="theme-manager-detail">
            <div className="machine-manager-detail-header">
              {renameDraft !== null && selectedCustom ? (
                <span className="theme-manager-rename">
                  <input
                    className="theme-manager-rename__input"
                    type="text"
                    value={renameDraft}
                    maxLength={THEME_NAME_MAX_LENGTH}
                    autoFocus
                    aria-label={t('themeManager.nameLabel')}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename()
                      if (event.key === 'Escape') {
                        event.stopPropagation()
                        setRenameDraft(null)
                      }
                    }}
                  />
                  <button className="btn-secondary" type="button" onClick={commitRename}>{t('themeManager.saveName')}</button>
                </span>
              ) : (
                <h3 className="machine-manager-detail-name">{selected.name}</h3>
              )}
              {selected.id === activeTheme.id ? (
                <span className="machine-manager-badge machine-manager-badge--active">{t('themeManager.activeBadge')}</span>
              ) : null}
              <span className={selected.builtin ? 'machine-manager-badge machine-manager-badge--builtin' : 'machine-manager-badge machine-manager-badge--custom'}>
                {selected.builtin ? t('themeManager.builtinBadge') : t('themeManager.customBadge')}
              </span>
            </div>

            <dl className="machine-manager-meta">
              <dt>{t('themeManager.familyLabel')}</dt>
              <dd>{selected.family === 'dark' ? t('appearance.darkLabel') : t('appearance.lightLabel')}</dd>
              {!selected.builtin ? (
                <>
                  <dt>{t('themeManager.basedOnLabel')}</dt>
                  <dd>{resolveBuiltinTheme(selected.baseThemeId).name}</dd>
                  <dt>{t('themeManager.changedColorsLabel')}</dt>
                  <dd>{selected.overriddenKeys.length}</dd>
                </>
              ) : null}
              {selected.builtin ? (
                <dd className="machine-manager-hint">
                  {t('themeManager.builtinHint')}
                </dd>
              ) : null}
            </dl>

            {notice ? (
              <p
                className={`theme-manager-notice theme-manager-notice--${notice.kind}`}
                role={notice.kind === 'error' ? 'alert' : 'status'}
              >
                {notice.text}
              </p>
            ) : null}

            <div className="machine-manager-actions">
              {!isActive ? (
                <button className="btn-primary" type="button" onClick={() => activateTheme(selected.id)}>
                  {t('themeManager.use')}
                </button>
              ) : null}

              <div className="machine-manager-actions-row">
                {selectedCustom ? (
                  <button className="btn-secondary" type="button" onClick={() => openEditor(selectedCustom)}>
                    {t('themeManager.edit')}
                  </button>
                ) : null}
                <button className="btn-secondary" type="button" onClick={() => handleDuplicate(true)}>
                  {selected.builtin ? t('themeManager.duplicateToEdit') : t('themeManager.duplicate')}
                </button>
                {selectedCustom ? (
                  <button
                    className="btn-secondary"
                    type="button"
                    onClick={() => setRenameDraft(selectedCustom.name)}
                  >
                    {t('themeManager.rename')}
                  </button>
                ) : null}
                {selectedCustom && selected.overriddenKeys.length > 0 ? (
                  <button className="btn-secondary" type="button" onClick={handleResetOverrides}>
                    {t('themeManager.resetToBase')}
                  </button>
                ) : null}
                <button className="btn-secondary" type="button" onClick={() => { void handleImport() }}>
                  {t('themeManager.import')}
                </button>
                {selectedCustom ? (
                  <button className="btn-secondary" type="button" onClick={handleExport}>
                    {t('themeManager.export')}
                  </button>
                ) : null}
              </div>

              {selectedCustom ? (
                <button className="machine-manager-action--remove" type="button" onClick={handleDelete}>
                  {t('themeManager.delete')}
                </button>
              ) : null}
            </div>

            <section className="theme-manager-system" aria-label={t('themeManager.systemAria')}>
              <h4 className="theme-manager-system__title">{t('themeManager.modeTitle')}</h4>
              <label className="theme-manager-system__mode">
                <input
                  type="radio"
                  name="theme-selection-mode"
                  checked={selection.mode === 'fixed'}
                  onChange={() => setSelection((previous) => ({ ...previous, mode: 'fixed' }))}
                />
                {t('themeManager.fixedMode')}
              </label>
              <label className="theme-manager-system__mode">
                <input
                  type="radio"
                  name="theme-selection-mode"
                  checked={selection.mode === 'system'}
                  onChange={() => setSelection((previous) => ({ ...previous, mode: 'system' }))}
                />
                {t('themeManager.systemMode')}
              </label>

              {selection.mode === 'system' ? (
                <div className="theme-manager-system__pair">
                  <label className="theme-manager-system__slot">
                    {t('themeManager.lightSlot')}
                    <select
                      value={selection.systemLightThemeId}
                      onChange={(event) =>
                        setSelection((previous) => ({ ...previous, systemLightThemeId: event.target.value }))}
                    >
                      {lightFamilyThemes.map((theme) => (
                        <option key={theme.id} value={theme.id}>{theme.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="theme-manager-system__slot">
                    {t('themeManager.darkSlot')}
                    <select
                      value={selection.systemDarkThemeId}
                      onChange={(event) =>
                        setSelection((previous) => ({ ...previous, systemDarkThemeId: event.target.value }))}
                    >
                      {darkFamilyThemes.map((theme) => (
                        <option key={theme.id} value={theme.id}>{theme.name}</option>
                      ))}
                    </select>
                  </label>
                  <p className="theme-manager-system__hint">
                    {systemPrefersDark ? t('themeManager.systemPrefersDark') : t('themeManager.systemPrefersLight')}
                  </p>
                </div>
              ) : null}
            </section>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-primary" type="button" onClick={onClose}>
            {t('themeManager.done')}
          </button>
        </div>
      </div>

      {editingTheme ? (
        <ThemeEditorDialog
          theme={editingTheme}
          onApply={handleEditorApply}
          onClose={() => setEditingTheme(null)}
        />
      ) : null}
    </div>,
    document.body,
  )
}
