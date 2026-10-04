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
 * The CAM panel's helpers and the setup target rule (issue #946). Everything
 * that offers a target — the Add hint, the quick operations, the compatible
 * highlight, "Select all", the "Add to operation" menu, the export checklist
 * — must agree with what the store will accept, and say why when it will not.
 *
 * Features on a 100 × 80 × 20 stock: `tray` (Top, blind), `recess` (Bottom,
 * blind), `pin` (Top, through).
 *
 * Run with: npx tsx src/components/cam/setupTargetHints.test.ts
 */

import {
  activeSetupTargetHint,
  compatibleFeatureIdsForOperation,
  getOperationAddHint,
  operationTargetFromSelection,
  selectAllCompatibleFeatureIds,
  validQuickOperationsForFeature,
} from './operationValidity'
import { addToOperationCandidates } from './operationTargetLists'
import {
  camSetupSections,
  crossFaceTargets,
  operationsDeletedWithSetup,
  operationTargetReach,
  unreachableTargets,
} from './setupSections'
import { camT } from './camI18n'
import { groupExportOperationOptions, listExportOperationOptions } from '../export/exportOperationSelection'
import type { SelectionState } from '../../store/types'
import { syncProjectSetups } from '../../store/helpers/setups'
import { BOTTOM_SETUP_ID, projectWithFeatures, withBottomSetup, withoutSetupFields } from '../../test/projectFixtures'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, Project, SetupFace, SketchFeature } from '../../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  )
}

function feature(id: string, x: number, zTop: number, zBottom: number, face: SetupFace): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: { profile: rectProfile(x, 10, 20, 20), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: zTop,
    z_bottom: zBottom,
    authoringFace: face,
    visible: true,
    locked: false,
  }
}

function operation(id: string, featureIds: string[]): Operation {
  return {
    id,
    name: id,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
  }
}

function makeProject(activeFace: SetupFace): Project {
  const base = newProject('hints', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 100, 80), thickness: 20 }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1' }]
  const withFeatures = projectWithFeatures(base, [
    feature('tray', 5, 20, 14, 'top'),
    feature('recess', 35, 6, 0, 'bottom'),
    feature('pin', 65, 20, 0, 'top'),
  ])
  const project = withBottomSetup(
    syncProjectSetups({ ...withFeatures, operations: [operation('topOp', ['tray']), operation('bottomOp', ['recess'])] }),
    { operationIds: ['bottomOp'] },
  )
  return activeFace === 'top' ? project : { ...project, activeSetupId: BOTTOM_SETUP_ID }
}

function selection(ids: string[]): SelectionState {
  return {
    mode: 'feature',
    selectedFeatureId: ids[0] ?? null,
    selectedFeatureIds: ids,
    selectedTabIds: [],
    selectedClampIds: [],
    selectedNode: null,
    hoveredFeatureId: null,
    sketchEditTool: null,
    activeControl: null,
  }
}

function testAddHint(): void {
  console.log('Testing the Add hint gives the face reason...')
  const onTop = makeProject('top')
  const onBottom = makeProject('bottom')

  assertEqual(getOperationAddHint(onTop, selection(['tray']), 'pocket'), null, 'Top: a Top pocket can be added')
  assertEqual(getOperationAddHint(onTop, selection(['pin']), 'pocket'), null, 'Top: a through-feature can be added')
  assertEqual(
    getOperationAddHint(onTop, selection(['tray', 'recess']), 'pocket'),
    camT('cam.hint.otherFaceFromTop', { features: 'recess' }),
    'Top: a blind Bottom feature is refused, by name',
  )
  assertEqual(getOperationAddHint(onBottom, selection(['recess', 'pin']), 'pocket'), null, 'Bottom: a Bottom pocket and a through-feature can be added')
  assertEqual(
    getOperationAddHint(onBottom, selection(['tray']), 'pocket'),
    camT('cam.hint.otherFaceFromBottom', { features: 'tray' }),
    'Bottom: a blind Top feature is refused, by name',
  )
  assert(camT('cam.hint.otherFaceFromTop', { features: 'x' }) !== camT('cam.hint.otherFaceFromBottom', { features: 'x' }), 'the two reasons read differently')
  // What the selection is still comes first.
  assertEqual(
    getOperationAddHint(onBottom, selection(['tray']), 'edge_route_outside'),
    getOperationAddHint(onTop, selection(['tray']), 'edge_route_outside'),
    'a selection of the wrong kind keeps its own hint',
  )
  assertEqual(operationTargetFromSelection(onBottom, selection(['tray']), 'pocket'), null, 'a refused selection yields no target')
  assertEqual(operationTargetFromSelection(onBottom, selection(['pin']), 'pocket'), { source: 'features', featureIds: ['pin'] }, 'a through-feature does')

  assertEqual(activeSetupTargetHint(onTop, []), null, 'nothing selected: no face reason')
  // A pre-setup project has one face.
  const legacy = withoutSetupFields(onTop) as unknown as Project
  assertEqual(activeSetupTargetHint(legacy, ['tray', 'pin', 'recess']), null, 'a project without setups refuses nothing for its face')
}

