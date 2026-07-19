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

import { CUSTOM_LANGUAGE_SCHEMA_VERSION, type CustomLanguageData } from './registry'
import {
  detectLocaleIdFromNavigator,
  readStoredCustomLanguages,
  readStoredLocaleId,
  resolveInitialLocaleId,
  sanitizeStoredCustomLanguages,
} from './selection'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const pack: CustomLanguageData = {
  schemaVersion: CUSTOM_LANGUAGE_SCHEMA_VERSION,
  id: 'custom-a',
  name: 'A',
  languageTag: 'de',
  baseLocaleId: 'en',
  overrides: {},
}

// Navigator detection
assert(detectLocaleIdFromNavigator(['zh-CN']) === 'zh-CN', 'zh-CN matches')
assert(detectLocaleIdFromNavigator(['zh']) === 'zh-CN', 'bare zh prefers Simplified')
assert(detectLocaleIdFromNavigator(['zh-Hans-SG']) === 'zh-CN', 'Hans script matches Simplified')
assert(detectLocaleIdFromNavigator(['zh-TW']) === 'en', 'explicit Traditional region stays English')
assert(detectLocaleIdFromNavigator(['zh-Hant']) === 'en', 'explicit Traditional script stays English')
assert(detectLocaleIdFromNavigator(['zh-TW', 'zh-CN']) === 'zh-CN', 'later Simplified entry still matches')
assert(detectLocaleIdFromNavigator(['fr-FR', 'zh-CN']) === 'zh-CN', 'unsupported first entry keeps scanning')
assert(detectLocaleIdFromNavigator(['fr-FR', 'en-GB']) === 'en', 'English variant matches')
assert(detectLocaleIdFromNavigator(['de']) === 'en', 'no match falls back to English')
assert(detectLocaleIdFromNavigator([]) === 'en', 'empty list falls back to English')

// Initial resolution: stored explicit choice wins when it still resolves.
assert(resolveInitialLocaleId('zh-CN', [], ['en-US']) === 'zh-CN', 'stored built-in wins over navigator')
assert(resolveInitialLocaleId('custom-a', [pack], ['zh-CN']) === 'custom-a', 'stored custom pack wins')
assert(resolveInitialLocaleId('custom-gone', [], ['zh-CN']) === 'zh-CN', 'stale stored id falls back to detection')
assert(resolveInitialLocaleId(null, [], ['zh-CN']) === 'zh-CN', 'no stored choice detects')
assert(resolveInitialLocaleId('junk!', [], []) === 'en', 'garbage stored id lands on English')

// Stored custom list sanitization
const sanitized = sanitizeStoredCustomLanguages([
  pack,
  { ...pack, id: 'custom-a' }, // duplicate id dropped
  { ...pack, id: 'en' }, // built-in collision dropped
  { bogus: true }, // invalid dropped
  'not even an object',
  { ...pack, id: 'custom-b', name: 'B' },
])
assert(sanitized.length === 2, 'only valid unique entries survive')
assert(sanitized[0].id === 'custom-a' && sanitized[1].id === 'custom-b', 'surviving entries keep order')
assert(sanitizeStoredCustomLanguages('junk').length === 0, 'non-array input yields empty list')

// Storage readers never throw
const throwing = { getItem: () => { throw new Error('disabled') } }
assert(readStoredLocaleId(throwing) === null, 'storage errors read as no stored locale')
assert(readStoredCustomLanguages(throwing).length === 0, 'storage errors read as no custom packs')
assert(readStoredLocaleId(null) === null, 'missing storage reads as no stored locale')
assert(
  readStoredCustomLanguages({ getItem: () => '{"not":"an array"}' }).length === 0,
  'corrupt stored list reads as empty',
)

console.log('i18n selection tests passed')
