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
import { projectsEqual, syncFeatureTreeProject } from './helpers/normalize'
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
// 2b. toggleFolderGrouped — groupFolderId reconciliation
// ============================================================================

console.log('\ntoggleFolderGrouped — groupFolderId reconciliation')

test('toggling a grouped folder OFF while it is the active group selection clears groupFolderId to null', () => {
  resetStore()

  // Create a grouped folder with features
  const folderId = useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().toggleFolderGrouped(folderId)
  useProjectStore.getState().addRectFeature('F1', 0, 0, 100, 100, 5)
  const f1 = useProjectStore.getState().selection.selectedFeatureId!
  useProjectStore.getState().addRectFeature('F2', 200, 0, 100, 100, 5)
  const f2 = useProjectStore.getState().selection.selectedFeatureId!

  // Deselect, then select one feature to trigger group expansion
  useProjectStore.getState().selectProject()
  useProjectStore.getState().selectFeature(f1, false)

  // Verify groupFolderId is set
  const selBefore = useProjectStore.getState().selection
  assert(
    selBefore.groupFolderId === folderId,
    `expected groupFolderId === ${folderId}, got ${selBefore.groupFolderId}`,
  )

  // Toggle grouping OFF
  useProjectStore.getState().toggleFolderGrouped(folderId)

  const selAfter = useProjectStore.getState().selection
  assert(
    selAfter.groupFolderId === null,
    `expected groupFolderId === null after turning grouping off, got ${selAfter.groupFolderId}`,
  )
  // grouped flag is flipped
  const folder = useProjectStore.getState().project.featureFolders.find((f) => f.id === folderId)
  assert(folder?.grouped === false, `expected folder grouped === false, got ${folder?.grouped}`)
  // selection is otherwise unchanged
  assert(selAfter.selectedFeatureIds.includes(f1), 'f1 should still be selected')
  assert(selAfter.selectedFeatureIds.includes(f2), 'f2 should still be selected')
})

test('toggling a folder ON while its members are the current selection sets groupFolderId to that folder', () => {
  resetStore()

  // Create a non-grouped folder with features
  const folderId = useProjectStore.getState().addFeatureFolder('features')
  // grouped stays false (default)
  useProjectStore.getState().addRectFeature('F1', 0, 0, 100, 100, 5)
  const f1 = useProjectStore.getState().selection.selectedFeatureId!
  useProjectStore.getState().addRectFeature('F2', 200, 0, 100, 100, 5)
  const f2 = useProjectStore.getState().selection.selectedFeatureId!

  // Select both features in the folder
  useProjectStore.getState().selectFeatures([f1, f2])
  const selBefore = useProjectStore.getState().selection
  assert(
    selBefore.groupFolderId === (undefined as unknown) || selBefore.groupFolderId === null,
    `expected groupFolderId to be undefined/null before toggle, got ${selBefore.groupFolderId}`,
  )

  // Toggle grouping ON
  useProjectStore.getState().toggleFolderGrouped(folderId)

  const selAfter = useProjectStore.getState().selection
  assert(
    selAfter.groupFolderId === folderId,
    `expected groupFolderId === ${folderId} after turning grouping on, got ${selAfter.groupFolderId}`,
  )
  // grouped flag is flipped
  const folder = useProjectStore.getState().project.featureFolders.find((f) => f.id === folderId)
  assert(folder?.grouped === true, `expected folder grouped === true, got ${folder?.grouped}`)
  // selection is otherwise unchanged
  assert(selAfter.selectedFeatureIds.includes(f1), 'f1 should still be selected')
  assert(selAfter.selectedFeatureIds.includes(f2), 'f2 should still be selected')
})

test('toggling a folder whose members are NOT the current selection does not change groupFolderId', () => {
  resetStore()

  // Create a folder with features
  const folderId = useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().addRectFeature('F1', 0, 0, 100, 100, 5)
  useProjectStore.getState().addRectFeature('F2', 200, 0, 100, 100, 5)

  // Create a second folder with a feature (not selected)
  useProjectStore.getState().selectProject()
  useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().addRectFeature('F3', 0, 200, 100, 100, 5)
  const f3 = useProjectStore.getState().selection.selectedFeatureId!

  // Select only the feature in the other folder
  useProjectStore.getState().selectFeature(f3, false)
  const selBefore = useProjectStore.getState().selection
  const initialGroupFolderId = selBefore.groupFolderId

  // Toggle grouping ON for the folder whose members are NOT selected
  useProjectStore.getState().toggleFolderGrouped(folderId)

  const selAfter = useProjectStore.getState().selection
  assert(
    selAfter.groupFolderId === (initialGroupFolderId ?? null),
    `expected groupFolderId to remain ${initialGroupFolderId}, got ${selAfter.groupFolderId}`,
  )
  // grouped flag is still flipped
  const folder = useProjectStore.getState().project.featureFolders.find((f) => f.id === folderId)
  assert(folder?.grouped === true, `expected folder grouped === true, got ${folder?.grouped}`)
})

