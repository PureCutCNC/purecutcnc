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
 * Saved-fixture regression for issue #1084's correction: a requested OUTSIDE
 * ramp follows the actual connected cut contour rather than the immediate
 * rounded-corner tessellation chord.
 *
 * The original implementation selected the entry vertex's forward chord, which
 * on `ramp-on-path-test.camj` is a 0.035256 in corner facet. It then reversed on
 * that facet for every descent stroke: 106 descending moves into the first level
 * and 308 into the last. The approved correction crosses the facet onto the 3 in
 * straight cut immediately after it, ramps along that connected travel up to the
 * existing 3D cap, and reverses only at the useful stroke endpoints.
 *
 * These assertions deliberately separate three counts that are easy to confuse:
 * descending MOVES (10 first / 30 last — each stroke crosses the facet plus the
 * straight run), true REVERSALS (4 / 14), and STROKES (5 / 15). The defect's
 * 106/308 is a descending-move count.
 *
 * Run with: npx tsx src/engine/toolpaths/edgeRampOnPathFixture.test.ts
 */

import { readFileSync } from 'node:fs'
import { generateEdgeRouteToolpath } from './edge'
import { isEntryHandoffMove } from './entry'
import { generatePocketToolpath } from './pocket'
import { normalizeProject } from '../../store/helpers/projectFormat'
import { projectWithFeatures } from '../../test/projectFixtures'
import {
  circleProfile,
  defaultTool,
  newProject,
  rectProfile,
  type Operation,
  type Point,
  type Project,
  type SketchFeature,
  type Tool,
} from '../../types/project'
import type { ToolpathMove, ToolpathResult } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

const KERF_TOLERANCE = 1e-6
const FIXTURE = new URL('../test-fixtures/ramp-on-path-test.camj', import.meta.url)

function loadedFixture(): Project {
  return normalizeProject(JSON.parse(readFileSync(FIXTURE, 'utf8')))
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (!(lengthSquared > 0)) return Math.hypot(point.x - a.x, point.y - a.y)
  const ratio = Math.max(0, Math.min(
    1,
    ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared,
  ))
  return Math.hypot(point.x - (a.x + dx * ratio), point.y - (a.y + dy * ratio))
}

