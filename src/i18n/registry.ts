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
 * Versioned locale registry, mirroring `src/theme/registry.ts`: immutable
 * built-in locale definitions, custom language-pack schema validation,
 * base+overrides resolution against the English catalog, duplication, and the
 * versioned import/export envelope. Locale data is application-local
 * preference data — never `.camj` project data.
 */

import { placeholderNames, placeholdersMatch } from './catalog'
import { enMessages, type MessageKey } from './locales/en'
import { fr } from './locales/fr'
import { zhCN } from './locales/zh-CN'
import { de } from './locales/de'

export const CUSTOM_LANGUAGE_SCHEMA_VERSION = 1
export const LANGUAGE_NAME_MAX_LENGTH = 60

export type BuiltinLocaleId = 'en' | 'zh-CN' | 'de' | 'fr'

export const BUILTIN_LOCALE_IDS: readonly BuiltinLocaleId[] = ['en', 'zh-CN', 'de', 'fr']

export function isBuiltinLocaleId(value: string): value is BuiltinLocaleId {
  return (BUILTIN_LOCALE_IDS as readonly string[]).includes(value)
}

interface BuiltinLocaleDefinition {
  id: BuiltinLocaleId
  /** BCP-47 tag applied to `document.documentElement.lang` and plural rules. */
  languageTag: string
  /** Self-name shown in the language menu; never translated. */
  nativeName: string
  englishName: string
  messages: Partial<Record<MessageKey, string>>
}

const BUILTIN_LOCALES: Record<BuiltinLocaleId, BuiltinLocaleDefinition> = {
  en: {
    id: 'en',
    languageTag: 'en',
    nativeName: 'English',
    englishName: 'English',
    messages: enMessages,
  },
  fr: {
    id: 'fr',
    languageTag: 'fr',
    nativeName: 'Français',
    englishName: 'French',
    messages: fr,
  },
  'zh-CN': {
    id: 'zh-CN',
    languageTag: 'zh-CN',
    nativeName: '简体中文',
    englishName: 'Simplified Chinese',
    messages: zhCN,
  },
  de: {
    id: 'de',
    languageTag: 'de',
    nativeName: 'Deutsch',
    englishName: 'German',
    messages: de,
  },
}

/** Menu-facing metadata for the built-in locales, in display order. */
export function builtinLocaleInfos(): { id: BuiltinLocaleId; nativeName: string; englishName: string }[] {
  return BUILTIN_LOCALE_IDS.map((id) => {
    const definition = BUILTIN_LOCALES[id]
    return { id, nativeName: definition.nativeName, englishName: definition.englishName }
  })
}

/** A user-created language pack: application-local preference data. */
export interface CustomLanguageData {
  schemaVersion: typeof CUSTOM_LANGUAGE_SCHEMA_VERSION
  id: string
  /** User-authored display name (e.g. "Deutsch"); never translated. */
  name: string
  /** BCP-47 tag for `document.lang` and plural rules (loosely validated). */
  languageTag: string
  /** Built-in locale whose translations fill keys this pack doesn't override. */
  baseLocaleId: BuiltinLocaleId
  /**
   * Per-key translations. Keys are message keys, but — deliberately unlike
   * theme token overrides — keys unknown to THIS build are kept, not rejected:
   * the catalog grows every release, so packs are version-skewed by design and
   * must round-trip through older builds without shedding translations.
   * Unknown keys are inert at lookup time.
   */
  overrides: Record<string, string>
}

export type LanguageValidationResult =
  | { ok: CustomLanguageData; error?: undefined }
  | { ok?: undefined; error: string }

const ALLOWED_CUSTOM_LANGUAGE_KEYS = new Set([
  'schemaVersion',
  'id',
  'name',
  'languageTag',
  'baseLocaleId',
  'overrides',
])

const LANGUAGE_TAG_PATTERN = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/

/** The loose BCP-47 shape accepted for custom packs (editor + validation). */
export function isValidLanguageTag(tag: string): boolean {
  return LANGUAGE_TAG_PATTERN.test(tag)
}

/**
 * Validate untrusted custom-language data (storage, import). Structural
 * problems reject with a readable message; empty-string override values are
 * dropped (an empty translation means "untranslated", which is the same as
 * absent), and unknown override keys are preserved (see CustomLanguageData).
 */
