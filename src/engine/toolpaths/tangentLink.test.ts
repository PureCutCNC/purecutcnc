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
 * Unit tests for tangential link-junction fillets (issue #545).
 * Run with: npx tsx src/engine/toolpaths/tangentLink.test.ts
 */

import {
  buildOffsetDomainCheck,
  collinearRunLength,
  linkJunctionFillet,
  pocketLinkFilletOptions,
  type LinkFilletOptions,
} from './tangentLink'
import type { Point } from '../../types/project'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps
}

const insideEverything: LinkFilletOptions = {
  maxRadius: 2,
  minRadius: 0.1,
  toolRadius: 3,
  isInsideDomain: () => true,
}

const uX: Point = { x: 1, y: 0 }
const uY: Point = { x: 0, y: 1 }

function unit(angleDeg: number): Point {
  const rad = (angleDeg * Math.PI) / 180
  return { x: Math.cos(rad), y: Math.sin(rad) }
}

function segmentDirection(from: Point, to: Point): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  return { x: dx / length, y: dy / length }
}

function angleBetween(a: Point, b: Point): number {
  const cos = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y))
  return Math.acos(cos)
}

function testRightAngleFilletTangentAtBothEnds() {
  console.log('Testing right-angle junction fillet is tangent at both ends...')
  const corner: Point = { x: 10, y: 10 }
  // Incoming along +x into the corner, outgoing +y (90 degree left turn).
  const points = linkJunctionFillet(corner, uX, uY, 5, 5, insideEverything)
  assert(points !== null, '90-degree junction with unrestricted domain must fillet')
  const p = points as Point[]
  // The half-tool-radius coverage cap binds before maxRadius 2:
  // tangent = toolRadius/2 = 1.5, radius = tangent/tan45 = 1.5.
  assert(approx(p[0].x, 8.5) && approx(p[0].y, 10), 'entry tangent point sits back along the incoming segment')
  assert(approx(p[p.length - 1].x, 10) && approx(p[p.length - 1].y, 11.5), 'exit tangent point sits ahead along the outgoing segment')
  // First arc segment continues the incoming direction, last continues outgoing.
  const firstDir = segmentDirection(p[0], p[1])
  const lastDir = segmentDirection(p[p.length - 2], p[p.length - 1])
  // Tessellation chords deviate by at most half the 5-degree arc step.
  assert(angleBetween(firstDir, uX) < 0.05, 'first arc segment is tangent to the incoming direction')
  assert(angleBetween(lastDir, uY) < 0.05, 'last arc segment is tangent to the outgoing direction')
  // All arc points at the fillet radius from the centre.
  const centre = { x: 8.5, y: 11.5 }
  for (const point of p) {
    assert(approx(Math.hypot(point.x - centre.x, point.y - centre.y), 1.5, 1e-3), 'every arc point lies on the fillet circle')
  }
  console.log('right-angle fillet tangency: PASSED')
}

function testDomainRejectionStaysSharp() {
  console.log('Testing domain rejection keeps the junction sharp...')
  const corner: Point = { x: 10, y: 10 }
  // The fillet bulges to the upper-left of the corner; a domain that only
  // admits points at or right of x=10 rejects every radius.
  const rightHalf: LinkFilletOptions = {
    ...insideEverything,
    isInsideDomain: (x) => x >= 10 - 1e-9,
  }
  assert(linkJunctionFillet(corner, uX, uY, 5, 5, rightHalf) === null, 'domain that excludes the bulge must reject the fillet')
  // A tighter domain that still admits the tangent points must shrink the
  // radius rather than reject outright.
  const nearWall: LinkFilletOptions = {
    ...insideEverything,
    maxRadius: 2,
    isInsideDomain: (x) => x >= 8.3 - 1e-9, // admits radius up to ~1.2
  }
  const points = linkJunctionFillet(corner, uX, uY, 5, 5, nearWall)
  assert(points !== null, 'domain admitting a smaller radius must fillet with it')
  const p = points as Point[]
  assert(p[0].x > 8.3 - 1e-6, 'entry tangent point stays inside the domain')
  assert(p[0].x > 8, 'radius was reduced below the unconstrained value')
  console.log('domain rejection: PASSED')
}

