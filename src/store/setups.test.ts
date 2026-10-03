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
 * Machining setups in the project model (issue #944): the missing-field
 * migration, the strict decoder, `.camj` round trip with a Bottom setup, the
 * reconciler, and the store actions.
 *
 * Mutations these assertions were checked against:
 * - the migration gated on the file version (skipped for 3.3)
 *   → "a 3.3 file saved before setups" fails;
 * - `authoringFace` not written by `normalizeInstance` → "every feature is
 *   authored on Top" and the Bottom round trip fail;
 * - `syncProjectSetups` not rebuilding `operationIds` → the migration,
 *   reorder and delete assertions fail;
 * - a new operation not joining the active setup → "a new operation joins
 *   the active setup" fails;
 * - the store wrapper removed → the reorder/delete/add assertions fail;
 * - `decodeSetups` accepting any angle → "an unsupported angle is refused"
 *   fails;
 * - `setFeatureAuthoringFace` also flipping the span → "the Z span is
 *   untouched" fails;
 * - `deleteSetup` leaving the setup's operations behind → "its operations go
 *   with it" fails;
 * - the resolver or `createFeatureInstance` dropping `authoringFace`
 *   → "a geometry edit leaves every face" / "an offset … stays on Bottom" fail;
 * - setup ids left out of id generation → "an id in use by a setup" fails;
 * - `assignOperationToSetup` accepting an unknown setup → "a refused
 *   assignment is not an undo step" fails.
 *
 * Run with: npx tsx src/store/setups.test.ts
 */

import { readFileSync, readdirSync } from 'node:fs'
import { useProjectStore } from './projectStore'
import { decodeProjectFormat, normalizeProject } from './helpers/projectFormat'
import type { ProjectFormatInput } from './helpers/projectFormat'
import { nextUniqueGeneratedId, syncIdCounter } from './helpers/ids'
import { commitResolvedInstances, featureInstanceFromResolved, resolvedProjectFeatures } from './helpers/resolveFeatures'
import { matchingSetupId, syncProjectSetups } from './helpers/setups'
import {
  DEFAULT_SETUP_ID,
  defaultTool,
  defaultTopSetup,
  newProject,
  rectProfile,
} from '../types/project'
import type { MachiningSetup, Operation, Project, SketchFeature } from '../types/project'
import { setupFace } from '../engine/setupOrientation'
import { convertProjectUnits } from '../utils/units'
import { BOTTOM_SETUP_ID, projectWithFeatures, withBottomSetup, withoutSetupFields } from '../test/projectFixtures'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  )
}

function assertThrows(run: () => unknown, pattern: RegExp, label: string): void {
  try {
    run()
  } catch (error) {
    assert(pattern.test(String(error)), `${label}: threw ${String(error)}, expected ${pattern}`)
    return
  }
  throw new Error(`Assertion failed: ${label}: expected a throw`)
}

// ── Fixtures ──────────────────────────────────────────────────

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

/** Three pockets — open at the top, floating, open at the bottom — and an operation on each. */
function makeProject(): Project {
  const base = newProject('Setups', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 100, 80), thickness: 20 }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Tool 1' }]
  const project = projectWithFeatures(base, [
    makeFeature('f-top', 20, 14),
    makeFeature('f-float', 12, 5),
    makeFeature('f-bottom', 5, 0),
  ])
  return normalizeProject({
    ...project,
    operations: [makeOperation('op1', 'f-top'), makeOperation('op2', 'f-float'), makeOperation('op3', 'f-bottom')],
  })
}

function spans(project: Project): Array<[string, unknown, unknown]> {
  return project.features.map((feature) => [feature.id, feature.z_top, feature.z_bottom])
}

function seed(project: Project): void {
  useProjectStore.setState({ project, dirty: false, history: { past: [], future: [], transactionStart: null } })
}

const store = () => useProjectStore.getState()

// ── Migration ─────────────────────────────────────────────────

function assertSingleTopSetup(project: Project, label: string): void {
  assertEqual(project.setups.length, 1, `${label}: one setup`)
  const [setup] = project.setups
  assertEqual(
    { id: setup.id, orientation: setup.orientation, indexing: setup.indexing, registration: setup.registration, notes: setup.notes },
    { id: DEFAULT_SETUP_ID, orientation: { axis: 'x', angleDeg: 0 }, indexing: 'manual', registration: [], notes: '' },
    `${label}: the Top setup`,
  )
  assertEqual(setupFace(setup), 'top', `${label}: it faces Top`)
  assertEqual(setup.operationIds, project.operations.map((operation) => operation.id), `${label}: every operation, in order`)
  assert(project.operations.every((operation) => operation.setupId === setup.id), `${label}: every operation names the setup`)
  assertEqual(project.activeSetupId, setup.id, `${label}: the Top setup is active`)
  assert(project.features.every((feature) => feature.authoringFace === 'top'), `${label}: every feature is authored on Top`)
}

