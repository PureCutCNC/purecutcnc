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

/** Project-format migration and strict 3.0 serialization tests. */

import {
  IDENTITY_MATRIX,
  defaultGrid,
  defaultStock,
  getProfileBounds,
  newProject,
  rectProfile,
  type Matrix2D,
  type SketchFeature,
} from '../types/project'
import { computeMeshBounds, serializeImportedMesh, type ImportedTriangleMesh } from '../engine/importedMesh'
import { projectWithFeatures, resolvedFeature } from '../test/projectFixtures'
import {
  decodeProjectFormat,
  normalizeProject,
  type ProjectFormatInput,
} from './helpers/projectFormat'
import { gcOrphanedDefinitions } from './helpers/featureDefinitions'
import { applyMatrixToPoint, resolvedProjectFeatures } from './helpers/resolveFeatures'
import { transformProfileAffine } from './helpers/transform'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-9): boolean {
  return Math.abs(left - right) <= epsilon
}

function makeRectFeature(id: string, operation: SketchFeature['operation'] = 'add'): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(10, 20, 30, 15),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
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

function makeLegacyProject(
  version: '1.0' | '2.0' | '2.1',
  features: SketchFeature[],
): ProjectFormatInput {
  return {
    version,
    meta: {
      name: 'legacy',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      units: 'mm',
      showFeatureInfo: true,
      showDimensions: true,
      copyMode: 'reference',
      maxTravelZ: 50,
      operationClearanceZ: 5,
      clampClearanceXY: 2,
      clampClearanceZ: 5,
      machineDefinitions: [],
      selectedMachineId: null,
    },
    grid: defaultGrid('mm'),
    stock: defaultStock(200, 200, 20, 'mm'),
    origin: { name: 'Origin', x: 0, y: 200, z: 20, visible: true },
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    featureDefinitions: {},
    features,
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  }
}

function makeImportedModelAsset(): ReturnType<typeof serializeImportedMesh> {
  const positions = new Float32Array([
    0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 1, 0,
    0, 0, 3, 2, 0, 3, 2, 1, 3, 0, 1, 3,
  ])
  const index = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ])
  const mesh: ImportedTriangleMesh = {
    positions,
    index,
    bounds: computeMeshBounds(positions),
  }
  return serializeImportedMesh(mesh, 'stl')
}

