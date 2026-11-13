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
 * Per-setup toolpath visibility (issue #1186): the eye on a setup's CAM-panel
 * card shows or hides that card's operations in one undo step, and leaves the
 * other setups' rows alone.
 *
 * Mutations these assertions were checked against:
 * - the action mapping over every operation (the panel-level rule instead of
 *   the setup's membership) → "only the Top card's operations change" fails,
 *   because the Bottom row moves too;
 * - one undo entry per changed operation → "hiding a card is one undo step"
 *   fails;
 * - membership ignoring an operation with no `setupId` → "an operation with no
 *   setup reads as the first setup's" fails.
 *
 * Run with: npx tsx src/store/setupToolpathVisibility.test.ts
 */

import { useProjectStore } from './projectStore'
import { normalizeProject } from './helpers/projectFormat'
import { DEFAULT_SETUP_ID, defaultTool, newProject, rectProfile } from '../types/project'
import type { Operation, Project, SketchFeature } from '../types/project'
import { BOTTOM_SETUP_ID, projectWithFeatures, withBottomSetup } from '../test/projectFixtures'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  )
}

function makeFeature(id: string, zTop: number, zBottom: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(10, 10, 30, 20),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function makeOperation(id: string, featureId: string): Operation {
  return {
    id,
    name: `Op ${id}`,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: [featureId] },
    toolRef: 't1',
    stepdown: 1,
    stepover: 0.4,
    feed: 600,
    plungeFeed: 180,
    rpm: 12000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
  }
}

/** Two pockets on Top and one on Bottom, every toolpath drawn. */
function makeProject(): Project {
  const base = newProject('Setup eye', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 100, 80), thickness: 20 }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Tool 1' }]
  const project = projectWithFeatures(base, [
    makeFeature('f-left', 20, 14),
    makeFeature('f-right', 20, 14),
    makeFeature('f-bottom', 5, 0),
  ])
  const normalized = normalizeProject({
    ...project,
    operations: [makeOperation('op1', 'f-left'), makeOperation('op2', 'f-right'), makeOperation('op3', 'f-bottom')],
  })
  return withBottomSetup(normalized, { operationIds: ['op3'] })
}

function seed(project: Project): void {
  useProjectStore.setState({ project, dirty: false, history: { past: [], future: [], transactionStart: null } })
}

const store = () => useProjectStore.getState()

/** Every operation's id and `showToolpath`, in project order. */
function visibility(project: Project): Array<[string, boolean]> {
  return project.operations.map((operation) => [operation.id, operation.showToolpath])
}

function testHidesOnlyTheChosenCard(): void {
  console.log('Testing the eye changes only the setup it belongs to...')
  seed(makeProject())
  const stepsBefore = store().history.past.length

  store().setSetupOperationToolpathVisibility(DEFAULT_SETUP_ID, false)
  assertEqual(visibility(store().project), [['op1', false], ['op2', false], ['op3', true]], 'only the Top card\'s operations change')
  assertEqual(store().project.setups.map((setup) => [setup.id, setup.operationIds]), [
    [DEFAULT_SETUP_ID, ['op1', 'op2']],
    [BOTTOM_SETUP_ID, ['op3']],
  ], 'the setups themselves are untouched')
  assertEqual(store().history.past.length, stepsBefore + 1, 'hiding a card is one undo step')

  store().undo()
  assertEqual(visibility(store().project), [['op1', true], ['op2', true], ['op3', true]], 'undo restores the whole card')
  assertEqual(store().history.past.length, stepsBefore, 'and pops the one step')

  // The same in the other direction, from the other card.
  store().setSetupOperationToolpathVisibility(BOTTOM_SETUP_ID, false)
  assertEqual(visibility(store().project), [['op1', true], ['op2', true], ['op3', false]], 'only the Bottom card\'s operation changes')
  store().setSetupOperationToolpathVisibility(BOTTOM_SETUP_ID, true)
  assertEqual(visibility(store().project), [['op1', true], ['op2', true], ['op3', true]], 'and showing it brings it back')
}

function testUnassignedOperationReadsAsTheFirstSetup(): void {
  console.log('Testing an operation with no setup reads as the first setup\'s...')
  const project = makeProject()
  // A file saved before setups carries no `setupId` on any operation; the CAM
  // panel lists those rows under the first setup, so its eye owns them too.
  const legacy = {
    ...project,
    operations: project.operations.map((operation) => (
      operation.id === 'op2' ? { ...operation, setupId: undefined } : operation
    )),
  }
  seed(legacy)
  store().setSetupOperationToolpathVisibility(DEFAULT_SETUP_ID, false)
  assertEqual(visibility(store().project), [['op1', false], ['op2', false], ['op3', true]], 'the unassigned row hides with the first setup')
  store().setSetupOperationToolpathVisibility(BOTTOM_SETUP_ID, false)
  assertEqual(visibility(store().project), [['op1', false], ['op2', false], ['op3', false]], 'and the Bottom eye leaves it alone')
}

function testEmptySetupIsNotAnUndoStep(): void {
  console.log('Testing a setup with no operations changes nothing...')
  const project = makeProject()
  seed({ ...project, operations: project.operations.filter((operation) => operation.id !== 'op3') })
  const stepsBefore = store().history.past.length
  store().setSetupOperationToolpathVisibility(BOTTOM_SETUP_ID, false)
  assertEqual(store().history.past.length, stepsBefore, 'no operation of that setup reads as no change, not an undo step')
}

testHidesOnlyTheChosenCard()
testUnassignedOperationReadsAsTheFirstSetup()
testEmptySetupIsNotAnUndoStep()

console.log('setup toolpath visibility tests passed')
