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
 * Global nearest-entry scheduling across seeded pockets and offset-tree
 * frontiers (issue #575).
 * Run with: npx tsx src/engine/toolpaths/seedScheduling.test.ts
 *
 * The defect this guards against: `seeded_offset` gave the scheduler one
 * candidate per seed stack but only one candidate per whole offset tree, so
 * the tree selected from its innermost entry drained ALL of its branches
 * before the remaining seed stacks could compete. On the committed fixture
 * the first planar level emitted seed stack #1, then the whole 21-branch
 * tree, then seed stacks #2 through #8. (Issue #576 changed how many branches
 * the tree has, so the count is no longer asserted; the shape is.)
 *
 * The assertions that matter:
 *
 *   - **interleaving** — at least one seed stack runs between two offset
 *     branches AND at least one offset branch runs between two seed stacks.
 *     The old schedule satisfies the first half (seed #1 sits before the
 *     tree block) but never the second, so either check alone could miss a
 *     relapse; together they pin the "seed -> whole tree -> remaining seeds"
 *     shape as gone.
 *   - **inner-first survives the frontier** — the first offset branch of the
 *     level reaches one stepover outside a seed island (a leaf ring), and the
 *     level's longest ring run is its last (the wall-side root), so parents
 *     only become eligible after their children complete. Leftover excursions
 *     (issue #576) trail the tree and are classified out of both claims.
 *   - **no coverage loss** — every seed stack still emits its full laps, and
 *     the seeded stream covers everything the plain offset pattern covers.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import ClipperLib from 'clipper-lib'

import {
  buildInsetRegions,
  buildOffsetRegionTree,
  generatePocketToolpath,
  planRegionSeedLeftovers,
} from './pocket'
import { planSeedCircles, seedStartRadius, type SeedCirclePlan } from './seedClearing'
import { cornerSmoothingRadius } from './offsetSmoothing'
import { resolvePocketRegions } from './resolver'
import { buildSweptCoverage } from './sweptCoverage'
import { normalizeProject } from '../../store/helpers/projectFormat'
import type { Operation, Point, Project } from '../../types/project'
import type { ToolpathMove } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

/** Distance from a point to a planned seed radius, for run classification. */
const SEED_RADIUS_TOLERANCE = 0.02

function loadFixture(): { project: Project; operation: Operation; toolRadius: number; stepover: number } {
  const project = normalizeProject(
    JSON.parse(readFileSync(join('src', 'engine', 'test-fixtures', 'another-pocket-test.camj'), 'utf8')) as Project,
  )
  const operation = project.operations.find((candidate) => candidate.id === 'op0036')
  assert(operation !== undefined && operation.kind === 'pocket', 'the fixture must contain pocket op0036')
  const tool = project.tools.find((candidate) => candidate.id === operation.toolRef)
  assert(tool !== undefined, 'the fixture operation must reference a tool')
  return {
    project,
    operation,
    toolRadius: tool.diameter / 2,
    stepover: tool.diameter * operation.stepover,
  }
}

/**
 * Seed plans exactly as `generateRoughBandMoves` plans them: the band
 * regions inset by tool radius + radial leave (zero here), with the island
 * join type the operation's `roundOutsideCorners` selects.
 */
function planSeeds(project: Project, operation: Operation, toolRadius: number, stepover: number): SeedCirclePlan[] {
  const resolved = resolvePocketRegions(project, operation)
  const islandJoinType = operation.roundOutsideCorners
    ? ClipperLib.JoinType.jtRound
    : ClipperLib.JoinType.jtMiter
  const centreRegions = resolved.bands.flatMap((band) =>
    band.regions.flatMap((region) =>
      buildInsetRegions(region, toolRadius, ClipperLib.JoinType.jtMiter, islandJoinType),
    ),
  )
  const startRadius = seedStartRadius(operation, toolRadius)
  return centreRegions.flatMap((region) => planSeedCircles(region, startRadius, stepover, toolRadius * 2))
}

/**
 * Exact vertices of the leftover excursions (issue #576), so the schedule
 * checks below can tell a cleanup excursion from a ring branch.
 *
 * Excursions are emitted raw — no smoothing, no tangent splice — so their
 * coordinates reach the move stream unchanged and an exact key matches.
 */
function leftoverVertexKeys(project: Project, operation: Operation, toolRadius: number, stepover: number): Set<string> {
  const resolved = resolvePocketRegions(project, operation)
  const islandJoinType = operation.roundOutsideCorners
    ? ClipperLib.JoinType.jtRound
    : ClipperLib.JoinType.jtMiter
  const startRadius = seedStartRadius(operation, toolRadius)
  const keys = new Set<string>()
  for (const band of resolved.bands) {
    for (const region of band.regions.flatMap((candidate) =>
      buildInsetRegions(candidate, toolRadius, ClipperLib.JoinType.jtMiter, islandJoinType))) {
      const plans = planSeedCircles(region, startRadius, stepover, toolRadius * 2)
      if (plans.length === 0) continue
      const seeded = buildOffsetRegionTree(
        { ...region, islands: [...region.islands, ...plans.map((plan) => plan.island)] },
        stepover,
        islandJoinType,
      )
      const tree = { region, children: seeded.children }
      for (const excursion of planRegionSeedLeftovers(
        tree,
        plans,
        stepover,
        toolRadius,
        islandJoinType,
        operation.cutDirection ?? 'conventional',
        cornerSmoothingRadius(operation.roundOutsideCorners, toolRadius, stepover),
      )) {
        for (const point of excursion.points) keys.add(`${point.x},${point.y}`)
      }
    }
  }
  return keys
}

const isLeftoverRun = (run: ToolpathMove[], keys: Set<string>): boolean =>
  keys.size > 0 && run.every((move) =>
    keys.has(`${move.from.x},${move.from.y}`) && keys.has(`${move.to.x},${move.to.y}`))

/** Maximal runs of consecutive cut moves at the first (topmost) planar level. */
function firstLevelRuns(moves: ToolpathMove[]): ToolpathMove[][] {
  const levelZ = moves
    .filter((move) => move.kind === 'cut' && Math.abs(move.from.z - move.to.z) < 1e-9)
    .map((move) => move.to.z)
    .reduce((max, z) => Math.max(max, z), Number.NEGATIVE_INFINITY)
  assert(levelZ !== Number.NEGATIVE_INFINITY, 'the fixture must emit planar cut moves')
  const runs: ToolpathMove[][] = []
  for (const move of moves) {
    const atLevel = move.kind === 'cut'
      && Math.abs(move.from.z - levelZ) < 1e-9
      && Math.abs(move.to.z - levelZ) < 1e-9
    if (atLevel) {
      if (runs.length === 0) runs.push([])
      runs[runs.length - 1].push(move)
    } else if (runs.length > 0 && runs[runs.length - 1].length > 0) {
      runs.push([])
    }
  }
  while (runs.length > 0 && runs[runs.length - 1].length === 0) runs.pop()
  return runs
}

const onSeedCircle = (plans: SeedCirclePlan[]) => (x: number, y: number): boolean =>
  plans.some((plan) => plan.radii.some((radius) =>
    Math.abs(Math.hypot(x - plan.centre.x, y - plan.centre.y) - radius) <= SEED_RADIUS_TOLERANCE,
  ))

function runKind(run: ToolpathMove[], onCircle: (x: number, y: number) => boolean): 'seed' | 'ring' {
  const seedMoves = run.filter((move) => onCircle(move.from.x, move.from.y) && onCircle(move.to.x, move.to.y)).length
  return seedMoves > run.length / 2 ? 'seed' : 'ring'
}

function runLength(run: ToolpathMove[]): number {
  return run.reduce((sum, move) => sum + Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y), 0)
}

