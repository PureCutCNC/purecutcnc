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
 * Tangent-arc leads on EDGE ROUTES (issue #695): when they are declined, and
 * the geometry behind them.
 *
 * An edge route looks like the case that needs this feature most — a finish
 * route cuts the whole depth in one pass, so a witness line runs the full
 * height of the wall. It is instead the case that cannot afford it ALONE. A
 * rough edge route clears a channel of exactly `2r`, the finish tool's own
 * diameter, so there is no radial room for the finish tool to step sideways
 * and stay in cut air: staging a lead off the wall moves the descent into
 * virgin stock and turns a sliver-engagement plunge into a full-width one.
 * `descentCanAffordALead` in `edge.ts` carries the measurement, and since #708
 * it answers by asking whether the descent at the staging point is RAMPED — a
 * helix or ramp makes the axial bite per revolution small, at which point full
 * radial engagement is ordinary slotting rather than a plunge.
 *
 * So these tests come in two halves. The first asserts the decline is clean
 * where it still applies — a plunging entry — warned rather than silent and
 * byte-identical to not asking. The second exercises the planner directly
 * against the same domains the generator builds, which keeps the
 * outside/inside containment proofs stated at the level of the geometry rather
 * than of one emitted program.
 *
 * The other half of the pairing — the entry itself, and the leads that arrive
 * with it — lives in `edgeEntryPolicy.test.ts`.
 *
 * Run with: npx tsx src/engine/toolpaths/xyLeadEdge.test.ts
 */

import { generateEdgeRouteToolpath } from './edge'
import { applyTabsToEdgeRoute } from './tabs'
import { domainOutsideLoops, planXyLeadIn, xyLeadOptions } from './xyLead'
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
import type { ToolpathMove } from './types'
import type { Point } from '../../types/project'

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

const LEAD_KINDS = new Set(['lead_in', 'lead_out'])

function countKind(moves: ToolpathMove[], kind: string): number {
  return moves.filter((move) => move.kind === kind).length
}


/**
 * Descents that land on a cut, and how many land on the wall the route cuts.
 * The tool-centre wall path is the profile offset by radius + radial stock.
 */
function descentsOntoWalls(
  moves: ToolpathMove[],
  distanceToWall: (point: Point) => number,
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

const outsideWallDistance = (point: Point): number =>
  Math.hypot(point.x - BOSS_CENTRE.x, point.y - BOSS_CENTRE.y) - (BOSS_RADIUS + TOOL_RADIUS)

const insideWallDistance = (point: Point): number => Math.min(
  point.x - (HOLE.x + TOOL_RADIUS),
  HOLE.x + HOLE.w - TOOL_RADIUS - point.x,
  point.y - (HOLE.y + TOOL_RADIUS),
  HOLE.y + HOLE.h - TOOL_RADIUS - point.y,
)

// ── Tests: the decline ───────────────────────────────────────────────

function testEdgeRoutesDeclineUntilTheDescentIsRamped() {
  console.log('Testing a plunging edge route declines the lead, and says why...')
  const project = edgeProject()
  // Every operation here leaves `entryStrategy` unset, i.e. a plunge. Ask for a
  // helix instead and the lead arrives; `edgeEntryPolicy.test.ts` pins that.

  for (const [label, operation, distance] of [
    ['outside finish', outsideOperation(), outsideWallDistance],
    ['inside finish', insideOperation(), insideWallDistance],
    ['outside rough at zero stock', outsideOperation({ pass: 'rough', stepdown: 2 }), outsideWallDistance],
  ] as const) {
    const asked = generateEdgeRouteToolpath(project, { ...operation, xyLeadStrategy: 'arc' })
    const legacy = generateEdgeRouteToolpath(project, operation)

    assert(countKind(asked.moves, 'lead_in') === 0 && countKind(asked.moves, 'lead_out') === 0,
      `${label}: no lead is emitted`)
    assert(asked.warnings.some((warning) => warning.code === 'xyLeadNeedsRampedEntry'),
      `${label}: and the request is declined out loud, not dropped`)
    assert(JSON.stringify(asked.moves) === JSON.stringify(legacy.moves),
      `${label}: the program is byte-identical to not asking`)
    // The defect #695 exists for is still present on a PLUNGING route, and
    // saying so keeps the decline honest: a lead here would trade a witness
    // line for a full-width full-depth plunge, so the route keeps the line
    // until the entry can carry it.
    assert(descentsOntoWalls(asked.moves, distance).onWall > 0,
      `${label}: a plunging descent still lands on the wall`)
  }
  console.log('edge routes decline with a warning: PASSED')
}

function testStockLeftIsDeclinedSilently() {
  console.log('Testing radial stock is still a silent gate...')
  const project = edgeProject()
  const rough = outsideOperation({ pass: 'rough', stockToLeaveRadial: 0.5 })
  const asked = generateEdgeRouteToolpath(project, { ...rough, xyLeadStrategy: 'arc' })

  // Stock left means a finish route comes back and cuts the wall again, so the
  // mark is machined away. That pass never wanted a lead, so it is not told it
  // could not have one — unlike the ramped-entry decline above.
  assert(!asked.warnings.some((warning) => warning.code === 'xyLeadNeedsRampedEntry'),
    'a pass that leaves stock is not warned about a lead it never needed')
  assert(JSON.stringify(asked.moves)
    === JSON.stringify(generateEdgeRouteToolpath(project, rough).moves),
    'and is byte-identical to not asking')
  console.log('stock-left gate stays silent: PASSED')
}

function testTrochoidalRoughingHasNoDescentToMove() {
  console.log('Testing trochoidal roughing is left alone...')
  const trochoidal = outsideOperation({
    pass: 'rough', edgeStrategy: 'trochoidal', entryStrategy: 'helix',
    trochoidalCutWidth: TOOL_DIAMETER * 1.5, trochoidalAdvance: 0.3,
  })
  const result = generateEdgeRouteToolpath(edgeProject(), trochoidal)

  // Measured, not assumed: a trochoidal route reaches the wall by widening
  // orbits from its own helical entry, so there is no descent onto the wall for
  // a lead to move, and no warning is owed either.
  assert(descentsOntoWalls(result.moves, outsideWallDistance).total === 0,
    'trochoidal roughing never descends straight into a cut')
  const asked = generateEdgeRouteToolpath(edgeProject(), { ...trochoidal, xyLeadStrategy: 'arc' })
  assert(!asked.warnings.some((warning) => warning.code === 'xyLeadNeedsRampedEntry'),
    'so it is not told it was declined')
  assert(JSON.stringify(asked.moves) === JSON.stringify(result.moves),
    'and asking for a lead is byte-identical to not asking')
  console.log('trochoidal is left alone: PASSED')
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
    // Kept, not stripped: the request outlives the deferral, so a project saved
    // today starts leading the moment #708 lands, with no migration.
    assert(normalized.xyLeadStrategy === 'arc', `${kind} keeps its lead request through a save/load`)
  }
  console.log('normalization keeps the field: PASSED')
}

// ── Tests: the geometry the generator builds on ──────────────────────

/** The tool-centre wall contour an outside route follows around the boss. */
function outsideWallContour(): Point[] {
  const radius = BOSS_RADIUS + TOOL_RADIUS
  const ring: Point[] = []
  for (let step = 0; step < 180; step += 1) {
    const angle = (step / 180) * 2 * Math.PI
    ring.push({
      x: BOSS_CENTRE.x + radius * Math.cos(angle),
      y: BOSS_CENTRE.y + radius * Math.sin(angle),
    })
  }
  return ring
}

/** The keep-out an outside route builds: the part grown to tool-centre distance. */
function outsideKeepOut(): Point[][] {
  return [outsideWallContour()]
}

function testOutsideDomainKeepsTheArcOffThePart() {
  console.log('Testing the outside domain keeps the arc off the part...')
  const options = xyLeadOptions(
    outsideOperation({ xyLeadStrategy: 'arc' }),
    TOOL_DIAMETER,
    domainOutsideLoops(outsideKeepOut(), TOOL_DIAMETER * 3.5),
  )
  assert(options !== undefined, 'the outside domain resolves to options')
  const plan = planXyLeadIn(outsideWallContour(), options, null)
  assert(plan !== null, 'and a lead fits in open air')

  // The whole point of the outside case: the safe side is open air, and the one
  // thing the arc must not do is swing the cutter into the boss.
  let closest = Infinity
  for (const point of plan.points) closest = Math.min(closest, outsideWallDistance(point))
  assert(closest > -1e-6, `every lead point clears the retained boss (closest ${closest.toFixed(6)} mm)`)
  console.log('outside domain containment: PASSED')
}

function testTheDeclineIsMeasuredNotAssumed() {
  console.log('Testing the staging point really is outside any roughing channel...')
  const options = xyLeadOptions(
    outsideOperation({ xyLeadStrategy: 'arc' }),
    TOOL_DIAMETER,
    domainOutsideLoops(outsideKeepOut(), TOOL_DIAMETER * 3.5),
  )
  assert(options !== undefined, 'the outside domain resolves to options')
  const plan = planXyLeadIn(outsideWallContour(), options, null)
  assert(plan !== null, 'a lead is planned')

  // This is the arithmetic behind `descentCanAffordALead`. A rough edge route
  // sweeps a channel exactly `2r` wide, so a staging point more than a tool
  // DIAMETER outboard of the wall path cannot sit inside it at any sane stock
  // allowance — the plunge there is into virgin stock, full width, full depth,
  // which is why the lead needs a ramped entry under it rather than a plunge.
  const offset = outsideWallDistance(plan.staging)
  assert(offset > TOOL_DIAMETER,
    `the staging point is ${offset.toFixed(2)} mm outboard of the wall path, beyond a ${TOOL_DIAMETER} mm channel`)
  console.log('the decline is measured: PASSED')
}

function testInsideDomainKeepsTheArcInTheCavity() {
  console.log('Testing the inside domain keeps the arc in the cavity...')
  // The tool-centre region an inside route is inset to.
  const region = {
    outer: [
      { x: HOLE.x + TOOL_RADIUS, y: HOLE.y + TOOL_RADIUS },
      { x: HOLE.x + HOLE.w - TOOL_RADIUS, y: HOLE.y + TOOL_RADIUS },
      { x: HOLE.x + HOLE.w - TOOL_RADIUS, y: HOLE.y + HOLE.h - TOOL_RADIUS },
      { x: HOLE.x + TOOL_RADIUS, y: HOLE.y + HOLE.h - TOOL_RADIUS },
    ],
    islands: [],
  }
  const options = xyLeadOptions(insideOperation({ xyLeadStrategy: 'arc' }), TOOL_DIAMETER, [region])
  assert(options !== undefined, 'the cavity resolves to options')
  const plan = planXyLeadIn(region.outer, options, null)
  assert(plan !== null, 'and a lead fits inside it')

  let closest = Infinity
  for (const point of plan.points) closest = Math.min(closest, insideWallDistance(point))
  assert(closest > -1e-6, `every lead point stays in the cavity (closest ${closest.toFixed(6)} mm)`)
  // A four-corner contour has no vertex you can arrive at tangentially, so the
  // join has to slide along an edge — and now also away from the corners.
  const join = plan.points[plan.points.length - 1]
  const toCorner = Math.min(...region.outer.map((c) => Math.hypot(join.x - c.x, join.y - c.y)))
  assert(toCorner > TOOL_RADIUS, `the join clears the corners (${toCorner.toFixed(2)} mm)`)
  console.log('inside domain containment: PASSED')
}

// ── Tests: the tab pass, which the entry policy relies on ────────────

function testTabPassLeavesLeadMovesAlone() {
  console.log('Testing the tab pass does not mangle a lead...')
  const tab: Tab = {
    id: 'tab1', name: 'tab1', x: 52, y: 36, w: 8, h: 8, z_top: -4, shape: 'rect',
  } as Tab
  const project = edgeProject([tab])
  const operation = outsideOperation()
  const routed = generateEdgeRouteToolpath(project, operation)

  // A plunging route emits no leads, so splice a pair in over the tab and run
  // the tab pass on that. This is the property both the lead and the entry
  // policy depend on: the pass only lifts vertical moves and splits `cut`
  // moves, so anything planned through a tab is driven into with nothing
  // downstream to correct it — which is why both domains subtract tab
  // footprints per level.
  const overTab = { x: tab.x + tab.w / 2, y: tab.y + tab.h / 2, z: -6 }
  const seeded = {
    ...routed,
    moves: [
      ...routed.moves,
      { kind: 'lead_in' as const, from: { x: overTab.x - 2, y: overTab.y - 2, z: -6 }, to: overTab },
      { kind: 'lead_out' as const, from: overTab, to: { x: overTab.x + 2, y: overTab.y + 2, z: -6 } },
    ],
  }
  const tabbed = applyTabsToEdgeRoute(project, operation, seeded)

  const before = seeded.moves.filter((move) => LEAD_KINDS.has(move.kind))
  const after = tabbed.moves.filter((move) => LEAD_KINDS.has(move.kind))
  assert(before.length === 2, 'the fixture has a lead pair for the tab pass to leave alone')
  assert(JSON.stringify(before) === JSON.stringify(after),
    'both lead moves survive the tab pass unchanged, tab or no tab')
  console.log('tab pass leaves leads alone: PASSED')
}

function testTabsDoNotFragmentAProfileIntoSeparateEntries() {
  console.log('Testing tabs do not turn one profile into many entries...')
  const tabs: Tab[] = [
    { id: 'tab1', name: 'tab1', x: 52, y: 36, w: 8, h: 8, z_top: -4, shape: 'rect' } as Tab,
    { id: 'tab2', name: 'tab2', x: 20, y: 36, w: 8, h: 8, z_top: -4, shape: 'rect' } as Tab,
    { id: 'tab3', name: 'tab3', x: 36, y: 56, w: 8, h: 8, z_top: -4, shape: 'rect' } as Tab,
  ]
  const project = edgeProject(tabs)
  const operation = outsideOperation({ pass: 'rough', stepdown: 2 })
  const plain = generateEdgeRouteToolpath(project, operation)
  const tabbed = applyTabsToEdgeRoute(project, operation, plain)

  // "One lead per profile per level" holds by construction rather than by code:
  // the tab pass rides the cutter over each tab while it stays engaged, so a
  // tabbed profile is one continuous engagement with one entry. If it ever
  // became a retract and re-plunge per span, every span start would be a fresh
  // descent onto the wall — and this count is what would notice.
  const descents = (moves: ToolpathMove[]) =>
    moves.filter((move, index) => move.kind === 'plunge' && move.from.z > move.to.z
      && moves[index + 1]?.kind === 'cut').length
  assert(descents(tabbed.moves) === descents(plain.moves),
    `tabs add no descents (${descents(plain.moves)} without, ${descents(tabbed.moves)} with)`)
  console.log('tabs do not fragment the profile: PASSED')
}

try {
  testEdgeRoutesDeclineUntilTheDescentIsRamped()
  testStockLeftIsDeclinedSilently()
  testTrochoidalRoughingHasNoDescentToMove()
  testAbsentAndNoneAreByteIdentical()
  testNormalizationKeepsTheFieldOnEdgeRoutes()
  testOutsideDomainKeepsTheArcOffThePart()
  testTheDeclineIsMeasuredNotAssumed()
  testInsideDomainKeepsTheArcInTheCavity()
  testTabPassLeavesLeadMovesAlone()
  testTabsDoNotFragmentAProfileIntoSeparateEntries()
  console.log('\nAll xyLead edge-route tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
