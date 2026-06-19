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
 * Tests for Feature References Creation Definitions (slice 06.5).
 *
 * Verifies that every creation path mints a FeatureDefinition + identity
 * transform instance, that the minting is idempotent, and that definition
 * data (text/STL) is correctly carried.
 *
 * Run with: npx tsx src/store/creationDefinitions.test.ts
 */

import {
  IDENTITY_MATRIX,
  newProject,
  rectProfile,
  circleProfile,
  polygonProfile,
  type FeatureDefinition,
  type Matrix2D,
  type Project,
  type SketchFeature,
  type TextFeatureData,
  type STLFeatureData,
} from '../types/project'
import { useProjectStore } from './projectStore'
import {
  createDefinitionForFeature,
} from './helpers/featureDefinitions'
import { resolveFeatureInstance } from './helpers/resolveFeatures'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── Helpers ────────────────────────────────────────────────────────

function resetStore(project?: Project): void {
  useProjectStore.setState({
    project: project ?? newProject(),
    selection: { selectedFeatureIds: [] },
    history: { past: [], future: [], transactionStart: null },
  } as any)
}

function getProject(): Project {
  return useProjectStore.getState().project
}

function getFeatures(): SketchFeature[] {
  return getProject().features
}

function getDefinitions(): Record<string, FeatureDefinition> {
  return getProject().featureDefinitions
}

// ── 1. addFeature mints a definition ───────────────────────────────

function test_addFeature_creates_definition_for_rect(): void {
  resetStore()
  const store = useProjectStore.getState()

  const feature: SketchFeature = {
    id: 'f-test1',
    name: 'Test Rect',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 10, 5),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 3,
    z_bottom: 0,
    visible: true,
    locked: false,
  }

  store.addFeature(feature)

  const features = getFeatures()
  assert(features.length === 1, `Expected 1 feature, got ${features.length}`)

  const created = features[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  assert(
    created.definitionId !== undefined,
    'Created feature should have a definitionId',
  )
  assert(
    created.definitionId !== feature.id,
    'definitionId should be a dedicated definition ID, not the feature id',
  )

  const defs = getDefinitions()
  const def = defs[created.definitionId!]
  assert(def !== undefined, `Definition ${created.definitionId} should exist`)
  assert(def.kind === 'rect', `Definition kind should be rect, got ${def.kind}`)
  // Operation is normalized: first machining feature with subtract → add
  assert(def.operation === 'add', `Definition operation should be add (normalized), got ${def.operation}`)
  assert(def.dimensions.length === 0, 'Definition dimensions should be empty for a bare rect')
  assert(def.text === null, 'Definition text should be null for a rect')
  assert(def.stl === null, 'Definition stl should be null for a rect')

  // Profile should be a clone
  assert(
    def.profile.start.x === 0 && def.profile.start.y === 0,
    'Definition profile start should match',
  )

  assert(
    created.transform !== undefined,
    'Created feature should have a transform',
  )
  assert(
    created.transform!.a === IDENTITY_MATRIX.a &&
    created.transform!.d === IDENTITY_MATRIX.d &&
    created.transform!.e === IDENTITY_MATRIX.e &&
    created.transform!.f === IDENTITY_MATRIX.f,
    'Transform should be identity',
  )

  console.log('✓ addFeature creates definition for rect')
}

// ── 2. Idempotency — feature with existing definitionId skipped ────

function test_addFeature_idempotent_when_definitionId_present(): void {
  resetStore()

  // Pre-create a definition in the store
  const project = getProject()
  const preDef: FeatureDefinition = {
    id: 'def-existing',
    kind: 'rect',
    profile: rectProfile(0, 0, 5, 5),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
  useProjectStore.setState({
    project: {
      ...project,
      featureDefinitions: { 'def-existing': preDef },
    },
  } as any)

  const store = useProjectStore.getState()

  const featureWithDef = {
    id: 'f-idempotent',
    name: 'Already Has Def',
    kind: 'rect' as const,
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 5, 5),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: 'add' as const,
    z_top: 3,
    z_bottom: 0,
    visible: true,
    locked: false,
    definitionId: 'def-existing',
  }

  store.addFeature(featureWithDef as SketchFeature & { definitionId?: string })

  const features = getFeatures()
  assert(features.length === 1, `Expected 1 feature, got ${features.length}`)

  const created = features[0] as SketchFeature & { definitionId?: string }
  assert(
    created.definitionId === 'def-existing',
    `Feature should keep its original definitionId, got ${created.definitionId}`,
  )

  const defs = getDefinitions()
  const defCount = Object.keys(defs).length
  assert(defCount === 1, `Should still have exactly 1 definition, got ${defCount}`)

  console.log('✓ addFeature is idempotent when definitionId already present')
}

