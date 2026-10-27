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
 * Store tests for gear creation (issue #1112 slice E).
 *
 * A gear is one canned feature: its bore is a hole in the same feature, and the
 * canned model's nesting rule gives it the opposite operation. These tests pin
 * that, the instance placement, naming, expansion and the format round trip.
 *
 * Run with: npx tsx src/store/gearCreation.test.ts
 */

import {
  IDENTITY_MATRIX,
  circleProfile,
  newProject,
  type Matrix2D,
  type Project,
  type SketchFeature,
} from '../types/project'
import { useProjectStore } from './projectStore'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import {
  cannedShapeSummary,
  resolveCannedShapeProfiles,
  resolveCannedShapeShapes,
} from '../cannedShapes'
import { GEAR_CANNED_KIND, normalizeGearCannedParams } from '../cannedShapes/generators/gear'
import { buildGearProfile } from '../sketch/gearProfile'
import type { ProjectStore } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual: ${JSON.stringify(actual)}`)
  }
}

function resetStore(project?: Project): void {
  useProjectStore.setState({
    project: project ?? newProject(),
    selection: {
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedTabIds: [],
      selectedClampIds: [],
      selectedNode: null,
      mode: 'feature' as const,
      sketchEditTool: null,
      activeControl: null,
      hoveredFeatureId: null,
      groupFolderId: null,
    },
    history: { past: [], future: [], transactionStart: null },
    sketchEditSession: null,
    pendingConstraint: null,
    pendingTransform: null,
    pendingOffset: null,
    pendingAdd: null,
    pendingMove: null,
    pendingShapeAction: null,
  } as unknown as Partial<ProjectStore>)
}

function createdFeature(id: string): SketchFeature {
  const feature = resolveFeatureInstance(useProjectStore.getState().project, id)
  assert(feature != null, `feature ${id} should exist`)
  return feature
}

function placeGear(center = { x: 10, y: 12 }, radius = 20): void {
  const store = useProjectStore.getState()
  store.startAddGearPlacement()
  useProjectStore.getState().setPendingAddAnchor(center)
  useProjectStore.getState().setPendingGearRadiusAt({ x: center.x + radius, y: center.y })
}

function testGearWithoutBoreIsOneCannedFeature(): void {
  resetStore()
  placeGear()

  const beforeHistory = useProjectStore.getState().history.past.length
  const ids = useProjectStore.getState().completePendingGear()
  const state = useProjectStore.getState()

  assertEqual(ids.length, 1, 'one created id')
  assert(state.pendingAdd?.shape === 'gear' && state.pendingAdd.anchor === null, 'pending gear re-arms after creation')
  assertEqual(state.project.features.length, 1, 'one feature row')
  assertEqual(state.project.featureFolders.length, 0, 'no group folder any more')
  assertEqual(state.history.past.length, beforeHistory + 1, 'creation is one history entry')

  const gear = createdFeature(ids[0])
  assertEqual(gear.kind, 'composite', 'gear keeps the composite feature kind')
  assertEqual(gear.name, 'Gear 1', 'gear name')
  assertEqual(gear.operation, 'add', 'first machining gear is Add')
  assert(gear.canned?.kind === GEAR_CANNED_KIND, 'the gear stores canned parameters')
  const params = gear.canned ? normalizeGearCannedParams(gear.canned.params) : null
  assert(params, 'stored parameters normalize')
  assertEqual(params.teeth, 24, 'default tooth count')
  assertEqual(params.outsideRadius, 20, 'stored outside radius')
  assertEqual(params.boreDiameter, 0, 'no bore stored')

  const transform = (gear as SketchFeature & { transform?: Matrix2D }).transform
  assertEqual(transform, { a: 1, b: 0, c: 0, d: 1, e: 10, f: 12 }, 'the instance transform carries the pick')

  const shapes = resolveCannedShapeShapes(gear)
  assertEqual(shapes.length, 1, 'a gear without a bore has one outline')
  assertEqual(shapes[0].operation, 'add', 'outer outline is Add')
  assertEqual(shapes[0].profile, buildGearProfile({ ...params, center: { x: 10, y: 12 } }), 'the outline is the old command output')
  assertEqual(resolveCannedShapeProfiles(gear).length, 1, 'the read path returns one profile')
  assertEqual(
    cannedShapeSummary(gear.canned)?.key,
    'canned.gear.summary',
    'Properties gets the gear summary',
  )
  console.log('gear without bore: PASSED')
}

function testAddGearHasSubtractBoreInTheSameFeature(): void {
  resetStore()
  placeGear()
  useProjectStore.getState().setPendingGearParams({ boreDiameter: 6 })

  const beforeHistory = useProjectStore.getState().history.past.length
  const ids = useProjectStore.getState().completePendingGear()
  const state = useProjectStore.getState()

  assertEqual(ids.length, 1, 'gear and bore are one feature')
  assertEqual(state.project.features.length, 1, 'one feature row')
  assertEqual(state.project.featureFolders.length, 0, 'no group folder')
  assertEqual(state.history.past.length, beforeHistory + 1, 'one history entry')

  const gear = createdFeature(ids[0])
  const params = gear.canned ? normalizeGearCannedParams(gear.canned.params) : null
  assert(params, 'stored parameters normalize')
  assertEqual(params.boreDiameter, 6, 'bore diameter stored on the same feature')

  const shapes = resolveCannedShapeShapes(gear)
  assertEqual(shapes.length, 2, 'gear and bore are two outlines')
  assertEqual(shapes.map((shape) => shape.depth), [0, 1], 'bore nests inside the gear')
  assertEqual(shapes.map((shape) => shape.operation), ['add', 'subtract'], 'Add gear => Subtract bore')
  assertEqual(
    shapes[1].profile,
    circleProfile(10, 12, 3),
    'the bore is the circle the old separate feature made',
  )
  console.log('add gear + subtract bore: PASSED')
}

function testSubtractGearBoreIsAnAddIsland(): void {
  resetStore()
  // A base solid makes a gear drawn inside it a Subtract feature.
  useProjectStore.getState().addRectFeature('Plate', 0, 0, 100, 100, 10)
  placeGear({ x: 50, y: 50 }, 20)
  useProjectStore.getState().setPendingGearParams({ boreDiameter: 6 })

  const ids = useProjectStore.getState().completePendingGear()
  assertEqual(ids.length, 1, 'one feature')
  const gear = createdFeature(ids[0])
  assertEqual(gear.operation, 'subtract', 'a gear inside a solid is Subtract')

  const shapes = resolveCannedShapeShapes(gear)
  assertEqual(shapes.map((shape) => shape.operation), ['subtract', 'add'], 'Subtract gear => Add island bore')
  console.log('subtract gear + add island: PASSED')
}

function testRepeatedGearsUseSequentialNames(): void {
  resetStore()
  placeGear()
  useProjectStore.getState().completePendingGear()
  placeGear()
  const ids = useProjectStore.getState().completePendingGear()
  const state = useProjectStore.getState()

  assertEqual(state.project.features.length, 2, 'two gear features')
  assertEqual(createdFeature(ids[0]).name, 'Gear 2', 'second gear is Gear 2')
  console.log('repeated gear naming: PASSED')
}

function testExpandGivesTheOutlinesWithTheirOperations(): void {
  resetStore()
  placeGear()
  useProjectStore.getState().setPendingGearParams({ boreDiameter: 6 })
  const ids = useProjectStore.getState().completePendingGear()

  useProjectStore.getState().expandCannedFeature(ids[0])
  const state = useProjectStore.getState()
  // The source row stays; two plain rows are added in one grouped folder.
  assertEqual(state.project.features.length, 3, 'source plus two plain outlines')
  const plain = state.project.features
    .map((feature) => resolveFeatureInstance(state.project, feature.id))
    .filter((feature) => feature && !feature.canned && feature.id !== ids[0])
  assertEqual(plain.length, 2, 'two plain outlines')
  assertEqual(plain.map((feature) => feature?.operation), ['add', 'subtract'], 'outer Add, bore Subtract')
  assert(plain.every((feature) => feature?.kind === 'composite'), 'expanded rows are plain composites')
  const folder = state.project.featureFolders.find((candidate) => candidate.grouped)
  assert(folder, 'expansion creates a grouped folder')
  assert(plain.every((feature) => feature?.folderId === folder?.id), 'both outlines share the group folder')
  console.log('expand gear: PASSED')
}

function testInvalidBoreDoesNotCreateFeature(): void {
  resetStore()
  placeGear({ x: 10, y: 12 }, 8)
  useProjectStore.getState().setPendingGearParams({ boreDiameter: 20 })

  const ids = useProjectStore.getState().completePendingGear()
  const state = useProjectStore.getState()

  assertEqual(ids.length, 0, 'no created ids')
  assert(state.pendingAdd?.shape === 'gear', 'pending gear remains when validation fails')
  assertEqual(state.project.features.length, 0, 'invalid gear creates nothing')
  assertEqual(state.history.past.length, 0, 'invalid gear adds no history')
  console.log('invalid bore validation: PASSED')
}

function testEditingTheParametersIsOneUndoStep(): void {
  resetStore()
  placeGear()
  const ids = useProjectStore.getState().completePendingGear()
  const gear = createdFeature(ids[0])
  const params = gear.canned ? normalizeGearCannedParams(gear.canned.params) : null
  assert(params, 'stored parameters normalize')
  const before = resolveCannedShapeProfiles(gear)
  const historyBefore = useProjectStore.getState().history.past.length

  useProjectStore.getState().updateFeature(ids[0], {
    canned: { kind: GEAR_CANNED_KIND, params: { ...params, teeth: 30 } },
  })

  assertEqual(useProjectStore.getState().history.past.length, historyBefore + 1, 'an edit is one undo step')
  const edited = createdFeature(ids[0])
  const editedParams = edited.canned ? normalizeGearCannedParams(edited.canned.params) : null
  assertEqual(editedParams?.teeth, 30, 'the new tooth count is stored')
  const after = resolveCannedShapeProfiles(edited)
  assert(JSON.stringify(after) !== JSON.stringify(before), 'the outline regenerates from the new parameters')
  console.log('gear edit: PASSED')
}

function testSavedGearRegeneratesTheSameGeometry(): void {
  resetStore()
  placeGear()
  useProjectStore.getState().setPendingGearParams({ boreDiameter: 6 })
  const ids = useProjectStore.getState().completePendingGear()
  const before = resolveCannedShapeProfiles(createdFeature(ids[0]))

  const file = useProjectStore.getState().saveProject()
  const saved = JSON.parse(file) as Project
  assertEqual(
    saved.featureDefinitions[useProjectStore.getState().project.features[0].definitionId].canned?.kind,
    GEAR_CANNED_KIND,
    'the saved file carries the canned kind',
  )

  useProjectStore.getState().openProjectFromText(file, null)
  const after = resolveCannedShapeProfiles(createdFeature(ids[0]))
  assertEqual(after, before, 'save, load, regenerate: same geometry')
  console.log('gear round trip: PASSED')
}

function testOldPlainGearProjectStaysPlain(): void {
  // An old project stored a composite gear and a separate subtract circle. It
  // must keep that shape exactly: no canned data appears, and export is stable.
  const base = newProject()
  const plainProject = {
    ...base,
    featureDefinitions: {
      ...base.featureDefinitions,
      'def-old-gear': {
        id: 'def-old-gear',
        kind: 'composite' as const,
        profile: buildGearProfile({
          center: { x: 0, y: 0 },
          outsideRadius: 20,
          teeth: 16,
          wholeDepth: 4,
          flankProfile: 'involute' as const,
          pressureAngleDeg: 20,
          rootForm: 'rounded' as const,
          rootFilletRadius: 0.5,
          crestForm: 'flat' as const,
          crestRadius: 0,
          boreDiameter: 0,
        }),
        dimensions: [],
        text: null,
        stl: null,
        operation: 'add' as const,
      },
      'def-old-bore': {
        id: 'def-old-bore',
        kind: 'circle' as const,
        profile: circleProfile(0, 0, 3),
        dimensions: [],
        text: null,
        stl: null,
        operation: 'subtract' as const,
      },
    },
    features: [
      {
        id: 'old-gear',
        name: 'Gear 1',
        definitionId: 'def-old-gear',
        transform: { ...IDENTITY_MATRIX },
        constraints: [],
        folderId: null,
        z_top: 5,
        z_bottom: 0,
        authoringFace: 'top' as const,
        visible: true,
        locked: false,
      },
      {
        id: 'old-bore',
        name: 'Gear Bore 1',
        definitionId: 'def-old-bore',
        transform: { ...IDENTITY_MATRIX },
        constraints: [],
        folderId: null,
        z_top: 5,
        z_bottom: 0,
        authoringFace: 'top' as const,
        visible: true,
        locked: false,
      },
    ],
  } as Project
  resetStore(plainProject)

  const gear = resolveFeatureInstance(plainProject, 'old-gear')
  assert(gear, 'old gear resolves')
  assertEqual(gear.canned, null, 'an old gear is not canned')
  assertEqual(gear.operation, 'add', 'old gear operation is untouched')

  const file = useProjectStore.getState().saveProject()
  const saved = JSON.parse(file) as Project
  assertEqual(saved.featureDefinitions['def-old-gear'].canned, undefined, 'no canned data is invented')
  assertEqual(
    saved.featureDefinitions['def-old-gear'].profile,
    plainProject.featureDefinitions['def-old-gear'].profile,
    'the old outline is saved unchanged',
  )
  console.log('old plain gear project: PASSED')
}

testGearWithoutBoreIsOneCannedFeature()
testAddGearHasSubtractBoreInTheSameFeature()
testSubtractGearBoreIsAnAddIsland()
testRepeatedGearsUseSequentialNames()
testExpandGivesTheOutlinesWithTheirOperations()
testInvalidBoreDoesNotCreateFeature()
testSavedGearRegeneratesTheSameGeometry()
testEditingTheParametersIsOneUndoStep()
testOldPlainGearProjectStaysPlain()
