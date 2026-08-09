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
 * Bulk selection and mutation tests for issue #468 slice S1.
 *
 * Covers: family exclusivity, additive toggle within family, incompatible
 * additive ignore (both directions), visible-only family Select All,
 * center-preserving bulk dimension updates, selection sanitization after bulk
 * delete, one-step undo for bulk operations, sanitizeSelection as centralized
 * invariant boundary, and bulk-mutation no-op checks.
 *
 * Run with: npx tsx src/store/bulkSelection.test.ts
 */

import { useProjectStore } from './projectStore'
import type { ProjectStore, SelectionState } from './types'
import type { Project, Tab, Clamp, FeatureInstance } from '../types/project'
import { IDENTITY_MATRIX, newProject } from '../types/project'
import { sanitizeSelection } from './slices/selectionSlice'

// ── Assertion helpers ──

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    )
  }
}

// ── Store helpers ──

function resetStore(project?: Project): void {
  useProjectStore.setState({
    project: project ?? newProject(),
    selection: {
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedTabIds: [],
      selectedClampIds: [],
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

function project(): Project {
  return useProjectStore.getState().project
}

function selection(): SelectionState {
  return useProjectStore.getState().selection
}

function selectionSnapshot(): SelectionState {
  // Deep-clone so later mutations don't affect the snapshot.
  return JSON.parse(JSON.stringify(useProjectStore.getState().selection))
}

function historyLen(): number {
  return useProjectStore.getState().history.past.length
}

function store() {
  return useProjectStore.getState()
}

// ── Fixture helpers ──

function projectWithTabsAndClamps(): Project {
  const p = newProject()
  const tabs: Tab[] = [
    { id: 'tb1', name: 'Tab 1', x: 10, y: 10, w: 10, h: 10, z_top: 3, z_bottom: 0, visible: true },
    { id: 'tb2', name: 'Tab 2', x: 30, y: 30, w: 10, h: 10, z_top: 3, z_bottom: 0, visible: true },
    { id: 'tb3', name: 'Tab 3', x: 50, y: 50, w: 10, h: 10, z_top: 3, z_bottom: 0, visible: false },
  ]
  const clamps: Clamp[] = [
    { id: 'cl1', name: 'Clamp 1', type: 'step_clamp' as const, x: 10, y: 10, w: 12, h: 12, height: 8, visible: true },
    { id: 'cl2', name: 'Clamp 2', type: 'step_clamp' as const, x: 30, y: 30, w: 12, h: 12, height: 8, visible: true },
    { id: 'cl3', name: 'Clamp 3', type: 'step_clamp' as const, x: 50, y: 50, w: 12, h: 12, height: 8, visible: false },
  ]
  return { ...p, tabs, clamps }
}

function projectWithFeatures(): Project {
  const p = newProject()
  const f1: FeatureInstance = {
    id: 'f1',
    definitionId: 'def1',
    name: 'Rect 1',
    transform: IDENTITY_MATRIX,
    constraints: [],
    z_top: 5,
    z_bottom: 0,
    folderId: null,
    visible: true,
    locked: false,
  }
  const f2: FeatureInstance = {
    id: 'f2',
    definitionId: 'def2',
    name: 'Rect 2',
    transform: IDENTITY_MATRIX,
    constraints: [],
    z_top: 5,
    z_bottom: 0,
    folderId: null,
    visible: true,
    locked: false,
  }
  return {
    ...p,
    features: [f1, f2],
    featureDefinitions: {
      def1: {
        id: 'def1',
        kind: 'rect' as const,
        profile: { start: { x: 0, y: 0 }, closed: true, segments: [] },
        dimensions: [],
        operation: 'add' as const,
      },
      def2: {
        id: 'def2',
        kind: 'rect' as const,
        profile: { start: { x: 0, y: 0 }, closed: true, segments: [] },
        dimensions: [],
        operation: 'add' as const,
      },
    },
  }
}

// ── Test runner ──

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
// 1. Family exclusivity
// ============================================================================
console.log('\n1. Family exclusivity')

test('selectTab clears feature IDs and sets tab IDs', () => {
  resetStore(projectWithTabsAndClamps())
  store().selectTab('tb1')
  const sel = selection()
  assertEq(sel.selectedFeatureIds.length, 0, 'feature IDs cleared')
  assertEq(sel.selectedTabIds.length, 1, 'tab ID set')
  assertEq(sel.selectedTabIds[0], 'tb1', 'correct tab selected')
  assert(sel.selectedClampIds.length === 0, 'clamp IDs empty')
  assert(sel.selectedNode?.type === 'tab' && sel.selectedNode.tabId === 'tb1', 'primary is tab')
})

test('selectClamp clears tab IDs and sets clamp IDs', () => {
  resetStore(projectWithTabsAndClamps())
  store().selectTab('tb1')
  store().selectClamp('cl1')
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 0, 'tab IDs cleared')
  assertEq(sel.selectedClampIds.length, 1, 'clamp ID set')
  assert(sel.selectedFeatureIds.length === 0, 'feature IDs empty')
  assert(sel.selectedNode?.type === 'clamp' && sel.selectedNode.clampId === 'cl1', 'primary is clamp')
})

test('selectFeature clears tab and clamp IDs', () => {
  resetStore(projectWithTabsAndClamps())
  store().selectTab('tb1')
  store().selectFeaturesRoot()
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 0, 'tab IDs cleared')
  assertEq(sel.selectedClampIds.length, 0, 'clamp IDs cleared')
})

// ============================================================================
// 2. Same-family additive toggle
// ============================================================================
console.log('\n2. Same-family additive toggle')

test('additive tab toggles into selection', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectTab('tb1')
  s.selectTab('tb2', true)
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 2, 'both tabs selected')
  assert(sel.selectedTabIds.includes('tb1'), 'tb1 in selection')
  assert(sel.selectedTabIds.includes('tb2'), 'tb2 in selection')
  assert(sel.selectedNode?.type === 'tab' && sel.selectedNode.tabId === 'tb2', 'primary updated to tb2')
})

test('additive tab toggles out of selection', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectTab('tb1')
  s.selectTab('tb2', true)
  s.selectTab('tb1', true)
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 1, 'one tab deselected')
  assert(sel.selectedTabIds.includes('tb2'), 'tb2 still selected')
  assert(!sel.selectedTabIds.includes('tb1'), 'tb1 deselected')
})

test('additive toggle preserves primary when sibling toggled off', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectTab('tb1')
  s.selectTab('tb2', true)
  s.selectTab('tb1', true)
  const sel = selection()
  assert(sel.selectedNode?.type === 'tab' && sel.selectedNode.tabId === 'tb2', 'primary still tb2')
})

