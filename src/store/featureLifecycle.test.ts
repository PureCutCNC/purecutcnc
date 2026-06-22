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
 * Feature Lifecycle Regression Tests (Phase 2).
 *
 * Create → definition, save/load round-trip, undo/redo, delete → GC.
 * Drives the REAL store actions/helpers.
 *
 * Run with: npx tsx src/store/featureLifecycle.test.ts
 */

import {
  IDENTITY_MATRIX,
  newProject,
  rectProfile,
  type FeatureDefinition,
  type Matrix2D,
  type Project,
  type SketchFeature,
  type STLFeatureData,
  type TextFeatureData,
} from '../types/project'
import { useProjectStore } from './projectStore'
import { getDefinitionId } from './helpers/featureDefinitions'

// ── Assertion helpers ──────────────────────────────────────────────

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── Store helpers ──────────────────────────────────────────────────

function resetStore(project?: Project): void {
  useProjectStore.setState({
    project: project ?? newProject(),
    selection: {
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedNode: null,
      mode: 'feature' as const,
      sketchEditTool: null,
      activeControl: null,
      hoveredFeatureId: null,
    },
    history: { past: [], future: [], transactionStart: null },
    sketchEditSession: null,
    pendingConstraint: null,
    pendingTransform: null,
    pendingOffset: null,
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

// ── Test runner ────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`   ✗ ${name}: ${msg}`)
  }
}

// ============================================================================
// 1. CREATE — each kind mints a FeatureDefinition + identity instance
// ============================================================================

console.log('\nCreate → definition + identity instance')

const CREATE_TEST_CASES: Array<{
  kind: string
  setup: () => void
  expectKind: string
  extra?: (f: SketchFeature & { definitionId?: string; transform?: Matrix2D }, def: FeatureDefinition) => void
}> = [
  {
    kind: 'rect',
    setup: () => { useProjectStore.getState().addRectFeature('Rect', 10, 20, 30, 15, 5) },
    expectKind: 'rect',
  },
  {
    kind: 'circle',
    setup: () => { useProjectStore.getState().addCircleFeature('Circle', 50, 50, 10, 5) },
    expectKind: 'circle',
    extra: (_f, def) => {
      assert(def.profile.segments[0].type === 'circle', 'circle def should have circle segment')
    },
  },
  {
    kind: 'ellipse',
    setup: () => { useProjectStore.getState().addEllipseFeature('Ellipse', 50, 50, 30, 20, 5) },
    expectKind: 'ellipse',
  },
  {
    kind: 'polygon',
    setup: () => { useProjectStore.getState().addPolygonFeature('Polygon', [{ x: 10, y: 20 }, { x: 50, y: 10 }, { x: 60, y: 40 }], 5) },
    expectKind: 'polygon',
  },
  {
    kind: 'spline',
    setup: () => { useProjectStore.getState().addSplineFeature('Spline', [{ x: 10, y: 20 }, { x: 40, y: 10 }, { x: 60, y: 40 }, { x: 20, y: 50 }], 5) },
    expectKind: 'spline',
  },
  {
    kind: 'composite (with arc)',
    setup: () => {
      const store = useProjectStore.getState()
      store.addFeature({
        id: 'f-comp-life',
        name: 'Composite',
        kind: 'composite',
        folderId: null,
        sketch: {
          profile: {
            start: { x: 10, y: 0 },
            segments: [
              { type: 'line' as const, to: { x: 20, y: 0 } },
              { type: 'arc' as const, to: { x: 30, y: 10 }, center: { x: 20, y: 10 }, clockwise: false },
              { type: 'line' as const, to: { x: 10, y: 10 } },
              { type: 'line' as const, to: { x: 10, y: 0 } },
            ],
            closed: true,
          },
          origin: { x: 0, y: 0 },
          orientationAngle: 0,
          dimensions: [],
          constraints: [],
        },
        operation: 'add',
        z_top: 5,
        z_bottom: 0,
        visible: true,
        locked: false,
      })
    },
    expectKind: 'composite',
    extra: (_f, def) => {
      const arcSegs = def.profile.segments.filter((s) => s.type === 'arc')
      assert(arcSegs.length === 1, `composite def should have 1 arc, got ${arcSegs.length}`)
    },
  },
  {
    kind: 'text',
    setup: () => {
      const store = useProjectStore.getState()
      store.addFeature({
        id: 'f-text-life',
        name: 'Text',
        kind: 'text',
        text: { text: 'Hello', style: 'skeleton', fontId: 'simple_stroke', size: 10 } as TextFeatureData,
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
      })
    },
    expectKind: 'text',
    extra: (_f, def) => {
      assert(def.text != null, 'text def should have text data')
      assert(def.text!.text === 'Hello', 'text content should match')
    },
  },
  {
    kind: 'stl',
    setup: () => {
      const store = useProjectStore.getState()
      store.addFeature({
        id: 'f-stl-life',
        name: 'STL',
        kind: 'stl',
        stl: { scale: 1, axisSwap: 'none' } as STLFeatureData,
        folderId: null,
        sketch: {
          profile: rectProfile(0, 0, 50, 30),
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
      })
    },
    expectKind: 'stl',
    extra: (_f, def) => {
      assert(def.stl != null, 'stl def should have stl data')
    },
  },
]

for (const tc of CREATE_TEST_CASES) {
  test(`${tc.kind}: create mints definition + identity instance`, () => {
    resetStore()
    tc.setup()

    const features = getFeatures()
    assert(features.length === 1, `[${tc.kind}] expected 1 feature, got ${features.length}`)

    const f = features[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
    assert(f.kind === tc.expectKind, `[${tc.kind}] expected kind ${tc.expectKind}, got ${f.kind}`)

    // Should have a definitionId set by addFeature
    const defId = f.definitionId!
    assert(defId !== undefined, `[${tc.kind}] feature should have definitionId`)
    assert(typeof defId === 'string' && defId.length > 0, `[${tc.kind}] definitionId should be non-empty string`)

    // Definition should exist in featureDefinitions
    const defs = getDefinitions()
    const def = defs[defId]
    assert(def !== undefined, `[${tc.kind}] definition should exist in featureDefinitions`)
    assert(def.kind === tc.expectKind, `[${tc.kind}] definition kind should be ${tc.expectKind}, got ${def.kind}`)

    // Identity transform should be present
    const t = f.transform
    assert(t !== undefined, `[${tc.kind}] feature should have transform`)
    if (t) {
      assert(t.a === 1 && t.b === 0 && t.c === 0 && t.d === 1 && t.e === 0 && t.f === 0,
        `[${tc.kind}] transform should be identity, got ${JSON.stringify(t)}`)
    }

    // definitionId should be accessible via getDefinitionId
    assert(getDefinitionId(f) === defId, `[${tc.kind}] getDefinitionId should match`)

    if (tc.extra) {
      tc.extra(f, def)
    }
  })
}

// ============================================================================
// 2. SAVE/LOAD ROUND-TRIP — byte-equivalent per kind + mixed project
// ============================================================================

console.log('\nSave/load round-trip — per kind')

for (const tc of CREATE_TEST_CASES) {
  test(`${tc.kind}: save → load → re-save is equivalent`, () => {
    resetStore()
    tc.setup()

    const store = useProjectStore.getState()
    const before = getProject()

    // Serialize and reload
    const json = store.saveProject()
    assert(json.length > 0, `[${tc.kind}] serialized project should be non-empty`)

    resetStore()
    const store2 = useProjectStore.getState()
    store2.openProjectFromText(json, null)

    const after = getProject()

    // Feature count preserved
    assert(after.features.length === before.features.length,
      `[${tc.kind}] feature count: before=${before.features.length}, after=${after.features.length}`)

    // Feature kinds preserved
    for (let i = 0; i < before.features.length; i++) {
      assert(after.features[i].kind === before.features[i].kind,
        `[${tc.kind}] feature[${i}] kind: before=${before.features[i].kind}, after=${after.features[i].kind}`)
    }

    // Definitions preserved
    const beforeDefIds = Object.keys(before.featureDefinitions)
    const afterDefIds = Object.keys(after.featureDefinitions)
    assert(beforeDefIds.length === afterDefIds.length,
      `[${tc.kind}] definition count: before=${beforeDefIds.length}, after=${afterDefIds.length}`)

    for (const defId of beforeDefIds) {
      const beforeDef = before.featureDefinitions[defId]
      const afterDef = after.featureDefinitions[defId]
      assert(afterDef !== undefined, `[${tc.kind}] definition ${defId} should survive`)
      assert(afterDef.kind === beforeDef.kind,
        `[${tc.kind}] definition ${defId} kind: before=${beforeDef.kind}, after=${afterDef.kind}`)
    }

    // Re-serialize and compare feature & definition shapes (system fields like
    // machineDefinitions / grid / stock may be refreshed during normalizeProject).
    const json2 = store2.saveProject()
    const obj1 = JSON.parse(json)
    const obj2 = JSON.parse(json2)
    assert(obj1.features.length === obj2.features.length,
      `[${tc.kind}] feature count mismatch after reload`)

    // Compare features (ignoring sketch.origin/orientationAngle which get normalized)
    for (let i = 0; i < obj1.features.length; i++) {
      const f1 = { ...obj1.features[i] }
      const f2 = { ...obj2.features[i] }
      assert(f1.kind === f2.kind, `[${tc.kind}] feature[${i}] kind mismatch: ${f1.kind} vs ${f2.kind}`)
      assert(f1.id === f2.id, `[${tc.kind}] feature[${i}] id mismatch`)
      // Profile segments should be equivalent
      assert(f1.sketch.profile.segments.length === f2.sketch.profile.segments.length,
        `[${tc.kind}] feature[${i}] segment count mismatch`)
    }

    // Compare definitions
    const defIds1 = Object.keys(obj1.featureDefinitions).sort()
    const defIds2 = Object.keys(obj2.featureDefinitions).sort()
    assert(defIds1.length === defIds2.length,
      `[${tc.kind}] definition count mismatch: ${defIds1.length} vs ${defIds2.length}`)
    for (const defId of defIds1) {
      const d1 = obj1.featureDefinitions[defId]
      const d2 = obj2.featureDefinitions[defId]
      assert(d2 !== undefined, `[${tc.kind}] definition ${defId} missing after reload`)
      assert(d1.kind === d2.kind, `[${tc.kind}] definition ${defId} kind mismatch: ${d1.kind} vs ${d2.kind}`)
      assert(d1.profile.segments.length === d2.profile.segments.length,
        `[${tc.kind}] definition ${defId} segment count mismatch`)
    }
  })
}

console.log('\nSave/load round-trip — mixed linked/unique/independent project')

test('mixed project: copyMode + linked relationships survive save/load', () => {
  resetStore()
  const store = useProjectStore.getState()

  // Set copy mode to reference (default)
  store.setCopyMode('reference')

  // Create base circle
  store.addCircleFeature('Base', 50, 50, 10, 5)

  const baseFeatures = getFeatures()
  const base = baseFeatures[0] as SketchFeature & { definitionId?: string }
  const baseDefId = base.definitionId!

  // Duplicate as reference (linked)
  store.selectFeature(base.id)
  store.startCopyFeature(base.id)
  store.setPendingMoveFrom({ x: 0, y: 0 })
  store.completePendingMove({ x: 100, y: 0 })

  const afterCopy = getFeatures()
  assert(afterCopy.length === 2, `expected 2 features after copy, got ${afterCopy.length}`)
  const linked = afterCopy[1] as SketchFeature & { definitionId?: string }
  assert(linked.definitionId === baseDefId, 'linked copy should share definitionId')

  // Copy as independent
  store.setCopyMode('independent')
  store.selectFeature(base.id)
  store.startCopyFeature(base.id, 'independent')
  store.setPendingMoveFrom({ x: 0, y: 0 })
  store.completePendingMove({ x: 0, y: 100 })

  const afterIndependent = getFeatures()
  assert(afterIndependent.length === 3, `expected 3 features, got ${afterIndependent.length}`)
  const independent = afterIndependent[2] as SketchFeature & { definitionId?: string }
  assert(independent.definitionId !== baseDefId, 'independent copy should have different definitionId')

  // Make unique on the linked copy
  store.makeUnique(linked.id)
  const afterUnique = getFeatures()
  const uniqued = afterUnique[1] as SketchFeature & { definitionId?: string }
  assert(uniqued.definitionId !== baseDefId, 'made-unique should have different definitionId')

  // Save and reload
  const json = store.saveProject()
  resetStore()
  const store2 = useProjectStore.getState()
  store2.openProjectFromText(json, null)

  const loaded = getProject()
  assert(loaded.features.length === 3, `expected 3 features after load, got ${loaded.features.length}`)

  // Verify copyMode survives
  assert(loaded.meta.copyMode === 'independent',
    `copyMode should be 'independent', got ${loaded.meta.copyMode}`)

  // Verify 3 distinct definitionIds exist
  const loadedDefIds = new Set<string>()
  for (const f of loaded.features) {
    const id = getDefinitionId(f)
    loadedDefIds.add(id)
  }
  assert(loadedDefIds.size === 3, `expected 3 distinct definitionIds after load, got ${loadedDefIds.size}`)

  // Verify the base feature still resolves correctly
  const baseLoaded = loaded.features.find((f) => f.id === base.id) as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  assert(baseLoaded != null, 'base feature should survive load')
  const baseLoadedDef = loaded.featureDefinitions[baseLoaded.definitionId!]
  assert(baseLoadedDef != null, 'base definition should survive load')
  assert(baseLoadedDef.kind === 'circle', 'base definition should still be circle')
})

// ============================================================================
// 3. UNDO/REDO
// ============================================================================

console.log('\nUndo/redo — create')

test('undo after create removes feature; redo restores it', () => {
  resetStore()
  const store = useProjectStore.getState()

  store.addRectFeature('Rect', 10, 20, 30, 15, 5)
  assert(getFeatures().length === 1, 'should have 1 feature after create')

  store.undo()
  assert(getFeatures().length === 0, 'should have 0 features after undo')
  assert(Object.keys(getDefinitions()).length === 0, 'definitions should be empty after undo')

  store.redo()
  assert(getFeatures().length === 1, 'should have 1 feature after redo')
  assert(Object.keys(getDefinitions()).length === 1, 'definition should be restored after redo')
})

test('undo after edit restores pre-edit geometry', () => {
  resetStore()
  const store = useProjectStore.getState()

  store.addCircleFeature('Circle', 50, 50, 10, 5)
  const f = getFeatures()[0] as SketchFeature & { definitionId?: string }
  const defId = f.definitionId!
  const preDef = getDefinitions()[defId]
  const preProfileJSON = JSON.stringify(preDef.profile)

  store.selectFeature(f.id)
  store.enterSketchEdit(f.id)
  store.moveFeatureControl(f.id, { kind: 'anchor', index: 0 }, { x: 65, y: 50 })
  store.applySketchEdit()

  // Profile should have changed
  const postEditDef = getDefinitions()[defId]
  assert(JSON.stringify(postEditDef.profile) !== preProfileJSON, 'edit should change profile')

  // Undo the edit
  store.undo()
  const undoneDef = getDefinitions()[defId]
  assert(JSON.stringify(undoneDef.profile) === preProfileJSON, 'undo should restore pre-edit profile')
})

test('undo after transform restores position', () => {
  resetStore()
  const store = useProjectStore.getState()

  store.addRectFeature('Rect', 10, 20, 30, 15, 5)
  const f = getFeatures()[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const preTransform = { ...(f.transform ?? IDENTITY_MATRIX) }

  store.selectFeature(f.id)
  store.startMoveFeature(f.id)
  store.setPendingMoveFrom({ x: 0, y: 0 })
  store.completePendingMove({ x: 50, y: 30 })

  const moved = getFeatures()[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const movedTransform = moved.transform ?? IDENTITY_MATRIX
  assert(!(movedTransform.e === preTransform.e && movedTransform.f === preTransform.f),
    'move should change transform')

  store.undo()
  const undone = getFeatures()[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const undoneTransform = undone.transform ?? IDENTITY_MATRIX
  assert(undoneTransform.e === preTransform.e && undoneTransform.f === preTransform.f,
    `undo should restore transform: expected e=${preTransform.e}, f=${preTransform.f}, got e=${undoneTransform.e}, f=${undoneTransform.f}`)
})

console.log('\nUndo/redo — delete')

test('undo after delete restores feature + definition', () => {
  resetStore()
  const store = useProjectStore.getState()

  store.addCircleFeature('Circle', 50, 50, 10, 5)
  const f = getFeatures()[0] as SketchFeature & { definitionId?: string }
  const defId = f.definitionId!

  assert(getDefinitions()[defId] !== undefined, 'definition should exist before delete')

  store.deleteFeatures([f.id])
  // Feature should be gone
  assert(getFeatures().length === 0, 'should have 0 features after delete')

  // Undo should restore both
  store.undo()
  assert(getFeatures().length === 1, 'should have 1 feature after undo delete')
  const restoredDef = getDefinitions()[defId]
  assert(restoredDef !== undefined, 'definition should be restored after undo delete')
  assert(restoredDef.kind === 'circle', 'restored definition should be circle')
})

// ============================================================================
// 4. DELETE → GC
// ============================================================================

console.log('\nDelete → definition GC')

test('delete last instance: definition is GCd; undo restores both', () => {
  resetStore()
  const store = useProjectStore.getState()

  store.addCircleFeature('Circle', 50, 50, 10, 5)
  const f = getFeatures()[0] as SketchFeature & { definitionId?: string }
  const defId = f.definitionId!

  assert(getDefinitions()[defId] !== undefined, 'definition should exist before delete')
  assert(getFeatures().length === 1, 'should have 1 feature before delete')

  // Delete the only instance → definition must be GC'd
  store.deleteFeatures([f.id])
  assert(getFeatures().length === 0, 'should have 0 features after delete')
  assert(getDefinitions()[defId] === undefined,
    'definition should be GCd when last instance is deleted')

  // Undo restores both instance + definition
  store.undo()
  assert(getFeatures().length === 1, 'undo should restore feature')
  const restoredDef = getDefinitions()[defId]
  assert(restoredDef !== undefined, 'undo should restore definition')
  assert(restoredDef.kind === 'circle', 'restored definition should be circle')
})

test('linked pair: delete one instance keeps definition; delete last GCs it', () => {
  resetStore()
  const store = useProjectStore.getState()

  store.addCircleFeature('Circle', 50, 50, 10, 5)
  const base = getFeatures()[0] as SketchFeature & { definitionId?: string }
  const defId = base.definitionId!

  // Create linked copy
  store.selectFeature(base.id)
  store.startCopyFeature(base.id)
  store.setPendingMoveFrom({ x: 0, y: 0 })
  store.completePendingMove({ x: 100, y: 0 })

  const features = getFeatures()
  assert(features.length === 2, 'should have 2 linked instances')
  const linked = features[1] as SketchFeature & { definitionId?: string }
  assert(linked.definitionId === defId, 'linked should share definitionId')

  // Delete one instance — definition still referenced by the other
  store.deleteFeatures([linked.id])
  assert(getFeatures().length === 1, 'should have 1 feature after partial delete')
  assert(getDefinitions()[defId] !== undefined,
    'definition should survive when other instance remains')

  // Delete the last instance — definition must be GC'd
  store.deleteFeatures([base.id])
  assert(getFeatures().length === 0, 'should have 0 features after deleting last instance')
  assert(getDefinitions()[defId] === undefined,
    'definition should be GCd when last instance is deleted')
})

// ============================================================================
// 5. UNDO AFTER DELETE RESTORES DEFINITION (cross-check)
// ============================================================================

console.log('\nUndo after delete — definition restoration')

test('undo delete: restores instance AND its definition', () => {
  resetStore()
  const store = useProjectStore.getState()

  store.addCircleFeature('Circle', 50, 50, 10, 5)
  const f = getFeatures()[0] as SketchFeature & { definitionId?: string }
  const defId = f.definitionId!

  const preDefJSON = JSON.stringify(getDefinitions()[defId])

  store.deleteFeatures([f.id])
  // Undo restores
  store.undo()

  const restoredFeatures = getFeatures()
  assert(restoredFeatures.length === 1, 'undo should restore feature')
  const restoredDef = getDefinitions()[defId]
  assert(restoredDef !== undefined, 'undo should restore definition')
  assert(JSON.stringify(restoredDef) === preDefJSON, 'restored definition should match original')
})

// ============================================================================
// 6. Multi-step undo/redo
// ============================================================================

console.log('\nMulti-step undo/redo')

test('multiple undos step back through history', () => {
  resetStore()
  const store = useProjectStore.getState()

  // Step 1: create
  store.addRectFeature('Rect1', 10, 20, 30, 15, 5)
  assert(getFeatures().length === 1, 'step 1: should have 1 feature')

  // Step 2: create another
  store.addCircleFeature('Circle1', 50, 50, 10, 5)
  assert(getFeatures().length === 2, 'step 2: should have 2 features')

  // Step 3: create a third
  store.addEllipseFeature('Ellipse1', 50, 50, 30, 20, 5)
  assert(getFeatures().length === 3, 'step 3: should have 3 features')

  // Undo step 3
  store.undo()
  assert(getFeatures().length === 2, 'after undo 1: should have 2 features')
  // The remaining features should be rect and circle
  const kinds1 = getFeatures().map((f) => f.kind)
  assert(kinds1.includes('rect') && kinds1.includes('circle'),
    `after undo 1: should have rect+circle, got ${kinds1.join(',')}`)

  // Undo step 2
  store.undo()
  assert(getFeatures().length === 1, 'after undo 2: should have 1 feature')
  assert(getFeatures()[0].kind === 'rect', 'remaining feature should be rect')

  // Undo step 1
  store.undo()
  assert(getFeatures().length === 0, 'after undo 3: should have 0 features')

  // Redo step 1
  store.redo()
  assert(getFeatures().length === 1, 'after redo 1: should have 1 feature')
  assert(getFeatures()[0].kind === 'rect', 'after redo 1: should be rect')

  // Redo step 2
  store.redo()
  assert(getFeatures().length === 2, 'after redo 2: should have 2 features')

  // Redo step 3
  store.redo()
  assert(getFeatures().length === 3, 'after redo 3: should have 3 features')
})

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