function testLegacyMigration(): void {
  console.log('Testing files saved before setups load as one Top setup...')
  const current = makeProject()
  const legacy = withoutSetupFields(current)
  assert(!('setups' in legacy) && !('activeSetupId' in legacy), 'fixture: no setup fields on the project')
  assert(legacy.operations.every((operation) => !('setupId' in operation)), 'fixture: no setupId on operations')
  assert(legacy.features.every((feature) => !('authoringFace' in feature)), 'fixture: no authoringFace on features')

  // The migration keys on the missing fields, not on the format number: a 3.2
  // file and a 3.3 file saved before setups existed both lack them.
  for (const version of ['3.2', '3.3'] as const) {
    const decoded = decodeProjectFormat({ ...structuredClone(legacy), version })
    const label = version === '3.3' ? 'a 3.3 file saved before setups' : 'a 3.2 file'
    assertSingleTopSetup(decoded.project, label)
    assertEqual(decoded.project.version, '3.3', `${label}: no format bump`)
    assertEqual(decoded.convertedLegacy, false, `${label}: not a legacy conversion`)
    assertEqual(spans(decoded.project), spans(current), `${label}: Z spans are unchanged`)
    assertEqual(
      decoded.project.operations.map((operation) => operation.id),
      ['op1', 'op2', 'op3'],
      `${label}: operation order is unchanged`,
    )
  }

  // Idempotent: saving runs the normaliser again, and so does every undo.
  const once = normalizeProject(structuredClone(legacy))
  assertEqual(normalizeProject(structuredClone(once)), once, 'normalising a migrated project changes nothing')
  assertEqual(syncProjectSetups(once) === once, true, 'a consistent project is returned as-is')

  // A new project starts in the same shape a migrated one ends in.
  assertSingleTopSetup(normalizeProject(newProject('Fresh', 'mm')), 'a new project')
}

function testFixtureFilesMigrate(): void {
  console.log('Testing every checked-in project file loads as one Top setup...')
  const directories = [
    new URL('../engine/test-fixtures/', import.meta.url),
    new URL('../../public/examples/', import.meta.url),
  ]
  let checked = 0
  for (const directory of directories) {
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.camj')).sort()) {
      const raw = JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as ProjectFormatInput
      assert(!('setups' in raw), `${name}: fixture predates setups`)
      const decoded = decodeProjectFormat(raw).project
      assertSingleTopSetup(decoded, name)
      assertEqual(
        decoded.operations.map((operation) => operation.id),
        raw.operations.map((operation) => operation.id),
        `${name}: operation order is the file's`,
      )
      checked += 1
    }
  }
  assert(checked >= 15, `expected to check the fixture corpus, checked ${checked}`)
}

// ── Round trip ────────────────────────────────────────────────

function bottomProject(): Project {
  const withBottom = withBottomSetup(makeProject(), {
    axis: 'y',
    operationIds: ['op3'],
    setup: {
      notes: 'Flip left to right against the fence.',
      registration: [
        { id: 'r1', kind: 'dowel', target: { type: 'feature', featureId: 'f-top' } },
        { id: 'r2', kind: 'corner', target: { type: 'point', point: { x: 0, y: 80 } } },
        { id: 'r3', kind: 'fence', target: { type: 'edge', start: { x: 0, y: 80 }, end: { x: 100, y: 80 } } },
      ],
    },
  })
  return {
    ...withBottom,
    activeSetupId: BOTTOM_SETUP_ID,
    features: withBottom.features.map((feature) => (
      feature.id === 'f-bottom' ? { ...feature, authoringFace: 'bottom' as const } : feature
    )),
  }
}

