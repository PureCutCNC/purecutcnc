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

import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWindowEvent } from '../../hooks/useEventListener'
import { placeholderNames, placeholdersMatch } from '../../i18n/catalog'
import { useI18n } from '../../i18n/i18nContext'
import { enMessages, type MessageKey } from '../../i18n/locales/en'
import {
  customLanguageProgress,
  customLanguagePlaceholderIssues,
  isValidLanguageTag,
  LANGUAGE_NAME_MAX_LENGTH,
  resolveBuiltinLocale,
  type CustomLanguageData,
} from '../../i18n/registry'

export interface LanguageEditorDialogProps {
  language: CustomLanguageData
  /** Called with the edited pack when Apply passes validation. */
  onApply: (language: CustomLanguageData) => void
  /** Cancel/Escape/close — a persisted preview is rolled back first. */
  onClose: () => void
}

type RowFilter = 'all' | 'untranslated' | 'edited'

/**
 * The catalog sections, grouped by top-level key namespace in catalog order.
 * Module-level because the key space is fixed per build (~1400 keys); the
 * dialog renders rows only for open sections to keep the DOM small.
 */
const SECTIONS: { namespace: string; keys: MessageKey[] }[] = (() => {
  const order: string[] = []
  const byNamespace = new Map<string, MessageKey[]>()
  for (const key of Object.keys(enMessages) as MessageKey[]) {
    const namespace = key.split('.')[0]
    let bucket = byNamespace.get(namespace)
    if (!bucket) {
      bucket = []
      byNamespace.set(namespace, bucket)
      order.push(namespace)
    }
    bucket.push(key)
  }
  return order.map((namespace) => ({ namespace, keys: byNamespace.get(namespace)! }))
})()

/** Brace-wrapped placeholder list for the per-row mismatch message. */
function expectedPlaceholderList(source: string): string {
  return placeholderNames(source).map((name) => `{${name}}`).join(', ')
}

/**
 * Custom-language editor, the language analogue of `ThemeEditorDialog`:
 * per-key translation rows grouped by namespace with search and filtering, a
 * placeholder-parity gate on Apply, and an explicit "Preview in app" that
 * persists the draft (there is no presentation-only preview channel for
 * language packs) — Cancel restores the snapshot taken when the editor
 * opened, including the previously active language.
 */
