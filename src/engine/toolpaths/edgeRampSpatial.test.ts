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
 * Spatial regression for issue #1084: a requested OUTSIDE edge-route ramp must
 * stay inside the kerf the level cut removes.
 *
 * The defect was not a missing collision check. The ramp was placed inside the
 * broad collision-free domain outside a part, and on a part standing in uncut
 * stock that domain contains stock beside the profile. The measured repro
 * (10 x 8 x 1 in board, 4 x 3 in part, 1/4 in cutter, 5 degree ramp) put the
 * entry centre 0.3718 in off the cut centreline while the cutter radius is
 * 0.125 in; an arc lead made it 0.6604 in.
 *
 * These tests measure the emitted cutter centre against the ACTUAL cut
 * segments at the level each entry descends to. A point on the cut centreline
 * is the only arrangement whose cutter envelope is exactly the level-cut
 * envelope; any offset becomes stock removed outside the kerf. The old
 * placement fails this by a wide margin, so the assertion is not a tautology.
 *
 * Run with: npx tsx src/engine/toolpaths/edgeRampSpatial.test.ts
 */

import { generateEdgeRouteToolpath } from './edge'
import { isEntryHandoffMove } from './entry'
import { applyEdgeRouteTabs } from './tabs'
import { projectWithFeatures } from '../../test/projectFixtures'
import {
  defaultTool,
  newProject,
  rectProfile,
  type Clamp,
  type Operation,
  type Point,
  type Project,
  type SketchFeature,
  type Tab,
  type Tool,
} from '../../types/project'
import type { ToolpathMove, ToolpathResult } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

const KERF_TOLERANCE = 1e-6

// ── Fixtures ─────────────────────────────────────────────────────────

function flatEndmill(units: 'inch' | 'mm', diameter: number): Tool {
  return { ...defaultTool(units, 1), id: 't1', name: 't1', diameter, defaultStepdown: diameter }
}

function rectFeature(
  id: string,
  box: { x: number; y: number; w: number; h: number },
  operation: SketchFeature['operation'],
  z: { top: number; bottom: number },
): SketchFeature {
  return {
    id, name: id, kind: 'rect', folderId: null,
    sketch: {
      profile: rectProfile(box.x, box.y, box.w, box.h),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation, z_top: z.top, z_bottom: z.bottom, visible: true, locked: false,
  }
}

function boardProject(
  units: 'inch' | 'mm',
  board: { w: number; h: number; thickness: number },
  diameter: number,
  features: SketchFeature[],
  tabs: Tab[] = [],
): Project {
  const base = newProject('ramp-spatial', units)
  const project: Project = {
    ...base,
    stock: {
      ...base.stock,
      profile: rectProfile(0, 0, board.w, board.h),
      thickness: board.thickness,
    },
    tools: [flatEndmill(units, diameter)],
  }
  return { ...projectWithFeatures(project, features), tabs }
}

function outsideOperation(featureIds: string[], overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'op1', name: 'outside rough', kind: 'edge_route_outside', pass: 'rough', enabled: true,
    showToolpath: true, debugToolpath: false, target: { source: 'features', featureIds },
    toolRef: 't1', stepdown: 0.25, stepover: 0.4, feed: 100, plungeFeed: 30, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: false, finishFloor: false, carveDepth: 1, maxCarveDepth: 1,
    cutDirection: 'conventional', machiningOrder: 'level_first',
    entryStrategy: 'ramp', entryRampAngle: 5,
    ...overrides,
  } as Operation
}

// ── Measurement ──────────────────────────────────────────────────────

interface Segment {
  a: Point
  b: Point
}

