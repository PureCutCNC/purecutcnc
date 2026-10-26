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
 * Issue #1109: a requested OUTSIDE ramp clips its first blocked contour segment
 * to the clear travel before a tab instead of dropping the whole segment.
 *
 * The reporter's project (`issue-1109-tab-ramp.camj`, reduced from
 * `sm_wall_0.5.2.camj`) cuts a 1/4 in part with three 0.1883 in levels and a 5
 * degree ramp. The first two levels ramp; the third plunged from safe Z because
 * the 0.75 in (3D) run is one straight segment and Tab 6's keep-out crossed it
 * at 0.451 in. Every whole segment before the tab was rejected, so the useful
 * 1.8-diameter prefix was thrown away with it.
 *
 * These tests pin the corrected behaviour from both ends: the real production
 * chain (tabs, optimizer, postprocessor) on the reported project, and focused
 * synthetic geometry for the clip itself — a long straight segment versus its
 * equivalent subdivision, the first exit only, boundary/collinear/tangent and
 * concave cases, inch/mm, the exact one-diameter floor, and a genuinely too
 * short or over-budget run that still falls back with the existing warning.
 *
 * Run with: node --import tsx src/engine/toolpaths/issue1109TabRamp.test.ts
 */

import { readFileSync } from 'node:fs'

import { normalizeProject } from '../../store/helpers/projectFormat'
import type { MachineDefinition } from '../gcode/types'
import { runPostProcessor } from '../gcode/postprocessor'
import type { Point, Project, Tab } from '../../types/project'
import {
  entryBoundarySafety,
  isEntryHandoffMove,
  synthesizeEntry,
  type EntryClearanceRegion,
  type EntryPolicy,
  type EntryRampPath,
} from './entry'
import { normalizeToolForProject } from './geometry'
import { computeOperationToolpath } from './generateOperation'
import type { ToolpathMove, ToolpathResult } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-9): boolean {
  return Math.abs(left - right) <= epsilon
}

const FIXTURE = new URL('../test-fixtures/issue-1109-tab-ramp.camj', import.meta.url)
const KERF_TOLERANCE = 1e-6
const SAFETY_EPSILON = 1e-6

function loadedFixture(): Project {
  return normalizeProject(JSON.parse(readFileSync(FIXTURE, 'utf8')))
}

function outsideOperation(project: Project) {
  const operation = project.operations.find((candidate) => candidate.kind === 'edge_route_outside')
  assert(operation !== undefined, 'the fixture has an outside edge route')
  return operation
}

// ── Move measurement ─────────────────────────────────────────────────

interface Segment {
  a: Point
  b: Point
}

function planar(move: ToolpathMove): number {
  return Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
}

function descending(move: ToolpathMove): boolean {
  return move.kind === 'lead_in' && move.to.z < move.from.z - 1e-9
}

/** Contiguous runs of descending lead-in moves: one entry's descent each. */
function descendingEntryBlocks(moves: ToolpathMove[]): ToolpathMove[][] {
  const blocks: ToolpathMove[][] = []
  let current: ToolpathMove[] = []
  for (const move of moves) {
    if (descending(move)) {
      current.push(move)
      continue
    }
    if (current.length > 0) blocks.push(current)
    current = []
  }
  if (current.length > 0) blocks.push(current)
  return blocks
}

function horizontal(move: ToolpathMove): Point | null {
  const x = move.to.x - move.from.x
  const y = move.to.y - move.from.y
  const length = Math.hypot(x, y)
  return length > 1e-12 ? { x: x / length, y: y / length } : null
}

/** Split one descent into strokes at its true reversals. */
function strokeTravels(block: ToolpathMove[]): number[] {
  const travels: number[] = []
  let travel = 0
  for (let index = 0; index < block.length; index += 1) {
    if (index > 0) {
      const previous = horizontal(block[index - 1])
      const next = horizontal(block[index])
      if (previous && next && previous.x * next.x + previous.y * next.y < -0.99) {
        travels.push(travel)
        travel = 0
      }
    }
    travel += planar(block[index])
  }
  travels.push(travel)
  return travels
}

