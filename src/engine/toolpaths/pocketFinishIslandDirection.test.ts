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
 * A pocket finish cuts the island in the direction that was asked for (issue
 * #706).
 *
 * Reported as "round corners reverses the cut direction", and it needs an
 * island to show: the pocket wall is never affected, only island rings, so a
 * pocket without one looks fine. Measured on the fixture below (60 × 40 pocket,
 * full-height 20 × 20 island, ⌀3, finish walls only, single band), reported as
 * the winding of the emitted closed rings:
 *
 *   round | direction    | pocket wall | island ring
 *   off   | conventional | CCW         | CW          correct — opposite senses
 *   off   | climb        | CW          | CCW         correct
 *   on    | conventional | CCW         | CCW         REVERSED
 *   on    | climb        | CW          | CW          REVERSED
 *
 * Opposite senses is what keeps the cutter on the same side of the material for
 * the requested direction, so with rounding on the island was climb-milled when
 * conventional was asked for, and the reverse.
 *
 * **Why the two round settings differed.** `buildExpandedIslandContours`
 * normalizes each island to outer winding before offsetting it — a hole-wound
 * path would shrink instead of expanding — and nothing converted it back. The
 * rings therefore carried outer winding, and `applyContourDirection`, which
 * assumes every contour it is handed shares one role, read them as pocket wall.
 * The unrounded branch pushes islands through `buildContourLoops` untouched, so
 * they keep hole winding and the direction pass gets them right.
 *
 * **The acute-corner cleanup runs ignored the setting outright.** They are open
 * polylines, so the closed-contour direction pass never reaches them: byte-
 * identical output for conventional and climb on every fixture tried. Setting a
 * winding at their assignment does not work either — `orderOpenSegmentsGreedy`
 * picks each run's start by proximity to the current position and re-reverses
 * whatever arrives (measured: reversing there changed nothing). The direction is
 * applied after the ordering instead, which is what the second test pins.
 *
 * **The rough pass is not affected**, and that is asserted as a control rather
 * than fixed: its islands go through `applyContourDirection` on the raw
 * islands, which is the correct construction and already honors the setting.
 * The report asked for this to be checked.
 *
 * Run with: npx tsx src/engine/toolpaths/pocketFinishIslandDirection.test.ts
 */

import type { CutDirection, Operation, Point, Project, SketchFeature, Tool } from '../../types/project'
import { defaultTool, newProject, polygonProfile, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { isClockwise } from './geometry'
import { generatePocketToolpath } from './pocket'
import type { ToolpathMove } from './types'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) {
    passed += 1
    console.log(`   ✓ ${name}`)
    return
  }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

const POCKET = { minX: 0, minY: 0, maxX: 60, maxY: 40 }
const ISLAND = { x: 20, y: 10, w: 20, h: 20 }

/** The spike island of the #746 fixture: one acute corner at (40, 20). */
const SPIKE_ISLAND: Point[] = [{ x: 10, y: 10 }, { x: 40, y: 20 }, { x: 10, y: 30 }]

function rectFeature(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  operation: 'subtract' | 'add',
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: 2,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function polygonIsland(id: string, points: Point[]): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: polygonProfile(points),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 2,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeFlatEndmill(id: string, diameter: number): Tool {
  return {
    ...defaultTool('mm', 1),
    id,
    name: `${diameter} mm endmill`,
    diameter,
    defaultStepdown: 1,
    defaultStepover: 0.4,
  }
}

function finishOp(toolRef: string, round: boolean, direction: CutDirection): Operation {
  return {
    id: 'op1',
    name: 'finish',
    kind: 'pocket',
    pass: 'finish',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['p1'] },
    toolRef,
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    roundOutsideCorners: round,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: false,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: direction,
    machiningOrder: 'level_first',
  }
}

function roughOp(toolRef: string, round: boolean, direction: CutDirection): Operation {
  return {
    ...finishOp(toolRef, round, direction),
    id: 'op1',
    name: 'rough',
    pass: 'rough',
    finishWalls: false,
  }
}

function projectWith(island: SketchFeature, diameter: number): Project {
  const base = newProject('pocket finish island direction', 'mm')
  return projectWithFeatures(
    { ...base, tools: [makeFlatEndmill('t1', diameter)] },
    [rectFeature('p1', POCKET.minX, POCKET.minY, POCKET.maxX, POCKET.maxY, 'subtract'), island],
  )
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface CutChain {
  points: Point[]
  closed: boolean
}

/** Cut moves chained end to end, split wherever a non-cut move interrupts. */
function cutChains(moves: ToolpathMove[]): CutChain[] {
  const chains: CutChain[] = []
  let points: Point[] = []

  const flush = (): void => {
    if (points.length >= 2) {
      const first = points[0]
      const last = points[points.length - 1]
      chains.push({ points, closed: Math.hypot(first.x - last.x, first.y - last.y) <= 1e-6 })
    }
    points = []
  }

  for (const move of moves) {
    if (move.kind !== 'cut') {
      flush()
      continue
    }
    if (points.length === 0) points.push({ x: move.from.x, y: move.from.y })
    else {
      const last = points[points.length - 1]
      if (Math.hypot(move.from.x - last.x, move.from.y - last.y) > 1e-6) flush()
      if (points.length === 0) points.push({ x: move.from.x, y: move.from.y })
    }
    points.push({ x: move.to.x, y: move.to.y })
  }
  flush()
  return chains
}

/** Distance to the island rectangle's boundary; negative inside it. */
function distanceToIslandRect(point: Point): number {
  const insideX = point.x >= ISLAND.x && point.x <= ISLAND.x + ISLAND.w
  const insideY = point.y >= ISLAND.y && point.y <= ISLAND.y + ISLAND.h
  if (insideX && insideY) {
    return -Math.min(
      point.x - ISLAND.x,
      ISLAND.x + ISLAND.w - point.x,
      point.y - ISLAND.y,
      ISLAND.y + ISLAND.h - point.y,
    )
  }
  const dx = Math.max(ISLAND.x - point.x, 0, point.x - (ISLAND.x + ISLAND.w))
  const dy = Math.max(ISLAND.y - point.y, 0, point.y - (ISLAND.y + ISLAND.h))
  return Math.hypot(dx, dy)
}

/** How far outside the pocket boundary a point sits (negative inside). */
function outsidePocket(point: Point): number {
  return Math.max(
    POCKET.minX - point.x,
    point.x - POCKET.maxX,
    POCKET.minY - point.y,
    point.y - POCKET.maxY,
  )
}

/**
 * The rotational sense of a set of chains about the island, taken from the
 * island-adjacent segments only.
 *
 * A ring that encircles the island is one closed loop that also hugs the wall,
 * so it cannot be classified as "the island ring" by containment — but the part
 * of it that runs along the island still turns the same way about the island's
 * centre, which is what the requested direction is about.
 */
function islandAdjacentSense(chains: CutChain[], band: number): { sense: 'CW' | 'CCW' | 'none'; segments: number } {
  const centre = { x: ISLAND.x + ISLAND.w / 2, y: ISLAND.y + ISLAND.h / 2 }
  let sum = 0
  let segments = 0
  for (const chain of chains) {
    for (let index = 1; index < chain.points.length; index += 1) {
      const a = chain.points[index - 1]
      const b = chain.points[index]
      const distanceA = distanceToIslandRect(a)
      const distanceB = distanceToIslandRect(b)
      if (distanceA < 0 || distanceB < 0) continue
      if (distanceA > band || distanceB > band) continue
      sum += (a.x - centre.x) * (b.y - centre.y) - (a.y - centre.y) * (b.x - centre.x)
      segments += 1
    }
  }
  if (segments === 0) return { sense: 'none', segments }
  return { sense: sum > 0 ? 'CCW' : 'CW', segments }
}

/** Unordered segment keys, so two traversals can be compared as geometry. */
function undirectedSegments(points: Point[]): string[] {
  const keys: string[] = []
  const quantise = (value: number): number => Math.round(value * 1000) / 1000
  const vertex = (point: Point): string => `${quantise(point.x)},${quantise(point.y)}`
  for (let index = 0; index < points.length; index += 1) {
    const a = vertex(points[index])
    const b = vertex(points[(index + 1) % points.length])
    if (a === b) continue
    keys.push(a < b ? `${a}|${b}` : `${b}|${a}`)
  }
  return keys.sort()
}

function directedKey(points: Point[]): string {
  const quantise = (value: number): number => Math.round(value * 1000) / 1000
  return points.map((point) => `${quantise(point.x)},${quantise(point.y)}`).join('>')
}

function sameGeometry(left: Point[], right: Point[]): boolean {
  const a = undirectedSegments(left)
  const b = undirectedSegments(right)
  return a.length === b.length && a.every((key, index) => key === b[index])
}

/** Distance from a point to a closed polygon's edges. */
function distanceToPolygon(point: Point, polygon: Point[]): number {
  let best = Number.POSITIVE_INFINITY
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index]
    const b = polygon[(index + 1) % polygon.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSquared = dx * dx + dy * dy
    const t = lengthSquared > 0
      ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
      : 0
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)))
  }
  return best
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]
    const b = polygon[j]
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