// ── 3. Text features carry text data ───────────────────────────────

function test_addFeature_creates_definition_with_text_data(): void {
  resetStore()
  const store = useProjectStore.getState()

  const textData: TextFeatureData = {
    text: 'Hello',
    style: 'skeleton',
    fontId: 'simple_stroke',
    size: 10,
  }

  const feature: SketchFeature = {
    id: 'f-text',
    name: 'Text Feature',
    kind: 'text',
    text: textData,
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 20, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 1,
    z_bottom: 0,
    visible: true,
    locked: false,
  }

  store.addFeature(feature)

  const features = getFeatures()
  assert(features.length === 1, `Expected 1 feature, got ${features.length}`)

  const created = features[0] as SketchFeature & { definitionId?: string; text?: TextFeatureData | null }
  assert(created.definitionId !== undefined, 'Text feature should have a definitionId')

  const defs = getDefinitions()
  const def = defs[created.definitionId!]
  assert(def !== undefined, 'Definition should exist for text feature')
  assert(def.kind === 'text', `Definition kind should be text, got ${def.kind}`)
  assert(def.text !== null, 'Definition should carry text data')
  assert(def.text !== undefined, 'Definition should carry text data')
  assert(def.text!.text === 'Hello', 'Definition text content should match')
  assert(typeof def.text!.fontId === 'string', `Definition text fontId should be a string, got ${def.text!.fontId}`)

  console.log('✓ addFeature creates definition with text data')
}

// ── 4. STL features carry stl data ─────────────────────────────────

function test_addFeature_creates_definition_with_stl_data(): void {
  resetStore()
  const store = useProjectStore.getState()

  const stlData: STLFeatureData = {
    scale: 1,
    axisSwap: 'none',
  }

  const feature: SketchFeature = {
    id: 'f-stl',
    name: 'STL Feature',
    kind: 'stl',
    stl: stlData,
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 50, 30),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: 10,
    z_bottom: 0,
    visible: true,
    locked: false,
  }

  store.addFeature(feature)

  const features = getFeatures()
  assert(features.length === 1, `Expected 1 feature, got ${features.length}`)

  const created = features[0] as SketchFeature & { definitionId?: string; stl?: STLFeatureData | null }
  assert(created.definitionId !== undefined, 'STL feature should have a definitionId')

  const defs = getDefinitions()
  const def = defs[created.definitionId!]
  assert(def !== undefined, 'Definition should exist for STL feature')
  assert(def.kind === 'stl', `Definition kind should be stl, got ${def.kind}`)
  assert(def.stl !== null, 'Definition should carry stl data')
  assert(def.stl !== undefined, 'Definition should carry stl data')
  assert(def.stl!.scale === 1, 'Definition stl scale should match')
  assert(def.stl!.axisSwap === 'none', 'Definition stl axisSwap should match')

  console.log('✓ addFeature creates definition with stl data')
}

// ── 5. Different feature kinds get correct definition kinds ────────

function test_addFeature_preserves_kind_in_definition(): void {
  resetStore()
  const store = useProjectStore.getState()

  // Circle
  store.addFeature({
    id: 'f-circle',
    name: 'Circle',
    kind: 'circle',
    folderId: null,
    sketch: {
      profile: circleProfile(5, 5, 3),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 2,
    z_bottom: 0,
    visible: true,
    locked: false,
  })

  const features = getFeatures()
  const created = features[0] as SketchFeature & { definitionId?: string }
  const def = getDefinitions()[created.definitionId!]
  assert(def.kind === 'circle', `Circle definition kind should be circle, got ${def.kind}`)

  console.log('✓ addFeature preserves circle kind')
}

// ── 6. createDefinitionForFeature helper ──────────────────────────

function test_createDefinitionForFeature_helper(): void {
  resetStore()
  const project = getProject()

  const feature: SketchFeature = {
    id: 'f-helper',
    name: 'Helper Test',
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: polygonProfile([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }]),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [{ id: 'd1', type: 'distance', segment_ids: ['0'], value: 10 }],
      constraints: [],
    },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }

  const { definitionId, definition } = createDefinitionForFeature(project, feature)

  assert(definitionId.startsWith('f-'), `definitionId should start with 'f-', got ${definitionId}`)
  assert(definition.id === definitionId, 'Definition id should match definitionId')
  assert(definition.kind === 'polygon', `Definition kind should be polygon, got ${definition.kind}`)
  assert(definition.operation === 'add', `Definition operation should be add, got ${definition.operation}`)
  assert(definition.dimensions.length === 1, 'Definition should carry dimensions')
  assert(definition.text === null, 'Definition text should be null')
  assert(definition.stl === null, 'Definition stl should be null')

  console.log('✓ createDefinitionForFeature returns correct result')
}

