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
 * Tests for Feature References migration (slice 01: model, versioning, migration).
 *
 * Run with: npx tsx src/store/featureReferencesMigration.test.ts
 */

import {
  newProject,
  rectProfile,
  circleProfile,
  defaultStock,
  defaultGrid,
  type Project,
  type SketchFeature,
  IDENTITY_MATRIX,
} from '../types/project'
import { normalizeProject } from './projectStore'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-6): boolean {
  return Math.abs(left - right) <= epsilon
}

// ── Helpers ────────────────────────────────────────────────────────

function makeRectFeature(
  id: string,
  name = 'Rect',
  operation: SketchFeature['operation'] = 'add',
): SketchFeature {
  return {
    id,
    name,
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

function makeCircleFeature(
  id: string,
  name = 'Circle',
  operation: SketchFeature['operation'] = 'add',
): SketchFeature {
  return {
    id,
    name,
    kind: 'circle',
    folderId: null,
    sketch: {
      profile: circleProfile(50, 50, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: 3,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeStlFeature(id: string, name = 'Model'): SketchFeature {
  return {
    id,
    name,
    kind: 'stl',
    folderId: null,
    stl: {
      format: 'stl',
      scale: 2,
      axisSwap: 'none',
      meshAssetId: 'mesh-abc123',
      fileData: 'data:model/stl;base64,AAAA',
    },
    sketch: {
      profile: rectProfile(0, 0, 50, 50),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: 10,
    z_bottom: -2,
    visible: true,
    locked: false,
  }
}

function makeOpenProfileFeature(
  id: string,
  name = 'OpenProfile',
  operation: SketchFeature['operation'] = 'subtract',
): SketchFeature {
  return {
    id,
    name,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 10, y: 0 } },
          { type: 'line', to: { x: 10, y: 5 } },
        ],
        closed: false,
      },
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

function make4ArcCircleFeature(id: string, name = '4ArcCircle'): SketchFeature {
  const cx = 50
  const cy = 50
  const r = 10
  // Build a 4-arc circle: 4 quarter-circle arcs
  const p0 = { x: cx + r, y: cy }       // right
  const p1 = { x: cx, y: cy + r }       // bottom
  const p2 = { x: cx - r, y: cy }       // left
  const p3 = { x: cx, y: cy - r }       // top
  return {
    id,
    name,
    kind: 'circle',
    folderId: null,
    sketch: {
      profile: {
        start: p0,
        segments: [
          { type: 'arc', to: p1, center: { x: cx, y: cy }, clockwise: true },
          { type: 'arc', to: p2, center: { x: cx, y: cy }, clockwise: true },
          { type: 'arc', to: p3, center: { x: cx, y: cy }, clockwise: true },
          { type: 'arc', to: p0, center: { x: cx, y: cy }, clockwise: true },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 3,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeStlWithTransientMeshFeature(id: string, name = 'TransientSTL'): SketchFeature {
  // Legacy STL feature with raw fileData and no meshAssetId — the
  // normalization must migrate this into modelAssets and drop the transient fields.
  // Use a minimal valid STL triangle so the import pipeline succeeds.
  const stlText = `solid tri
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 2 0 0
    vertex 0 3 4
  endloop
endfacet
endsolid tri
`
  return {
    id,
    name,
    kind: 'stl',
    folderId: null,
    stl: {
      format: 'stl',
      fileData: `data:model/stl;base64,${btoa(stlText)}`,
      scale: 3,
      axisSwap: 'none',
    },
    sketch: {
      profile: rectProfile(0, 0, 50, 50),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: 10,
    z_bottom: -2,
    visible: true,
    locked: false,
  }
}

function makeLegacyProject(features: SketchFeature[]): Project {
  return {
    version: '1.0',
    meta: {
      name: 'legacy',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      units: 'mm',
      showFeatureInfo: true,
      showDimensions: true,
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
    modelAssets: { 'mesh-abc123': { storage: 'mesh-v1', vertexCount: 0, triangleCount: 0, positions: '', indices: '', bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 } } },
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

// ── Tests ──────────────────────────────────────────────────────────

function testNewProjectHasFeatureDefinitions(): void {
  console.log('1. newProject() has the new model shape...')
  const project = newProject('Test')
  assert(project.version === '2.0', `expected version '2.0', got '${project.version}'`)
  assert(
    typeof project.featureDefinitions === 'object' && project.featureDefinitions !== null,
    'expected featureDefinitions to be an object',
  )
  assert(
    Object.keys(project.featureDefinitions).length === 0,
    `expected empty featureDefinitions, got ${Object.keys(project.featureDefinitions).length}`,
  )
  console.log('   ✓ newProject has version 2.0 and empty featureDefinitions')
}

function testLegacySingleFeatureMigrates(): void {
  console.log('2. Legacy single-feature project migrates to one definition...')
  const feature = makeRectFeature('f-rect-01', 'Rectangle')
  const legacy = makeLegacyProject([feature])
  const normalized = normalizeProject(legacy)

  assert(normalized.version === '2.0', `expected version '2.0', got '${normalized.version}'`)
  const defs = normalized.featureDefinitions
  const defKeys = Object.keys(defs)
  assert(defKeys.length === 1, `expected 1 definition, got ${defKeys.length}`)
  assert(defKeys[0] === 'f-rect-01', `expected definition id 'f-rect-01', got '${defKeys[0]}'`)

  const def = defs['f-rect-01']
  assert(def.kind === 'rect', `expected kind 'rect', got '${def.kind}'`)
  assert(def.operation === 'add', `expected operation 'add', got '${def.operation}'`)
  // Profile should match
  const prof = def.profile
  assert(approx(prof.start.x, 10), `expected profile start.x 10, got ${prof.start.x}`)
  assert(approx(prof.start.y, 20), `expected profile start.y 20, got ${prof.start.y}`)
  assert(prof.segments.length === 4, `expected 4 profile segments, got ${prof.segments.length}`)

  // Feature array should still have the feature
  assert(normalized.features.length === 1, `expected 1 feature, got ${normalized.features.length}`)
  assert(normalized.features[0].id === 'f-rect-01', `expected feature id 'f-rect-01', got '${normalized.features[0].id}'`)

  console.log('   ✓ single feature migrated to 1 definition + 1 feature')
}

function testLegacyMultiFeatureMigratesWithUniqueDefs(): void {
  console.log('3. Legacy multi-feature project migrates with unique definitions...')
  const rect = makeRectFeature('f-001', 'Rect A')
  const circ = makeCircleFeature('f-002', 'Circle B')
  const legacy = makeLegacyProject([rect, circ])
  const normalized = normalizeProject(legacy)

  assert(normalized.version === '2.0', `expected version '2.0', got '${normalized.version}'`)
  const defs = normalized.featureDefinitions
  const defKeys = Object.keys(defs)
  assert(defKeys.length === 2, `expected 2 definitions, got ${defKeys.length}`)

  // Both definition IDs should exist
  assert('f-001' in defs, 'expected definition f-001 to exist')
  assert('f-002' in defs, 'expected definition f-002 to exist')

  // Kind checks
  assert(defs['f-001'].kind === 'rect', `expected rect kind, got '${defs['f-001'].kind}'`)
  assert(defs['f-002'].kind === 'circle', `expected circle kind, got '${defs['f-002'].kind}'`)

  // Feature IDs preserved
  const featureIds = normalized.features.map((f) => f.id)
  assert(featureIds.includes('f-001'), 'expected feature f-001 in features array')
  assert(featureIds.includes('f-002'), 'expected feature f-002 in features array')

  console.log('   ✓ multi-feature project migrated with unique definitions and preserved IDs')
}

function testOperationTargetsPreservedAfterMigration(): void {
  console.log('4. Operation targets still reference valid migrated instance IDs...')
  const feature = makeRectFeature('f-op-target', 'Target')
  const legacy = makeLegacyProject([feature])
  // Add an operation that targets this feature
  legacy.operations = [{
    id: 'op-001',
    name: 'Pocket',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: false,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['f-op-target'] },
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

  const normalized = normalizeProject(legacy)
  assert(normalized.operations.length === 1, `expected 1 operation, got ${normalized.operations.length}`)
  const op = normalized.operations[0]
  assert(
    op.target.source === 'features',
    `expected target source 'features', got '${op.target.source}'`,
  )
  assert(
    op.target.featureIds.includes('f-op-target'),
    `expected operation to target 'f-op-target', got [${op.target.featureIds.join(',')}]`,
  )
  // Definition should also exist
  assert('f-op-target' in normalized.featureDefinitions, 'expected definition f-op-target to exist')

  console.log('   ✓ operation targets preserved after migration')
}

function testFeatureTreeEntriesPreservedAfterMigration(): void {
  console.log('5. Feature tree entries still reference valid migrated instance IDs...')
  const feature = makeRectFeature('f-tree-01', 'Tree Item')
  const legacy = makeLegacyProject([feature])
  legacy.featureTree = [{ type: 'feature', featureId: 'f-tree-01' }]

  const normalized = normalizeProject(legacy)
  assert(normalized.featureTree.length >= 1, `expected at least 1 tree entry, got ${normalized.featureTree.length}`)

  const featureEntries = normalized.featureTree.filter((e) => e.type === 'feature')
  const hasTreeFeature = featureEntries.some(
    (e) => e.type === 'feature' && e.featureId === 'f-tree-01',
  )
  assert(hasTreeFeature, 'expected feature tree entry for f-tree-01')

  console.log('   ✓ feature tree entries preserved after migration')
}

function testReNormalizationIsIdempotent(): void {
  console.log('6. Re-normalizing an already-migrated project is idempotent...')
  const feature = makeRectFeature('f-idem-01', 'Idempotent')
  const legacy = makeLegacyProject([feature])
  const first = normalizeProject(legacy)

  assert(first.version === '2.0', `expected first pass version '2.0'`)
  const firstDefCount = Object.keys(first.featureDefinitions).length
  assert(firstDefCount === 1, `expected 1 definition after first pass, got ${firstDefCount}`)

  // Second normalization — should not duplicate
  const second = normalizeProject(first)
  const secondDefCount = Object.keys(second.featureDefinitions).length
  assert(secondDefCount === 1, `expected 1 definition after second pass, got ${secondDefCount}`)
  assert(
    second.featureDefinitions['f-idem-01'] !== undefined,
    'expected definition f-idem-01 to still exist',
  )
  assert(second.version === '2.0', `expected version '2.0' after second pass`)

  console.log('   ✓ re-normalization is idempotent')
}

function testStlModelAssetReferencesSurviveMigration(): void {
  console.log('7. Imported STL/model asset references survive migration...')
  const stlFeature = makeStlFeature('f-stl-01', 'Imported Model')
  const legacy = makeLegacyProject([stlFeature])

  // Verify the legacy feature has the expected STL data before migration
  const legacyFeature = legacy.features[0]
  assert(legacyFeature.stl?.meshAssetId === 'mesh-abc123', 'expected meshAssetId before migration')

  const normalized = normalizeProject(legacy)

  // Definition should preserve STL data with the mesh asset reference
  const def = normalized.featureDefinitions['f-stl-01']
  assert(def !== undefined, 'expected definition f-stl-01 to exist')
  assert(def.stl !== null && def.stl !== undefined, 'expected definition to have STL data')
  assert(def.stl?.meshAssetId === 'mesh-abc123', `expected meshAssetId 'mesh-abc123', got '${def.stl?.meshAssetId}'`)
  assert(def.stl?.scale === 2, `expected STL scale 2, got ${def.stl?.scale}`)
  assert(def.operation === 'model', `expected operation 'model', got '${def.operation}'`)

  // modelAssets should still contain the mesh
  assert('mesh-abc123' in normalized.modelAssets, 'expected mesh-abc123 in modelAssets')

  // Feature should still have the STL data for backwards compat
  const migratedFeature = normalized.features[0]
  assert(migratedFeature.stl?.meshAssetId === 'mesh-abc123', 'expected feature to still have meshAssetId')

  console.log('   ✓ STL/model asset references survive migration')
}

function testRoundTripPreservesMigratedShape(): void {
  console.log('8. Save/load round trip preserves the migrated shape...')
  const feature = makeRectFeature('f-rt-01', 'Roundtrip')
  const legacy = makeLegacyProject([feature])
  legacy.operations = [{
    id: 'op-rt-01',
    name: 'Edge Route',
    kind: 'edge_route_inside',
    pass: 'finish',
    enabled: true,
    showToolpath: false,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['f-rt-01'] },
    toolRef: null,
    stepdown: 0.5,
    stepover: 0.2,
    feed: 500,
    plungeFeed: 200,
    rpm: 24000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: false,
    carveDepth: 5,
    maxCarveDepth: 20,
  }]

  // First normalization
  const first = normalizeProject(legacy)

  // Simulate save/load: serialize → parse → re-normalize
  const serialized = JSON.stringify(first)
  const parsed = JSON.parse(serialized) as Project
  // Parsed project may have version '2.0' but we need to check migration handles it
  const reloaded = normalizeProject(parsed)

  // Verify definitions
  assert(reloaded.version === '2.0', `expected version '2.0' after round trip`)
  const defKeys = Object.keys(reloaded.featureDefinitions)
  assert(defKeys.length === 1, `expected 1 definition after round trip, got ${defKeys.length}`)
  assert('f-rt-01' in reloaded.featureDefinitions, 'expected definition f-rt-01 after round trip')

  // Verify features
  assert(reloaded.features.length === 1, `expected 1 feature after round trip`)
  assert(reloaded.features[0].id === 'f-rt-01', `expected feature id f-rt-01`)

  // Verify operation targets
  assert(reloaded.operations.length === 1, `expected 1 operation after round trip`)
  const op = reloaded.operations[0]
  assert(op.target.source === 'features', `expected feature target source`)
  assert(op.target.featureIds.includes('f-rt-01'), `expected operation to target f-rt-01`)

  // Verify definition data integrity
  const def = reloaded.featureDefinitions['f-rt-01']
  assert(def.kind === 'rect', `expected kind rect after round trip`)
  assert(def.operation === 'add', `expected operation add after round trip`)
  assert(approx(def.profile.start.x, 10), `expected profile start.x 10, got ${def.profile.start.x}`)

  console.log('   ✓ round trip preserves migrated shape')
}

function testIdentityMatrixConstant(): void {
  console.log('9. IDENTITY_MATRIX has expected values...')
  assert(IDENTITY_MATRIX.a === 1, `expected a=1, got ${IDENTITY_MATRIX.a}`)
  assert(IDENTITY_MATRIX.b === 0, `expected b=0, got ${IDENTITY_MATRIX.b}`)
  assert(IDENTITY_MATRIX.c === 0, `expected c=0, got ${IDENTITY_MATRIX.c}`)
  assert(IDENTITY_MATRIX.d === 1, `expected d=1, got ${IDENTITY_MATRIX.d}`)
  assert(IDENTITY_MATRIX.e === 0, `expected e=0, got ${IDENTITY_MATRIX.e}`)
  assert(IDENTITY_MATRIX.f === 0, `expected f=0, got ${IDENTITY_MATRIX.f}`)
  console.log('   ✓ IDENTITY_MATRIX is correct')
}

function testEmptyProjectHasNoDefinitions(): void {
  console.log('10. Empty legacy project migrates with empty definitions...')
  const legacy = makeLegacyProject([])
  const normalized = normalizeProject(legacy)

  assert(normalized.version === '2.0', `expected version '2.0'`)
  assert(
    Object.keys(normalized.featureDefinitions).length === 0,
    `expected 0 definitions for empty project, got ${Object.keys(normalized.featureDefinitions).length}`,
  )
  assert(normalized.features.length === 0, 'expected 0 features')

  console.log('   ✓ empty project has no definitions')
}

function testLegacyOpenProfileOperationBecomesLine(): void {
  console.log('11. Legacy open add/subtract profile: definition.operation must become "line"...')
  // Before 'line' operation type existed, open profiles were stored as
  // 'subtract' (or 'add'). The existing normalization converts these to 'line'.
  // The definition must reflect the normalized operation.
  const openFeature = makeOpenProfileFeature('f-open-01', 'Open Subtract', 'subtract')
  const legacy = makeLegacyProject([openFeature])
  const normalized = normalizeProject(legacy)

  // Feature should have been upgraded to 'line'
  const migratedFeature = normalized.features[0]
  assert(migratedFeature.operation === 'line',
    `expected feature operation 'line', got '${migratedFeature.operation}'`)

  // Definition must match the upgraded feature
  const def = normalized.featureDefinitions['f-open-01']
  assert(def !== undefined, 'expected definition f-open-01 to exist')
  assert(def.operation === 'line',
    `expected definition operation 'line', got '${def.operation}'`)
  assert(def.kind === 'polygon', `expected kind 'polygon', got '${def.kind}'`)

  // Profile should be the open profile
  assert(def.profile.closed === false, 'expected open profile')

  console.log('   ✓ open profile operation normalized to line in definition')
}

function testLegacy4ArcCircleDefinitionProfileMatchesNormalized(): void {
  console.log('12. Legacy 4-arc circle: definition profile must match native circle...')
  // Legacy circles stored as 4 arc segments. Normalization converts to a
  // single native circle segment. The definition must use the native shape.
  const arcCircle = make4ArcCircleFeature('f-4arc-01', '4-Arc Circle')
  const legacy = makeLegacyProject([arcCircle])
  const normalized = normalizeProject(legacy)

  // Feature should be upgraded to native circle
  const migratedFeature = normalized.features[0]
  assert(migratedFeature.sketch.profile.segments.length === 1,
    `expected 1 profile segment (native circle), got ${migratedFeature.sketch.profile.segments.length}`)
  assert(migratedFeature.sketch.profile.segments[0].type === 'circle',
    `expected circle segment type, got '${migratedFeature.sketch.profile.segments[0].type}'`)

  // Definition must match the normalized feature
  const def = normalized.featureDefinitions['f-4arc-01']
  assert(def !== undefined, 'expected definition f-4arc-01 to exist')
  assert(def.profile.segments.length === 1,
    `expected 1 definition profile segment, got ${def.profile.segments.length}`)
  assert(def.profile.segments[0].type === 'circle',
    `expected definition circle type, got '${def.profile.segments[0].type}'`)

  // Profile coordinates should match
  const circleSeg = def.profile.segments[0]
  assert(circleSeg.type === 'circle', 'expected circle segment')
  const featureCircleSeg = migratedFeature.sketch.profile.segments[0]
  assert(featureCircleSeg.type === 'circle', 'expected feature circle segment')
  assert(
    approx(circleSeg.center.x, featureCircleSeg.center.x)
    && approx(circleSeg.center.y, featureCircleSeg.center.y),
    `definition circle center should match feature: def(${circleSeg.center.x},${circleSeg.center.y}) vs feat(${featureCircleSeg.center.x},${featureCircleSeg.center.y})`,
  )
  assert(
    approx(def.profile.start.x, migratedFeature.sketch.profile.start.x)
    && approx(def.profile.start.y, migratedFeature.sketch.profile.start.y),
    'definition profile start should match feature profile start',
  )

  console.log('   ✓ 4-arc circle definition matches normalized native circle')
}

function testStlTransientStorageCleanedUpInDefinitions(): void {
  console.log('13. Legacy STL: definition stl must match normalized feature stl...')
  // Legacy STL features can carry transient `fileData`, `mesh`, or `filePath`
  // fields. Normalization moves the mesh into modelAssets and strips those
  // transient fields. The definition must reflect the cleaned-up shape.
  const stlFeature = makeStlWithTransientMeshFeature('f-stl-transient-01', 'Transient STL')
  const legacy = makeLegacyProject([stlFeature])
  const normalized = normalizeProject(legacy)

  const migratedFeature = normalized.features[0]
  const def = normalized.featureDefinitions['f-stl-transient-01']
  assert(def !== undefined, 'expected definition f-stl-transient-01 to exist')
  assert(def.stl !== null && def.stl !== undefined, 'expected definition to have STL data')

  // The definition's STL keys should exactly match what the normalized feature has.
  const featureStl = migratedFeature.stl
  const defStl = def.stl

  // The normalized feature STL must have transient fields cleared (value is undefined/null)
  assert(!featureStl?.mesh, 'normalized feature STL must have mesh=undefined/null')
  assert(!featureStl?.fileData, 'normalized feature STL must have fileData=undefined/null')

  // Definition must also be free of transient data
  assert(!defStl?.mesh, 'definition STL must have mesh=undefined/null')
  assert(!defStl?.fileData, 'definition STL must have fileData=undefined/null')

  // Key sets must match (same keys in both)
  const featureStlKeys = Object.keys(featureStl ?? {}).sort()
  const defStlKeys = Object.keys(defStl ?? {}).sort()

  for (const key of featureStlKeys) {
    assert(defStlKeys.includes(key),
      `definition missing STL key '${key}' present on normalized feature`)
  }
  for (const key of defStlKeys) {
    assert(featureStlKeys.includes(key),
      `definition has STL key '${key}' not on normalized feature`)
  }

  // Operation and kind must match
  assert(def.operation === 'model', `expected operation 'model', got '${def.operation}'`)
  assert(def.kind === 'stl', `expected kind 'stl', got '${def.kind}'`)

  console.log('   ✓ STL transient storage cleaned up in definitions')
}

function testDuplicateLegacyFeatureIdsGetMatchingDefinitions(): void {
  console.log('14. Duplicate legacy feature IDs: every normalized feature must have a definition...')
  // Two features share the same ID. dedupeProjectIds renames the second.
  // Every resulting feature ID must have a corresponding definition entry.
  const featureA = makeRectFeature('f-0001', 'Duplicate A')
  const featureB = makeCircleFeature('f-0001', 'Duplicate B') // same ID
  const legacy = makeLegacyProject([featureA, featureB])
  const normalized = normalizeProject(legacy)

  // Both features should have unique IDs after dedupe
  assert(normalized.features.length === 2,
    `expected 2 features, got ${normalized.features.length}`)
  const featureIds = normalized.features.map((f) => f.id)
  const uniqueIds = new Set(featureIds)
  assert(uniqueIds.size === 2,
    `expected 2 unique feature IDs after dedupe, got ${uniqueIds.size}: [${featureIds.join(', ')}]`)

  // Every feature ID must have a corresponding definition
  const defIds = Object.keys(normalized.featureDefinitions)
  assert(defIds.length === 2,
    `expected 2 definitions, got ${defIds.length}: [${defIds.join(', ')}]`)

  for (const feature of normalized.features) {
    const def = normalized.featureDefinitions[feature.id]
    assert(def !== undefined,
      `feature '${feature.id}' missing definition; def IDs: [${defIds.join(', ')}]`)
    assert(def.id === feature.id,
      `definition id '${def.id}' should match feature id '${feature.id}'`)
    assert(def.kind === feature.kind,
      `definition kind '${def.kind}' should match feature kind '${feature.kind}' for '${feature.id}'`)
  }

  console.log('   ✓ duplicate feature IDs each get a matching definition')
}

// ── Main ────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

const tests: Array<{ name: string; fn: () => void }> = [
  { name: 'newProject shape', fn: testNewProjectHasFeatureDefinitions },
  { name: 'single-feature migration', fn: testLegacySingleFeatureMigrates },
  { name: 'multi-feature migration', fn: testLegacyMultiFeatureMigratesWithUniqueDefs },
  { name: 'operation targets preserved', fn: testOperationTargetsPreservedAfterMigration },
  { name: 'feature tree entries preserved', fn: testFeatureTreeEntriesPreservedAfterMigration },
  { name: 're-normalization idempotent', fn: testReNormalizationIsIdempotent },
  { name: 'STL model asset references', fn: testStlModelAssetReferencesSurviveMigration },
  { name: 'round trip', fn: testRoundTripPreservesMigratedShape },
  { name: 'IDENTITY_MATRIX constant', fn: testIdentityMatrixConstant },
  { name: 'empty project', fn: testEmptyProjectHasNoDefinitions },
  { name: 'open-profile operation→line', fn: testLegacyOpenProfileOperationBecomesLine },
  { name: '4-arc circle→native profile', fn: testLegacy4ArcCircleDefinitionProfileMatchesNormalized },
  { name: 'STL transient storage cleanup', fn: testStlTransientStorageCleanedUpInDefinitions },
  { name: 'duplicate ID → matching defs', fn: testDuplicateLegacyFeatureIdsGetMatchingDefinitions },
]

for (const test of tests) {
  try {
    test.fn()
    passed += 1
  } catch (err) {
    failed += 1
    console.error(`✗ ${test.name} FAILED:`, err instanceof Error ? err.message : err)
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total\n`)

if (failed > 0) {
  throw new Error(`${failed} test(s) failed`)
}
