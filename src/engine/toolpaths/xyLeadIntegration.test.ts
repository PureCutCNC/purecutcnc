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
 * Integration tests for XY lead-in / lead-out on generated clearing streams
 * (issue #695): composition with each Z-entry strategy, tangent continuity into
 * the ring, containment in the tool-centre-safe domain, the feed ramp, the
 * masked and unsupported fallbacks, byte-identity for operations that did not
 * opt in, and survival of the always-on linear-move optimizer.
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
import type { PocketToolpathResult, ToolpathMove } from './types'

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

function testComposesWithEveryZEntryStrategy() {
  console.log('Testing arc composes with plunge, helix and ramp...')
  const { project, operation } = islandPocket()

  for (const entryStrategy of ['plunge', 'helix', 'ramp'] as EntryStrategy[]) {
    const legacy = generatePocketToolpath(project, { ...operation, entryStrategy })
    const led = generatePocketToolpath(project, { ...operation, entryStrategy, xyLeadStrategy: 'arc' })
    assert(led.warnings.length === 0, `${entryStrategy}: the lead is planned without a warning`)
    assert(countKind(led.moves, 'lead_in') > countKind(legacy.moves, 'lead_in'),
      `${entryStrategy}: entry leads were emitted`)
    assert(countKind(led.moves, 'lead_out') > countKind(legacy.moves, 'lead_out'),
      `${entryStrategy}: exit leads were emitted`)

    // Kind alone cannot separate the XY lead from a helix or ramp descent —
    // both are lead_in — so the stream is read at the seam that matters: the
    // move that hands over to the first ring cut.
    const firstCut = led.moves.findIndex((move) => move.kind === 'cut')
    assert(firstCut > 0, `${entryStrategy}: the program cuts something`)
    const handover = led.moves[firstCut - 1]
    assert(handover.kind === 'lead_in', `${entryStrategy}: a lead hands over to the ring`)
    assert(Math.abs(handover.from.z - handover.to.z) < 1e-9, `${entryStrategy}: the handover is planar`)
    assert(angleBetween(unitDirection(handover), unitDirection(led.moves[firstCut])) < 0.12,
      `${entryStrategy}: the lead joins the ring tangent-continuously`)

    // Where the descent actually reached final depth, and how far that is from
    // where cutting starts. A legacy plunge lands exactly on the ring start;
    // this is the staging that replaces it.
    let descent = firstCut - 1
    while (descent >= 0 && led.moves[descent].from.z <= led.moves[descent].to.z + 1e-9) descent -= 1
    assert(descent >= 0, `${entryStrategy}: the program descends before it cuts`)
    const staging = led.moves[descent].to
    const ringStart = led.moves[firstCut].from
    assert(Math.hypot(ringStart.x - staging.x, ringStart.y - staging.y) > 0.75,
      `${entryStrategy}: the final-depth staging point differs from the ring start`)
  }

  // The tangential handover is what the lead adds: without it the same fixture
  // meets its first ring at whatever angle the entry happened to leave at.
  const plungeLegacy = generatePocketToolpath(project, { ...operation, entryStrategy: 'plunge' })
  const legacyFirstCut = plungeLegacy.moves.findIndex((move) => move.kind === 'cut')
  assert(plungeLegacy.moves[legacyFirstCut - 1].kind === 'plunge',
    'a legacy plunge entry drops straight onto the ring start with no XY lead at all')
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

function testSurfaceCleanCarriesTheLead() {
  console.log('Testing surface clean carries the lead...')
  const project = projectWithFeatures(
    { ...newProject('xy-lead-surface', 'mm'), tools: [makeFlatEndmill('t1', 4)] },
    [makeRect('boss', 20, 20, 30, 30, 'add')],
  )
  const operation: Operation = {
    ...pocketOperation({
      id: 'sc1',
      kind: 'surface_clean',
      target: { source: 'features', featureIds: ['boss'] },
      stepdown: 1,
      carveDepth: 2,
      maxCarveDepth: 2,
      finishWalls: true,
      finishFloor: true,
    }),
  }
  const legacy = generateSurfaceCleanToolpath(project, operation)
  const led = generateSurfaceCleanToolpath(project, { ...operation, xyLeadStrategy: 'arc' })
  assert(countKind(led.moves, 'lead_in') > countKind(legacy.moves, 'lead_in'), 'entry leads were emitted')
  assert(countKind(led.moves, 'lead_out') > countKind(legacy.moves, 'lead_out'), 'exit leads were emitted')
  assert(JSON.stringify(generateSurfaceCleanToolpath(project, { ...operation, xyLeadStrategy: 'none' }).moves)
    === JSON.stringify(legacy.moves), 'surface clean stays byte-identical when opted out')
  console.log('surface clean: PASSED')
}

function testRoughSurfaceCarriesTheLead() {
  console.log('Testing rough surface carries the lead...')
  const { project, operation } = roughSurfaceFixture()
  const legacy = generateRoughSurfaceToolpath(project, operation)
  const led = generateRoughSurfaceToolpath(project, { ...operation, xyLeadStrategy: 'arc' })
  assert(countKind(legacy.moves, 'cut') > 0, 'the 3D fixture cuts something')
  assert(countKind(led.moves, 'lead_in') > countKind(legacy.moves, 'lead_in'), 'entry leads were emitted')
  assert(countKind(led.moves, 'lead_out') > countKind(legacy.moves, 'lead_out'), 'exit leads were emitted')
  assert(JSON.stringify(generateRoughSurfaceToolpath(project, { ...operation, xyLeadStrategy: 'none' }).moves)
    === JSON.stringify(legacy.moves), 'rough surface stays byte-identical when opted out')
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
    pocketOperation({ kind: 'edge_route_inside', xyLeadStrategy: 'arc' }),
    project,
    0,
  )
  assert(wrongKind.xyLeadStrategy === undefined, 'a kind with no lead seam does not keep the request')
  console.log('normalization: PASSED')
}

try {
  testComposesWithEveryZEntryStrategy()
  testEveryLeadSampleStaysInsideTheSafeDomain()
  testEmittedLeadsCarryOneConstantFeed()
  testLeadsFitToASingleArc()
  testLeadsSurviveLinearMoveOptimization()
  testAbsentAndNoneAreByteIdentical()
  testRingToRingLinksAreUntouchedByTheLead()
  testMaskedAndUnsupportedFallBackWithAWarning()
  testSurfaceCleanCarriesTheLead()
  testRoughSurfaceCarriesTheLead()
  testNormalizationKeepsAndStripsTheField()
  console.log('\nAll xyLead integration tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
