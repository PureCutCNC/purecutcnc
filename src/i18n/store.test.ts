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

import { enMessages } from './locales/en'
import { zhCN } from './locales/zh-CN'
import { CUSTOM_LANGUAGE_SCHEMA_VERSION, type CustomLanguageData } from './registry'
import { CUSTOM_LANGUAGES_STORAGE_KEY, LOCALE_STORAGE_KEY } from './selection'
import {
  deleteCustomLanguage,
  getI18nSnapshot,
  initI18nStore,
  resetI18nStoreForTests,
  saveCustomLanguage,
  setActiveLocale,
  subscribe,
  translate,
  translatePlural,
} from './store'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
  }
}

const pack: CustomLanguageData = {
  schemaVersion: CUSTOM_LANGUAGE_SCHEMA_VERSION,
  id: 'custom-test',
  name: 'Testish',
  languageTag: 'de',
  baseLocaleId: 'zh-CN',
  overrides: { 'file.saveProject': 'Projekt speichern' },
}

// Uninitialized store translates English (defensive default).
resetI18nStoreForTests()
assert(translate('file.saveProject') === enMessages['file.saveProject'], 'default store is English')

// Init restores a stored built-in choice.
resetI18nStoreForTests()
initI18nStore(makeStorage({ [LOCALE_STORAGE_KEY]: 'zh-CN' }))
assert(getI18nSnapshot().localeId === 'zh-CN', 'stored zh-CN restored')
assert(getI18nSnapshot().languageTag === 'zh-CN', 'language tag follows locale')
assert(translate('file.saveProject') === zhCN['file.saveProject'], 'translate uses active locale')

// Init restores a stored custom pack, resolving overrides > base > English.
resetI18nStoreForTests()
initI18nStore(makeStorage({
  [LOCALE_STORAGE_KEY]: 'custom-test',
  [CUSTOM_LANGUAGES_STORAGE_KEY]: JSON.stringify([pack]),
}))
assert(getI18nSnapshot().localeId === 'custom-test', 'stored custom pack restored')
assert(translate('file.saveProject') === 'Projekt speichern', 'override wins')
assert(translate('file.undo') === zhCN['file.undo'], 'base locale fills unoverridden keys')
assert(getI18nSnapshot().languageTag === 'de', 'custom pack drives the language tag')

// A stale stored id falls back cleanly.
resetI18nStoreForTests()
initI18nStore(makeStorage({ [LOCALE_STORAGE_KEY]: 'custom-gone' }))
assert(getI18nSnapshot().localeId === 'en', 'stale stored id resolves to English')

// Explicit selection persists and notifies.
resetI18nStoreForTests()
const storage = makeStorage()
initI18nStore(storage)
let notified = 0
const unsubscribe = subscribe(() => { notified += 1 })
setActiveLocale('zh-CN')
assert(storage.map.get(LOCALE_STORAGE_KEY) === 'zh-CN', 'explicit choice is persisted as the bare id')
assert(notified === 1, 'subscribers are notified once per change')
assert(translate('shell.topBar.saved') === zhCN['shell.topBar.saved'], 'translations switch immediately')
unsubscribe()
setActiveLocale('en')
assert(notified === 1, 'unsubscribed listeners stop firing')

// Plural selection follows the active locale's rules.
resetI18nStoreForTests()
initI18nStore(makeStorage())
setActiveLocale('en')
assert(
  translatePlural(1, 'shell.snap.enabledAria.one', 'shell.snap.enabledAria.other') === 'Snapping enabled (1 mode)',
  'English singular variant',
)
assert(
  translatePlural(3, 'shell.snap.enabledAria.one', 'shell.snap.enabledAria.other') === 'Snapping enabled (3 modes)',
  'English plural variant',
)
setActiveLocale('zh-CN')
assert(
  translatePlural(1, 'shell.snap.enabledAria.one', 'shell.snap.enabledAria.other') === zhCN['shell.snap.enabledAria.other'].replace('{count}', '1'),
  'Chinese always uses the other variant',
)
// German inflects: the rest-op message is locale-owned, so 2 regions must read
// "Bereichen" (dative plural), not the old interpolated English suffix
// "Bereichs". Covers one and multiple regions.
setActiveLocale('de')
assert(
  translatePlural(1, 'cam.restOp.created.one', 'cam.restOp.created.other') ===
    'Restoperation mit 1 Bereich erstellt; wählen Sie ein kleineres Werkzeug',
  'German rest-op singular uses Bereich',
)
assert(
  translatePlural(2, 'cam.restOp.created.one', 'cam.restOp.created.other') ===
    'Restoperation mit 2 Bereichen erstellt; wählen Sie ein kleineres Werkzeug',
  'German rest-op plural uses Bereichen, not the English-suffix Bereichs',
)
// French likewise inflects (région/régions) and owns its full phrase.
setActiveLocale('fr')
assert(
  translatePlural(1, 'cam.restOp.created.one', 'cam.restOp.created.other') ===
    'Opération de reprise créée avec 1 région ; choisissez un outil plus petit',
  'French rest-op singular uses région',
)
assert(
  translatePlural(2, 'cam.restOp.created.one', 'cam.restOp.created.other') ===
    'Opération de reprise créée avec 2 régions ; choisissez un outil plus petit',
  'French rest-op plural uses régions',
)

// Custom pack CRUD: save re-resolves an active pack, delete falls back to base.
resetI18nStoreForTests()
const crudStorage = makeStorage({
  [LOCALE_STORAGE_KEY]: 'custom-test',
  [CUSTOM_LANGUAGES_STORAGE_KEY]: JSON.stringify([pack]),
})
initI18nStore(crudStorage)
saveCustomLanguage({ ...pack, overrides: { 'file.saveProject': 'Speichern!' } })
assert(translate('file.saveProject') === 'Speichern!', 'editing the active pack re-resolves')
assert(
  (JSON.parse(crudStorage.map.get(CUSTOM_LANGUAGES_STORAGE_KEY) ?? '[]') as unknown[]).length === 1,
  'saving an existing pack updates in place',
)
deleteCustomLanguage('custom-test')
assert(getI18nSnapshot().localeId === 'zh-CN', 'deleting the active pack falls back to its base locale')
assert(crudStorage.map.get(LOCALE_STORAGE_KEY) === 'zh-CN', 'the fallback selection is persisted')
assert(
  (JSON.parse(crudStorage.map.get(CUSTOM_LANGUAGES_STORAGE_KEY) ?? 'null') as unknown[]).length === 0,
  'deleted pack is removed from storage',
)

// Deleting an inactive pack keeps the current selection.
resetI18nStoreForTests()
const quietStorage = makeStorage({
  [LOCALE_STORAGE_KEY]: 'en',
  [CUSTOM_LANGUAGES_STORAGE_KEY]: JSON.stringify([pack]),
})
initI18nStore(quietStorage)
deleteCustomLanguage('custom-test')
assert(getI18nSnapshot().localeId === 'en', 'deleting an inactive pack keeps the selection')
assert(quietStorage.map.get(LOCALE_STORAGE_KEY) === 'en', 'selection storage is untouched')

resetI18nStoreForTests()
console.log('i18n store tests passed')
