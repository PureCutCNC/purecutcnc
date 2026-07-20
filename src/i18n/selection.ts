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

/**
 * Locale selection model: which locale is active and which custom language
 * packs exist. Persisted in namespaced local storage as application
 * preferences (never `.camj` project data). No stored choice means
 * "auto-detect from the browser/OS locale"; only an explicit user selection
 * is ever written.
 */

import type { StorageCodec } from '../hooks/useLocalStorageState'
import {
  isBuiltinLocaleId,
  validateCustomLanguage,
  type BuiltinLocaleId,
  type CustomLanguageData,
} from './registry'

export const LOCALE_STORAGE_KEY = 'purecutcnc.i18n.locale'
export const CUSTOM_LANGUAGES_STORAGE_KEY = 'purecutcnc.i18n.customLanguages'

/** Stored as the bare locale ID string, not JSON. */
export const localeIdCodec: StorageCodec<string> = {
  serialize: (value) => value,
  deserialize: (raw) => raw,
}

/**
 * Parse the stored custom language list. Invalid entries and duplicate or
 * built-in-colliding IDs are dropped individually so one corrupt record can
 * never take down the whole language system.
 */
export function sanitizeStoredCustomLanguages(raw: unknown): CustomLanguageData[] {
  if (!Array.isArray(raw)) return []
  const languages: CustomLanguageData[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const validated = validateCustomLanguage(entry)
    if (validated.ok !== undefined && !seen.has(validated.ok.id) && !isBuiltinLocaleId(validated.ok.id)) {
      seen.add(validated.ok.id)
      languages.push(validated.ok)
    }
  }
  return languages
}

export const customLanguagesCodec: StorageCodec<CustomLanguageData[]> = {
  serialize: (value) => JSON.stringify(value),
  deserialize: (raw) => sanitizeStoredCustomLanguages(JSON.parse(raw)),
}

export function readStoredCustomLanguages(storage: Pick<Storage, 'getItem'> | null): CustomLanguageData[] {
  if (!storage) return []
  try {
    const stored = storage.getItem(CUSTOM_LANGUAGES_STORAGE_KEY)
    if (stored === null) return []
    return customLanguagesCodec.deserialize(stored)
  } catch {
    return []
  }
}

export function readStoredLocaleId(storage: Pick<Storage, 'getItem'> | null): string | null {
  if (!storage) return null
  try {
    return storage.getItem(LOCALE_STORAGE_KEY)
  } catch {
    return null
  }
}

/**
 * Map the browser/OS language list onto a built-in locale. French matches
 * any `fr` tag. Simplified Chinese matches `zh` tags unless they explicitly mark the Traditional
 * script or a Traditional-default region (`Hant`, TW, HK, MO) — issue #311's
 * contract is "prefer zh-CN when the locale resolves to zh-CN", and serving
 * Simplified text to explicit Traditional readers would be wrong more often
 * than helpful. German matches any `de` tag (de, de-DE, de-AT, de-CH) since
 * there is no comparable script split — issue #320's contract is "prefer
 * German when the locale resolves to German". Unmatched tags keep scanning;
 * the final fallback is English.
 */
export function detectLocaleIdFromNavigator(languages: readonly string[]): BuiltinLocaleId {
  for (const tag of languages) {
    const lower = tag.toLowerCase()
    const subtags = lower.split('-')
    if (subtags[0] === 'en') return 'en'
    if (subtags[0] === 'de') return 'de'
    if (subtags[0] === 'fr') return 'fr'
    if (subtags[0] === 'zh') {
      const traditional = subtags.includes('hant')
        || subtags.includes('tw')
        || subtags.includes('hk')
        || subtags.includes('mo')
      if (!traditional) return 'zh-CN'
    }
  }
  return 'en'
}

/**
 * The locale to activate at startup: a stored choice that still resolves
 * (built-in or existing custom pack) wins; otherwise detect from the
 * browser/OS language list; otherwise English.
 */
export function resolveInitialLocaleId(
  storedId: string | null,
  customLanguages: readonly CustomLanguageData[],
  navigatorLanguages: readonly string[],
): string {
  if (storedId !== null) {
    if (isBuiltinLocaleId(storedId)) return storedId
    if (customLanguages.some((language) => language.id === storedId)) return storedId
  }
  return detectLocaleIdFromNavigator(navigatorLanguages)
}