function testRadiusFloorAndGentlyCurvedJunctions() {
  console.log('Testing radius floor and shallow junctions...')
  const corner: Point = { x: 0, y: 0 }
  const tiny: LinkFilletOptions = { ...insideEverything, maxRadius: 0.4, minRadius: 0.5 }
  assert(linkJunctionFillet(corner, uX, uY, 5, 5, tiny) === null, 'maxRadius below the floor must stay sharp')
  // 10 degrees of deflection is below the default 20-degree minimum.
  const shallow = linkJunctionFillet(corner, uX, unit(10), 5, 5, insideEverything)
  assert(shallow === null, '10-degree junction needs no fillet')
  // 30 degrees gets one.
  const mild = linkJunctionFillet(corner, uX, unit(30), 5, 5, insideEverything)
  assert(mild !== null, '30-degree junction fillets')
  console.log('radius floor and shallow junctions: PASSED')
}

function testHairpinAndDegenerateJunctions() {
  console.log('Testing hairpin and degenerate junctions...')
  const corner: Point = { x: 0, y: 0 }
  assert(linkJunctionFillet(corner, uX, { x: -1, y: 0 }, 5, 5, insideEverything) === null, 'full reversal stays sharp')
  assert(linkJunctionFillet(corner, uX, uY, 0, 5, insideEverything) === null, 'zero-length incoming segment stays sharp')
  assert(linkJunctionFillet(corner, uX, uY, 5, 0, insideEverything) === null, 'zero-length outgoing segment stays sharp')
  console.log('hairpin and degenerate junctions: PASSED')
}

function testSegmentLengthClamp() {
  console.log('Testing the tangent points never exceed the segment lengths...')
  const corner: Point = { x: 0, y: 0 }
  const clamped = linkJunctionFillet(corner, uX, uY, 0.5, 0.5, insideEverything)
  assert(clamped !== null, 'junction with short segments still fillets')
  const p = clamped as Point[]
  assert(approx(p[0].x, -0.5) && approx(p[0].y, 0), 'entry tangent point clamps to the incoming segment end')
  assert(approx(p[p.length - 1].x, 0) && approx(p[p.length - 1].y, 0.5), 'exit tangent point clamps to the outgoing segment end')
  // So short that no radius >= minRadius fits.
  const tooShort: LinkFilletOptions = { ...insideEverything, minRadius: 0.2 }
  assert(linkJunctionFillet(corner, uX, uY, 0.05, 5, tooShort) === null, 'segments shorter than the floor radius stay sharp')
  console.log('segment length clamp: PASSED')
}

function testCoverageCapBindsTangent() {
  console.log('Testing the half-tool-radius coverage cap...')
  const corner: Point = { x: 0, y: 0 }
  const capped: LinkFilletOptions = { ...insideEverything, maxRadius: 10, toolRadius: 1 }
  const p = linkJunctionFillet(corner, uX, uY, 50, 50, capped) as Point[]
  // Tangent setback <= toolRadius/2 = 0.5 even though maxRadius allows more.
  assert(approx(p[0].x, -0.5) && approx(p[0].y, 0), 'tangent setback capped at half the tool radius')
  assert(approx(p[p.length - 1].x, 0) && approx(p[p.length - 1].y, 0.5), 'exit tangent point matches the same cap')
  console.log('coverage cap: PASSED')
}

function testDeterminism() {
  console.log('Testing determinism...')
  const corner: Point = { x: 1.5, y: -2.25 }
  const incoming = unit(17)
  const outgoing = unit(-64)
  const a = linkJunctionFillet(corner, incoming, outgoing, 4, 4, insideEverything)
  const b = linkJunctionFillet(corner, incoming, outgoing, 4, 4, insideEverything)
  assert(a !== null && b !== null, 'both runs fillet')
  assert(JSON.stringify(a) === JSON.stringify(b), 'identical inputs produce identical points')
  console.log('determinism: PASSED')
}

