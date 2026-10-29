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
 * Canned-shape format round trip (issue #1112, slice A).
 *
 * Run with: npx tsx src/store/cannedFeatureFormat.test.ts
 *
 * The load-bearing property: save, load, regenerate, same geometry. A canned
 * shape stores parameters, so a file that loses its parameters would silently
 * fall back to the stored frame — these tests compare the regenerated outlines
 * before and after the `.camj` round trip.
 */

import {
  IDENTITY_MATRIX,
  getProfileBounds,
  rectProfile,
  type CannedShapeData,
  type FeatureDefinition,
  type FeatureInstance,
  type Project,
} from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { instantiateProjectTemplate } from './helpers/normalize'
import { convertProjectUnits } from '../utils/units'
import { cannedShapeFrame, resolveCannedShapeProfiles } from '../cannedShapes'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import { registerTestCannedShapes, testOpenLineCanned, testPlateCanned } from '../test/cannedShapeFixture'

registerTestCannedShapes()

let passCount = 0
let failCount = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`✓ ${name}`)
    passCount += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${(error as Error).message}`)
    failCount += 1
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual: ${JSON.stringify(actual)}`)
  }
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`)
  }
}

function cannedRow(
  id: string,
  canned: CannedShapeData,
  operation: FeatureDefinition['operation'],
): { feature: FeatureInstance; definition: FeatureDefinition } {
  const definition: FeatureDefinition = {
    id: `def-${id}`,
    kind: 'composite',
    // A real creation path stores the derived placement frame, so the unit
    // conversion test has to start from one too.
    profile: cannedShapeFrame(canned) ?? { start: { x: 0, y: 0 }, segments: [], closed: true },
    dimensions: [],
    text: null,
    canned,
    stl: null,
    operation,
  }
  const feature: FeatureInstance = {
    id,
    name: id,
    definitionId: definition.id,
    transform: { ...IDENTITY_MATRIX },
    constraints: [],
    folderId: null,
    z_top: 5,
    z_bottom: 0,
    authoringFace: 'top',
    visible: true,
    locked: false,
  }
  return { feature, definition }
}

function seed(extraDefinitions: Record<string, FeatureDefinition> = {}): Project {
  const plate = cannedRow('canned-plate', testPlateCanned(100, 60, 12), 'add')
  const line = cannedRow('canned-line', testOpenLineCanned(60, 8), 'line')
  const plainDefinition: FeatureDefinition = {
    id: 'def-plain',
    kind: 'rect',
    profile: rectProfile(0, 0, 20, 10),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
  const plainFeature: FeatureInstance = {
    id: 'plain',
    name: 'Plain',
    definitionId: plainDefinition.id,
    transform: { ...IDENTITY_MATRIX },
    constraints: [],
    folderId: null,
    z_top: 5,
    z_bottom: 0,
    authoringFace: 'top',
    visible: true,
    locked: false,
  }
  const project: Project = {
    ...instantiateProjectTemplate(),
    featureDefinitions: {
      [plate.definition.id]: plate.definition,
      [line.definition.id]: line.definition,
      [plainDefinition.id]: plainDefinition,
      ...extraDefinitions,
    },
    features: [plate.feature, line.feature, plainFeature],
  }
  useProjectStore.setState({
    project,
    selection: { ...useProjectStore.getState().selection, selectedFeatureIds: [] },
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
  return project
}

function regenerated(featureId: string) {
  const project = useProjectStore.getState().project
  const feature = resolveFeatureInstance(project, featureId)
  assert(feature, `${featureId} resolves`)
  return resolveCannedShapeProfiles(feature)
}

test('saved format stays 3.3 and carries the canned data', () => {
  seed()
  const file = JSON.parse(useProjectStore.getState().saveProject()) as Project
  assertEqual(file.version, '3.3', 'format version')
  assertEqual(file.featureDefinitions['def-canned-plate'].canned, testPlateCanned(100, 60, 12), 'plate parameters saved')
  assertEqual(file.featureDefinitions['def-canned-line'].canned, testOpenLineCanned(60, 8), 'line parameters saved')
})

test('save, load, regenerate: closed shape with a hole', () => {
  seed()
  const before = regenerated('canned-plate')
  assertEqual(before.length, 2, 'two outlines before saving')

  const file = useProjectStore.getState().saveProject()
  useProjectStore.getState().openProjectFromText(file, null)

  assertEqual(regenerated('canned-plate'), before, 'same geometry after the round trip')
})

test('save, load, regenerate: open-line shape', () => {
  seed()
  const before = regenerated('canned-line')
  assertEqual(before.length, 1, 'one outline before saving')

  const file = useProjectStore.getState().saveProject()
  useProjectStore.getState().openProjectFromText(file, null)

  assertEqual(regenerated('canned-line'), before, 'same open line after the round trip')
})

test('the Add/Subtract nesting survives the round trip', () => {
  seed()
  const file = useProjectStore.getState().saveProject()
  useProjectStore.getState().openProjectFromText(file, null)

  const plate = resolveFeatureInstance(useProjectStore.getState().project, 'canned-plate')
  assert(plate, 'plate resolves')
  assertEqual(plate.operation, 'add', 'feature operation survives')
  assertEqual(
    regenerated('canned-plate').length,
    2,
    'both outlines regenerate',
  )
})

test('an unregistered kind round-trips without dropping its data', () => {
  const future: FeatureDefinition = {
    id: 'def-future',
    kind: 'composite',
    profile: { start: { x: 0, y: 0 }, segments: [], closed: true },
    dimensions: [],
    text: null,
    canned: { kind: 'shape-from-a-later-build', params: { sides: 7, mirror: false } },
    stl: null,
    operation: 'add',
  }
  seed({ [future.id]: future })

  const file = useProjectStore.getState().saveProject()
  useProjectStore.getState().openProjectFromText(file, null)

  assertEqual(
    useProjectStore.getState().project.featureDefinitions[future.id].canned,
    future.canned,
    'unknown generator data is preserved verbatim',
  )
  assertEqual(regenerated('canned-plate').length, 2, 'known shapes are unaffected')
})

test('a saved canned project is stable across a second save', () => {
  seed()
  const first = JSON.parse(useProjectStore.getState().saveProject()) as Project
  useProjectStore.getState().openProjectFromText(JSON.stringify(first), null)
  const second = JSON.parse(useProjectStore.getState().saveProject()) as Project

  assertEqual(
    second.featureDefinitions['def-canned-plate'].canned,
    first.featureDefinitions['def-canned-plate'].canned,
    'parameters are idempotent',
  )
})

test('a definition that is not canned does not grow the field', () => {
  seed()
  const file = JSON.parse(useProjectStore.getState().saveProject()) as Project
  assert(!('canned' in file.featureDefinitions['def-plain']), 'a plain definition keeps its saved shape')

  // Editing a plain feature must not add the field either — that would rewrite
  // every existing project on its first edit (issue #1112).
  useProjectStore.getState().updateFeature('plain', { name: 'Renamed' })
  const edited = useProjectStore.getState().project.featureDefinitions['def-plain']
  assert(!('canned' in edited), 'an edited plain definition still has no canned field')
})

test('editing the parameters regenerates the outlines and the frame', () => {
  seed()
  const before = regenerated('canned-plate')

  useProjectStore.getState().updateFeature('canned-plate', {
    canned: testPlateCanned(120, 80, 10),
  })
  const definition = useProjectStore.getState().project.featureDefinitions['def-canned-plate']
  assertEqual(definition.canned, testPlateCanned(120, 80, 10), 'parameters changed')
  assertEqual(
    getProfileBounds(definition.profile),
    { minX: 0, maxX: 120, minY: 0, maxY: 80 },
    'the stored placement frame was refit',
  )

  const after = regenerated('canned-plate')
  assertEqual(getProfileBounds(after[0]), { minX: 0, maxX: 120, minY: 0, maxY: 80 }, 'geometry grew')
  assert(after[0] !== before[0], 'the geometry was regenerated, not frozen')

  // And the edited parameters survive the file round trip.
  const file = useProjectStore.getState().saveProject()
  useProjectStore.getState().openProjectFromText(file, null)
  assertEqual(regenerated('canned-plate'), after, 'edited geometry round-trips')
})

test('unit conversion converts canned parameters with the frame', () => {
  const project = seed()
  const mm = convertProjectUnits(project, 'mm')
  const plate = mm.featureDefinitions['def-canned-plate']
  const params = plate.canned?.params ?? {}
  assertEqual(plate.canned?.kind, 'test-plate', 'kind survives the conversion')
  assertNear(Number(params.width), 2540, 'width converted')
  assertNear(Number(params.height), 1524, 'height converted')
  assertNear(Number(params.holeRadius), 304.8, 'hole radius converted')

  const frame = getProfileBounds(plate.profile)
  assertNear(frame.maxX, 2540, 'frame width converted')
  assertNear(frame.maxY, 1524, 'frame height converted')

  const resolved = resolveFeatureInstance(mm, 'canned-plate')
  assert(resolved, 'converted plate resolves')
  assertEqual(
    getProfileBounds(resolveCannedShapeProfiles(resolved)[0]),
    frame,
    'regenerated geometry agrees with the converted frame',
  )
})

if (failCount > 0) {
  console.error(`\n${failCount} test(s) failed, ${passCount} passed`)
  process.exit(1)
}
console.log(`\nAll ${passCount} canned-format tests passed`)