function testOffers(): void {
  console.log('Testing quick operations, the highlight and Select all follow the active face...')
  const onTop = makeProject('top')
  const onBottom = makeProject('bottom')
  const kinds = (project: Project, id: string) => validQuickOperationsForFeature(project, id).map((entry) => entry.kind)

  assert(kinds(onTop, 'tray').includes('pocket'), 'Top: the tray has quick operations')
  assertEqual(kinds(onTop, 'recess'), [], 'Top: a blind Bottom feature has none')
  assertEqual(kinds(onBottom, 'tray'), [], 'Bottom: a blind Top feature has none')
  assert(kinds(onBottom, 'recess').includes('pocket') && kinds(onBottom, 'pin').includes('pocket'), 'Bottom: its own features and through-features do')

  assertEqual(compatibleFeatureIdsForOperation(onTop, 'pocket'), ['tray', 'pin'], 'Top: the highlight skips the blind Bottom feature')
  assertEqual(compatibleFeatureIdsForOperation(onBottom, 'pocket'), ['recess', 'pin'], 'Bottom: the highlight skips the blind Top feature')
  assertEqual(selectAllCompatibleFeatureIds(onBottom, 'pocket'), ['recess', 'pin'], 'Select all selects only what the setup can cut')
}

function testAddToOperationMenu(): void {
  console.log('Testing "Add to operation" judges each operation from its own setup...')
  // The active face does not matter here: the menu lists operations of every setup.
  for (const project of [makeProject('top'), makeProject('bottom')]) {
    const ids = (featureIds: string[]) => addToOperationCandidates(project, featureIds).map((entry) => entry.id)
    assertEqual(ids(['pin']), ['topOp', 'bottomOp'], 'a through-feature can join an operation of either setup')
    assertEqual(ids(['tray']), [], 'the tray is already in the Top operation and cannot join the Bottom one')
    assertEqual(ids(['recess']), [], 'the recess cannot join the Top operation')
    // The Top operation is ruled out by the recess; the Bottom one already has
    // the recess and can take the pin.
    assertEqual(ids(['pin', 'recess']), ['bottomOp'], 'one unreachable feature in the selection rules an operation out')
    assertEqual(ids(['pin', 'tray']), ['topOp'], 'and the same from the other side')
  }
}

function testExportChecklistGroups(): void {
  console.log('Testing the export checklist is grouped by setup...')
  const project = makeProject('top')
  const groups = groupExportOperationOptions(project, listExportOperationOptions(project))
  assertEqual(groups.map((group) => [group.setup?.name, group.programNumber, group.face, group.options.map((option) => option.operation.id)]), [
    ['Top', 1, 'top', ['topOp']],
    ['Bottom', 2, 'bottom', ['bottomOp']],
  ], 'one group per setup, in setup order')

  // A setup with no operations has no group.
  const emptyBottom: Project = { ...project, operations: project.operations.filter((entry) => entry.id === 'topOp') }
  assertEqual(groupExportOperationOptions(emptyBottom, listExportOperationOptions(emptyBottom)).map((group) => group.setup?.name), ['Top'], 'an empty setup is not listed')

  // One setup: the list it always was.
  const single: Project = { ...project, setups: [project.setups[0]], operations: project.operations.filter((entry) => entry.id === 'topOp') }
  const [only, ...rest] = groupExportOperationOptions(single, listExportOperationOptions(single))
  assertEqual([rest.length, only.setup, only.options.length], [0, null, 1], 'a single setup is one unlabelled group')
  assertEqual(groupExportOperationOptions(single, []), [], 'no operations: no group')
}

