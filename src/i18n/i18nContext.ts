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

import { createContext, useContext } from 'react'
import type { MessageParams } from './catalog'
import type { MessageKey } from './locales/en'
import type { CustomLanguageData, ResolvedLocale } from './registry'

/** Context contract, separated from the provider for Fast Refresh. */
export interface I18nContextValue {
  localeId: string
  languageTag: string
  locale: ResolvedLocale
  customLanguages: readonly CustomLanguageData[]
  t: (key: MessageKey, params?: MessageParams) => string
  tPlural: (count: number, oneKey: MessageKey, otherKey: MessageKey, params?: MessageParams) => string
  setLocale: (localeId: string) => void
  saveCustomLanguage: (language: CustomLanguageData) => void
  deleteCustomLanguage: (languageId: string) => void
}

export const I18nContext = createContext<I18nContextValue | null>(null)

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext)
  if (value === null) {
    throw new Error('useI18n must be used within an I18nProvider')
  }
  return value
}
