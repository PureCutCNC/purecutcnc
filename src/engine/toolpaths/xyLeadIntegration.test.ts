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
 * Integration tests for tangent-arc leads on generated streams (issue #695).
 *
 * The headline is `testNoDescentLandsOnAFinishedWall`: the defect this feature
 * exists for is the cutter reaching a wall by plunging onto it, which rubs a
 * witness line down a surface that stays in the part. Everything else here —
 * composition with each Z entry, domain containment, the constant feed, the
 * arc-fit round trip, the `stockToLeaveRadial` gate, and byte-identity for
 * operations that did not opt in — supports that one claim.
 *
 * Run with: npx tsx src/engine/toolpaths/xyLeadIntegration.test.ts
 */

import { generatePocketToolpath, buildInsetRegions } from './pocket'
import { generateSurfaceCleanToolpath } from './surface'
import { generateRoughSurfaceToolpath } from './roughSurface'
import { resolvePocketRegions } from './resolver'
import { buildOffsetDomainCheck } from './tangentLink'
import { optimizeLinearMoves } from './linearMoveOptimization'
import { fitArcsInMachineMoves } from '../gcode/arcFitting'
import { normalizeOperation } from '../../store/helpers/normalize'
import { normalizeToolForProject } from './geometry'
import { projectWithFeatures } from '../../test/projectFixtures'
import {
  circleProfile,
  defaultTool,
  newProject,
  rectProfile,
  type EntryStrategy,
  type Operation,
  type Point,
  type Project,
  type SketchFeature,
  type Tool,
} from '../../types/project'
import type { PocketToolpathResult, ToolpathMove, ToolpathPoint } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

const LEAD_KINDS = new Set(['lead_in', 'lead_out'])

function countKind(moves: ToolpathMove[], kind: string): number {
  return moves.filter((move) => move.kind === kind).length
}

function unitDirection(move: ToolpathMove): Point {
  const dx = move.to.x - move.from.x
  const dy = move.to.y - move.from.y
  const length = Math.hypot(dx, dy)
  return { x: dx / length, y: dy / length }
}

function angleBetween(a: Point, b: Point): number {
  return Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y)))
}

// ── Fixtures ─────────────────────────────────────────────────────────

function makeFlatEndmill(id = 't1', diameter = 6): Tool {
  return { ...defaultTool('mm', 1), id, name: id, diameter, defaultStepdown: 2, defaultStepover: 0.4 }
}

function makeRect(id: string, x: number, y: number, w: number, h: number, operation: 'add' | 'subtract' | 'region' = 'subtract'): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: { profile: rectProfile(x, y, w, h), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation,
    z_top: operation === 'region' ? 0 : 0,
    z_bottom: operation === 'region' ? 0 : -4,
    visible: true,
    locked: false,
  }
}

function makeCircleIsland(id: string, cx: number, cy: number, radius: number): SketchFeature {
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

function pocketOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'op1',
    name: 'op',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    ...overrides,
  }
}

function islandPocket(): { project: Project; operation: Operation } {
  const project = projectWithFeatures(
    { ...newProject('xy-lead', 'mm'), tools: [makeFlatEndmill()] },
    [makeRect('p1', 0, 0, 60, 60), makeCircleIsland('i1', 30, 30, 8)],
  )
  return { project, operation: pocketOperation() }
}

/**
 * How far a tool-centre sits from the nearest WALL CONTOUR of `islandPocket` —
 * the 60 x 60 pocket and its r=8 island, cut with a 6 mm tool. Zero means the
 * point is on the finished wall's own path.
 */
function wallDistance(point: ToolpathPoint): number {
  const toOuterWall = Math.min(point.x, 60 - point.x, point.y, 60 - point.y) - 3
  const toIslandWall = Math.hypot(point.x - 30, point.y - 30) - (8 + 3)
  return Math.min(Math.abs(toOuterWall), Math.abs(toIslandWall))
}

/** Descents that land on a cut, and how many of those land on a wall contour. */
function descentsOntoWalls(moves: ToolpathMove[]): { total: number; onWall: number } {
  let total = 0
  let onWall = 0
  moves.forEach((move, index) => {
    if (move.kind !== 'plunge' || move.from.z <= move.to.z) return
    const next = moves[index + 1]
    if (!next || next.kind !== 'cut') return
    if (Math.abs(next.from.x - move.to.x) > 1e-9 || Math.abs(next.from.y - move.to.y) > 1e-9) return
    total += 1
    if (wallDistance(move.to) < 0.05) onWall += 1
  })
  return { total, onWall }
}