function testCollinearRunLength() {
  console.log('Testing collinear run lengths...')
  const maxLength = 10
  const minDeflection = (20 * Math.PI) / 180
  // A straight square edge: the run stops at the first 90-degree bend.
  const square: Point[] = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
  ]
  assert(approx(collinearRunLength(square, 0, 1, maxLength, minDeflection), 10), 'forward run capped at maxLength on a long straight edge')
  assert(approx(collinearRunLength(square, 0, -1, maxLength, minDeflection), 10), 'backward run capped at maxLength')
  // A short edge: the run stops at the corner before reaching the cap.
  const short: Point[] = [
    { x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 10 }, { x: 0, y: 10 },
  ]
  assert(approx(collinearRunLength(short, 0, 1, maxLength, minDeflection), 3), 'run stops at the corner bend')
  // A tessellated arc: 5-degree steps accumulate across chords until the cap.
  const arc: Point[] = [{ x: 0, y: 0 }]
  let heading = 0
  for (let index = 0; index < 24; index += 1) {
    heading += (5 * Math.PI) / 180
    const previous = arc[arc.length - 1]
    arc.push({ x: previous.x + Math.cos(heading), y: previous.y + Math.sin(heading) })
  }
  const run = collinearRunLength(arc, 0, 1, maxLength, minDeflection)
  // The run accumulates chords while the total deviation from the base
  // direction stays under 20 degrees: four 5-degree chords.
  assert(approx(run, 4), '5-degree chords accumulate across the tessellation until the 20-degree limit, got ' + run.toFixed(3))
  // Degenerate inputs.
  assert(collinearRunLength([{ x: 0, y: 0 }], 0, 1, maxLength, minDeflection) === 0, 'single point has no run')
  assert(collinearRunLength(arc, 0, 1, 0, minDeflection) === 0, 'zero cap has no run')
  console.log('collinear run lengths: PASSED')
}

function testDomainCheck() {
  console.log('Testing the offset-domain predicate...')
  const domain = buildOffsetDomainCheck([
    {
      outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      islands: [[{ x: 4, y: 4 }, { x: 6, y: 4 }, { x: 6, y: 6 }, { x: 4, y: 6 }]],
    },
    {
      outer: [{ x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 20, y: 10 }],
      islands: [],
    },
  ])
  assert(domain(2, 2), 'inside the outer, outside the island')
  assert(!domain(5, 5), 'inside the island is rejected')
  assert(!domain(15, 5), 'between disjoint regions is rejected')
  assert(domain(25, 5), 'inside a second region')
  assert(!domain(35, 5), 'outside everything is rejected')
  console.log('offset-domain predicate: PASSED')
}

function testPocketOptionsGating() {
  console.log('Testing pocket option gating...')
  const region = { outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], islands: [] as Point[][] }
  assert(pocketLinkFilletOptions(undefined, 3, 2, [region]) === undefined, 'undefined flag disables')
  assert(pocketLinkFilletOptions(false, 3, 2, [region]) === undefined, 'false flag disables')
  const options = pocketLinkFilletOptions(true, 3, 2, [region])
  assert(options !== undefined, 'true flag enables')
  const o = options as LinkFilletOptions
  assert(approx(o.maxRadius, 6 * 0.4), 'maxRadius = 0.4 x tool diameter')
  assert(approx(o.minRadius, 1), 'minRadius = 0.5 x stepover')
  assert(approx(o.toolRadius, 3), 'toolRadius carried through')
  assert(o.isInsideDomain(5, 5), 'domain predicate wired')
  assert(!o.isInsideDomain(20, 20), 'domain predicate rejects outside')
  console.log('pocket option gating: PASSED')
}

try {
  testRightAngleFilletTangentAtBothEnds()
  testDomainRejectionStaysSharp()
  testRadiusFloorAndGentlyCurvedJunctions()
  testHairpinAndDegenerateJunctions()
  testSegmentLengthClamp()
  testCoverageCapBindsTangent()
  testDeterminism()
  testCollinearRunLength()
  testDomainCheck()
  testPocketOptionsGating()
  console.log('\nAll tangentLink tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