// ============================================================================
// 3. Slice 2a — group selection (store only)
// ============================================================================

console.log('\nSlice 2a — group selection')

test('selectFeature on a grouped folder member expands to all members and sets groupFolderId', () => {
  resetStore()

  // Create a folder (this selects the folder so new features auto-assign)
  const folderId = useProjectStore.getState().addFeatureFolder('features')
  // Toggle to grouped
  useProjectStore.getState().toggleFolderGrouped(folderId)

  // Add features — they auto-assign to the selected folder
  useProjectStore.getState().addRectFeature('F1', 0, 0, 100, 100, 5)
  const f1 = useProjectStore.getState().selection.selectedFeatureId!
  useProjectStore.getState().addRectFeature('F2', 200, 0, 100, 100, 5)
  const f2 = useProjectStore.getState().selection.selectedFeatureId!

  // Deselect by clicking project, so we can test single-feature select
  useProjectStore.getState().selectProject()

  // Select f1 non-additively
  useProjectStore.getState().selectFeature(f1, false)
  const sel = useProjectStore.getState().selection

  assert(
    sel.selectedFeatureIds.length === 2,
    `expected 2 selected features, got ${sel.selectedFeatureIds.length}`,
  )
  assert(sel.selectedFeatureIds.includes(f1), 'f1 should be selected')
  assert(sel.selectedFeatureIds.includes(f2), 'f2 should be selected')
  assert(sel.groupFolderId === folderId, `expected groupFolderId === ${folderId}, got ${sel.groupFolderId}`)
})

test('selectFeature on a non-grouped folder member selects only that feature and leaves groupFolderId null', () => {
  resetStore()

  // Create a folder (not grouped)
  useProjectStore.getState().addFeatureFolder('features')
  // Keep grouped === false (default)

  // Add features
  useProjectStore.getState().addRectFeature('F1', 0, 0, 100, 100, 5)
  const f1 = useProjectStore.getState().selection.selectedFeatureId!
  useProjectStore.getState().addRectFeature('F2', 200, 0, 100, 100, 5)

  // Deselect
  useProjectStore.getState().selectProject()

  // Select f1 non-additively
  useProjectStore.getState().selectFeature(f1, false)
  const sel = useProjectStore.getState().selection

  assert(
    sel.selectedFeatureIds.length === 1,
    `expected 1 selected feature, got ${sel.selectedFeatureIds.length}`,
  )
  assert(sel.selectedFeatureIds[0] === f1, `expected f1 selected, got ${sel.selectedFeatureIds[0]}`)
  assert(sel.groupFolderId === null, `expected groupFolderId === null, got ${sel.groupFolderId}`)
})

test('selectFolderFeatures on a grouped folder sets groupFolderId, on a non-grouped folder it is null', () => {
  resetStore()

  // Create a grouped folder
  const groupedFolderId = useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().toggleFolderGrouped(groupedFolderId)
  useProjectStore.getState().addRectFeature('GF1', 0, 0, 100, 100, 5)
  useProjectStore.getState().addRectFeature('GF2', 200, 0, 100, 100, 5)

  // Create a non-grouped folder (select project first so next folder doesn't inherit selection context)
  useProjectStore.getState().selectProject()
  const normalFolderId = useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().addRectFeature('NF1', 0, 200, 100, 100, 5)

  // Test grouped folder
  useProjectStore.getState().selectFolderFeatures(groupedFolderId)
  const selGrouped = useProjectStore.getState().selection
  assert(
    selGrouped.groupFolderId === groupedFolderId,
    `expected groupFolderId === ${groupedFolderId}, got ${selGrouped.groupFolderId}`,
  )

  // Test non-grouped folder
  useProjectStore.getState().selectFolderFeatures(normalFolderId)
  const selNormal = useProjectStore.getState().selection
  assert(
    selNormal.groupFolderId === null,
    `expected groupFolderId === null for non-grouped folder, got ${selNormal.groupFolderId}`,
  )
})

