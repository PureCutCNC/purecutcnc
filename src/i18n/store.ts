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
 * Framework-agnostic i18n state: the active resolved locale plus the custom
 * language list, with subscribe/notify for React (`I18nProvider` uses
 * `useSyncExternalStore`) and module-level `translate()` for the few
 * non-React call sites (platform confirm dialogs, pre-React bootstrap).
 *
 * Translation is presentation-only: nothing here touches project, geometry,
 * toolpath, or serialization state, and switching locale must never dirty a
 * project.
 */

import { interpolate, pluralVariant, type MessageParams } from './catalog'
import { enMessages, type MessageKey } from './locales/en'
import { writeToStorage } from '../hooks/useLocalStorageState'
import {
  resolveLocaleById,
  type CustomLanguageData,
  type ResolvedLocale,
} from './registry'
import {
  CUSTOM_LANGUAGES_STORAGE_KEY,
  customLanguagesCodec,
  LOCALE_STORAGE_KEY,
  localeIdCodec,
  readStoredCustomLanguages,
  readStoredLocaleId,
  resolveInitialLocaleId,
} from './selection'

export interface I18nSnapshot {
  localeId: string
  languageTag: string
  locale: ResolvedLocale
  customLanguages: readonly CustomLanguageData[]
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function buildSnapshot(localeId: string, customLanguages: readonly CustomLanguageData[]): I18nSnapshot {
  const locale = resolveLocaleById(localeId, customLanguages)
  return {
    // A stale ID resolves to a fallback; snapshot the resolved identity so
    // state and persistence never reference a locale that doesn't exist.
    localeId: locale.id,
    languageTag: locale.languageTag,
    locale,
    customLanguages,
  }
}

let storageRef: StorageLike | null = null
let snapshot: I18nSnapshot = buildSnapshot('en', [])
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function applyDocumentLanguage(): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = snapshot.languageTag
}

/**
 * Initialize from persisted preferences (called by `bootstrapI18n()` before
 * React renders; tests pass a fake storage or null). Applies the resolved
 * language tag to the document immediately so there is no wrong-language
 * flash and the phone-blocker screen is covered too.
 */
export function initI18nStore(storage: StorageLike | null): void {
  storageRef = storage
  const customLanguages = readStoredCustomLanguages(storage)
  const storedId = readStoredLocaleId(storage)
  const localeId = resolveInitialLocaleId(storedId, customLanguages, navigatorLanguages())
  snapshot = buildSnapshot(localeId, customLanguages)
  applyDocumentLanguage()
  notify()
}

function navigatorLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    return navigator.languages
  }
  return navigator.language ? [navigator.language] : []
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getI18nSnapshot(): I18nSnapshot {
  return snapshot
}

/**
 * Activate a locale as an explicit user choice: resolves (stale IDs fall back
 * to English), persists, retags the document, and notifies subscribers.
 */
export function setActiveLocale(localeId: string): void {
  snapshot = buildSnapshot(localeId, snapshot.customLanguages)
  writeToStorage(storageRef, LOCALE_STORAGE_KEY, snapshot.localeId, localeIdCodec)
  applyDocumentLanguage()
  notify()
}

/** Add or update a custom language pack; re-resolves if it is active. */
export function saveCustomLanguage(language: CustomLanguageData): void {
  const index = snapshot.customLanguages.findIndex((existing) => existing.id === language.id)
  const customLanguages = index === -1
    ? [...snapshot.customLanguages, language]
    : snapshot.customLanguages.map((existing) => (existing.id === language.id ? language : existing))
  writeToStorage(storageRef, CUSTOM_LANGUAGES_STORAGE_KEY, customLanguages, customLanguagesCodec)
  snapshot = buildSnapshot(snapshot.localeId, customLanguages)
  applyDocumentLanguage()
  notify()
}

/**
 * Delete a custom language pack. If it was active, the selection falls back
 * to the pack's base built-in locale (persisted, mirroring theme deletion).
 */
export function deleteCustomLanguage(languageId: string): void {
  const target = snapshot.customLanguages.find((language) => language.id === languageId)
  if (!target) return
  const wasActive = snapshot.localeId === languageId
  const customLanguages = snapshot.customLanguages.filter((language) => language.id !== languageId)
  writeToStorage(storageRef, CUSTOM_LANGUAGES_STORAGE_KEY, customLanguages, customLanguagesCodec)
  snapshot = buildSnapshot(wasActive ? target.baseLocaleId : snapshot.localeId, customLanguages)
  if (wasActive) {
    writeToStorage(storageRef, LOCALE_STORAGE_KEY, snapshot.localeId, localeIdCodec)
  }
  applyDocumentLanguage()
  notify()
}

/**
 * Translate a message key in the active locale, falling back to English per
 * key. Usable outside React (platform dialogs); React components should use
 * `useI18n()` so they re-render on locale change.
 */
export function translate(key: MessageKey, params?: MessageParams): string {
  const template = snapshot.locale.messages[key] ?? enMessages[key]
  return interpolate(template, params)
}

/**
 * Translate a count-bearing message using explicit plural-variant keys. The
 * count is provided to interpolation as `{count}` automatically.
 */
export function translatePlural(
  count: number,
  oneKey: MessageKey,
  otherKey: MessageKey,
  params?: MessageParams,
): string {
  const key = pluralVariant(snapshot.languageTag, count) === 'one' ? oneKey : otherKey
  return translate(key, { count, ...params })
}

/** Test seam: reset module state between unit tests. */
export function resetI18nStoreForTests(): void {
  storageRef = null
  snapshot = buildSnapshot('en', [])
  listeners.clear()
}