test('additive toggle of primary falls back to remaining member', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectTab('tb1')
  s.selectTab('tb2', true)
  s.selectTab('tb2', true)
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 1, 'one tab remaining')
  assert(sel.selectedTabIds.includes('tb1'), 'tb1 still selected')
  assert(sel.selectedNode?.type === 'tab' && sel.selectedNode.tabId === 'tb1', 'primary fell back to tb1')
})

test('additive toggle of last member clears selection', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectTab('tb1')
  s.selectTab('tb1', true)
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 0, 'no tabs selected')
  assertEq(sel.selectedNode, null, 'no primary node')
})

test('additive clamp toggles into selection', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectClamp('cl1')
  s.selectClamp('cl2', true)
  const sel = selection()
  assertEq(sel.selectedClampIds.length, 2, 'both clamps selected')
})

test('additive clamp toggles out of selection', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectClamp('cl1')
  s.selectClamp('cl2', true)
  s.selectClamp('cl1', true)
  const sel = selection()
  assertEq(sel.selectedClampIds.length, 1, 'cl1 deselected')
  assert(sel.selectedClampIds.includes('cl2'), 'cl2 still selected')
})

// ============================================================================
// 3. Incompatible additive attempts are ignored
// ============================================================================
console.log('\n3. Incompatible additive attempts')

test('additive tab on feature selection is ignored', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.setState((s) => ({
    selection: {
      ...s.selection,
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedTabIds: [],
      selectedClampIds: [],
      selectedNode: { type: 'features_root' },
    },
  }))
  store().selectTab('tb1', true)
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 0, 'tab not added to feature-family selection')
  assert(sel.selectedNode?.type === 'features_root', 'primary unchanged')
})

test('additive clamp on tab selection is ignored', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectTab('tb1')
  s.selectClamp('cl1', true)
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 1, 'tab selection preserved')
  assertEq(sel.selectedClampIds.length, 0, 'clamp not added')
  assert(sel.selectedNode?.type === 'tab', 'primary still tab')
})

test('plain click switches family from tab to clamp', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectTab('tb1')
  s.selectClamp('cl1')
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 0, 'tab IDs cleared')
  assertEq(sel.selectedClampIds.length, 1, 'clamp ID set')
  assert(sel.selectedNode?.type === 'clamp', 'family switched to clamp')
})

// ── Adversarial: selectFeature additive from tab/clamp family ──

test('additive feature on tab selection is true no-op', () => {
  // Build a project with both features and tabs.
  const p = projectWithTabsAndClamps()
  const pWithFeatures = projectWithFeatures()
  const combined: Project = {
    ...p,
    features: pWithFeatures.features,
    featureDefinitions: pWithFeatures.featureDefinitions,
    featureTree: pWithFeatures.featureTree,
  }
  resetStore(combined)
  store().selectTab('tb1')
  store().selectTab('tb2', true)
  // Attempt additive feature selection — must be ignored entirely.
  store().selectFeature('f1', true)
  const sel = selection()
  assertEq(sel.selectedFeatureIds.length, 0, 'feature not added')
  assertEq(sel.selectedTabIds.length, 2, 'tab selection fully preserved')
  assert(sel.selectedNode?.type === 'tab', 'primary still tab')
})

test('additive feature on clamp selection is true no-op', () => {
  const p = projectWithTabsAndClamps()
  const pWithFeatures = projectWithFeatures()
  const combined: Project = {
    ...p,
    features: pWithFeatures.features,
    featureDefinitions: pWithFeatures.featureDefinitions,
    featureTree: pWithFeatures.featureTree,
  }
  resetStore(combined)
  store().selectClamp('cl1')
  store().selectClamp('cl2', true)
  store().selectFeature('f1', true)
  const sel = selection()
  assertEq(sel.selectedFeatureIds.length, 0, 'feature not added')
  assertEq(sel.selectedClampIds.length, 2, 'clamp selection fully preserved')
  assert(sel.selectedNode?.type === 'clamp', 'primary still clamp')
})

test('additive feature with null node but tab IDs present is true no-op', () => {
  resetStore(projectWithTabsAndClamps())
  // Simulate pending workflow: tab IDs present, primary node is null.
  useProjectStore.setState((s) => ({
    selection: {
      ...s.selection,
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedTabIds: ['tb1'],
      selectedClampIds: [],
      selectedNode: null,
    },
  }))
  store().selectFeature('f1', true)
  const sel = selection()
  assertEq(sel.selectedFeatureIds.length, 0, 'feature not added')
  assertEq(sel.selectedTabIds.length, 1, 'tab selection preserved')
})

test('additive feature with null node but clamp IDs present is true no-op', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.setState((s) => ({
    selection: {
      ...s.selection,
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedTabIds: [],
      selectedClampIds: ['cl1'],
      selectedNode: null,
    },
  }))
  store().selectFeature('f1', true)
  const sel = selection()
  assertEq(sel.selectedFeatureIds.length, 0, 'feature not added')
  assertEq(sel.selectedClampIds.length, 1, 'clamp selection preserved')
})

test('additive feature succeeds when null node and only feature IDs present', () => {
  resetStore(projectWithFeatures())
  // Simulate pending-feature-workflow: feature IDs present, primary node null.
  useProjectStore.setState((s) => ({
    selection: {
      ...s.selection,
      selectedFeatureIds: ['f1'],
      selectedFeatureId: 'f1',
      selectedTabIds: [],
      selectedClampIds: [],
      selectedNode: null,
    },
  }))
  store().selectFeature('f2', true)
  const sel = selection()
  assertEq(sel.selectedFeatureIds.length, 2, 'f2 added to feature selection')
  assert(sel.selectedFeatureIds.includes('f1'), 'f1 still in selection')
  assert(sel.selectedFeatureIds.includes('f2'), 'f2 added to selection')
})

// ── Cross-family additive with null primary: tab/clamp from non-tab/non-clamp IDs ──

test('additive tab from feature IDs + null node is true no-op (deep compare)', () => {
  const p = projectWithTabsAndClamps()
  const pWithFeatures = projectWithFeatures()
  const combined: Project = {
    ...p,
    features: pWithFeatures.features,
    featureDefinitions: pWithFeatures.featureDefinitions,
    featureTree: pWithFeatures.featureTree,
  }
  resetStore(combined)
  // Set up feature IDs with null primary — simulates a pending feature workflow.
  useProjectStore.setState((s) => ({
    selection: {
      ...s.selection,
      selectedFeatureIds: ['f1', 'f2'],
      selectedFeatureId: null,
      selectedTabIds: [],
      selectedClampIds: [],
      selectedNode: null,
    },
  }))
  const before = selectionSnapshot()
  store().selectTab('tb1', true)
  const after = selection()
  assert(JSON.stringify(before) === JSON.stringify(after), 'selection unchanged — byte-for-byte')
})

