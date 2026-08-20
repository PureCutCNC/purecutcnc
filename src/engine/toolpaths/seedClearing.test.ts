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
 * Seeded circle pocket clearing (issue #554).
 * Run with: npx tsx src/engine/toolpaths/seedClearing.test.ts
 *
 * The assertions that matter here are the two that reach the workpiece:
 *
 *   - **no circle is ever clipped** — every emitted point is inside the
 *     tool-centre region, which is what makes phase 1 free of containment
 *     tests and free of Clipper;
 *   - **the seed disc is fully cleared** — checked by rasterising the disc
 *     against the swept envelope of the circles alone, not by trusting the
 *     schedule. That one is falsifiable: it is re-run with the first radius
 *     deliberately pushed past the tool radius and must FAIL, which is what
 *     makes `r0 <= toolRadius` a tested rule rather than a comment.
 *
 * Plus the claim that lets this ship: when no seed fits, the seeded pattern's
 * move stream is byte-identical to `offset` — asserted through real generation,
 * not by reading the gate.
 */

import {
  planSeedCircles,
  seedArcTolerance,
  seedCircleContour,
  seedCircleContours,
  seedStartRadius,
} from './seedClearing'
import { buildInsetRegions, buildOffsetRegionTree, generatePocketToolpath } from './pocket'
import { buildSweptCoverage } from './sweptCoverage'
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
import type { ResolvedPocketRegion, ToolpathMove } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

// ── fixtures ───────────────────────────────────────────────────────────────

function endmill(id: string, diameter: number): Tool {
  return {
    ...defaultTool('mm', 1),
    id,
    name: `${diameter} mm endmill`,
    diameter,
    defaultStepdown: 2,
    defaultStepover: 0.4,
  }
}

function rect(id: string, x: number, y: number, w: number, h: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: { profile: rectProfile(x, y, w, h), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: 0,
    z_bottom: -4,
    visible: true,
    locked: false,
  }
}

function island(id: string, cx: number, cy: number, radius: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'circle',
    folderId: null,
    sketch: { profile: circleProfile(cx, cy, radius), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'add',
    z_top: 0,
    z_bottom: -4,
    visible: true,
    locked: false,
  }
}

function pocketOperation(id: string, featureIds: string[], overrides: Partial<Operation>): Operation {
  return {
    id,
    name: id,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: 't1',
    stepdown: 4,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18_000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    ...overrides,
  }
}

function projectWith(features: SketchFeature[], toolDiameter = 6): Project {
  const base = newProject('seed-clearing-test', 'mm')
  return projectWithFeatures({ ...base, tools: [endmill('t1', toolDiameter)] }, features)
}

/** A tool-centre region given directly, so the schedule is checked on exact geometry. */
function rectRegion(width: number, height: number): ResolvedPocketRegion {
  return {
    outer: [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }],
    islands: [],
    targetFeatureIds: [],
    islandFeatureIds: [],
  }
}

