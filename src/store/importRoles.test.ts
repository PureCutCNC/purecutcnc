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
 * Store tests — importShapes with classified roles (issue #270 S3).
 *
 * Run with: npx tsx src/store/importRoles.test.ts
 */

import type { ClassifiedShape } from '../import'
import { rectProfile } from '../types/project'
import { resolveFeatureInstance, resolvedProjectFeatures } from './helpers/resolveFeatures'
import { useProjectStore } from './projectStore'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('FAIL: ' + msg)
}

function resetStore(): void {
  useProjectStore.getState().createNewProject()
}

function getFeatures() {
  return resolvedProjectFeatures(useProjectStore.getState().project)
}

function getDefinitions() {
  return useProjectStore.getState().project.featureDefinitions
}

function getHistory() {
  return useProjectStore.getState().history
}

function getFeatureById(id: string) {
  return resolveFeatureInstance(useProjectStore.getState().project, id)
}

function getFolders() {
  return useProjectStore.getState().project.featureFolders
}

function makeClassified(
  overrides: Partial<ClassifiedShape> & { profile: ClassifiedShape['profile'] },
): ClassifiedShape {
  return {
    name: overrides.name ?? 'shape',
    sourceType: overrides.sourceType ?? 'dxf',
    layerName: overrides.layerName ?? null,
    profile: overrides.profile,
    operation: overrides.operation ?? 'add',
    sourceIndex: overrides.sourceIndex ?? 0,
  }
}

// ── classified operations honored ──────────────────────────────────────

function test_classified_honored(): void {
  resetStore()
  const store = useProjectStore.getState()

  const shapes = [
    {
      name: 'add-feature',
      sourceType: 'dxf' as const,
      profile: rectProfile(0, 0, 100, 100),
      layerName: null,
    },
    {
      name: 'subtract-feature',
      sourceType: 'dxf' as const,
      profile: rectProfile(10, 10, 20, 20),
      layerName: null,
    },
    {
      name: 'line-feature',
      sourceType: 'dxf' as const,
      profile: rectProfile(50, 50, 10, 10),
      layerName: null,
    },
  ]

  const classified: ClassifiedShape[] = [
    makeClassified({ name: 'add-feature', profile: shapes[0].profile, operation: 'add', sourceIndex: 0 }),
    makeClassified({ name: 'subtract-feature', profile: shapes[1].profile, operation: 'subtract', sourceIndex: 1 }),
    makeClassified({ name: 'line-feature', profile: shapes[2].profile, operation: 'line', sourceIndex: 2 }),
  ]

  const ids = store.importShapes({
    fileName: 'test.dxf',
    sourceType: 'dxf',
    shapes,
    classified,
  })

  assert(ids.length === 3, `expected 3 created features, got ${ids.length}`)

  const addFeat = getFeatureById(ids[0])
  assert(addFeat?.operation === 'add', `index 0 should be add, got ${addFeat?.operation}`)
  assert(addFeat?.name === 'add-feature', 'name preserved')

  const subFeat = getFeatureById(ids[1])
  assert(subFeat?.operation === 'subtract', `index 1 should be subtract, got ${subFeat?.operation}`)
  assert(subFeat?.name === 'subtract-feature', 'name preserved')

  const lineFeat = getFeatureById(ids[2])
  assert(lineFeat?.operation === 'line', `index 2 should be line, got ${lineFeat?.operation}`)
  assert(lineFeat?.name === 'line-feature', 'name preserved')
}

// ── fallback: no classified uses legacy behavior ───────────────────────

function test_no_classified_fallback(): void {
  resetStore()
  const store = useProjectStore.getState()

  const ids = store.importShapes({
    fileName: 'test.svg',
    sourceType: 'svg',
    shapes: [
      {
        name: 'closed',
        sourceType: 'svg' as const,
        profile: rectProfile(0, 0, 10, 10),
        layerName: null,
      },
      {
        name: 'open',
        sourceType: 'svg' as const,
        profile: {
          start: { x: 0, y: 0 },
          segments: [{ type: 'line' as const, to: { x: 10, y: 0 } }],
          closed: false,
        },
        layerName: null,
      },
    ],
  })

  assert(ids.length === 2, `expected 2 features, got ${ids.length}`)
  const closedFeat = getFeatureById(ids[0])
  assert(closedFeat?.operation === 'add', `closed default should be add, got ${closedFeat?.operation}`)
  const openFeat = getFeatureById(ids[1])
  assert(openFeat?.operation === 'line', `open default should be line, got ${openFeat?.operation}`)
}

// ── definitions created for all imported features ──────────────────────