test('additive clamp from feature IDs + null node is true no-op (deep compare)', () => {
  const p = projectWithTabsAndClamps()
  const pWithFeatures = projectWithFeatures()
  const combined: Project = {
    ...p,
    features: pWithFeatures.features,
    featureDefinitions: pWithFeatures.featureDefinitions,
    featureTree: pWithFeatures.featureTree,
  }
  resetStore(combined)
  useProjectStore.setState((s) => ({
    selection: {
      ...s.selection,
      selectedFeatureIds: ['f1', 'f2'],
      selectedFeatureId: null,
      selectedTabIds: [],
      selectedClampIds: [],
      selectedNode: null,
    },
  }))
  const before = selectionSnapshot()
  store().selectClamp('cl1', true)
  const after = selection()
  assert(JSON.stringify(before) === JSON.stringify(after), 'selection unchanged — byte-for-byte')
})

test('additive tab from clamp IDs + null node is true no-op (deep compare)', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.setState((s) => ({
    selection: {
      ...s.selection,
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedTabIds: [],
      selectedClampIds: ['cl1'],
      selectedNode: null,
    },
  }))
  const before = selectionSnapshot()
  store().selectTab('tb1', true)
  const after = selection()
  assert(JSON.stringify(before) === JSON.stringify(after), 'selection unchanged — byte-for-byte')
})

test('additive clamp from tab IDs + null node is true no-op (deep compare)', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.setState((s) => ({
    selection: {
      ...s.selection,
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedTabIds: ['tb1'],
      selectedClampIds: [],
      selectedNode: null,
    },
  }))
  const before = selectionSnapshot()
  store().selectClamp('cl1', true)
  const after = selection()
  assert(JSON.stringify(before) === JSON.stringify(after), 'selection unchanged — byte-for-byte')
})

// ── Non-family node additive guards (regression: stock, project, grid, etc.) ──

test('additive tab on non-family node (stock) is no-op (deep compare)', () => {
  resetStore(projectWithTabsAndClamps())
  store().selectStock()
  const before = selectionSnapshot()
  store().selectTab('tb1', true)
  const after = selection()
  assert(JSON.stringify(before) === JSON.stringify(after), 'selection unchanged — byte-for-byte')
})

test('additive clamp on non-family node (stock) is no-op (deep compare)', () => {
  resetStore(projectWithTabsAndClamps())
  store().selectStock()
  const before = selectionSnapshot()
  store().selectClamp('cl1', true)
  const after = selection()
  assert(JSON.stringify(before) === JSON.stringify(after), 'selection unchanged — byte-for-byte')
})

// ============================================================================
// 4. Visible-only family Select All
// ============================================================================
console.log('\n4. Visible-only Select All')

test('selectAllTabs selects only visible tabs', () => {
  resetStore(projectWithTabsAndClamps())
  store().selectAllTabs()
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 2, 'two visible tabs selected')
  assert(sel.selectedTabIds.includes('tb1'), 'visible tb1 selected')
  assert(sel.selectedTabIds.includes('tb2'), 'visible tb2 selected')
  assert(!sel.selectedTabIds.includes('tb3'), 'hidden tb3 not selected')
})

test('selectAllClamps selects only visible clamps', () => {
  resetStore(projectWithTabsAndClamps())
  store().selectAllClamps()
  const sel = selection()
  assertEq(sel.selectedClampIds.length, 2, 'two visible clamps selected')
  assert(sel.selectedClampIds.includes('cl1'), 'visible cl1 selected')
  assert(sel.selectedClampIds.includes('cl2'), 'visible cl2 selected')
  assert(!sel.selectedClampIds.includes('cl3'), 'hidden cl3 not selected')
})

test('selectAllTabs replaces previous clamp selection', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectClamp('cl1')
  s.selectAllTabs()
  const sel = selection()
  assertEq(sel.selectedClampIds.length, 0, 'clamp selection cleared')
  assertEq(sel.selectedTabIds.length, 2, 'tab selection set')
})

test('selectAllTabs with no visible tabs yields empty selection', () => {
  const p = projectWithTabsAndClamps()
  p.tabs = p.tabs.map((t) => ({ ...t, visible: false }))
  resetStore(p)
  store().selectAllTabs()
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 0, 'no tabs selected')
  assertEq(sel.selectedNode, null, 'no primary node')
})

// ============================================================================
// 5. Center-preserving bulk dimension updates
// ============================================================================
console.log('\n5. Center-preserving bulk dimensions')

test('updateTabs preserves center on width change', () => {
  resetStore(projectWithTabsAndClamps())
  store().updateTabs(['tb1'], { w: 20 })
  const tab = project().tabs.find((t) => t.id === 'tb1')!
  assertEq(tab.w, 20, 'width updated')
  assertEq(tab.x + tab.w / 2, 15, 'center x preserved')
})

test('updateTabs preserves center on height change', () => {
  resetStore(projectWithTabsAndClamps())
  store().updateTabs(['tb1'], { h: 20 })
  const tab = project().tabs.find((t) => t.id === 'tb1')!
  assertEq(tab.h, 20, 'height updated')
  assertEq(tab.y + tab.h / 2, 15, 'center y preserved')
})

test('updateTabs preserves center on both dimensions change', () => {
  resetStore(projectWithTabsAndClamps())
  store().updateTabs(['tb1'], { w: 20, h: 20 })
  const tab = project().tabs.find((t) => t.id === 'tb1')!
  assertEq(tab.w, 20, 'width updated')
  assertEq(tab.h, 20, 'height updated')
  assertEq(tab.x + tab.w / 2, 15, 'center x preserved')
  assertEq(tab.y + tab.h / 2, 15, 'center y preserved')
})

test('updateTabs keeps width and height independent', () => {
  resetStore(projectWithTabsAndClamps())
  store().updateTabs(['tb1'], { w: 20 })
  const tab = project().tabs.find((t) => t.id === 'tb1')!
  assertEq(tab.w, 20, 'width updated')
  assertEq(tab.h, 10, 'height unchanged')
})

test('updateTabs bulk applies to all specified IDs', () => {
  resetStore(projectWithTabsAndClamps())
  store().updateTabs(['tb1', 'tb2'], { w: 20 })
  const t1 = project().tabs.find((t) => t.id === 'tb1')!
  const t2 = project().tabs.find((t) => t.id === 'tb2')!
  const t3 = project().tabs.find((t) => t.id === 'tb3')!
  assertEq(t1.w, 20, 'tb1 width updated')
  assertEq(t2.w, 20, 'tb2 width updated')
  assertEq(t3.w, 10, 'tb3 width unchanged')
})