export function validateCustomLanguage(input: unknown): LanguageValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: 'Language must be a JSON object.' }
  }
  const record = input as Record<string, unknown>

  for (const key of Object.keys(record)) {
    if (!ALLOWED_CUSTOM_LANGUAGE_KEYS.has(key)) {
      return { error: `Unknown language property: "${key}".` }
    }
  }

  if (record.schemaVersion !== CUSTOM_LANGUAGE_SCHEMA_VERSION) {
    return {
      error: `Unsupported language schema version: ${String(record.schemaVersion)}. This app supports version ${CUSTOM_LANGUAGE_SCHEMA_VERSION}.`,
    }
  }
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    return { error: 'Language is missing a valid "id".' }
  }
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (name === '') {
    return { error: 'Language is missing a display "name".' }
  }
  if (name.length > LANGUAGE_NAME_MAX_LENGTH) {
    return { error: `Language name is longer than ${LANGUAGE_NAME_MAX_LENGTH} characters.` }
  }
  const languageTag = typeof record.languageTag === 'string' ? record.languageTag.trim() : ''
  if (!LANGUAGE_TAG_PATTERN.test(languageTag)) {
    return { error: `Language "languageTag" must be a BCP-47 tag such as "de" or "pt-BR".` }
  }
  if (typeof record.baseLocaleId !== 'string' || !isBuiltinLocaleId(record.baseLocaleId)) {
    return { error: `Language "baseLocaleId" must be a built-in locale (${BUILTIN_LOCALE_IDS.join(', ')}).` }
  }
  if (typeof record.overrides !== 'object' || record.overrides === null || Array.isArray(record.overrides)) {
    return { error: 'Language "overrides" must be an object of message strings.' }
  }

  const overrides: Record<string, string> = {}
  for (const [key, value] of Object.entries(record.overrides as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      return { error: `Translation for "${key}" must be a string.` }
    }
    if (value !== '') overrides[key] = value
  }

  return {
    ok: {
      schemaVersion: CUSTOM_LANGUAGE_SCHEMA_VERSION,
      id: record.id.trim(),
      name,
      languageTag,
      baseLocaleId: record.baseLocaleId,
      overrides,
    },
  }
}

/** A locale resolved to a complete, English-backed message map. */
export interface ResolvedLocale {
  id: string
  languageTag: string
  /** Native name (built-in) or the pack's own display name (custom). */
  name: string
  englishName: string
  builtin: boolean
  baseLocaleId: BuiltinLocaleId
  /** Complete lookup map: English filled in wherever the locale has no value. */
  messages: Record<MessageKey, string>
}

export function resolveBuiltinLocale(id: BuiltinLocaleId): ResolvedLocale {
  const definition = BUILTIN_LOCALES[id]
  return {
    id: definition.id,
    languageTag: definition.languageTag,
    name: definition.nativeName,
    englishName: definition.englishName,
    builtin: true,
    baseLocaleId: definition.id,
    messages: { ...enMessages, ...definition.messages },
  }
}

export function resolveCustomLanguage(custom: CustomLanguageData): ResolvedLocale {
  const base = BUILTIN_LOCALES[custom.baseLocaleId]
  const messages: Record<MessageKey, string> = { ...enMessages, ...base.messages }
  for (const [key, value] of Object.entries(custom.overrides)) {
    // Unknown keys (from a different app version) are inert by design.
    if (Object.prototype.hasOwnProperty.call(enMessages, key)) {
      messages[key as MessageKey] = value
    }
  }
  return {
    id: custom.id,
    languageTag: custom.languageTag,
    name: custom.name,
    englishName: custom.name,
    builtin: false,
    baseLocaleId: custom.baseLocaleId,
    messages,
  }
}

/**
 * Resolve any locale ID against the built-ins plus a custom-language list. A
 * stale ID (e.g. a deleted custom pack) falls back to the given built-in so
 * the UI always has a complete catalog.
 */
export function resolveLocaleById(
  id: string,
  customLanguages: readonly CustomLanguageData[],
  fallback: BuiltinLocaleId = 'en',
): ResolvedLocale {
  if (isBuiltinLocaleId(id)) return resolveBuiltinLocale(id)
  const custom = customLanguages.find((language) => language.id === id)
  if (custom) return resolveCustomLanguage(custom)
  return resolveBuiltinLocale(fallback)
}

