/**
 * Tests for feature transform helpers.
 *
 * Run with: npx tsx src/store/projectStoreTransform.test.ts
 */

import { defaultGrid, defaultStock, getProfileBounds, rectProfile, type SketchFeature } from '../types/project'
import { mirrorFeatureFromReference, normalizeProject, resizeFeatureFromReference } from './projectStore'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-6): boolean {
  return Math.abs(left - right) <= epsilon
}

function makeFeature(kind: 'rect' | 'stl'): SketchFeature {
  return {
    id: kind,
    name: kind,
    kind,
    folderId: null,
    stl: kind === 'stl'
      ? {
          format: 'stl',
          fileData: 'data:model/stl;base64,',
          scale: 1,
          axisSwap: 'none',
          silhouettePaths: [[
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 5 },
            { x: 0, y: 5 },
          ]],
        }
      : null,
    sketch: {
      profile: rectProfile(0, 0, 10, 5),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: kind === 'stl' ? 'model' : 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function testRegularFeatureCanResizeOneAxis(): void {
  console.log('Testing regular feature resize keeps axis scaling...')
  const resized = resizeFeatureFromReference(
    makeFeature('rect'),
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
  )

  if (!resized) throw new Error('Assertion failed: expected resized feature')
  const bounds = getProfileBounds(resized.sketch.profile)
  assert(approx(bounds.maxX - bounds.minX, 20), `expected width 20, got ${bounds.maxX - bounds.minX}`)
  assert(approx(bounds.maxY - bounds.minY, 5), `expected height 5, got ${bounds.maxY - bounds.minY}`)
}

function testStlFeatureResizeIsUniform(): void {
  console.log('Testing STL feature resize is uniform...')
  const resized = resizeFeatureFromReference(
    makeFeature('stl'),
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
  )

  if (!resized) throw new Error('Assertion failed: expected resized STL feature')
  const bounds = getProfileBounds(resized.sketch.profile)
  assert(approx(bounds.maxX - bounds.minX, 20), `expected width 20, got ${bounds.maxX - bounds.minX}`)
  assert(approx(bounds.maxY - bounds.minY, 10), `expected uniform height 10, got ${bounds.maxY - bounds.minY}`)
  assert(approx(resized.stl?.scale ?? 0, 2), `expected STL mesh scale 2, got ${resized.stl?.scale}`)
  assert(approx(Number(resized.z_bottom), 0), `expected z_bottom anchored at 0, got ${resized.z_bottom}`)
  assert(approx(Number(resized.z_top), 10), `expected z_top scaled to 10, got ${resized.z_top}`)
  const path = resized.stl?.silhouettePaths?.[0]
  assert(Boolean(path), 'expected resized STL silhouette path')
  assert(approx(path![1].x, 20), `expected silhouette path x scaled to 20, got ${path![1].x}`)
  assert(approx(path![2].y, 10), `expected silhouette path y scaled to 10, got ${path![2].y}`)
}

function testFeatureMirrorsAcrossVerticalLine(): void {
  console.log('Testing feature mirror across vertical line...')
  const mirrored = mirrorFeatureFromReference(
    makeFeature('rect'),
    { x: 5, y: -10 },
    { x: 5, y: 10 },
  )

  if (!mirrored) throw new Error('Assertion failed: expected mirrored feature')
  const bounds = getProfileBounds(mirrored.sketch.profile)
  assert(approx(bounds.minX, 0), `expected minX 0, got ${bounds.minX}`)
  assert(approx(bounds.maxX, 10), `expected maxX 10, got ${bounds.maxX}`)
  assert(approx(mirrored.sketch.profile.start.x, 10), `expected mirrored start x 10, got ${mirrored.sketch.profile.start.x}`)
  assert(approx(mirrored.sketch.origin.x, 10), `expected mirrored origin x 10, got ${mirrored.sketch.origin.x}`)
}

function testMirrorFlipsArcHandedness(): void {
  console.log('Testing mirror flips arc handedness...')
  const feature = makeFeature('rect')
  const source: SketchFeature = {
    ...feature,
    kind: 'composite',
    sketch: {
      ...feature.sketch,
      profile: {
        start: { x: 0, y: 0 },
        closed: false,
        segments: [
          {
            type: 'arc',
            to: { x: 10, y: 0 },
            center: { x: 5, y: 5 },
            clockwise: true,
          },
        ],
      },
    },
  }
  const mirrored = mirrorFeatureFromReference(source, { x: 5, y: -10 }, { x: 5, y: 10 })
  if (!mirrored) throw new Error('Assertion failed: expected mirrored arc feature')
  const segment = mirrored.sketch.profile.segments[0]
  if (segment.type !== 'arc') throw new Error('Assertion failed: expected mirrored segment to remain an arc')
  assert(segment.clockwise === false, 'expected mirrored arc clockwise flag to flip')
  assert(approx(mirrored.sketch.profile.start.x, 10), `expected mirrored arc start x 10, got ${mirrored.sketch.profile.start.x}`)
  assert(approx(segment.to.x, 0), `expected mirrored arc end x 0, got ${segment.to.x}`)
}

function testStlMirrorTransformsSilhouette(): void {
  console.log('Testing STL mirror transforms silhouette...')
  const mirrored = mirrorFeatureFromReference(
    makeFeature('stl'),
    { x: 5, y: -10 },
    { x: 5, y: 10 },
  )

  if (!mirrored) throw new Error('Assertion failed: expected mirrored STL feature')
  assert(approx(mirrored.stl?.scale ?? 0, 1), `expected STL mesh scale 1, got ${mirrored.stl?.scale}`)
  const path = mirrored.stl?.silhouettePaths?.[0]
  assert(Boolean(path), 'expected mirrored STL silhouette path')
  assert(approx(path![0].x, 10), `expected silhouette path x mirrored to 10, got ${path![0].x}`)
  assert(approx(path![1].x, 0), `expected silhouette path x mirrored to 0, got ${path![1].x}`)
}

function testLegacyModelMovesToAssetTable(): void {
  console.log('Testing legacy STL model migrates to project asset table...')
  const stl = `solid tri
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 2 0 0
      vertex 0 3 4
    endloop
  endfacet
endsolid tri
`
  const project = normalizeProject({
    version: '1.0',
    meta: {
      name: 'legacy-model',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      units: 'mm',
      showFeatureInfo: true,
      showDimensions: true,
      maxTravelZ: 10,
      operationClearanceZ: 3,
      clampClearanceXY: 2,
      clampClearanceZ: 2,
      machineDefinitions: [],
      selectedMachineId: null,
    },
    grid: defaultGrid('mm'),
    stock: defaultStock(10, 10, 5, 'mm'),
    origin: { name: 'Origin', x: 0, y: 0, z: 5, visible: true },
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    features: [makeFeature('stl')].map((feature) => ({
      ...feature,
      stl: {
        ...feature.stl!,
        fileData: `data:model/stl;base64,${btoa(stl)}`,
      },
    })),
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  })

  const model = project.features[0]
  assert(model.stl?.meshAssetId !== undefined, 'legacy model should reference a model asset')
  assert(model.stl?.fileData === undefined, 'legacy source file should be removed after migration')
  assert(model.stl?.mesh === undefined, 'transient inline mesh should not be retained')
  assert(Object.keys(project.modelAssets).length === 1, 'model asset should be stored once at project level')
  assert(project.modelAssets[model.stl!.meshAssetId!] !== undefined, 'referenced model asset should exist')
}

testRegularFeatureCanResizeOneAxis()
testStlFeatureResizeIsUniform()
testFeatureMirrorsAcrossVerticalLine()
testMirrorFlipsArcHandedness()
testStlMirrorTransformsSilhouette()
testLegacyModelMovesToAssetTable()

console.log('projectStore transform tests passed')