function pointInPolygon(x: number, y: number, contour: Point[]): boolean {
  let inside = false
  for (let index = 0; index < contour.length; index += 1) {
    const a = contour[index]
    const b = contour[(index + 1) % contour.length]
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

function cutCentrelines(moves: ToolpathMove[]): Point[][] {
  return moves
    .filter((move) => move.kind === 'cut' || move.kind === 'lead_in' || move.kind === 'lead_out')
    .map((move) => [{ x: move.from.x, y: move.from.y }, { x: move.to.x, y: move.to.y }])
}

// ── the schedule ───────────────────────────────────────────────────────────

function testScheduleStopsAtTheFirstRadiusThatDoesNotFit(): void {
  const region = rectRegion(80, 40)
  const stepover = 2.4
  const plan = planSeedCircles(region, 3, stepover, 6)
  assert(plan !== null, 'a 80x40 tool-centre region must hold a seed')

  // Inscribed radius of a 80x40 rectangle is 20, under-reported by the search.
  assert(plan.maxRadius <= 20 + 1e-9, `maxRadius must never over-report, got ${plan.maxRadius}`)
  assert(plan.maxRadius > 19.9, `maxRadius must be tight, got ${plan.maxRadius}`)

  assert(plan.radii[0] === 3, 'the schedule starts at r0')
  for (let index = 1; index < plan.radii.length; index += 1) {
    const delta = plan.radii[index] - plan.radii[index - 1]
    assert(Math.abs(delta - stepover) < 1e-9, `radii step by exactly one stepover, got ${delta}`)
  }
  const last = plan.radii[plan.radii.length - 1]
  assert(last === plan.lastRadius, 'lastRadius is the last scheduled radius')
  assert(last <= plan.maxRadius, 'every scheduled radius fits')
  assert(last + stepover > plan.maxRadius, 'the schedule stops at the FIRST radius that does not fit')
  console.log(`schedule: PASSED (${plan.radii.length} circles, ${plan.radii[0]} to ${last}, Rmax ${plan.maxRadius.toFixed(4)})`)
}

function testNoCircleIsEverClipped(): void {
  const region: ResolvedPocketRegion = {
    ...rectRegion(80, 40),
    islands: [seedCircleContour({ x: 62, y: 20 }, 5, 0.01)],
  }
  const plan = planSeedCircles(region, 3, 2.4, 6)
  assert(plan !== null, 'the island region must still hold a seed')

  for (const contour of seedCircleContours(plan, 2.4)) {
    for (const point of contour) {
      assert(
        pointInPolygon(point.x, point.y, region.outer),
        `a circle left the region at (${point.x.toFixed(3)}, ${point.y.toFixed(3)})`,
      )
      for (const hole of region.islands) {
        assert(
          !pointInPolygon(point.x, point.y, hole),
          `a circle entered an island at (${point.x.toFixed(3)}, ${point.y.toFixed(3)})`,
        )
      }
    }
  }
  // The seed must have moved away from the island rather than shrinking around it.
  assert(plan.centre.x < 40, `the seed relocates away from the island, centred at x=${plan.centre.x.toFixed(2)}`)
  console.log(`no clipping: PASSED (${plan.radii.length} circles clear of the island)`)
}

/**
 * The seed disc is cleared by the circles alone. Rasterised against the swept
 * envelope, not inferred from the schedule.
 *
 * `startRadius` is a parameter so the same check can be re-run past the tool
 * radius and be required to FAIL — an always-satisfiable coverage test proves
 * nothing about the rule it is meant to pin.
 */
function seedDiscUncovered(startRadius: number, toolRadius: number): number {
  const region = rectRegion(80, 40)
  const stepover = toolRadius * 0.8
  const plan = planSeedCircles(region, startRadius, stepover, toolRadius * 2)
  assert(plan !== null, 'the plan must exist for the coverage check')
  const coverage = buildSweptCoverage(seedCircleContours(plan, stepover), toolRadius)

  let uncovered = 0
  const step = toolRadius / 6
  for (let x = -plan.lastRadius; x <= plan.lastRadius; x += step) {
    for (let y = -plan.lastRadius; y <= plan.lastRadius; y += step) {
      if (Math.hypot(x, y) > plan.lastRadius) continue
      if (!coverage.covers(plan.centre.x + x, plan.centre.y + y)) uncovered += 1
    }
  }
  return uncovered
}

function testSeedDiscIsFullyCleared(): void {
  const toolRadius = 3
  const uncovered = seedDiscUncovered(seedStartRadius(
    pocketOperation('helix', [], { entryStrategy: 'helix', entryHelixDiameterPercent: 80 }),
    toolRadius,
  ), toolRadius)
  assert(uncovered === 0, `${uncovered} samples of the seed disc were left uncut`)

  // Falsification: a first circle beyond the tool radius cannot reach its own
  // centre, so the same check must fail. Without this the test above passes on
  // any schedule that happens to start small.
  const broken = seedDiscUncovered(toolRadius * 1.5, toolRadius)
  assert(broken > 0, 'the coverage check must FAIL when r0 exceeds the tool radius')
  console.log(`seed disc cleared: PASSED (0 uncut; ${broken} uncut when r0 > toolRadius)`)
}

function testStartRadiusNeverExceedsToolRadius(): void {
  const toolRadius = 3
  for (const percent of [1, 40, 80, 100, 150, 0]) {
    const operation = pocketOperation('helix', [], {
      entryStrategy: 'helix',
      entryHelixDiameterPercent: percent,
    })
    const radius = seedStartRadius(operation, toolRadius)
    assert(radius > 0, `helix at ${percent}% must yield a positive start radius`)
    assert(radius <= toolRadius + 1e-12, `helix at ${percent}% must not exceed the tool radius, got ${radius}`)
  }
  for (const strategy of ['plunge', 'ramp', undefined] as const) {
    const operation = pocketOperation('entry', [], { entryStrategy: strategy })
    assert(
      seedStartRadius(operation, toolRadius) === toolRadius,
      `${strategy ?? 'absent'} entry clears nothing circular, so the schedule starts at the tool radius`,
    )
  }
  assert(seedStartRadius(pocketOperation('x', [], {}), 0) === 0, 'a degenerate tool yields no schedule')
  console.log('start radius: PASSED')
}

function testTessellationTracksTheTrueCircle(): void {
  const tolerance = seedArcTolerance(2.4)
  for (const radius of [1, 5, 30]) {
    const contour = seedCircleContour({ x: 7, y: -3 }, radius, tolerance)
    assert(contour.length >= 24, `radius ${radius} must have at least 24 points`)
    for (const point of contour) {
      const error = Math.abs(Math.hypot(point.x - 7, point.y + 3) - radius)
      assert(error < 1e-9, `every point must lie ON the circle, off by ${error}`)
    }
    // Sagitta of the widest chord must respect the tolerance, which is what
    // makes the emitted polyline recoverable as a true arc.
    let maxSagitta = 0
    for (let index = 0; index < contour.length; index += 1) {
      const a = contour[index]
      const b = contour[(index + 1) % contour.length]
      const midX = (a.x + b.x) / 2
      const midY = (a.y + b.y) / 2
      maxSagitta = Math.max(maxSagitta, radius - Math.hypot(midX - 7, midY + 3))
    }
    assert(maxSagitta <= tolerance + 1e-12, `radius ${radius} sagitta ${maxSagitta} exceeds ${tolerance}`)
  }
  console.log('tessellation: PASSED')
}

function testHandoffLandsOneStepoverOutsideTheSeed(): void {
  const region = rectRegion(80, 40)
  const stepover = 2.4
  const plan = planSeedCircles(region, 3, stepover, 6)
  assert(plan !== null, 'the plan must exist')

  const tree = buildOffsetRegionTree(
    { ...region, islands: [...region.islands, plan.island] },
    stepover,
  )
  // The schedule always grows until it touches the inscribed radius, so the
  // seed reaches the wall somewhere and there is no closed ring around it —
  // what remains are the lobes the disc did not reach. The property that
  // matters is radial, not topological: because the circle is injected in
  // TOOL-CENTRE space and `buildInsetRegions` expands islands by exactly one
  // stepover, the nearest point of everything phase 2 still has to cut sits at
  // `lastRadius + stepover`. That is the claim, and it needs no radius
  // conversion anywhere to hold.
  const childPoints = tree.children.flatMap((child) => child.region.outer)
  assert(childPoints.length > 0, 'the tree must leave lobes for phase 2')
  const nearest = childPoints.reduce(
    (min, point) => Math.min(min, Math.hypot(point.x - plan.centre.x, point.y - plan.centre.y)),
    Infinity,
  )
  assert(
    Math.abs(nearest - (plan.lastRadius + stepover)) < stepover * 0.05,
    `phase 2 must start at ${(plan.lastRadius + stepover).toFixed(3)} from the seed centre, got ${nearest.toFixed(3)}`,
  )
  console.log(`handoff: PASSED (seed ${plan.lastRadius.toFixed(2)} -> phase 2 at ${nearest.toFixed(2)}, one stepover out)`)
}

// ── integration ────────────────────────────────────────────────────────────

function testSeededStreamEmitsCirclesAndClearsEverything(): void {
  const project = projectWith([rect('pocket', 0, 0, 70, 50)])
  const base = pocketOperation('seeded', ['pocket'], { entryStrategy: 'helix', entryHelixDiameterPercent: 80 })
  const offset = generatePocketToolpath(project, base)
  const seeded = generatePocketToolpath(project, { ...base, pocketPattern: 'seeded_offset' })

  assert(offset.moves.length > 0, 'the offset baseline must produce moves')
  assert(seeded.moves.length > 0, 'the seeded pattern must produce moves')
  assert(seeded.moves.length !== offset.moves.length, 'the seeded pattern must change the stream')

  // The seed centre of a 70x50 pocket is its middle. Some cut move must run on
  // a circle about it — the feature is present in the output, not just planned.
  const centre = { x: 35, y: 25 }
  const onSameCircle = seeded.moves.filter((move) => {
    if (move.kind !== 'cut') return false
    const from = Math.hypot(move.from.x - centre.x, move.from.y - centre.y)
    const to = Math.hypot(move.to.x - centre.x, move.to.y - centre.y)
    return Math.abs(from - to) < 1e-6 && from > 1
  })
  assert(onSameCircle.length > 40, `expected concentric circle moves about the seed, got ${onSameCircle.length}`)

  // Nothing the offset pattern cleared may be left behind. Self-referential,
  // like `pocketClearance.test.ts`: whatever a round cutter can never reach
  // cancels out on both sides.
  const toolRadius = 3
  const offsetCoverage = buildSweptCoverage(cutCentrelines(offset.moves), toolRadius)
  const seededCoverage = buildSweptCoverage(cutCentrelines(seeded.moves), toolRadius)
  let missed = 0
  for (let x = 0; x <= 70; x += 0.5) {
    for (let y = 0; y <= 50; y += 0.5) {
      if (offsetCoverage.covers(x, y) && !seededCoverage.covers(x, y)) missed += 1
    }
  }
  assert(missed === 0, `${missed} samples cleared by offset are left uncut by the seeded pattern`)
  console.log(`seeded integration: PASSED (${onSameCircle.length} circle moves, 0 samples lost)`)
}

function testSeedIsNotCutTwice(): void {
  const project = projectWith([rect('pocket', 0, 0, 70, 50)])
  const seeded = generatePocketToolpath(project, pocketOperation('seeded', ['pocket'], {
    pocketPattern: 'seeded_offset',
    entryStrategy: 'helix',
    entryHelixDiameterPercent: 80,
  }))

  const region = buildInsetRegions(
    { outer: [{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 50 }, { x: 0, y: 50 }], islands: [], targetFeatureIds: [], islandFeatureIds: [] },
    3,
  )[0]
  const plan = planSeedCircles(region, seedStartRadius(
    pocketOperation('helix', [], { entryStrategy: 'helix', entryHelixDiameterPercent: 80 }), 3,
  ), 2.4, 6)
  assert(plan !== null, 'the plan must exist')

  // Cut length lying on the seed circle, at one Z level. One lap, not two:
  // phase 1 cuts it, and the root of the tree must not cut it again.
  const onSeed = (x: number, y: number): boolean =>
    Math.abs(Math.hypot(x - plan.centre.x, y - plan.centre.y) - plan.lastRadius) <= 0.02
  const levelZ = seeded.moves.reduce((min, move) => Math.min(min, move.to.z), 0)
  let length = 0
  for (const move of seeded.moves) {
    if (move.kind !== 'cut') continue
    if (Math.abs(move.from.z - levelZ) > 1e-9 || Math.abs(move.to.z - levelZ) > 1e-9) continue
    if (!onSeed(move.from.x, move.from.y) || !onSeed(move.to.x, move.to.y)) continue
    length += Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
  }
  const lap = 2 * Math.PI * plan.lastRadius
  assert(length > lap * 0.9, `the seed circle must be cut, got ${length.toFixed(2)} of ${lap.toFixed(2)}`)
  assert(length < lap * 1.5, `the seed circle must be cut ONCE, got ${length.toFixed(2)} of ${lap.toFixed(2)}`)
  console.log(`no duplicate lap: PASSED (${length.toFixed(2)} vs one lap ${lap.toFixed(2)})`)
}

/**
 * When no seed fits, `seeded_offset` must be byte-identical to `offset`.
 *
 * An 11.6 mm-wide pocket cut with a 6 mm tool leaves a 5.6 mm-wide tool-centre
 * region, whose inscribed radius (2.8) is under the tool radius (3), so the
 * schedule is empty. A 10% stepover and a four-level stepdown still fill that
 * region with rings, so this compares a stream of real size rather than the
 * couple of moves a merely narrow slot would produce.
 */
function testNoSeedFallsBackByteIdentical(): void {
  const project = projectWith([rect('narrow', 0, 0, 120, 11.6)])
  const base = pocketOperation('narrow', ['narrow'], {
    stepover: 0.1,
    stepdown: 1,
    roundOutsideCorners: true,
    pocketSlotFeedPercent: 60,
  })
  const offset = generatePocketToolpath(project, base)
  const seeded = generatePocketToolpath(project, { ...base, pocketPattern: 'seeded_offset' })

  assert(offset.moves.length > 0, 'the narrow pocket must still produce moves')
  assert(
    seeded.moves.length === offset.moves.length,
    `move count must match: offset ${offset.moves.length}, seeded ${seeded.moves.length}`,
  )
  for (let index = 0; index < offset.moves.length; index += 1) {
    const a = offset.moves[index]
    const b = seeded.moves[index]
    assert(
      a.kind === b.kind
        && a.from.x === b.from.x && a.from.y === b.from.y && a.from.z === b.from.z
        && a.to.x === b.to.x && a.to.y === b.to.y && a.to.z === b.to.z
        && (a.feedScale ?? null) === (b.feedScale ?? null),
      `move ${index} differs between offset and an unseeded seeded_offset`,
    )
  }
  console.log(`no-seed fallback: PASSED (${offset.moves.length} moves identical)`)
}

function testParallelAndIslandsAreUnaffected(): void {
  const project = projectWith([rect('pocket', 0, 0, 70, 50)])
  const base = pocketOperation('parallel', ['pocket'], { pocketPattern: 'parallel' })
  const first = generatePocketToolpath(project, base)
  const second = generatePocketToolpath(project, base)
  assert(first.moves.length === second.moves.length, 'parallel generation must be deterministic')

  // An island region still seeds, and still never crosses the island.
  const withIsland = projectWith([rect('pocket', 0, 0, 70, 50), island('core', 35, 25, 8)])
  const seeded = generatePocketToolpath(withIsland, pocketOperation('seeded', ['pocket', 'core'], {
    pocketPattern: 'seeded_offset',
  }))
  assert(seeded.moves.length > 0, 'a seeded pocket with an island must produce moves')
  for (const move of seeded.moves) {
    if (move.kind !== 'cut') continue
    const distance = Math.hypot(move.to.x - 35, move.to.y - 25)
    assert(distance > 8 + 3 - 1e-6, `a cut entered the island, tool centre at ${distance.toFixed(3)}`)
  }
  console.log('parallel + island: PASSED')
}

try {
  testScheduleStopsAtTheFirstRadiusThatDoesNotFit()
  testNoCircleIsEverClipped()
  testSeedDiscIsFullyCleared()
  testStartRadiusNeverExceedsToolRadius()
  testTessellationTracksTheTrueCircle()
  testHandoffLandsOneStepoverOutsideTheSeed()
  testSeededStreamEmitsCirclesAndClearsEverything()
  testSeedIsNotCutTwice()
  testNoSeedFallsBackByteIdentical()
  testParallelAndIslandsAreUnaffected()
  console.log('\nAll seedClearing tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
