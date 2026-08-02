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
 * Store tests for sticky drawing (issue #415).
 *
 * Run with: npx tsx src/store/stickyDrawing.test.ts
 */

import { newProject } from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function resetStore(): void {
  useProjectStore.setState({
    project: newProject(),
    selection: {
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedNode: null,
      mode: 'feature' as const,
      sketchEditTool: null,
      activeControl: null,
      hoveredFeatureId: null,
      groupFolderId: null,
    },
    history: { past: [], future: [], transactionStart: null },
    sketchEditSession: null,
    pendingConstraint: null,
    pendingTransform: null,
    pendingOffset: null,
    pendingAdd: null,
    pendingMove: null,
    pendingShapeAction: null,
    creationTarget: 'feature' as const,
  } as unknown as Partial<ProjectStore>)
}

function testRectReArmsAfterCompletion() {
  resetStore()
  const store = useProjectStore.getState()
  store.startAddRectPlacement()
  useProjectStore.getState().setPendingAddAnchor({ x: 10, y: 10 })
  useProjectStore.getState().placePendingAddAt({ x: 20, y: 20 })

  const state = useProjectStore.getState()
  assert(state.pendingAdd !== null, 'pendingAdd should be non-null after rect completion')
  assert(state.pendingAdd?.shape === 'rect', 'pendingAdd shape should be rect')
  assert((state.pendingAdd as { anchor: unknown }).anchor === null, 'pendingAdd anchor should be null (re-armed)')
  assert(state.project.features.length === 1, 'one feature should exist')
}

function testDrawTwoRectsInSequence() {
  resetStore()
  const store = useProjectStore.getState()

  store.startAddRectPlacement()
  useProjectStore.getState().setPendingAddAnchor({ x: 10, y: 10 })
  useProjectStore.getState().placePendingAddAt({ x: 20, y: 20 })

  useProjectStore.getState().setPendingAddAnchor({ x: 30, y: 30 })
  useProjectStore.getState().placePendingAddAt({ x: 40, y: 40 })

  const state = useProjectStore.getState()
  assert(state.project.features.length === 2, 'two features should exist')
  assert(state.pendingAdd !== null, 'pendingAdd should remain armed after second rect')
  assert(state.pendingAdd?.shape === 'rect', 'pendingAdd shape should still be rect')
}

function testEscapeClearsAfterCompletion() {
  resetStore()
  const store = useProjectStore.getState()

  store.startAddRectPlacement()
  useProjectStore.getState().setPendingAddAnchor({ x: 10, y: 10 })
  useProjectStore.getState().placePendingAddAt({ x: 20, y: 20 })

  let state = useProjectStore.getState()
  assert(state.pendingAdd !== null, 'pendingAdd should be re-armed after completion')

  useProjectStore.getState().cancelPendingAdd()
  state = useProjectStore.getState()
  assert(state.pendingAdd === null, 'pendingAdd should be null after Escape')
}

function testNgonReArmPreservesSides() {
  resetStore()
  const store = useProjectStore.getState()

  store.startAddNgonPlacement()
  useProjectStore.getState().setPendingNgonSides(5)
  useProjectStore.getState().setPendingAddAnchor({ x: 10, y: 10 })
  useProjectStore.getState().placePendingNgonAt({ x: 20, y: 20 })

  const state = useProjectStore.getState()
  assert(state.pendingAdd !== null, 'pendingAdd should be re-armed')
  assert(state.pendingAdd?.shape === 'ngon', 'pendingAdd shape should be ngon')
  assert((state.pendingAdd as { sides: number }).sides === 5, 'ngon sides should be preserved (5)')
}

function testGearReArmPreservesParamsResetsRadius() {
  resetStore()
  const store = useProjectStore.getState()

  store.startAddGearPlacement()
  useProjectStore.getState().setPendingAddAnchor({ x: 10, y: 10 })
  useProjectStore.getState().setPendingGearRadiusAt({ x: 30, y: 10 })
  useProjectStore.getState().setPendingGearParams({ boreDiameter: 6, teeth: 20 })
  useProjectStore.getState().completePendingGear()

  const state = useProjectStore.getState()
  assert(state.pendingAdd !== null, 'pendingAdd should be re-armed')
  assert(state.pendingAdd?.shape === 'gear', 'pendingAdd shape should be gear')
  const gear = state.pendingAdd as { shape: 'gear'; params: { boreDiameter: number; teeth: number }; outsideRadius: unknown }
  assert(gear.params.boreDiameter === 6, 'gear params.boreDiameter should be preserved')
  assert(gear.params.teeth === 20, 'gear params.teeth should be preserved')
  assert(gear.outsideRadius === null, 'gear outsideRadius should be null (reset)')
}

function testCompositeReArmPreservesModeAndResetsGeometry() {
  resetStore()
  useProjectStore.setState({
    pendingAdd: {
      shape: 'composite',
      start: { x: 10, y: 10 },
      lastPoint: { x: 10, y: 10 },
      segments: [
        { type: 'line' as const, to: { x: 20, y: 10 } },
        { type: 'line' as const, to: { x: 15, y: 20 } },
        { type: 'line' as const, to: { x: 10, y: 10 } },
      ],
      currentMode: 'arc' as const,
      pendingArcEnd: null,
      closed: true,
      session: 1,
    },
  } as unknown as Partial<ProjectStore>)
  useProjectStore.getState().completePendingComposite()

  const state = useProjectStore.getState()
  assert(state.pendingAdd !== null, 'pendingAdd should be re-armed')
  assert(state.pendingAdd?.shape === 'composite', 'pendingAdd shape should be composite')
  const comp = state.pendingAdd as { currentMode: string; start: unknown; segments: unknown[] }
  assert(comp.currentMode === 'arc', 'composite currentMode should be preserved (arc)')
  assert(comp.start === null, 'composite start should be null (reset)')
  assert(comp.segments.length === 0, 'composite segments should be empty (reset)')
}

const tests = [
  ['rect re-arms after completion', testRectReArmsAfterCompletion],
  ['draw two rects in sequence', testDrawTwoRectsInSequence],
  ['escape clears after completion', testEscapeClearsAfterCompletion],
  ['ngon re-arm preserves sides', testNgonReArmPreservesSides],
  ['gear re-arm preserves params and resets radius', testGearReArmPreservesParamsResetsRadius],
  ['composite re-arm preserves mode and resets geometry', testCompositeReArmPreservesModeAndResetsGeometry],
] as const

let passed = 0
for (const [name, test] of tests) {
  test()
  passed += 1
  console.log(`${name}: PASSED`)
}
console.log(`\nstickyDrawing.test.ts: ${passed} passed, 0 failed`)