test('after a group selection, a subsequent ungrouped single-feature select resets groupFolderId to null', () => {
  resetStore()

  // Create a grouped folder with features
  const groupedFolderId = useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().toggleFolderGrouped(groupedFolderId)
  useProjectStore.getState().addRectFeature('GF1', 0, 0, 100, 100, 5)

  // Create a non-grouped folder with a feature
  useProjectStore.getState().selectProject()
  useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().addRectFeature('NF1', 0, 200, 100, 100, 5)
  const nf1 = useProjectStore.getState().selection.selectedFeatureId!

  // Deselect
  useProjectStore.getState().selectProject()

  // First, select a feature in the grouped folder to establish groupFolderId
  const state = useProjectStore.getState()
  const gf1 = state.project.features.find((f) => f.folderId === groupedFolderId)!.id
  useProjectStore.getState().selectFeature(gf1, false)
  const selGrouped = useProjectStore.getState().selection
  assert(
    selGrouped.groupFolderId === groupedFolderId,
    `expected groupFolderId === ${groupedFolderId} after group select, got ${selGrouped.groupFolderId}`,
  )

  // Now select a feature in the non-grouped folder
  useProjectStore.getState().selectFeature(nf1, false)
  const selNormal = useProjectStore.getState().selection
  assert(
    selNormal.groupFolderId === null,
    `expected groupFolderId === null after ungrouped select, got ${selNormal.groupFolderId}`,
  )
  assert(
    selNormal.selectedFeatureIds.length === 1,
    `expected 1 selected feature after ungrouped select, got ${selNormal.selectedFeatureIds.length}`,
  )
  assert(selNormal.selectedFeatureIds[0] === nf1, 'expected nf1 to be selected')
})

// ============================================================================
// 4. P2-1 — lock members into a grouped folder
// ============================================================================

console.log('\nP2-1 — lock members into a grouped folder')

function setupGroupedFolder(): { folderId: string; f1: string; f2: string } {
  resetStore()
  const folderId = useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().toggleFolderGrouped(folderId)
  useProjectStore.getState().addRectFeature('F1', 0, 0, 100, 100, 5)
  const f1 = useProjectStore.getState().selection.selectedFeatureId!
  useProjectStore.getState().addRectFeature('F2', 200, 0, 100, 100, 5)
  const f2 = useProjectStore.getState().selection.selectedFeatureId!
  return { folderId, f1, f2 }
}

test('moveFeatureTreeFeature cannot move feature out of grouped folder to root', () => {
  const { f1 } = setupGroupedFolder()
  const before = useProjectStore.getState().project

  useProjectStore.getState().moveFeatureTreeFeature(f1, null) // move to root

  const after = useProjectStore.getState().project
  const feature = after.features.find((f) => f.id === f1)
  assert(feature !== undefined, 'feature should still exist')
  assert(
    feature.folderId !== null,
    `expected feature to still be in its folder (folderId !== null), got folderId=${feature.folderId}`,
  )
  assert(
    projectsEqual(before, after),
    'project state should be unchanged when move is rejected',
  )
})

test('moveFeatureTreeFeature cannot move feature from one grouped folder to another folder', () => {
  const { f1 } = setupGroupedFolder()
  // Create a second folder
  useProjectStore.getState().selectProject()
  const otherFolderId = useProjectStore.getState().addFeatureFolder('features')
  const before = useProjectStore.getState().project

  useProjectStore.getState().moveFeatureTreeFeature(f1, otherFolderId)

  const after = useProjectStore.getState().project
  const feature = after.features.find((f) => f.id === f1)
  assert(feature !== undefined, 'feature should still exist')
  assert(
    feature.folderId !== otherFolderId,
    `expected feature to NOT be in otherFolderId, got folderId=${feature.folderId}`,
  )
  assert(
    projectsEqual(before, after),
    'project state should be unchanged when move is rejected',
  )
})