function cutCentrelines(moves: ToolpathMove[]): Point[][] {
  return moves
    .filter((move) => move.kind === 'cut')
    .map((move) => [{ x: move.from.x, y: move.from.y }, { x: move.to.x, y: move.to.y }])
}

function testFrontierInterleavesSeedStacksAndOffsetBranches(): void {
  const { project, operation, toolRadius, stepover } = loadFixture()
  const plans = planSeeds(project, operation, toolRadius, stepover)
  assert(plans.length === 8, `the fixture must plan eight seed stacks, got ${plans.length}`)

  const { moves } = generatePocketToolpath(project, operation)
  const leftoverKeys = leftoverVertexKeys(project, operation, toolRadius, stepover)
  // Leftover excursions (issue #576) trail the tree at every level and are not
  // ring branches; the schedule claims below are about the tree, so they are
  // classified out rather than counted as rings.
  const runs = firstLevelRuns(moves).filter((run) => !isLeftoverRun(run, leftoverKeys))
  const onCircle = onSeedCircle(plans)
  const kinds = runs.map((run) => runKind(run, onCircle))
  const seedRuns = kinds.filter((kind) => kind === 'seed').length
  const ringRuns = kinds.filter((kind) => kind === 'ring').length

  // The fixture's first level is exactly its eight seed stacks plus its offset
  // branches, each contiguous run separate from the others.
  assert(seedRuns === 8, `every seed stack must be its own run, got ${seedRuns}`)
  assert(ringRuns > 0, `the tree must still emit offset branches, got ${ringRuns}`)

  // Interleaving, in both directions. The legacy "seed #1 -> whole tree ->
  // remaining seeds" shape satisfies ring-between-seeds (seed #1 sits before
  // the tree block) but never seed-between-rings, because every remaining
  // stack came after the tree. Together they pin the drained-tree shape gone.
  const seedIndexes = kinds.map((kind, index) => kind === 'seed' ? index : -1).filter((index) => index >= 0)
  const ringIndexes = kinds.map((kind, index) => kind === 'ring' ? index : -1).filter((index) => index >= 0)
  const ringBetweenSeeds = seedIndexes.some((index, n) =>
    n + 1 < seedIndexes.length
    && ringIndexes.some((ring) => index < ring && ring < seedIndexes[n + 1]),
  )
  const seedBetweenRings = ringIndexes.some((index, n) =>
    n + 1 < ringIndexes.length
    && seedIndexes.some((seed) => index < seed && seed < ringIndexes[n + 1]),
  )
  assert(ringBetweenSeeds, 'an offset branch must run between two seed stacks')
  assert(seedBetweenRings, 'a seed stack must run between two offset branches')

  // Inner-first survives the frontier. The first offset branch must be a leaf
  // that reaches the handoff — its nearest point to some seed centre sits one
  // stepover outside that seed's island (issue #576 moved that radius out from
  // `lastRadius` to `islandRadius`; how much of the branch's perimeter lies on
  // it is a property of the region shape, not of the schedule). And the
  // wall-side root ring is the longest ring of the pocket, so it must come
  // last.
  const firstRing = runs.findIndex((run) => runKind(run, onCircle) === 'ring')
  const handoffGap = (run: ToolpathMove[]): number => Math.min(...plans.map((plan) => Math.abs(
    Math.min(...run.flatMap((move) => [
      Math.hypot(move.from.x - plan.centre.x, move.from.y - plan.centre.y),
      Math.hypot(move.to.x - plan.centre.x, move.to.y - plan.centre.y),
    ])) - (plan.islandRadius + stepover),
  )))
  assert(
    handoffGap(runs[firstRing]) <= SEED_RADIUS_TOLERANCE,
    `the first offset branch must reach a seed handoff radius, off by ${handoffGap(runs[firstRing]).toFixed(4)}`,
  )
  const ringLengths = runs.map((run, index) => ({ index, kind: runKind(run, onCircle), length: runLength(run) }))
    .filter((entry) => entry.kind === 'ring')
  const longest = ringLengths.reduce((best, entry) => entry.length > best.length ? entry : best)
  const lastRing = ringLengths[ringLengths.length - 1]
  assert(
    longest.index === lastRing.index,
    `the longest (wall-side root) ring must be cut last, got run ${longest.index} of ${lastRing.index}`,
  )

  // No seed lap may go missing while the frontier reorders work.
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]
    let cutLength = 0
    for (const move of moves) {
      if (move.kind !== 'cut') continue
      if (Math.abs(move.from.z - move.to.z) > 1e-9) continue
      const onFrom = plan.radii.some((radius) =>
        Math.abs(Math.hypot(move.from.x - plan.centre.x, move.from.y - plan.centre.y) - radius) <= SEED_RADIUS_TOLERANCE)
      const onTo = plan.radii.some((radius) =>
        Math.abs(Math.hypot(move.to.x - plan.centre.x, move.to.y - plan.centre.y) - radius) <= SEED_RADIUS_TOLERANCE)
      if (onFrom && onTo) cutLength += Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
    }
    const expected = plan.radii.reduce((sum, radius) => sum + 2 * Math.PI * radius, 0)
    assert(
      cutLength >= expected * 0.995,
      `seed stack ${index} lost laps: cut ${cutLength.toFixed(3)} of ${expected.toFixed(3)}`,
    )
  }

  console.log(`frontier interleaving: PASSED (sequence ${kinds.map((kind) => kind === 'seed' ? 'S' : 'R').join('')})`)
}

