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
 * Unit tests for XY lead planning and emission (issue #695).
 * Run with: npx tsx src/engine/toolpaths/xyLead.test.ts
 */

import {
  beginXyLeadLevel,
  emitXyLead,
  emitXyLeadOut,
  leadInitialFeedScale,
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
import { buildOffsetDomainCheck } from './tangentLink'
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

function openOptions(overrides: Partial<XyLeadOptions> = {}): XyLeadOptions {
  return {
    minRadius: 1.5,
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
    xyLeadStrategy: 'tangent_s',
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

  // The whole point of the feature: the descent no longer lands on the ring.
  const offset = Math.hypot(plan.staging.x - arrival.x, plan.staging.y - arrival.y)
  assert(offset > options.minRadius * 0.5, `staging point is off the ring (offset ${offset})`)
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
  assert(offset > options.minRadius * 0.5, `staging point is off the ring (offset ${offset})`)
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
  console.log('Testing the domain gate samples between lead vertices...')
  const ring = squareRing(20, 80, 6)
  // Punch a hole smaller than any lead vertex spacing. A gate that only tested
  // the emitted vertices would drive the swept cutter straight through it.
  let holeHits = 0
  const options = openOptions({
    isInsideDomain: (x, y) => {
      const inside = x > 0 && x < 100 && y > 0 && y < 100
      if (!inside) return false
      // Ring the whole square with a forbidden collar just inside the ring, so
      // every candidate lead has to cross it somewhere between two vertices.
      const nearRing = Math.min(
        Math.abs(x - 20), Math.abs(x - 80), Math.abs(y - 20), Math.abs(y - 80),
      )
      if (nearRing > 0.05 && nearRing < 0.35 && x >= 19 && x <= 81 && y >= 19 && y <= 81) {
        holeHits += 1
        return false
      }
      return true
    },
  })
  assert(planXyLeadIn(ring, options) === null, 'a lead crossing the collar is refused')
  assert(holeHits > 0, 'the collar was actually reached by the sampler')
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

function testFeedRampRisesInAndFallsOut() {
  console.log('Testing the lead feed ramp...')
  const options = openOptions()
  const initial = leadInitialFeedScale(options)
  assert(Math.abs(initial - 300 / 800) < 1e-12, 'the initial scale is plungeFeed / feed')

  const points: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }]
  const plan = { points, staging: points[0], arrivalIndex: 0 }

  const inMoves: ToolpathMove[] = []
  emitXyLead(inMoves, { x: 0, y: 0, z: -2 }, plan, -2, options, 'lead_in')
  assert(inMoves.length === 4, 'one move per lead segment')
  assert(inMoves.every((move) => move.kind === 'lead_in'), 'entry moves are classified lead_in')
  const inScales = inMoves.map((move) => move.feedScale ?? 1)
  assert(inScales.every((scale, index) => index === 0 || scale > inScales[index - 1]),
    'the entry feed rises monotonically')
  assert(inScales[0] > initial && inScales[0] < 1, 'the entry starts near the constrained feed')
  assert(inScales[inScales.length - 1] < 1, 'the entry never claims full feed before the ring')

  const outMoves: ToolpathMove[] = []
  emitXyLead(outMoves, { x: 0, y: 0, z: -2 }, plan, -2, options, 'lead_out')
  assert(outMoves.every((move) => move.kind === 'lead_out'), 'exit moves are classified lead_out')
  const outScales = outMoves.map((move) => move.feedScale ?? 1)
  assert(outScales.every((scale, index) => index === 0 || scale < outScales[index - 1]),
    'the exit feed falls monotonically')
  assert(Math.abs(outScales[0] - inScales[inScales.length - 1]) < 1e-12,
    'the exit ramp is the entry ramp reversed')

  // Adjacent lead moves must never be mergeable by the linear-move optimizer,
  // which merges only same-kind moves that share a feedScale.
  const distinct = new Set(inScales.map((scale) => scale.toFixed(12)))
  assert(distinct.size === inScales.length, 'every collinear lead move carries a distinct feed scale')

  // A plunge feed at or above the cut feed leaves no ramp to apply at all.
  const unlimited: ToolpathMove[] = []
  emitXyLead(unlimited, { x: 0, y: 0, z: -2 }, plan, -2, openOptions({ plungeFeed: 900 }), 'lead_in')
  assert(unlimited.every((move) => move.feedScale === undefined),
    'no feedScale is stamped when the plunge feed does not constrain the lead')
  console.log('feed ramp: PASSED')
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
  assert(resolved.minRadius === 6 * 0.25 && resolved.maxLength === 6 * 2.5, 'the S-link budget is reused')

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
  // Every shape in the family is longer than a quarter of the floor radius.
  assert(planXyLeadIn(ring, openOptions({ maxLength: 0.25 })) === null, 'no entry lead fits the budget')
  assert(planXyLeadOut(ring, openOptions({ maxLength: 0.25 })) === null, 'no exit lead fits the budget')
  assert(planXyLeadIn(ring, openOptions({ minRadius: 0 })) === null, 'a degenerate radius plans nothing')
  console.log('length budget: PASSED')
}

try {
  testEntryArrivesTangentToTheRing()
  testExitDepartsTangentFromTheRing()
  testCornerSeamedRingExitsThroughAnOverlap()
  testDomainRejectionLeavesNoLead()
  testSweptSamplingSeesBetweenVertices()
  testDeterminismAndValidatedPlacement()
  testRotateRingForLead()
  testFeedRampRisesInAndFallsOut()
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