function test_classified_definitions_created(): void {
  resetStore()
  const store = useProjectStore.getState()

  const profile = rectProfile(0, 0, 10, 10)
  store.importShapes({
    fileName: 'test.dxf',
    sourceType: 'dxf',
    shapes: [
      {
        name: 'feat1',
        sourceType: 'dxf' as const,
        profile,
        layerName: null,
      },
    ],
    classified: [
      makeClassified({ name: 'feat1', profile, operation: 'subtract', sourceIndex: 0 }),
    ],
  })

  const features = getFeatures()
  const defs = getDefinitions()
  assert(features.length === 1, '1 feature')
  assert(Object.keys(defs).length === 1, '1 definition')
  const feat = features[0]
  assert(feat.operation === 'subtract', 'operation is subtract')
}

// ── history recorded ───────────────────────────────────────────────────

function test_classified_history_recorded(): void {
  resetStore()
  const store = useProjectStore.getState()

  const prevPastLen = getHistory().past.length
  const profile = rectProfile(0, 0, 10, 10)
  store.importShapes({
    fileName: 'test.svg',
    sourceType: 'svg',
    shapes: [
      {
        name: 'feat1',
        sourceType: 'svg' as const,
        profile,
        layerName: null,
      },
    ],
    classified: [
      makeClassified({ name: 'feat1', profile, operation: 'add', sourceIndex: 0 }),
    ],
  })

  const history = getHistory()
  assert(history.past.length === prevPastLen + 1, 'history past grew')
  assert(history.future.length === 0, 'history future cleared')
}

// ── folder / layer grouping preserved ──────────────────────────────────

function test_classified_layer_grouping(): void {
  resetStore()
  const store = useProjectStore.getState()

  const profile1 = rectProfile(0, 0, 10, 10)
  const profile2 = {
    start: { x: 0, y: 0 },
    segments: [{ type: 'line' as const, to: { x: 10, y: 0 } }],
    closed: false,
  }

  store.importShapes({
    fileName: 'test.dxf',
    sourceType: 'dxf',
    shapes: [
      {
        name: 'cutout',
        sourceType: 'dxf' as const,
        profile: profile1,
        layerName: 'Cutouts',
      },
      {
        name: 'engrave',
        sourceType: 'dxf' as const,
        profile: profile2,
        layerName: 'Engrave',
      },
    ],
    classified: [
      makeClassified({ name: 'cutout', profile: profile1, layerName: 'Cutouts', operation: 'subtract', sourceIndex: 0 }),
      makeClassified({ name: 'engrave', profile: profile2, layerName: 'Engrave', operation: 'line', sourceIndex: 1 }),
    ],
  })

  const features = getFeatures()
  assert(features.length === 2, '2 features')
  const folders = getFolders()
  assert(folders.length === 2, `2 folders for 2 layers, got ${folders.length}`)
  const cutoutFeat = features.find((f) => f.name === 'cutout')
  const engraveFeat = features.find((f) => f.name === 'engrave')
  assert(cutoutFeat?.folderId !== engraveFeat?.folderId, 'different layers → different folders')
  assert(cutoutFeat?.operation === 'subtract', 'cutout is subtract')
  assert(engraveFeat?.operation === 'line', 'engrave is line')
}

// ── regression: child-first source order → parent-before-child features ─

function test_child_first_source_preserves_classifier_order(): void {
  resetStore()
  const store = useProjectStore.getState()

  // Source: child (inner) before parent (outer).
  const innerProfile = rectProfile(20, 20, 10, 10)
  const outerProfile = rectProfile(0, 0, 100, 100)

  const shapes = [
    {
      name: 'inner',
      sourceType: 'dxf' as const,
      profile: innerProfile,
      layerName: null,
    },
    {
      name: 'outer',
      sourceType: 'dxf' as const,
      profile: outerProfile,
      layerName: null,
    },
  ]

  // Classifier output: parent-before-child (depth 0 Add, depth 1 Subtract).
  const classified: ClassifiedShape[] = [
    makeClassified({ name: 'outer', profile: outerProfile, operation: 'add', sourceIndex: 1 }),
    makeClassified({ name: 'inner', profile: innerProfile, operation: 'subtract', sourceIndex: 0 }),
  ]

  const ids = store.importShapes({
    fileName: 'test.dxf',
    sourceType: 'dxf',
    shapes,
    classified,
  })

  assert(ids.length === 2, `expected 2 features, got ${ids.length}`)

  // Feature order must be parent (add) then child (subtract), NOT source order.
  const features = getFeatures()
  assert(features.length === 2, '2 features in project')
  assert(features[0].name === 'outer', `first feature should be outer, got ${features[0].name}`)
  assert(features[0].operation === 'add', `outer should be add, got ${features[0].operation}`)
  assert(features[1].name === 'inner', `second feature should be inner, got ${features[1].name}`)
  assert(features[1].operation === 'subtract', `inner should be subtract, got ${features[1].operation}`)

  // Definitions and history must exist.
  const defs = getDefinitions()
  assert(Object.keys(defs).length === 2, '2 definitions')
  assert(getHistory().past.length >= 1, 'history recorded')
}

// ── regression: degenerate prefix does not shift operations ────────────