/** The wall-finishing sibling of `islandPocket`. */
function finishWallOperation(overrides: Partial<Operation> = {}): Operation {
  return pocketOperation({
    pass: 'finish', finishWalls: true, finishFloor: false, stepdown: 6,
    carveDepth: 4, maxCarveDepth: 4, ...overrides,
  })
}

/** The tool-centre-safe domain the generator itself clears within. */
function pocketDomainCheck(project: Project, operation: Operation): (x: number, y: number) => boolean {
  const resolved = resolvePocketRegions(project, operation)
  const toolRecord = project.tools.find((tool) => tool.id === operation.toolRef)
  assert(toolRecord !== undefined, 'the fixture has its tool')
  const tool = normalizeToolForProject(toolRecord, project)
  const regions = resolved.bands.flatMap((band) => band.regions
    .flatMap((region) => buildInsetRegions(region, tool.radius + Math.max(0, operation.stockToLeaveRadial))))
  assert(regions.length > 0, 'the fixture resolves a clearable domain')
  return buildOffsetDomainCheck(regions)
}

// ── Tests ────────────────────────────────────────────────────────────

function testNoDescentLandsOnAFinishedWall() {
  console.log('Testing no descent lands on a finished wall...')
  const { project, operation } = islandPocket()

  // The defect, measured. A wall-finish pass drops onto the outer wall contour
  // AND onto the island wall contour, and starts cutting from the plunge point.
  const legacyFinish = generatePocketToolpath(project, finishWallOperation())
  const legacyLanded = descentsOntoWalls(legacyFinish.moves)
  assert(legacyLanded.onWall > 0,
    `the fixture reproduces the defect (${legacyLanded.onWall} of ${legacyLanded.total} descents on a wall)`)

  const led = generatePocketToolpath(project, finishWallOperation({ xyLeadStrategy: 'arc' }))
  assert(descentsOntoWalls(led.moves).onWall === 0, 'and with the lead, none of them do')
  assert(led.warnings.length === 0, 'without falling back')
  assert(countKind(led.moves, 'lead_in') > 0 && countKind(led.moves, 'lead_out') > 0,
    'both ends of the wall pass are led')

  // A roughing ring that leaves no radial stock IS the finished wall, so it is
  // covered by the same rule.
  const legacyRough = generatePocketToolpath(project, operation)
  assert(descentsOntoWalls(legacyRough.moves).onWall > 0, 'roughing at zero stock lands on a wall too')
  const ledRough = generatePocketToolpath(project, { ...operation, xyLeadStrategy: 'arc' })
  assert(descentsOntoWalls(ledRough.moves).onWall === 0, 'and the lead clears that as well')
  console.log('no descent lands on a wall: PASSED')
}

function testEveryWallContourIsLedInAndOut() {
  console.log('Testing every wall contour gets both an entry and an exit...')
  const { project } = islandPocket()
  const led = generatePocketToolpath(project, finishWallOperation({ xyLeadStrategy: 'arc' }))

  // Group the contiguous lead runs and name the contour each one touches. The
  // island wall contour sits one tool radius outside the r=8 island.
  const onIslandWall = (point: ToolpathPoint): boolean =>
    Math.abs(Math.hypot(point.x - 30, point.y - 30) - (8 + 3)) < 0.3
  // The join is the LAST move of an entry run and the FIRST of an exit run, so
  // the run has to be accumulated: reading the first move of an entry gives a
  // point part-way round the arc, which is on no contour at all.
  const runs: Array<{ kind: string; anchor: ToolpathPoint }> = []
  let current: { kind: string; anchor: ToolpathPoint } | null = null
  for (const move of led.moves) {
    if (move.kind !== 'lead_in' && move.kind !== 'lead_out') { current = null; continue }
    if (current !== null && current.kind === move.kind) {
      if (move.kind === 'lead_in') current.anchor = move.to
      continue
    }
    current = { kind: move.kind, anchor: move.kind === 'lead_in' ? move.to : move.from }
    runs.push(current)
  }

  for (const wall of [false, true]) {
    const here = runs.filter((run) => onIslandWall(run.anchor) === wall)
    const label = wall ? 'island wall' : 'outer wall'
    assert(here.some((run) => run.kind === 'lead_in'), `the ${label} is entered along an arc`)
    // An exit emitted once per LEVEL leaves every wall but the last being
    // departed by stopping and travelling away, which rubs the finished
    // surface exactly as the plunge did. This is the assertion that caught it.
    assert(here.some((run) => run.kind === 'lead_out'), `the ${label} is also LEFT along an arc`)
  }
  assert(led.warnings.length === 0, 'and neither falls back')
  console.log('every wall led in and out: PASSED')
}

