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
 * Folder Transform Groups — Slice 1 unit tests.
 *
 * Run with: npx tsx src/store/folderGroup.test.ts
 */

import { newProject, type FeatureFolder, type Project } from '../types/project'
import { syncFeatureTreeProject } from './helpers/normalize'
import { useProjectStore } from './projectStore'

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
// 1. Migration — folder missing `grouped` normalizes to false
// ============================================================================

console.log('\nMigration — folder missing grouped normalizes to false')

test('folder without grouped field gets grouped === false', () => {
  const project = newProject()
  const rawFolder = { id: 'fd-test', name: 'Test', collapsed: false } as FeatureFolder
  // Cast through unknown to simulate loaded JSON missing the grouped field
  const loaded = {
    ...project,
    featureFolders: [rawFolder],
    featureTree: [{ type: 'folder' as const, folderId: 'fd-test' }],
  }
  const normalized = syncFeatureTreeProject(loaded)
  const folder = normalized.featureFolders.find((f) => f.id === 'fd-test')
  assert(folder !== undefined, 'folder should exist after sync')
  assert(folder.grouped === false, `expected grouped === false, got ${folder.grouped}`)
})

test('folder with grouped: true preserves the value', () => {
  const project = newProject()
  const folder: FeatureFolder = { id: 'fd-test', name: 'Test', collapsed: false, grouped: true }
  const loaded = {
    ...project,
    featureFolders: [folder],
    featureTree: [{ type: 'folder' as const, folderId: 'fd-test' }],
  }
  const normalized = syncFeatureTreeProject(loaded)
  const result = normalized.featureFolders.find((f) => f.id === 'fd-test')
  assert(result !== undefined, 'folder should exist after sync')
  assert(result.grouped === true, `expected grouped === true, got ${result.grouped}`)
})

// ============================================================================
// 2. toggleFolderGrouped — flips the flag on the target folder only
// ============================================================================

console.log('\ntoggleFolderGrouped — flips grouped on target folder only')

test('toggleFolderGrouped sets grouped: true on a default folder', () => {
  resetStore()
  const folderId = useProjectStore.getState().addFeatureFolder('features')
  const stateAfterAdd = useProjectStore.getState()
  const before = stateAfterAdd.project.featureFolders.find((f) => f.id === folderId)
  assert(before !== undefined, 'folder should exist')
  assert(before.grouped === false, `expected initial grouped === false, got ${before.grouped}`)

  stateAfterAdd.toggleFolderGrouped(folderId)
  const after = useProjectStore.getState().project.featureFolders.find((f) => f.id === folderId)
  assert(after !== undefined, 'folder should still exist')
  assert(after.grouped === true, `expected grouped === true after toggle, got ${after.grouped}`)
})

test('toggleFolderGrouped flips back to false on second call', () => {
  resetStore()
  const folderId = useProjectStore.getState().addFeatureFolder('features')

  useProjectStore.getState().toggleFolderGrouped(folderId)
  assert(
    useProjectStore.getState().project.featureFolders.find((f) => f.id === folderId)?.grouped === true,
    'first toggle should set grouped to true',
  )

  useProjectStore.getState().toggleFolderGrouped(folderId)
  assert(
    useProjectStore.getState().project.featureFolders.find((f) => f.id === folderId)?.grouped === false,
    'second toggle should set grouped back to false',
  )
})

test('toggleFolderGrouped does not affect other folders', () => {
  resetStore()
  const folderA = useProjectStore.getState().addFeatureFolder('features')
  const folderB = useProjectStore.getState().addFeatureFolder('features')

  useProjectStore.getState().toggleFolderGrouped(folderA)

  const state = useProjectStore.getState()
  const a = state.project.featureFolders.find((f) => f.id === folderA)
  const b = state.project.featureFolders.find((f) => f.id === folderB)

  assert(a?.grouped === true, `folder A should be grouped === true, got ${a?.grouped}`)
  assert(b?.grouped === false, `folder B should be grouped === false, got ${b?.grouped}`)
})

test('toggleFolderGrouped on unknown folder is a no-op', () => {
  resetStore()
  const before = useProjectStore.getState().project.featureFolders.length
  useProjectStore.getState().toggleFolderGrouped('nonexistent')
  const after = useProjectStore.getState().project.featureFolders.length
  assert(before === after, 'folder count should not change')
})

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exitCode = 1
}