test('moveFeatureTreeFeature can reorder within the same grouped folder', () => {
  const { folderId, f1, f2 } = setupGroupedFolder()
  const state = useProjectStore.getState()
  // f2 is the second feature; reorder f1 before f2
  state.moveFeatureTreeFeature(f1, folderId, f2)

  const features = useProjectStore.getState().project.features
  const f1Index = features.findIndex((f) => f.id === f1)
  const f2Index = features.findIndex((f) => f.id === f2)

  assert(f1Index !== -1, 'f1 should exist')
  assert(f2Index !== -1, 'f2 should exist')
  assert(f1Index < f2Index, `f1 should be before f2 after reorder, got f1=${f1Index}, f2=${f2Index}`)
})

test('feature in non-grouped folder can still be moved freely (regression)', () => {
  resetStore()
  // Create a non-grouped folder (feature goes into it, then we move it out)
  useProjectStore.getState().addFeatureFolder('features')
  // grouped stays false (default)
  useProjectStore.getState().addRectFeature('F1', 0, 0, 100, 100, 5)
  const f1 = useProjectStore.getState().selection.selectedFeatureId!

  // Move to root
  useProjectStore.getState().moveFeatureTreeFeature(f1, null)
  const after = useProjectStore.getState().project.features.find((f) => f.id === f1)
  assert(after !== undefined, 'feature should still exist')
  assert(after.folderId === null, `expected feature at root, got folderId=${after.folderId}`)
})

test('moving a feature into a grouped folder succeeds', () => {
  const { folderId } = setupGroupedFolder()
  // Create a feature in root
  useProjectStore.getState().selectProject()
  useProjectStore.getState().addRectFeature('RootF', 0, 200, 100, 100, 5)
  const rootF = useProjectStore.getState().selection.selectedFeatureId!

  // Move rootF into the grouped folder
  useProjectStore.getState().moveFeatureTreeFeature(rootF, folderId)
  const after = useProjectStore.getState().project.features.find((f) => f.id === rootF)
  assert(after !== undefined, 'feature should still exist')
  assert(after.folderId === folderId, `expected feature in grouped folder, got folderId=${after.folderId}`)
})

test('assignFeaturesToFolder does not relocate a feature in a grouped folder to a different folder', () => {
  const { folderId, f1 } = setupGroupedFolder()
  // Create another folder
  useProjectStore.getState().selectProject()
  const otherFolderId = useProjectStore.getState().addFeatureFolder('features')

  // Try to assign f1 (in grouped folder) to otherFolderId
  useProjectStore.getState().assignFeaturesToFolder([f1], otherFolderId)
  const after = useProjectStore.getState().project.features.find((f) => f.id === f1)
  assert(after !== undefined, 'feature should still exist')
  assert(
    after.folderId === folderId,
    `expected feature to still be in original grouped folder, got folderId=${after.folderId}`,
  )
})

test('assignFeaturesToFolder still works for non-grouped features (regression)', () => {
  resetStore()
  useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().addRectFeature('F1', 0, 0, 100, 100, 5)
  const f1 = useProjectStore.getState().selection.selectedFeatureId!

  useProjectStore.getState().selectProject()
  const otherFolderId = useProjectStore.getState().addFeatureFolder('features')

  // Move f1 (non-grouped) to otherFolderId
  useProjectStore.getState().assignFeaturesToFolder([f1], otherFolderId)
  const after = useProjectStore.getState().project.features.find((f) => f.id === f1)
  assert(after !== undefined, 'feature should still exist')
  assert(after.folderId === otherFolderId, `expected feature in otherFolderId, got folderId=${after.folderId}`)
})

test('assignFeaturesToFolder moves non-grouped features while skipping grouped ones in mixed batch', () => {
  const { folderId: groupedFolderId, f1: groupedF1 } = setupGroupedFolder()

  // Create a non-grouped folder with a feature
  useProjectStore.getState().selectProject()
  useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().addRectFeature('NF1', 0, 200, 100, 100, 5)
  const normalF = useProjectStore.getState().selection.selectedFeatureId!

  // Create target folder
  useProjectStore.getState().selectProject()
  const targetFolderId = useProjectStore.getState().addFeatureFolder('features')

  // Try to move both the grouped feature and the normal feature to targetFolderId
  useProjectStore.getState().assignFeaturesToFolder([groupedF1, normalF], targetFolderId)

  const after = useProjectStore.getState().project
  const groupedAfter = after.features.find((f) => f.id === groupedF1)
  const normalAfter = after.features.find((f) => f.id === normalF)

  assert(groupedAfter !== undefined, 'grouped feature should still exist')
  assert(
    groupedAfter.folderId === groupedFolderId,
    `grouped feature should stay in original folder, got folderId=${groupedAfter.folderId}`,
  )
  assert(normalAfter !== undefined, 'normal feature should still exist')
  assert(
    normalAfter.folderId === targetFolderId,
    `normal feature should move to target folder, got folderId=${normalAfter.folderId}`,
  )
})

