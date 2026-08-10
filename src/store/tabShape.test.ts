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
 * Tab shape field tests for issue #414 slice S1.
 *
 * Covers: legacy-tab rect default, explicit smooth round-trip, garbage-value
 * safety, full-project normalization, serialization round-trip, unit-conversion
 * preservation, updateTab array-identity invalidation, and auto-placement
 * creation default.
 *
 * Run with: npx tsx src/store/tabShape.test.ts
 */

import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import {
  defaultTool,
  newProject,
  tabShape,
  type Project,
  type Tab,
} from '../types/project'
import { normalizeProject } from './helpers/projectFormat'
import { convertProjectUnits } from '../utils/units'

// ── Helpers ──────────────────────────────────────────────────────────

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
    pendingAdd: null,
    pendingMove: null,
    pendingShapeAction: null,
  } as unknown as Partial<ProjectStore>)
}

function getProject(): Project {
  return useProjectStore.getState().project
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err: unknown) {
    failed++
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`  ✗ ${name}`)
    console.error(`    ${msg}`)
  }
}

// ── Tests ────────────────────────────────────────────────────────────

console.log('\nTab shape — data model')

// 1. Legacy tab (no shape key) resolves to 'rect'
test('tabShape() returns rect for a tab with no shape field', () => {
  const t: Tab = {
    id: 'tb1',
    name: 'Tab 1',
    x: 0,
    y: 0,
    w: 6,
    h: 6,
    z_top: 3,
    z_bottom: 0,
    visible: true,
  }
  assertEq(tabShape(t), 'rect', 'missing shape should resolve to rect')
  // `shape` is optional at the type level, so TypeScript should not
  // require any cast for the tab above.
  assert(!('shape' in t), 'legacy tab object should not have shape key at all')
})

// 2. Explicit smooth survives normalizeTab (via normalizeProject)
test('normalizeProject preserves explicit smooth', () => {
  const base = newProject()
  const input: Project = {
    ...base,
    tabs: [
      {
        id: 'tb1',
        name: 'Smooth Tab',
        x: 10,
        y: 10,
        w: 6,
        h: 6,
        z_top: 3,
        z_bottom: 0,
        visible: true,
        shape: 'smooth',
      },
    ],
  }
  const normalized = normalizeProject(input)
  assertEq(normalized.tabs.length, 1, 'should have 1 tab')
  assertEq(normalized.tabs[0].shape, 'smooth', 'explicit smooth should survive normalization')
})

// 3. Unknown/garbage value normalizes to 'rect'
test('tabShape() returns rect for an unknown shape value', () => {
  const t = {
    id: 'tb1',
    name: 'Tab 1',
    x: 0,
    y: 0,
    w: 6,
    h: 6,
    z_top: 3,
    z_bottom: 0,
    visible: true,
    shape: 'banana',
  } as unknown as Tab
  assertEq(tabShape(t), 'rect', 'unknown shape value should resolve to rect, never smooth')
})

// 4. Full project load: serialized tabs without shape → all rect
test('normalizeProject defaults all legacy tabs to rect', () => {
  const base = newProject()
  const input: Project = {
    ...base,
    tabs: [
      { id: 'tb1', name: 'Tab 1', x: 0, y: 0, w: 6, h: 6, z_top: 3, z_bottom: 0, visible: true },
      { id: 'tb2', name: 'Tab 2', x: 20, y: 20, w: 6, h: 6, z_top: 3, z_bottom: 0, visible: true },
    ],
  }
  const normalized = normalizeProject(input)
  assertEq(normalized.tabs.length, 2, 'should have 2 tabs')
  for (const t of normalized.tabs) {
    assertEq(t.shape, 'rect', `tab ${t.id} should default to rect`)
  }
})

