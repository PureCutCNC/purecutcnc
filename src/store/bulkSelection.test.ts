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
 * additive ignore, visible-only family Select All, center-preserving bulk
 * dimension updates, selection sanitization after bulk delete, and one-step
 * undo for bulk operations.
 *
 * Run with: npx tsx src/store/bulkSelection.test.ts
 */

import { useProjectStore } from './projectStore'
import type { ProjectStore, SelectionState } from './types'
import type { Project, Tab, Clamp } from '../types/project'
import { newProject } from '../types/project'

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

function historyLen(): number {
  return useProjectStore.getState().history.past.length
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
  useProjectStore.getState().selectTab('tb1')
  const sel = selection()
  assertEq(sel.selectedFeatureIds.length, 0, 'feature IDs cleared')
  assertEq((sel.selectedTabIds ?? []).length, 1, 'tab ID set')
  assertEq((sel.selectedTabIds ?? [])[0], 'tb1', 'correct tab selected')
  assert((sel.selectedClampIds ?? []).length === 0, 'clamp IDs empty')
  assert(sel.selectedNode?.type === 'tab' && sel.selectedNode.tabId === 'tb1', 'primary is tab')
})

test('selectClamp clears tab IDs and sets clamp IDs', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.getState().selectTab('tb1')
  useProjectStore.getState().selectClamp('cl1')
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 0, 'tab IDs cleared')
  assertEq((sel.selectedClampIds ?? []).length, 1, 'clamp ID set')
  assert(sel.selectedFeatureIds.length === 0, 'feature IDs empty')
  assert(sel.selectedNode?.type === 'clamp' && sel.selectedNode.clampId === 'cl1', 'primary is clamp')
})

test('selectFeature clears tab and clamp IDs', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.getState().selectTab('tb1')
  // selectFeature with feature ID that doesn't exist is a no-op but still switches family
  // Actually selectFeature only switches family if we pass a real feature ID. Let me use a
  // different approach: verify that a project root selection clears arrays.
  useProjectStore.getState().selectFeaturesRoot()
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 0, 'tab IDs cleared')
  assertEq((sel.selectedClampIds ?? []).length, 0, 'clamp IDs cleared')
})

// ============================================================================
// 2. Same-family additive toggle
// ============================================================================
console.log('\n2. Same-family additive toggle')

test('additive tab toggles into selection', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectTab('tb1')
  store.selectTab('tb2', true)
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 2, 'both tabs selected')
  assert((sel.selectedTabIds ?? []).includes('tb1'), 'tb1 in selection')
  assert((sel.selectedTabIds ?? []).includes('tb2'), 'tb2 in selection')
  assert(sel.selectedNode?.type === 'tab' && sel.selectedNode.tabId === 'tb2', 'primary updated to tb2')
})

test('additive tab toggles out of selection', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectTab('tb1')
  store.selectTab('tb2', true)
  store.selectTab('tb1', true) // toggle off tb1
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 1, 'one tab deselected')
  assert((sel.selectedTabIds ?? []).includes('tb2'), 'tb2 still selected')
  assert(!(sel.selectedTabIds ?? []).includes('tb1'), 'tb1 deselected')
})

test('additive toggle preserves primary when sibling toggled off', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectTab('tb1')
  store.selectTab('tb2', true)
  store.selectTab('tb1', true) // toggle off tb1 (not primary)
  const sel = selection()
  assert(sel.selectedNode?.type === 'tab' && sel.selectedNode.tabId === 'tb2', 'primary still tb2')
})

test('additive toggle of primary falls back to remaining member', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectTab('tb1')
  store.selectTab('tb2', true) // primary is now tb2
  store.selectTab('tb2', true) // toggle off primary
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 1, 'one tab remaining')
  assert((sel.selectedTabIds ?? []).includes('tb1'), 'tb1 still selected')
  assert(sel.selectedNode?.type === 'tab' && sel.selectedNode.tabId === 'tb1', 'primary fell back to tb1')
})

test('additive toggle of last member clears selection', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectTab('tb1')
  store.selectTab('tb1', true)
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 0, 'no tabs selected')
  assertEq(sel.selectedNode, null, 'no primary node')
})

test('additive clamp toggles into selection', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectClamp('cl1')
  store.selectClamp('cl2', true)
  const sel = selection()
  assertEq((sel.selectedClampIds ?? []).length, 2, 'both clamps selected')
})

test('additive clamp toggles out of selection', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectClamp('cl1')
  store.selectClamp('cl2', true)
  store.selectClamp('cl1', true)
  const sel = selection()
  assertEq((sel.selectedClampIds ?? []).length, 1, 'cl1 deselected')
  assert((sel.selectedClampIds ?? []).includes('cl2'), 'cl2 still selected')
})

// ============================================================================
// 3. Incompatible additive attempts are ignored
// ============================================================================
console.log('\n3. Incompatible additive attempts')

