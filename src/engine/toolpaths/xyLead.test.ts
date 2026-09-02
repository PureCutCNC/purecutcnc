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
 * Unit tests for tangent-arc lead planning and emission (issue #695).
 * Run with: npx tsx src/engine/toolpaths/xyLead.test.ts
 */

import {
  beginXyLeadLevel,
  emitXyLead,
  emitXyLeadOut,
  leadFeedScale,
  planXyLeadIn,
  planXyLeadOut,
  recordXyLeadExit,
  resolveXyLeadOptions,
  rotateRingForLead,
  supportsXyLead,
  takeXyLeadIn,
  xyLeadOptions,
  type XyLeadOptions,
} from './xyLead'
import { buildOffsetDomainCheck, domainSafePathLength } from './tangentLink'
import { DEFAULT_FLATTEN_ARC_STEP } from './geometry'
import type { Operation, Point } from '../../types/project'
import type { ToolpathMove, ToolpathPoint } from './types'
import type { ToolpathWarning } from './warningCodes'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

function direction(from: Point, to: Point): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  return { x: dx / length, y: dy / length }
}

function angleBetween(a: Point, b: Point): number {
  return Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y)))
}

/** A square ring, counter-clockwise in screen coords, with `perSide` vertices. */
function squareRing(min: number, max: number, perSide: number): Point[] {
  const ring: Point[] = []
  const push = (fromX: number, fromY: number, toX: number, toY: number): void => {
    for (let step = 0; step < perSide; step += 1) {
      const t = step / perSide
      ring.push({ x: fromX + (toX - fromX) * t, y: fromY + (toY - fromY) * t })
    }
  }
  push(min, min, max, min)
  push(max, min, max, max)
  push(max, max, min, max)
  push(min, max, min, min)
  return ring
}

const DOMAIN_OUTER: Point[] = [
  { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
]

const TOOL_DIAMETER = 6

function openOptions(overrides: Partial<XyLeadOptions> = {}): XyLeadOptions {
  return {
    toolDiameter: TOOL_DIAMETER,
    maxLength: 15,
    arcStepRadians: DEFAULT_FLATTEN_ARC_STEP,
    cutFeed: 800,
    plungeFeed: 300,
    isInsideDomain: buildOffsetDomainCheck([{ outer: DOMAIN_OUTER, islands: [] }]),
    ...overrides,
  }
}

function baseOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'op', name: 'op', kind: 'pocket', pass: 'rough', enabled: true,
    showToolpath: true, debugToolpath: false,
    target: { source: 'features', featureIds: ['f'] }, toolRef: 't',
    stepdown: 2, stepover: 0.4, feed: 800, plungeFeed: 300, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0,
    stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: false, finishFloor: false,
    carveDepth: 1, maxCarveDepth: 1,
    xyLeadStrategy: 'arc',
    ...overrides,
  }
}

function testEntryArrivesTangentToTheRing() {
  console.log('Testing the entry lead arrives tangent to the ring...')
  const ring = squareRing(20, 80, 6)
  const options = openOptions()
  const plan = planXyLeadIn(ring, options)
  assert(plan !== null, 'a lead is planned on an open square ring')

  const arrival = ring[plan.arrivalIndex]
  const last = plan.points[plan.points.length - 1]
  assert(Math.hypot(last.x - arrival.x, last.y - arrival.y) < 1e-9, 'the lead ends on the arrival vertex')

  const ringTangent = direction(arrival, ring[(plan.arrivalIndex + 1) % ring.length])
  const approach = direction(plan.points[plan.points.length - 2], last)
  assert(angleBetween(approach, ringTangent) < 0.06, 'the last lead segment is tangent to the ring')

  // The whole point of the feature: the descent no longer lands on the surface.
  const offset = Math.hypot(plan.staging.x - arrival.x, plan.staging.y - arrival.y)
  assert(offset > options.toolDiameter * 0.25, `staging point is off the ring (offset ${offset})`)
  console.log('entry tangency and staging offset: PASSED')
}

