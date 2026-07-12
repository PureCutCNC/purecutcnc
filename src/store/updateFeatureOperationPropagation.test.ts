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
 * P1b regression test: updateFeature operation change on a linked instance
 * propagates to the definition and all siblings.
 *
 * Run with: npx tsx src/store/updateFeatureOperationPropagation.test.ts
 */

import {
  newProject,
  type Matrix2D,
  type Project,
  type SketchFeature,
} from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { resolveFeatureInstance } from './helpers/resolveFeatures'

// ── Helpers ──────────────────────────────────────────────────────────

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

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
  } as unknown as Partial<ProjectStore>)
}

function addLinkedPair(): { featureA: SketchFeature; featureB: SketchFeature; defId: string } {
  const store = useProjectStore.getState()

  // Add a dummy "base plate" feature first so the linked pair isn't guarded
  // by the isFirst→force-add rule (first feature must be 'add').
  store.addRectFeature('BasePlate', 0, 0, 200, 200, 10)

  // Create the actual base rect strictly inside the plate so the nesting
  // default makes it Subtract. Avoid a shared boundary at (0, 0), which is
  // intentionally ambiguous and therefore defaults Add.
  store.addRectFeature('Base', 10, 10, 60, 40, 5)
  const features1 = useProjectStore.getState().project.features
  const base = features1[1] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const defId = base.definitionId!

  // Create a linked copy via store (translate by 80, 0)
  store.selectFeature(base.id)
  store.startCopyFeature(base.id, 'reference')
  store.setPendingMoveFrom({ x: 0, y: 0 })
  store.completePendingMove({ x: 80, y: 0 })

  const features = useProjectStore.getState().project.features
  const linked = features[2] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  assert(linked.definitionId === defId, 'linked copy should share definitionId')
  assert(features.length === 3, `should have 3 features, got ${features.length}`)

  return { featureA: base, featureB: linked, defId }
}

function getProject(): Project {
  return useProjectStore.getState().project
}

// ── Test runner ──────────────────────────────────────────────────────

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

// =====================================================================
// P1b: operation change on linked instance propagates to def + siblings
// =====================================================================

console.log('\nP1b — updateFeature operation propagation on linked instances')

test('operation change on linked instance updates definition + all siblings', () => {
  resetStore()
  const { featureA, featureB, defId } = addLinkedPair()

  // Both start as 'subtract' (addRectFeature defaults to subtract)
  const project = getProject()
  assert(project.featureDefinitions[defId].operation === 'subtract', 'definition operation should start as subtract')

  // Change feature A's operation to 'add' (valid: not isFirst-guarded, can always go to add)
  useProjectStore.getState().updateFeature(featureA.id, { operation: 'add' })

  const afterProject = getProject()

  // Definition operation should be updated
  assert(afterProject.featureDefinitions[defId].operation === 'add',
    `definition operation should be add, got ${afterProject.featureDefinitions[defId].operation}`)

  // Both instance rows should agree
  const afterA = afterProject.features.find((f) => f.id === featureA.id)!
  const afterB = afterProject.features.find((f) => f.id === featureB.id)!
  assert(afterA.operation === 'add', `feature A operation should be add, got ${afterA.operation}`)
  assert(afterB.operation === 'add', `feature B operation should be add, got ${afterB.operation}`)

  // Resolver should report the new operation for both
  const resolvedA = resolveFeatureInstance(afterProject, featureA.id)
  const resolvedB = resolveFeatureInstance(afterProject, featureB.id)
  assert(resolvedA !== null, 'resolved A should not be null')
  assert(resolvedB !== null, 'resolved B should not be null')
  assert(resolvedA!.operation === 'add', `resolved A operation should be add, got ${resolvedA!.operation}`)
  assert(resolvedB!.operation === 'add', `resolved B operation should be add, got ${resolvedB!.operation}`)
})

test('operation change on linked instance is undoable (one step restores all)', () => {
  resetStore()
  const { featureA, featureB, defId } = addLinkedPair()

  // Both start as 'subtract'
  const project = getProject()
  assert(project.featureDefinitions[defId].operation === 'subtract', 'pre: definition operation should be subtract')

  useProjectStore.getState().updateFeature(featureA.id, { operation: 'add' })

  // One undo restores everything
  useProjectStore.getState().undo()

  const undoneProject = getProject()
  assert(undoneProject.featureDefinitions[defId].operation === 'subtract', 'undo: definition operation should be subtract again')

  const undoneA = undoneProject.features.find((f) => f.id === featureA.id)!
  const undoneB = undoneProject.features.find((f) => f.id === featureB.id)!
  assert(undoneA.operation === 'subtract', 'undo: feature A should be subtract')
  assert(undoneB.operation === 'subtract', 'undo: feature B should be subtract')
})

test('non-linked (unique) feature operation change works as before', () => {
  resetStore()
  const store = useProjectStore.getState()

  // Add a dummy first feature so the unique feature isn't guarded by isFirst
  store.addRectFeature('BasePlate', 0, 0, 200, 200, 10)

  // Create a unique rect feature (second in tree, starts as 'subtract')
  store.addRectFeature('Unique', 10, 20, 30, 15, 5)
  const f = useProjectStore.getState().project.features[1] as SketchFeature & { definitionId?: string }

  // Change its operation to 'add'
  store.updateFeature(f.id, { operation: 'add' })

  const after = getProject()
  const afterF = after.features.find((feat) => feat.id === f.id)!
  assert(afterF.operation === 'add', `unique feature operation should be add, got ${afterF.operation}`)

  // Definition should also be updated
  const defId = f.definitionId!
  assert(after.featureDefinitions[defId].operation === 'add',
    `unique definition operation should be add, got ${after.featureDefinitions[defId].operation}`)

  // Other fields in the patch still apply normally
  store.updateFeature(f.id, { name: 'Renamed', operation: 'subtract' })
  const after2 = getProject()
  const f2 = after2.features.find((feat) => feat.id === f.id)!
  assert(f2.name === 'Renamed', `name should be updated, got ${f2.name}`)
  assert(f2.operation === 'subtract', `operation should be subtract, got ${f2.operation}`)
})

// =====================================================================
// Summary
// =====================================================================

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