// ============================================================================
// 5. P2-2 — groupSelectedFeaturesIntoNewFolder
// ============================================================================

console.log('\nP2-2 — groupSelectedFeaturesIntoNewFolder')

test('groupSelectedFeaturesIntoNewFolder creates a new grouped folder with selected features', () => {
  resetStore()
  // Create features at root
  useProjectStore.getState().addRectFeature('A', 0, 0, 100, 100, 5)
  const fA = useProjectStore.getState().selection.selectedFeatureId!
  useProjectStore.getState().addRectFeature('B', 200, 0, 100, 100, 5)
  const fB = useProjectStore.getState().selection.selectedFeatureId!

  // Select both features
  useProjectStore.getState().selectFeatures([fA, fB])

  const state = useProjectStore.getState()
  const historyLengthBefore = state.history.past.length
  const folderId = state.groupSelectedFeaturesIntoNewFolder()

  assert(folderId !== '', 'should return a non-empty folder id')
  const after = useProjectStore.getState()

  // Folder created
  const folder = after.project.featureFolders.find((f) => f.id === folderId)
  assert(folder !== undefined, 'folder should exist')
  assert(folder.grouped === true, `expected grouped === true, got ${folder.grouped}`)
  assert(folder.section === 'features', `expected section features, got ${folder.section}`)

  // Features in folder
  const fA2 = after.project.features.find((f) => f.id === fA)
  const fB2 = after.project.features.find((f) => f.id === fB)
  assert(fA2?.folderId === folderId, `fA should be in folder, got folderId=${fA2?.folderId}`)
  assert(fB2?.folderId === folderId, `fB should be in folder, got folderId=${fB2?.folderId}`)

  // Selection
  assert(
    after.selection.selectedFeatureIds.length === 2,
    `expected 2 selected features, got ${after.selection.selectedFeatureIds.length}`,
  )
  assert(after.selection.selectedFeatureIds.includes(fA), 'fA should be selected')
  assert(after.selection.selectedFeatureIds.includes(fB), 'fB should be selected')
  assert(
    after.selection.groupFolderId === folderId,
    `expected groupFolderId === ${folderId}, got ${after.selection.groupFolderId}`,
  )
  assert(
    after.selection.selectedNode?.type === 'folder' && after.selection.selectedNode.folderId === folderId,
    `expected selectedNode to be folder ${folderId}, got ${JSON.stringify(after.selection.selectedNode)}`,
  )

  // Single history entry
  assert(
    after.history.past.length === historyLengthBefore + 1,
    `expected ${historyLengthBefore + 1} history entries, got ${after.history.past.length}`,
  )
})

test('groupSelectedFeaturesIntoNewFolder returns empty string when < 2 features selected', () => {
  resetStore()
  useProjectStore.getState().addRectFeature('A', 0, 0, 100, 100, 5)

  const state = useProjectStore.getState()
  const historyBefore = state.history.past.length
  const result = state.groupSelectedFeaturesIntoNewFolder()

  assert(result === '', `expected empty string, got "${result}"`)
  assert(
    useProjectStore.getState().history.past.length === historyBefore,
    'history should not change',
  )
})

test('groupSelectedFeaturesIntoNewFolder produces a unique folder name', () => {
  resetStore()
  useProjectStore.getState().addFeatureFolder('features') // Folder 1
  useProjectStore.getState().addRectFeature('A', 0, 0, 100, 100, 5)
  const fA = useProjectStore.getState().selection.selectedFeatureId!
  useProjectStore.getState().selectProject()
  useProjectStore.getState().addRectFeature('B', 200, 0, 100, 100, 5)
  const fB = useProjectStore.getState().selection.selectedFeatureId!

  // Select both features
  useProjectStore.getState().selectFeatures([fA, fB])

  const folderId = useProjectStore.getState().groupSelectedFeaturesIntoNewFolder()
  const folder = useProjectStore.getState().project.featureFolders.find((f) => f.id === folderId)
  assert(folder !== undefined, 'folder should exist')
  assert(folder.name.startsWith('Group '), `expected name to start with "Group ", got "${folder.name}"`)
})