/**
 * The deepest any move *at cut depth* reaches into the island, sampled.
 *
 * Depth rather than kind, on purpose: the link between two cleanup runs is
 * emitted at depth and is exactly the failure that makes reorienting an open
 * run worth checking, so filtering to `cut` alone would miss it. Moves that
 * climb away — plunges, retracts, safe-Z transit that legitimately flies over
 * the island — are excluded, which is why z is tested rather than the kind.
 */
function worstIslandEntry(moves: ToolpathMove[], polygon: Point[], spacing = 0.05): number {
  let cutZ = Number.POSITIVE_INFINITY
  for (const move of moves) cutZ = Math.min(cutZ, move.from.z, move.to.z)
  let worst = 0
  for (const move of moves) {
    if (Math.max(move.from.z, move.to.z) > cutZ + 1e-6) continue
    const steps = Math.max(1, Math.ceil(
      Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) / spacing,
    ))
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps
      const point = {
        x: move.from.x + (move.to.x - move.from.x) * t,
        y: move.from.y + (move.to.y - move.from.y) * t,
      }
      if (!pointInPolygon(point, polygon)) continue
      worst = Math.max(worst, distanceToPolygon(point, polygon))
    }
  }
  return worst
}

/** Tolerance for jtRound tessellation: 1% of the delta, capped at 0.01 mm. */
const ARC_TOLERANCE = 0.02

