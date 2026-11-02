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
 * Which CAM operation is on the face the workspace is on (issue #1102). The
 * operations list shows every setup, but only the active setup's operations
 * count as selected from the face in view: an operation from the other face is
 * a ghost row, and switching face drops it from the selection without
 * forgetting it. Selecting a ghost row is still the supported route — it turns
 * the workspace over to its face (issue #1112 F3, pinned by
 * `camGhostRowSelection.test.ts`).
 *
 * The rule lives in `setupSections.ts` next to the grouping it follows, so it
 * is testable without rendering the panel. Two projects are used: one with a
 * real Top and Bottom setup (the `setupTargetHints` fixture), and the states
 * around a setup the project does not hold yet.
 *
 * Run with: npx tsx src/components/cam/operationOnActiveSetup.test.ts
 */

import { camSetupSections, operationOnActiveSetup } from './setupSections'
import { activeSetup } from '../../store/helpers/activeFace'
import { setupFace } from '../../engine/setupOrientation'
import { syncProjectSetups } from '../../store/helpers/setups'
import { provisionalSetupId } from '../../store/helpers/provisionalSetup'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { BOTTOM_SETUP_ID, withBottomSetup } from '../../test/projectFixtures'
import { DEFAULT_SETUP_ID, defaultTopSetup, newProject } from '../../types/project'
import type { MachiningSetup, Operation, OperationTarget, Project } from '../../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  )
}

const TARGET: OperationTarget = { source: 'features', featureIds: [] }

/** An operation of the project's kind and shape, with the id the test reads it by. */
function operation(project: Project, id: string, setupId?: string): Operation {
  const created = defaultOperationForTarget(project, 'pocket', 'rough', TARGET, 0)
  return { ...created, id, name: id, ...(setupId === undefined ? {} : { setupId }) }
}

/** A Top and a real Bottom setup, each with an operation moved to it. */
function twoSetups(activeFace: 'top' | 'bottom'): Project {
  const base = newProject('operation on active setup', 'mm')
  const project = withBottomSetup(
    syncProjectSetups({ ...base, operations: [operation(base, 'topOp'), operation(base, 'bottomOp')] }),
    { operationIds: ['bottomOp'] },
  )
  return activeFace === 'top' ? project : { ...project, activeSetupId: BOTTOM_SETUP_ID }
}

function find(project: Project, id: string): Operation {
  const found = project.operations.find((operation) => operation.id === id)
  if (!found) throw new Error(`fixture: no operation ${id}`)
  return found
}

function testRealSetups(): void {
  console.log('Testing Top and Bottom setups: an operation is on the one that cuts it...')
  const onTop = twoSetups('top')
  assertEqual(activeSetup(onTop).id, DEFAULT_SETUP_ID, 'fixture: the Top setup is active')
  assertEqual(operationOnActiveSetup(onTop, find(onTop, 'topOp')), true, 'Top active, a Top operation: on it')
  assertEqual(operationOnActiveSetup(onTop, find(onTop, 'bottomOp')), false, 'Top active, a Bottom operation: not on it')

  const onBottom = twoSetups('bottom')
  assertEqual(activeSetup(onBottom).id, BOTTOM_SETUP_ID, 'fixture: the Bottom setup is active')
  assertEqual(operationOnActiveSetup(onBottom, find(onBottom, 'bottomOp')), true, 'Bottom active, its own operation: on it')
  assertEqual(operationOnActiveSetup(onBottom, find(onBottom, 'topOp')), false, 'Bottom active, a Top operation: not on it')
}

function testProvisionalBottom(): void {
  console.log('Testing a Bottom setup the project does not hold yet...')
  // The workspace on a face with no setup of its own: the provisional setup is
  // the active one, and it is the first (here: the only) setup the list holds,
  // so an operation with no `setupId` reads as its own.
  const base = newProject('provisional bottom', 'mm')
  const only = operation(base, 'onlyOp')
  const project: Project = {
    ...base,
    setups: [],
    activeSetupId: provisionalSetupId('bottom'),
    operations: [only],
  }
  const active = activeSetup(project)
  assertEqual(active.id, provisionalSetupId('bottom'), 'fixture: the provisional Bottom setup is active')
  assert(!project.setups.some((setup) => setup.id === active.id), 'fixture: it is not one of the project\'s setups')
  assertEqual(camSetupSections(project).grouped, true, 'fixture: the list has its own section')
  assertEqual(operationOnActiveSetup(project, only), true, 'the operation reads as the setup in view')

  // The ordinary shape of that state: a Top setup exists and the workspace only
  // looks at Bottom. Nothing is assigned to the provisional setup, so the Top
  // operation is not on it.
  const topOnly = syncProjectSetups({ ...base, operations: [operation(base, 'topOp')] })
  const lookingAtBottom: Project = { ...topOnly, activeSetupId: provisionalSetupId('bottom') }
  assertEqual(operationOnActiveSetup(lookingAtBottom, find(lookingAtBottom, 'topOp')), false, 'a Top operation while looking at Bottom: not on it')
}

function testAround(): void {
  console.log('Testing an Around operation while the workspace is on Top...')
  const base = newProject('around operation', 'mm')
  const around: MachiningSetup = {
    id: 'su-around', kind: 'around', name: 'Around',
    orientation: { axis: 'x', angleDeg: 0 }, indexing: 'manual', registration: [], notes: '', operationIds: [],
  }
  const project = syncProjectSetups({
    ...base,
    setups: [defaultTopSetup(), around],
    activeSetupId: DEFAULT_SETUP_ID,
    operations: [operation(base, 'aroundOp', around.id)],
  })
  const aroundOp = find(project, 'aroundOp')
  assertEqual(operationOnActiveSetup(project, aroundOp), false, 'an Around operation on Top: not on it')
  assertEqual(operationOnActiveSetup({ ...project, activeSetupId: around.id }, aroundOp), true, 'on the Around setup: on it')
}

function testSameFaceSetups(): void {
  console.log('Testing two setups that turn the same face up...')
  // Setups are compared by face, as the feature tree compares features: the
  // face switch is the only way to change setup, so an operation on a second
  // Top setup must stay usable from Top (review of PR #1105).
  const base = newProject('two top setups', 'mm')
  const secondTop: MachiningSetup = { ...defaultTopSetup(), id: 'su-top-2', name: 'Top 2' }
  const project = syncProjectSetups({
    ...base,
    setups: [defaultTopSetup(), secondTop],
    activeSetupId: DEFAULT_SETUP_ID,
    operations: [operation(base, 'secondTopOp', secondTop.id)],
  })
  const secondOp = find(project, 'secondTopOp')
  assertEqual(setupFace(activeSetup(project)), setupFace(secondTop), 'fixture: both setups turn the same face up')
  assertEqual(operationOnActiveSetup(project, secondOp), true, 'same face, different setup: still usable, since switching face cannot pick between them')
}

function testSingleSetup(): void {
  console.log('Testing a flat single-setup project...')
  const base = newProject('single setup', 'mm')
  const project = syncProjectSetups({ ...base, operations: [operation(base, 'onlyOp')] })
  assertEqual(camSetupSections(project).grouped, false, 'fixture: one flat setup, not grouped')
  assertEqual(operationOnActiveSetup(project, find(project, 'onlyOp')), true, 'one setup: every operation is on it')
}

testRealSetups()
testProvisionalBottom()
testAround()
testSameFaceSetups()
testSingleSetup()

console.log('operation on active setup tests passed')