// ============================================================================
// 6. P2-2 — Add to folder path
// ============================================================================

console.log('\nP2-2 — Add to folder path')

test('assignFeaturesToFolder moves non-grouped features to an existing folder', () => {
  resetStore()
  useProjectStore.getState().addFeatureFolder('features')
  const folderId = useProjectStore.getState().selection.selectedNode?.type === 'folder'
    ? (useProjectStore.getState().selection.selectedNode as { folderId: string }).folderId
    : ''
  assert(folderId !== '', 'should have selected the new folder')

  useProjectStore.getState().selectProject()
  useProjectStore.getState().addRectFeature('F1', 0, 0, 100, 100, 5)
  const f1 = useProjectStore.getState().selection.selectedFeatureId!
  useProjectStore.getState().addRectFeature('F2', 200, 0, 100, 100, 5)
  const f2 = useProjectStore.getState().selection.selectedFeatureId!

  useProjectStore.getState().assignFeaturesToFolder([f1, f2], folderId)

  const f1After = useProjectStore.getState().project.features.find((f) => f.id === f1)
  const f2After = useProjectStore.getState().project.features.find((f) => f.id === f2)
  assert(f1After?.folderId === folderId, `f1 should be in folder, got ${f1After?.folderId}`)
  assert(f2After?.folderId === folderId, `f2 should be in folder, got ${f2After?.folderId}`)
})

test('assignFeaturesToFolder into a grouped folder succeeds (joins the group)', () => {
  resetStore()
  // Create a grouped folder
  const folderId = useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().toggleFolderGrouped(folderId)
  useProjectStore.getState().addRectFeature('GF1', 0, 0, 100, 100, 5)

  // Create a root feature
  useProjectStore.getState().selectProject()
  useProjectStore.getState().addRectFeature('RF1', 200, 0, 100, 100, 5)
  const rf1 = useProjectStore.getState().selection.selectedFeatureId!

  // Move root feature into the grouped folder
  useProjectStore.getState().assignFeaturesToFolder([rf1], folderId)

  const rf1After = useProjectStore.getState().project.features.find((f) => f.id === rf1)
  assert(rf1After?.folderId === folderId, `rf1 should be in grouped folder, got folderId=${rf1After?.folderId}`)
})

test('assignFeaturesToFolder refuses to move features out of a grouped folder (P2-1 regression)', () => {
  // Setup from existing P2-1 test
  resetStore()
  const folderId = useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().toggleFolderGrouped(folderId)
  useProjectStore.getState().addRectFeature('GF1', 0, 0, 100, 100, 5)
  const gf1 = useProjectStore.getState().selection.selectedFeatureId!

  // Create another folder
  useProjectStore.getState().selectProject()
  const otherFolderId = useProjectStore.getState().addFeatureFolder('features')

  // Try to move gf1 (in grouped folder) to otherFolderId
  useProjectStore.getState().assignFeaturesToFolder([gf1], otherFolderId)

  const gf1After = useProjectStore.getState().project.features.find((f) => f.id === gf1)
  assert(gf1After !== undefined, 'feature should still exist')
  assert(
    gf1After.folderId === folderId,
    `feature should still be in original grouped folder, got folderId=${gf1After.folderId}`,
  )
})

test('creating a new folder and assigning features via addFeatureFolder + assignFeaturesToFolder works', () => {
  resetStore()
  useProjectStore.getState().addRectFeature('F1', 0, 0, 100, 100, 5)
  const f1 = useProjectStore.getState().selection.selectedFeatureId!
  useProjectStore.getState().addRectFeature('F2', 200, 0, 100, 100, 5)
  const f2 = useProjectStore.getState().selection.selectedFeatureId!

  const newFolderId = useProjectStore.getState().addFeatureFolder('features')
  useProjectStore.getState().assignFeaturesToFolder([f1, f2], newFolderId)

  const f1After = useProjectStore.getState().project.features.find((f) => f.id === f1)
  const f2After = useProjectStore.getState().project.features.find((f) => f.id === f2)
  assert(f1After?.folderId === newFolderId, `f1 should be in new folder, got folderId=${f1After?.folderId}`)
  assert(f2After?.folderId === newFolderId, `f2 should be in new folder, got folderId=${f2After?.folderId}`)
})

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exitCode = 1
}
