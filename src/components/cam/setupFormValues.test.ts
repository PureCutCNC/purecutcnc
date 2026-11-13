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
 * The values the setup properties dialog compares before enabling Save
 * (issue #1112 F4): only what Save actually writes on that face, with the name
 * normalised the way `updateSetup` stores it.
 *
 * Run with: npx tsx src/components/cam/setupFormValues.test.ts
 */

import assert from 'node:assert/strict'
import type { MachiningSetup } from '../../types/project'
import { setupFormValues } from './setupFormValues'

const top: MachiningSetup = {
  id: 'setup-top',
  name: 'Top',
  orientation: { axis: 'x', angleDeg: 0 },
  indexing: 'manual',
  registration: [],
  notes: '',
  operationIds: [],
}
const bottom: MachiningSetup = {
  ...top,
  id: 'setup-bottom',
  name: 'Bottom',
  orientation: { axis: 'y', angleDeg: 180 },
  registration: [{ id: 'registration-1', kind: 'dowel', target: { type: 'point', point: { x: 10, y: 5 } } }],
  notes: 'Seat on the pins',
}
const around: MachiningSetup = {
  ...top,
  id: 'setup-around',
  kind: 'around',
  name: 'Around',
  registration: [{ id: 'registration-1', kind: 'dowel', target: { type: 'point', point: { x: 10, y: 5 } } }],
}

// A flat setup writes its flip axis and its registration references.
assert.deepEqual(
  setupFormValues(bottom, 'bottom'),
  {
    name: 'Bottom',
    notes: 'Seat on the pins',
    flipAxis: 'y',
    registration: [{ id: 'registration-1', kind: 'dowel', target: { type: 'point', point: { x: 10, y: 5 } } }],
  },
  'a flat setup carries its name, notes, flip axis and references',
)

// An Around setup writes only its name and notes, so nothing it does not store
// can be reported as a change (issue #395).
assert.deepEqual(setupFormValues(around, 'around'), { name: 'Around', notes: '' }, 'Around carries only name and notes')

// The name is trimmed, because that is what `updateSetup` stores.
assert.deepEqual(
  setupFormValues({ ...top, name: '  Top  ' }, 'top'),
  { name: 'Top', notes: '', flipAxis: 'x', registration: [] },
  'a whitespace-only difference in the name is not a stored change',
)

// The returned shape is the dialog's own: later edits to the source array are
// not needed for comparison, but re-reading it must give the same values.
const source = { ...bottom }
assert.deepEqual(setupFormValues(source, 'bottom'), setupFormValues({ ...bottom }, 'bottom'), 'the shape is stable')

console.log('setup form value tests passed')
