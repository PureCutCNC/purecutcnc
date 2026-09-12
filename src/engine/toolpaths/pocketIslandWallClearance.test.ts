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
 * The pocket finish may not cut past the pocket wall to clean an island
 * (issue #746).
 *
 * With "Round wall corners" on, the finish builds its island passes by
 * offsetting the raw island outward — `buildExpandedIslandContours` at the
 * finish delta, and `buildAcuteIslandCornerCleanupSegments` one stepover
 * further out. Neither construction can see the pocket wall, so when the stock
 * between island and wall is narrower than the cutter the pass simply runs
 * outside the pocket and the cutter gouges the wall, silently. The unrounded
 * branch never could: its rings come out of `buildInsetRegions`, which is
 * `difference(outer ⊖ delta, islands ⊕ delta)` and is therefore clipped to the
 * wall by construction.
 *
 * The measurement is the cutter's outermost reach: for every sampled point on
 * every cut, how far past the nominal pocket boundary does a disc of the finish
 * radius centred there reach? Zero (within arc tessellation) is the only
 * acceptable answer — the wall is the finished surface.
 *
 * Recorded measurements, cutter reach past the wall with the control on:
 *   rect island, 5 mm of stock either side, ⌀8
 *     main 3b9b1f7 (before):  3.000 mm, no warning
 *     after:                  0.000 mm, `pocketFinishIslandWallTooTight`
 *   spike island, tip 7 mm from the wall, ⌀6 — the ring fits, the cleanup
 *   run one stepover further out does not
 *     main 3b9b1f7 (before):  1.391 mm, no warning
 *     after:                  0.000 mm, `pocketFinishIslandWallTooTight`
 *
 * Trimming is not the whole requirement, so the other half is asserted too: the
 * island wall must still be finished where the cutter *does* fit (#550's
 * missing-ring defect must not come back through the guard), geometry whose
 * cutter fits everywhere must keep the closed ring it already had, and no cut
 * may enter the island. That last one is not decoration — keeping the reachable
 * spans of a trimmed cleanup arc instead of dropping the run put 1.4 mm of
 * cutter into the spike, because the two surviving fragments sit either side of
 * the island tip and the emission links consecutive runs at depth.
 *
 * One branch is exercised but not isolated: no fixture here makes a closed
 * ring's seam chord the segment that decides the ring leaves the domain.
 *
 * Run with: npx tsx src/engine/toolpaths/pocketIslandWallClearance.test.ts
 */

import type { CutDirection, Operation, Point, Project, SketchFeature, Tool } from '../../types/project'
import { defaultTool, newProject, polygonProfile, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { generatePocketToolpath } from './pocket'
import type { ToolpathMove } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** The pocket every case here is cut into. */
const POCKET = { minX: 0, minY: 0, maxX: 50, maxY: 40 }

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
    defaultStepdown: 2,
    defaultStepover: 0.4,
  }
}

function finishOp(toolRef: string, roundOutsideCorners: boolean, cutDirection: CutDirection): Operation {
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
    roundOutsideCorners,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: false,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection,
    machiningOrder: 'level_first',
  }
}

function projectWith(island: SketchFeature, diameter: number): Project {
  const base = newProject('pocket island wall clearance', 'mm')
  return projectWithFeatures(
    { ...base, tools: [makeFlatEndmill('t1', diameter)] },
    [rectFeature('p1', POCKET.minX, POCKET.minY, POCKET.maxX, POCKET.maxY, 'subtract'), island],
  )
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * `jtRound` tessellates arcs to 1% of the offset delta, capped at 0.01 mm, so a
 * ring that is exactly tangent to the domain can sit this far outside it. Two
 * orders of magnitude below the 3 mm defect.
 */
const ARC_TOLERANCE = 0.02

const cutMoves = (moves: ToolpathMove[]): ToolpathMove[] => moves.filter((move) => move.kind === 'cut')

/** How far outside the pocket boundary a point lies (negative inside). */
function outsidePocket(x: number, y: number): number {
  return Math.max(POCKET.minX - x, x - POCKET.maxX, POCKET.minY - y, y - POCKET.maxY)
}

function samplePoints(moves: ToolpathMove[], spacing = 0.1): Point[] {
  const points: Point[] = []
  for (const move of cutMoves(moves)) {
    const steps = Math.max(1, Math.ceil(
      Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) / spacing,
    ))
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps
      points.push({
        x: move.from.x + (move.to.x - move.from.x) * t,
        y: move.from.y + (move.to.y - move.from.y) * t,
      })
    }
  }
  return points
}