/** Fraction of the catalog a custom pack translates itself, as counts. */
export function customLanguageProgress(custom: CustomLanguageData): { translated: number; total: number } {
  const keys = Object.keys(enMessages)
  let translated = 0
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(custom.overrides, key)) translated += 1
  }
  return { translated, total: keys.length }
}

export interface PlaceholderIssue {
  key: MessageKey
  expected: string[]
  found: string[]
}

/**
 * Keys whose override does not preserve the English source's `{placeholder}`
 * set. Used by the editor's save gate and surfaced as warnings on import;
 * never a hard validation failure, since the strings still render (unknown
 * tokens stay literal).
 */
export function customLanguagePlaceholderIssues(custom: CustomLanguageData): PlaceholderIssue[] {
  const issues: PlaceholderIssue[] = []
  for (const [key, value] of Object.entries(custom.overrides)) {
    if (!Object.prototype.hasOwnProperty.call(enMessages, key)) continue
    const source = enMessages[key as MessageKey]
    if (!placeholdersMatch(source, value)) {
      issues.push({
        key: key as MessageKey,
        expected: placeholderNames(source),
        found: placeholderNames(value),
      })
    }
  }
  return issues
}

export function createCustomLanguageId(): string {
  const cryptoApi = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `custom-${cryptoApi.randomUUID()}`
  }
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** A unique "Name copy"/"Name copy 2" style name for a duplicated language. */
export function duplicateLanguageName(sourceName: string, existingNames: readonly string[]): string {
  const taken = new Set(existingNames.map((name) => name.toLowerCase()))
  const base = `${sourceName} copy`.slice(0, LANGUAGE_NAME_MAX_LENGTH)
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n += 1) {
    const suffix = ` ${n}`
    const candidate = `${sourceName} copy`.slice(0, LANGUAGE_NAME_MAX_LENGTH - suffix.length) + suffix
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * Duplicate any resolved locale into a new editable custom pack. Duplicating
 * a built-in starts with no overrides (its translations come from the base),
 * so "duplicate English" is the blank starting point for a brand-new
 * language and "duplicate 简体中文" starts from complete Chinese.
 */
export function duplicateLocaleAsCustom(
  source: ResolvedLocale,
  customLanguages: readonly CustomLanguageData[],
  existingNames: readonly string[],
): CustomLanguageData {
  const sourceCustom = source.builtin
    ? null
    : customLanguages.find((language) => language.id === source.id) ?? null
  return {
    schemaVersion: CUSTOM_LANGUAGE_SCHEMA_VERSION,
    id: createCustomLanguageId(),
    name: duplicateLanguageName(source.name, existingNames),
    languageTag: source.languageTag,
    baseLocaleId: source.baseLocaleId,
    overrides: sourceCustom ? { ...sourceCustom.overrides } : {},
  }
}

export const LANGUAGE_EXPORT_FORMAT = 'purecutcnc-language'

interface LanguageExportEnvelope {
  format: typeof LANGUAGE_EXPORT_FORMAT
  schemaVersion: typeof CUSTOM_LANGUAGE_SCHEMA_VERSION
  language: CustomLanguageData
}

export function serializeLanguageExport(language: CustomLanguageData): string {
  const envelope: LanguageExportEnvelope = {
    format: LANGUAGE_EXPORT_FORMAT,
    schemaVersion: CUSTOM_LANGUAGE_SCHEMA_VERSION,
    language,
  }
  return JSON.stringify(envelope, null, 2)
}

/**
 * Parse and validate an imported language JSON file. The imported pack keeps
 * its translations but always receives a fresh local ID so it can never
 * collide with an existing language.
 */
export function parseLanguageImport(json: string): LanguageValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { error: 'Not a valid JSON file.' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Language file must contain a JSON object.' }
  }
  const record = parsed as Record<string, unknown>
  if (record.format !== LANGUAGE_EXPORT_FORMAT) {
    return { error: `Not a PureCutCNC language file (missing "format": "${LANGUAGE_EXPORT_FORMAT}").` }
  }
  if (record.schemaVersion !== CUSTOM_LANGUAGE_SCHEMA_VERSION) {
    return {
      error: `Unsupported language schema version: ${String(record.schemaVersion)}. This app supports version ${CUSTOM_LANGUAGE_SCHEMA_VERSION}.`,
    }
  }
  const validated = validateCustomLanguage(record.language)
  if (validated.error !== undefined) return validated
  return { ok: { ...validated.ok, id: createCustomLanguageId() } }
}