function testStockToLeaveGatesRoughingLeads() {
  console.log('Testing radial stock gates the roughing lead...')
  const { project, operation } = islandPocket()

  const zero = generatePocketToolpath(project, { ...operation, stockToLeaveRadial: 0, xyLeadStrategy: 'arc' })
  assert(countKind(zero.moves, 'lead_out') > 0, 'no radial stock: the ring is the wall, so it is led')

  // Stock left means a finish pass comes back and machines the mark away, so
  // the lead would be motion spent on nothing.
  const left = generatePocketToolpath(project, { ...operation, stockToLeaveRadial: 0.5, xyLeadStrategy: 'arc' })
  const legacy = generatePocketToolpath(project, { ...operation, stockToLeaveRadial: 0.5 })
  assert(countKind(left.moves, 'lead_in') === 0 && countKind(left.moves, 'lead_out') === 0,
    'stock left: no lead')
  assert(JSON.stringify(left.moves) === JSON.stringify(legacy.moves),
    'and the program is byte-identical to not asking for one')
  console.log('stock-to-leave gate: PASSED')
}

function testComposesWithEveryZEntryStrategy() {
  console.log('Testing the arc composes with plunge, helix and ramp...')
  const { project } = islandPocket()

  for (const entryStrategy of ['plunge', 'helix', 'ramp'] as EntryStrategy[]) {
    const led = generatePocketToolpath(project, finishWallOperation({ entryStrategy, xyLeadStrategy: 'arc' }))
    assert(led.warnings.length === 0, `${entryStrategy}: the lead is planned without a warning`)
    assert(descentsOntoWalls(led.moves).onWall === 0, `${entryStrategy}: no descent lands on the wall`)

    // Kind alone cannot separate the XY lead from a helix or ramp descent —
    // both are lead_in — so read the stream at the seam that matters: the move
    // that hands over to the first wall cut.
    const firstCut = led.moves.findIndex((move) => move.kind === 'cut')
    assert(firstCut > 0, `${entryStrategy}: the program cuts something`)
    const handover = led.moves[firstCut - 1]
    assert(handover.kind === 'lead_in', `${entryStrategy}: a lead hands over to the wall`)
    assert(Math.abs(handover.from.z - handover.to.z) < 1e-9, `${entryStrategy}: the handover is planar`)
    assert(angleBetween(unitDirection(handover), unitDirection(led.moves[firstCut])) < 0.12,
      `${entryStrategy}: the lead joins the wall tangent-continuously`)

    // The descent reaches depth somewhere OTHER than where cutting starts.
    let descent = firstCut - 1
    while (descent >= 0 && led.moves[descent].from.z <= led.moves[descent].to.z + 1e-9) descent -= 1
    assert(descent >= 0, `${entryStrategy}: the program descends before it cuts`)
    const staging = led.moves[descent].to
    const wallStart = led.moves[firstCut].from
    assert(Math.hypot(wallStart.x - staging.x, wallStart.y - staging.y) > 0.75,
      `${entryStrategy}: the staging point differs from where the wall cut starts`)
  }
  console.log('Z-entry composition: PASSED')
}

function testEveryLeadSampleStaysInsideTheSafeDomain() {
  console.log('Testing no lead sample leaves the tool-centre-safe domain...')
  const { project, operation } = islandPocket()
  const led = generatePocketToolpath(project, { ...operation, entryStrategy: 'plunge', xyLeadStrategy: 'arc' })
  const inside = pocketDomainCheck(project, operation)

  let checked = 0
  for (const move of led.moves) {
    if (!LEAD_KINDS.has(move.kind)) continue
    // Sample the swept path, not just the endpoints: the domain is already
    // eroded by the tool radius, so a centre proven inside it is a cutter
    // proven inside the pocket.
    const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
    const samples = Math.max(2, Math.ceil(length / 0.05))
    for (let step = 0; step <= samples; step += 1) {
      const t = step / samples
      const x = move.from.x + (move.to.x - move.from.x) * t
      const y = move.from.y + (move.to.y - move.from.y) * t
      assert(inside(x, y), `lead sample (${x.toFixed(3)}, ${y.toFixed(3)}) left the safe domain`)
      checked += 1
    }
  }
  assert(checked > 200, `the fixture actually produced leads to check (${checked} samples)`)
  console.log(`domain containment over ${checked} samples: PASSED`)
}