test('updateClamps preserves center on width change', () => {
  resetStore(projectWithTabsAndClamps())
  store().updateClamps(['cl1'], { w: 24 })
  const clamp = project().clamps.find((c) => c.id === 'cl1')!
  assertEq(clamp.w, 24, 'width updated')
  assertEq(clamp.x + clamp.w / 2, 10 + 12 / 2, 'center x preserved')
})

test('updateTabs with empty IDs does not change history', () => {
  resetStore(projectWithTabsAndClamps())
  const before = historyLen()
  store().updateTabs([], { w: 20 })
  assertEq(historyLen(), before, 'no history entry for empty update')
})

// ============================================================================
// 6. Selection sanitization after bulk delete
// ============================================================================
console.log('\n6. Selection sanitization after bulk delete')

test('deleteTabs removes deleted IDs from selection', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectTab('tb1')
  s.selectTab('tb2', true)
  s.deleteTabs(['tb1'])
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 1, 'one tab remains selected')
  assert(sel.selectedTabIds.includes('tb2'), 'tb2 still selected')
  assert(!sel.selectedTabIds.includes('tb1'), 'tb1 removed')
})

test('deleteTabs clears selection when all selected are deleted', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectTab('tb1')
  s.selectTab('tb2', true)
  s.deleteTabs(['tb1', 'tb2'])
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 0, 'no tabs selected')
  assertEq(sel.selectedNode, null, 'primary cleared')
})

test('deleteTabs promotes other member when primary is deleted', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectTab('tb1')
  s.selectTab('tb2', true)
  s.deleteTabs(['tb2'])
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 1, 'one tab remains')
  assert(sel.selectedTabIds.includes('tb1'), 'tb1 remains')
  assert(sel.selectedNode?.type === 'tab' && sel.selectedNode.tabId === 'tb1', 'primary fell back to tb1')
})

test('deleteClamps sanitizes selection', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectClamp('cl1')
  s.selectClamp('cl2', true)
  s.deleteClamps(['cl1', 'cl2'])
  const sel = selection()
  assertEq(sel.selectedClampIds.length, 0, 'all deleted clamps removed')
  assertEq(sel.selectedNode, null, 'primary cleared')
})

test('deleteTabs preserves unrelated feature selection', () => {
  resetStore(projectWithTabsAndClamps())
  // Select a tab so there are IDs in the collection, then switch to feature family.
  const s = store()
  s.selectTab('tb1')
  s.selectTab('tb2', true)
  // Now switch to a features_root node (feature family).
  s.selectFeaturesRoot()
  // Delete tabs while feature family is active.
  s.deleteTabs(['tb1'])
  const sel = selection()
  // Feature selection should be preserved, tab IDs cleaned up.
  assertEq(sel.selectedTabIds.length, 0, 'deleted tabs removed from collection')
  assert(sel.selectedNode?.type === 'features_root', 'feature root preserved')
})

// ============================================================================
// 7. One-step undo for bulk operations
// ============================================================================
console.log('\n7. One-step undo for bulk operations')

test('updateTabs creates one history entry', () => {
  resetStore(projectWithTabsAndClamps())
  const before = historyLen()
  store().updateTabs(['tb1', 'tb2'], { w: 20 })
  assertEq(historyLen(), before + 1, 'one history entry created')
})

test('deleteTabs creates one history entry', () => {
  resetStore(projectWithTabsAndClamps())
  const before = historyLen()
  store().deleteTabs(['tb1', 'tb2'])
  assertEq(historyLen(), before + 1, 'one history entry for bulk delete')
})

test('undo restores bulk-deleted tabs with selection', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectTab('tb1')
  s.selectTab('tb2', true)
  s.deleteTabs(['tb1', 'tb2'])
  assertEq(project().tabs.length, 1, 'one tab remaining after delete')
  s.undo()
  assertEq(project().tabs.length, 3, 'all three tabs restored')
})

test('undo restores bulk-updated dimensions', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.updateTabs(['tb1'], { w: 20 })
  assertEq(project().tabs.find((t) => t.id === 'tb1')!.w, 20, 'width changed')
  s.undo()
  assertEq(project().tabs.find((t) => t.id === 'tb1')!.w, 10, 'width restored')
})

// ============================================================================
// 8. Bulk selection helpers
// ============================================================================
console.log('\n8. Bulk selection helpers')

test('selectTabs sets exact ID set', () => {
  resetStore(projectWithTabsAndClamps())
  store().selectTabs(['tb1', 'tb3'])
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 2, 'two tabs selected')
  assert(sel.selectedTabIds.includes('tb1'), 'tb1 selected')
  assert(sel.selectedTabIds.includes('tb3'), 'tb3 selected')
  assert(sel.selectedClampIds.length === 0, 'clamp IDs cleared')
})

test('selectTabs filters out nonexistent IDs', () => {
  resetStore(projectWithTabsAndClamps())
  store().selectTabs(['tb1', 'nonexistent'])
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 1, 'only valid IDs kept')
  assert(sel.selectedTabIds.includes('tb1'), 'valid ID kept')
})

test('selectTabs replaces previous clamp selection', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectClamp('cl1')
  s.selectTabs(['tb1'])
  const sel = selection()
  assertEq(sel.selectedClampIds.length, 0, 'clamp IDs cleared')
  assertEq(sel.selectedTabIds.length, 1, 'tab IDs set')
})

test('selectClamps deduplicates IDs', () => {
  resetStore(projectWithTabsAndClamps())
  store().selectClamps(['cl1', 'cl1', 'cl2'])
  const sel = selection()
  assertEq(sel.selectedClampIds.length, 2, 'duplicates filtered')
})

// ============================================================================
// 9. Bulk mutation no-op checks
// ============================================================================
console.log('\n9. Bulk mutation no-op checks')

test('updateTabs with nonexistent IDs does not change history', () => {
  resetStore(projectWithTabsAndClamps())
  const before = historyLen()
  store().updateTabs(['nonexistent'], { w: 20 })
  assertEq(historyLen(), before, 'no history entry for nonexistent IDs')
})

test('updateTabs with identical patch does not change history', () => {
  resetStore(projectWithTabsAndClamps())
  const before = historyLen()
  // tb1 already has w: 10
  store().updateTabs(['tb1'], { w: 10 })
  assertEq(historyLen(), before, 'no history entry for identical patch')
})

test('updateClamps with nonexistent IDs does not change history', () => {
  resetStore(projectWithTabsAndClamps())
  const before = historyLen()
  store().updateClamps(['nonexistent'], { w: 24 })
  assertEq(historyLen(), before, 'no history entry for nonexistent clamp IDs')
})

