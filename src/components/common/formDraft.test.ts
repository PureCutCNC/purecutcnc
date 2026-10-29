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
 * A form's Save/Apply gate compares by value (issue #1112 F4). A draft rebuilt
 * on every keystroke holds fresh arrays and objects, so only a value comparison
 * can tell an untouched form from an edited one — and only that keeps Save
 * disabled until something really differs.
 *
 * Run with: npx tsx src/components/common/formDraft.test.ts
 */

import assert from 'node:assert/strict'
import { formHasChanges } from './formDraft'

// Primitives, including the two cases `===` gets wrong for form values.
assert.equal(formHasChanges('Top', 'Top'), false, 'the same text is unchanged')
assert.equal(formHasChanges('Top', 'Bottom'), true, 'changed text is a change')
assert.equal(formHasChanges(12, 12), false, 'the same number is unchanged')
assert.equal(formHasChanges(0, -0), false, '0 and -0 are the same value')
assert.equal(formHasChanges(Number.NaN, Number.NaN), false, 'NaN compared with NaN is unchanged')
assert.equal(formHasChanges(undefined, undefined), false, 'two absent values are unchanged')
assert.equal(formHasChanges(undefined, null), true, 'an absent value and null differ')
assert.equal(formHasChanges('12', 12), true, 'a typed string is not the stored number: the form normalises first')

// Objects and arrays compare by value, so a rebuilt draft is not a change.
const reference = { id: 'registration-1', kind: 'dowel', target: { type: 'point', point: { x: 10, y: 5 } } }
const rebuilt = { id: 'registration-1', kind: 'dowel', target: { type: 'point', point: { x: 10, y: 5 } } }
assert.notEqual(reference, rebuilt, 'the fixture is a distinct object, as a draft would be')
assert.equal(formHasChanges([reference], [rebuilt]), false, 'equal objects are unchanged, not different by reference')
assert.equal(formHasChanges([reference], []), true, 'a removed reference is a change')
assert.equal(formHasChanges([], [rebuilt]), true, 'an added reference is a change')
const other = { id: 'registration-2', kind: 'fence', target: { type: 'point', point: { x: 0, y: 0 } } }
assert.equal(formHasChanges([reference, other], [other, reference]), true, 'reordering references is a change')
assert.equal(
  formHasChanges({ name: 'Top', notes: '' }, { notes: '', name: 'Top' }),
  false,
  'key order is not data',
)
assert.equal(
  formHasChanges({ name: 'Top' }, { name: 'Top', notes: '' }),
  true,
  'an added field is a change',
)
assert.equal(
  formHasChanges({ name: 'Top' }, { name: 'Top', notes: undefined }),
  true,
  'an absent key is not the same as an undefined one',
)
assert.equal(
  formHasChanges({ target: { point: { x: 10, y: 5 } } }, { target: { point: { x: 10, y: 5.0001 } } }),
  true,
  'a nested value is compared to the leaf',
)
assert.equal(formHasChanges([[1, 2], [3]], [[1, 2], [3]]), false, 'nested arrays compare by value')
assert.equal(formHasChanges([[1, 2], [3]], [[3], [1, 2]]), true, 'nested array order is data')

// Only plain data is compared field by field; anything else is a change unless
// it is the very same value (a draft never holds two equal class instances).
class Marker {
  value = 1
}
assert.equal(formHasChanges(new Marker(), new Marker()), true, 'separate non-plain objects differ')
const shared = new Marker()
assert.equal(formHasChanges({ marker: shared }, { marker: shared }), false, 'the same object is unchanged')

console.log('form draft tests passed')