function testBottomRoundTrip(): void {
  console.log('Testing a project with a Bottom setup round-trips through .camj...')
  const project = bottomProject()
  seed(project)
  const text = store().saveProject()
  const file = JSON.parse(text) as Project
  assertEqual(file.version, '3.3', 'saved format')
  assertEqual(file.setups.map((setup) => [setup.id, setup.orientation, setup.operationIds]), [
    [DEFAULT_SETUP_ID, { axis: 'x', angleDeg: 0 }, ['op1', 'op2']],
    [BOTTOM_SETUP_ID, { axis: 'y', angleDeg: 180 }, ['op3']],
  ], 'saved setups')
  assert(!('face' in file.setups[1]), 'the face is derived, not stored')

  store().openProjectFromText(text, null)
  const reopened = store().project
  assertEqual(reopened.setups, project.setups, 'setups survive the round trip')
  assertEqual(setupFace(reopened.setups[1]), 'bottom', 'the second setup faces Bottom')
  assertEqual(reopened.activeSetupId, BOTTOM_SETUP_ID, 'the active setup survives')
  assertEqual(reopened.operations.map((operation) => [operation.id, operation.setupId]), [
    ['op1', DEFAULT_SETUP_ID], ['op2', DEFAULT_SETUP_ID], ['op3', BOTTOM_SETUP_ID],
  ], 'operation membership survives')
  assertEqual(reopened.features.map((feature) => [feature.id, feature.authoringFace]), [
    ['f-top', 'top'], ['f-float', 'top'], ['f-bottom', 'bottom'],
  ], 'authoring faces survive')
  assertEqual(spans(reopened), spans(project), 'Z spans survive, floating and bottom-open included')
  assertEqual(store().dirty, false, 'a current file opens clean')
  assertEqual(JSON.parse(store().saveProject()).setups, file.setups, 'a second save is stable')
}

function testStrictDecode(): void {
  console.log('Testing a file this build cannot honour is refused...')
  const project = bottomProject()
  const withSetup = (patch: Record<string, unknown>): unknown => ({
    ...structuredClone(project),
    setups: [project.setups[0], { ...project.setups[1], ...patch }],
  })
  // A setup turned to an angle we cannot machine must not load as Top.
  for (const angleDeg of [90, 45, -180, 360]) {
    assertThrows(() => decodeProjectFormat(withSetup({ orientation: { axis: 'x', angleDeg } })), /orientation/, `an unsupported angle is refused (${angleDeg})`)
  }
  assertThrows(() => decodeProjectFormat(withSetup({ orientation: { axis: 'z', angleDeg: 180 } })), /orientation/, 'an unsupported axis is refused')
  assertThrows(() => decodeProjectFormat(withSetup({ orientation: undefined })), /orientation/, 'a missing orientation is refused')
  assertThrows(() => decodeProjectFormat(withSetup({ indexing: 'rotary' })), /indexing/, 'an unknown indexing mode is refused')
  assertThrows(() => decodeProjectFormat(withSetup({ id: DEFAULT_SETUP_ID })), /more than once/, 'a duplicate setup id is refused')
  assertThrows(
    () => decodeProjectFormat(withSetup({ registration: [{ id: 'r', kind: 'dowel', target: { type: 'point', point: { x: 'a', y: 1 } } }] })),
    /registration/,
    'a malformed registration reference is refused',
  )
  assertThrows(
    () => decodeProjectFormat(withSetup({ registration: [{ id: 'r', kind: 'magnet', target: { type: 'point', point: { x: 0, y: 1 } } }] })),
    /registration/,
    'an unknown registration kind is refused',
  )
  assertThrows(
    () => decodeProjectFormat({ ...structuredClone(project), operations: project.operations.map((operation) => ({ ...operation, setupId: 'gone' })) }),
    /missing setup/,
    'an operation in a setup that does not exist is refused',
  )
  assertThrows(
    () => decodeProjectFormat({ ...structuredClone(project), features: project.features.map((feature) => ({ ...feature, authoringFace: 'left' })) }),
    /authoring face/,
    'an unknown authoring face is refused',
  )

  // What is recoverable is recovered rather than refused.
  const stale = decodeProjectFormat({
    ...structuredClone(project),
    activeSetupId: 'gone',
    setups: [
      { ...project.setups[0], operationIds: ['op3', 'nope'] },
      { ...project.setups[1], operationIds: [], registration: [{ id: 'r1', kind: 'dowel', target: { type: 'feature', featureId: 'deleted' } }] },
    ],
  }).project
  assertEqual(stale.setups.map((setup) => setup.operationIds), [['op1', 'op2'], ['op3']], 'stale operation lists are rebuilt from membership')
  assertEqual(stale.setups[1].registration, [], 'a reference to a deleted feature is dropped')
  assertEqual(stale.activeSetupId, DEFAULT_SETUP_ID, 'a stale active setup falls back to the first')
}

// ── Reconciler ────────────────────────────────────────────────