test('updateClamps with identical patch does not change history', () => {
  resetStore(projectWithTabsAndClamps())
  const before = historyLen()
  // cl1 already has w: 12
  store().updateClamps(['cl1'], { w: 12 })
  assertEq(historyLen(), before, 'no history entry for identical clamp patch')
})

test('deleteTabs with nonexistent IDs does not change history', () => {
  resetStore(projectWithTabsAndClamps())
  const before = historyLen()
  store().deleteTabs(['nonexistent'])
  assertEq(historyLen(), before, 'no history entry for nonexistent tab delete')
})

test('deleteClamps with nonexistent IDs does not change history', () => {
  resetStore(projectWithTabsAndClamps())
  const before = historyLen()
  store().deleteClamps(['nonexistent'])
  assertEq(historyLen(), before, 'no history entry for nonexistent clamp delete')
})

// ============================================================================
// 10. sanitizeSelection — centralized invariant boundary
// ============================================================================
console.log('\n10. sanitizeSelection tests')

function emptySel(overrides: Partial<SelectionState> = {}): SelectionState {
  return {
    mode: 'feature',
    selectedFeatureId: null,
    selectedFeatureIds: [],
    selectedTabIds: [],
    selectedClampIds: [],
    selectedNode: null,
    hoveredFeatureId: null,
    sketchEditTool: null,
    activeControl: null,
    groupFolderId: null,
    ...overrides,
  }
}

test('sanitizeSelection filters nonexistent feature IDs', () => {
  const p = projectWithFeatures()
  const sel = emptySel({
    selectedFeatureIds: ['f1', 'nonexistent'],
    selectedFeatureId: 'nonexistent',
    selectedNode: { type: 'feature', featureId: 'nonexistent' },
  })
  const result = sanitizeSelection(p, sel)
  assertEq(result.selectedFeatureIds.length, 1, 'only valid IDs kept')
  assert(result.selectedFeatureIds.includes('f1'), 'f1 kept')
  assertEq(result.selectedFeatureId, 'f1', 'primary fell back to valid ID')
})

test('sanitizeSelection filters nonexistent tab IDs', () => {
  const p = projectWithTabsAndClamps()
  const sel = emptySel({
    selectedTabIds: ['tb1', 'nonexistent'],
    selectedNode: { type: 'tab', tabId: 'tb1' },
  })
  const result = sanitizeSelection(p, sel)
  assertEq(result.selectedTabIds.length, 1, 'only valid tab IDs kept')
  assert(result.selectedTabIds.includes('tb1'), 'tb1 kept')
  assert(result.selectedNode?.type === 'tab' && result.selectedNode.tabId === 'tb1', 'primary preserved')
})

test('sanitizeSelection enforces single-family: tab primary drops features', () => {
  const p = projectWithTabsAndClamps()
  // Malformed: feature IDs present with a tab primary.
  const sel = emptySel({
    selectedFeatureIds: ['f1'],
    selectedFeatureId: 'f1',
    selectedTabIds: ['tb1'],
    selectedNode: { type: 'tab', tabId: 'tb1' },
  })
  const result = sanitizeSelection(p, sel)
  assertEq(result.selectedFeatureIds.length, 0, 'feature IDs dropped')
  assertEq(result.selectedTabIds.length, 1, 'tab IDs kept')
  assert(result.selectedNode?.type === 'tab', 'primary is tab')
})

test('sanitizeSelection enforces single-family: clamp primary drops features', () => {
  const p = projectWithTabsAndClamps()
  const sel = emptySel({
    selectedFeatureIds: ['f1'],
    selectedTabIds: [],
    selectedClampIds: ['cl1'],
    selectedNode: { type: 'clamp', clampId: 'cl1' },
  })
  const result = sanitizeSelection(p, sel)
  assertEq(result.selectedFeatureIds.length, 0, 'feature IDs dropped')
  assertEq(result.selectedClampIds.length, 1, 'clamp IDs kept')
  assert(result.selectedNode?.type === 'clamp', 'primary is clamp')
})

test('sanitizeSelection: invalid tab primary falls back deterministically', () => {
  const p = projectWithTabsAndClamps()
  const sel = emptySel({
    selectedTabIds: ['tb1', 'tb2'],
    selectedNode: { type: 'tab', tabId: 'deleted_tab' },
  })
  const result = sanitizeSelection(p, sel)
  assertEq(result.selectedTabIds.length, 2, 'tab collection preserved')
  assert(result.selectedNode?.type === 'tab', 'primary is tab')
  assert(result.selectedTabIds.includes(result.selectedNode!.tabId), 'primary belongs to collection')
})

test('sanitizeSelection: invalid feature primary falls back deterministically', () => {
  const p = projectWithFeatures()
  const sel = emptySel({
    selectedFeatureIds: ['f1', 'f2'],
    selectedFeatureId: 'deleted',
    selectedNode: { type: 'feature', featureId: 'deleted' },
  })
  const result = sanitizeSelection(p, sel)
  assertEq(result.selectedFeatureIds.length, 2, 'feature collection preserved')
  assert(result.selectedNode?.type === 'feature', 'primary is a feature')
  assertEq(result.selectedFeatureId, 'f2', 'primary fell back to last surviving ID')
})

test('sanitizeSelection preserves pending workflow (features + null primary)', () => {
  const p = projectWithFeatures()
  const sel = emptySel({
    selectedFeatureIds: ['f1'],
    selectedFeatureId: null,
    selectedNode: null,
  })
  const result = sanitizeSelection(p, sel)
  assertEq(result.selectedFeatureIds.length, 1, 'feature IDs preserved')
  assert(result.selectedFeatureIds.includes('f1'), 'f1 survives')
  assertEq(result.selectedNode, null, 'primary remains null')
  assertEq(result.selectedFeatureId, null, 'selectedFeatureId remains null')
})

test('sanitizeSelection resolves mixed-family without primary to features first', () => {
  const p = projectWithTabsAndClamps()
  // Mixed collections, no primary node.
  const sel = emptySel({
    selectedFeatureIds: ['f1'],
    selectedTabIds: ['tb1'],
    selectedClampIds: ['cl1'],
    selectedNode: null,
  })
  const result = sanitizeSelection(p, sel)
  // Features win in the fallback order.
  // (f1 doesn't exist in this project, so features are empty anyway)
  // Tabs win because feature IDs are all filtered.
  assertEq(result.selectedFeatureIds.length, 0, 'nonexistent features filtered')
  assertEq(result.selectedTabIds.length, 1, 'tabs survive as fallback')
  assertEq(result.selectedClampIds.length, 0, 'clamps dropped (tabs won)')
})