function testExitDepartsTangentFromTheRing() {
  console.log('Testing the exit lead departs tangent from the ring...')
  const ring = squareRing(20, 80, 6)
  const options = openOptions()
  const plan = planXyLeadOut(ring, options)
  assert(plan !== null, 'a lead-out is planned on an open square ring')

  assert(Math.hypot(plan.points[0].x - ring[0].x, plan.points[0].y - ring[0].y) < 1e-9,
    'the lead-out starts where the ring cut ended')
  const closing = direction(ring[ring.length - 1], ring[0])
  const departure = direction(plan.points[0], plan.points[1])
  assert(angleBetween(departure, closing) < 0.06, 'the first lead-out segment continues the ring tangent')
  const offset = Math.hypot(plan.staging.x - ring[0].x, plan.staging.y - ring[0].y)
  assert(offset > options.toolDiameter * 0.25, `staging point is off the ring (offset ${offset})`)
  console.log('exit tangency: PASSED')
}

function testCornerSeamedRingExitsThroughAnOverlap() {
  console.log('Testing a corner-seamed ring still finds an exit...')
  // A four-vertex square seams at a corner and closes travelling straight at
  // the wall. No tangent departure exists there at any radius, so a viable exit
  // proves the overlap search ran; without it this ring would fall back.
  const ring: Point[] = [{ x: 80, y: 80 }, { x: 20, y: 80 }, { x: 20, y: 20 }, { x: 80, y: 20 }]
  const options = openOptions({
    isInsideDomain: buildOffsetDomainCheck([{
      outer: [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 }, { x: 20, y: 80 }],
      islands: [],
    }]),
  })
  const plan = planXyLeadOut(ring, options)
  assert(plan !== null, 'the corner-seamed ring finds an exit through the overlap')
  const overlapEnd = plan.points[1]
  assert(Math.abs(overlapEnd.y - 80) < 1e-9 && overlapEnd.x < 80,
    'the exit first runs back along the ring it just cut')
  console.log('corner-seamed exit: PASSED')
}

function testDomainRejectionLeavesNoLead() {
  console.log('Testing a lead that cannot stay inside the domain is refused...')
  const ring = squareRing(20, 80, 6)
  // A domain that is exactly the ring's own path: any curve off it is outside.
  const hairline = openOptions({
    isInsideDomain: (x, y) => {
      const onVertical = (Math.abs(x - 20) < 1e-9 || Math.abs(x - 80) < 1e-9) && y >= 20 && y <= 80
      const onHorizontal = (Math.abs(y - 20) < 1e-9 || Math.abs(y - 80) < 1e-9) && x >= 20 && x <= 80
      return onVertical || onHorizontal
    },
  })
  assert(planXyLeadIn(ring, hairline) === null, 'no entry lead fits a hairline domain')
  assert(planXyLeadOut(ring, hairline) === null, 'no exit lead fits a hairline domain')
  console.log('domain rejection: PASSED')
}

function testSweptSamplingSeesBetweenVertices() {
  console.log('Testing the domain gate samples between path vertices...')
  // The gate that every lead candidate is validated with. A hole in the middle
  // of a long segment is invisible to a vertex-only check and would drive the
  // swept cutter straight through it, so this asserts the mechanism directly
  // rather than through a planner that has fallbacks to hide behind.
  const path: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }]
  const hole = (x: number, y: number): boolean => !(x > 4.8 && x < 5.2 && Math.abs(y) < 1)

  assert(hole(path[0].x, path[0].y) && hole(path[1].x, path[1].y),
    'both vertices lie outside the hole, so only interior sampling can see it')
  assert(domainSafePathLength(path, 0.2, hole) === null, 'a hole mid-segment is caught')
  assert(domainSafePathLength(path, 20, hole) !== null,
    'and is missed when the budget is coarser than the segment — which is why leads halve theirs')

  const clear = domainSafePathLength(path, 0.2, () => true)
  assert(clear !== null && Math.abs(clear - 10) < 1e-9, 'a clear path reports its true length')

  // End to end: a domain that allows nothing off the contour admits no lead.
  const ring = squareRing(20, 80, 6)
  assert(planXyLeadIn(ring, openOptions({ isInsideDomain: () => false })) === null,
    'no lead survives a domain that refuses everything')
  console.log('swept sampling: PASSED')
}