function testSync(): void {
  console.log('Testing the reconciler...')
  const project = bottomProject()
  // Membership missing, but the lists are there: each operation rejoins the setup that lists it.
  const stripped = { ...project, operations: project.operations.map(({ setupId: _setupId, ...operation }) => { void _setupId; return operation }) }
  assertEqual(
    syncProjectSetups(stripped).operations.map((operation) => operation.setupId),
    [DEFAULT_SETUP_ID, DEFAULT_SETUP_ID, BOTTOM_SETUP_ID],
    'an operation without a setup rejoins the one that lists it',
  )
  // Listed nowhere: it joins the active setup.
  const added = syncProjectSetups({ ...project, operations: [...project.operations, makeOperation('op4', 'f-top')] })
  assertEqual(added.operations[3].setupId, BOTTOM_SETUP_ID, 'an unlisted operation joins the active setup')
  assertEqual(added.setups[1].operationIds, ['op3', 'op4'], 'and its setup lists it')
  // No setups at all (a project built by hand): one Top setup appears.
  const bare = syncProjectSetups({ ...stripped, setups: [], activeSetupId: '' })
  assertEqual(bare.setups.map((setup) => [setup.id, setup.operationIds]), [[DEFAULT_SETUP_ID, ['op1', 'op2', 'op3']]], 'a project without setups gets one Top setup')
}

// ── Store actions ─────────────────────────────────────────────