test('sanitizeSelection: empty everything with non-family primary keeps it', () => {
  const p = projectWithTabsAndClamps()
  const sel = emptySel({
    selectedNode: { type: 'features_root' },
  })
  const result = sanitizeSelection(p, sel)
  assertEq(result.selectedNode?.type, 'features_root', 'non-family root node preserved')
})

test('sanitizeSelection: tab primary with empty collection clears everything', () => {
  const p = projectWithTabsAndClamps()
  // All tab IDs are nonexistent → collection is empty.
  const sel = emptySel({
    selectedTabIds: ['nonexistent'],
    selectedNode: { type: 'tab', tabId: 'nonexistent' },
  })
  const result = sanitizeSelection(p, sel)
  assertEq(result.selectedTabIds.length, 0, 'tab IDs empty')
  assertEq(result.selectedNode, null, 'primary cleared')
})

test('sanitizeSelection: existing tab primary + empty tab IDs clears primary', () => {
  const p = projectWithTabsAndClamps()
  // The tab node EXISTS in the project but has no selected IDs.
  const sel = emptySel({
    selectedTabIds: [],
    selectedNode: { type: 'tab', tabId: 'tb1' },
  })
  const result = sanitizeSelection(p, sel)
  assertEq(result.selectedTabIds.length, 0, 'tab IDs empty')
  assertEq(result.selectedClampIds.length, 0, 'clamp IDs empty')
  assertEq(result.selectedFeatureIds.length, 0, 'feature IDs empty')
  assertEq(result.selectedNode, null, 'primary cleared — family node with empty collection')
  assertEq(result.selectedFeatureId, null, 'selectedFeatureId null')
})

test('sanitizeSelection: existing clamp primary + empty clamp IDs clears primary', () => {
  const p = projectWithTabsAndClamps()
  // The clamp node EXISTS in the project but has no selected IDs.
  const sel = emptySel({
    selectedClampIds: [],
    selectedNode: { type: 'clamp', clampId: 'cl1' },
  })
  const result = sanitizeSelection(p, sel)
  assertEq(result.selectedClampIds.length, 0, 'clamp IDs empty')
  assertEq(result.selectedTabIds.length, 0, 'tab IDs empty')
  assertEq(result.selectedFeatureIds.length, 0, 'feature IDs empty')
  assertEq(result.selectedNode, null, 'primary cleared — family node with empty collection')
  assertEq(result.selectedFeatureId, null, 'selectedFeatureId null')
})

// ============================================================================
// 11. Single-delete selection promotion (deleteTab / deleteClamp)
// ============================================================================
console.log('\n11. Single-delete selection promotion')

test('deleteTab of primary from two-tab selection promotes sibling', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectTab('tb1')
  s.selectTab('tb2', true)
  // tb2 is primary (last added), delete it.
  s.deleteTab('tb2')
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 1, 'one tab remains selected')
  assert(sel.selectedTabIds.includes('tb1'), 'sibling tb1 remains')
  assert(!sel.selectedTabIds.includes('tb2'), 'deleted tb2 gone')
  assert(sel.selectedNode?.type === 'tab' && sel.selectedNode.tabId === 'tb1', 'sibling promoted to primary')
  assertEq(sel.selectedFeatureIds.length, 0, 'no feature IDs leaked')
  assertEq(sel.selectedClampIds.length, 0, 'no clamp IDs leaked')
})

test('deleteTab of only member clears selection', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectTab('tb1')
  s.deleteTab('tb1')
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 0, 'no tabs selected')
  assertEq(sel.selectedNode, null, 'primary cleared')
  assertEq(sel.selectedFeatureIds.length, 0, 'no feature IDs')
  assertEq(sel.selectedClampIds.length, 0, 'no clamp IDs')
})

test('deleteClamp of primary from two-clamp selection promotes sibling', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectClamp('cl1')
  s.selectClamp('cl2', true)
  // cl2 is primary (last added), delete it.
  s.deleteClamp('cl2')
  const sel = selection()
  assertEq(sel.selectedClampIds.length, 1, 'one clamp remains selected')
  assert(sel.selectedClampIds.includes('cl1'), 'sibling cl1 remains')
  assert(!sel.selectedClampIds.includes('cl2'), 'deleted cl2 gone')
  assert(sel.selectedNode?.type === 'clamp' && sel.selectedNode.clampId === 'cl1', 'sibling promoted to primary')
  assertEq(sel.selectedFeatureIds.length, 0, 'no feature IDs leaked')
  assertEq(sel.selectedTabIds.length, 0, 'no tab IDs leaked')
})

test('deleteClamp of only member clears selection', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectClamp('cl1')
  s.deleteClamp('cl1')
  const sel = selection()
  assertEq(sel.selectedClampIds.length, 0, 'no clamps selected')
  assertEq(sel.selectedNode, null, 'primary cleared')
  assertEq(sel.selectedFeatureIds.length, 0, 'no feature IDs')
  assertEq(sel.selectedTabIds.length, 0, 'no tab IDs')
})

// ============================================================================
// 12. Creation and transition selection invariants (S2-CORRECTION)
// ============================================================================
console.log('\n12. Creation and transition selection invariants')

test('placePendingAddAt tab sets selectedTabIds', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  // Start tab placement then place it — the selection must include the new tab.
  s.startAddTabPlacement()
  const anchor = { x: 0, y: 0 }
  const point = { x: 20, y: 20 }
  // Set anchor first.
  useProjectStore.setState((prev) => ({
    pendingAdd: prev.pendingAdd && 'anchor' in prev.pendingAdd
      ? { ...prev.pendingAdd, anchor }
      : prev.pendingAdd,
  }))
  s.placePendingAddAt(point)
  const sel = selection()
  assert(sel.selectedTabIds.length >= 1, 'new tab ID should be in selectedTabIds')
  assertEq(sel.selectedFeatureIds.length, 0, 'no feature IDs leaked')
  assertEq(sel.selectedClampIds.length, 0, 'no clamp IDs leaked')
  assert(sel.selectedNode?.type === 'tab', 'primary is tab')
})

test('placePendingAddAt clamp sets selectedClampIds', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.startAddClampPlacement()
  const anchor = { x: 0, y: 0 }
  const point = { x: 20, y: 20 }
  useProjectStore.setState((prev) => ({
    pendingAdd: prev.pendingAdd && 'anchor' in prev.pendingAdd
      ? { ...prev.pendingAdd, anchor }
      : prev.pendingAdd,
  }))
  s.placePendingAddAt(point)
  const sel = selection()
  assert(sel.selectedClampIds.length >= 1, 'new clamp ID should be in selectedClampIds')
  assertEq(sel.selectedFeatureIds.length, 0, 'no feature IDs leaked')
  assertEq(sel.selectedTabIds.length, 0, 'no tab IDs leaked')
  assert(sel.selectedNode?.type === 'clamp', 'primary is clamp')
})