function testDeterminismAndValidatedPlacement() {
  console.log('Testing placement is deterministic and validated, not assumed...')
  const ring = squareRing(20, 80, 6)
  const first = planXyLeadIn(ring, openOptions())
  const second = planXyLeadIn(ring, openOptions())
  assert(first !== null && second !== null, 'both runs plan a lead')
  assert(first.arrivalIndex === second.arrivalIndex, 'the same arrival vertex is chosen every time')
  assert(JSON.stringify(first.points) === JSON.stringify(second.points), 'the same path is built every time')

  // The source contour's first vertex is not an assumption. Forbid everything
  // below y = 45; the ring seams at (20,20) and its first nine vertices cannot
  // carry a lead, so a planner that took the seam on faith would return null
  // (or worse, a path through the forbidden band) instead of walking on.
  const halfOpen = openOptions({ isInsideDomain: (x, y) => x > 0 && x < 100 && y >= 45 })
  const walked = planXyLeadIn(ring, halfOpen)
  assert(walked !== null, 'a lead is still found when the seam cannot take one')
  assert(walked.arrivalIndex >= 9,
    `the search walked past every unusable vertex (landed on ${walked.arrivalIndex})`)
  assert(ring[walked.arrivalIndex].y >= 45, 'and landed on a vertex the domain actually allows')
  assert(walked.points.every((point) => point.y >= 45), 'no emitted lead sample leaves the domain')
  const walkedAgain = planXyLeadIn(ring, halfOpen)
  assert(walkedAgain !== null && walkedAgain.arrivalIndex === walked.arrivalIndex,
    'the walked placement is deterministic too')
  console.log('determinism and validated placement: PASSED')
}


/** Circumradius of three points — recovers the radius of a tessellated arc. */
function fittedRadius(a: Point, b: Point, c: Point): number {
  const ab = Math.hypot(b.x - a.x, b.y - a.y)
  const bc = Math.hypot(c.x - b.x, c.y - b.y)
  const ca = Math.hypot(a.x - c.x, a.y - c.y)
  const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2
  return area > 1e-12 ? (ab * bc * ca) / (4 * area) : Number.POSITIVE_INFINITY
}

/** The radius the planner actually used, read back off the emitted polyline. */
function planRadius(points: Point[]): number {
  const mid = Math.floor(points.length / 2)
  return fittedRadius(points[0], points[mid], points[points.length - 1])
}

/** A corridor of half-width `h` around the square ring's own lines. */
function corridor(h: number): (x: number, y: number) => boolean {
  return (x, y) => {
    if (x < 20 - h - 1 || x > 80 + h + 1 || y < 20 - h - 1 || y > 80 + h + 1) return false
    return Math.min(Math.abs(x - 20), Math.abs(x - 80), Math.abs(y - 20), Math.abs(y - 80)) <= h
  }
}

