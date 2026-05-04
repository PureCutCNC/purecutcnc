/**
 * Tests for rest operation creation behavior.
 *
 * Run with: npx tsx src/store/createRestOperation.test.ts
 */

import { useProjectStore } from './projectStore'
import {
  newProject,
  polygonProfile,
  rectProfile,
  type FeatureFolder,
  type Operation,
  type Project,
  type SketchFeature,
} from '../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeFeature(
  id: string,
  name: string,
  operation: SketchFeature['operation'],
  profile = rectProfile(0, 0, 10, 5),
): SketchFeature {
  return {
    id,
    name,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeProject(): { project: Project; operation: Operation; machiningId: string; regionIds: string[] } {
  const machiningId = 'f-machining'
  const regionIds = ['f-region-a', 'f-region-b']
  const machiningFeature = makeFeature(machiningId, 'Machining Feature', 'subtract')
  const regionA = makeFeature(
    regionIds[0],
    'Region A',
    'region',
    polygonProfile([
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 8, y: 8 },
      { x: 0, y: 8 },
    ]),
  )
  const regionB = makeFeature(
    regionIds[1],
    'Region B',
    'region',
    polygonProfile([
      { x: 10, y: 0 },
      { x: 16, y: 0 },
      { x: 16, y: 6 },
      { x: 10, y: 6 },
    ]),
  )

  const operation: Operation = {
    id: 'op-source',
    name: 'Edge Route Inside',
    kind: 'edge_route_inside',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: {
      source: 'features',
      featureIds: [machiningId, ...regionIds],
    },
    toolRef: 't1',
    stepdown: 1,
    stepover: 0.5,
    feed: 100,
    plungeFeed: 50,
    rpm: 12000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'feature_first',
  }

  const project: Project = {
    ...newProject('Edge rest test'),
    tools: [
      {
        id: 't1',
        name: 'Tool 1',
        units: 'mm' as const,
        type: 'flat_endmill' as const,
        diameter: 6,
        vBitAngle: null,
        flutes: 2,
        material: 'carbide' as const,
        defaultRpm: 12000,
        defaultFeed: 100,
        defaultPlungeFeed: 50,
        defaultStepdown: 1,
        defaultStepover: 0.5,
        maxCutDepth: 0,
      },
    ],
    features: [machiningFeature, regionA, regionB],
    featureFolders: [] as FeatureFolder[],
    featureTree: [
      { type: 'feature', featureId: machiningId },
      { type: 'feature', featureId: regionIds[0] },
      { type: 'feature', featureId: regionIds[1] },
    ],
    operations: [operation],
  }

  return { project, operation, machiningId, regionIds }
}

function testEdgeRestCreatesGeneratedRegionFilters(): void {
  console.log('Testing edge rest operation creates generated region filters...')
  const { project, operation, machiningId, regionIds } = makeProject()
  useProjectStore.setState({
    project,
    history: { past: [], future: [], transactionStart: null },
  })

  const result = useProjectStore.getState().createRestOperation(operation.id)
  assert(result.operationId !== null, 'expected a rest operation to be created')
  assert(result.regionIds.length === 2, `expected 2 rest regions, got ${result.regionIds.length}`)

  const nextProject = useProjectStore.getState().project
  const restOperation = nextProject.operations.find((item) => item.id === result.operationId)
  assert(restOperation !== undefined, 'expected created operation to exist')
  assert(restOperation.toolRef === null, 'expected rest operation to clear toolRef')
  assert(restOperation.target.source === 'features', 'expected rest operation target to stay feature-based')
  assert(
    restOperation.target.featureIds[0] === machiningId,
    'expected machining feature to remain first in target',
  )
  assert(
    restOperation.target.featureIds.length === 3,
    `expected 3 target ids, got ${restOperation.target.featureIds.length}`,
  )

  const restFolder = nextProject.featureFolders.find((folder) => folder.name === 'Edge Route Inside Rest Regions')
  assert(restFolder !== undefined, 'expected rest-region folder to exist')
  assert(restFolder?.section === 'regions', 'expected rest-region folder to live in the Regions section')

  const restFeatures = result.regionIds.map((id) => nextProject.features.find((feature) => feature.id === id) ?? null)
  assert(restFeatures.every((feature) => feature !== null), 'expected all rest region features to exist')
  assert(
    restFeatures.every((feature) => feature?.folderId === restFolder?.id),
    'expected rest regions to be placed in the rest-region folder',
  )
  assert(
    restFeatures.every((feature) => feature?.operation === 'region'),
    'expected rest region features to be region features',
  )
  assert(
    restFeatures.every((feature) => !regionIds.includes(feature!.id)),
    'expected rest region IDs to differ from the source region IDs',
  )
  assert(
    restOperation.target.featureIds[1] === result.regionIds[0]
      && restOperation.target.featureIds[2] === result.regionIds[1],
    'expected rest region IDs to be appended after machining features',
  )
}

testEdgeRestCreatesGeneratedRegionFilters()

console.log('createRestOperation tests passed')
