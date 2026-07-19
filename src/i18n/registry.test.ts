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

import { placeholdersMatch } from './catalog'
import { enMessages, type MessageKey } from './locales/en'
import { fr } from './locales/fr'
import { zhCN } from './locales/zh-CN'
import {
  CUSTOM_LANGUAGE_SCHEMA_VERSION,
  customLanguagePlaceholderIssues,
  customLanguageProgress,
  duplicateLocaleAsCustom,
  parseLanguageImport,
  resolveBuiltinLocale,
  resolveCustomLanguage,
  resolveLocaleById,
  serializeLanguageExport,
  validateCustomLanguage,
  type CustomLanguageData,
} from './registry'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ---------------------------------------------------------------------------
// Built-in catalog contracts
// ---------------------------------------------------------------------------

const enKeys = Object.keys(enMessages) as MessageKey[]
assert(enKeys.length > 0, 'English catalog is non-empty')

// Built-in overlays ship complete: every English key has a localized entry
// (the type enforces this at compile time; this guards the runtime merge too).
for (const [localeName, locale] of [['fr', fr], ['zh-CN', zhCN]] as const) {
  for (const key of enKeys) {
    const value = locale[key]
    assert(typeof value === 'string' && value !== '', `${localeName} has a value for ${key}`)
  }
}

// Placeholder parity: every built-in translation preserves its English set.
for (const [localeName, locale] of [['fr', fr], ['zh-CN', zhCN]] as const) {
  for (const key of enKeys) {
    assert(
      placeholdersMatch(enMessages[key], locale[key]),
      `${localeName} preserves placeholders of ${key}`,
    )
  }
}

const builtinEn = resolveBuiltinLocale('en')
assert(builtinEn.languageTag === 'en' && builtinEn.builtin, 'en resolves as built-in')
const builtinFr = resolveBuiltinLocale('fr')
assert(builtinFr.languageTag === 'fr', 'fr carries its BCP-47 tag')
assert(builtinFr.name === 'Français', 'fr presents its native name')
assert(builtinFr.messages['file.saveProject'] === fr['file.saveProject'], 'fr resolution uses French strings')
const builtinZh = resolveBuiltinLocale('zh-CN')
assert(builtinZh.languageTag === 'zh-CN', 'zh-CN carries its BCP-47 tag')
assert(builtinZh.name === '简体中文', 'zh-CN presents its native name')
assert(builtinZh.messages['file.saveProject'] === zhCN['file.saveProject'], 'zh-CN resolution uses Chinese strings')

// ---------------------------------------------------------------------------
// Custom-language validation
// ---------------------------------------------------------------------------

const validPack: CustomLanguageData = {
  schemaVersion: CUSTOM_LANGUAGE_SCHEMA_VERSION,
  id: 'custom-test',
  name: 'Testish',
  languageTag: 'de',
  baseLocaleId: 'en',
  overrides: { 'file.saveProject': 'Projekt speichern' },
}

assert(validateCustomLanguage(validPack).ok !== undefined, 'valid pack validates')
assert(validateCustomLanguage(null).error !== undefined, 'null rejects')
assert(validateCustomLanguage({ ...validPack, extra: 1 }).error !== undefined, 'unknown property rejects')
assert(validateCustomLanguage({ ...validPack, schemaVersion: 99 }).error !== undefined, 'wrong schema version rejects')
assert(validateCustomLanguage({ ...validPack, id: ' ' }).error !== undefined, 'blank id rejects')
assert(validateCustomLanguage({ ...validPack, name: '' }).error !== undefined, 'blank name rejects')
assert(validateCustomLanguage({ ...validPack, name: 'x'.repeat(61) }).error !== undefined, 'over-long name rejects')
assert(validateCustomLanguage({ ...validPack, languageTag: 'not a tag!' }).error !== undefined, 'invalid tag rejects')
assert(validateCustomLanguage({ ...validPack, languageTag: 'pt-BR' }).ok !== undefined, 'region tag accepted')
assert(validateCustomLanguage({ ...validPack, baseLocaleId: 'es' }).error !== undefined, 'unknown base rejects')
assert(validateCustomLanguage({ ...validPack, overrides: { k: 5 } }).error !== undefined, 'non-string override rejects')