export function LanguageEditorDialog({ language, onApply, onClose }: LanguageEditorDialogProps) {
  const { t, tPlural, localeId, setLocale, saveCustomLanguage } = useI18n()

  const [name, setName] = useState(language.name)
  const [languageTag, setLanguageTag] = useState(language.languageTag)
  const [overrides, setOverrides] = useState(language.overrides)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<RowFilter>('all')
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(new Set())
  const [previewed, setPreviewed] = useState(false)

  // Snapshots for Cancel: the pack as it was saved, and the locale that was
  // active, when the editor opened.
  const savedLanguageRef = useRef(language)
  const openLocaleIdRef = useRef(localeId)

  const base = resolveBuiltinLocale(language.baseLocaleId)
  const baseIsEnglish = language.baseLocaleId === 'en'

  const working = useMemo<CustomLanguageData>(
    () => ({
      ...language,
      name: name.trim() === '' ? language.name : name.trim(),
      languageTag: languageTag.trim(),
      overrides,
    }),
    [language, name, languageTag, overrides],
  )

  const progress = useMemo(() => customLanguageProgress(working), [working])
  const issueCount = useMemo(() => customLanguagePlaceholderIssues(working).length, [working])

  const nameInvalid = name.trim() === ''
  const tagInvalid = !isValidLanguageTag(languageTag.trim())
  const blocked = issueCount > 0 || nameInvalid || tagInvalid

  const handleCancel = () => {
    if (previewed) {
      saveCustomLanguage(savedLanguageRef.current)
      if (localeId !== openLocaleIdRef.current) {
        setLocale(openLocaleIdRef.current)
      }
    }
    onClose()
  }

  useWindowEvent('keydown', (event) => {
    if (event.key === 'Escape') handleCancel()
  })

  const changeValue = (key: MessageKey, nextValue: string) => {
    setOverrides((previous) => {
      const next = { ...previous }
      if (nextValue === '') {
        delete next[key]
      } else {
        next[key] = nextValue
      }
      return next
    })
  }

  const resetValue = (key: MessageKey) => {
    setOverrides((previous) => {
      if (previous[key] === undefined) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })
  }

  // Preview persists the draft and activates the pack so the whole app renders
  // with it; further edits need another press (no per-keystroke persistence).
  const handlePreview = () => {
    if (nameInvalid || tagInvalid) return
    saveCustomLanguage(working)
    if (localeId !== working.id) setLocale(working.id)
    setPreviewed(true)
  }

  const handleApply = () => {
    if (blocked) return
    onApply(working)
  }

  const query = search.trim().toLowerCase()
  const filterActive = query !== '' || filter !== 'all'

  const rowMatches = (key: MessageKey): boolean => {
    const value = overrides[key] ?? ''
    if (filter === 'untranslated' && value !== '') return false
    if (filter === 'edited' && value === '') return false
    if (query === '') return true
    return (
      key.toLowerCase().includes(query)
      || enMessages[key].toLowerCase().includes(query)
      || value.toLowerCase().includes(query)
    )
  }

  const visibleSections = SECTIONS
    .map((section) => ({
      ...section,
      visibleKeys: filterActive ? section.keys.filter(rowMatches) : section.keys,
    }))
    .filter((section) => section.visibleKeys.length > 0)

  const toggleSection = (namespace: string, open: boolean) => {
    setOpenSections((previous) => {
      const next = new Set(previous)
      if (open) {
        next.add(namespace)
      } else {
        next.delete(namespace)
      }
      return next
    })
  }

  return createPortal(
    <div className="dialog-backdrop" onClick={handleCancel}>
      <div
        className="dialog dialog--language-editor"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('langEditor.title', { name: language.name })}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{t('langEditor.title', { name: language.name })}</h2>
          <button className="dialog-close" onClick={handleCancel} aria-label={t('langManager.close')} type="button">
            ✕
          </button>
        </div>

        <div className="dialog-body dialog-body--language-editor">
          <div className="language-editor-meta">
            <label className="language-editor-field">
              {t('langEditor.nameLabel')}
              <input
                className={`language-editor-field__input ${nameInvalid ? 'language-editor-field__input--invalid' : ''}`}
                type="text"
                value={name}
                maxLength={LANGUAGE_NAME_MAX_LENGTH}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="language-editor-field">
              {t('langEditor.tagLabel')}
              <input
                className={`language-editor-field__input ${tagInvalid ? 'language-editor-field__input--invalid' : ''}`}
                type="text"
                value={languageTag}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setLanguageTag(event.target.value)}
              />
              <span className="language-editor-field__hint">
                {tagInvalid ? t('langEditor.tagInvalid') : t('langEditor.tagHint')}
              </span>
            </label>
            <p className="language-editor-progress">
              {t('langEditor.progress', { translated: progress.translated, total: progress.total })}
            </p>
          </div>

          <div className="language-editor-toolbar">
            <input
              className="language-editor-search"
              type="search"
              value={search}
              placeholder={t('langEditor.searchPlaceholder')}
              aria-label={t('langEditor.searchPlaceholder')}
              onChange={(event) => setSearch(event.target.value)}
            />
            <label className="language-editor-filter">
              {t('langEditor.filterLabel')}
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value as RowFilter)}
              >
                <option value="all">{t('langEditor.filterAll')}</option>
                <option value="untranslated">{t('langEditor.filterUntranslated')}</option>
                <option value="edited">{t('langEditor.filterEdited')}</option>
              </select>
            </label>
          </div>

          <div className="language-editor-sections">
            {visibleSections.length === 0 ? (
              <p className="language-editor-no-matches">{t('langEditor.noMatches')}</p>
            ) : null}
            {visibleSections.map((section) => {
              const open = query !== '' || openSections.has(section.namespace)
              const translatedInSection = section.keys
                .filter((key) => (overrides[key] ?? '') !== '').length
              return (
                <details
                  key={section.namespace}
                  className="language-editor-section"
                  open={open}
                  onToggle={(event) => toggleSection(section.namespace, event.currentTarget.open)}
                >
                  <summary className="language-editor-section__summary">
                    <span className="language-editor-section__name">{section.namespace}</span>
                    <span className="language-editor-section__count">
                      {t('langEditor.sectionCount', {
                        translated: translatedInSection,
                        total: section.keys.length,
                      })}
                    </span>
                  </summary>
                  {open ? section.visibleKeys.map((key) => {
                    const source = enMessages[key]
                    const value = overrides[key] ?? ''
                    const issue = value !== '' && !placeholdersMatch(source, value)
                    const rows = Math.max(source.length, value.length) > 90 ? 3 : 1
                    return (
                      <div key={key} className="language-editor-row">
                        <div className="language-editor-row__meta">
                          <code className="language-editor-row__key">{key}</code>
                          <span className="language-editor-row__text">
                            <span className="language-editor-row__text-label">{t('langEditor.sourceLabel')}</span>
                            <span lang="en">{source}</span>
                          </span>
                          {!baseIsEnglish ? (
                            <span className="language-editor-row__text language-editor-row__text--base">
                              <span className="language-editor-row__text-label">
                                {t('langEditor.baseLabel', { base: base.name })}
                              </span>
                              <span lang={base.languageTag}>{base.messages[key]}</span>
                            </span>
                          ) : null}
                        </div>
                        <div className="language-editor-row__edit">
                          <textarea
                            className={`language-editor-row__input ${issue ? 'language-editor-row__input--invalid' : ''}`}
                            value={value}
                            rows={rows}
                            lang={working.languageTag}
                            spellCheck={false}
                            aria-label={key}
                            aria-invalid={issue}
                            placeholder={t('langEditor.inputPlaceholder')}
                            onChange={(event) => changeValue(key, event.target.value)}
                          />
                          <button
                            className="language-editor-row__reset"
                            type="button"
                            aria-label={`${t('langEditor.resetKey')} ${key}`}
                            disabled={value === ''}
                            onClick={() => resetValue(key)}
                          >
                            ↺
                          </button>
                        </div>
                        {issue ? (
                          <p className="language-editor-row__issue" role="alert">
                            {t('langEditor.placeholderIssue', { expected: expectedPlaceholderList(source) })}
                          </p>
                        ) : null}
                      </div>
                    )
                  }) : null}
                </details>
              )
            })}
          </div>
        </div>

        <div className="dialog-footer">
          {previewed ? (
            <span className="language-editor-footer-note" role="status">
              {t('langEditor.previewing')}
            </span>
          ) : null}
          {issueCount > 0 ? (
            <span className="theme-editor-footer-blocked" role="status">
              {tPlural(
                issueCount,
                'langEditor.placeholderIssuesBlockApply.one',
                'langEditor.placeholderIssuesBlockApply.other',
              )}
            </span>
          ) : null}
          <button className="btn-secondary" type="button" onClick={handleCancel}>
            {t('langEditor.cancel')}
          </button>
          <button
            className="btn-secondary"
            type="button"
            onClick={handlePreview}
            disabled={nameInvalid || tagInvalid}
          >
            {t('langEditor.preview')}
          </button>
          <button
            className="btn-primary"
            type="button"
            onClick={handleApply}
            disabled={blocked}
          >
            {t('langEditor.apply')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