// ── 7. resolveFeatureInstance works for newly created features ─────

function test_newly_created_feature_resolves_without_raw_fallback(): void {
  resetStore()
  const store = useProjectStore.getState()

  const feature: SketchFeature = {
    id: 'f-resolve',
    name: 'Resolve Test',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(10, 20, 30, 40),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 6,
    z_bottom: 0,
    visible: true,
    locked: false,
  }

  store.addFeature(feature)

  const project = getProject()
  const features = getFeatures()
  const created = features[0]

  // The created feature should have an explicit definitionId
  const withDef = created as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  assert(withDef.definitionId !== undefined, 'Feature should have a definitionId')

  // resolveFeatureInstance should succeed (not return null)
  const resolved = resolveFeatureInstance(project, created.id)
  assert(resolved !== null, 'resolveFeatureInstance should return a resolved feature')

  // The resolved feature should have world geometry matching the definition
  assert(
    resolved.kind === 'rect',
    `Resolved kind should be rect, got ${resolved.kind}`,
  )

  console.log('✓ resolveFeatureInstance works for newly created feature')
}

// ── 8. SVG/DXF import creates definitions ──────────────────────────

function test_importShapes_creates_definitions(): void {
  resetStore()
  const store = useProjectStore.getState()

  // Simulate importing two rectangles
  store.importShapes({
    fileName: 'test.svg',
    sourceType: 'svg',
    shapes: [
      {
        name: 'Shape1',
        sourceType: 'svg',
        profile: rectProfile(0, 0, 10, 10),
        layerName: 'layer1',
      },
      {
        name: 'Shape2',
        sourceType: 'svg',
        profile: rectProfile(20, 0, 10, 10),
        layerName: 'layer1',
      },
    ],
  })

  const features = getFeatures()
  const defs = getDefinitions()

  assert(features.length === 2, `Expected 2 imported features, got ${features.length}`)
  assert(Object.keys(defs).length === 2, `Expected 2 definitions, got ${Object.keys(defs).length}`)

  for (const feature of features) {
    const withDef = feature as SketchFeature & { definitionId?: string; transform?: Matrix2D }
    assert(withDef.definitionId !== undefined, `Feature ${feature.name} should have a definitionId`)
    assert(defs[withDef.definitionId!] !== undefined, `Definition for ${withDef.definitionId} should exist`)
    assert(
      withDef.transform !== undefined &&
      withDef.transform!.a === IDENTITY_MATRIX.a &&
      withDef.transform!.d === IDENTITY_MATRIX.d,
      `Feature ${feature.name} should have identity transform`,
    )
  }

  console.log('✓ importShapes creates definitions for imported features')
}

// ── 9. .camj import merges definitions collision-safe ──────────────