// 5. Round trip: smooth serialized and re-loaded stays smooth
test('smooth tab survives serialize and re-load', () => {
  const base = newProject()
  const input: Project = {
    ...base,
    tabs: [
      {
        id: 'tb1',
        name: 'Smooth Tab',
        x: 10,
        y: 10,
        w: 6,
        h: 6,
        z_top: 3,
        z_bottom: 0,
        visible: true,
        shape: 'smooth',
      },
    ],
  }
  const first = normalizeProject(input)
  assertEq(first.tabs[0].shape, 'smooth', 'shape should survive first normalization')

  // Serialize by round-tripping through normalizeProject (same as load path)
  const second = normalizeProject(first)
  assertEq(second.tabs[0].shape, 'smooth', 'shape should survive second normalization (round trip)')
})

// 6. convertProjectUnits preserves shape
test('convertProjectUnits mm→inch→mm preserves smooth shape', () => {
  const base = newProject('Test', 'mm')
  const project: Project = {
    ...base,
    tabs: [
      {
        id: 'tb1',
        name: 'Smooth Tab',
        x: 10,
        y: 10,
        w: 6,
        h: 6,
        z_top: 3,
        z_bottom: 0,
        visible: true,
        shape: 'smooth',
      },
    ],
  }
  const normalized = normalizeProject(project)
  assertEq(normalized.tabs[0].shape, 'smooth', 'shape should be smooth before conversion')

  const inInch = convertProjectUnits(normalized, 'inch')
  assert(inInch.meta.units === 'inch', 'units should be inch after conversion')
  assertEq(inInch.tabs[0].shape, 'smooth', 'convertProjectUnits must preserve shape (mm→inch)')

  const backInMm = convertProjectUnits(inInch, 'mm')
  assert(backInMm.meta.units === 'mm', 'units should be mm after round trip')
  assertEq(backInMm.tabs[0].shape, 'smooth', 'convertProjectUnits must preserve shape (inch→mm)')
})

// 7. updateTab replaces the tabs array identity for toolpath cache invalidation.
//    src/app/useToolpathGeneration.ts checks `entry.tabs === project.tabs`
test('updateTab with shape change replaces the tabs array', () => {
  resetStore()
  const store = useProjectStore.getState()

  // Add a tab via the store action
  store.addRectFeature('Part', 10, 10, 50, 40, 5)

  const storeState = useProjectStore.getState()
  useProjectStore.setState({
    project: {
      ...storeState.project,
      tabs: [
        {
          id: 'tb1',
          name: 'Tab 1',
          x: 10,
          y: 10,
          w: 6,
          h: 6,
          z_top: 3,
          z_bottom: 0,
          visible: true,
          shape: 'rect',
        },
      ],
    },
  } as unknown as Partial<ProjectStore>)

  const prev = getProject()
  const prevTabs = prev.tabs

  // Mutate via updateTab
  useProjectStore.getState().updateTab('tb1', { shape: 'smooth' })
  const next = getProject()

  assertEq(next.tabs[0].shape, 'smooth', 'tab shape should be updated to smooth')
  // Array identity must change or useToolpathGeneration's cache won't invalidate
  assert(
    next.tabs !== prevTabs,
    'updateTab must replace the tabs array identity so useToolpathGeneration cache invalidates',
  )
})

// 8. Auto-placed tabs are created with shape: 'rect'
test('autoPlaceTabsForOperation creates tabs with shape: rect', () => {
  resetStore()
  const store = useProjectStore.getState()

  store.addRectFeature('Part', 10, 10, 50, 40, 5)
  const feat = getProject().features[0]

  const tool = { ...defaultTool('mm', 1), id: 't1', name: '6mm endmill', diameter: 6 }
  useProjectStore.setState({
    project: { ...getProject(), tools: [tool] },
  } as unknown as Partial<ProjectStore>)

  const opId = store.addOperation('edge_route_outside', 'rough', { source: 'features', featureIds: [feat.id] })
  assert(opId !== null, 'operation should be created')

  store.autoPlaceTabsForOperation(opId!)

  const tabs = getProject().tabs
  assert(tabs.length > 0, `autoPlaceTabsForOperation should create at least 1 tab, got ${tabs.length}`)

  for (const t of tabs) {
    assertEq(t.shape, 'rect', `auto-placed tab ${t.id} should have shape: 'rect'`)
  }
})

// =====================================================================
// Summary
// =====================================================================

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