test('startAddTabPlacement clears incompatible family IDs', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  // First select a feature, then start tab placement.
  s.selectFeaturesRoot()
  s.startAddTabPlacement()
  const sel = selection()
  assertEq(sel.selectedFeatureIds.length, 0, 'feature IDs cleared')
  assertEq(sel.selectedFeatureId, null, 'selectedFeatureId cleared')
  assert(sel.selectedNode?.type === 'tabs_root', 'primary is tabs_root')
})

test('startAddClampPlacement clears incompatible family IDs', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectFeaturesRoot()
  s.startAddClampPlacement()
  const sel = selection()
  assertEq(sel.selectedFeatureIds.length, 0, 'feature IDs cleared')
  assertEq(sel.selectedFeatureId, null, 'selectedFeatureId cleared')
  assert(sel.selectedNode?.type === 'clamps_root', 'primary is clamps_root')
})

test('startMoveTab sets selectedTabIds and clears other families', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.startMoveTab('tb1')
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 1, 'selectedTabIds includes tab')
  assert(sel.selectedTabIds.includes('tb1'), 'tb1 in selectedTabIds')
  assertEq(sel.selectedFeatureIds.length, 0, 'no feature IDs')
  assertEq(sel.selectedClampIds.length, 0, 'no clamp IDs')
  assertEq(sel.selectedFeatureId, null, 'selectedFeatureId null')
  assert(sel.selectedNode?.type === 'tab' && sel.selectedNode.tabId === 'tb1', 'primary is tab')
})

test('startCopyTab sets selectedTabIds and clears other families', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.startCopyTab('tb1')
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 1, 'selectedTabIds includes tab')
  assert(sel.selectedTabIds.includes('tb1'), 'tb1 in selectedTabIds')
  assertEq(sel.selectedFeatureIds.length, 0, 'no feature IDs')
  assertEq(sel.selectedClampIds.length, 0, 'no clamp IDs')
})

test('startMoveClamp sets selectedClampIds and clears other families', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.startMoveClamp('cl1')
  const sel = selection()
  assertEq(sel.selectedClampIds.length, 1, 'selectedClampIds includes clamp')
  assert(sel.selectedClampIds.includes('cl1'), 'cl1 in selectedClampIds')
  assertEq(sel.selectedFeatureIds.length, 0, 'no feature IDs')
  assertEq(sel.selectedTabIds.length, 0, 'no tab IDs')
  assert(sel.selectedNode?.type === 'clamp' && sel.selectedNode.clampId === 'cl1', 'primary is clamp')
})

test('startCopyClamp sets selectedClampIds and clears other families', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.startCopyClamp('cl1')
  const sel = selection()
  assertEq(sel.selectedClampIds.length, 1, 'selectedClampIds includes clamp')
  assert(sel.selectedClampIds.includes('cl1'), 'cl1 in selectedClampIds')
  assertEq(sel.selectedFeatureIds.length, 0, 'no feature IDs')
  assertEq(sel.selectedTabIds.length, 0, 'no tab IDs')
})

// ============================================================================
// 13. Non-family node additive feature guard (S2-CORRECTION)
// ============================================================================
console.log('\n13. Non-family node additive feature guard')

function testNonFamilyAdditiveIgnored(nodeType: string, setupFn: () => void) {
  resetStore(projectWithTabsAndClamps())
  setupFn()
  const before = selectionSnapshot()
  store().selectFeature('f1', true)
  const after = selection()
  assert(JSON.stringify(before) === JSON.stringify(after),
    `additive feature on ${nodeType} must be byte-for-byte no-op`)
}

test('additive feature on stock is no-op', () => {
  testNonFamilyAdditiveIgnored('stock', () => store().selectStock())
})

test('additive feature on project is no-op', () => {
  testNonFamilyAdditiveIgnored('project', () => store().selectProject())
})

test('additive feature on grid is no-op', () => {
  testNonFamilyAdditiveIgnored('grid', () => store().selectGrid())
})

test('additive feature on origin is no-op', () => {
  testNonFamilyAdditiveIgnored('origin', () => store().selectOrigin())
})

test('additive feature on backdrop is no-op', () => {
  // backdrop needs a backdrop set on the project
  resetStore(projectWithTabsAndClamps())
  useProjectStore.setState((s) => ({
    project: {
      ...s.project,
      backdrop: {
        name: 'Test',
        width: 100,
        height: 100,
        visible: true,
        imageDataUrl: '',
        mimeType: 'image/png',
        orientationAngle: 90,
        opacity: 0.6,
        intrinsicWidth: 100,
        intrinsicHeight: 100,
        center: { x: 50, y: 50 } as { x: number; y: number },
      },
    },
  }))
  store().selectBackdrop()
  const before = selectionSnapshot()
  store().selectFeature('f1', true)
  const after = selection()
  assert(JSON.stringify(before) === JSON.stringify(after),
    'additive feature on backdrop must be byte-for-byte no-op')
})

test('plain click on feature from stock still replaces selection', () => {
  resetStore(projectWithFeatures())
  store().selectStock()
  store().selectFeature('f1')
  const sel = selection()
  assertEq(sel.selectedFeatureIds.length, 1, 'feature selected')
  assert(sel.selectedNode?.type === 'feature', 'primary switched to feature')
})

test('plain click on feature from project still replaces selection', () => {
  resetStore(projectWithFeatures())
  store().selectProject()
  store().selectFeature('f1')
  const sel = selection()
  assertEq(sel.selectedFeatureIds.length, 1, 'feature selected')
  assert(sel.selectedNode?.type === 'feature', 'primary switched to feature')
})

// ============================================================================
// 14. Cross-family placement transition tests (S2-FINAL-CORRECTION)
// ============================================================================
console.log('\n14. Cross-family placement transition tests')

function assertPlacementClears(placement: 'tab' | 'clamp', expectedRoot: string) {
  const sel = selection()
  assert(sel.selectedFeatureIds.length === 0 && sel.selectedFeatureId === null, `${placement}: feature IDs cleared`)
  assert(sel.selectedNode?.type === expectedRoot, `${placement}: ${expectedRoot}`)
}