function testStoreActions(): void {
  console.log('Testing setup store actions...')
  seed(makeProject())

  assertEqual(store().createSetup({ orientation: { axis: 'x', angleDeg: 90 } }), null, 'an unsupported orientation creates nothing')
  assertEqual(store().project.setups.length, 1, 'still one setup')
  assertEqual(store().history.past.length, 0, 'a refused action is not an undo step')

  const bottomId = store().createSetup({ orientation: { axis: 'y', angleDeg: 180 } })
  assert(bottomId, 'createSetup returns the new id')
  const created = store().project.setups.find((setup) => setup.id === bottomId)
  assertEqual(
    created && { name: created.name, orientation: created.orientation, indexing: created.indexing, operationIds: created.operationIds },
    { name: 'Bottom', orientation: { axis: 'y', angleDeg: 180 }, indexing: 'manual', operationIds: [] },
    'the created setup',
  )
  assertEqual(store().project.activeSetupId, DEFAULT_SETUP_ID, 'creating a setup does not switch to it')
  assertEqual(store().history.past.length, 1, 'creating a setup is one undo step')
  assert(store().dirty, 'creating a setup marks the project changed')

  // A second Bottom gets its own id and a distinct name.
  const secondId = store().createSetup({ orientation: { axis: 'x', angleDeg: 180 } })
  assert(secondId && secondId !== bottomId, 'a second setup has a new id')
  assertEqual(store().project.setups.at(-1)?.name, 'Bottom 2', 'a second Bottom gets a distinct name')
  assert(store().deleteSetup(secondId), 'an empty setup can be deleted')

  store().renameSetup(bottomId, '  Underside  ')
  assertEqual(store().project.setups[1].name, 'Underside', 'renameSetup trims and stores the name')
  store().renameSetup(bottomId, '   ')
  assertEqual(store().project.setups[1].name, 'Underside', 'an empty name is ignored')

  console.log('Testing the active setup...')
  useProjectStore.setState({ dirty: false })
  const stepsBefore = store().history.past.length
  store().setActiveSetup('gone')
  assertEqual(store().project.activeSetupId, DEFAULT_SETUP_ID, 'an unknown setup cannot be made active')
  store().setActiveSetup(bottomId)
  assertEqual(store().project.activeSetupId, bottomId, 'setActiveSetup switches the workspace')
  assertEqual(store().history.past.length, stepsBefore, 'switching setups is not an undo step')
  assertEqual(store().dirty, false, 'switching setups does not mark the project changed')

  console.log('Testing operations follow their setup...')
  const newId = store().addOperation('pocket', 'rough', { source: 'features', featureIds: ['f-bottom'] })
  assert(newId, 'addOperation created an operation')
  const setupOf = (id: string) => store().project.operations.find((operation) => operation.id === id)?.setupId
  const lists = () => store().project.setups.map((setup) => setup.operationIds)
  assertEqual(setupOf(newId), bottomId, 'a new operation joins the active setup')
  assertEqual(lists(), [['op1', 'op2', 'op3'], [newId]], 'and is listed there')

  const copyId = store().duplicateOperation('op1')
  assert(copyId, 'duplicateOperation created an operation')
  assertEqual(setupOf(copyId), DEFAULT_SETUP_ID, 'a duplicate stays in its source setup, not the active one')

  store().assignOperationToSetup('op3', bottomId)
  assertEqual(lists(), [['op1', 'op2', copyId], ['op3', newId]], 'assignOperationToSetup moves the operation; lists keep project order')
  const stepsBeforeUnknown = store().history.past.length
  store().assignOperationToSetup('op2', 'gone')
  assertEqual(setupOf('op2'), DEFAULT_SETUP_ID, 'an unknown setup is not assigned')
  assertEqual(store().history.past.length, stepsBeforeUnknown, 'and a refused assignment is not an undo step')

  store().reorderOperations([newId, 'op3', 'op2', 'op1', copyId])
  assertEqual(lists(), [['op2', 'op1', copyId], [newId, 'op3']], 'a reorder is reflected in each setup')
  store().deleteOperation('op1')
  assertEqual(lists(), [['op2', copyId], [newId, 'op3']], 'a deleted operation leaves its setup')
  store().undo()
  assertEqual(lists(), [['op2', 'op1', copyId], [newId, 'op3']], 'undo restores it')

  console.log('Testing a feature changes face without changing its span...')
  const before = spans(store().project)
  store().setFeatureAuthoringFace(['f-bottom', 'f-float'], 'bottom')
  assertEqual(store().project.features.map((feature) => feature.authoringFace), ['top', 'bottom', 'bottom'], 'setFeatureAuthoringFace sets the face')
  assertEqual(spans(store().project), before, 'the Z span is untouched')
  const steps = store().history.past.length
  store().setFeatureAuthoringFace(['f-bottom'], 'bottom')
  assertEqual(store().history.past.length, steps, 'setting the same face is not an undo step')

  console.log('Testing the face survives edits and derived geometry...')
  const faceOf = (id: string) => store().project.features.find((feature) => feature.id === id)?.authoringFace
  // A geometry edit rebuilds every row from the resolved read model, so the
  // face has to ride through it — for the rows that were not edited too.
  const editSteps = store().history.past.length
  store().moveFeatureControl('f-top', { kind: 'anchor', index: 0 }, { x: 8, y: 8 })
  assertEqual(store().history.past.length, editSteps + 1, 'fixture: the geometry edit happened')
  assertEqual(['f-top', 'f-float', 'f-bottom'].map(faceOf), ['top', 'bottom', 'bottom'], 'a geometry edit leaves every face as it was')
  // Geometry derived from a Bottom feature is drawn on Bottom.
  store().selectFeature('f-bottom')
  const offsetIds = store().offsetSelectedFeatures(2)
  assert(offsetIds.length === 1, 'fixture: the offset created one feature')
  assertEqual(faceOf(offsetIds[0]), 'bottom', 'an offset of a Bottom feature stays on Bottom')

  console.log('Testing a registration reference follows its feature...')
  useProjectStore.setState((state) => ({
    project: {
      ...state.project,
      setups: state.project.setups.map((setup) => (setup.id === bottomId
        ? {
            ...setup,
            registration: [
              { id: 'r1', kind: 'dowel' as const, target: { type: 'feature' as const, featureId: 'f-float' } },
              { id: 'r2', kind: 'corner' as const, target: { type: 'point' as const, point: { x: 0, y: 80 } } },
            ],
          }
        : setup)),
    },
  }))
  store().deleteFeature('f-float')
  assertEqual(store().project.setups[1].registration.map((reference) => reference.id), ['r2'], 'deleting the feature drops its reference')

  console.log('Testing deleting a setup...')
  const bottomOperations = store().project.setups[1].operationIds
  assert(bottomOperations.length > 0, 'fixture: the Bottom setup has operations')
  assertEqual(store().deleteSetup('gone'), false, 'an unknown setup is not deleted')
  const pastBefore = store().history.past.length
  assertEqual(store().deleteSetup(bottomId), true, 'deleteSetup reports success')
  assertEqual(store().project.setups.map((setup) => setup.id), [DEFAULT_SETUP_ID], 'the setup is gone')
  assert(
    store().project.operations.every((operation) => !bottomOperations.includes(operation.id)),
    'its operations go with it',
  )
  assert(store().project.operations.every((operation) => operation.setupId === DEFAULT_SETUP_ID), 'no operation is moved to another face')
  assertEqual(store().project.activeSetupId, DEFAULT_SETUP_ID, 'the active setup falls back')
  assertEqual(store().history.past.length, pastBefore + 1, 'deleting a setup is one undo step')
  assertEqual(store().deleteSetup(DEFAULT_SETUP_ID), false, 'the last setup cannot be deleted')
  store().undo()
  assertEqual(store().project.setups.map((setup) => setup.id), [DEFAULT_SETUP_ID, bottomId], 'undo restores the setup')
  assertEqual(store().project.setups[1].operationIds, bottomOperations, 'and its operations')
}