function testRadiusLadderTakesTheWidestArcThatFits() {
  console.log('Testing the radius ladder...')
  const ring = squareRing(20, 80, 6)

  // Open space: the widest rung, a full tool diameter, and the widest sweep.
  const open = planXyLeadIn(ring, openOptions())
  assert(open !== null, 'an open domain plans a lead')
  assert(Math.abs(planRadius(open.points) - TOOL_DIAMETER) < 0.05,
    `the widest rung is chosen in open space (got ${planRadius(open.points).toFixed(3)})`)
  // 90 deg at R: the staging point sits a chord of R*sqrt(2) from the arrival.
  const arrival = ring[open.arrivalIndex]
  const chord = Math.hypot(open.staging.x - arrival.x, open.staging.y - arrival.y)
  assert(Math.abs(chord - TOOL_DIAMETER * Math.SQRT2) < 0.05, 'swept the full 90 degrees')

  // A corridor that a 90 deg arc of full radius cannot fit. The ladder is
  // radius-MAJOR, so it shortens the sweep before it narrows the arc: the
  // radius must hold while the chord gets shorter.
  const narrowed = planXyLeadIn(ring, openOptions({ isInsideDomain: corridor(3.5) }))
  assert(narrowed !== null, 'a narrower corridor still plans a lead')
  assert(Math.abs(planRadius(narrowed.points) - TOOL_DIAMETER) < 0.05,
    'the radius is held and the sweep gives way first')
  const narrowedChord = Math.hypot(
    narrowed.staging.x - ring[narrowed.arrivalIndex].x,
    narrowed.staging.y - ring[narrowed.arrivalIndex].y,
  )
  assert(narrowedChord < chord, 'so the lead is shorter than the open-space one')

  // Tight enough that only the bottom rung fits.
  const tight = planXyLeadIn(ring, openOptions({ isInsideDomain: corridor(0.5) }))
  assert(tight !== null, 'a tight corridor still plans a lead rather than giving up')
  assert(Math.abs(planRadius(tight.points) - TOOL_DIAMETER * 0.25) < 0.05,
    `the ladder descended to its bottom rung (got ${planRadius(tight.points).toFixed(3)})`)
  console.log('radius ladder: PASSED')
}

function testRotateRingForLead() {
  console.log('Testing the ring re-seams at the arrival vertex...')
  const ring = squareRing(20, 80, 4)
  const plan = planXyLeadIn(ring, openOptions())
  assert(plan !== null, 'a lead is planned')
  const rotated = rotateRingForLead(ring, plan)
  assert(rotated.length === ring.length, 're-seaming preserves every vertex')
  assert(rotated[0] === ring[plan.arrivalIndex], 'the ring now starts on the arrival vertex')
  assert(rotateRingForLead(ring, null) === ring, 'no plan leaves the ring alone')
  console.log('ring re-seam: PASSED')
}

function testLeadRunsAtOneConstantFeed() {
  console.log('Testing the lead feed...')
  const options = openOptions()
  assert(Math.abs(leadFeedScale(options) - 300 / 800) < 1e-12, 'the scale is plungeFeed / feed')

  const points: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }]
  const plan = { points, staging: points[0], arrivalIndex: 0 }

  for (const kind of ['lead_in', 'lead_out'] as const) {
    const moves: ToolpathMove[] = []
    emitXyLead(moves, { x: 0, y: 0, z: -2 }, plan, -2, options, kind)
    assert(moves.length === 4, `${kind}: one move per lead segment`)
    assert(moves.every((move) => move.kind === kind), `${kind}: moves carry the lead kind`)
    // One constant feed, entry and exit alike. A per-move ramp was tried and
    // dropped: arc fitting groups a run by equal feedScale, so a ramp would
    // linearise the arc into G1 chords and mark the surface it exists to
    // protect. This assertion is what keeps a ramp from creeping back.
    const scales = moves.map((move) => move.feedScale)
    assert(new Set(scales).size === 1, `${kind}: every lead move shares one feed scale`)
    assert(Math.abs((scales[0] ?? 1) - 300 / 800) < 1e-12, `${kind}: at the constrained feed`)
  }

  // A plunge feed at or above the cut feed leaves nothing to constrain.
  const unlimited: ToolpathMove[] = []
  emitXyLead(unlimited, { x: 0, y: 0, z: -2 }, plan, -2, openOptions({ plungeFeed: 900 }), 'lead_in')
  assert(unlimited.every((move) => move.feedScale === undefined),
    'no feedScale is stamped when the plunge feed does not constrain the lead')
  console.log('constant lead feed: PASSED')
}

