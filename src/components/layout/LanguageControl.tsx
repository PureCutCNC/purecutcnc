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
import { useI18n } from '../../i18n/i18nContext'
import { builtinLocaleInfos } from '../../i18n/registry'
import { Icon } from '../Icon'

/**
 * Interface-language selector, mirroring `AppearanceControl`'s menu pattern
 * (and reusing its menu styling): built-in locales listed by native name,
 * any custom language packs beneath, radio-style selection. Language is an
 * application preference — switching never touches project state.
 * The "Manage languages…" entry arrives with the language manager (phase 6
 * of issue #314).
 */
export function LanguageControl() {
  const { t, localeId, locale, customLanguages, setLocale } = useI18n()
  const [open, setOpen] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()

  useOutsideDismiss({ open, refs: hostRef, onDismiss: () => setOpen(false) })

  const chooseLocale = (id: string) => {
    setLocale(id)
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }

  return (
    <div className="appearance-control language-control" ref={hostRef}>
      <div className="toolbar-action">
        <button
          ref={triggerRef}
          className="toolbar-icon-btn language-control__trigger"
          type="button"
          aria-label={t('language.current', { name: locale.name })}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((previous) => !previous)}
        >
          <Icon id="language" />
        </button>
        {!open && (
          <span className="toolbar-tooltip toolbar-tooltip--bottom" role="tooltip">
            {t('language.tooltip')}
          </span>
        )}
      </div>

      {open && (
        <div className="appearance-menu" id={menuId} role="menu" aria-label={t('language.menuAria')}>
          <div className="appearance-menu__heading">{t('language.heading')}</div>
          <div className="appearance-menu__options">
            {builtinLocaleInfos().map((info) => {
              const selected = localeId === info.id
              return (
                <button
                  key={info.id}
                  className={`appearance-menu__option ${selected ? 'appearance-menu__option--selected' : ''}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  lang={info.id}
                  onClick={() => chooseLocale(info.id)}
                >
                  <span className="appearance-menu__copy">
                    <span className="appearance-menu__label">{info.nativeName}</span>
                    {info.englishName !== info.nativeName && (
                      <span className="appearance-menu__detail">{info.englishName}</span>
                    )}
                  </span>
                  <span className="appearance-menu__check" aria-hidden="true">{selected ? '✓' : ''}</span>
                </button>
              )
            })}

            {customLanguages.length > 0 && (
              <>
                <div className="appearance-menu__heading appearance-menu__heading--section">
                  {t('language.customHeading')}
                </div>
                {customLanguages.map((custom) => {
                  const selected = localeId === custom.id
                  return (
                    <button
                      key={custom.id}
                      className={`appearance-menu__option ${selected ? 'appearance-menu__option--selected' : ''}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      lang={custom.languageTag}
                      onClick={() => chooseLocale(custom.id)}
                    >
                      <span className="appearance-menu__copy">
                        <span className="appearance-menu__label">{custom.name}</span>
                        <span className="appearance-menu__detail">{custom.languageTag}</span>
                      </span>
                      <span className="appearance-menu__check" aria-hidden="true">{selected ? '✓' : ''}</span>
                    </button>
                  )
                })}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
