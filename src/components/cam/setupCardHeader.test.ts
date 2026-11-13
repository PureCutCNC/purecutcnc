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
 * What one setup card's header reads (issue #1102): the face name, the
 * operation count and the short program chip, whether the missing-registration
 * warning shows, and whether the card is the one-row empty form.
 *
 * The rule lives here rather than only in the component so the wording — and
 * what no longer appears — is testable without rendering the panel.
 *
 * Run with: npx tsx src/components/cam/setupCardHeader.test.ts
 */

import { setupCardHeader } from './setupSections'
import type { CamSetupSection } from './setupSections'
import { camT } from './camI18n'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { defaultTopSetup, newProject } from '../../types/project'
import type { MachiningSetup, Operation, SetupFace } from '../../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  )
}

/** Real operations of the right shape; only their length reaches the header. */
function operations(count: number): Operation[] {
  const project = newProject('setup card header', 'mm')
  return Array.from({ length: count }, (_, index) =>
    defaultOperationForTarget(project, 'pocket', 'rough', { source: 'features', featureIds: [] }, index))
}

function cardSection(face: SetupFace, overrides: Partial<CamSetupSection> = {}): CamSetupSection {
  const setup: MachiningSetup = face === 'around'
    ? {
        id: 'su-around', kind: 'around', name: 'Around',
        orientation: { axis: 'x', angleDeg: 0 }, indexing: 'manual', registration: [], notes: '', operationIds: [],
      }
    : face === 'bottom'
      ? {
          id: 'su-bottom', name: 'Back machining',
          orientation: { axis: 'x', angleDeg: 180 }, indexing: 'manual', registration: [], notes: '', operationIds: [],
        }
      : defaultTopSetup()
  return {
    setup,
    face,
    programNumber: 1,
    active: false,
    operations: [],
    flipAxis: null,
    registrationCount: 0,
    registrationMissing: false,
    ...overrides,
  }
}

function testTop(): void {
  console.log('Testing a Top card: name, count and the short program chip...')
  const header = setupCardHeader(cardSection('top', { operations: operations(2), programNumber: 1 }), camT)
  assertEqual(header, {
    label: camT('cam.setup.top'),
    ariaLabel: `${camT('cam.setup.topOperations')} 2 ${camT('cam.setup.programFull', { number: '01' })}`,
    programChip: camT('cam.setup.program', { number: '01' }),
    warn: false,
    empty: false,
  }, 'a Top card with two operations')
  // The longer wording stays the accessible name, which the browser specs match.
  assert(header.ariaLabel.startsWith(camT('cam.setup.topOperations')), 'the accessible name keeps the "Top operations" wording')
  assertEqual(header.programChip, 'P01', 'the chip is the short form')
}

function testBottomWarns(): void {
  console.log('Testing a Bottom card warns when its registration is missing...')
  const header = setupCardHeader(cardSection('bottom', {
    operations: operations(1),
    programNumber: 2,
    registrationMissing: true,
    registrationCount: 0,
  }), camT)
  assertEqual(header.label, camT('cam.setup.bottom'), 'the label is the face name, not the setup name')
  assertEqual([header.warn, header.empty], [true, false], 'a second setup with no registration warns')
  assertEqual(header.programChip, 'P02', 'the chip is the setup\'s program number')

  const registered = setupCardHeader(cardSection('bottom', { operations: operations(1), programNumber: 2 }), camT)
  assertEqual(registered.warn, false, 'a declared registration does not warn')
}

function testAround(): void {
  console.log('Testing an Around card: the setup\'s own name, never the registration warning...')
  const around = cardSection('around', { operations: operations(1) })
  around.setup = { ...around.setup, name: 'Bar side' }
  const header = setupCardHeader({ ...around, registrationMissing: true }, camT)
  assertEqual(header.label, 'Bar side', 'the visible name is the setup\'s own name')
  assertEqual([header.warn, header.empty], [false, false], 'an Around setup never warns about registration')
}

function testEmpty(): void {
  console.log('Testing an empty setup is the one-row form...')
  const header = setupCardHeader(cardSection('bottom', { programNumber: 2 }), camT)
  assertEqual([header.empty, header.warn], [true, false], 'no operations: empty, with nothing to warn about')
  assertEqual(header.label, camT('cam.setup.bottom'), 'the empty row still names the face')
}

function testProgramPadding(): void {
  console.log('Testing the program number pads to two digits...')
  const chip = (programNumber: number) => setupCardHeader(cardSection('top', { programNumber }), camT).programChip
  assertEqual(chip(1), 'P01', 'program 1')
  assertEqual(chip(9), 'P09', 'program 9')
  assertEqual(chip(12), 'P12', 'program 12 is not padded past two digits')
}

testTop()
testBottomWarns()
testAround()
testEmpty()
testProgramPadding()

console.log('setup card header tests passed')