function testSections(): void {
  console.log('Testing the CAM panel sections...')
  const project = makeProject('bottom')
  const { grouped, sections } = camSetupSections(project)
  assert(grouped, 'two setups: the list is grouped')
  assertEqual(sections.map((section) => [
    section.setup.name, section.face, section.programNumber, section.active, section.operations.map((entry) => entry.id), section.flipAxis,
    section.registrationCount, section.registrationMissing,
  ]), [
    ['Top', 'top', 1, false, ['topOp'], null, 0, false],
    ['Bottom', 'bottom', 2, true, ['bottomOp'], 'x', 0, true],
  ], 'one section per setup: program, face, the active one, its operations, the flip, registration')

  // Declaring a reference clears the registration flag; the first setup never carries it.
  const registered: Project = {
    ...project,
    setups: project.setups.map((setup) => (setup.id === BOTTOM_SETUP_ID
      ? { ...setup, registration: [{ id: 'r1', kind: 'dowel' as const, target: { type: 'feature' as const, featureId: 'pin' } }] }
      : setup)),
  }
  assertEqual(camSetupSections(registered).sections.map((section) => [section.registrationCount, section.registrationMissing]), [[0, false], [1, false]], 'registration status')

  // An empty setup still has a section; a single setup is not grouped.
  const emptyBottom: Project = { ...project, operations: project.operations.filter((entry) => entry.id === 'topOp') }
  assertEqual(camSetupSections(emptyBottom).sections.map((section) => section.operations.length), [1, 0], 'an empty setup keeps its section')
  const single: Project = { ...project, setups: [project.setups[0]], activeSetupId: project.setups[0].id, operations: emptyBottom.operations }
  const one = camSetupSections(single)
  assertEqual([one.grouped, one.sections.length, one.sections[0].operations.length], [false, 1, 1], 'one setup: a flat list')

  assertEqual(operationsDeletedWithSetup(project, BOTTOM_SETUP_ID).map((entry) => entry.id), ['bottomOp'], 'deleting a setup lists the operations that go with it')
  assertEqual(operationsDeletedWithSetup(emptyBottom, BOTTOM_SETUP_ID), [], 'none for an empty setup')

  console.log('Testing cross-face marks and reach in the operation properties...')
  const both: Project = {
    ...project,
    operations: [
      { ...operation('fromTop', ['tray', 'pin']), setupId: project.setups[0].id },
      { ...operation('fromBottom', ['pin', 'recess']), setupId: BOTTOM_SETUP_ID },
      { ...operation('stale', ['tray']), setupId: BOTTOM_SETUP_ID },
    ],
  }
  const [fromTop, fromBottom, stale] = both.operations
  assertEqual(crossFaceTargets(both, fromTop).map((verdict) => verdict.featureId), [], 'the pin is drawn on Top: not cross-face from Top')
  assertEqual(crossFaceTargets(both, fromBottom).map((verdict) => verdict.featureId), ['pin'], 'and cross-face from Bottom')
  assertEqual(unreachableTargets(both, stale).map((verdict) => verdict.featureId), ['tray'], 'a blind Top feature in a Bottom operation is flagged')
  assertEqual(unreachableTargets(both, fromBottom), [], 'a valid operation has none')

  // The pin is the 20 × 20 rect at x 65 → 85, y 10 → 30.
  const cut = (z: number) => ({ moves: [{ kind: 'cut' as const, from: { x: 75, y: 20, z }, to: { x: 75, y: 20, z } }] })
  const paths = new Map([['fromTop', cut(8)], ['fromBottom', cut(9)]])
  const reach = operationTargetReach(both, fromBottom, paths)
  assertEqual(reach.map((entry) => [entry.featureName, entry.verdict.status, entry.range, entry.coverage?.status ?? null, entry.coverage?.overlap ?? null]), [
    ['pin', 'cross-face', { min: 0, max: 9 }, 'meets', 1],
    ['recess', 'same-face', null, null, null],
  ], 'a cross-face through target reports its reach and that it meets the Top pass')
  // Without the Top toolpath nothing is claimed.
  const alone = operationTargetReach(both, fromBottom, new Map([['fromBottom', cut(9)]]))
  assertEqual([alone[0].range, alone[0].coverage?.status], [{ min: 0, max: 9 }, 'unverified'], 'the other side unmeasured: unverified, not complete')
  const none = operationTargetReach(both, fromBottom, new Map())
  assertEqual([none[0].range, none[0].coverage?.status], [null, 'unverified'], 'no toolpath of its own: no range')
}

testAddHint()
testSections()
testOffers()
testAddToOperationMenu()
testExportChecklistGroups()

console.log('setup target hint tests passed')
