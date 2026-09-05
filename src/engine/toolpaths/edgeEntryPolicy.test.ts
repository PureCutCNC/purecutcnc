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
 * Tool ENTRY on edge routes (issue #708).
 *
 * Two things land together here, and the second is only possible because of
 * the first.
 *
 * `edge.ts` carried private copies of seven helpers that `pocket.ts` already
 * exported. Four were byte-identical, one differed only in its loop, and two
 * had DRIFTED: `pushRapidAndPlunge` was pocket's minus the `entryPolicy`
 * branch, which is the whole reason an edge route could not helix, and
 * `transitionToCutEntry` was pocket's minus its XY epsilon and minus the guard
 * that refuses to link from safe Z into a descending cut. So the fix is to
 * delete the fork, not to write a second entry implementation beside it — and
 * the first test here is the one that keeps it deleted.
 *
 * With pocket's motion layer in place the policy from #412 wires straight in,
 * and the XY lead #695 built and then gated behind `descentCanAffordALead` is
 * finally affordable: the lead stages the cutter in open, domain-validated air
 * off the wall, which is exactly the clearance a helix needs, and the helix
 * makes the axial bite per revolution small, which is what makes staging there
 * survivable. Neither is safe alone on an edge route.
 *
 * Run with: npx tsx src/engine/toolpaths/edgeEntryPolicy.test.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateEdgeRouteToolpath } from './edge'
