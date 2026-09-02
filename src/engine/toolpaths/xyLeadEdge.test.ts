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
 * Tangent-arc leads on EDGE ROUTES (issue #695).
 *
 * An edge route is the case with the least margin for the mark this feature
 * exists to prevent: a finish route cuts the whole depth in one pass, so the
 * witness line a descent leaves runs the full height of the wall. It is also
 * the case where the safe side flips — an outside route has no cavity to sweep
 * into, only open air bounded by what must survive — so the domain is built
 * the other way up and needs its own containment proof.
 *
 * Run with: npx tsx src/engine/toolpaths/xyLeadEdge.test.ts
 */

import { generateEdgeRouteToolpath } from './edge'
import { applyTabsToEdgeRoute } from './tabs'
import { projectWithFeatures } from '../../test/projectFixtures'
import { normalizeOperation } from '../../store/helpers/normalize'
import {
  circleProfile,
  defaultTool,
  newProject,
  rectProfile,
  type Operation,
  type OperationKind,
  type Project,
  type SketchFeature,
  type Tab,
  type Tool,
} from '../../types/project'
import type { ToolpathMove, ToolpathPoint } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

const TOOL_DIAMETER = 6
const TOOL_RADIUS = TOOL_DIAMETER / 2

// ── Fixture ──────────────────────────────────────────────────────────
//
// A round boss to route around on the outside and a rectangular hole to route
// around on the inside. Round and rectangular on purpose: the outside case
// exercises the arc against a convex curve, the inside case against corners,
// which is where a contour has no tangent departure of its own.

const BOSS_CENTRE = { x: 40, y: 40 }
const BOSS_RADIUS = 15
const HOLE = { x: 10, y: 10, w: 30, h: 20 }

function makeFlatEndmill(): Tool {
  return { ...defaultTool('mm', 1), id: 't1', name: 't1', diameter: TOOL_DIAMETER, defaultStepdown: 2 }
}

function makeBoss(): SketchFeature {
  return {
    id: 'b1', name: 'boss', kind: 'circle', folderId: null,
    sketch: {
      profile: circleProfile(BOSS_CENTRE.x, BOSS_CENTRE.y, BOSS_RADIUS),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation: 'add', z_top: 0, z_bottom: -6, visible: true, locked: false,
  }
}

function makeHole(): SketchFeature {
  return {
    id: 'h1', name: 'hole', kind: 'rect', folderId: null,
    sketch: {
      profile: rectProfile(HOLE.x, HOLE.y, HOLE.w, HOLE.h),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation: 'subtract', z_top: 0, z_bottom: -6, visible: true, locked: false,
  }
}

function edgeProject(tabs: Tab[] = []): Project {
  const project = projectWithFeatures(
    { ...newProject('xy-lead-edge', 'mm'), tools: [makeFlatEndmill()] },
    [makeBoss(), makeHole()],
  )
  return { ...project, tabs }
}

function edgeOperation(kind: OperationKind, featureIds: string[], overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'op1', name: 'op', kind, pass: 'finish', enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'features', featureIds }, toolRef: 't1',
    stepdown: 2, stepover: 0.4, feed: 800, plungeFeed: 300, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: false, finishFloor: false, carveDepth: 6, maxCarveDepth: 6,
    cutDirection: 'conventional', machiningOrder: 'level_first',
    ...overrides,
  } as Operation
}

const outsideOperation = (o: Partial<Operation> = {}): Operation =>
  edgeOperation('edge_route_outside', ['b1'], o)
const insideOperation = (o: Partial<Operation> = {}): Operation =>
  edgeOperation('edge_route_inside', ['h1'], o)

function countKind(moves: ToolpathMove[], kind: string): number {
  return moves.filter((move) => move.kind === kind).length
}

function leadPoints(moves: ToolpathMove[]): ToolpathPoint[] {
  return moves
    .filter((move) => move.kind === 'lead_in' || move.kind === 'lead_out')
    .flatMap((move) => [move.from, move.to])
}

/**
 * Descents that land on a cut, and how many land on the wall the route cuts.
 * The tool-centre wall path is the profile offset by radius + radial stock.
 */
function descentsOntoWalls(
  moves: ToolpathMove[],
  distanceToWall: (point: ToolpathPoint) => number,
): { total: number; onWall: number } {
  let total = 0
  let onWall = 0
  moves.forEach((move, index) => {
    if (move.kind !== 'plunge' || move.from.z <= move.to.z) return
    const next = moves[index + 1]
    if (!next || next.kind !== 'cut') return
    if (Math.abs(next.from.x - move.to.x) > 1e-9 || Math.abs(next.from.y - move.to.y) > 1e-9) return
    total += 1
    if (Math.abs(distanceToWall(move.to)) < 0.05) onWall += 1
  })
  return { total, onWall }
}

const outsideWallDistance = (point: ToolpathPoint): number =>
  Math.hypot(point.x - BOSS_CENTRE.x, point.y - BOSS_CENTRE.y) - (BOSS_RADIUS + TOOL_RADIUS)

const insideWallDistance = (point: ToolpathPoint): number => Math.min(
  point.x - (HOLE.x + TOOL_RADIUS),
  HOLE.x + HOLE.w - TOOL_RADIUS - point.x,
  point.y - (HOLE.y + TOOL_RADIUS),
  HOLE.y + HOLE.h - TOOL_RADIUS - point.y,
)

// ── Tests ────────────────────────────────────────────────────────────

function testFinishRoutesNoLongerDescendOntoTheirWall() {
  console.log('Testing neither finish route lands on the wall it cuts...')

  for (const [label, operation, distance] of [
    ['outside', outsideOperation(), outsideWallDistance],
    ['inside', insideOperation(), insideWallDistance],
  ] as const) {
    const project = edgeProject()
    const legacy = generateEdgeRouteToolpath(project, operation)
    assert(descentsOntoWalls(legacy.moves, distance).onWall > 0,
      `the ${label} fixture reproduces the defect`)

    const led = generateEdgeRouteToolpath(project, { ...operation, xyLeadStrategy: 'arc' })
    assert(descentsOntoWalls(led.moves, distance).onWall === 0,
      `and with the lead the ${label} route lands nowhere near it`)
    assert(countKind(led.moves, 'lead_in') > 0 && countKind(led.moves, 'lead_out') > 0,
      `the ${label} route is both entered and left along an arc`)
    assert(led.warnings.length === 0, `without falling back (${label})`)
  }
  console.log('finish routes lead onto their wall: PASSED')
}

function testOutsideLeadStaysOutsideTheRetainedPart() {
  console.log('Testing the outside lead never enters the part...')
  const led = generateEdgeRouteToolpath(edgeProject(), outsideOperation({ xyLeadStrategy: 'arc' }))

  // The whole point of the outside case: the safe side is open air, and the
  // one thing the arc must not do is swing the cutter into the boss. Tangency
  // is zero, so the tolerance is float dust plus the polygon approximation of
  // the round offset, not a margin.
  let closest = Infinity
  for (const point of leadPoints(led.moves)) {
    closest = Math.min(closest, outsideWallDistance(point))
  }
  assert(Number.isFinite(closest), 'the fixture produced a lead to measure')
  assert(closest > -1e-3, `every lead point clears the retained boss (closest ${closest.toFixed(6)} mm)`)
  console.log('outside lead stays outside: PASSED')
}

function testInsideLeadStaysInsideTheCavity() {
  console.log('Testing the inside lead never leaves the cavity...')
  const led = generateEdgeRouteToolpath(edgeProject(), insideOperation({ xyLeadStrategy: 'arc' }))

  let closest = Infinity
  for (const point of leadPoints(led.moves)) {
    closest = Math.min(closest, insideWallDistance(point))
  }
  assert(Number.isFinite(closest), 'the fixture produced a lead to measure')
  assert(closest > -1e-6, `every lead point stays in the cavity (closest ${closest.toFixed(6)} mm)`)
  console.log('inside lead stays inside: PASSED')
}

function testEveryLevelOfAStepdownRouteIsLed() {
  console.log('Testing a stepped roughing route leads at every level...')
  const operation = outsideOperation({ pass: 'rough', stepdown: 2, xyLeadStrategy: 'arc' })
  const led = generateEdgeRouteToolpath(edgeProject(), operation)

  // Three levels over a 6 mm span. A lead emitted once for the operation would
  // leave the second and third descents still landing on the wall.
  const levels = new Set(led.moves.filter((m) => m.kind === 'lead_in').map((m) => m.to.z.toFixed(6)))
  assert(levels.size === 3, `each of the three levels is entered along an arc (saw ${levels.size})`)
  assert(descentsOntoWalls(led.moves, outsideWallDistance).onWall === 0, 'and none of them lands on the wall')
  console.log('every level is led: PASSED')
}

function testRadialStockGatesTheRoughingRoute() {
  console.log('Testing radial stock gates the roughing route...')
  const project = edgeProject()
  const rough = outsideOperation({ pass: 'rough', stockToLeaveRadial: 0.5 })

  // Stock left means a finish route comes back and cuts the wall again, so the
  // mark is machined away and the lead would be motion spent on nothing.
  const asked = generateEdgeRouteToolpath(project, { ...rough, xyLeadStrategy: 'arc' })
  const legacy = generateEdgeRouteToolpath(project, rough)
  assert(countKind(asked.moves, 'lead_in') === 0, 'stock left: no lead')
  assert(JSON.stringify(asked.moves) === JSON.stringify(legacy.moves),
    'and the program is byte-identical to not asking for one')

  // No stock: this route IS the wall, so it carries the lead.
  const bare = generateEdgeRouteToolpath(project, { ...rough, stockToLeaveRadial: 0, xyLeadStrategy: 'arc' })
  assert(countKind(bare.moves, 'lead_in') > 0, 'no radial stock: the route is the wall, so it is led')
  console.log('radial stock gate: PASSED')
}

function testTrochoidalRoughingHasNoDescentToMove() {
  console.log('Testing trochoidal roughing is left alone...')
  const trochoidal = outsideOperation({
    pass: 'rough', edgeStrategy: 'trochoidal', entryStrategy: 'helix',
    trochoidalCutWidth: TOOL_DIAMETER * 1.5, trochoidalAdvance: 0.3,
  })
  const result = generateEdgeRouteToolpath(edgeProject(), trochoidal)

  // The exclusion is measured, not assumed: a trochoidal route reaches the wall
  // by widening orbits from its own helical entry, so there is no descent onto
  // the wall for a lead to move. Asking for one must therefore change nothing.
  assert(descentsOntoWalls(result.moves, outsideWallDistance).total === 0,
    'trochoidal roughing never descends straight into a cut')
  const asked = generateEdgeRouteToolpath(edgeProject(), { ...trochoidal, xyLeadStrategy: 'arc' })
  assert(JSON.stringify(asked.moves) === JSON.stringify(result.moves),
    'so asking for a lead is byte-identical to not asking')
  console.log('trochoidal is left alone: PASSED')
}

function testLeadAvoidsTheTabItWouldOtherwiseDriveInto() {
  console.log('Testing the lead keeps out of tab footprints...')
  const bare = generateEdgeRouteToolpath(edgeProject(), outsideOperation({ xyLeadStrategy: 'arc' }))
  const join = [...bare.moves].reverse().find((move) => move.kind === 'lead_in')
  assert(join !== undefined, 'the untabbed route has a lead to displace')

  // A tab straddling the wall right where the lead wants to join. The tab pass
  // runs AFTER generation and only lifts vertical moves and splits cuts — it
  // never sees a lead — so a lead planned through a tab drives into it and
  // nothing downstream corrects that.
  const tab: Tab = {
    id: 'tab1', name: 'tab1', x: 36, y: 19, w: 10, h: 8, z_top: -4, shape: 'rect',
  } as Tab
  const tabbed = generateEdgeRouteToolpath(edgeProject([tab]), outsideOperation({ xyLeadStrategy: 'arc' }))
  assert(countKind(tabbed.moves, 'lead_in') > 0, 'the route is still led')

  const clearance = TOOL_RADIUS
  const insideTab = (point: ToolpathPoint): boolean =>
    point.z < tab.z_top - 1e-9
    && point.x >= tab.x - clearance && point.x <= tab.x + tab.w + clearance
    && point.y >= tab.y - clearance && point.y <= tab.y + tab.h + clearance
  assert(!leadPoints(tabbed.moves).some(insideTab), 'and no lead point enters the tab footprint below its top')

  const movedJoin = [...tabbed.moves].reverse().find((move) => move.kind === 'lead_in')
  assert(movedJoin !== undefined, 'the tabbed route still has a join')
  assert(Math.hypot(movedJoin.to.x - join.to.x, movedJoin.to.y - join.to.y) > 1,
    'the join actually moved, so the keep-out is load-bearing rather than vacuous')
  console.log('lead avoids tabs: PASSED')
}

function testTabPassLeavesLeadsAlone() {
  console.log('Testing the tab pass does not mangle a lead...')
  const tab: Tab = {
    id: 'tab1', name: 'tab1', x: 52, y: 36, w: 8, h: 8, z_top: -4, shape: 'rect',
  } as Tab
  const project = edgeProject([tab])
  const operation = outsideOperation({ xyLeadStrategy: 'arc' })
  const led = generateEdgeRouteToolpath(project, operation)
  const tabbed = applyTabsToEdgeRoute(project, operation, led)

  const before = led.moves.filter((move) => move.kind === 'lead_in' || move.kind === 'lead_out')
  const after = tabbed.moves.filter((move) => move.kind === 'lead_in' || move.kind === 'lead_out')
  assert(before.length > 0, 'the fixture has leads for the tab pass to leave alone')
  assert(JSON.stringify(before) === JSON.stringify(after),
    'every lead move survives the tab pass unchanged')
  console.log('tab pass leaves leads alone: PASSED')
}

function testAbsentAndNoneAreByteIdentical() {
  console.log('Testing an operation that did not opt in is untouched...')
  const project = edgeProject()
  for (const operation of [outsideOperation(), insideOperation()]) {
    const absent = generateEdgeRouteToolpath(project, operation)
    const none = generateEdgeRouteToolpath(project, { ...operation, xyLeadStrategy: 'none' })
    assert(JSON.stringify(absent.moves) === JSON.stringify(none.moves),
      `absent and 'none' emit the same program (${operation.kind})`)
    assert(absent.warnings.length === 0 && none.warnings.length === 0, 'and neither warns')
  }
  console.log('opt-out is byte-identical: PASSED')
}

function testNormalizationKeepsTheFieldOnEdgeRoutes() {
  console.log('Testing normalization keeps the field on edge routes...')
  const project = edgeProject()
  for (const kind of ['edge_route_inside', 'edge_route_outside'] as const) {
    const ids = kind === 'edge_route_inside' ? ['h1'] : ['b1']
    const normalized = normalizeOperation(
      edgeOperation(kind, ids, { xyLeadStrategy: 'arc' }), project, 0,
    )
    assert(normalized.xyLeadStrategy === 'arc', `${kind} keeps its lead request through a save/load`)
  }
  console.log('normalization keeps the field: PASSED')
}

try {
  testFinishRoutesNoLongerDescendOntoTheirWall()
  testOutsideLeadStaysOutsideTheRetainedPart()
  testInsideLeadStaysInsideTheCavity()
  testEveryLevelOfAStepdownRouteIsLed()
  testRadialStockGatesTheRoughingRoute()
  testTrochoidalRoughingHasNoDescentToMove()
  testLeadAvoidsTheTabItWouldOtherwiseDriveInto()
  testTabPassLeavesLeadsAlone()
  testAbsentAndNoneAreByteIdentical()
  testNormalizationKeepsTheFieldOnEdgeRoutes()
  console.log('\nAll xyLead edge-route tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