interface FinishRun {
  result: ReturnType<typeof generatePocketToolpath>
  chains: CutChain[]
}

function generateFinish(round: boolean, direction: CutDirection, island: SketchFeature, diameter: number): FinishRun {
  const result = generatePocketToolpath(projectWith(island, diameter), finishOp('t1', round, direction))
  return { result, chains: cutChains(result.moves) }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** The reported defect: the island ring runs the same way round as the wall. */
function testIslandRingOpposesTheWall(): void {
  console.log('Testing the island ring is cut opposite to the pocket wall...')
  const island = rectFeature('i1', ISLAND.x, ISLAND.y, ISLAND.w, ISLAND.h, 'add')
  const rows: string[] = []

  for (const round of [false, true]) {
    for (const direction of ['conventional', 'climb'] as const) {
      const { chains } = generateFinish(round, direction, island, 3)
      const closed = chains.filter((chain) => chain.closed)

      // The island ring lies at the finish delta from the island; the wall ring
      // hugs the pocket boundary. Both are closed, so classify by where they
      // run rather than by winding — winding is the thing under test.
      const islandRing = closed.find((chain) => chain.points.every((point) => distanceToIslandRect(point) <= 2.5))
      const wallRing = closed.find((chain) => chain.points.every((point) => outsidePocket(point) <= 2.5))
      if (!islandRing || !wallRing) {
        check(
          `round=${round} ${direction}: both rings are emitted`,
          false,
          `island ring ${islandRing ? 'found' : 'MISSING'}, wall ring ${wallRing ? 'found' : 'MISSING'}`,
        )
        continue
      }

      const islandSense = isClockwise(islandRing.points) ? 'CW' : 'CCW'
      const wallSense = isClockwise(wallRing.points) ? 'CW' : 'CCW'
      rows.push(`round=${round ? 'on ' : 'off'} ${direction.padEnd(12)} wall=${wallSense} island=${islandSense}`)
      check(
        `round=${round} ${direction}: island ring opposes the wall`,
        islandSense !== wallSense,
        `both rings are cut ${wallSense} — the island is finished in the wrong direction`,
      )
    }
  }

  console.log(rows.map((row) => `     ${row}`).join('\n'))
}

/**
 * Containment, not detection: this one holds with and without the fix, by
 * design. Reversing the ring is what `applyContourDirection` always did — it
 * was reading the ring's role wrong, not skipping the reversal — so the claim
 * worth pinning is that the fix changed the traversal and nothing else about the
 * geometry. A fix that re-seamed the ring or moved a lead would fail here.
 */
function testOnlyTheTraversalMoved(): void {
  console.log('Testing the two directions move only the traversal, not the ring geometry...')
  const island = rectFeature('i1', ISLAND.x, ISLAND.y, ISLAND.w, ISLAND.h, 'add')
  const conventional = generateFinish(true, 'conventional', island, 3)
    .chains.find((chain) => chain.closed && chain.points.every((p) => distanceToIslandRect(p) <= 2.5))
  const climb = generateFinish(true, 'climb', island, 3)
    .chains.find((chain) => chain.closed && chain.points.every((p) => distanceToIslandRect(p) <= 2.5))

  if (!conventional || !climb) {
    check('both directions emit the island ring', false, 'a ring is missing')
    return
  }
  check(
    'the island ring is the same geometry in both directions',
    sameGeometry(conventional.points, climb.points),
    'the cut segments changed, not only their order',
  )
  check(
    'the island ring is not traversed the same way',
    directedKey(conventional.points) !== directedKey(climb.points),
    'conventional and climb emit the identical traversal — the setting did nothing',
  )
}

/** The cleanup runs never saw the setting at all. */
function testCleanupRunsHonourDirection(): void {
  console.log('Testing the acute-island cleanup runs honour the cut direction...')
  const island = polygonIsland('i1', SPIKE_ISLAND)
  const band = 3 + 3 * 2 * 0.4
  const runs: Record<string, CutChain[]> = {}

  for (const direction of ['conventional', 'climb'] as const) {
    const { chains, result } = generateFinish(true, direction, island, 6)
    const open = chains.filter((chain) => !chain.closed)
    runs[direction] = open
    const sense = islandAdjacentSense(open, band)
    check(
      `${direction}: the cleanup runs are emitted`,
      open.length > 0,
      'no open run found on a fixture with an acute island corner',
    )
    check(
      `${direction}: the cleanup runs turn about the island`,
      sense.sense !== 'none',
      'no island-adjacent segment found in the runs',
    )
    const entry = worstIslandEntry(result.moves, SPIKE_ISLAND)
    check(
      `${direction}: no move enters the island`,
      entry <= ARC_TOLERANCE,
      `a move reaches ${entry.toFixed(4)} mm into the island`,
    )
  }

  const conventionalRuns = runs.conventional ?? []
  const climbRuns = runs.climb ?? []
  const conventionalSegments = conventionalRuns.flatMap((chain) => undirectedSegments(chain.points))
  const climbSegments = climbRuns.flatMap((chain) => undirectedSegments(chain.points))
  check(
    'the cleanup runs are the same geometry in both directions',
    conventionalSegments.length === climbSegments.length
      && conventionalSegments.sort().every((key, index) => key === climbSegments.sort()[index]),
    'the run geometry changed, not only its order',
  )

  const conventionalSense = islandAdjacentSense(conventionalRuns, band)
  const climbSense = islandAdjacentSense(climbRuns, band)
  console.log(`     cleanup runs: conventional=${conventionalSense.sense} (${conventionalSense.segments} segs) climb=${climbSense.sense} (${climbSense.segments} segs)`)
  check(
    'the cleanup runs turn opposite ways for the two directions',
    conventionalSense.sense !== 'none'
      && climbSense.sense !== 'none'
      && conventionalSense.sense !== climbSense.sense,
    `both directions run the cleanup the same way (${conventionalSense.sense})`,
  )
}

/**
 * Control, not a fix: the rough pass takes its islands straight from the raw
 * geometry, so it already honored the setting. The report asked for it to be
 * checked; this is that check.
 */
function testRoughPassIsUnaffected(): void {
  console.log('Testing the rough pass already honors the direction (control)...')
  const island = rectFeature('i1', ISLAND.x, ISLAND.y, ISLAND.w, ISLAND.h, 'add')
  const band = 3 + 3 * 2 * 0.4
  const senses: Record<string, string> = {}

  for (const direction of ['conventional', 'climb'] as const) {
    const result = generatePocketToolpath(projectWith(island, 6), roughOp('t1', true, direction))
    const sense = islandAdjacentSense(cutChains(result.moves), band)
    senses[direction] = sense.sense
    check(
      `rough ${direction}: island-adjacent cuts are emitted`,
      sense.sense !== 'none',
      'no island-adjacent segment found',
    )
  }
  check(
    'the rough pass cuts the island opposite ways for the two directions',
    senses.conventional !== 'none' && senses.climb !== 'none' && senses.conventional !== senses.climb,
    `both directions run the same way (${senses.conventional})`,
  )
  console.log(`     rough island sense: conventional=${senses.conventional} climb=${senses.climb}`)
}

testIslandRingOpposesTheWall()
testOnlyTheTraversalMoved()
testCleanupRunsHonourDirection()
testRoughPassIsUnaffected()

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