function testEmittedLeadsCarryOneConstantFeed() {
  console.log('Testing the emitted leads carry one constant reduced feed...')
  const { project, operation } = islandPocket()
  const led = generatePocketToolpath(project, {
    ...operation, entryStrategy: 'plunge', xyLeadStrategy: 'arc',
  })
  const expected = Math.min(1, operation.plungeFeed / operation.feed)

  // Only the planar XY leads at cut depth; a helix or ramp descent is also
  // lead_in but is not what this governs.
  const runs: ToolpathMove[][] = []
  let run: ToolpathMove[] = []
  for (const move of led.moves) {
    if (LEAD_KINDS.has(move.kind) && Math.abs(move.from.z - move.to.z) < 1e-9) {
      run.push(move)
      continue
    }
    if (run.length > 0) runs.push(run)
    run = []
  }
  if (run.length > 0) runs.push(run)
  assert(runs.length > 0, 'planar leads were emitted')

  for (const candidate of runs) {
    const scales = new Set(candidate.map((move) => move.feedScale ?? 1))
    // One scale for the whole lead. A ramp would split the run and stop arc
    // fitting from ever seeing it as one arc.
    assert(scales.size === 1, 'every move of a lead shares one feed scale')
    assert(Math.abs([...scales][0] - expected) < 1e-12, 'and it is min(plungeFeed / feed, 1)')
  }

  // Plunge moves are never scaled — the descent keeps plunge feed.
  assert(led.moves.every((move) => move.kind !== 'plunge' || move.feedScale === undefined),
    'no plunge move carries a feed scale')
  console.log('constant lead feed: PASSED')
}

function testLeadsFitToASingleArc() {
  console.log('Testing an emitted lead round-trips to one G2/G3 arc...')
  const { project, operation } = islandPocket()
  const led = generatePocketToolpath(project, {
    ...operation, entryStrategy: 'plunge', xyLeadStrategy: 'arc',
  })

  const fitted = fitArcsInMachineMoves(led.moves, 0.01, 90)
  const arcs = fitted.filter((descriptor) => descriptor.kind === 'arc')
  assert(arcs.length > 0, 'the program fits some arcs at all')

  // The lead is the reason this matters: a faceted G1 approach marks a finished
  // surface much as the plunge it replaces would. Before this issue arc fitting
  // refused every non-cut kind, so a lead could never reach G2/G3.
  const leadRuns = new Set<number>()
  for (let index = 0; index < led.moves.length; index += 1) {
    if (LEAD_KINDS.has(led.moves[index].kind) && Math.abs(led.moves[index].from.z - led.moves[index].to.z) < 1e-9) {
      leadRuns.add(index)
    }
  }
  assert(leadRuns.size > 0, 'the fixture emits planar leads')

  // A lead's chords must not survive as a long string of linear descriptors.
  const linearLeads = fitted.filter((descriptor) => descriptor.kind === 'linear'
    && (descriptor.moveKind === 'lead_in' || descriptor.moveKind === 'lead_out')
    && Math.abs(descriptor.point.z - (-2)) < 1e-9).length
  assert(linearLeads < leadRuns.size / 2,
    `most lead chords were fitted rather than passed through (${linearLeads} linear of ${leadRuns.size})`)

  // And a lead is never fitted together with the cut it hands over to: that
  // would relabel it and lose the distinction the preview and booklet read.
  const kinds = new Set(fitted.filter((d) => d.kind === 'linear').map((d) => d.moveKind))
  assert(kinds.has('cut'), 'cuts still pass through or fit on their own')
  console.log('lead arc fitting: PASSED')
}

function testLeadsSurviveLinearMoveOptimization() {
  console.log('Testing the linear-move optimizer preserves the leads...')
  const { project, operation } = islandPocket()
  const raw = generatePocketToolpath(project, {
    ...operation, entryStrategy: 'plunge', xyLeadStrategy: 'arc',
  })
  const optimized = optimizeLinearMoves(raw)
  for (const kind of ['lead_in', 'lead_out']) {
    assert(countKind(optimized.moves, kind) === countKind(raw.moves, kind),
      `${kind} moves are neither merged away nor relabelled`)
  }
  console.log('optimizer preservation: PASSED')
}

