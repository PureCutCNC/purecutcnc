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

import { interpolate, placeholderNames, placeholdersMatch, pluralVariant } from './catalog'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// Interpolation
assert(interpolate('Hello') === 'Hello', 'no params is identity')
assert(interpolate('Hello {name}', { name: 'CNC' }) === 'Hello CNC', 'named param replaced')
assert(interpolate('{count} modes', { count: 3 }) === '3 modes', 'numeric param inserted verbatim')
assert(interpolate('{count}/{count}', { count: 2 }) === '2/2', 'repeated token replaced everywhere')
assert(interpolate('Hi {name}', {}) === 'Hi {name}', 'missing param leaves token visible')
assert(interpolate('Hi {name}', { other: 'x' }) === 'Hi {name}', 'unrelated params leave token visible')
assert(interpolate('缩放 {count} 项', { count: 10 }) === '缩放 10 项', 'CJK templates interpolate')

// Placeholder extraction and parity
assert(placeholderNames('a {b} c {a} {b}').join(',') === 'a,b', 'names are unique and sorted')
assert(placeholderNames('none').length === 0, 'no placeholders yields empty list')
assert(placeholdersMatch('Hi {name}', '你好{name}'), 'same set matches')
assert(!placeholdersMatch('Hi {name}', '你好'), 'dropped placeholder fails parity')
assert(!placeholdersMatch('Hi {name}', '你好{Name}'), 'case-different placeholder fails parity')
assert(!placeholdersMatch('Hi', 'Hi {extra}'), 'invented placeholder fails parity')

// Plural variants
assert(pluralVariant('en', 1) === 'one', 'English 1 is one')
assert(pluralVariant('en', 0) === 'other', 'English 0 is other')
assert(pluralVariant('en', 2) === 'other', 'English 2 is other')
assert(pluralVariant('zh-CN', 1) === 'other', 'Chinese has no grammatical plural')
assert(pluralVariant('zh-CN', 5) === 'other', 'Chinese counts stay other')
assert(pluralVariant('not a tag!', 1) === 'one', 'invalid tag falls back to English rules')

console.log('i18n catalog tests passed')