function testFaceSurvivesTheResolvedReadModel(): void {
  console.log('Testing the face survives resolving a row and committing it back...')
  const project = bottomProject()
  const resolved = resolvedProjectFeatures(project)
  assertEqual(resolved.map((feature) => feature.authoringFace), ['top', 'top', 'bottom'], 'the resolved row carries the face')
  assertEqual(
    resolved.map((feature) => featureInstanceFromResolved(feature).authoringFace),
    ['top', 'top', 'bottom'],
    'featureInstanceFromResolved keeps the face',
  )
  assertEqual(
    commitResolvedInstances(project, resolved).map((feature) => feature.authoringFace),
    ['top', 'top', 'bottom'],
    'commitResolvedInstances keeps the face',
  )
}

function testSetupIdsAreReserved(): void {
  console.log('Testing a generated id never collides with a setup...')
  const project = makeProject()
  // The counter is shared by the whole test process, so work relative to it.
  const counter = Number(nextUniqueGeneratedId(project, 'su').slice(2))
  const setupId = (suffix: number) => `su${String(suffix).padStart(4, '0')}`
  // The id the generator would hand out next already names a setup.
  const taken = { ...project, setups: [...project.setups, { ...defaultTopSetup(), id: setupId(counter + 1), name: 'Taken' }] }
  assertEqual(nextUniqueGeneratedId(taken, 'su'), setupId(counter + 2), 'an id in use by a setup is skipped')
  // Loading a project moves the counter past its setup ids.
  const far = { ...project, setups: [...project.setups, { ...defaultTopSetup(), id: setupId(counter + 1000), name: 'Far' }] }
  syncIdCounter(far)
  assertEqual(nextUniqueGeneratedId(project, 'su'), setupId(counter + 1001), 'the counter resumes after the highest setup id')
}

// ── Units and import ──────────────────────────────────────────

function testUnitsAndImport(): void {
  console.log('Testing registration points convert with the project units...')
  const project = bottomProject()
  const inches = convertProjectUnits(project, 'inch')
  const [, corner, fence] = inches.setups[1].registration
  assertEqual(corner.target, { type: 'point', point: { x: 0, y: 80 / 25.4 } }, 'a registration point converts')
  assertEqual(fence.target, { type: 'edge', start: { x: 0, y: 80 / 25.4 }, end: { x: 100 / 25.4, y: 80 / 25.4 } }, 'a registration edge converts')
  assertEqual(inches.setups[1].registration[0], project.setups[1].registration[0], 'a feature reference has nothing to convert')
  assertEqual(inches.setups[1].orientation, project.setups[1].orientation, 'the orientation is unitless')

  console.log('Testing an imported operation joins a setup turned the same way...')
  const bottomAboutY: MachiningSetup = project.setups[1]
  const bottomAboutX: MachiningSetup = { ...bottomAboutY, id: 'other', orientation: { axis: 'x', angleDeg: 180 } }
  assertEqual(matchingSetupId(project, bottomAboutY), BOTTOM_SETUP_ID, 'the same turn matches')
  assertEqual(matchingSetupId(project, { ...defaultTopSetup(), id: 'their-top', orientation: { axis: 'y', angleDeg: 0 } }), DEFAULT_SETUP_ID, 'Top matches Top whatever its axis')
  // A flip about the other axis is a different turn: no match, so the active setup.
  assertEqual(matchingSetupId({ ...project, activeSetupId: DEFAULT_SETUP_ID }, bottomAboutX), DEFAULT_SETUP_ID, 'a different flip axis does not match')
  assertEqual(matchingSetupId(project, undefined), BOTTOM_SETUP_ID, 'an operation from a pre-setup project joins the active setup')
}

testLegacyMigration()
testFixtureFilesMigrate()
testBottomRoundTrip()
testStrictDecode()
testSync()
testStoreActions()
testFaceSurvivesTheResolvedReadModel()
testSetupIdsAreReserved()
testUnitsAndImport()

console.log('setup model tests passed')
