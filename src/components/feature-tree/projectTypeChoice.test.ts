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
 * Issue #1028 slice B: the Project type UI's pure helpers — the type's label
 * keys and the machine picker's grouping and option order.
 *
 * Run with: npx tsx src/components/feature-tree/projectTypeChoice.test.ts
 */

import assert from 'node:assert/strict'
import { BUNDLED_DEFINITIONS } from '../../engine/gcode/definitions'
import { validateMachineDefinition, type MachineDefinition } from '../../engine/gcode/types'
import {
  PROJECT_TYPES,
  groupMachinesForProjectType,
  machineOptionsForType,
  projectTypeLabelKey,
} from './projectTypeChoice'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   \u2713 ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.log(`   \u2717 ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function bundled(id: string): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  assert.ok(found, `bundled definition ${id} exists`)
  return validateMachineDefinition(structuredClone(found))
}

const PLASMA = bundled('qtplasmac')
const ROUTER = validateMachineDefinition({ ...bundled('generic'), id: 'plain-router', name: 'Plain router' })
const ROTARY_ROUTER = validateMachineDefinition({
  ...bundled('generic'),
  id: 'rotary-router',
  name: 'Rotary router',
  rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
})

console.log('\nProject type UI (issue #1028)')

test('every type has its own label key', () => {
  assert.deepEqual(PROJECT_TYPES, ['milling', 'plasma', 'rotary'], 'the picker order is fixed')
  assert.equal(projectTypeLabelKey('milling'), 'featureTree.properties.projectType.milling', 'milling key')
  assert.equal(projectTypeLabelKey('plasma'), 'featureTree.properties.projectType.plasma', 'plasma key')
  assert.equal(projectTypeLabelKey('rotary'), 'featureTree.properties.projectType.rotary', 'rotary key')
})

test('machines that suit the type come first, the rest keep candidate order', () => {
  const groups = groupMachinesForProjectType([PLASMA, ROUTER, ROTARY_ROUTER], 'rotary')
  assert.deepEqual(groups.matching.map((definition) => definition.id), ['rotary-router'], 'only the rotary-capable router suits rotary')
  assert.deepEqual(groups.other.map((definition) => definition.id), ['qtplasmac', 'plain-router'], 'the rest keep candidate order')

  const milling = groupMachinesForProjectType([PLASMA, ROUTER, ROTARY_ROUTER], 'milling')
  assert.deepEqual(milling.matching.map((definition) => definition.id), ['plain-router', 'rotary-router'], 'any router suits milling')
  assert.deepEqual(milling.other.map((definition) => definition.id), ['qtplasmac'], 'a plasma machine does not')

  const plasma = groupMachinesForProjectType([PLASMA, ROUTER], 'plasma')
  assert.deepEqual(plasma.matching.map((definition) => definition.id), ['qtplasmac'], 'only a plasma machine suits plasma')
  assert.deepEqual(plasma.other.map((definition) => definition.id), ['plain-router'], 'the router is the other group')
})

test('the machine options are None, the type machines, then the rest under the group label', () => {
  const options = machineOptionsForType([PLASMA, ROUTER, ROTARY_ROUTER], 'rotary', 'None', 'Other machines')
  assert.deepEqual(
    options.map((option) => [option.value, option.group ?? null]),
    [['', null], ['rotary-router', null], ['qtplasmac', 'Other machines'], ['plain-router', 'Other machines']],
    'None first, then the matching machines unlabelled, then the others',
  )
  assert.deepEqual(options.map((option) => option.label), ['None', ROTARY_ROUTER.name, PLASMA.name, ROUTER.name], 'the labels are the machines\' names')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
