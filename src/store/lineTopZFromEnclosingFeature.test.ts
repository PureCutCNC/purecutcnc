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

import type { Point, SketchProfile } from '../types/project'
import { useProjectStore } from './projectStore'
import { resolvedProjectFeatures } from './helpers/resolveFeatures'
import { inferLineTopZFromEnclosingFeature } from './helpers/manualFeatureOperation'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function resetStore(): void {
  useProjectStore.getState().createNewProject()
  useProjectStore.getState().setCreationTarget('feature')
}

function featureZTop(name: string): number | undefined {
  const feature = resolvedProjectFeatures(useProjectStore.getState().project).find((f) => f.name === name)
  return typeof feature?.z_top === 'number' ? feature.z_top : undefined
}

/** Build a store project with an outer Add and an inner Subtract pocket. */
function setupPocket(floorZ: number): { pocketName: string } {
  useProjectStore.getState().addRectFeature('outer', 0, 0, 100, 100, 6)
  useProjectStore.getState().addRectFeature('pocket', 10, 10, 80, 80, 6)
  const pocket = resolvedProjectFeatures(useProjectStore.getState().project).find((f) => f.name === 'pocket')
  assert(pocket?.operation === 'subtract', 'pocket should default to subtract inside the add')
  useProjectStore.getState().updateFeature(pocket!.id, { z_bottom: floorZ })
  return { pocketName: 'pocket' }
}

function openPolylineProfile(p1: Point, p2: Point): SketchProfile {
  return { start: p1, segments: [{ type: 'line', to: p2 }], closed: false }
}

// ── Unit tests of the helper ─────────────────────────────────────────

function testLineInsideSubtractInheritsPocketFloor(): void {
  resetStore()
  setupPocket(2)
  const project = useProjectStore.getState().project
  const z = inferLineTopZFromEnclosingFeature(project, openPolylineProfile({ x: 30, y: 40 }, { x: 70, y: 40 }), 10)
  assert(z === 2, `line inside pocket should inherit pocket floor (z_bottom=2), got ${z}`)
}

function testLineOnPocketWallStillInherits(): void {
  resetStore()
  setupPocket(2)
  const project = useProjectStore.getState().project
  // Endpoints on the pocket boundary (x=10 and x=90). Clipper treats
  // on-boundary as inside (non-zero), so a line along the wall still inherits.
  const z = inferLineTopZFromEnclosingFeature(project, openPolylineProfile({ x: 10, y: 50 }, { x: 90, y: 50 }), 10)
  assert(z === 2, `line on pocket wall should inherit floor, got ${z}`)
}

function testLineOutsideAnySolidKeepsDefault(): void {
  resetStore()
  setupPocket(2)
  const project = useProjectStore.getState().project
  const z = inferLineTopZFromEnclosingFeature(project, openPolylineProfile({ x: 200, y: 200 }, { x: 210, y: 210 }), 10)
  assert(z === 10, `line outside any solid should keep default, got ${z}`)
}

function testLineInsideAddInheritsAddTop(): void {
  resetStore()
  useProjectStore.getState().addRectFeature('plate', 0, 0, 100, 100, 7)
  useProjectStore.getState().updateFeature(
    resolvedProjectFeatures(useProjectStore.getState().project).find((f) => f.name === 'plate')!.id,
    { z_top: 7 },
  )
  const project = useProjectStore.getState().project
  const z = inferLineTopZFromEnclosingFeature(project, openPolylineProfile({ x: 30, y: 40 }, { x: 70, y: 40 }), 10)
  assert(z === 7, `line on top of an add should inherit add z_top, got ${z}`)
}

function testNestedInnermostContainerWins(): void {
  resetStore()
  // outer add (z_top=6) enclosing a pocket (z_bottom=2). The line is inside
  // both; the pocket is smaller, so its floor wins over the add's top.
  setupPocket(2)
  const project = useProjectStore.getState().project
  const z = inferLineTopZFromEnclosingFeature(project, openPolylineProfile({ x: 30, y: 40 }, { x: 70, y: 40 }), 10)
  assert(z === 2, `innermost container (pocket floor) should win over outer add top, got ${z}`)
}

function testNestedAddInsideSubtractInheritsAddTop(): void {
  resetStore()
  // A subtract pocket (z_bottom=2) with an add island (z_top=4) inside it.
  // A line on the island is inside both; the island is smaller, so its
  // top (z_top=4) wins.
  useProjectStore.getState().addRectFeature('outer', 0, 0, 100, 100, 6)
  useProjectStore.getState().addRectFeature('pocket', 10, 10, 80, 80, 6)
  const pocket = resolvedProjectFeatures(useProjectStore.getState().project).find((f) => f.name === 'pocket')!
  useProjectStore.getState().updateFeature(pocket.id, { z_bottom: 2 })
  // Island add inside the pocket.
  useProjectStore.getState().addRectFeature('island', 40, 40, 20, 20, 4)
  const island = resolvedProjectFeatures(useProjectStore.getState().project).find((f) => f.name === 'island')!
  assert(island.operation === 'add', 'island inside a subtract should default to add')
  const project = useProjectStore.getState().project
  const z = inferLineTopZFromEnclosingFeature(project, openPolylineProfile({ x: 45, y: 50 }, { x: 55, y: 50 }), 10)
  assert(z === 4, `line on island inside pocket should inherit island z_top, got ${z}`)
}

function testDegenerateProfileOutsideSolidsReturnsDefault(): void {
  resetStore()
  setupPocket(2)
  const project = useProjectStore.getState().project
  // A profile whose only flattened point sits outside every solid returns
  // the default. (The helper is never called with < 2 points in practice —
  // callers guard on points.length < 2 — but the degenerate path is still
  // defined: a point outside all solids inherits nothing.)
  const z = inferLineTopZFromEnclosingFeature(project, { start: { x: 500, y: 500 }, segments: [], closed: false }, 10)
  assert(z === 10, `degenerate profile outside all solids should return default, got ${z}`)
}