/** The cutter's outermost reach past the pocket wall, over every cut. */
function worstWallOvercut(moves: ToolpathMove[], radius: number): { depth: number; at: Point } {
  let depth = Number.NEGATIVE_INFINITY
  let at: Point = { x: 0, y: 0 }
  for (const point of samplePoints(moves)) {
    const reach = outsidePocket(point.x, point.y) + radius
    if (reach > depth) {
      depth = reach
      at = point
    }
  }
  return { depth, at }
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

/**
 * How far into the island the cutter reaches, over every cut. The island is
 * convex here, so distance to its boundary is the whole story: any cut centre
 * closer than the finish radius takes material off the island.
 */
function worstIslandGouge(
  moves: ToolpathMove[],
  island: Point[],
  radius: number,
): { depth: number; at: Point } {
  let depth = Number.NEGATIVE_INFINITY
  let at: Point = { x: 0, y: 0 }
  for (const point of samplePoints(moves)) {
    const reach = radius - distanceToPolygon(point, island)
    if (reach > depth) {
      depth = reach
      at = point
    }
  }
  return { depth, at }
}

const hasWarning = (warnings: Array<{ code: string }>, code: string): boolean =>
  warnings.some((warning) => warning.code === code)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * A rectangular island with 5 mm of stock to the left and right walls and 15 mm
 * to the top and bottom, cut with a ⌀8 endmill: the cutter fits above and below
 * the island and nowhere near the sides.
 */
function testRectIslandTooCloseToWall(direction: CutDirection): void {
  console.log(`Testing the finish does not cut past the wall to clean a wall-hugging island (${direction})...`)
  const island = rectFeature('i1', 5, 15, 40, 10, 'add')
  const project = projectWith(island, 8)
  const radius = 4

  for (const round of [false, true]) {
    const result = generatePocketToolpath(project, finishOp('t1', round, direction))
    const worst = worstWallOvercut(result.moves, radius)
    assert(
      worst.depth <= ARC_TOLERANCE,
      `${direction} round=${round}: no finish cut may reach past the pocket wall, got ${worst.depth.toFixed(4)} mm `
      + `at (${worst.at.x.toFixed(2)}, ${worst.at.y.toFixed(2)})`,
    )
  }

  // The trim has to be announced. Silently leaving the island wall unfinished
  // is the same surprise as gouging it, one pass later.
  const rounded = generatePocketToolpath(project, finishOp('t1', true, direction))
  assert(
    hasWarning(rounded.warnings, 'pocketFinishIslandWallTooTight'),
    'the trimmed island pass must raise pocketFinishIslandWallTooTight',
  )

  // ...and the trim may not cost the coverage it is not there to remove. The
  // island's top and bottom walls have 15 mm of room, so both must still be
  // finished at exactly the finish delta from the island edge, across their
  // whole reachable width — from the pocket's own tool-centre limit at x = 4 to
  // the one at x = 46. The dropped ring is not a loss because the wall's outer
  // contour picks these spans up (the ring only leaves the domain by crossing
  // it, and where it crosses it folds into that contour); this is the assertion
  // that holds that reasoning to account.
  const points = samplePoints(rounded.moves)
  // One finish radius off the island is the island's finished wall, corner arcs
  // included, so this measures the pass itself rather than one chosen y.
  const distanceToIsland = (point: Point): number => Math.hypot(
    Math.max(5 - point.x, 0, point.x - 45),
    Math.max(15 - point.y, 0, point.y - 25),
  )
  const finishedSpan = (onThisSide: (point: Point) => boolean): { min: number; max: number } => {
    const xs = points
      .filter((point) => Math.abs(distanceToIsland(point) - radius) < ARC_TOLERANCE && onThisSide(point))
      .map((point) => point.x)
    return { min: Math.min(...xs), max: Math.max(...xs) }
  }
  const sides: Array<[string, (point: Point) => boolean]> = [
    ['top', (point) => point.y > 25],
    ['bottom', (point) => point.y < 15],
  ]
  for (const [name, onThisSide] of sides) {
    const span = finishedSpan(onThisSide)
    assert(
      span.min <= 4 + ARC_TOLERANCE && span.max >= 46 - ARC_TOLERANCE,
      `the island ${name} wall has room for the cutter and must stay finished across x 4..46, `
      + `got ${span.min.toFixed(2)}..${span.max.toFixed(2)}`,
    )
  }
  console.log('finish keeps the cutter inside the wall around a wall-hugging island: PASSED')
}

/**
 * The acute-corner cleanup runs sit one stepover further out than the island
 * ring, so they can leave the pocket even where the ring itself fits. This
 * fixture isolates them: a spike island whose tip points at the right wall,
 * placed so the ⌀6 ring tip lands at x = 46 — inside the tool-centre limit of
 * x = 47 — while the cleanup run reaches for x = 48.4, a millimetre and a half
 * of wall.
 */
function testAcuteIslandCleanupPastTheWall(direction: CutDirection): void {
  console.log(`Testing the acute-island corner cleanup does not cut past the wall (${direction})...`)
  const spikeEdges: Point[] = [{ x: 10, y: 10 }, { x: 43, y: 20 }, { x: 10, y: 30 }]
  const project = projectWith(polygonIsland('i1', spikeEdges), 6)
  const radius = 3

  for (const round of [false, true]) {
    const result = generatePocketToolpath(project, finishOp('t1', round, direction))
    const worst = worstWallOvercut(result.moves, radius)
    assert(
      worst.depth <= ARC_TOLERANCE,
      `${direction} round=${round}: no finish cut may reach past the pocket wall, got ${worst.depth.toFixed(4)} mm `
      + `at (${worst.at.x.toFixed(2)}, ${worst.at.y.toFixed(2)})`,
    )
  }

  const rounded = generatePocketToolpath(project, finishOp('t1', true, direction))
  assert(
    hasWarning(rounded.warnings, 'pocketFinishIslandWallTooTight'),
    'a cleanup run trimmed at the wall must raise pocketFinishIslandWallTooTight',
  )

  // The run is dropped, not trimmed to its surviving spans, and this is the
  // assertion that says why. Trimming an arc that pokes out through its middle
  // leaves two fragments either side of the island tip; consecutive runs are
  // linked at depth, so the link between them cuts straight across the island
  // the arc was cleaning around — measured at 1.4 mm into this very spike.
  const worstIsland = worstIslandGouge(rounded.moves, spikeEdges, radius)
  assert(
    worstIsland.depth <= ARC_TOLERANCE,
    `no finish cut may enter the island, got ${worstIsland.depth.toFixed(4)} mm `
    + `at (${worstIsland.at.x.toFixed(2)}, ${worstIsland.at.y.toFixed(2)})`,
  )

  // Pull the island back and the same geometry needs no trim at all.
  const clear = generatePocketToolpath(
    projectWith(polygonIsland('i1', [{ x: 10, y: 10 }, { x: 40, y: 20 }, { x: 10, y: 30 }]), 6),
    finishOp('t1', true, direction),
  )
  assert(
    !hasWarning(clear.warnings, 'pocketFinishIslandWallTooTight'),
    `a spike with room for the cleanup run must not warn, got ${JSON.stringify(clear.warnings)}`,
  )
  console.log('acute island cleanup stays inside the wall: PASSED')
}

/**
 * The control. An island the cutter clears on every side must be untouched by
 * any of this: a whole closed ring, and no warning.
 */
function testIslandWithRoomIsUnchanged(direction: CutDirection): void {
  console.log(`Testing an island with room for the cutter keeps its whole closed ring (${direction})...`)
  const island = rectFeature('i1', 20, 15, 10, 10, 'add')
  const project = projectWith(island, 4)
  const radius = 2
  const result = generatePocketToolpath(project, finishOp('t1', true, direction))

  assert(
    !hasWarning(result.warnings, 'pocketFinishIslandWallTooTight'),
    `an island the cutter clears must not warn, got ${JSON.stringify(result.warnings)}`,
  )
  const worst = worstWallOvercut(result.moves, radius)
  assert(worst.depth <= ARC_TOLERANCE, `control must not overcut either, got ${worst.depth.toFixed(4)} mm`)

  // The ring is closed, so the island wall is finished on all four sides.
  const points = samplePoints(result.moves)
  const sides: Array<[string, (point: Point) => boolean]> = [
    ['left', (p) => Math.abs(p.x - (20 - radius)) < ARC_TOLERANCE && p.y > 17 && p.y < 23],
    ['right', (p) => Math.abs(p.x - (30 + radius)) < ARC_TOLERANCE && p.y > 17 && p.y < 23],
    ['bottom', (p) => Math.abs(p.y - (15 - radius)) < ARC_TOLERANCE && p.x > 22 && p.x < 28],
    ['top', (p) => Math.abs(p.y - (25 + radius)) < ARC_TOLERANCE && p.x > 22 && p.x < 28],
  ]
  for (const [name, onSide] of sides) {
    assert(points.some(onSide), `the island's ${name} wall must be finished when the cutter fits`)
  }
  console.log('island with room keeps its whole ring: PASSED')
}

// Both directions (issue #706): the cleanup runs are open and reach the wall
// one stepover further out than the ring, so reorienting them has to be checked
// against the reach guard, not assumed safe.
for (const direction of ['conventional', 'climb'] as const) {
  testRectIslandTooCloseToWall(direction)
  testAcuteIslandCleanupPastTheWall(direction)
  testIslandWithRoomIsUnchanged(direction)
}
console.log('\nAll pocketIslandWallClearance tests PASSED.')
