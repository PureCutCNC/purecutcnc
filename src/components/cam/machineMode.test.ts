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
 * Issue #960 slice A: the derived machine mode and the CAM offers that follow it.
 *
 * Run with: npx tsx src/components/cam/machineMode.test.ts
 */

import assert from 'node:assert/strict'
import {
  libraryEntryOffered,
  machineMode,
  operationCutOnMachine,
  operationOffer,
  selectableToolTypes,
  showsFaceSwitch,
  showsMillingAuthoring,
  uncutOperationCount,
  type MachineMode,
} from './machineMode'
import { BUNDLED_DEFINITIONS } from '../../engine/gcode/definitions'
import type { MachineDefinition } from '../../engine/gcode/types'
import { newProject, type Operation, type Project, type ToolType } from '../../types/project'

function bundled(id: string): MachineDefinition {
  const definition = BUNDLED_DEFINITIONS.find((candidate) => candidate.id === id)
  assert(definition !== undefined, `expected the bundled ${id} definition`)
  return definition
}

function projectWithMachine(definition: MachineDefinition | null, selectedId?: string): Project {
  const project = newProject('mode', 'mm')
  return {
    ...project,
    meta: {
      ...project.meta,
      machineDefinitions: definition ? [definition] : [],
      selectedMachineId: selectedId ?? definition?.id ?? null,
    },
  }
}

const ROUTER = bundled('generic')
const QTPLASMAC = bundled('qtplasmac')
const GRBL_PLASMA = bundled('grbl-plasma')

function testMachineModeDerived(): void {
  assert(machineMode(projectWithMachine(null)) === 'router', 'no machine selected is a router project')
  assert(machineMode(projectWithMachine(ROUTER)) === 'router', 'a definition without machineKind is a router')
  assert(machineMode(projectWithMachine({ ...ROUTER, machineKind: 'router' })) === 'router', 'an explicit router is a router')
  assert(machineMode(projectWithMachine(QTPLASMAC)) === 'plasma', 'qtplasmac is a plasma machine')
  assert(machineMode(projectWithMachine(GRBL_PLASMA)) === 'plasma', 'grbl-plasma is a plasma machine')
  assert(
    machineMode(projectWithMachine(ROUTER, 'no-such-machine')) === 'router',
    'a selectedMachineId matching no embedded definition is a router',
  )
}

function testOperationOffer(): void {
  const kinds: Operation['kind'][] = ['plasma_profile', 'pocket', 'v_carve', 'edge_route_outside', 'drilling']
  for (const kind of kinds) {
    // plasma mode: only the plasma operation is offered.
    assert(
      operationOffer('plasma', kind) === (kind === 'plasma_profile' ? 'available' : 'hidden'),
      `plasma mode offer for ${kind}`,
    )
    // router mode: milling kinds are offered, plasma_profile says what it needs.
    assert(
      operationOffer('router', kind) === (kind === 'plasma_profile' ? 'needs-plasma-machine' : 'available'),
      `router mode offer for ${kind}`,
    )
  }
}

function testOperationCutOnMachine(): void {
  for (const mode of ['router', 'plasma'] as const) {
    assert(operationCutOnMachine(mode, 'plasma_profile') === (mode === 'plasma'), `${mode}: plasma_profile`)
    assert(operationCutOnMachine(mode, 'pocket') === (mode === 'router'), `${mode}: pocket`)
    assert(operationCutOnMachine(mode, 'follow_line') === (mode === 'router'), `${mode}: follow_line`)
  }
}

function testUncutOperationCount(): void {
  const operations: Pick<Operation, 'kind' | 'enabled'>[] = [
    { kind: 'plasma_profile', enabled: true },
    { kind: 'plasma_profile', enabled: false },
    { kind: 'pocket', enabled: true },
    { kind: 'pocket', enabled: false },
  ]

  // Plasma mode cannot cut the enabled pocket; the disabled plasma profile is not counted.
  assert(uncutOperationCount('plasma', operations) === 1, 'plasma mode counts the one enabled milling operation')
  // Router mode cannot cut the enabled plasma profile; the disabled one is not counted.
  assert(uncutOperationCount('router', operations) === 1, 'router mode counts the one enabled plasma operation')
  assert(uncutOperationCount('plasma', []) === 0, 'no operations means nothing uncut')
  assert(
    uncutOperationCount('plasma', [{ kind: 'pocket', enabled: false }]) === 0,
    'a disabled operation is never counted',
  )
}

function testSelectableToolTypes(): void {
  const milling: ToolType[] = ['flat_endmill', 'ball_endmill', 'v_bit', 'drill']
  const all: ToolType[] = [...milling, 'plasma']

  assert.deepEqual(selectableToolTypes('plasma'), ['plasma'], 'plasma, no current tool')
  assert.deepEqual(selectableToolTypes('plasma', 'plasma'), ['plasma'], 'plasma, current torch')
  assert.deepEqual(selectableToolTypes('plasma', 'flat_endmill'), ['flat_endmill', 'plasma'], 'plasma, current flat endmill')
  assert.deepEqual(selectableToolTypes('plasma', 'v_bit'), ['v_bit', 'plasma'], 'plasma, current v-bit keeps canonical order')
  assert.deepEqual(selectableToolTypes('plasma', 'drill'), ['drill', 'plasma'], 'plasma, current drill')

  assert.deepEqual(selectableToolTypes('router'), milling, 'router, no current tool')
  assert.deepEqual(selectableToolTypes('router', 'ball_endmill'), milling, 'router, current milling tool')
  assert.deepEqual(selectableToolTypes('router', 'plasma'), all, 'router, current torch stays selectable')
}

function testLibraryEntryOffered(): void {
  const types: ToolType[] = ['flat_endmill', 'ball_endmill', 'v_bit', 'drill', 'plasma']
  for (const type of types) {
    assert(libraryEntryOffered('plasma', type) === (type === 'plasma'), `plasma library offer for ${type}`)
    assert(libraryEntryOffered('router', type) === (type !== 'plasma'), `router library offer for ${type}`)
  }
}

function testFaceSwitchAndMillingAuthoring(): void {
  assert(showsFaceSwitch('router', false) === true, 'router always shows the face switch')
  assert(showsFaceSwitch('router', true) === true, 'router shows the face switch with both faces')
  assert(showsFaceSwitch('plasma', false) === false, 'plasma hides the face switch for a single-face project')
  assert(showsFaceSwitch('plasma', true) === true, 'plasma keeps the face switch when both faces carry content')

  assert(showsMillingAuthoring('router') === true, 'router authors milling work')
  assert(showsMillingAuthoring('plasma') === false, 'plasma does not author milling work')
}

function testModesAreExhaustive(): void {
  const modes: MachineMode[] = ['router', 'plasma']
  assert.deepEqual(modes, ['router', 'plasma'], 'both modes are covered above')
}

testMachineModeDerived()
testOperationOffer()
testOperationCutOnMachine()
testUncutOperationCount()
testSelectableToolTypes()
testLibraryEntryOffered()
testFaceSwitchAndMillingAuthoring()
testModesAreExhaustive()

console.log('machineMode tests passed')