// Empty-string overrides mean "untranslated" and are dropped on validation.
const withEmpty = validateCustomLanguage({ ...validPack, overrides: { 'file.undo': '', 'file.redo': '重做' } })
assert(withEmpty.ok !== undefined, 'empty-string override is tolerated')
assert(!('file.undo' in withEmpty.ok!.overrides), 'empty-string override is dropped')
assert(withEmpty.ok!.overrides['file.redo'] === '重做', 'non-empty override survives')

// Unknown override keys are kept: packs are version-skewed across app
// releases by design and must round-trip without shedding translations.
const withUnknown = validateCustomLanguage({
  ...validPack,
  overrides: { 'future.key.not.in.this.build': 'Zukunft' },
})
assert(withUnknown.ok !== undefined, 'unknown override key validates')
assert(withUnknown.ok!.overrides['future.key.not.in.this.build'] === 'Zukunft', 'unknown override key is preserved')

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const zhBased: CustomLanguageData = {
  ...validPack,
  id: 'custom-zh-based',
  baseLocaleId: 'zh-CN',
  overrides: { 'file.saveProject': '存盘', 'unknown.key': 'x' },
}
const resolvedCustom = resolveCustomLanguage(zhBased)
assert(resolvedCustom.messages['file.saveProject'] === '存盘', 'override wins over base')
assert(resolvedCustom.messages['file.undo'] === zhCN['file.undo'], 'base built-in fills unoverridden keys')
assert(!resolvedCustom.builtin, 'custom resolution is marked custom')
assert(resolvedCustom.name === 'Testish', 'custom pack shows its own name')

const enBased = resolveCustomLanguage({ ...validPack, id: 'custom-en-based' })
assert(enBased.messages['file.undo'] === enMessages['file.undo'], 'en-based pack falls back to English')

assert(resolveLocaleById('zh-CN', []).id === 'zh-CN', 'built-in id resolves')
assert(resolveLocaleById('custom-zh-based', [zhBased]).id === 'custom-zh-based', 'custom id resolves')
assert(resolveLocaleById('gone', [zhBased]).id === 'en', 'stale id falls back to English')

// ---------------------------------------------------------------------------
// Progress, placeholder issues, duplication
// ---------------------------------------------------------------------------

const progress = customLanguageProgress(zhBased)
assert(progress.total === enKeys.length, 'progress total is the catalog size')
assert(progress.translated === 1, 'unknown keys do not count as translated')

const issues = customLanguagePlaceholderIssues({
  ...validPack,
  overrides: {
    'platform.readFileError': 'kaputt', // drops {name}
    'file.undo': 'Rückgängig',
    'unknown.key': 'ignored',
  },
})
assert(issues.length === 1 && issues[0].key === 'platform.readFileError', 'placeholder drop is reported')
assert(issues[0].expected.join(',') === 'name', 'issue lists expected placeholders')

const dupOfBuiltin = duplicateLocaleAsCustom(builtinZh, [], ['简体中文'])
assert(dupOfBuiltin.baseLocaleId === 'zh-CN', 'duplicating a built-in keeps it as base')
assert(Object.keys(dupOfBuiltin.overrides).length === 0, 'duplicating a built-in starts with no overrides')
assert(dupOfBuiltin.name === '简体中文 copy', 'duplicate gets a copy name')

const dupOfCustom = duplicateLocaleAsCustom(resolvedCustom, [zhBased], ['Testish'])
assert(dupOfCustom.overrides['file.saveProject'] === '存盘', 'duplicating a custom copies its overrides')
assert(dupOfCustom.id !== zhBased.id, 'duplicate gets a fresh id')

// ---------------------------------------------------------------------------
// Import/export envelope
// ---------------------------------------------------------------------------

const exported = serializeLanguageExport(zhBased)
const reimported = parseLanguageImport(exported)
assert(reimported.ok !== undefined, 'export round-trips through import')
assert(reimported.ok!.id !== zhBased.id, 'import always assigns a fresh id')
assert(reimported.ok!.overrides['file.saveProject'] === '存盘', 'import keeps translations')
assert(reimported.ok!.overrides['unknown.key'] === 'x', 'import keeps version-skewed keys')

assert(parseLanguageImport('not json').error !== undefined, 'non-JSON rejects')
assert(parseLanguageImport('[]').error !== undefined, 'non-object rejects')
assert(parseLanguageImport('{"format":"other"}').error !== undefined, 'wrong format rejects')
assert(
  parseLanguageImport(JSON.stringify({ format: 'purecutcnc-language', schemaVersion: 99, language: validPack }))
    .error !== undefined,
  'wrong envelope version rejects',
)

console.log('i18n registry tests passed')