function sampledPoints(move: ToolpathMove, perMove = 16): Point[] {
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

function distanceToSegment(point: Point, segment: Segment): number {
  const dx = segment.b.x - segment.a.x
  const dy = segment.b.y - segment.a.y
  const lengthSquared = dx * dx + dy * dy
  if (!(lengthSquared > 0)) return Math.hypot(point.x - segment.a.x, point.y - segment.a.y)
  const ratio = Math.max(0, Math.min(
    1,
    ((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / lengthSquared,
  ))
  return Math.hypot(
    point.x - (segment.a.x + dx * ratio),
    point.y - (segment.a.y + dy * ratio),
  )
}

function cutSegmentsAt(moves: ToolpathMove[], z: number): Segment[] {
  return moves
    .filter((move) => move.kind === 'cut'
      && Math.abs(move.from.z - z) <= 1e-9
      && Math.abs(move.to.z - z) <= 1e-9)
    .map((move) => ({ a: move.from, b: move.to }))
}

function distanceToPolyline(point: Point, points: Point[]): number {
  let best = Infinity
  for (let index = 1; index < points.length; index += 1) {
    best = Math.min(best, distanceToSegment(point, { a: points[index - 1], b: points[index] }))
  }
  return best
}

function distanceToRect(point: Point, tab: Tab): number {
  const dx = Math.max(tab.x - point.x, 0, point.x - (tab.x + tab.w))
  const dy = Math.max(tab.y - point.y, 0, point.y - (tab.y + tab.h))
  return Math.hypot(dx, dy)
}

function warningsOf(result: { warnings: Array<{ code: string }> }): string[] {
  return result.warnings.map((warning) => warning.code)
}

function entryMovesIntoCut(moves: ToolpathMove[]): Array<{ move: ToolpathMove; targetZ: number }> {
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

// ── The reported project, through the production chain ───────────────

function postFixture(project: Project, result: ToolpathResult): string {
  const operation = outsideOperation(project)
  const tool = normalizeToolForProject(
    project.tools.find((candidate) => candidate.id === operation.toolRef)!,
    project,
  )
  const definition = project.meta.machineDefinitions.find(
    (candidate: MachineDefinition) => candidate.id === project.meta.selectedMachineId,
  )
  assert(definition !== undefined, 'the fixture names a machine definition')
  return runPostProcessor({
    project,
    operations: [{ operation, tool, toolpath: result }],
    definition,
    options: { emitToolChanges: true, emitCoolant: true },
  }).gcode
}

function testReportedProjectRampsEveryLevelWithoutFallback(): void {
  console.log('Testing the reported project through tabs and the production chain...')
  const project = loadedFixture()
  const operation = outsideOperation(project)
  const envelope = computeOperationToolpath(project, operation, { trace: true })
  assert(envelope !== null, 'the production chain returns a toolpath')
  const result = envelope.result
  const toolDiameter = project.tools.find((tool) => tool.id === operation.toolRef)!.diameter
  const safety = entryBoundarySafety(toolDiameter)

  assert(!warningsOf(result).includes('entryStrategyFallback'),
    'every level, including the final one, finds a useful ramp')
  assert(!result.moves.some((move) => move.kind === 'plunge'
    && move.from.z > move.to.z + 1e-9),
  'the chain never emits a descending plunge into the cut')

  const levels = [0.3616666666666667, 0.17333333333333337, -0.014999999999999902]
  const blocks = descendingEntryBlocks(result.moves)
  const targets = blocks.map((block) => block[block.length - 1].to.z)
  assert(blocks.length === levels.length,
    `one ramp per level, including the final one (got ${blocks.length})`)
  for (const level of levels) {
    assert(targets.some((target) => approx(target, level, 1e-9)),
      `level ${level} is reached by a descending ramp (${targets.join(', ')})`)
  }

  for (const block of blocks) {
    const z = block[block.length - 1].to.z
    if (approx(z, levels[2], 1e-9)) continue
    assert(approx(strokeTravels(block)[0], toolDiameter * 3, 1e-6),
      `level ${z}: the unobstructed run still uses the full 3D cap`)
  }

  const finalBlock = blocks.find((block) => approx(block[block.length - 1].to.z, levels[2], 1e-9))!
  const finalTravel = strokeTravels(finalBlock)[0]
  assert(finalBlock.length > 1,
    `the final entry descends in several moves, not one plunge (got ${finalBlock.length})`)
  assert(finalTravel >= toolDiameter - 1e-6,
    `the final stroke clears the one-diameter useful floor (${finalTravel.toFixed(4)} in)`)
  assert(finalTravel < toolDiameter * 3 - 1e-6,
    `the final stroke is genuinely shortened by the tab (${finalTravel.toFixed(4)} in)`)
  assert(finalTravel <= 0.75 - safety + 1e-6,
    'the clip stops at least the boundary safety margin before the tab keep-out')

  // Independently measured: every descending entry keeps its cutter centre on
  // the level-cut centreline (same kerf) and its swept radius off every tab.
  for (const { move, targetZ } of entryMovesIntoCut(result.moves)) {
    const segments = cutSegmentsAt(result.moves, targetZ)
    assert(segments.length > 0, `level ${targetZ} has a cut path to measure against`)
    for (const point of sampledPoints(move)) {
      const nearest = segments.reduce(
        (best, segment) => Math.min(best, distanceToSegment(point, segment)),
        Infinity,
      )
      assert(nearest <= KERF_TOLERANCE,
        `level ${targetZ}: the entry stays on the level-cut kerf (${nearest})`)
      for (const tab of project.tabs) {
        if (targetZ >= tab.z_top - 1e-9) continue
        const distance = distanceToRect(point, tab)
        assert(distance >= toolDiameter / 2 + safety - SAFETY_EPSILON,
          `level ${targetZ}: the swept cutter clears ${tab.name} by the keep-out margin`
          + ` (${distance.toFixed(6)} in)`)
      }
    }
  }

  // The literal posted program: the old straight plunge line is gone and the
  // final entry descends over several axis moves before the flat cut.
  const gcode = postFixture(project, result)
  assert(gcode.includes('G20'), 'the fixture posts in inch mode')
  assert(!/^G1 X6\.125 Y0\.125 Z-0\.565 F90$/m.test(gcode),
    'the reported straight plunge line is no longer posted')
  const retracts = gcode.split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line === 'G00 Z0.2')
  // Three levels, so the third retract introduces the final-level entry; a
  // fourth retract after the completed contour does not.
  assert(retracts.length >= 3, 'the posted program retracts before every level')
  const finalEntry = retracts[2]
  assert(finalEntry !== undefined, 'the posted program retracts before each level')
  const lines = gcode.split('\n')
  const finalLines = lines.slice(finalEntry.index + 1, retracts[3]?.index ?? lines.length)
  const rampLines = finalLines.filter((line) => /^(G1 )?X6\.125 Y[\d.-]+ Z-?[\d.]+/.test(line))
  assert(rampLines.length >= 5,
    `the posted final entry descends over several moves (got ${rampLines.length})`)
  const zValues = rampLines.map((line) => Number(/ Z(-?[\d.]+)/.exec(line)?.[1]))
  assert(zValues[0] > zValues[zValues.length - 1],
    'the posted entry descends monotonically to the final depth')
  assert(!rampLines.some((line) => line.includes('F90')),
    'no final-depth plunge feed appears at the entry')
  console.log('reported project final-level ramp: PASSED')
}

// ── Focused synthetic clips ──────────────────────────────────────────

function rectangle(width: number, height: number, islands: Point[][] = []): EntryClearanceRegion {
  return {
    outer: [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
    islands,
  }
}

function island(x: number, y: number, w: number, h: number): Point[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
}

function policy(
  region: EntryClearanceRegion,
  overrides: Partial<EntryPolicy> = {},
): EntryPolicy {
  return {
    strategy: 'ramp',
    rampAngle: 5,
    helixDiameterPercent: 80,
    toolDiameter: 4,
    cutFeed: 800,
    plungeFeed: 200,
    cutDirection: 'conventional',
    cutSide: 'external',
    clearanceRegions: [region],
    ...overrides,
  }
}

function runEntry(
  region: EntryClearanceRegion,
  points: Point[],
  overrides: Partial<EntryPolicy> = {},
  target: Point = points[0],
  safeZ = 4,
): { moves: ToolpathMove[]; result: ReturnType<typeof synthesizeEntry> } {
  const path: EntryRampPath = { points, closed: false }
  const moves: ToolpathMove[] = []
  const result = synthesizeEntry(
    moves, null, { x: target.x, y: target.y, z: 0 }, safeZ,
    policy(region, { rampPath: path, ...overrides }),
  )
  return { moves, result }
}

function firstStroke(moves: ToolpathMove[]): number {
  const blocks = descendingEntryBlocks(moves)
  assert(blocks.length === 1, `one entry descent (got ${blocks.length})`)
  return strokeTravels(blocks[0])[0]
}

function maxEntryX(moves: ToolpathMove[]): number {
  let max = -Infinity
  for (const move of moves.filter((candidate) => candidate.kind === 'lead_in')) {
    max = Math.max(max, move.from.x, move.to.x)
  }
  return max
}

function testOneLongSegmentIsClippedBeforeTheTab(): void {
  console.log('Testing a tab inside one long straight 3D segment...')
  const toolDiameter = 4
  const safety = entryBoundarySafety(toolDiameter)
  const exitX = 15
  const region = rectangle(200, 40, [island(exitX, 4, 1, 2)])
  const { moves, result } = runEntry(region, [{ x: 5, y: 5 }, { x: 25, y: 5 }])
  assert(result.usedStrategy === 'ramp',
    `a long straight prefix is a ramp, not a plunge (got ${result.usedStrategy})`)
  assert(!warningsOf(result).includes('entryStrategyFallback'), 'no fallback is reported')
  const expectedTravel = exitX - 5 - safety
  assert(approx(firstStroke(moves), expectedTravel, 1e-6),
    `the stroke clips at the exit less the boundary margin (${firstStroke(moves).toFixed(6)})`)
  assert(approx(maxEntryX(moves), exitX - safety, 1e-6),
    `the entry stops before the tab keep-out (${maxEntryX(moves).toFixed(6)})`)
  assert(!moves.some((move) => move.kind === 'lead_in' && move.to.x >= exitX),
    'no entry move reaches the blocked island')
  const handoff = moves.find((move) => isEntryHandoffMove(move))
  assert(handoff !== undefined, 'the clipped ramp still hands off at final depth')
  assert(approx(handoff.to.x, 5) && approx(handoff.to.y, 5),
    'the handoff returns to the actual entry vertex')
  console.log('long straight segment clip: PASSED')
}

function testEquivalentSubdivisionReachesTheSamePoint(): void {
  console.log('Testing the same clip on an equivalent tessellated straight run...')
  const toolDiameter = 4
  const safety = entryBoundarySafety(toolDiameter)
  const exitX = 15
  const region = rectangle(200, 40, [island(exitX, 4, 1, 2)])
  const tessellated: Point[] = []
  for (let index = 0; index <= 80; index += 1) {
    tessellated.push({ x: 5 + 0.25 * index, y: 5 })
  }
  // The clip lands at x = 14.6, between the 9.5 and 9.75 vertices: the backoff
  // must cross a vertex that was already accepted.
  const straight = runEntry(region, [{ x: 5, y: 5 }, { x: 25, y: 5 }])
  const split = runEntry(region, tessellated)
  assert(split.result.usedStrategy === 'ramp', 'the tessellated run still ramps')
  assert(!warningsOf(split.result).includes('entryStrategyFallback'),
    'the tessellated run does not fall back')
  assert(approx(firstStroke(straight.moves), firstStroke(split.moves), 1e-6),
    `straight and subdivided runs reach the same stroke (${firstStroke(straight.moves)}`
    + ` vs ${firstStroke(split.moves)})`)
  assert(approx(maxEntryX(straight.moves), maxEntryX(split.moves), 1e-6),
    'straight and subdivided runs reach the same safe point')
  assert(approx(maxEntryX(split.moves), exitX - safety, 1e-6),
    'the subdivided run backs up across its last accepted vertex into the margin')
  console.log('straight versus tessellated clip: PASSED')
}

function testOnlyTheFirstBlockedRunIsUsed(): void {
  console.log('Testing that a clip stops at the first island and never re-enters...')
  const region = rectangle(200, 40, [island(9.5, 4, 1, 2)])
  const { moves, result } = runEntry(region, [{ x: 5, y: 5 }, { x: 25, y: 5 }])
  assert(result.usedStrategy === 'ramp', 'the prefix before the first island is useful')
  assert(!warningsOf(result).includes('entryStrategyFallback'), 'no fallback is reported')
  assert(maxEntryX(moves) <= 9.5 - 0.3,
    `the entry stops at the first island (${maxEntryX(moves).toFixed(6)})`)
  assert(!moves.some((move) => move.kind === 'lead_in' && move.to.x > 10.5),
    'the clear travel after the island is not resumed')
  console.log('first-blocked-only clip: PASSED')
}

function testBoundaryStartCollinearAndTangent(): void {
  console.log('Testing boundary-start, collinear and tangent segment semantics...')
  // The entry itself sits on the tab keep-out boundary and the only forward
  // travel enters the island immediately: there is no safe prefix.
  const blocked = rectangle(200, 40, [island(5, 4, 2, 2)])
  const blockedRun = runEntry(blocked, [{ x: 5, y: 5 }, { x: 9, y: 5 }])
  assert(blockedRun.result.usedStrategy === 'plunge',
    'a segment that starts on the boundary and leaves immediately falls back')
  assert(warningsOf(blockedRun.result).includes('entryStrategyFallback'),
    'the boundary-start fallback is warned')

  // A collinear run along the outer boundary is normal: the cut path rides the
  // outside domain's wall, and boundary contact is inside.
  const collinear = runEntry(rectangle(20, 20), [{ x: 5, y: 0 }, { x: 15, y: 0 }],
    {}, { x: 5, y: 0 })
  assert(collinear.result.usedStrategy === 'ramp', 'a boundary-collinear run ramps')
  assert(collinear.moves.filter((move) => move.kind === 'lead_in')
    .every((move) => approx(move.from.y, 0, 1e-9) && approx(move.to.y, 0, 1e-9)),
  'the collinear ramp never leaves the boundary')

  // Tangency to an island boundary is contact, not penetration.
  const tangent = rectangle(20, 20, [island(8, 0, 2, 2)])
  const tangentRun = runEntry(tangent, [{ x: 5, y: 2 }, { x: 15, y: 2 }])
  assert(tangentRun.result.usedStrategy === 'ramp', 'a tangent kiss is inside the region')
  assert(!warningsOf(tangentRun.result).includes('entryStrategyFallback'),
    'tangency does not trigger the fallback')
  console.log('boundary/collinear/tangent semantics: PASSED')
}

function testConcaveBoundaryUsesTheFirstExit(): void {
  console.log('Testing a concave outer boundary...')
  const outer: Point[] = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 14, y: 20 },
    { x: 14, y: 16 },
    { x: 10, y: 16 },
    { x: 10, y: 20 },
    { x: 0, y: 20 },
  ]
  const region: EntryClearanceRegion = { outer, islands: [] }
  const { moves, result } = runEntry(region, [{ x: 5, y: 18 }, { x: 19, y: 18 }])
  assert(result.usedStrategy === 'ramp', 'the prefix before the notch is a useful ramp')
  assert(!warningsOf(result).includes('entryStrategyFallback'), 'no fallback is reported')
  assert(maxEntryX(moves) <= 10 - entryBoundarySafety(4) + 1e-6,
    `the ramp stops at the notch entry (${maxEntryX(moves).toFixed(6)})`)
  assert(!moves.some((move) => move.kind === 'lead_in' && move.to.x > 14),
    'the region after the notch is not re-entered')
  console.log('concave boundary clip: PASSED')
}

function testUsefulMinimumBoundaryInInchAndMm(): void {
  console.log('Testing the exact one-diameter useful floor in inch and mm...')
  for (const [label, toolDiameter] of [['inch', 0.25], ['mm', 6.35]] as const) {
    const minRun = toolDiameter
    const safety = entryBoundarySafety(toolDiameter)
    const exactRegion = rectangle(50, 20, [island(5 + minRun + safety, 4, 1, 2)])
    const exact = runEntry(
      exactRegion,
      [{ x: 5, y: 5 }, { x: 5 + minRun * 4, y: 5 }],
      { toolDiameter },
    )
    assert(exact.result.usedStrategy === 'ramp',
      `${label}: exactly one diameter of clipped travel is a ramp`)
    assert(approx(firstStroke(exact.moves), minRun, 1e-6),
      `${label}: the exact-minimum stroke is kept (${firstStroke(exact.moves).toFixed(6)})`)

    const shortRegion = rectangle(50, 20, [island(5 + minRun + safety - 0.01, 4, 1, 2)])
    const short = runEntry(
      shortRegion,
      [{ x: 5, y: 5 }, { x: 5 + minRun * 4, y: 5 }],
      { toolDiameter },
    )
    assert(short.result.usedStrategy === 'plunge',
      `${label}: a sub-minimum prefix falls back`)
    assert(warningsOf(short.result).includes('entryStrategyFallback'),
      `${label}: the sub-minimum fallback is warned`)
  }
  console.log('one-diameter floor: PASSED')
}

function testCurvedOpenFragmentClipsAndHandsOff(): void {
  console.log('Testing a curved open fragment with a blocking keep-out...')
  const center = { x: 5, y: 5 }
  const radius = 5
  const points: Point[] = []
  for (let index = 0; index <= 50; index += 1) {
    const angle = (index / 50) * Math.PI / 2
    points.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    })
  }
  // An obstacle on the arc at about 60 degrees: 5.236 in of arclength from the
  // entry, so the useful 4.8 in prefix exists and the travel after it does not.
  const blockAngle = Math.PI / 3
  const blockX = center.x + Math.cos(blockAngle) * radius
  const blockY = center.y + Math.sin(blockAngle) * radius
  const region = rectangle(20, 20, [island(blockX - 0.35, blockY - 0.35, 0.7, 0.7)])
  const target = points[0]
  const { moves, result } = runEntry(region, points, {}, target, 4)
  assert(result.usedStrategy === 'ramp', 'the curved open fragment supplies a ramp')
  assert(!warningsOf(result).includes('entryStrategyFallback'), 'no fallback is reported')

  let maxDistanceFromArc = 0
  for (const move of moves.filter((candidate) => candidate.kind === 'lead_in')) {
    for (const point of sampledPoints(move)) {
      maxDistanceFromArc = Math.max(maxDistanceFromArc, distanceToPolyline(point, points))
    }
  }
  assert(maxDistanceFromArc <= 1e-6,
    `every entry move stays on the curved cut polyline (${maxDistanceFromArc})`)
  const handoff = moves.find((move) => isEntryHandoffMove(move))
  assert(handoff !== undefined, 'the curved clipped ramp hands off')
  assert(approx(handoff.to.x, target.x) && approx(handoff.to.y, target.y),
    'the curved handoff returns to the entry vertex')
  const firstStrokeTravel = firstStroke(moves)
  assert(firstStrokeTravel < radius * Math.PI / 2,
    'the curved run is genuinely shortened by the obstacle')
  console.log('curved open fragment: PASSED')
}