function makeLegacyImportedModel(id: string): SketchFeature & { transform: Matrix2D } {
  const scale = 0.5
  const existingTransform: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 3, f: 2 }
  const sketchPlacement: Matrix2D = { a: 0, b: 1, c: -1, d: 0, e: 10, f: -4 }
  const placement: Matrix2D = {
    ...sketchPlacement,
    e: sketchPlacement.e + existingTransform.e,
    f: sketchPlacement.f + existingTransform.f,
  }
  const localProfile = rectProfile(0, 0, 2 * scale, scale)
  const transformPoint = (point: { x: number, y: number }) => applyMatrixToPoint(placement, point)
  const silhouettePaths = [[
    { x: 0, y: 0 },
    { x: 2 * scale, y: 0 },
    { x: 2 * scale, y: scale },
    { x: 0, y: scale },
  ].map(transformPoint)]
  return {
    id,
    name: id,
    kind: 'stl',
    folderId: null,
    transform: existingTransform,
    stl: {
      format: 'stl',
      scale,
      axisSwap: 'none',
      meshAssetId: 'legacy-model-asset',
      silhouettePaths,
    },
    sketch: {
      profile: transformProfileAffine(localProfile, transformPoint),
      origin: { x: 10, y: -4 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: 4,
    z_bottom: 1,
    visible: true,
    locked: false,
  }
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.error(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

test('new projects use format 3.0 and lightweight rows', () => {
  const project = newProject('Current')
  assert(project.version === '3.0', `expected 3.0, got ${project.version}`)
  assert(Object.keys(project.featureDefinitions).length === 0, 'new project definitions should be empty')
})

for (const version of ['1.0', '2.0', '2.1'] as const) {
  test(`legacy ${version} rows convert one way into definitions and instances`, () => {
    const decoded = decodeProjectFormat(makeLegacyProject(version, [makeRectFeature(`rect-${version}`)]))
    const row = decoded.project.features[0] as unknown as Record<string, unknown>
    assert(decoded.convertedLegacy, 'legacy input should report conversion')
    assert(decoded.sourceVersion === version, 'source version should be retained in decode metadata')
    assert(decoded.project.version === '3.0', 'decoded project should be current')
    assert(!('sketch' in row), 'converted instance must not retain baked sketch geometry')
    assert(!('operation' in row), 'converted instance must not retain definition-owned operation')
    assert(decoded.project.features[0].definitionId === `rect-${version}`, 'instance should reference definition')
    assert(decoded.project.featureDefinitions[`rect-${version}`].operation === 'add', 'definition owns operation')
    assert(resolvedFeature(decoded.project, `rect-${version}`).sketch.profile.start.x === 10, 'geometry should resolve')
  })
}

for (const version of ['1.0', '2.0', '2.1'] as const) {
  test(`legacy ${version} imported-model placement becomes a strict instance transform`, () => {
    const feature = makeLegacyImportedModel(`model-${version}`)
    const input = makeLegacyProject(version, [feature])
    input.modelAssets = { 'legacy-model-asset': makeImportedModelAsset() }
    const decoded = decodeProjectFormat(input).project
    const instance = decoded.features[0]
    const row = instance as unknown as Record<string, unknown>
    const expectedTransform: Matrix2D = { a: 0, b: 1, c: -1, d: 0, e: 13, f: -2 }

    assert(!('sketch' in row), 'converted imported-model instance must be lightweight')
    assert(Object.keys(decoded.modelAssets).length === 1, 'persisted mesh asset should not be duplicated')
    for (const component of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
      assert(approx(instance.transform[component], expectedTransform[component]),
        `legacy placement ${component} should compose`)
    }
    assert(decoded.featureDefinitions[instance.definitionId].stl?.scale === 0.5, 'STL scale should be retained')
    assert(instance.z_top === 4 && instance.z_bottom === 1, 'Z range should be retained')

    const resolved = resolvedFeature(decoded, feature.id)
    const expectedBounds = getProfileBounds(feature.sketch.profile)
    const resolvedBounds = getProfileBounds(resolved.sketch.profile)
    for (const bound of ['minX', 'maxX', 'minY', 'maxY'] as const) {
      assert(approx(resolvedBounds[bound], expectedBounds[bound]),
        `resolved profile ${bound} should retain its legacy world coordinate`)
    }
    const expectedSilhouette = feature.stl?.silhouettePaths?.[0] ?? []
    const resolvedSilhouette = resolved.stl?.silhouettePaths?.[0] ?? []
    assert(resolvedSilhouette.length === expectedSilhouette.length, 'resolved silhouette length should be retained')
    resolvedSilhouette.forEach((point, index) => {
      assert(approx(point.x, expectedSilhouette[index].x) && approx(point.y, expectedSilhouette[index].y),
        `resolved silhouette point ${index} should retain its legacy world coordinate`)
    })

    const reopened = decodeProjectFormat(JSON.parse(JSON.stringify(decoded))).project
    for (const component of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
      assert(approx(reopened.features[0].transform[component], instance.transform[component]),
        `strict save/reopen should retain transform ${component}`)
    }
    assert(Object.keys(reopened.modelAssets).length === 1, 'save/reopen should retain one mesh asset')
  })
}

test('legacy imported-model conversion rejects non-invertible placement', () => {
  const feature = makeLegacyImportedModel('invalid-model')
  feature.transform = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }
  const input = makeLegacyProject('2.1', [feature])
  input.modelAssets = { 'legacy-model-asset': makeImportedModelAsset() }
  let message = ''
  try {
    decodeProjectFormat(input)
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert(message.includes('non-invertible placement'), `expected clear placement error, got: ${message}`)
})

test('current 3.0 decode is idempotent and is not reported as legacy', () => {
  const current = projectWithFeatures(newProject('Current', 'mm'), [makeRectFeature('rect-current')])
  const decoded = decodeProjectFormat(JSON.parse(JSON.stringify(current)))
  assert(!decoded.convertedLegacy, 'current project should not report conversion')
  assert(decoded.sourceVersion === '3.0', 'source version should remain 3.0')
  assert(JSON.stringify(decoded.project) === JSON.stringify(normalizeProject(current)), 'normalization should be idempotent')
})

test('serialized 3.0 features contain only instance-owned fields', () => {
  const current = projectWithFeatures(newProject('Serialized', 'mm'), [makeRectFeature('rect-serialized')])
  const parsed = JSON.parse(JSON.stringify(current)) as Record<string, unknown>
  const rows = parsed.features as Array<Record<string, unknown>>
  const row = rows[0]
  for (const forbidden of ['sketch', 'kind', 'operation', 'regionMaskMode', 'text', 'stl']) {
    assert(!(forbidden in row), `serialized instance must not contain ${forbidden}`)
  }
  assert(typeof row.definitionId === 'string', 'serialized instance should contain definitionId')
  assert(typeof row.transform === 'object', 'serialized instance should contain transform')
  assert(Array.isArray(row.constraints), 'serialized instance should contain constraints')
})

test('open legacy profiles normalize operation on the definition', () => {
  const feature = makeRectFeature('open', 'subtract')
  feature.sketch.profile = {
    start: { x: 0, y: 0 },
    segments: [{ type: 'line', to: { x: 10, y: 0 } }],
    closed: false,
  }
  const decoded = decodeProjectFormat(makeLegacyProject('2.1', [feature])).project
  assert(decoded.featureDefinitions.open.operation === 'line', 'open definition should become line')
  assert(resolvedFeature(decoded, 'open').operation === 'line', 'resolved operation should match definition')
})

test('legacy four-arc circles normalize before definition creation', () => {
  const feature = makeRectFeature('circle')
  feature.kind = 'circle'
  feature.sketch.profile = {
    start: { x: 60, y: 50 },
    segments: [
      { type: 'arc', to: { x: 50, y: 60 }, center: { x: 50, y: 50 }, clockwise: true },
      { type: 'arc', to: { x: 40, y: 50 }, center: { x: 50, y: 50 }, clockwise: true },
      { type: 'arc', to: { x: 50, y: 40 }, center: { x: 50, y: 50 }, clockwise: true },
      { type: 'arc', to: { x: 60, y: 50 }, center: { x: 50, y: 50 }, clockwise: true },
    ],
    closed: true,
  }
  const project = decodeProjectFormat(makeLegacyProject('1.0', [feature])).project
  const definition = project.featureDefinitions.circle
  assert(definition.profile.segments.length === 1, 'definition should contain native circle')
  assert(definition.profile.segments[0].type === 'circle', 'definition segment should be circle')
  assert(resolvedFeature(project, 'circle').sketch.profile.segments[0].type === 'circle', 'resolver should match')
})

test('operation targets and feature-tree IDs survive legacy conversion', () => {
  const input = makeLegacyProject('2.1', [makeRectFeature('target')])
  input.featureTree = [{ type: 'feature', featureId: 'target' }]
  input.operations = [{
    id: 'op-1',
    name: 'Pocket',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: false,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['target'] },
    toolRef: null,
    stepdown: 1,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 5,
    maxCarveDepth: 20,
  }]
  const project = decodeProjectFormat(input).project
  assert(project.featureTree.some((entry) => entry.type === 'feature' && entry.featureId === 'target'), 'tree ID')
  const target = project.operations[0].target
  assert(target.source === 'features', 'operation target source')
  assert(target.featureIds.includes('target'), 'operation target ID')
})

test('missing or malformed definitions, transforms, constraints, and baked 3.0 rows are rejected', () => {
  const valid = projectWithFeatures(newProject('Validation', 'mm'), [makeRectFeature('valid')])
  const missingDefinition = structuredClone(valid)
  missingDefinition.features[0].definitionId = 'missing'
  const malformedDefinition = structuredClone(valid) as unknown as Record<string, unknown>
  const malformedDefinitions = malformedDefinition.featureDefinitions as Record<string, Record<string, unknown>>
  malformedDefinitions.valid.profile = null
  const invalidTransform = structuredClone(valid) as unknown as Record<string, unknown>
  ;((invalidTransform.features as Array<Record<string, unknown>>)[0]).transform = { ...IDENTITY_MATRIX, e: Number.NaN }
  const invalidConstraints = structuredClone(valid) as unknown as Record<string, unknown>
  ;((invalidConstraints.features as Array<Record<string, unknown>>)[0]).constraints = null
  const bakedCurrent = structuredClone(valid) as unknown as Record<string, unknown>
  ;((bakedCurrent.features as Array<Record<string, unknown>>)[0]).sketch = makeRectFeature('baked').sketch

  for (const [expectedMessage, input] of [
    ['definition', missingDefinition],
    ['profile', malformedDefinition],
    ['transform', invalidTransform],
    ['constraints', invalidConstraints],
    ['legacy baked', bakedCurrent],
  ] as const) {
    let message = ''
    try {
      decodeProjectFormat(input)
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error)
    }
    assert(message.toLowerCase().includes(expectedMessage), `${expectedMessage} should fail clearly, got: ${message}`)
  }
})

test('legacy feature-based stock converts to a lightweight source instance', () => {
  const source = makeRectFeature('stock-source')
  const legacy = makeLegacyProject('2.1', []) as unknown as Record<string, unknown>
  const stock = legacy.stock as Record<string, unknown>
  stock.sourceFeatureId = source.id
  stock.sourceFeature = source

  const decoded = decodeProjectFormat(legacy)
  const converted = decoded.project.stock.sourceFeature
  assert(converted !== null && converted !== undefined, 'stock source should be retained')
  assert(!('sketch' in (converted as unknown as Record<string, unknown>)), 'stock source must be lightweight')
  assert(converted.definitionId === source.id, 'stock source should reference its migrated definition')
  assert(decoded.project.featureDefinitions[source.id].profile.start.x === source.sketch.profile.start.x,
    'stock source definition should retain its geometry')
})

test('definition GC retains a feature-based stock source definition', () => {
  const current = projectWithFeatures(newProject('Stock GC', 'mm'), [
    makeRectFeature('stock-source'),
    makeRectFeature('ordinary'),
  ])
  const source = current.features[0]
  const collected = gcOrphanedDefinitions(
    current.features.slice(1),
    current.featureDefinitions,
    source,
  )
  assert(collected.definitions[source.definitionId] !== undefined,
    'stock source definition should survive feature-row garbage collection')
})

test('linked-instance serialization is materially smaller than baked rows', () => {
  const source = makeRectFeature('linked-0')
  const current = projectWithFeatures(newProject('Linked scale', 'mm'), [source])
  const original = current.features[0]
  current.features = Array.from({ length: 500 }, (_, index) => ({
    ...original,
    id: `linked-${index}`,
    name: `Linked ${index}`,
    transform: { ...IDENTITY_MATRIX, e: index * 2 },
    constraints: [],
  }))
  const baked = makeLegacyProject('2.1', Array.from({ length: 500 }, (_, index) => ({
    ...source,
    id: `linked-${index}`,
    name: `Linked ${index}`,
  })))
  const currentBytes = JSON.stringify(current).length
  const bakedBytes = JSON.stringify(baked).length
  assert(currentBytes < bakedBytes * 0.6, `expected compact format; current=${currentBytes}, baked=${bakedBytes}`)
  const currentLoadStart = performance.now()
  const decodedCurrent = decodeProjectFormat(JSON.parse(JSON.stringify(current))).project
  const currentLoadMs = performance.now() - currentLoadStart
  const legacyLoadStart = performance.now()
  decodeProjectFormat(JSON.parse(JSON.stringify(baked)))
  const legacyLoadMs = performance.now() - legacyLoadStart
  const resolveStart = performance.now()
  const resolved = resolvedProjectFeatures(decodedCurrent)
  const resolveMs = performance.now() - resolveStart
  assert(resolved.length === current.features.length, 'every linked instance should resolve in the bulk read pass')
  console.log(`     linked-size current=${currentBytes} baked=${bakedBytes}`)
  console.log(`     linked-load current=${currentLoadMs.toFixed(2)}ms legacy=${legacyLoadMs.toFixed(2)}ms resolve=${resolveMs.toFixed(2)}ms`)
})

console.log(`\nProject format migration: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
