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
 * Leftover probe for the seeded-to-offset handoff (issue #576).
 * Run with: npx tsx src/engine/toolpaths/seedLeftover.test.ts
 *
 * The extension is a machine-time optimisation and the probe is what keeps it
 * safe, so the claims here are in that order:
 *
 *   - **nothing the offset pattern clears is left behind**, over a matrix of
 *     seed-near-wall and seed-near-island fixtures at three stepovers, two
 *     radial leaves, and with corner rounding both off and on. Self-referential in the same way `pocketClearance` and
 *     `seedClearing` are: stock no round cutter can reach cancels on both
 *     sides. Zero samples, not a tolerance.
 *   - **the probe actually fires**, and the stream without its excursions
 *     FAILS the same check. Two of the fixtures strand stock without it; a
 *     probe that never fired would pass the matrix above while proving
 *     nothing, which is the failure mode `seedDiscUncovered` was built to
 *     avoid one issue earlier.
 *   - **an excursion cannot gouge** — every point of every one is inside the
 *     tool-centre region and clear of its islands, which follows from
 *     excursions being subpaths of the pre-extension tree, and is checked
 *     rather than argued.
 *   - **an open excursion plunges into swept material**, so it needs no
 *     helix or ramp budget.
 *   - **the handoff got cheaper**: every fixture's stream is shorter than the
 *     same fixture was immediately before this issue, excursions included. A
 *     path-length comparison against recorded geometry, not a timing
 *     assertion — the same inputs give the same millimetres on any machine.
 */

import ClipperLib from 'clipper-lib'

import {
  buildInsetRegions,
  buildOffsetRegionTree,
  generatePocketToolpath,
  planRegionSeedLeftovers,
  seedLeftoverCandidates,
  treeCutContours,
} from './pocket'
import { cornerSmoothingRadius } from './offsetSmoothing'
import { planSeedCircles, seedCircleContours, seedStartRadius, type SeedCirclePlan } from './seedClearing'
import { planSeedLeftovers, type SeedLeftoverExcursion } from './seedLeftover'
import { resolvePocketRegions } from './resolver'
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

const TOOL_DIAMETER = 6
const TOOL_RADIUS = TOOL_DIAMETER / 2

// ── fixtures ───────────────────────────────────────────────────────────────

function endmill(): Tool {
  return {
    ...defaultTool('mm', 1),
    id: 't1',
    name: `${TOOL_DIAMETER} mm endmill`,
    diameter: TOOL_DIAMETER,
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
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
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
    sketch: {
      profile: circleProfile(cx, cy, radius),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 0,
    z_bottom: -4,
    visible: true,
    locked: false,
  }
}

function pocketOperation(featureIds: string[], overrides: Partial<Operation>): Operation {
  return {
    id: 'seeded',
    name: 'seeded',
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
    pocketPattern: 'seeded_offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    entryStrategy: 'helix',
    entryHelixDiameterPercent: 80,
    ...overrides,
  }
}

function projectWith(features: SketchFeature[]): Project {
  return projectWithFeatures({ ...newProject('seed-leftover-test', 'mm'), tools: [endmill()] }, features)
}

interface Case {
  name: string
  features: SketchFeature[]
  overrides: Partial<Operation>
  /** Sampling window, the pocket's bounding box. */
  width: number
  height: number
}

const CASES: Case[] = [
  { name: '70x50 wall-tight', features: [rect('pocket', 0, 0, 70, 50)], overrides: {}, width: 70, height: 50 },
  { name: '70x50 fine stepover', features: [rect('pocket', 0, 0, 70, 50)], overrides: { stepover: 0.15 }, width: 70, height: 50 },
  { name: '70x50 coarse stepover', features: [rect('pocket', 0, 0, 70, 50)], overrides: { stepover: 0.6 }, width: 70, height: 50 },
  { name: '70x50 radial leave', features: [rect('pocket', 0, 0, 70, 50)], overrides: { stockToLeaveRadial: 0.5 }, width: 70, height: 50 },
  { name: '120x60 multi-seed', features: [rect('pocket', 0, 0, 120, 60)], overrides: {}, width: 120, height: 60 },
  {
    name: '120x60 multi-seed, leave',
    features: [rect('pocket', 0, 0, 120, 60)],
    overrides: { stockToLeaveRadial: 0.5 },
    width: 120,
    height: 60,
  },
  {
    name: 'seed near island',
    features: [rect('pocket', 0, 0, 80, 60), island('core', 55, 30, 6)],
    overrides: {},
    width: 80,
    height: 60,
  },
  {
    name: 'seed near island, coarse',
    features: [rect('pocket', 0, 0, 80, 60), island('core', 55, 30, 6)],
    overrides: { stepover: 0.6 },
    width: 80,
    height: 60,
  },
  // Rounding matters to the probe specifically: the coverage it judges against
  // is built from the RAW region contours, while the emitter smooths ring
  // corners, so a raw contour claims a corner tip the emitted path does not
  // sweep. These two are what keep that over-claim honest.
  {
    name: '70x50 rounded corners',
    features: [rect('pocket', 0, 0, 70, 50)],
    overrides: { roundOutsideCorners: true, roundLinkCorners: true, cleanWallCorners: true },
    width: 70,
    height: 50,
  },
  {
    name: 'seed near island, rounded',
    features: [rect('pocket', 0, 0, 80, 60), island('core', 55, 30, 6)],
    overrides: { roundOutsideCorners: true, cleanWallCorners: true },
    width: 80,
    height: 60,
  },
]

// ── helpers ────────────────────────────────────────────────────────────────

function cutCentrelines(moves: ToolpathMove[]): Point[][] {
  return moves
    .filter((move) => move.kind === 'cut' || move.kind === 'lead_in' || move.kind === 'lead_out')
    .map((move) => [{ x: move.from.x, y: move.from.y }, { x: move.to.x, y: move.to.y }])
}

/**
 * Samples the offset pattern clears and the given centrelines do not.
 *
 * A quarter-millimetre grid, which is under half the width of the thinnest
 * ridge the extension can open (`2*toolRadius - stepover` bounds it, and the
 * cap keeps that non-negative), so a stranded sliver cannot slip between rows.
 */
function samplesLost(reference: Point[][], candidate: Point[][], width: number, height: number): number {
  const referenceCoverage = buildSweptCoverage(reference, TOOL_RADIUS)
  const candidateCoverage = buildSweptCoverage(candidate, TOOL_RADIUS)
  let lost = 0
  for (let x = 0; x <= width; x += 0.25) {
    for (let y = 0; y <= height; y += 0.25) {
      if (referenceCoverage.covers(x, y) && !candidateCoverage.covers(x, y)) lost += 1
    }
  }
  return lost
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

interface SeededRegion {
  region: ResolvedPocketRegion
  plans: SeedCirclePlan[]
  tree: { region: ResolvedPocketRegion; children: ReturnType<typeof buildOffsetRegionTree>['children'] }
  stepover: number
  smoothRadius: number | undefined
  direction: 'climb' | 'conventional'
  excursions: SeedLeftoverExcursion[]
}

/**
 * Rebuild one case's seeded regions exactly as `generateRoughBandMoves` does,
 * so the probe under test sees the geometry production sees.
 */
function seededRegions(testCase: Case): SeededRegion[] {
  const project = projectWith(testCase.features)
  const operation = pocketOperation(testCase.features.map((feature) => feature.id), testCase.overrides)
  const stepover = TOOL_DIAMETER * (operation.stepover ?? 0.4)
  const leave = Math.max(0, operation.stockToLeaveRadial)
  const islandJoinType = operation.roundOutsideCorners
    ? ClipperLib.JoinType.jtRound
    : ClipperLib.JoinType.jtMiter
  const resolved = resolvePocketRegions(project, operation)
  const centreRegions = resolved.bands.flatMap((band) => band.regions.flatMap((region) =>
    buildInsetRegions(region, TOOL_RADIUS + leave, ClipperLib.JoinType.jtMiter, islandJoinType)))
  const startRadius = seedStartRadius(operation, TOOL_RADIUS)
  const seeded: SeededRegion[] = []
  for (const region of centreRegions) {
    const plans = planSeedCircles(region, startRadius, stepover, TOOL_DIAMETER, leave)
    if (plans.length === 0) continue
    const built = buildOffsetRegionTree(
      { ...region, islands: [...region.islands, ...plans.map((plan) => plan.island)] },
      stepover,
      islandJoinType,
    )
    const tree = { region, children: built.children }
    const smoothRadius = cornerSmoothingRadius(operation.roundOutsideCorners, TOOL_RADIUS, stepover)
    const direction = operation.cutDirection ?? 'conventional'
    seeded.push({
      region,
      plans,
      tree,
      stepover,
      smoothRadius,
      direction,
      excursions: planRegionSeedLeftovers(
        tree, plans, stepover, TOOL_RADIUS, islandJoinType, direction, smoothRadius,
      ),
    })
  }
  return seeded
}

// ── the unit the rest rests on ─────────────────────────────────────────────

function testProbeAnswersItsDegenerateInputs(): void {
  const square: Point[] = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }]

  assert(
    planSeedLeftovers([square], [], TOOL_RADIUS).length === 0,
    'nothing emitted means nothing to compare against, and re-cutting the candidates would double-cut',
  )
  assert(
    planSeedLeftovers([], [square], TOOL_RADIUS).length === 0,
    'no candidates means no excursions',
  )
  assert(
    planSeedLeftovers([square], [square], TOOL_RADIUS).length === 0,
    'a candidate the stream already cuts is covered by its own sweep',
  )

  // A candidate nothing has been near comes back whole, and CLOSED — there is
  // no swept vertex to plunge through, so it must take the entry policy.
  const faraway = planSeedLeftovers([square], [[{ x: 500, y: 500 }, { x: 520, y: 500 }]], TOOL_RADIUS)
  assert(faraway.length === 1, `an untouched candidate must come back whole, got ${faraway.length}`)
  assert(faraway[0].closed, 'an untouched candidate has no cleared start and must be emitted closed')

  console.log('probe degenerate inputs: PASSED')
}

// ── the claim that reaches the workpiece ───────────────────────────────────

function testNothingTheOffsetPatternClearsIsLeftBehind(): void {
  for (const testCase of CASES) {
    const project = projectWith(testCase.features)
    const featureIds = testCase.features.map((feature) => feature.id)
    const seeded = generatePocketToolpath(
      project, pocketOperation(featureIds, testCase.overrides),
    )
    const offset = generatePocketToolpath(
      project, pocketOperation(featureIds, { ...testCase.overrides, pocketPattern: 'offset' }),
    )
    assert(seeded.moves.length > 0 && offset.moves.length > 0, `${testCase.name} must produce moves`)
    const lost = samplesLost(
      cutCentrelines(offset.moves),
      cutCentrelines(seeded.moves),
      testCase.width,
      testCase.height,
    )
    assert(lost === 0, `${testCase.name}: ${lost} samples cleared by offset are left uncut by seeded_offset`)
  }
  console.log(`coverage parity: PASSED (${CASES.length} fixtures, 0 samples lost)`)
}

function testTheProbeFiresAndTheStreamNeedsIt(): void {
  // Falsification. The matrix above is satisfiable by a probe that never runs,
  // so at least one fixture must both produce excursions AND fail the same
  // coverage check when they are taken back out.
  let fired = 0
  let falsified = 0
  for (const testCase of CASES) {
    const regions = seededRegions(testCase)
    const excursions = regions.flatMap((entry) => entry.excursions)
    if (excursions.length === 0) continue
    fired += 1

    const emitted = regions.flatMap((entry) => [
      ...entry.plans.flatMap((plan) => seedCircleContours(plan, entry.stepover)),
      ...treeCutContours(entry.tree, {
        direction: entry.direction, smoothRadius: entry.smoothRadius, toolRadius: TOOL_RADIUS,
      }),
    ])
    const withExcursions = [...emitted, ...excursions.map((excursion) => excursion.points)]
    // The reference is the pre-extension tree — the shipped stream. Without the
    // excursions the extended stream must lose ground against it; with them it
    // must not.
    const baseline = regions.flatMap((entry) => [
      ...entry.plans.flatMap((plan) => seedCircleContours(plan, entry.stepover)),
      ...seedLeftoverCandidates(
        entry.region, entry.plans, entry.stepover, ClipperLib.JoinType.jtMiter, 'conventional',
      ),
    ])
    const without = samplesLost(baseline, emitted, testCase.width, testCase.height)
    const with_ = samplesLost(baseline, withExcursions, testCase.width, testCase.height)
    assert(
      with_ === 0,
      `${testCase.name}: excursions must close the gap, ${with_} samples still lost`,
    )
    if (without > 0) falsified += 1
  }
  assert(fired > 0, 'no fixture exercised the probe — the coverage matrix above would prove nothing')
  assert(
    falsified > 0,
    'no fixture LOSES stock without its excursions — the probe is firing but recovering nothing',
  )
  console.log(`probe falsification: PASSED (${fired} fixtures fired, ${falsified} strand stock without it)`)
}

function testExcursionsStayInsideTheToolCentreDomain(): void {
  let points = 0
  for (const testCase of CASES) {
    for (const entry of seededRegions(testCase)) {
      for (const excursion of entry.excursions) {
        for (const point of excursion.points) {
          points += 1
          assert(
            pointInPolygon(point.x, point.y, entry.region.outer),
            `${testCase.name}: an excursion left the region at (${point.x.toFixed(3)}, ${point.y.toFixed(3)})`,
          )
          for (const hole of entry.region.islands) {
            assert(
              !pointInPolygon(point.x, point.y, hole),
              `${testCase.name}: an excursion entered an island at (${point.x.toFixed(3)}, ${point.y.toFixed(3)})`,
            )
          }
        }
      }
    }
  }
  assert(points > 0, 'no excursion points were checked')
  console.log(`excursion containment: PASSED (${points} points inside the domain)`)
}

function testOpenExcursionsPlungeIntoSweptMaterial(): void {
  let open = 0
  for (const testCase of CASES) {
    for (const entry of seededRegions(testCase)) {
      if (entry.excursions.length === 0) continue
      const coverage = buildSweptCoverage([
        ...entry.plans.flatMap((plan) => seedCircleContours(plan, entry.stepover)),
        ...treeCutContours(entry.tree, {
          direction: entry.direction, smoothRadius: entry.smoothRadius, toolRadius: TOOL_RADIUS,
        }),
      ], TOOL_RADIUS)
      for (const excursion of entry.excursions) {
        if (excursion.closed) continue
        open += 1
        const start = excursion.points[0]
        const end = excursion.points[excursion.points.length - 1]
        assert(
          coverage.covers(start.x, start.y),
          `${testCase.name}: an open excursion starts in uncut stock at (${start.x.toFixed(3)}, ${start.y.toFixed(3)})`,
        )
        assert(
          coverage.covers(end.x, end.y),
          `${testCase.name}: an open excursion ends in uncut stock at (${end.x.toFixed(3)}, ${end.y.toFixed(3)})`,
        )
      }
    }
  }
  assert(open > 0, 'no open excursion was checked')
  console.log(`excursion entry: PASSED (${open} open excursions start and end in swept material)`)
}

/**
 * Cut length of each fixture's `seeded_offset` stream immediately before this
 * issue — the pre-extension island, no probe — measured through
 * `generatePocketToolpath` on this branch's fixtures.
 *
 * These are lengths, not durations: the same geometry comes out of the same
 * inputs on any machine, so there is nothing here to drift. The rule against
 * absolute budgets is about timing assertions, and this is not one.
 */
const PRE_EXTENSION_CUT_LENGTH: Record<string, number> = {
  '70x50 wall-tight': 3411.0,
  '70x50 fine stepover': 8777.6,
  '70x50 coarse stepover': 2989.9,
  '70x50 radial leave': 3328.6,
  '120x60 multi-seed': 7707.9,
  '120x60 multi-seed, leave': 8322.2,
  'seed near island': 5260.3,
  'seed near island, coarse': 4735.4,
  '70x50 rounded corners': 3499.8,
  'seed near island, rounded': 5425.2,
}

function testTheHandoffGotCheaper(): void {
  // The point of the whole issue. Every fixture must cut less than it did
  // before the extension — including the two that need excursions back, where
  // the recovery has to stay cheaper than the graze rings it replaced.
  const savings: string[] = []
  for (const testCase of CASES) {
    const before = PRE_EXTENSION_CUT_LENGTH[testCase.name]
    assert(before !== undefined, `${testCase.name} has no recorded pre-#576 length`)
    const project = projectWith(testCase.features)
    const { moves } = generatePocketToolpath(
      project, pocketOperation(testCase.features.map((feature) => feature.id), testCase.overrides),
    )
    const after = moves
      .filter((move) => move.kind === 'cut' || move.kind === 'lead_in' || move.kind === 'lead_out')
      .reduce((sum, move) => sum + Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y), 0)
    assert(
      after < before,
      `${testCase.name}: the handoff must get cheaper, ${after.toFixed(1)} mm against ${before.toFixed(1)} mm`,
    )
    savings.push(`${(100 * (before - after) / before).toFixed(1)}%`)
  }
  console.log(`handoff cost: PASSED (shorter on all ${CASES.length} fixtures: ${savings.join(', ')})`)
}

try {
  testProbeAnswersItsDegenerateInputs()
  testNothingTheOffsetPatternClearsIsLeftBehind()
  testTheProbeFiresAndTheStreamNeedsIt()
  testExcursionsStayInsideTheToolCentreDomain()
  testOpenExcursionsPlungeIntoSweptMaterial()
  testTheHandoffGotCheaper()
  console.log('\nAll seedLeftover tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