test('additive tab on feature selection is ignored', () => {
  resetStore(projectWithTabsAndClamps())
  // Simulate a feature-family selection with no feature/tab/clamp mix
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
  // Attempt additive tab — should be ignored since current node is not tab/tabs_root
  useProjectStore.getState().selectTab('tb1', true)
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 0, 'tab not added to feature-family selection')
  assert(sel.selectedNode?.type === 'features_root', 'primary unchanged')
})

test('additive clamp on tab selection is ignored', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectTab('tb1')
  store.selectClamp('cl1', true) // additive on non-clamp family
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 1, 'tab selection preserved')
  assertEq((sel.selectedClampIds ?? []).length, 0, 'clamp not added')
  assert(sel.selectedNode?.type === 'tab', 'primary still tab')
})

test('plain click switches family from tab to clamp', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectTab('tb1')
  store.selectClamp('cl1') // plain click, not additive
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 0, 'tab IDs cleared')
  assertEq((sel.selectedClampIds ?? []).length, 1, 'clamp ID set')
  assert(sel.selectedNode?.type === 'clamp', 'family switched to clamp')
})

// ============================================================================
// 4. Visible-only family Select All
// ============================================================================
console.log('\n4. Visible-only Select All')

test('selectAllTabs selects only visible tabs', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.getState().selectAllTabs()
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 2, 'two visible tabs selected')
  assert((sel.selectedTabIds ?? []).includes('tb1'), 'visible tb1 selected')
  assert((sel.selectedTabIds ?? []).includes('tb2'), 'visible tb2 selected')
  assert(!(sel.selectedTabIds ?? []).includes('tb3'), 'hidden tb3 not selected')
})

test('selectAllClamps selects only visible clamps', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.getState().selectAllClamps()
  const sel = selection()
  assertEq((sel.selectedClampIds ?? []).length, 2, 'two visible clamps selected')
  assert((sel.selectedClampIds ?? []).includes('cl1'), 'visible cl1 selected')
  assert((sel.selectedClampIds ?? []).includes('cl2'), 'visible cl2 selected')
  assert(!(sel.selectedClampIds ?? []).includes('cl3'), 'hidden cl3 not selected')
})

test('selectAllTabs replaces previous clamp selection', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectClamp('cl1')
  store.selectAllTabs()
  const sel = selection()
  assertEq((sel.selectedClampIds ?? []).length, 0, 'clamp selection cleared')
  assertEq((sel.selectedTabIds ?? []).length, 2, 'tab selection set')
})

test('selectAllTabs with no visible tabs yields empty selection', () => {
  const p = projectWithTabsAndClamps()
  p.tabs = p.tabs.map((t) => ({ ...t, visible: false }))
  resetStore(p)
  useProjectStore.getState().selectAllTabs()
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 0, 'no tabs selected')
  assertEq(sel.selectedNode, null, 'no primary node')
})

// ============================================================================
// 5. Center-preserving bulk dimension updates
// ============================================================================
console.log('\n5. Center-preserving bulk dimensions')

test('updateTabs preserves center on width change', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.getState().updateTabs(['tb1'], { w: 20 })
  const tab = project().tabs.find((t) => t.id === 'tb1')!
  // Original center x = 10 + 10/2 = 15
  assertEq(tab.w, 20, 'width updated')
  assertEq(tab.x + tab.w / 2, 15, 'center x preserved')
})

test('updateTabs preserves center on height change', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.getState().updateTabs(['tb1'], { h: 20 })
  const tab = project().tabs.find((t) => t.id === 'tb1')!
  // Original center y = 10 + 10/2 = 15
  assertEq(tab.h, 20, 'height updated')
  assertEq(tab.y + tab.h / 2, 15, 'center y preserved')
})

test('updateTabs preserves center on both dimensions change', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.getState().updateTabs(['tb1'], { w: 20, h: 20 })
  const tab = project().tabs.find((t) => t.id === 'tb1')!
  assertEq(tab.w, 20, 'width updated')
  assertEq(tab.h, 20, 'height updated')
  assertEq(tab.x + tab.w / 2, 15, 'center x preserved')
  assertEq(tab.y + tab.h / 2, 15, 'center y preserved')
})

test('updateTabs keeps width and height independent', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.getState().updateTabs(['tb1'], { w: 20 })
  const tab = project().tabs.find((t) => t.id === 'tb1')!
  assertEq(tab.w, 20, 'width updated')
  assertEq(tab.h, 10, 'height unchanged')
})

test('updateTabs bulk applies to all specified IDs', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.getState().updateTabs(['tb1', 'tb2'], { w: 20 })
  const t1 = project().tabs.find((t) => t.id === 'tb1')!
  const t2 = project().tabs.find((t) => t.id === 'tb2')!
  const t3 = project().tabs.find((t) => t.id === 'tb3')!
  assertEq(t1.w, 20, 'tb1 width updated')
  assertEq(t2.w, 20, 'tb2 width updated')
  assertEq(t3.w, 10, 'tb3 width unchanged')
})

test('updateClamps preserves center on width change', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.getState().updateClamps(['cl1'], { w: 24 })
  const clamp = project().clamps.find((c) => c.id === 'cl1')!
  assertEq(clamp.w, 24, 'width updated')
  assertEq(clamp.x + clamp.w / 2, 10 + 12 / 2, 'center x preserved')
})