function testOverBudgetClippedRunStillFallsBack(): void {
  console.log('Testing a clipped run that still exceeds the move budget...')
  const region = rectangle(200, 40, [island(15, 4, 1, 2)])
  const points = Array.from({ length: 6001 }, (_, index) => ({ x: 5 + 20 * index / 6000, y: 5 }))
  const { moves, result } = runEntry(region, points, {
    toolDiameter: 4,
    rampAngle: 0.1,
  }, { x: 5, y: 5 }, 200)
  assert(result.usedStrategy === 'plunge', 'the over-budget clipped run falls back')
  assert(warningsOf(result).includes('entryStrategyFallback'), 'the over-budget fallback is warned')
  assert(moves.length < 20_010, `the refused run stays bounded (got ${moves.length})`)
  console.log('over-budget clipped run: PASSED')
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.error(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

test('reported project ramps every level without fallback', testReportedProjectRampsEveryLevelWithoutFallback)
test('one long segment is clipped before the tab', testOneLongSegmentIsClippedBeforeTheTab)
test('equivalent subdivision reaches the same point', testEquivalentSubdivisionReachesTheSamePoint)
test('only the first blocked run is used', testOnlyTheFirstBlockedRunIsUsed)
test('boundary-start, collinear and tangent semantics', testBoundaryStartCollinearAndTangent)
test('concave boundary uses the first exit', testConcaveBoundaryUsesTheFirstExit)
test('useful minimum boundary in inch and mm', testUsefulMinimumBoundaryInInchAndMm)
test('curved open fragment clips and hands off', testCurvedOpenFragmentClipsAndHandsOff)
test('over-budget clipped run still falls back', testOverBudgetClippedRunStillFallsBack)

console.log(`\nissue #1109 tab-ramp tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