import { helixAngularDirection, isEntryHandoffMove } from './entry'
import { flattenProfile } from './geometry'
import { applyTabsToEdgeRoute } from './tabs'
import { projectWithFeatures } from '../../test/projectFixtures'
import {
  circleProfile,
  defaultTool,
  newProject,
  rectProfile,
  type EntryStrategy,
  type Operation,
  type OperationKind,
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

const TOOL_DIAMETER = 6
const TOOL_RADIUS = TOOL_DIAMETER / 2

// ── Fixture ──────────────────────────────────────────────────────────
//
// A round boss to route around on the outside and a rectangular opening to
// route around on the inside — the same pair `xyLeadEdge.test.ts` uses, so the
// two files' claims are about the same geometry. Round outside and rectangular
// inside on purpose: the outside case exercises placement against a convex
// curve, the inside case against corners.

const BOSS = { x: 40, y: 40, r: 15 }
const HOLE = { x: 10, y: 10, w: 34, h: 26 }
/** Every level of the rough fixtures, at stepdown 2 over a 6 mm feature. */
const ROUGH_LEVELS = [-2, -4, -6]

function makeFlatEndmill(): Tool {
  return { ...defaultTool('mm', 1), id: 't1', name: 't1', diameter: TOOL_DIAMETER, defaultStepdown: 2 }
}

function circleFeature(
  id: string,
  centre: { x: number; y: number; r: number },
  operation: SketchFeature['operation'],
  zTop = 0,
  zBottom = -6,
): SketchFeature {
  return {
    id, name: id, kind: 'circle', folderId: null,
    sketch: {
      profile: circleProfile(centre.x, centre.y, centre.r),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation, z_top: zTop, z_bottom: zBottom, visible: true, locked: false,
  }
}

function rectFeature(
  id: string,
  box: { x: number; y: number; w: number; h: number },
  operation: SketchFeature['operation'],
): SketchFeature {
  return {
    id, name: id, kind: 'rect', folderId: null,
    sketch: {
      profile: rectProfile(box.x, box.y, box.w, box.h),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation, z_top: 0, z_bottom: -6, visible: true, locked: false,
  }
}

function edgeProject(features: SketchFeature[], tabs: Tab[] = []): Project {
  const project = projectWithFeatures(
    { ...newProject('edge-entry', 'mm'), tools: [makeFlatEndmill()] },
    features,
  )
  return { ...project, tabs }
}

const bossProject = (tabs: Tab[] = []): Project =>
  edgeProject([circleFeature('boss', BOSS, 'add')], tabs)
const holeProject = (): Project => edgeProject([rectFeature('hole', HOLE, 'subtract')])

function edgeOperation(
  kind: OperationKind,
  featureIds: string[],
  overrides: Partial<Operation> = {},
): Operation {
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
  edgeOperation('edge_route_outside', ['boss'], o)
const insideOperation = (o: Partial<Operation> = {}): Operation =>
  edgeOperation('edge_route_inside', ['hole'], o)

const RAMPED: EntryStrategy[] = ['helix', 'ramp']

// ── Move helpers ─────────────────────────────────────────────────────

/**
 * Descents that arrive at the start of a cut, and the depth each covers.
 *
 * A `plunge` straight into the first cutting move is the defect this issue
 * exists to remove: on a finish route `levels` is one entry, so that single
 * move is the whole depth of the wall.
 */
function descentsIntoCut(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((move, index) => {
    if (move.kind !== 'plunge' || move.from.z <= move.to.z) return false
    const next = moves[index + 1]
    return next !== undefined && (next.kind === 'cut' || next.kind === 'lead_in')
  })
}

/** Every point the cutter centre passes through on a descending entry move. */
function entrySamples(moves: ToolpathMove[], perMove = 8): Point[] {
  const samples: Point[] = []
  for (const move of moves) {
    if (move.kind !== 'lead_in') continue
    for (let step = 0; step <= perMove; step += 1) {
      const ratio = step / perMove
      samples.push({
        x: move.from.x + (move.to.x - move.from.x) * ratio,
        y: move.from.y + (move.to.y - move.from.y) * ratio,
      })
    }
  }
  return samples
}

/** The same, for the cutting moves — the baseline a containment claim is measured against. */
function cutSamples(moves: ToolpathMove[], perMove = 4): Point[] {
  const samples: Point[] = []
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    for (let step = 0; step <= perMove; step += 1) {
      const ratio = step / perMove
      samples.push({
        x: move.from.x + (move.to.x - move.from.x) * ratio,
        y: move.from.y + (move.to.y - move.from.y) * ratio,
      })
    }
  }
  return samples
}

/**
 * What "touching" means here, in project units.
 *
 * Clipper works on integers at `DEFAULT_CLIPPER_SCALE` (10 000 per unit), so a
 * tool-centre path and the profile it was offset from agree only to about a
 * tenth of a micron. One micron is ten of those and four orders below the
 * cutter's own boundary safety, so it separates "riding the boundary" from
 * "gouging" without ever calling rounding a gouge.
 */
const GEOMETRIC_TOLERANCE = 1e-3

/** The entry moves that live at or below `z`, i.e. the ones actually in stock. */
function entryMovesBelow(moves: ToolpathMove[], z: number): ToolpathMove[] {
  return moves.filter((move) => move.kind === 'lead_in'
    && (move.from.z <= z + 1e-9 || move.to.z <= z + 1e-9))
}

function warned(result: ToolpathResult, code: string): boolean {
  return result.warnings.some((warning) => warning.code === code)
}

function countKind(moves: ToolpathMove[], kind: string): number {
  return moves.filter((move) => move.kind === kind).length
}

function pointInRect(point: Point, box: { x: number; y: number; w: number; h: number }): boolean {
  return point.x >= box.x && point.x <= box.x + box.w
    && point.y >= box.y && point.y <= box.y + box.h
}

/** Euclidean distance from the point out to `box`; zero anywhere inside it. */
function distanceToRect(point: Point, box: { x: number; y: number; w: number; h: number }): number {
  return Math.hypot(
    Math.max(box.x - point.x, 0, point.x - (box.x + box.w)),
    Math.max(box.y - point.y, 0, point.y - (box.y + box.h)),
  )
}

/**
 * How far a cutter centred at `point` reaches into `box`; zero when it merely
 * grazes or misses.
 *
 * The true keep-out is the Minkowski sum of the rectangle with the cutter disc,
 * so its corners are ROUND — the same shape `expandedTabFootprints` builds, and
 * for the same reason. Growing the rectangle by a square instead would
 * overstate each corner by (sqrt(2) - 1) * radius and report a bite where the
 * cutter never touched the tab.
 */
function cutterBiteIntoRect(
  point: Point,
  box: { x: number; y: number; w: number; h: number },
): number {
  return Math.max(0, TOOL_RADIUS - distanceToRect(point, box))
}

/**
 * Distance from `point` out to `polygon`, negative inside it.
 *
 * Measured against the TESSELLATED profile the generator actually offsets, not
 * against an ideal circle: a 15 mm circle flattens to chords that sag 0.014 mm
 * inside its own radius, which is more than a containment claim's tolerance and
 * would make an ideal-circle reference report a gouge where the cut itself
 * runs.
 */
function distanceOutside(point: Point, polygon: Point[]): number {
  let nearest = Infinity
  let inside = false
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index]
    const b = polygon[(index + 1) % polygon.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSquared = dx * dx + dy * dy
    const ratio = lengthSquared > 0
      ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
      : 0
    nearest = Math.min(nearest, Math.hypot(point.x - (a.x + dx * ratio), point.y - (a.y + dy * ratio)))
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside ? -nearest : nearest
}

/** The retained outline of a circular feature, exactly as the generator sees it. */
function tessellatedCircle(centre: { x: number; y: number; r: number }): Point[] {
  return flattenProfile(circleProfile(centre.x, centre.y, centre.r)).points
}

// ── The fork stays deleted ───────────────────────────────────────────

/**
 * The seven helpers `edge.ts` used to keep its own copies of, plus the eighth
 * that only existed because one of them had drifted.
 */
const UNFORKED_HELPERS = [
  'contourStartPoint',
  'toClosedCutMoves',
  'toOpenCutMoves',
  'pushRapidAndPlunge',
  'retractToSafe',
  'transitionToCutEntry',
  'generateStepLevels',
] as const

function testTheMotionLayerIsNotForkedAgain() {
  console.log('Testing edge.ts still imports the motion layer rather than copying it...')
  const source = readFileSync(
    fileURLToPath(new URL('./edge.ts', import.meta.url)),
    'utf8',
  )

  for (const helper of UNFORKED_HELPERS) {
    // A local declaration is the fork coming back. The two that had drifted
    // cost this project a lead deferral (#695) and a `cut` move that descended
    // 29 mm from safe Z at cutting feed, so the guard is a test rather than a
    // comment asking politely.
    assert(!new RegExp(`\\bfunction\\s+${helper}\\s*\\(`).test(source),
      `edge.ts must not declare its own '${helper}' — import pocket's`)
    assert(new RegExp(`^\\s*${helper},\\s*$`, 'm').test(source),
      `edge.ts must import '${helper}'`)
  }

  // `edgeLinksAtDepth` existed only to mirror the drifted transition. With
  // pocket's in place, pocket's own predicate answers for edge too.
  assert(!source.includes('edgeLinksAtDepth'),
    'edgeLinksAtDepth is superseded by transitionLinksAtDepth')
  assert(source.includes('transitionLinksAtDepth'),
    'edge.ts uses pocket\'s at-depth-link predicate')
  console.log('the motion layer stays un-forked: PASSED')
}

/**
 * The one behaviour change a project with no entry strategy can see, and the
 * reason it is a fix rather than a regression.
 *
 * Edge's forked `transitionToCutEntry` linked with a `cut` move whenever the
 * next start was within a tool diameter — including when the cutter was sitting
 * at SAFE Z. On this fixture the obstacle fragments the -2 level into open
 * spans that each retract, then the -4 level's ring starts 5.2 mm away, and the
 * fork joined the two with a single `cut` move descending 29 mm at cutting
 * feed, off the wall path, through whatever happened to be there. Pocket's
 * version has always refused that; now edge's does too.
 */
function testDescendingLinksFromSafeZAreRefused() {
  console.log('Testing a link from safe Z is no longer a diagonal cut...')
  const project = edgeProject([
    circleFeature('boss', BOSS, 'add'),
    circleFeature('neighbour', { x: 26, y: 26, r: 8 }, 'add', 0, -3),
  ])
  const result = generateEdgeRouteToolpath(project, outsideOperation({ pass: 'rough' }))

  const descendingCuts = result.moves.filter((move) =>
    move.kind === 'cut' && Math.abs(move.from.z - move.to.z) > 1e-9 && move.from.z > move.to.z)
  const fromSafeZ = descendingCuts.filter((move) => move.from.z >= 0)
  assert(fromSafeZ.length === 0,
    `no cut move may start above the stock and descend (found ${fromSafeZ.length})`)

  // Positive control: the fixture really does reach the branch. Without the
  // retract there would be no rapid at safe Z between the -2 spans and -4.
  const safeZRapids = result.moves.filter((move) =>
    move.kind === 'rapid' && move.from.z === move.to.z && move.from.z > 0)
  assert(safeZRapids.length > 0, 'the fixture still travels between fragments at safe Z')
  console.log('descending links from safe Z: PASSED')
}

// ── The descent itself ───────────────────────────────────────────────

function testNoDescentReachesDepthInOnePlunge() {
  console.log('Testing a ramped entry replaces the descent on both sides...')
  for (const strategy of RAMPED) {
    for (const [label, project, operation] of [
      ['outside finish', bossProject(), outsideOperation({ entryStrategy: strategy })],
      ['outside rough', bossProject(), outsideOperation({ pass: 'rough', entryStrategy: strategy })],
      ['inside finish', holeProject(), insideOperation({ entryStrategy: strategy })],
      ['inside rough', holeProject(), insideOperation({ pass: 'rough', entryStrategy: strategy })],
    ] as const) {
      const asked = generateEdgeRouteToolpath(project, operation)
      const plunged = generateEdgeRouteToolpath(project, { ...operation, entryStrategy: 'plunge' })

      // The `plunge` baseline is the defect: one move from safe Z to depth.
      assert(descentsIntoCut(plunged.moves).length > 0,
        `${label}: the plunge baseline still descends straight into the cut`)
      assert(descentsIntoCut(asked.moves).length === 0,
        `${label} ${strategy}: no descent reaches cut depth in a single plunge`)
      assert(!warned(asked, 'entryStrategyFallback'),
        `${label} ${strategy}: and it did not have to fall back to get there`)
      assert(countKind(asked.moves, 'lead_in') > 0, `${label} ${strategy}: an entry was emitted`)
    }
  }
  console.log('no single-plunge descent: PASSED')
}

/**
 * Every level, not just the first. A roughing route re-enters the material at
 * each step level, and pocket's `transitionToCutEntry` sends the same-XY
 * descent between levels through the policy rather than plunging in place —
 * which is the branch that would silently leave levels 2..n plunging.
 */
function testEveryLevelIsEnteredThroughThePolicy() {
  console.log('Testing every level of a stepped route is entered, not plunged...')
  for (const strategy of RAMPED) {
    for (const [label, project, operation] of [
      ['outside', bossProject(), outsideOperation({ pass: 'rough', entryStrategy: strategy })],
      ['inside', holeProject(), insideOperation({ pass: 'rough', entryStrategy: strategy })],
    ] as const) {
      const result = generateEdgeRouteToolpath(project, operation)
      const cutLevels = new Set(result.moves
        .filter((move) => move.kind === 'cut' && Math.abs(move.from.z - move.to.z) < 1e-9)
        .map((move) => Number(move.to.z.toFixed(6))))
      assert(ROUGH_LEVELS.every((z) => cutLevels.has(z)),
        `${label}: the fixture cuts every level (${[...cutLevels].join(',')})`)

      for (const z of ROUGH_LEVELS) {
        const arrivals = result.moves.filter((move) =>
          move.kind === 'lead_in' && Math.abs(move.to.z - z) < 1e-9 && move.from.z > move.to.z + 1e-9)
        assert(arrivals.length > 0, `${label} ${strategy}: level ${z} is reached by a ramped entry`)
      }
      assert(descentsIntoCut(result.moves).length === 0,
        `${label} ${strategy}: and no level falls back to a plunge`)
    }
  }
  console.log('every level entered: PASSED')
}

// ── Where the entry is allowed to be ─────────────────────────────────

/**
 * The outside case is the one that is new to `entry.ts`'s call sites. An inside
 * route sweeps into a cavity the pocket generator already describes; an outside
 * route has no cavity, so the domain is built the other way up — the complement
 * of the retained part and of everything else standing in the Z span.
 *
 * Asserted on the CUTTER, not the tool centre: a centre that clears the boss by
 * two millimetres still buries a 6 mm cutter in it.
 */
function testTheOutsideEntryStaysOffThePartAndItsObstacles() {
  console.log('Testing an outside entry clears the boss and every obstacle...')
  const obstacle = { x: 40, y: 72, r: 7 }
  const project = edgeProject([
    circleFeature('boss', BOSS, 'add'),
    circleFeature('obstacle', obstacle, 'add'),
  ])

  for (const strategy of RAMPED) {
    const result = generateEdgeRouteToolpath(
      project,
      outsideOperation({ pass: 'rough', entryStrategy: strategy }),
    )
    const samples = entrySamples(result.moves)
    assert(samples.length > 0, `${strategy}: the route emitted an entry to check`)

    const bossOutline = tessellatedCircle(BOSS)
    const obstacleOutline = tessellatedCircle(obstacle)
    const clearanceOf = (points: Point[], outline: Point[]): number => points.reduce(
      (closest, point) => Math.min(closest, distanceOutside(point, outline) - TOOL_RADIUS),
      Infinity,
    )

    // The entry must not bite the boss any deeper than the CUT does. Stated
    // against the cut rather than against zero because the wall path and the
    // profile are two Clipper results that agree only to the integer scale, so
    // an absolute zero would be a claim about rounding, not about gouging.
    const entryClearance = clearanceOf(samples, bossOutline)
    const cutClearance = clearanceOf(cutSamples(result.moves), bossOutline)
    assert(entryClearance >= cutClearance - 1e-9,
      `${strategy}: the entry stays as clear of the boss as the cut does`
      + ` (entry ${entryClearance.toFixed(6)} mm, cut ${cutClearance.toFixed(6)} mm)`)

    // The obstacle is not cut at all, so this one is absolute: the cutter is
    // simply never inside it.
    const obstacleClearance = clearanceOf(samples, obstacleOutline)
    assert(obstacleClearance > -GEOMETRIC_TOLERANCE,
      `${strategy}: the cutter never enters the obstacle standing in the Z span`
      + ` (closest ${obstacleClearance.toFixed(6)} mm)`)
  }
  console.log('outside entry containment: PASSED')
}

/** The mirror claim inside: the cutter never leaves the opening it is cutting. */
function testTheInsideEntryStaysInsideTheOpening() {
  console.log('Testing an inside entry stays within the opening...')
  for (const strategy of RAMPED) {
    const result = generateEdgeRouteToolpath(
      holeProject(),
      insideOperation({ pass: 'rough', entryStrategy: strategy }),
    )
    const samples = entrySamples(result.moves)
    assert(samples.length > 0, `${strategy}: the route emitted an entry to check`)

    let closest = Infinity
    for (const sample of samples) {
      closest = Math.min(closest, Math.min(
        sample.x - (HOLE.x + TOOL_RADIUS),
        HOLE.x + HOLE.w - TOOL_RADIUS - sample.x,
        sample.y - (HOLE.y + TOOL_RADIUS),
        HOLE.y + HOLE.h - TOOL_RADIUS - sample.y,
      ))
    }
    assert(closest > -GEOMETRIC_TOLERANCE,
      `${strategy}: the cutter never leaves the opening (closest ${closest.toFixed(6)} mm)`)
  }
  console.log('inside entry containment: PASSED')
}

/**
 * Tabs are a keep-out for the entry exactly as they are for the lead, and for
 * the same mechanical reason: `applyTabsToEdgeRoute` only lifts PURE VERTICAL
 * moves and splits planar `cut` moves. A helix is neither, so a helix placed
 * over a tab is driven into with nothing downstream to correct it.
 */
function testTabsAreKeptOutOfTheEntry() {
  console.log('Testing a tab pushes the entry off itself...')
  const plain = generateEdgeRouteToolpath(
    bossProject(),
    outsideOperation({ pass: 'rough', entryStrategy: 'helix' }),
  )
  const natural = entrySamples(plain.moves)[0]
  assert(natural !== undefined, 'the untabbed route places an entry')

  // A tab planted on the natural entry, tall enough to stand at every level.
  const tab = {
    id: 'tab1', name: 'tab1',
    x: natural.x - 5, y: natural.y - 5, w: 10, h: 10,
    z_top: -1, shape: 'rect',
  } as Tab
  const box = { x: tab.x, y: tab.y, w: tab.w, h: tab.h }
  assert(pointInRect(natural, box), 'the fixture really does plant the tab on the entry')

  const project = bossProject([tab])
  const operation = outsideOperation({ pass: 'rough', entryStrategy: 'helix' })
  const routed = generateEdgeRouteToolpath(project, operation)
  const tabbed = applyTabsToEdgeRoute(project, operation, routed)

  // Below the tab top the tab is standing, so the cutter may not be over it.
  const worstBite = (moves: ToolpathMove[]): number => entrySamples(entryMovesBelow(moves, tab.z_top))
    .reduce((worst, sample) => Math.max(worst, cutterBiteIntoRect(sample, box)), 0)

  // Before: the untabbed helix is not merely touching the footprint, it is
  // deep inside it, so the assertion below cannot pass by accident.
  assert(worstBite(plain.moves) >= TOOL_RADIUS - GEOMETRIC_TOLERANCE,
    `without the keep-out the cutter sits wholly over the tab (${worstBite(plain.moves).toFixed(3)} mm)`)
  // After: at most tangent. Riding the boundary is correct — the loop already
  // carries the cutter's own clearance, so touching it is the cutter grazing
  // past the tab, not cutting into it.
  assert(worstBite(routed.moves) <= GEOMETRIC_TOLERANCE,
    `the entry is placed clear of the tab below its top (${worstBite(routed.moves).toFixed(6)} mm inside)`)

  // And the tab pass leaves the entry moves exactly as generated — which is
  // precisely why the keep-out above has to exist.
  const before = JSON.stringify(routed.moves.filter((move) => move.kind === 'lead_in'))
  const after = JSON.stringify(tabbed.moves.filter((move) => move.kind === 'lead_in'))
  assert(before === after, 'the tab pass does not adjust entry moves')
  console.log('tabs are kept out of the entry: PASSED')
}

/**
 * An outside helix must turn the other way round a boss than it does inside a
 * cavity, or a conventional cut climbs on the way in. That is what
 * `cutSide: 'external'` buys, and nothing else in this file would notice it
 * being wrong — the containment proofs pass either way, because a circle
 * traversed backwards occupies the same space.
 */
function testTheOutsideHelixTurnsTheExternalWay() {
  console.log('Testing an outside helix turns the external way...')
  for (const direction of ['conventional', 'climb'] as const) {
    const result = generateEdgeRouteToolpath(
      bossProject(),
      outsideOperation({ entryStrategy: 'helix', cutDirection: direction }),
    )
    // Signed area of the emitted helix in project space: its sign IS the
    // angular direction, and `helixAngularDirection` is the engine's own answer
    // for what that should be on this side.
    const arc = result.moves.filter((move) => move.kind === 'lead_in')
    assert(arc.length > 0, `${direction}: a helix was emitted`)
    let twice = 0
    for (const move of arc) {
      twice += (move.to.x - move.from.x) * (move.to.y + move.from.y)
    }
    const swept = Math.sign(-twice)
    assert(swept === helixAngularDirection(direction, 'external'),
      `${direction}: the helix sweeps the external way (${swept})`)
    assert(swept !== helixAngularDirection(direction, 'internal'),
      `${direction}: which is the opposite of a pocket's`)
  }
  console.log('outside helix direction: PASSED')
}

/**
 * A region mask fragments the wall into open spans whose first point is a
 * clipped intersection ON the wall path. That point is where the domain's
 * keep-out boundary also runs, and the two are separate Clipper results — so
 * without `WALL_PATH_TOUCH_TOLERANCE` the intersection lands tens of nanometres
 * on the wrong side and `pointInRegion` refuses the entry outright, dropping a
 * masked route back to a full-depth plunge with only a fallback warning.
 */
function testAMaskedRouteStillGetsItsEntry() {
  console.log('Testing a region-masked route still enters through the policy...')
  const project = edgeProject([
    circleFeature('boss', BOSS, 'add'),
    {
      id: 'mask', name: 'mask', kind: 'rect', folderId: null,
      sketch: {
        profile: rectProfile(52, 20, 8, 40),
        origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
      },
      operation: 'region', regionMaskMode: 'exclude',
      z_top: 0, z_bottom: -6, visible: true, locked: false,
    } as SketchFeature,
  ])
  const operation = edgeOperation('edge_route_outside', ['boss', 'mask'], {
    pass: 'rough', entryStrategy: 'helix',
  })
  const result = generateEdgeRouteToolpath(project, operation)

  // The mask really did fragment the ring — otherwise this proves nothing.
  assert(result.moves.some((move) => move.kind === 'cut'
    && Math.abs(move.from.x - 52) < 1e-6), 'the mask clips the ring at its boundary')
  assert(descentsIntoCut(result.moves).length === 0,
    'every masked span is entered through the policy')
  assert(!warned(result, 'entryStrategyFallback'),
    'and none of them had to fall back')
  console.log('masked route entry: PASSED')
}

/**
 * Where the domain really is too tight, the fallback ladder runs and SAYS so.
 * The fixture pinches the wall path against an obstacle's clearance, so the
 * open span that starts in that wedge has room for neither a helix nor a ramp.
 */
function testAnUnplaceableEntryFallsBackOutLoud() {
  console.log('Testing an unplaceable entry warns rather than descending quietly...')
  const project = edgeProject([
    circleFeature('boss', BOSS, 'add'),
    circleFeature('neighbour', { x: 63, y: 40, r: 5 }, 'add', 0, -3),
  ])
  for (const strategy of RAMPED) {
    const result = generateEdgeRouteToolpath(
      project,
      outsideOperation({ pass: 'rough', entryStrategy: strategy }),
    )
    const descents = descentsIntoCut(result.moves)
    assert(descents.length > 0, `${strategy}: this fixture is the pinched one`)
    assert(warned(result, 'entryStrategyFallback'),
      `${strategy}: a descent that could not be ramped is reported`)
    // The rest of the route still gets its entry — one pinched span does not
    // drop the whole operation back to plunging.
    assert(countKind(result.moves, 'lead_in') > 0,
      `${strategy}: the spans that fit still ramp in`)
  }
  console.log('unplaceable entry falls back out loud: PASSED')
}

// ── What must not change ─────────────────────────────────────────────

/**
 * Trochoidal edge roughing keeps its own entry. It helixes in away from the
 * wall and reaches the wall by widening orbits, so #412's policy has no descent
 * to replace there, and #708 deliberately never builds one for it.
 *
 * Asserted on the SIGNATURE of the #412 policy rather than on move counts: only
 * `entry.ts` marks a handoff move, and it marks exactly one per synthesized
 * entry. A count could match by coincidence; a handoff move cannot appear
 * unless the policy ran.
 *
 * (Deliberately NOT asserted by varying `entryRampAngle`: the trochoidal entry
 * reads that setting too, through its own helix, so it moves a trochoidal
 * program without #412 being involved at all.)
 */
function testTrochoidalRoughingNeverBuildsTheEntryPolicy() {
  console.log('Testing trochoidal roughing is untouched by the entry policy...')
  const project = bossProject()
  const trochoidal = generateEdgeRouteToolpath(project, outsideOperation({
    pass: 'rough', edgeStrategy: 'trochoidal', entryStrategy: 'helix',
    trochoidalCutWidth: TOOL_DIAMETER * 1.5, trochoidalAdvance: 0.3,
  }))
  assert(countKind(trochoidal.moves, 'lead_in') > 0, 'the trochoidal route does enter helically')
  assert(!trochoidal.moves.some((move) => isEntryHandoffMove(move)),
    'but not through the #412 policy — no synthesized entry hands off to the cut')
  assert(trochoidal.moves.some((move) => move.source === 'trochoidal-transition'),
    'it still descends through its own transition')

  // Control: a contour route on the same fixture does carry the signature, so
  // the assertion above is about trochoidal and not about the marker being
  // unreachable from here.
  const contour = generateEdgeRouteToolpath(
    project,
    outsideOperation({ pass: 'rough', entryStrategy: 'helix' }),
  )
  assert(contour.moves.some((move) => isEntryHandoffMove(move)),
    'a contour route does synthesize its entry')
  console.log('trochoidal never builds the entry policy: PASSED')
}

/**
 * `'plunge'`, and a project that never chose, stay exactly as they were. The
 * `transitionToCutEntry` re-baseline is deliberate and separate — it is pinned
 * by `testDescendingLinksFromSafeZAreRefused` above, on the only fixture in
 * this suite that reaches it.
 */
function testPlungeAndAbsentAreUnchangedAndIdentical() {
  console.log('Testing an unset entry strategy still plunges, exactly as before...')
  for (const [label, project, operation] of [
    ['outside finish', bossProject(), outsideOperation()],
    ['outside rough', bossProject(), outsideOperation({ pass: 'rough' })],
    ['inside finish', holeProject(), insideOperation()],
    ['inside rough', holeProject(), insideOperation({ pass: 'rough' })],
  ] as const) {
    const absent = generateEdgeRouteToolpath(project, operation)
    const explicit = generateEdgeRouteToolpath(project, { ...operation, entryStrategy: 'plunge' })
    assert(JSON.stringify(absent.moves) === JSON.stringify(explicit.moves),
      `${label}: absent and 'plunge' emit the same program`)
    assert(countKind(absent.moves, 'lead_in') === 0, `${label}: and no entry move appears`)
    assert(absent.warnings.length === 0, `${label}: and nothing is warned`)
    assert(descentsIntoCut(absent.moves).length > 0,
      `${label}: the legacy descent is still exactly one plunge per entry`)
  }
  console.log('plunge is unchanged: PASSED')
}

// ── The lead #695 built, now affordable ──────────────────────────────

/**
 * `descentCanAffordALead` is now the policy check #695 said it would become.
 * The measurement behind it has not changed — staging a lead off the wall of a
 * rough channel exactly `2r` wide moves the descent into virgin stock — but a
 * helix or ramp at the staging point is what makes that survivable.
 */
function testTheLeadArrivesWithTheRampedEntry() {
  console.log('Testing the XY lead is unlocked by a ramped entry, and only then...')
  for (const [label, project, operation] of [
    ['outside finish', bossProject(), outsideOperation()],
    ['inside finish', holeProject(), insideOperation()],
    ['outside rough', bossProject(), outsideOperation({ pass: 'rough' })],
  ] as const) {
    const withPlunge = generateEdgeRouteToolpath(project, { ...operation, xyLeadStrategy: 'arc' })
    assert(countKind(withPlunge.moves, 'lead_out') === 0,
      `${label}: a plunging route still declines the lead`)
    assert(warned(withPlunge, 'xyLeadNeedsRampedEntry'),
      `${label}: and still says why`)

    const withHelix = generateEdgeRouteToolpath(
      project,
      { ...operation, entryStrategy: 'helix', xyLeadStrategy: 'arc' },
    )
    assert(countKind(withHelix.moves, 'lead_out') > 0,
      `${label}: a helical entry earns the lead`)
    assert(!warned(withHelix, 'xyLeadNeedsRampedEntry'),
      `${label}: and the deferral warning is gone`)
  }
  console.log('the lead arrives with the ramped entry: PASSED')
}

try {
  testTheMotionLayerIsNotForkedAgain()
  testDescendingLinksFromSafeZAreRefused()
  testNoDescentReachesDepthInOnePlunge()
  testEveryLevelIsEnteredThroughThePolicy()
  testTheOutsideEntryStaysOffThePartAndItsObstacles()
  testTheInsideEntryStaysInsideTheOpening()
  testTheOutsideHelixTurnsTheExternalWay()
  testAMaskedRouteStillGetsItsEntry()
  testTabsAreKeptOutOfTheEntry()
  testAnUnplaceableEntryFallsBackOutLoud()
  testTrochoidalRoughingNeverBuildsTheEntryPolicy()
  testPlungeAndAbsentAreUnchangedAndIdentical()
  testTheLeadArrivesWithTheRampedEntry()
  console.log('\nAll edge-route entry-policy tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