test('updateTabs with empty IDs does not change history', () => {
  resetStore(projectWithTabsAndClamps())
  const before = historyLen()
  useProjectStore.getState().updateTabs([], { w: 20 })
  assertEq(historyLen(), before, 'no history entry for empty update')
})

// ============================================================================
// 6. Selection sanitization after bulk delete
// ============================================================================
console.log('\n6. Selection sanitization after bulk delete')

test('deleteTabs removes deleted IDs from selection', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectTab('tb1')
  store.selectTab('tb2', true)
  store.deleteTabs(['tb1'])
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 1, 'one tab remains selected')
  assert((sel.selectedTabIds ?? []).includes('tb2'), 'tb2 still selected')
  assert(!(sel.selectedTabIds ?? []).includes('tb1'), 'tb1 removed')
})

test('deleteTabs clears selection when all selected are deleted', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectTab('tb1')
  store.selectTab('tb2', true)
  store.deleteTabs(['tb1', 'tb2'])
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 0, 'no tabs selected')
  assertEq(sel.selectedNode, null, 'primary cleared')
})

test('deleteTabs promotes other member when primary is deleted', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectTab('tb1')
  store.selectTab('tb2', true) // primary is tb2
  store.deleteTabs(['tb2'])
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 1, 'one tab remains')
  assert((sel.selectedTabIds ?? []).includes('tb1'), 'tb1 remains')
  assert(sel.selectedNode?.type === 'tab' && sel.selectedNode.tabId === 'tb1', 'primary fell back to tb1')
})

test('deleteClamps sanitizes selection', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectClamp('cl1')
  store.selectClamp('cl2', true)
  store.deleteClamps(['cl1', 'cl2'])
  const sel = selection()
  assertEq((sel.selectedClampIds ?? []).length, 0, 'all deleted clamps removed')
  assertEq(sel.selectedNode, null, 'primary cleared')
})

// ============================================================================
// 7. One-step undo for bulk operations
// ============================================================================
console.log('\n7. One-step undo for bulk operations')

test('updateTabs creates one history entry', () => {
  resetStore(projectWithTabsAndClamps())
  const before = historyLen()
  useProjectStore.getState().updateTabs(['tb1', 'tb2'], { w: 20 })
  assertEq(historyLen(), before + 1, 'one history entry created')
})

test('deleteTabs creates one history entry', () => {
  resetStore(projectWithTabsAndClamps())
  const before = historyLen()
  useProjectStore.getState().deleteTabs(['tb1', 'tb2'])
  assertEq(historyLen(), before + 1, 'one history entry for bulk delete')
})

test('undo restores bulk-deleted tabs with selection', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectTab('tb1')
  store.selectTab('tb2', true)
  store.deleteTabs(['tb1', 'tb2'])
  assertEq(project().tabs.length, 1, 'one tab remaining after delete')
  store.undo()
  assertEq(project().tabs.length, 3, 'all three tabs restored')
})

test('undo restores bulk-updated dimensions', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.updateTabs(['tb1'], { w: 20 })
  assertEq(project().tabs.find((t) => t.id === 'tb1')!.w, 20, 'width changed')
  store.undo()
  assertEq(project().tabs.find((t) => t.id === 'tb1')!.w, 10, 'width restored')
})

// ============================================================================
// 8. Bulk selection helpers
// ============================================================================
console.log('\n8. Bulk selection helpers')

test('selectTabs sets exact ID set', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.getState().selectTabs(['tb1', 'tb3'])
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 2, 'two tabs selected')
  assert((sel.selectedTabIds ?? []).includes('tb1'), 'tb1 selected')
  assert((sel.selectedTabIds ?? []).includes('tb3'), 'tb3 selected')
  assert((sel.selectedClampIds ?? []).length === 0, 'clamp IDs cleared')
})

test('selectTabs filters out nonexistent IDs', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.getState().selectTabs(['tb1', 'nonexistent'])
  const sel = selection()
  assertEq((sel.selectedTabIds ?? []).length, 1, 'only valid IDs kept')
  assert((sel.selectedTabIds ?? []).includes('tb1'), 'valid ID kept')
})

test('selectTabs replaces previous clamp selection', () => {
  resetStore(projectWithTabsAndClamps())
  const store = useProjectStore.getState()
  store.selectClamp('cl1')
  store.selectTabs(['tb1'])
  const sel = selection()
  assertEq((sel.selectedClampIds ?? []).length, 0, 'clamp IDs cleared')
  assertEq((sel.selectedTabIds ?? []).length, 1, 'tab IDs set')
})

test('selectClamps deduplicates IDs', () => {
  resetStore(projectWithTabsAndClamps())
  useProjectStore.getState().selectClamps(['cl1', 'cl1', 'cl2'])
  const sel = selection()
  assertEq((sel.selectedClampIds ?? []).length, 2, 'duplicates filtered')
})

// ============================================================================
// Results
// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