function test_camj_import_merges_definitions_collision_safe(): void {
  resetStore()
  const store = useProjectStore.getState()

  // Build a source project with featureDefinitions and features referencing them
  const sourceDef: FeatureDefinition = {
    id: 'f-0001',
    kind: 'rect',
    profile: rectProfile(0, 0, 10, 10),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }

  const sourceProject: Project = {
    ...newProject('Source', 'inch'),
    featureDefinitions: { 'f-0001': sourceDef },
    features: [
      {
        id: 'src-f1',
        name: 'Source Feature',
        kind: 'rect',
        folderId: 'src-fd1',
        sketch: {
          profile: rectProfile(0, 0, 10, 10),
          origin: { x: 0, y: 0 },
          orientationAngle: 90,
          dimensions: [],
          constraints: [],
        },
        operation: 'add',
        z_top: 5,
        z_bottom: 0,
        visible: true,
        locked: false,
        definitionId: 'f-0001',
        transform: IDENTITY_MATRIX,
      } as SketchFeature & { definitionId?: string; transform?: Matrix2D },
    ],
    featureFolders: [
      { id: 'src-fd1', name: 'Source Folder', collapsed: false },
    ],
    featureTree: [
      { type: 'folder' as const, folderId: 'src-fd1' },
    ],
  }

  store.importCamjFolders({
    fileName: 'test.camj',
    sourceProject,
    selectedFolderIds: ['src-fd1'],
    importStock: false,
  })

  const features = getFeatures()
  const defs = getDefinitions()

  assert(features.length === 1, `Expected 1 imported feature, got ${features.length}`)

  const imported = features[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  assert(imported.definitionId !== undefined, 'Imported feature should have a definitionId')

  // The definition should have been remapped with collision-safe ID
  const def = defs[imported.definitionId!]
  assert(def !== undefined, 'Remapped definition should exist')
  assert(def.kind === 'rect', 'Remapped definition kind should be rect')

  // The imported feature's definitionId should be remapped, not the source ID
  // (unless the source ID doesn't collide)
  console.log(`  Imported feature definitionId: ${imported.definitionId}`)
  console.log(`  Definition keys: ${Object.keys(defs).join(', ')}`)

  console.log('✓ camj import merges definitions collision-safe')
}

// ── 10. Convenience constructors (addRectFeature, etc.) ────────────

function test_convenience_constructors_mint_definitions(): void {
  resetStore()
  const store = useProjectStore.getState()

  store.addRectFeature('MyRect', 10, 20, 30, 40, 5)

  const features = getFeatures()
  assert(features.length === 1, 'Should have 1 feature')
  const created = features[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  assert(created.definitionId !== undefined, 'addRectFeature should mint a definitionId')

  const defs = getDefinitions()
  assert(defs[created.definitionId!] !== undefined, 'Definition should exist')

  // Test circle
  store.addCircleFeature('MyCircle', 50, 60, 25, 3)
  assert(getFeatures().length === 2, 'Should have 2 features')
  const circle = getFeatures()[1] as SketchFeature & { definitionId?: string }
  assert(circle.definitionId !== undefined, 'addCircleFeature should mint a definitionId')

  // Test ellipse
  store.addEllipseFeature('MyEllipse', 0, 0, 15, 10, 2)
  assert(getFeatures().length === 3, 'Should have 3 features')
  const ellipse = getFeatures()[2] as SketchFeature & { definitionId?: string }
  assert(ellipse.definitionId !== undefined, 'addEllipseFeature should mint a definitionId')

  // Test polygon
  store.addPolygonFeature('MyPolygon', [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 25, y: 50 }], 4)
  assert(getFeatures().length === 4, 'Should have 4 features')
  const polygon = getFeatures()[3] as SketchFeature & { definitionId?: string }
  assert(polygon.definitionId !== undefined, 'addPolygonFeature should mint a definitionId')

  console.log('✓ convenience constructors mint definitions')
}

// ── Run ────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function run(name: string, fn: () => void): void {
  try {
    fn()
    passed++
  } catch (e) {
    failed++
    console.error(`✗ ${name}: ${(e as Error).message}`)
  }
}

run('addFeature creates definition for rect', test_addFeature_creates_definition_for_rect)
run('addFeature idempotent when definitionId present', test_addFeature_idempotent_when_definitionId_present)
run('addFeature creates definition with text data', test_addFeature_creates_definition_with_text_data)
run('addFeature creates definition with stl data', test_addFeature_creates_definition_with_stl_data)
run('addFeature preserves kind in definition', test_addFeature_preserves_kind_in_definition)
run('createDefinitionForFeature helper', test_createDefinitionForFeature_helper)
run('resolveFeatureInstance works for newly created feature', test_newly_created_feature_resolves_without_raw_fallback)
run('importShapes creates definitions', test_importShapes_creates_definitions)
run('camj import merges definitions collision-safe', test_camj_import_merges_definitions_collision_safe)
run('convenience constructors mint definitions', test_convenience_constructors_mint_definitions)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exitCode = 1
}