function sampledPoints(move: ToolpathMove, perMove = 8): Point[] {
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

/** Contiguous runs of descending `lead_in` moves: one entry's descent. */
function descendingEntryBlocks(moves: ToolpathMove[]): ToolpathMove[][] {
  const blocks: ToolpathMove[][] = []
  let current: ToolpathMove[] = []
  for (const move of moves) {
    if (move.kind === 'lead_in' && move.to.z < move.from.z - 1e-9) {
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

/**
 * True reversals inside one descent: adjacent planar directions pointing
 * opposite ways. A tessellation vertex turns by a few degrees and a square
 * corner by 90, neither of which is a reversal.
 */
function trueReversals(block: ToolpathMove[]): number {
  let reversals = 0
  for (let index = 1; index < block.length; index += 1) {
    const previous = horizontal(block[index - 1])
    const next = horizontal(block[index])
    if (previous && next && previous.x * next.x + previous.y * next.y < -0.99) reversals += 1
  }
  return reversals
}

/** Split a descent into strokes at its true reversals. */
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
    travel += Math.hypot(
      block[index].to.x - block[index].from.x,
      block[index].to.y - block[index].from.y,
    )
  }
  travels.push(travel)
  return travels
}

function cutSegmentsAt(moves: ToolpathMove[], z: number): Array<{ a: Point; b: Point }> {
  return moves
    .filter((move) => move.kind === 'cut'
      && Math.abs(move.from.z - z) <= 1e-9
      && Math.abs(move.to.z - z) <= 1e-9)
    .map((move) => ({ a: move.from, b: move.to }))
}

function maxOffCutPath(moves: ToolpathMove[], z: number, samples: ToolpathMove[]): number {
  const segments = cutSegmentsAt(moves, z)
  assert(segments.length > 0, `level ${z} has a cut path to measure against`)
  let worst = 0
  for (const move of samples) {
    for (const point of sampledPoints(move, 12)) {
      const nearest = segments.reduce(
        (best, segment) => Math.min(best, distanceToSegment(point, segment.a, segment.b)),
        Infinity,
      )
      worst = Math.max(worst, nearest)
    }
  }
  return worst
}

function entriesAtLevel(moves: ToolpathMove[], z: number): ToolpathMove[] {
  return moves.filter((move) => move.kind === 'lead_in'
    && Math.abs(move.from.z - move.to.z) <= 1e-9
    && Math.abs(move.to.z - z) <= 1e-9)
}

function warningsOf(result: ToolpathResult): string[] {
  return result.warnings.map((warning) => warning.code)
}

function assertNoFallback(result: ToolpathResult, label: string): void {
  assert(!warningsOf(result).includes('entryStrategyFallback'),
    `${label}: the connected contour supplies a useful ramp at every level`)
  assert(!warningsOf(result).includes('xyLeadNoViablePath'),
    `${label}: no XY lead was requested, so no omission warning is due`)
}

// ── The rejected saved fixture ──────────────────────────────────────

function testSavedFixtureUsesTheConnectedContour(): void {
  console.log('Testing the saved ramp-on-path fixture...')
  const project = loadedFixture()
  const outside = project.operations.find((operation) => operation.kind === 'edge_route_outside')
  assert(outside !== undefined, 'the fixture has an outside route')
  const result = generateEdgeRouteToolpath(project, outside)
  assertNoFallback(result, 'saved fixture')

  const blocks = descendingEntryBlocks(result.moves)
  assert(blocks.length === 6, `one ramp per rough level (got ${blocks.length})`)
  const targetLevels = blocks.map((block) => block[block.length - 1].to.z)
  assert(JSON.stringify(targetLevels.map((z) => Number(z.toFixed(6))))
    === JSON.stringify([0.625, 0.5, 0.375, 0.25, 0.125, 0]),
  `the fixture cuts every level in order (${targetLevels.join(', ')})`)

  const expectedStrokes = [5, 7, 9, 11, 13, 15]
  const strokeCounts = blocks.map((block) => trueReversals(block) + 1)
  assert(JSON.stringify(strokeCounts) === JSON.stringify(expectedStrokes),
    `stroke count follows the requested angle and descent (${strokeCounts.join(', ')})`)
  assert(JSON.stringify(blocks.map(trueReversals)) === JSON.stringify([4, 6, 8, 10, 12, 14]),
    'true reversals are strokes minus one, not one per tessellation chord')
  assert(JSON.stringify(blocks.map((block) => block.length))
    === JSON.stringify([10, 14, 18, 22, 26, 30]),
  'descending moves cross the corner facet plus the connected straight run')
  assert(blocks[0].length < 50 && blocks[blocks.length - 1].length < 80,
    'the first and last levels are nowhere near the rejected 106/308 descending moves')

  const toolDiameter = project.tools[0].diameter
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const z = targetLevels[index]
    const travels = strokeTravels(block)
    assert(travels.length === expectedStrokes[index],
      `level ${z}: every stroke is separated by a true reversal`)
    for (const travel of travels) {
      assert(travel <= toolDiameter * 3 + 1e-9,
        `level ${z}: a stroke stays within the existing 3D cap (${travel})`)
    }
    const lastStroke = travels[travels.length - 1]
    assert(lastStroke > 0 && lastStroke < toolDiameter * 3 - 1e-6,
      `level ${z}: the final stroke is partial, not a padded full run`)
    assert(maxOffCutPath(result.moves, z, block) <= KERF_TOLERANCE,
      `level ${z}: every descending move stays on the level-cut centreline`)
    const handoff = entriesAtLevel(result.moves, z)
    assert(handoff.length > 0, `level ${z}: a planar handoff is emitted`)
    assert(handoff.some((move) => isEntryHandoffMove(move)),
      `level ${z}: the final-depth handoff is marked`)
    assert(maxOffCutPath(result.moves, z, handoff) <= KERF_TOLERANCE,
      `level ${z}: the final-depth handoff follows the contour too`)
  }
  console.log('saved fixture connected-contour ramp: PASSED')
}

function testPocketIsUnchanged(): void {
  console.log('Testing the same fixture\'s pocket operation for exact parity...')
  const project = loadedFixture()
  const pocket = project.operations.find((operation) => operation.kind === 'pocket')
  assert(pocket !== undefined, 'the fixture has a pocket operation')
  const result = generatePocketToolpath(project, pocket)
  assert(result.warnings.length === 0, 'the pocket fixture still emits no warnings')
  // Measured against the pre-correction fixed/main probes for this exact file.
  assert(result.moves.length === 854,
    `the pocket stream is byte-for-byte the same length (got ${result.moves.length})`)
  const blocks = descendingEntryBlocks(result.moves)
  assert(blocks.length === 2, `the pocket still has two entry descents (got ${blocks.length})`)
  assert(blocks.every((block) => block.length <= 5),
    'the pocket ramp still takes its ordinary few full strokes')
  console.log('pocket parity: PASSED')
}

// ── A curved (closed, all-vertices) contour ─────────────────────────

function flatEndmill(units: 'inch' | 'mm', diameter: number): Tool {
  return { ...defaultTool(units, 1), id: 't1', name: 't1', diameter, defaultStepdown: diameter }
}

function circleFeature(cx: number, cy: number, r: number): SketchFeature {
  return {
    id: 'boss', name: 'boss', kind: 'circle', folderId: null,
    sketch: {
      profile: circleProfile(cx, cy, r),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation: 'add', z_top: 1, z_bottom: 0, visible: true, locked: false,
  }
}

function circleProject(): Project {
  const base = newProject('ramp-curve', 'inch')
  const project: Project = {
    ...base,
    stock: {
      ...base.stock,
      profile: rectProfile(0, 0, 6, 6),
      thickness: 1,
    },
    tools: [flatEndmill('inch', 0.25)],
  }
  return projectWithFeatures(project, [circleFeature(3, 3, 1.5)])
}

function outsideOperation(): Operation {
  return {
    id: 'op1', name: 'outside rough', kind: 'edge_route_outside', pass: 'rough', enabled: true,
    showToolpath: true, debugToolpath: false, target: { source: 'features', featureIds: ['boss'] },
    toolRef: 't1', stepdown: 0.125, stepover: 0.4, feed: 100, plungeFeed: 30, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: false, finishFloor: false, carveDepth: 1, maxCarveDepth: 1,
    cutDirection: 'conventional', machiningOrder: 'level_first',
    entryStrategy: 'ramp', entryRampAngle: 5, roundOutsideCorners: true,
  } as Operation
}

function testCurvedClosedContourStaysOnTheCircle(): void {
  console.log('Testing a tessellated circular contour...')
  const project = circleProject()
  const result = generateEdgeRouteToolpath(project, outsideOperation())
  assertNoFallback(result, 'circle')
  const blocks = descendingEntryBlocks(result.moves)
  assert(blocks.length === 8, `eight rough levels are ramped (got ${blocks.length})`)
  for (const block of blocks) {
    const z = block[block.length - 1].to.z
    assert(block.length > 2, `level ${z}: the ramp crosses several circle facets`)
    const reversals = trueReversals(block)
    assert(block.length >= (reversals + 1) * 5,
      `level ${z}: many facet moves per useful stroke, not one reversal per facet`)
    assert(block.length < 400, `level ${z}: the tessellated contour stays bounded`)
    assert(reversals + 1 >= 2,
      `level ${z}: the circle supplies more than one useful stroke`)
    assert(maxOffCutPath(result.moves, z, block) <= KERF_TOLERANCE,
      `level ${z}: the entry follows the circle's cut centreline`)
    const handoff = entriesAtLevel(result.moves, z)
    assert(handoff.some((move) => isEntryHandoffMove(move)),
      `level ${z}: the handoff also follows the circle`)
    assert(maxOffCutPath(result.moves, z, handoff) <= KERF_TOLERANCE,
      `level ${z}: no off-path chord at final depth`)
  }
  console.log('curved closed-contour ramp: PASSED')
}

try {
  testSavedFixtureUsesTheConnectedContour()
  testPocketIsUnchanged()
  testCurvedClosedContourStaysOnTheCircle()
  console.log('\nAll on-path ramp fixture tests PASSED.')
} catch (error) {
  console.error(error)
  throw error
}