function testAbsentAndNoneAreByteIdentical() {
  console.log('Testing operations that did not opt in are byte-identical...')
  const { project, operation } = islandPocket()
  const serialize = (result: PocketToolpathResult): string => JSON.stringify(result.moves)

  for (const entryStrategy of ['plunge', 'helix', 'ramp'] as EntryStrategy[]) {
    const absent = generatePocketToolpath(project, { ...operation, entryStrategy })
    const none = generatePocketToolpath(project, { ...operation, entryStrategy, xyLeadStrategy: 'none' })
    assert(serialize(absent) === serialize(none),
      `${entryStrategy}: 'none' is byte-identical to the field being absent`)
  }

  // And the ring-to-ring S-links keep their own geometry either way.
  const linkedAbsent = generatePocketToolpath(project, { ...operation, roundLinkCorners: true })
  const linkedNone = generatePocketToolpath(project, { ...operation, roundLinkCorners: true, xyLeadStrategy: 'none' })
  assert(serialize(linkedAbsent) === serialize(linkedNone), 'S-linked output is unchanged by an opted-out lead field')
  console.log('byte-identity: PASSED')
}

function testRingToRingLinksAreUntouchedByTheLead() {
  console.log('Testing the lead does not disturb ring-to-ring S-links...')
  const { project, operation } = islandPocket()
  const linked = generatePocketToolpath(project, { ...operation, roundLinkCorners: true })
  const ledAndLinked = generatePocketToolpath(project, {
    ...operation, roundLinkCorners: true, xyLeadStrategy: 'arc',
  })
  // The lead only ever replaces the level's FIRST entry and adds an exit, so
  // the level's interior cut mileage must not collapse or explode.
  const cutLength = (moves: ToolpathMove[]): number => moves
    .filter((move) => move.kind === 'cut')
    .reduce((total, move) => total + Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y), 0)
  const before = cutLength(linked.moves)
  const after = cutLength(ledAndLinked.moves)
  assert(Math.abs(after - before) / before < 0.05,
    `ring cutting is essentially unchanged (${before.toFixed(2)} -> ${after.toFixed(2)})`)
  assert(ledAndLinked.warnings.length === 0, 'and no warning was raised')
  console.log('S-link coexistence: PASSED')
}

function testMaskedAndUnsupportedFallBackWithAWarning() {
  console.log('Testing the masked and unsupported fallbacks...')
  const { project, operation } = islandPocket()

  const raster = generatePocketToolpath(project, { ...operation, pocketPattern: 'parallel', xyLeadStrategy: 'arc' })
  assert(raster.warnings.some((warning) => warning.code === 'xyLeadUnsupported'),
    'a raster clearing pattern warns that leads are unavailable')
  assert(countKind(raster.moves, 'lead_out') === 0, 'and emits none')
  const rasterLegacy = generatePocketToolpath(project, { ...operation, pocketPattern: 'parallel' })
  assert(JSON.stringify(raster.moves) === JSON.stringify(rasterLegacy.moves),
    'a declined lead leaves the raster program byte-identical')

  const maskedProject = projectWithFeatures(
    { ...newProject('xy-lead-mask', 'mm'), tools: [makeFlatEndmill()] },
    [makeRect('p1', 0, 0, 60, 60), makeRect('r1', 0, 0, 40, 60, 'region')],
  )
  const maskedOp = pocketOperation({ target: { source: 'features', featureIds: ['p1', 'r1'] } })
  const masked = generatePocketToolpath(maskedProject, { ...maskedOp, xyLeadStrategy: 'arc' })
  assert(masked.warnings.some((warning) => warning.code === 'xyLeadRegionMask'),
    'a region-masked operation warns that leads are unavailable')
  assert(countKind(masked.moves, 'lead_out') === 0, 'and emits none')
  const maskedLegacy = generatePocketToolpath(maskedProject, maskedOp)
  assert(JSON.stringify(masked.moves) === JSON.stringify(maskedLegacy.moves),
    'a masked program is byte-identical to the same operation without the request')
  console.log('masked and unsupported fallbacks: PASSED')
}