function test_degenerate_prefix_no_shift(): void {
  resetStore()
  const store = useProjectStore.getState()

  // A zero-area profile (degenerate) followed by valid shapes.
  const degenerateProfile = rectProfile(5, 5, 5, 5)
  // Override with a degenerate: all points at same coordinate.
  degenerateProfile.segments = []

  const outerProfile = rectProfile(0, 0, 100, 100)
  const innerProfile = rectProfile(20, 20, 10, 10)

  const shapes = [
    {
      name: 'degenerate',
      sourceType: 'dxf' as const,
      profile: degenerateProfile,
      layerName: null,
    },
    {
      name: 'outer',
      sourceType: 'dxf' as const,
      profile: outerProfile,
      layerName: null,
    },
    {
      name: 'inner',
      sourceType: 'dxf' as const,
      profile: innerProfile,
      layerName: null,
    },
  ]

  // Classifier output: ignores degenerate, outputs parent→child.
  const classified: ClassifiedShape[] = [
    makeClassified({ name: 'outer', profile: outerProfile, operation: 'add', sourceIndex: 1 }),
    makeClassified({ name: 'inner', profile: innerProfile, operation: 'subtract', sourceIndex: 2 }),
  ]

  const ids = store.importShapes({
    fileName: 'test.dxf',
    sourceType: 'dxf',
    shapes,
    classified,
  })

  assert(ids.length === 2, `expected 2 features, got ${ids.length} (degenerate filtered)`)

  const features = getFeatures()
  assert(features.length === 2, '2 features')
  assert(features[0].name === 'outer', `first should be outer, got ${features[0].name}`)
  assert(features[0].operation === 'add', 'outer is add')
  assert(features[1].name === 'inner', `second should be inner, got ${features[1].name}`)
  assert(features[1].operation === 'subtract', 'inner is subtract')
}

// ── regression: cross-layer parent-before-child ordering ───────────────

function test_cross_layer_ordering(): void {
  resetStore()
  const store = useProjectStore.getState()

  // Child in layer B appears before parent in layer A in source order.
  // Classifier puts parent (depth 0) before child (depth 1).
  const innerProfile = rectProfile(20, 20, 10, 10)
  const outerProfile = rectProfile(0, 0, 100, 100)

  const shapes = [
    {
      name: 'inner',
      sourceType: 'dxf' as const,
      profile: innerProfile,
      layerName: 'LayerB',
    },
    {
      name: 'outer',
      sourceType: 'dxf' as const,
      profile: outerProfile,
      layerName: 'LayerA',
    },
  ]

  const classified: ClassifiedShape[] = [
    makeClassified({ name: 'outer', profile: outerProfile, layerName: 'LayerA', operation: 'add', sourceIndex: 1 }),
    makeClassified({ name: 'inner', profile: innerProfile, layerName: 'LayerB', operation: 'subtract', sourceIndex: 0 }),
  ]

  const ids = store.importShapes({
    fileName: 'test.dxf',
    sourceType: 'dxf',
    shapes,
    classified,
  })

  assert(ids.length === 2, `expected 2 features, got ${ids.length}`)

  const features = getFeatures()
  assert(features.length === 2, '2 features')
  // Parent (outer, LayerA) must be created before child (inner, LayerB)
  assert(features[0].name === 'outer', `first should be outer, got ${features[0].name}`)
  assert(features[0].operation === 'add', 'outer is add')
  assert(features[1].name === 'inner', `second should be inner, got ${features[1].name}`)
  assert(features[1].operation === 'subtract', 'inner is subtract')

  // Both layers get folders in first-seen order (LayerA, then LayerB from classifier).
  const folders = getFolders()
  assert(folders.length === 2, `expected 2 folders, got ${folders.length}`)
  assert(folders[0].name === 'LayerA', `first folder should be LayerA, got ${folders[0].name}`)
  assert(folders[1].name === 'LayerB', `second folder should be LayerB, got ${folders[1].name}`)

  // Features are in the correct folders.
  assert(features[0].folderId === folders[0].id, 'outer in LayerA folder')
  assert(features[1].folderId === folders[1].id, 'inner in LayerB folder')
}

// ── run ────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

const tests: Array<{ name: string; fn: () => void }> = [
  { name: 'classified honored', fn: test_classified_honored },
  { name: 'no classified fallback', fn: test_no_classified_fallback },
  { name: 'definitions created', fn: test_classified_definitions_created },
  { name: 'history recorded', fn: test_classified_history_recorded },
  { name: 'layer grouping preserved', fn: test_classified_layer_grouping },
  { name: 'child-first source → parent-before-child', fn: test_child_first_source_preserves_classifier_order },
  { name: 'degenerate prefix no shift', fn: test_degenerate_prefix_no_shift },
  { name: 'cross-layer ordering', fn: test_cross_layer_ordering },
]

for (const t of tests) {
  try {
    t.fn()
    console.log(`${t.name}: PASSED`)
    passed += 1
  } catch (err) {
    console.log(`${t.name}: FAILED — ${err instanceof Error ? err.message : err}`)
    failed += 1
  }
}

console.log(`\nImport roles store: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
