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

import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { I18nContext, type I18nContextValue } from './i18nContext'
import {
  deleteCustomLanguage,
  getI18nSnapshot,
  saveCustomLanguage,
  setActiveLocale,
  subscribe,
  translate,
  translatePlural,
} from './store'

/**
 * React binding for the i18n store. Locale changes swap the context value,
 * re-rendering consumers in place — component identity, project state,
 * selection, and view transforms are untouched. The store itself lives at
 * module level so `bootstrapI18n()` and non-React call sites share it.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(subscribe, getI18nSnapshot, getI18nSnapshot)

  const value = useMemo<I18nContextValue>(
    () => ({
      localeId: snapshot.localeId,
      languageTag: snapshot.languageTag,
      locale: snapshot.locale,
      customLanguages: snapshot.customLanguages,
      t: translate,
      tPlural: translatePlural,
      setLocale: setActiveLocale,
      saveCustomLanguage,
      deleteCustomLanguage,
    }),
    [snapshot],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