function testSurfaceCleanLeadsOntoItsWall() {
  console.log('Testing surface clean leads onto its wall...')
  const project = projectWithFeatures(
    { ...newProject('xy-lead-surface', 'mm'), tools: [makeFlatEndmill('t1', 4)] },
    [makeRect('boss', 20, 20, 30, 30, 'add')],
  )
  const wallPass = pocketOperation({
    id: 'sc1', kind: 'surface_clean', target: { source: 'features', featureIds: ['boss'] },
    pass: 'finish', finishWalls: true, finishFloor: false,
    stepdown: 1, carveDepth: 2, maxCarveDepth: 2,
  })

  const legacy = generateSurfaceCleanToolpath(project, wallPass)
  const led = generateSurfaceCleanToolpath(project, { ...wallPass, xyLeadStrategy: 'arc' })
  assert(countKind(led.moves, 'lead_in') > countKind(legacy.moves, 'lead_in'), 'entry leads were emitted')
  assert(countKind(led.moves, 'lead_out') > countKind(legacy.moves, 'lead_out'), 'exit leads were emitted')
  assert(led.warnings.length === 0, 'without falling back')

  // The wall pass's first cut is now reached along a tangent arc rather than
  // by dropping onto it. Measuring "is this point on the wall contour" is
  // unreliable at a mitered corner — the offset there is sqrt(2) x radius from
  // the source corner, not radius — so read the handover, which is exact.
  const firstCut = led.moves.findIndex((move) => move.kind === 'cut')
  assert(firstCut > 0, 'the wall pass cuts something')
  const handover = led.moves[firstCut - 1]
  assert(handover.kind === 'lead_in', 'a lead hands over to the wall')
  assert(Math.abs(handover.from.z - handover.to.z) < 1e-9, 'and it is planar at cut depth')
  assert(angleBetween(unitDirection(handover), unitDirection(led.moves[firstCut])) < 0.12,
    'joining the wall tangent-continuously')

  // Without the lead the same first cut is reached by a plunge landing on it.
  const legacyFirstCut = legacy.moves.findIndex((move) => move.kind === 'cut')
  const legacyBefore = legacy.moves[legacyFirstCut - 1]
  assert(legacyBefore.kind === 'plunge'
    && Math.abs(legacyBefore.to.x - legacy.moves[legacyFirstCut].from.x) < 1e-9
    && Math.abs(legacyBefore.to.y - legacy.moves[legacyFirstCut].from.y) < 1e-9,
    'the legacy wall pass drops straight onto the point it starts cutting from')

  assert(JSON.stringify(generateSurfaceCleanToolpath(project, { ...wallPass, xyLeadStrategy: 'none' }).moves)
    === JSON.stringify(legacy.moves), 'surface clean stays byte-identical when opted out')
  console.log('surface clean wall: PASSED')
}

function testRoughSurfaceCarriesTheLead() {
  console.log('Testing rough surface carries the lead...')
  const { project, operation } = roughSurfaceFixture()
  const legacy = generateRoughSurfaceToolpath(project, operation)
  const led = generateRoughSurfaceToolpath(project, { ...operation, xyLeadStrategy: 'arc' })
  assert(countKind(legacy.moves, 'cut') > 0, 'the 3D fixture cuts something')
  // 3D roughing traverses OUTER-FIRST, so unlike pocket clearing its
  // wall-adjacent ring is the one the descent lands on — which is exactly why
  // it needs the lead.
  assert(countKind(led.moves, 'lead_in') > countKind(legacy.moves, 'lead_in'), 'entry leads were emitted')
  assert(JSON.stringify(generateRoughSurfaceToolpath(project, { ...operation, xyLeadStrategy: 'none' }).moves)
    === JSON.stringify(legacy.moves), 'rough surface stays byte-identical when opted out')

  // Stock left means a finish pass takes the mark away, so no lead.
  const withStock = generateRoughSurfaceToolpath(project, {
    ...operation, stockToLeaveRadial: 0.5, xyLeadStrategy: 'arc',
  })
  assert(countKind(withStock.moves, 'lead_in') === countKind(
    generateRoughSurfaceToolpath(project, { ...operation, stockToLeaveRadial: 0.5 }).moves, 'lead_in'),
    'radial stock gates the 3D roughing lead too')
  console.log('rough surface: PASSED')
}