test('startAddTabPlacement and startAddClampPlacement clear incompatible family IDs', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectClamp('cl1')
  s.selectClamp('cl2', true)
  s.startAddTabPlacement()
  let sel = selection()
  assertEq(sel.selectedClampIds.length, 0, 'tab placement: clamp IDs cleared')
  assertEq(sel.selectedTabIds.length, 0, 'tab placement: tab IDs empty')
  assertPlacementClears('tab', 'tabs_root')
  resetStore(projectWithTabsAndClamps())
  s.selectTab('tb1')
  s.selectTab('tb2', true)
  s.startAddClampPlacement()
  sel = selection()
  assertEq(sel.selectedTabIds.length, 0, 'clamp placement: tab IDs cleared')
  assertEq(sel.selectedClampIds.length, 0, 'clamp placement: clamp IDs empty')
  assertPlacementClears('clamp', 'clamps_root')
})

test('startAddTabPlacement and startAddClampPlacement clear a selected feature ID', () => {
  const p = projectWithFeatures()
  resetStore(p)
  const s = store()
  s.selectFeature('f1')
  s.selectFeature('f2', true)
  s.startAddTabPlacement()
  assertPlacementClears('tab', 'tabs_root')
  resetStore(p)
  s.selectFeature('f1')
  s.selectFeature('f2', true)
  s.startAddClampPlacement()
  assertPlacementClears('clamp', 'clamps_root')
})

// ============================================================================
// 15. Tab/clamp copy completion selection (S2-FINAL-CORRECTION)
// ============================================================================
console.log('\n15. Tab/clamp copy completion selection')

test('tab copy completion selects created IDs and clears incompatible family', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectClamp('cl1')
  s.selectClamp('cl2', true)
  s.startCopyTab('tb1')
  useProjectStore.setState((prev) => ({
    pendingMove: prev.pendingMove ? { ...prev.pendingMove, fromPoint: { x: 0, y: 0 } } : null,
  }))
  const beforeIds = project().tabs.map((t) => t.id)
  s.completePendingMove({ x: 5, y: 5 })
  const createdIds = project().tabs.map((t) => t.id).filter((id) => !beforeIds.includes(id))
  assertEq(createdIds.length, 1, 'one new tab created')
  const sel = selection()
  assert(sel.selectedTabIds.length === 1 && sel.selectedTabIds.includes(createdIds[0]), 'selectedTabIds correct')
  assertEq(sel.selectedClampIds.length, 0, 'clamp IDs cleared')
  assertEq(sel.selectedFeatureIds.length, 0, 'no feature IDs')
  assertEq(sel.selectedFeatureId, null, 'selectedFeatureId null')
  assert(sel.selectedNode?.type === 'tab' && sel.selectedNode.tabId === createdIds[0], 'primary created tab')
})

test('clamp copy completion selects created IDs and clears incompatible family', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectTab('tb1')
  s.selectTab('tb2', true)
  s.startCopyClamp('cl1')
  useProjectStore.setState((prev) => ({
    pendingMove: prev.pendingMove ? { ...prev.pendingMove, fromPoint: { x: 0, y: 0 } } : null,
  }))
  const beforeIds = project().clamps.map((c) => c.id)
  s.completePendingMove({ x: 5, y: 5 })
  const createdIds = project().clamps.map((c) => c.id).filter((id) => !beforeIds.includes(id))
  assertEq(createdIds.length, 1, 'one new clamp created')
  const sel = selection()
  assertEq(sel.selectedClampIds.length, 1, 'selectedClampIds has created clamp')
  assert(sel.selectedClampIds.includes(createdIds[0]), 'selectedClampIds includes created clamp ID')
  assertEq(sel.selectedTabIds.length, 0, 'tab IDs cleared')
  assertEq(sel.selectedFeatureIds.length, 0, 'no feature IDs')
  assertEq(sel.selectedFeatureId, null, 'selectedFeatureId null')
  assert(sel.selectedNode?.type === 'clamp' && sel.selectedNode.clampId === createdIds[0], 'primary is created clamp')
})

test('tab move completion retains homogeneous source selection', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.startMoveTab('tb1')
  useProjectStore.setState((prev) => ({
    pendingMove: prev.pendingMove ? { ...prev.pendingMove, fromPoint: { x: 0, y: 0 } } : null,
  }))
  s.completePendingMove({ x: 5, y: 5 })
  const sel = selection()
  assertEq(sel.selectedTabIds.length, 1, 'selectedTabIds preserved')
  assert(sel.selectedTabIds.includes('tb1'), 'tb1 still selected')
  assertEq(sel.selectedFeatureIds.length, 0, 'no feature IDs')
  assertEq(sel.selectedClampIds.length, 0, 'no clamp IDs')
})

// ============================================================================
// 16. Strengthened start move/copy with incompatible family seed (S2-FINAL-CORRECTION)
// ============================================================================
console.log('\n16. Strengthened start move/copy with incompatible family seed')

function assertTabSelectedForMove(sel: SelectionState, tabId: string, label: string) {
  assert(sel.selectedClampIds.length === 0 && sel.selectedFeatureIds.length === 0, `${label}: other families cleared`)
  assertEq(sel.selectedTabIds.length, 1, `${label}: tab IDs set`)
  assert(sel.selectedTabIds.includes(tabId), `${label}: correct tab ID`)
  assertEq(sel.selectedFeatureId, null, `${label}: selectedFeatureId null`)
}

test('startMoveTab and startCopyTab clear clamp family when clamps were selected', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectClamp('cl1'); s.selectClamp('cl2', true)
  s.startMoveTab('tb1')
  assertTabSelectedForMove(selection(), 'tb1', 'moveTab')
  resetStore(projectWithTabsAndClamps())
  s.selectClamp('cl1'); s.selectClamp('cl2', true)
  s.startCopyTab('tb1')
  assertTabSelectedForMove(selection(), 'tb1', 'copyTab')
})

function assertClampSelectedForMove(sel: SelectionState, clampId: string, label: string) {
  assert(sel.selectedTabIds.length === 0 && sel.selectedFeatureIds.length === 0, `${label}: other families cleared`)
  assertEq(sel.selectedClampIds.length, 1, `${label}: clamp IDs set`)
  assert(sel.selectedClampIds.includes(clampId), `${label}: ${clampId} selected`)
}

test('startMoveClamp and startCopyClamp clear tab family when tabs were selected', () => {
  resetStore(projectWithTabsAndClamps())
  const s = store()
  s.selectTab('tb1'); s.selectTab('tb2', true)
  s.startMoveClamp('cl1')
  assertClampSelectedForMove(selection(), 'cl1', 'moveClamp')
  resetStore(projectWithTabsAndClamps())
  s.selectTab('tb1'); s.selectTab('tb2', true)
  s.startCopyClamp('cl1')
  assertClampSelectedForMove(selection(), 'cl1', 'copyClamp')
})

// ============================================================================
// Results
// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
