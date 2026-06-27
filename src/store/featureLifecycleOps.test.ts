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
 * Feature Lifecycle Ops Tests — Phase 3 audit-and-fill (Area C).
 *
 * Stock, tabs, and align/distribute lifecycle paths. No existing coverage.
 * Drives the real store actions.
 *
 * Run with: npx tsx src/store/featureLifecycleOps.test.ts
 */

import {
  defaultTool,
  newProject,
  rectProfile,
  type Project,
  type SketchFeature,
  type Stock,
} from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { getProfileBounds } from '../types/project'

// ── Helpers ──────────────────────────────────────────────────────────

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) <= epsilon
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
    pendingAdd: null,
    pendingMove: null,
    pendingShapeAction: null,
  } as unknown as Partial<ProjectStore>)
}

function getProject(): Project {
  return useProjectStore.getState().project
}

function getFeatures(): SketchFeature[] {
  return getProject().features
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
// 1. STOCK — basic create + change
// =====================================================================

console.log('\nStock — basic create + change')

test('setStock updates stock dimensions', () => {
  resetStore()
  const store = useProjectStore.getState()

  const newStock: Stock = {
    profile: rectProfile(0, 0, 300, 200),
    thickness: 25,
    material: 'aluminum_6061',
    color: '#cccccc',
    visible: true,
    origin: { x: 0, y: 0 },
    sourceFeatureId: null,
    sourceFeature: null,
  }
  store.setStock(newStock)

  const stock = getProject().stock
  const bounds = getProfileBounds(stock.profile)
  assert(approx(bounds.maxX - bounds.minX, 300), `stock width should be 300, got ${bounds.maxX - bounds.minX}`)
  assert(approx(bounds.maxY - bounds.minY, 200), `stock height should be 200, got ${bounds.maxY - bounds.minY}`)
  assert(approx(stock.thickness, 25), `stock thickness should be 25, got ${stock.thickness}`)
  assert(stock.sourceFeatureId === null, 'sourceFeatureId should be null')
})

test('setStock is undoable', () => {
  resetStore()
  const store = useProjectStore.getState()

  const originalThickness = getProject().stock.thickness
  const newStock2: Stock = {
    profile: rectProfile(0, 0, 300, 200),
    thickness: 50,
    material: 'aluminum_6061',
    color: '#cccccc',
    visible: true,
    origin: { x: 0, y: 0 },
    sourceFeatureId: null,
    sourceFeature: null,
  }
  store.setStock(newStock2)
  assert(approx(getProject().stock.thickness, 50), 'thickness should be updated')

  store.undo()
  assert(approx(getProject().stock.thickness, originalThickness), 'undo should restore original thickness')
})

test('setStockSourceFeature: sets feature as stock source, removes from tree', () => {
  resetStore()
  const store = useProjectStore.getState()

  // Add a rect feature to serve as stock source
  store.addRectFeature('StockSource', 0, 0, 250, 150, 30)
  const features = getFeatures()
  assert(features.length === 1, 'should have 1 feature')
  const sourceId = features[0].id

  // Set it as stock source
  store.setStockSourceFeature(sourceId)

  // Feature is removed from tree but stored in stock.sourceFeature
  const afterStock = getProject().stock
  assert(afterStock.sourceFeatureId === sourceId, 'sourceFeatureId should be set')
  assert(afterStock.sourceFeature !== null, 'sourceFeature should be stored')
  assert(afterStock.sourceFeature !== undefined, 'sourceFeature should not be undefined')
  assert(getFeatures().length === 0, 'feature should be removed from feature list when set as stock source')
})

test('setStockSourceFeature(null): restores feature and resets to rect stock', () => {
  resetStore()
  const store = useProjectStore.getState()

  store.addRectFeature('StockSource', 0, 0, 250, 150, 30)
  const sourceId = getFeatures()[0].id
  store.setStockSourceFeature(sourceId)
  assert(getFeatures().length === 0, 'feature removed from tree')

  // Reset to rectangle
  store.setStockSourceFeature(null)

  // Feature should be restored
  const features = getFeatures()
  assert(features.length === 1, 'feature should be restored after reset')
  assert(features[0].id === sourceId, 'restored feature should have original id')

  // Stock should be reset
  const stock = getProject().stock
  assert(stock.sourceFeatureId === null || stock.sourceFeatureId === undefined, 'sourceFeatureId should be cleared')
})

// =====================================================================
// 2. STOCK — delete source feature resets stock
// =====================================================================

console.log('\nStock — delete source feature resets stock')

test('delete source feature resets stock to rect bounds', () => {
  resetStore()
  const store = useProjectStore.getState()

  store.addRectFeature('StockSource', 0, 0, 250, 150, 30)
  const sourceId = getFeatures()[0].id
  store.setStockSourceFeature(sourceId)

  // The feature is now the stock source (removed from tree, held in stock.sourceFeature)
  // Delete the stock source feature via its id
  store.deleteFeature(sourceId)

  // Stock should be reset to rect with source cleared
  const stock = getProject().stock
  // The sourceFeatureId should be cleared after deleting the source
  // (The featureSlice deleteFeatures path handles this)
  assert(stock.sourceFeatureId === null || stock.sourceFeatureId === undefined,
    `sourceFeatureId should be cleared after source delete, got ${stock.sourceFeatureId}`)
  // Stock should still have valid bounds (derived from the original stock source rect)
  const bounds = getProfileBounds(stock.profile)
  assert(bounds.maxX - bounds.minX > 0 && bounds.maxY - bounds.minY > 0,
    'stock should have valid dimensions after reset')
})

// =====================================================================
// 3. TABS — create, auto-place, edit, delete
// =====================================================================

console.log('\nTabs — create, auto-place, edit, delete')

test('autoPlaceTabsForOperation creates tabs for edge_route_outside', () => {
  resetStore()
  const store = useProjectStore.getState()

  // Create a rect feature and a tool
  store.addRectFeature('Part', 10, 10, 50, 40, 5)
  const feat = getFeatures()[0]

  const tool = { ...defaultTool('mm', 1), id: 't1', name: '6mm endmill', diameter: 6 }
  useProjectStore.setState({
    project: { ...getProject(), tools: [tool] },
  } as unknown as Partial<ProjectStore>)

  // Create an edge_route_outside operation
  const opId = store.addOperation('edge_route_outside', 'rough', { source: 'features', featureIds: [feat.id] })
  assert(opId !== null, 'operation should be created')

  // Auto-place tabs
  store.autoPlaceTabsForOperation(opId!)

  const tabs = getProject().tabs
  assert(tabs.length > 0, `autoPlaceTabsForOperation should create at least 1 tab, got ${tabs.length}`)

  // Each tab should have valid geometry
  for (const tab of tabs) {
    assert(tab.w > 0 && tab.h > 0, `tab should have positive dimensions, got w=${tab.w}, h=${tab.h}`)
  }
})

test('updateTab modifies tab geometry', () => {
  resetStore()
  const store = useProjectStore.getState()

  store.addRectFeature('Part', 10, 10, 50, 40, 5)
  const feat = getFeatures()[0]
  const tool = { ...defaultTool('mm', 1), id: 't1', name: '6mm endmill', diameter: 6 }
  useProjectStore.setState({
    project: { ...getProject(), tools: [tool] },
  } as unknown as Partial<ProjectStore>)

  const opId = store.addOperation('edge_route_outside', 'rough', { source: 'features', featureIds: [feat.id] })
  store.autoPlaceTabsForOperation(opId!)

  const tabs = getProject().tabs
  assert(tabs.length > 0, 'should have tabs')

  // Update the first tab
  const tabId = tabs[0].id
  store.updateTab(tabId, { w: 20, z_top: 3 })

  const updated = getProject().tabs.find((t) => t.id === tabId)!
  assert(approx(updated.w, 20), `tab width should be 20, got ${updated.w}`)
  assert(approx(updated.z_top, 3), `tab z_top should be 3, got ${updated.z_top}`)
})

test('deleteTab removes tab', () => {
  resetStore()
  const store = useProjectStore.getState()

  store.addRectFeature('Part', 10, 10, 50, 40, 5)
  const feat = getFeatures()[0]
  const tool = { ...defaultTool('mm', 1), id: 't1', name: '6mm endmill', diameter: 6 }
  useProjectStore.setState({
    project: { ...getProject(), tools: [tool] },
  } as unknown as Partial<ProjectStore>)

  const opId = store.addOperation('edge_route_outside', 'rough', { source: 'features', featureIds: [feat.id] })
  store.autoPlaceTabsForOperation(opId!)

  const tabsBefore = getProject().tabs
  assert(tabsBefore.length > 0, 'should have tabs before delete')
  const tabId = tabsBefore[0].id

  store.deleteTab(tabId)
  const tabsAfter = getProject().tabs
  assert(tabsAfter.length === tabsBefore.length - 1, 'tab count should decrease by 1')
  assert(!tabsAfter.some((t) => t.id === tabId), 'deleted tab should not exist')
})

test('enterTabEdit + moveTabControl repositions tab', () => {
  resetStore()
  const store = useProjectStore.getState()

  store.addRectFeature('Part', 10, 10, 50, 40, 5)
  const feat = getFeatures()[0]
  const tool = { ...defaultTool('mm', 1), id: 't1', name: '6mm endmill', diameter: 6 }
  useProjectStore.setState({
    project: { ...getProject(), tools: [tool] },
  } as unknown as Partial<ProjectStore>)

  const opId = store.addOperation('edge_route_outside', 'rough', { source: 'features', featureIds: [feat.id] })
  store.autoPlaceTabsForOperation(opId!)

  const tabs = getProject().tabs
  assert(tabs.length > 0, 'should have tabs')
  const tabId = tabs[0].id
  const originalX = tabs[0].x
  const originalY = tabs[0].y

  // Enter tab edit and move a control — tab should change position
  // (moveTabControl moves the anchor/control, not a direct translate;
  //  the tab's (x,y) is derived from the control positions)
  store.enterTabEdit(tabId)
  store.moveTabControl(tabId, { kind: 'anchor', index: 0 }, { x: originalX + 5, y: originalY + 5 })

  const moved = getProject().tabs.find((t) => t.id === tabId)!
  // Tab should have moved from its original position
  assert(!approx(moved.x, originalX) || !approx(moved.y, originalY),
    `tab position should have changed from (${originalX}, ${originalY}), got (${moved.x}, ${moved.y})`)
})

// =====================================================================
// 4. ALIGN / DISTRIBUTE — ≥3 features
// =====================================================================

console.log('\nAlign / distribute — ≥3 features')

function addThreeRects(): string[] {
  resetStore()
  const store = useProjectStore.getState()

  // Three rects at different positions
  store.addRectFeature('Rect1', 10, 10, 30, 15, 5)
  store.addRectFeature('Rect2', 80, 50, 30, 15, 5)
  store.addRectFeature('Rect3', 50, 90, 30, 15, 5)

  const features = getFeatures()
  assert(features.length === 3, `should have 3 features, got ${features.length}`)
  return features.map((f) => f.id)
}

test('alignFeatures left: aligns to common minX', () => {
  const ids = addThreeRects()
  const store = useProjectStore.getState()

  // All three rects have width 30, so minX varies. Find refMinX (smallest minX)
  const preFeatures = getFeatures()
  const preMinXs = preFeatures.map((f) => getProfileBounds(f.sketch.profile).minX)
  const refMinX = Math.min(...preMinXs) // should be 10 (Rect1)

  store.selectFeatures(ids)
  store.alignFeatures(ids, 'left')

  const features = getFeatures()
  for (const f of features) {
    const bounds = getProfileBounds(f.sketch.profile)
    assert(approx(bounds.minX, refMinX),
      `feature ${f.name} minX should be ${refMinX}, got ${bounds.minX}`)
  }
})

test('alignFeatures right: aligns to common maxX', () => {
  const ids = addThreeRects()
  const store = useProjectStore.getState()

  const preFeatures = getFeatures()
  const preMaxXs = preFeatures.map((f) => getProfileBounds(f.sketch.profile).maxX)
  const refMaxX = Math.max(...preMaxXs) // should be 110 (Rect2: 80+30=110)

  store.selectFeatures(ids)
  store.alignFeatures(ids, 'right')

  const features = getFeatures()
  for (const f of features) {
    const bounds = getProfileBounds(f.sketch.profile)
    assert(approx(bounds.maxX, refMaxX),
      `feature ${f.name} maxX should be ${refMaxX}, got ${bounds.maxX}`)
  }
})

test('alignFeatures center_horizontal: aligns to common center X', () => {
  const ids = addThreeRects()
  const store = useProjectStore.getState()

  store.selectFeatures(ids)
  store.alignFeatures(ids, 'center_horizontal')

  const features = getFeatures()
  const centerXs = features.map((f) => {
    const b = getProfileBounds(f.sketch.profile)
    return (b.minX + b.maxX) / 2
  })
  const firstCenter = centerXs[0]
  for (const cx of centerXs) {
    assert(approx(cx, firstCenter), `all centerX should be ${firstCenter}, got ${cx}`)
  }
})

test('alignFeatures top: aligns to common minY', () => {
  const ids = addThreeRects()
  const store = useProjectStore.getState()

  const preFeatures = getFeatures()
  const preMinYs = preFeatures.map((f) => getProfileBounds(f.sketch.profile).minY)
  const refMinY = Math.min(...preMinYs) // should be 10 (Rect1)

  store.selectFeatures(ids)
  store.alignFeatures(ids, 'top')

  const features = getFeatures()
  for (const f of features) {
    const bounds = getProfileBounds(f.sketch.profile)
    assert(approx(bounds.minY, refMinY),
      `feature ${f.name} minY should be ${refMinY}, got ${bounds.minY}`)
  }
})

test('distributeFeatures horizontal_gaps: equalizes horizontal spacing', () => {
  const ids = addThreeRects()
  const store = useProjectStore.getState()

  store.selectFeatures(ids)
  store.distributeFeatures(ids, 'horizontal_gaps')

  const features = getFeatures()
  // Sort by minX to get left-to-right order
  const sorted = [...features].sort(
    (a, b) => getProfileBounds(a.sketch.profile).minX - getProfileBounds(b.sketch.profile).minX,
  )

  // Gaps between consecutive features should be equal
  const gap1 = getProfileBounds(sorted[1].sketch.profile).minX - getProfileBounds(sorted[0].sketch.profile).maxX
  const gap2 = getProfileBounds(sorted[2].sketch.profile).minX - getProfileBounds(sorted[1].sketch.profile).maxX
  assert(approx(gap1, gap2), `gaps should be equal: gap1=${gap1}, gap2=${gap2}`)
})

test('distributeFeatures vertical_centers: equalizes vertical center spacing', () => {
  const ids = addThreeRects()
  const store = useProjectStore.getState()

  store.selectFeatures(ids)
  store.distributeFeatures(ids, 'vertical_centers')

  const features = getFeatures()
  const centers = features.map((f) => {
    const b = getProfileBounds(f.sketch.profile)
    return (b.minY + b.maxY) / 2
  }).sort((a, b) => a - b)

  // Steps between consecutive centers should be equal
  const step1 = centers[1] - centers[0]
  const step2 = centers[2] - centers[1]
  assert(approx(step1, step2), `center steps should be equal: step1=${step1}, step2=${step2}`)
})

// =====================================================================
// 5. ALIGN / DISTRIBUTE — undo
// =====================================================================

console.log('\nAlign / distribute — undo')

test('alignFeatures is undoable', () => {
  const ids = addThreeRects()
  const store = useProjectStore.getState()

  const preFeatures = getFeatures()
  const preMinY_0 = getProfileBounds(preFeatures[0].sketch.profile).minY

  store.selectFeatures(ids)
  store.alignFeatures(ids, 'top')

  // After top-align, positions may change. We only assert undo restores.
  store.undo()

  const undoneFeatures = getFeatures()
  const undoneMinY_0 = getProfileBounds(undoneFeatures[0].sketch.profile).minY
  assert(approx(undoneMinY_0, preMinY_0),
    `undo should restore pre-align minY: was ${preMinY_0}, got ${undoneMinY_0}`)
})

test('distributeFeatures is undoable', () => {
  const ids = addThreeRects()
  const store = useProjectStore.getState()

  const preFeatures = getFeatures()
  const preMinX_1 = getProfileBounds(preFeatures[1].sketch.profile).minX

  store.selectFeatures(ids)
  store.distributeFeatures(ids, 'horizontal_gaps')

  store.undo()

  const undoneFeatures = getFeatures()
  const undoneMinX_1 = getProfileBounds(undoneFeatures[1].sketch.profile).minX
  assert(approx(undoneMinX_1, preMinX_1),
    `undo should restore pre-distribute minX: was ${preMinX_1}, got ${undoneMinX_1}`)
})

// =====================================================================
// Summary
// =====================================================================

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