function testEmittedLeadStaysPlanarAtZ() {
  console.log('Testing emitted leads stay planar at the cut Z...')
  const options = openOptions()
  const ring = squareRing(20, 80, 6)
  const plan = planXyLeadIn(ring, options)
  assert(plan !== null, 'a lead is planned')
  const moves: ToolpathMove[] = []
  const from: ToolpathPoint = { x: plan.staging.x, y: plan.staging.y, z: -3.5 }
  const end = emitXyLead(moves, from, plan, -3.5, options, 'lead_in')
  assert(moves.every((move) => move.from.z === -3.5 && move.to.z === -3.5), 'no lead move changes Z')
  assert(moves[0].from.x === from.x && moves[0].from.y === from.y, 'the lead starts at the staging point')
  const arrival = ring[plan.arrivalIndex]
  assert(Math.abs(end.x - arrival.x) < 1e-9 && Math.abs(end.y - arrival.y) < 1e-9,
    'the lead ends on the ring')
  console.log('planar emission: PASSED')
}

function testGatesAndWarnings() {
  console.log('Testing the operation gates and their warnings...')
  const regions = [{ outer: DOMAIN_OUTER, islands: [] }]
  const collect = (): { warnings: ToolpathWarning[]; onWarning: (w: ToolpathWarning) => void } => {
    const warnings: ToolpathWarning[] = []
    return { warnings, onWarning: (warning) => warnings.push(warning) }
  }

  assert(supportsXyLead(baseOperation()), 'a rough offset pocket supports leads')
  assert(!supportsXyLead(baseOperation({ pocketPattern: 'parallel' })), 'raster clearing does not')
  assert(!supportsXyLead(baseOperation({ pass: 'finish' })), 'a finish pass does not')
  assert(!supportsXyLead(baseOperation({ kind: 'edge_route_inside' })), 'edge routing does not')
  assert(supportsXyLead(baseOperation({ kind: 'surface_clean' })), 'surface clean does')
  assert(supportsXyLead(baseOperation({ kind: 'rough_surface' })), 'rough surface does')

  const off = collect()
  assert(resolveXyLeadOptions(baseOperation({ xyLeadStrategy: undefined }), 6, regions, false, off.onWarning) === undefined,
    'an operation that did not opt in gets no options')
  assert(off.warnings.length === 0, 'and is not warned about — absent is the legacy default, not a refusal')

  const raster = collect()
  assert(resolveXyLeadOptions(baseOperation({ pocketPattern: 'parallel' }), 6, regions, false, raster.onWarning) === undefined,
    'raster clearing gets no options')
  assert(raster.warnings.some((warning) => warning.code === 'xyLeadUnsupported'),
    'and is told its request was declined')

  const masked = collect()
  assert(resolveXyLeadOptions(baseOperation(), 6, regions, true, masked.onWarning) === undefined,
    'a masked operation gets no options')
  assert(masked.warnings.some((warning) => warning.code === 'xyLeadRegionMask'),
    'and is told the mask is why')

  const ok = collect()
  const resolved = resolveXyLeadOptions(baseOperation(), 6, regions, false, ok.onWarning)
  assert(resolved !== undefined, 'a supported unmasked operation gets options')
  assert(ok.warnings.length === 0, 'with no warning')
  // The lead budget must be the S-link's, or the two curves would disagree
  // about what fits in the same domain.
  assert(resolved.toolDiameter === 6 && resolved.maxLength === 6 * 2.5, 'the length budget is the S-link\'s')

  assert(xyLeadOptions(baseOperation(), 0, regions) === undefined, 'a degenerate tool gets no options')
  assert(xyLeadOptions(baseOperation(), 6, []) === undefined, 'an empty domain gets no options')
  console.log('gates and warnings: PASSED')
}

function testEntryLatchIsSpentOnce() {
  console.log('Testing the entry latch is spent once per level...')
  const warnings: ToolpathWarning[] = []
  const context = beginXyLeadLevel(openOptions(), (warning) => warnings.push(warning))
  assert(context !== undefined, 'a level context is armed')
  const ring = squareRing(20, 80, 6)
  assert(takeXyLeadIn(context, ring) !== null, 'the first ring takes the lead')
  assert(takeXyLeadIn(context, ring) === null, 'a later ring at the same level does not')
  assert(warnings.length === 0, 'a spent latch is not a failure and does not warn')
  assert(takeXyLeadIn(undefined, ring) === null, 'no context means no lead')

  // A level whose first ring cannot take a lead warns once and does not go
  // hunting through the rest of its rings.
  const failed: ToolpathWarning[] = []
  const tight = beginXyLeadLevel(
    openOptions({ isInsideDomain: () => false }),
    (warning) => failed.push(warning),
  )
  assert(tight !== undefined, 'the tight level is armed')
  assert(takeXyLeadIn(tight, ring) === null, 'no lead fits')
  assert(failed.length === 1 && failed[0].code === 'xyLeadNoViablePath', 'and it says so once')
  assert(tight.entryPending === false, 'the latch is spent either way')
  console.log('entry latch: PASSED')
}