function distanceToSegment(point: Point, segment: Segment): number {
  const dx = segment.b.x - segment.a.x
  const dy = segment.b.y - segment.a.y
  const lengthSquared = dx * dx + dy * dy
  if (!(lengthSquared > 0)) return Math.hypot(point.x - segment.a.x, point.y - segment.a.y)
  const ratio = Math.max(0, Math.min(
    1,
    ((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / lengthSquared,
  ))
  return Math.hypot(point.x - (segment.a.x + dx * ratio), point.y - (segment.a.y + dy * ratio))
}

function distanceToRect(point: Point, box: { x: number; y: number; w: number; h: number }): number {
  return Math.hypot(
    Math.max(box.x - point.x, 0, point.x - (box.x + box.w)),
    Math.max(box.y - point.y, 0, point.y - (box.y + box.h)),
  )
}

function sampledMovePoints(move: ToolpathMove, perMove = 8): Point[] {
  const points: Point[] = []
  for (let index = 0; index <= perMove; index += 1) {
    const ratio = index / perMove
    points.push({
      x: move.from.x + (move.to.x - move.from.x) * ratio,
      y: move.from.y + (move.to.y - move.from.y) * ratio,
    })
  }
  return points
}

function cutSegmentsAt(moves: ToolpathMove[], z: number): Segment[] {
  return moves
    .filter((move) => move.kind === 'cut'
      && Math.abs(move.from.z - z) <= 1e-9
      && Math.abs(move.to.z - z) <= 1e-9)
    .map((move) => ({ a: move.from, b: move.to }))
}

/**
 * Every ramp lead-in move paired with the Z level it descends to. The level is
 * read from the first cut move that follows the entry run, so the comparison
 * is against the path that entry actually feeds.
 */
function entriesWithTargetZ(moves: ToolpathMove[]): Array<{ move: ToolpathMove; targetZ: number }> {
  const entries: Array<{ move: ToolpathMove; targetZ: number }> = []
  for (let index = 0; index < moves.length; index += 1) {
    if (moves[index].kind !== 'lead_in') continue
    let next = index + 1
    while (next < moves.length && moves[next].kind === 'lead_in') next += 1
    if (next < moves.length && moves[next].kind === 'cut') {
      entries.push({ move: moves[index], targetZ: moves[next].to.z })
    }
  }
  return entries
}

function maxCutterCentreOffCutPath(moves: ToolpathMove[]): number {
  let worst = 0
  for (const { move, targetZ } of entriesWithTargetZ(moves)) {
    const segments = cutSegmentsAt(moves, targetZ)
    assert(segments.length > 0, `level ${targetZ} has a cut path to measure against`)
    for (const point of sampledMovePoints(move)) {
      const nearest = segments.reduce(
        (best, segment) => Math.min(best, distanceToSegment(point, segment)),
        Infinity,
      )
      worst = Math.max(worst, nearest)
    }
  }
  return worst
}

function descentsIntoCut(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((move, index) => {
    if (move.kind !== 'plunge' || move.from.z <= move.to.z) return false
    const next = moves[index + 1]
    return next !== undefined && (next.kind === 'cut' || next.kind === 'lead_in')
  })
}

function warned(result: ToolpathResult, code: string): boolean {
  return result.warnings.some((warning) => warning.code === code)
}

/** The kerf bound plus the entry-shape claims that make it meaningful. */
function assertEntryIsKerfBound(result: ToolpathResult, label: string): void {
  assert(result.moves.length > 0, `${label}: the route emitted moves`)
  const offPath = maxCutterCentreOffCutPath(result.moves)
  assert(offPath <= KERF_TOLERANCE,
    `${label}: the entry centre stays on the level-cut centreline`
    + ` (worst ${offPath.toFixed(6)})`)
  assert(descentsIntoCut(result.moves).length === 0,
    `${label}: no descent reaches cut depth in a single plunge`)
  assert(result.moves.some((move) => isEntryHandoffMove(move)),
    `${label}: the ramp hands off to the cut`)
  assert(countKind(result.moves, 'lead_out') === 0,
    `${label}: the incompatible XY exit lead is omitted too`)
}

function countKind(moves: ToolpathMove[], kind: string): number {
  return moves.filter((move) => move.kind === kind).length
}

// ── The 10 x 8 x 1 inch repro ────────────────────────────────────────

const INCH_BOARD = { w: 10, h: 8, thickness: 1 }
const INCH_PART = { x: 3, y: 2.5, w: 4, h: 3 }

function inchReproProject(tabs: Tab[] = []): Project {
  return boardProject(
    'inch',
    INCH_BOARD,
    0.25,
    [rectFeature('part', INCH_PART, 'add', { top: 1, bottom: 0 })],
    tabs,
  )
}

function testInchBoardRampStaysInsideTheKerf(): void {
  console.log('Testing inch board: outside ramp stays inside the level-cut kerf...')
  const result = generateEdgeRouteToolpath(inchReproProject(), outsideOperation(['part'], {
    stepdown: 0.25,
    xyLeadStrategy: 'arc',
  }))
  assertEntryIsKerfBound(result, 'inch board')

  const cutLevels = [...new Set(result.moves
    .filter((move) => move.kind === 'cut')
    .map((move) => Number(move.to.z.toFixed(6))))].sort((a, b) => b - a)
  assert(JSON.stringify(cutLevels) === JSON.stringify([0.75, 0.5, 0.25, 0]),
    `inch board: every rough depth is cut (${cutLevels.join(', ')})`)
  for (const z of cutLevels) {
    const descending = result.moves.some((move) => move.kind === 'lead_in'
      && Math.abs(move.to.z - z) <= 1e-9
      && move.from.z > move.to.z + 1e-9)
    assert(descending, `inch board: level ${z} is reached by a descending ramp`)
  }

  // The arc lead was requested and cannot coexist with a kerf-bound ramp: it is
  // omitted with the existing accurate warning, and never silently ignored.
  assert(warned(result, 'xyLeadNoViablePath'),
    'inch board: the incompatible arc lead is reported as unavailable')
  assert(!warned(result, 'xyLeadNeedsRampedEntry'),
    'inch board: the report is not the stale "needs ramped entry" one')
  assert(!warned(result, 'entryStrategyFallback'),
    'inch board: the actual adjacent cut segment is a valid ramp')
  console.log('inch board ramp containment: PASSED')
}

// ── The same geometry in millimetres ─────────────────────────────────

function testMmBoardRampStaysInsideTheKerf(): void {
  console.log('Testing mm board: the same kerf bound survives the unit transform...')
  const scale = 25.4
  const project = boardProject(
    'mm',
    { w: INCH_BOARD.w * scale, h: INCH_BOARD.h * scale, thickness: INCH_BOARD.thickness * scale },
    6.35,
    [rectFeature('part', {
      x: INCH_PART.x * scale,
      y: INCH_PART.y * scale,
      w: INCH_PART.w * scale,
      h: INCH_PART.h * scale,
    }, 'add', { top: 25.4, bottom: 0 })],
  )
  const result = generateEdgeRouteToolpath(project, outsideOperation(['part'], {
    stepdown: 6.35,
    feed: 2540,
    plungeFeed: 762,
    xyLeadStrategy: 'arc',
  }))
  assertEntryIsKerfBound(result, 'mm board')
  assert(warned(result, 'xyLeadNoViablePath'), 'mm board: the arc lead is omitted and reported')
  assert(!warned(result, 'entryStrategyFallback'), 'mm board: the ramp still fits the cut segment')
  console.log('mm board ramp containment: PASSED')
}

// ── Tabs ─────────────────────────────────────────────────────────────

function testATabPushesTheRampToTheOtherActualSegment(): void {
  console.log('Testing a tab blocks the forward segment and the ramp uses the other one...')
  // The part's outside cut starts at (7.125, 5.625) and runs down its right
  // side. Put a tab on that first segment inside the ramp's 3D cap: below the
  // tab top the forward segment is unavailable, but the closed contour's other
  // adjacent segment (the top side) is real, clear, and still on the kerf.
  const tab: Tab = {
    id: 'tab1', name: 'tab1',
    x: 7.125 - 0.25, y: 5.0 - 0.25, w: 0.5, h: 0.5,
    z_top: 0.5, z_bottom: 0, visible: true, shape: 'rect',
  }
  const tabbedProject = inchReproProject([tab])
  const operation = outsideOperation(['part'], { stepdown: 0.25, xyLeadStrategy: 'arc' })
  const result = generateEdgeRouteToolpath(tabbedProject, operation)
  assertEntryIsKerfBound(result, 'tabbed board')
  assert(!warned(result, 'entryStrategyFallback'),
    'tabbed board: the other real adjacent segment is used rather than the broad domain')

  const box = { x: tab.x, y: tab.y, w: tab.w, h: tab.h }
  let worstBite = 0
  for (const { move, targetZ } of entriesWithTargetZ(result.moves)) {
    if (targetZ >= tab.z_top - 1e-9) continue
    // Where the tab is standing, only the other adjacent segment is available.
    assert(Math.abs(move.from.y - 5.625) <= 1e-6 && Math.abs(move.to.y - 5.625) <= 1e-6,
      `tabbed board: level ${targetZ} ramps on the clear top-side segment`)
    for (const point of sampledMovePoints(move)) {
      worstBite = Math.max(worstBite, Math.max(0, 0.125 - distanceToRect(point, box)))
    }
  }
  assert(worstBite <= KERF_TOLERANCE,
    `tabbed board: the entry never bites the tab below its top (${worstBite.toFixed(6)} in)`)

  // The ramp was generated before the tab pass; this proves the FINAL
  // `applyTabsToEdgeRoute` actually ran on the on-path stream below the tab
  // top, rather than the tab being honoured only by the entry placement.
  const untabbed = generateEdgeRouteToolpath(
    inchReproProject(),
    operation,
  )
  const tabbed = applyEdgeRouteTabs(tabbedProject, operation, result)
  const verticalSignature = (moves: ToolpathMove[]): string => JSON.stringify(
    moves.map((move) => [move.kind, Number(move.from.z.toFixed(6)), Number(move.to.z.toFixed(6))]),
  )
  assert(verticalSignature(tabbed.moves) !== verticalSignature(untabbed.moves),
    'tabbed board: the final tab pass lifted/split moves below the tab top')
  assert(!warned(tabbed, 'tabsBlockFinalDepth'),
    'tabbed board: the tab interrupts the final pass rather than replacing it')
  // The tab pass rebuilds moves, so identity-based entry markers do not survive;
  // the geometric claims still do.
  assert(maxCutterCentreOffCutPath(tabbed.moves) <= KERF_TOLERANCE,
    'tabbed board: the final stream still keeps the entry on the kerb')
  assert(descentsIntoCut(tabbed.moves).length === 0,
    'tabbed board: no level falls back to a single plunge after tabbing')
  console.log('tabbed ramp segment choice: PASSED')
}

// ── Combined targets and open region fragments ───────────────────────

function testCombinedTargetsAndOpenFragmentsStayKerfBound(): void {
  console.log('Testing combined targets and region-clipped open fragments...')
  const combined = boardProject('inch', INCH_BOARD, 0.25, [
    rectFeature('a', { x: 1, y: 1, w: 2, h: 2 }, 'add', { top: 1, bottom: 0 }),
    rectFeature('b', { x: 6, y: 4, w: 2, h: 2 }, 'add', { top: 1, bottom: 0 }),
  ])
  const combinedResult = generateEdgeRouteToolpath(
    combined,
    outsideOperation(['a', 'b'], { stepdown: 0.25, xyLeadStrategy: 'arc' }),
  )
  assertEntryIsKerfBound(combinedResult, 'combined targets')
  assert(!warned(combinedResult, 'entryStrategyFallback'),
    'combined targets: every fragment enters on a real cut segment')

  // A region mask splits the outside route into OPEN spans. Each one may only
  // use its valid forward segment, and the handoff still has to be on it.
  const masked = boardProject('inch', INCH_BOARD, 0.25, [
    rectFeature('part', INCH_PART, 'add', { top: 1, bottom: 0 }),
    {
      ...rectFeature('mask', { x: 4.5, y: 0, w: 1, h: 8 }, 'region', { top: 1, bottom: 0 }),
      regionMaskMode: 'exclude',
    } as SketchFeature,
  ])
  const maskedResult = generateEdgeRouteToolpath(
    masked,
    outsideOperation(['part', 'mask'], { stepdown: 0.25, xyLeadStrategy: 'arc' }),
  )
  assertEntryIsKerfBound(maskedResult, 'open region fragments')
  assert(maskedResult.moves.some((move) => move.kind === 'cut'
    && Math.abs(move.from.x - 4.5) < 1e-6), 'the mask really does open the route')
  assert(!warned(maskedResult, 'entryStrategyFallback'),
    'open fragments: the forward cut segment is a valid ramp')

  // A clamp standing across the wall path splits the lower levels into open
  // fragments through the obstacle mask. Those fragments get the same
  // per-fragment cut-path constraint, not a return to the broad domain.
  const clamp: Clamp = {
    id: 'c1', name: 'c1', type: 'step_clamp',
    x: 7.1, y: 3, w: 0.5, h: 2, height: 0.1, visible: true,
  }
  const clamped: Project = {
    ...boardProject('inch', INCH_BOARD, 0.25, [
      rectFeature('part', INCH_PART, 'add', { top: 1, bottom: 0 }),
    ]),
    clamps: [clamp],
  }
  const clampedResult = generateEdgeRouteToolpath(
    clamped,
    outsideOperation(['part'], { stepdown: 0.25, xyLeadStrategy: 'arc' }),
  )
  assertEntryIsKerfBound(clampedResult, 'clamp fragments')
  const lowerRightSpans = clampedResult.moves.filter((move) => move.kind === 'cut'
    && move.to.z <= 0.25 + 1e-9
    && Math.abs(move.from.x - 7.125) <= 1e-6
    && Math.abs(move.to.x - 7.125) <= 1e-6)
  assert(lowerRightSpans.length >= 2,
    'the clamp really does split the lower levels into separate right-side spans')
  assert(!warned(clampedResult, 'entryStrategyFallback'),
    'clamp fragments: the remaining cut segment is a valid ramp')
  console.log('combined targets and open fragments: PASSED')
}

try {
  testInchBoardRampStaysInsideTheKerf()
  testMmBoardRampStaysInsideTheKerf()
  testATabPushesTheRampToTheOtherActualSegment()
  testCombinedTargetsAndOpenFragmentsStayKerfBound()
  console.log('\nAll outside-ramp spatial tests PASSED.')
} catch (error) {
  console.error(error)
  throw error
}
