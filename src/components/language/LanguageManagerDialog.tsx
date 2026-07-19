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
import {
  BUILTIN_LOCALE_IDS,
  customLanguageProgress,
  customLanguagePlaceholderIssues,
  duplicateLanguageName,
  duplicateLocaleAsCustom,
  LANGUAGE_NAME_MAX_LENGTH,
  parseLanguageImport,
  resolveBuiltinLocale,
  resolveCustomLanguage,
  serializeLanguageExport,
  type CustomLanguageData,
  type ResolvedLocale,
} from '../../i18n/registry'
import { platform } from '../../platform'
import { LanguageEditorDialog } from './LanguageEditorDialog'

export interface LanguageManagerDialogProps {
  onClose: () => void
}

/**
 * Language manager, mirroring `ThemeManagerDialog`: built-in locales and
 * custom language packs with activate/duplicate/rename/edit/delete/export/
 * import actions and translation-progress reporting. Language packs are
 * application-local preferences; nothing here touches project data.
 */
export function LanguageManagerDialog({ onClose }: LanguageManagerDialogProps) {
  const {
    t,
    tPlural,
    localeId,
    customLanguages,
    setLocale,
    saveCustomLanguage,
    deleteCustomLanguage,
  } = useI18n()

  const allLocales = useMemo<ResolvedLocale[]>(
    () => [
      ...BUILTIN_LOCALE_IDS.map((id) => resolveBuiltinLocale(id)),
      ...customLanguages.map((custom) => resolveCustomLanguage(custom)),
    ],
    [customLanguages],
  )

  const [selectedId, setSelectedId] = useState(localeId)
  const [editingLanguage, setEditingLanguage] = useState<CustomLanguageData | null>(null)
  const [renameDraft, setRenameDraft] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)

  const selected = allLocales.find((locale) => locale.id === selectedId) ?? allLocales[0]
  const selectedCustom = customLanguages.find((language) => language.id === selected.id) ?? null
  const existingNames = useMemo(() => allLocales.map((locale) => locale.name), [allLocales])

  // Escape closes the manager, unless the nested editor owns the key press.
  useWindowEvent('keydown', (event) => {
    if (event.key !== 'Escape' || editingLanguage) return
    onClose()
  })

  const openEditor = (custom: CustomLanguageData) => {
    setNotice(null)
    setRenameDraft(null)
    setEditingLanguage(custom)
  }

  const handleDuplicate = () => {
    const duplicated = duplicateLocaleAsCustom(selected, customLanguages, existingNames)
    saveCustomLanguage(duplicated)
    setSelectedId(duplicated.id)
    openEditor(duplicated)
  }

  const handleDelete = () => {
    if (!selectedCustom) return
    deleteCustomLanguage(selectedCustom.id)
    setSelectedId(selectedCustom.baseLocaleId)
    setNotice({ kind: 'info', text: t('langManager.deleted', { name: selectedCustom.name }) })
  }

  const handleExport = () => {
    if (!selectedCustom) return
    void platform.saveTextFile(
      `${selectedCustom.name}.json`,
      serializeLanguageExport(selectedCustom),
      'json',
    )
  }

  const handleImport = async () => {
    const content = await platform.pickJsonFile()
    if (content === null) return
    const result = parseLanguageImport(content)
    if (result.error !== undefined) {
      setNotice({ kind: 'error', text: t('langManager.importFailed', { error: result.error }) })
      return
    }
    const imported = existingNames.some((name) => name.toLowerCase() === result.ok.name.toLowerCase())
      ? { ...result.ok, name: duplicateLanguageName(result.ok.name, existingNames) }
      : result.ok
    saveCustomLanguage(imported)
    setSelectedId(imported.id)
    const issues = customLanguagePlaceholderIssues(imported)
    setNotice({
      kind: 'info',
      text: issues.length > 0
        ? tPlural(
          issues.length,
          'langManager.importPlaceholderIssues.one',
          'langManager.importPlaceholderIssues.other',
          { name: imported.name },
        )
        : t('langManager.imported', { name: imported.name }),
    })
  }

  const commitRename = () => {
    if (!selectedCustom || renameDraft === null) return
    const trimmed = renameDraft.trim()
    if (trimmed !== '' && trimmed !== selectedCustom.name) {
      saveCustomLanguage({ ...selectedCustom, name: trimmed })
    }
    setRenameDraft(null)
  }

  // Apply persists and closes; activation stays an explicit "Use this
  // language" choice (unlike themes, a half-translated pack is a state the
  // author may want saved without living in it).
  const handleEditorApply = (edited: CustomLanguageData) => {
    saveCustomLanguage(edited)
    setSelectedId(edited.id)
    setEditingLanguage(null)
  }

  const isActive = selected.id === localeId
  const progress = selectedCustom ? customLanguageProgress(selectedCustom) : null

  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog--theme-manager dialog--language-manager"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('langManager.title')}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{t('langManager.title')}</h2>
          <button className="dialog-close" onClick={onClose} aria-label={t('langManager.close')} type="button">
            ✕
          </button>
        </div>

        <div className="dialog-body dialog-body--theme-manager">
          {/* Left: locale list */}
          <div className="theme-manager-list" role="listbox" aria-label={t('langManager.title')}>
            {allLocales.map((locale) => (
              <button
                key={locale.id}
                type="button"
                role="option"
                aria-selected={locale.id === selected.id}
                className={[
                  'theme-manager-item',
                  locale.id === selected.id ? 'theme-manager-item--selected' : '',
                  locale.id === localeId ? 'theme-manager-item--active' : '',
                ].join(' ').trim()}
                onClick={() => {
                  setSelectedId(locale.id)
                  setRenameDraft(null)
                  setNotice(null)
                }}
              >
                <span className="theme-manager-item-name" lang={locale.languageTag}>{locale.name}</span>
                <span className={locale.builtin ? 'machine-manager-badge machine-manager-badge--builtin' : 'machine-manager-badge machine-manager-badge--custom'}>
                  {locale.builtin ? t('langManager.builtinBadge') : t('langManager.customBadge')}
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
                    maxLength={LANGUAGE_NAME_MAX_LENGTH}
                    autoFocus
                    aria-label={t('langManager.renameLabel')}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename()
                      if (event.key === 'Escape') {
                        event.stopPropagation()
                        setRenameDraft(null)
                      }
                    }}
                  />
                  <button className="btn-secondary" type="button" onClick={commitRename}>
                    {t('langManager.saveName')}
                  </button>
                </span>
              ) : (
                <h3 className="machine-manager-detail-name" lang={selected.languageTag}>{selected.name}</h3>
              )}
              {isActive ? (
                <span className="machine-manager-badge machine-manager-badge--active">{t('langManager.activeBadge')}</span>
              ) : null}
              <span className={selected.builtin ? 'machine-manager-badge machine-manager-badge--builtin' : 'machine-manager-badge machine-manager-badge--custom'}>
                {selected.builtin ? t('langManager.builtinBadge') : t('langManager.customBadge')}
              </span>
            </div>

            <dl className="machine-manager-meta">
              <dt>{t('langManager.tagLabel')}</dt>
              <dd>{selected.languageTag}</dd>
              {!selected.builtin ? (
                <>
                  <dt>{t('langManager.baseLabel')}</dt>
                  <dd lang={resolveBuiltinLocale(selected.baseLocaleId).languageTag}>
                    {resolveBuiltinLocale(selected.baseLocaleId).name}
                  </dd>
                </>
              ) : null}
              {selected.builtin ? (
                <dd className="machine-manager-hint">
                  {t('langManager.duplicateHint')}
                </dd>
              ) : null}
            </dl>

            {progress ? (
              <p className="language-manager-progress">
                {t('langManager.progress', { translated: progress.translated, total: progress.total })}
              </p>
            ) : null}

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
                <button className="btn-primary" type="button" onClick={() => setLocale(selected.id)}>
                  {t('langManager.use')}
                </button>
              ) : null}

              <div className="machine-manager-actions-row">
                {selectedCustom ? (
                  <button className="btn-secondary" type="button" onClick={() => openEditor(selectedCustom)}>
                    {t('langManager.edit')}
                  </button>
                ) : null}
                <button className="btn-secondary" type="button" onClick={handleDuplicate}>
                  {t('langManager.duplicate')}
                </button>
                {selectedCustom ? (
                  <button
                    className="btn-secondary"
                    type="button"
                    onClick={() => setRenameDraft(selectedCustom.name)}
                  >
                    {t('langManager.rename')}
                  </button>
                ) : null}
                <button className="btn-secondary" type="button" onClick={() => { void handleImport() }}>
                  {t('langManager.import')}
                </button>
                {selectedCustom ? (
                  <button className="btn-secondary" type="button" onClick={handleExport}>
                    {t('langManager.export')}
                  </button>
                ) : null}
              </div>

              {selectedCustom ? (
                <button className="machine-manager-action--remove" type="button" onClick={handleDelete}>
                  {t('langManager.delete')}
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-primary" type="button" onClick={onClose}>
            {t('langManager.done')}
          </button>
        </div>
      </div>

      {editingLanguage ? (
        <LanguageEditorDialog
          language={editingLanguage}
          onApply={handleEditorApply}
          onClose={() => setEditingLanguage(null)}
        />
      ) : null}
    </div>,
    document.body,
  )
}