/** A shallow frustum, big enough that its level rings can carry a lead. */
function roughSurfaceFixture(): { project: Project; operation: Operation } {
  const vertices = {
    b0: [0, 0, 0], b1: [60, 0, 0], b2: [60, 40, 0], b3: [0, 40, 0],
    t0: [20, 10, 6], t1: [40, 10, 6], t2: [40, 30, 6], t3: [20, 30, 6],
  } as const
  const faces: Array<[keyof typeof vertices, keyof typeof vertices, keyof typeof vertices]> = [
    ['b0', 'b2', 'b1'], ['b0', 'b3', 'b2'],
    ['t0', 't1', 't2'], ['t0', 't2', 't3'],
    ['b0', 'b1', 't1'], ['b0', 't1', 't0'],
    ['b1', 'b2', 't2'], ['b1', 't2', 't1'],
    ['b2', 'b3', 't3'], ['b2', 't3', 't2'],
    ['b3', 'b0', 't0'], ['b3', 't0', 't3'],
  ]
  const lines = ['solid frustum']
  for (const face of faces) {
    lines.push('  facet normal 0 0 0')
    lines.push('    outer loop')
    for (const key of face) lines.push(`      vertex ${vertices[key].join(' ')}`)
    lines.push('    endloop')
    lines.push('  endfacet')
  }
  lines.push('endsolid frustum')

  const model: SketchFeature = {
    id: 'model1',
    name: 'Frustum',
    kind: 'stl',
    stl: {
      format: 'stl',
      fileData: `data:model/stl;base64,${btoa(`${lines.join('\n')}\n`)}`,
      scale: 1,
      axisSwap: 'none',
    },
    folderId: null,
    sketch: { profile: rectProfile(0, 0, 60, 40), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'model',
    z_top: 6,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
  const region = makeRect('region1', -4, -4, 68, 48, 'region')
  const project = projectWithFeatures(
    { ...newProject('xy-lead-rough', 'mm'), tools: [makeFlatEndmill('t1', 4)] },
    [model, region],
  )
  project.stock.thickness = 6
  const operation = pocketOperation({
    id: 'rough1',
    kind: 'rough_surface',
    target: { source: 'features', featureIds: ['model1'] },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.5,
  })
  return { project, operation }
}

function testNormalizationKeepsAndStripsTheField() {
  console.log('Testing normalization of the stored field...')
  const { project } = islandPocket()

  const kept = normalizeOperation(pocketOperation({ xyLeadStrategy: 'arc' }), project, 0)
  assert(kept.xyLeadStrategy === 'arc', 'a supported kind keeps its request')

  const absent = normalizeOperation(pocketOperation(), project, 0)
  assert(absent.xyLeadStrategy === undefined, 'an operation without the field is not backfilled')

  const junk = normalizeOperation(
    pocketOperation({ xyLeadStrategy: 'spiral' as unknown as 'arc' }),
    project,
    0,
  )
  assert(junk.xyLeadStrategy === undefined, 'an unknown stored value normalizes away')

  const wrongKind = normalizeOperation(
    pocketOperation({ kind: 'v_carve', xyLeadStrategy: 'arc' }),
    project,
    0,
  )
  assert(wrongKind.xyLeadStrategy === undefined, 'a kind with no lead seam does not keep the request')

  // Edge routes DO have one, on either side: every contour they cut is a wall.
  for (const kind of ['edge_route_inside', 'edge_route_outside'] as const) {
    const edge = normalizeOperation(pocketOperation({ kind, xyLeadStrategy: 'arc' }), project, 0)
    assert(edge.xyLeadStrategy === 'arc', `${kind} keeps the request through a save/load`)
  }
  console.log('normalization: PASSED')
}

try {
  testNoDescentLandsOnAFinishedWall()
  testEveryWallContourIsLedInAndOut()
  testStockToLeaveGatesRoughingLeads()
  testComposesWithEveryZEntryStrategy()
  testEveryLeadSampleStaysInsideTheSafeDomain()
  testEmittedLeadsCarryOneConstantFeed()
  testLeadsFitToASingleArc()
  testLeadsSurviveLinearMoveOptimization()
  testAbsentAndNoneAreByteIdentical()
  testRingToRingLinksAreUntouchedByTheLead()
  testMaskedAndUnsupportedFallBackWithAWarning()
  testSurfaceCleanLeadsOntoItsWall()
  testRoughSurfaceCarriesTheLead()
  testNormalizationKeepsAndStripsTheField()
  console.log('\nAll xyLead integration tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