function testExitRecordMustMatchTheCurrentPosition() {
  console.log('Testing the exit only leads off the ring the cutter is standing on...')
  const context = beginXyLeadLevel(openOptions(), () => {})
  assert(context !== undefined, 'a level context is armed')
  const ring = squareRing(20, 80, 6)
  const cutMoves: ToolpathMove[] = ring.map((point, index) => ({
    kind: 'cut' as const,
    from: { x: point.x, y: point.y, z: -2 },
    to: { x: ring[(index + 1) % ring.length].x, y: ring[(index + 1) % ring.length].y, z: -2 },
  }))
  recordXyLeadExit(context, cutMoves)
  assert(context.exit !== null, 'a closed planar ring is recorded')

  const moved: ToolpathMove[] = []
  const elsewhere = emitXyLeadOut(moved, { x: 50, y: 50, z: -2 }, -2, context)
  assert(moved.length === 0 && elsewhere?.x === 50,
    'a position that is not the ring end emits nothing')

  const leaving: ToolpathMove[] = []
  const end = emitXyLeadOut(leaving, { x: ring[0].x, y: ring[0].y, z: -2 }, -2, context)
  assert(leaving.length > 0 && leaving.every((move) => move.kind === 'lead_out'), 'the exit is emitted')
  assert(end !== null && Math.hypot(end.x - ring[0].x, end.y - ring[0].y) > 0.5,
    'and it leaves the ring behind')

  // An open run, or a ramping one, is not a ring and clears the record.
  recordXyLeadExit(context, cutMoves.slice(0, 2))
  assert(context.exit === null, 'an unclosed run is not a ring')
  recordXyLeadExit(context, [
    ...cutMoves.slice(0, cutMoves.length - 1),
    { ...cutMoves[cutMoves.length - 1], to: { ...cutMoves[cutMoves.length - 1].to, z: -3 } },
  ])
  assert(context.exit === null, 'a ramping run is not a planar ring')
  console.log('exit record: PASSED')
}

function testLengthBudgetIsEnforced() {
  console.log('Testing the length budget rejects an oversized lead...')
  const ring = squareRing(20, 80, 6)
  // The narrowest arc in the ladder is 0.25 x D swept 45 deg — far longer.
  assert(planXyLeadIn(ring, openOptions({ maxLength: 0.25 })) === null, 'no entry lead fits the budget')
  assert(planXyLeadOut(ring, openOptions({ maxLength: 0.25 })) === null, 'no exit lead fits the budget')
  assert(planXyLeadIn(ring, openOptions({ toolDiameter: 0 })) === null, 'a degenerate tool plans nothing')
  console.log('length budget: PASSED')
}

try {
  testEntryArrivesTangentToTheRing()
  testExitDepartsTangentFromTheRing()
  testCornerSeamedRingExitsThroughAnOverlap()
  testDomainRejectionLeavesNoLead()
  testSweptSamplingSeesBetweenVertices()
  testDeterminismAndValidatedPlacement()
  testRadiusLadderTakesTheWidestArcThatFits()
  testRotateRingForLead()
  testLeadRunsAtOneConstantFeed()
  testEmittedLeadStaysPlanarAtZ()
  testGatesAndWarnings()
  testEntryLatchIsSpentOnce()
  testExitRecordMustMatchTheCurrentPosition()
  testLengthBudgetIsEnforced()
  console.log('\nAll xyLead tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