function testFrontierKeepsOffsetCoverage(): void {
  const { project, operation, toolRadius } = loadFixture()
  const seeded = generatePocketToolpath(project, operation).moves
  const offset = generatePocketToolpath(project, { ...operation, pocketPattern: 'offset' }).moves

  const seededCoverage = buildSweptCoverage(cutCentrelines(seeded), toolRadius)
  const offsetCoverage = buildSweptCoverage(cutCentrelines(offset), toolRadius)

  const resolved = resolvePocketRegions(project, operation)
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const band of resolved.bands) {
    for (const region of band.regions) {
      for (const point of region.outer) {
        minX = Math.min(minX, point.x)
        minY = Math.min(minY, point.y)
        maxX = Math.max(maxX, point.x)
        maxY = Math.max(maxY, point.y)
      }
    }
  }

  let missed = 0
  for (let x = minX; x <= maxX; x += 0.05) {
    for (let y = minY; y <= maxY; y += 0.05) {
      if (offsetCoverage.covers(x, y) && !seededCoverage.covers(x, y)) {
        missed += 1
      }
    }
  }
  assert(missed === 0, `${missed} samples cleared by offset are left uncut by the frontier schedule`)
  console.log('frontier coverage: PASSED (nothing the offset pattern clears is lost)')
}

try {
  testFrontierInterleavesSeedStacksAndOffsetBranches()
  testFrontierKeepsOffsetCoverage()
  console.log('\nAll seedScheduling tests PASSED.')
} catch (error) {
  console.error(error)
  throw error
}