// ── Integration tests through the store wiring ───────────────────────

function testClosedLineViaAddRectFeatureInheritsPocketFloor(): void {
  resetStore()
  setupPocket(2)
  useProjectStore.getState().setCreationTarget('line')
  useProjectStore.getState().addRectFeature('lineRect', 30, 30, 20, 20, 10)
  const z = featureZTop('lineRect')
  assert(z === 2, `closed line rect inside pocket should inherit floor, got ${z}`)
}

function testOpenPolylineViaCompletePendingOpenPathInheritsPocketFloor(): void {
  resetStore()
  setupPocket(2)
  useProjectStore.getState().setCreationTarget('line')
  useProjectStore.getState().startAddPolygonPlacement()
  useProjectStore.getState().addPendingPolygonPoint({ x: 30, y: 50 })
  useProjectStore.getState().addPendingPolygonPoint({ x: 70, y: 50 })
  useProjectStore.getState().completePendingOpenPath()
  const line = resolvedProjectFeatures(useProjectStore.getState().project).find(
    (f) => f.operation === 'line' && f.sketch.profile.closed === false,
  )
  assert(line !== undefined, 'an open polyline line feature should have been created')
  const z = line!.z_top
  assert(typeof z === 'number' && z === 2, `open polyline inside pocket should inherit floor (z_top=2), got ${z}`)
}

function testOpenCompositeViaCompletePendingOpenCompositeInheritsPocketFloor(): void {
  resetStore()
  setupPocket(2)
  useProjectStore.getState().setCreationTarget('line')
  useProjectStore.setState({
    pendingAdd: {
      shape: 'composite',
      start: { x: 30, y: 50 },
      lastPoint: { x: 30, y: 50 },
      segments: [{ type: 'line', to: { x: 70, y: 50 } }],
      currentMode: 'line',
      pendingArcEnd: null,
      closed: false,
      session: 1,
    },
  })
  useProjectStore.getState().completePendingOpenComposite()
  const line = resolvedProjectFeatures(useProjectStore.getState().project).find(
    (f) => f.operation === 'line' && f.kind === 'composite',
  )
  assert(line !== undefined, 'an open composite line feature should have been created')
  const z = line!.z_top
  assert(typeof z === 'number' && z === 2, `open composite inside pocket should inherit floor (z_top=2), got ${z}`)
}

function testConstructionOpenPathKeepsDefault(): void {
  resetStore()
  setupPocket(2)
  useProjectStore.getState().setCreationTarget('construction')
  useProjectStore.getState().startAddPolygonPlacement()
  useProjectStore.getState().addPendingPolygonPoint({ x: 30, y: 50 })
  useProjectStore.getState().addPendingPolygonPoint({ x: 70, y: 50 })
  useProjectStore.getState().completePendingOpenPath()
  const construction = resolvedProjectFeatures(useProjectStore.getState().project).find(
    (f) => f.operation === 'construction',
  )
  assert(construction !== undefined, 'a construction open path should have been created')
  const stockThickness = useProjectStore.getState().project.stock.thickness
  const expectedDefault = Math.min(stockThickness, 10)
  const z = construction!.z_top
  assert(
    typeof z === 'number' && z === expectedDefault,
    `construction path should keep stock-derived default (${expectedDefault}), got ${z}`,
  )
}

function testLineOutsidePocketKeepsDefault(): void {
  resetStore()
  setupPocket(2)
  useProjectStore.getState().setCreationTarget('line')
  // buildShapeFeature uses the depth argument verbatim as the default when
  // no solid encloses the line (the stock-thickness cap is applied by the
  // canvas caller, not by buildShapeFeature). Pass an explicit depth and
  // expect it back unchanged.
  useProjectStore.getState().addRectFeature('farLine', 200, 200, 10, 10, 5)
  const z = featureZTop('farLine')
  assert(z === 5, `line outside any solid should keep the passed depth (5), got ${z}`)
}

const tests = [
  ['line inside subtract inherits pocket floor', testLineInsideSubtractInheritsPocketFloor],
  ['line on pocket wall still inherits', testLineOnPocketWallStillInherits],
  ['line outside any solid keeps default', testLineOutsideAnySolidKeepsDefault],
  ['line inside add inherits add top', testLineInsideAddInheritsAddTop],
  ['nested innermost container wins', testNestedInnermostContainerWins],
  ['nested add inside subtract inherits add top', testNestedAddInsideSubtractInheritsAddTop],
  ['degenerate profile outside solids returns default', testDegenerateProfileOutsideSolidsReturnsDefault],
  ['closed line via addRectFeature inherits pocket floor', testClosedLineViaAddRectFeatureInheritsPocketFloor],
  ['open polyline via completePendingOpenPath inherits pocket floor', testOpenPolylineViaCompletePendingOpenPathInheritsPocketFloor],
  ['open composite via completePendingOpenComposite inherits pocket floor', testOpenCompositeViaCompletePendingOpenCompositeInheritsPocketFloor],
  ['construction open path keeps default', testConstructionOpenPathKeepsDefault],
  ['line outside pocket keeps default', testLineOutsidePocketKeepsDefault],
] as const

let passed = 0
let failed = 0
for (const [name, test] of tests) {
  try {
    test()
    passed += 1
    console.log(`${name}: PASSED`)
  } catch (err) {
    failed += 1
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`${name}: FAILED — ${msg}`)
  }
}
console.log(`\nlineTopZFromEnclosingFeature.test.ts: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
