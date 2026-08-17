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

function assert(condition: boolean, message: string): asserts condition {
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

/** Straight ring run of chords of the given length along a direction. */
function ringRun(corner: Point, direction: Point, chordLength: number, chordCount: number): Point[] {
  const vertices: Point[] = [corner]
  for (let index = 0; index < chordCount; index += 1) {
    const previous = vertices[vertices.length - 1]
    vertices.push({ x: previous.x + direction.x * chordLength, y: previous.y + direction.y * chordLength })
  }
  return vertices
}

function testRightAngleFilletTangentAtBothEnds() {
  console.log('Testing right-angle junction fillet is tangent at both ends...')
  const corner: Point = { x: 10, y: 10 }
  // Link from the west into the corner, ring turning north (left turn).
  const result = linkJunctionFillet(
    corner,
    { x: 5, y: 10 },
    5,
    ringRun(corner, { x: 0, y: 1 }, 1, 5),
    insideEverything,
  )
  assert(result !== null, '90-degree junction with unrestricted domain must fillet')
  const points = result.points
  // The ring vertices are 1.0 apart; the coverage cap (1.5) admits k = 1,
  // so the radius is 1.0 and the link tangent sits 1.0 from the corner.
  assert(approx(result.linkTangent, 1), 'link tangent distance matches the ring vertex span')
  assert(result.ringChordsConsumed === 1, 'one ring chord consumed')
  assert(approx(points[0].x, 9) && approx(points[0].y, 10), 'arc starts on the link segment')
  assert(approx(points[points.length - 1].x, 10) && approx(points[points.length - 1].y, 11), 'arc ends on the ring vertex')
  // Tangency: the first arc chord continues the link heading, the last
  // continues the ring chord heading (tessellation chords deviate <= half the
  // 5-degree arc step).
  const firstDir = segmentDirection(points[0], points[1])
  const lastDir = segmentDirection(points[points.length - 2], points[points.length - 1])
  assert(angleBetween(firstDir, { x: 1, y: 0 }) < 0.05, 'first arc segment is tangent to the link')
  assert(angleBetween(lastDir, { x: 0, y: 1 }) < 0.05, 'last arc segment is tangent to the ring')
  // All arc points lie on the fillet circle centred at the corner's interior.
  const centre = { x: 9, y: 11 }
  for (const point of points) {
    assert(approx(Math.hypot(point.x - centre.x, point.y - centre.y), 1, 1e-3), 'every arc point lies on the fillet circle')
  }
  console.log('right-angle fillet tangency: PASSED')
}

function testDomainRejectionStaysSharp() {
  console.log('Testing domain rejection keeps the junction sharp...')
  const corner: Point = { x: 10, y: 10 }
  const ring = ringRun(corner, { x: 0, y: 1 }, 0.5, 5)
  // A domain that excludes the whole fillet bulge rejects every candidate.
  const tight: LinkFilletOptions = {
    ...insideEverything,
    isInsideDomain: (x) => x >= 9.9 - 1e-9,
  }
  assert(linkJunctionFillet(corner, { x: 5, y: 10 }, 5, ring, tight) === null, 'domain that excludes the bulge must reject the fillet')
  // A domain that admits only the smaller candidate (k = 1) picks it rather
  // than rejecting outright.
  const partial: LinkFilletOptions = {
    ...insideEverything,
    isInsideDomain: (x) => x >= 9.0 - 1e-9,
  }
  const result = linkJunctionFillet(corner, { x: 5, y: 10 }, 5, ring, partial)
  assert(result !== null, 'domain admitting a smaller candidate must fillet with it')
  // The unconstrained largest candidate (k = 3, tangent 1.5) violates the
  // domain (its link tangent point sits at x = 8.5); the next candidate
  // (k = 2, tangent 1.0) fits and is chosen.
  assert(approx(result.linkTangent, 1), 'the fillet shrinks to the largest admitted candidate')
  console.log('domain rejection: PASSED')
}

function testRadiusFloorAndGentlyCurvedJunctions() {
  console.log('Testing radius floor and shallow junctions...')
  const corner: Point = { x: 0, y: 0 }
  const ring = ringRun(corner, { x: 0, y: 1 }, 1, 3)
  const tiny: LinkFilletOptions = { ...insideEverything, maxRadius: 0.4, minRadius: 0.5 }
  assert(linkJunctionFillet(corner, { x: -5, y: 0 }, 5, ring, tiny) === null, 'candidates above the max radius stay sharp')
  // 10 degrees of deflection is below the default 20-degree minimum.
  const shallow = linkJunctionFillet(corner, { x: -5, y: 0 }, 5, ringRun(corner, unit(10), 1, 3), insideEverything)
  assert(shallow === null, '10-degree junction needs no fillet')
  // A 30-degree turn needs ~3.7x the tangent span in radius, so the ring
  // vertices must be fine enough for a candidate to fit under maxRadius.
  const mild = linkJunctionFillet(corner, { x: -5, y: 0 }, 5, ringRun(corner, unit(30), 0.2, 6), insideEverything)
  assert(mild !== null, '30-degree junction fillets when a candidate fits')
  console.log('radius floor and shallow junctions: PASSED')
}

function testHairpinAndDegenerateJunctions() {
  console.log('Testing hairpin and degenerate junctions...')
  const corner: Point = { x: 0, y: 0 }
  const west: Point = { x: -5, y: 0 }
  assert(linkJunctionFillet(corner, west, 5, ringRun(corner, { x: 1, y: 0 }, 1, 3), insideEverything) === null, 'full reversal stays sharp')
  assert(linkJunctionFillet(corner, west, 0, ringRun(corner, { x: 0, y: 1 }, 1, 3), insideEverything) === null, 'zero-length link stays sharp')
  assert(linkJunctionFillet(corner, west, 5, [corner], insideEverything) === null, 'no ring vertices stays sharp')
  assert(linkJunctionFillet(corner, west, 5, [{ x: 1, y: 1 }, { x: 1, y: 2 }], insideEverything) === null, 'ring not anchored at the corner stays sharp')
  console.log('hairpin and degenerate junctions: PASSED')
}

function testLinkLengthAndCapBounds() {
  console.log('Testing the link length and coverage cap bounds...')
  const corner: Point = { x: 0, y: 0 }
  const shortLink = linkJunctionFillet(corner, { x: -0.5, y: 0 }, 0.5, ringRun(corner, { x: 0, y: 1 }, 1, 3), insideEverything)
  assert(shortLink === null, 'link shorter than the first ring chord stays sharp')
  // Half-tool-radius cap: with toolRadius 1 the tangent can never exceed 0.5.
  const capped: LinkFilletOptions = { ...insideEverything, toolRadius: 1 }
  const result = linkJunctionFillet(corner, { x: -5, y: 0 }, 5, ringRun(corner, { x: 0, y: 1 }, 0.2, 6), capped)
  assert(result !== null, 'junction with fine ring chords fillets')
  assert(result.linkTangent <= 0.5 + 1e-9, 'link tangent bounded by half the tool radius')
  console.log('link length and cap bounds: PASSED')
}

function testDeterminism() {
  console.log('Testing determinism...')
  const corner: Point = { x: 1.5, y: -2.25 }
  const ring = ringRun(corner, unit(-64), 0.3, 8)
  const a = linkJunctionFillet(corner, { x: corner.x - 4 * unit(17).x, y: corner.y - 4 * unit(17).y }, 4, ring, insideEverything)
  const b = linkJunctionFillet(corner, { x: corner.x - 4 * unit(17).x, y: corner.y - 4 * unit(17).y }, 4, ring, insideEverything)
  assert(a !== null && b !== null, 'both runs fillet')
  assert(JSON.stringify(a) === JSON.stringify(b), 'identical inputs produce identical results')
  console.log('determinism: PASSED')
}

function testCollinearRunLength() {
  console.log('Testing collinear run lengths...')
  const maxLength = 10
  const minDeflection = (20 * Math.PI) / 180
  const square: Point[] = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
  ]
  assert(approx(collinearRunLength(square, 0, 1, maxLength, minDeflection), 10), 'forward run capped at maxLength on a long straight edge')
  assert(approx(collinearRunLength(square, 0, -1, maxLength, minDeflection), 10), 'backward run capped at maxLength')
  const short: Point[] = [
    { x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 10 }, { x: 0, y: 10 },
  ]
  assert(approx(collinearRunLength(short, 0, 1, maxLength, minDeflection), 3), 'run stops at the corner bend')
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
  testLinkLengthAndCapBounds()
  testDeterminism()
  testCollinearRunLength()
  testDomainCheck()
  testPocketOptionsGating()
  console.log('\nAll tangentLink tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
