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
 * Packer core (issue #844). Every guarantee is checked on the placed geometry
 * itself — distances are measured between the transformed footprints, not
 * inferred from the translations the packer reports.
 *
 * Run with: npx tsx src/engine/nesting/packer.test.ts
 */

import { expandByHalfGap, largestFirst, shrinkByHalfGap } from './defaults'
import { nest } from './packer'
import { assert, assertValidLayout, GAP_TOLERANCE, rect } from './testLayout'
import type { NestPart, NestRequest, NestResult, NestRing } from './types'

function gear(teeth: number, outer: number, inner: number): NestRing {
  const ring: NestRing = []
  const steps = teeth * 4
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2
    const r = i % 4 < 2 ? outer : inner
    ring.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r })
  }
  return ring
}

function request(overrides: Partial<NestRequest> & Pick<NestRequest, 'parts'>): NestRequest {
  return {
    sheet: rect(0, 0, 100, 100),
    obstacles: [],
    minimumGap: 6,
    expandFootprint: expandByHalfGap,
    shrinkHoles: shrinkByHalfGap,
    orderParts: largestFirst,
    ...overrides,
  }
}

function countPlaced(result: NestResult, partId: string): number {
  return result.placements.filter((placement) => placement.partId === partId).length
}

function unplacedCount(result: NestResult, partId: string): number {
  return result.unplaced.find((entry) => entry.partId === partId)?.count ?? 0
}

function part(id: string, footprint: NestRing[], quantity: number, rotations = [0], holes?: NestRing[]): NestPart {
  return holes ? { id, footprint, quantity, rotations, holes } : { id, footprint, quantity, rotations }
}

/** A 60 mm frame with a 40 mm square hole, filling a 60 mm sheet. */
function frameRequest(small: NestPart, minimumGap: number, islands: NestRing[] = []): NestRequest {
  return request({
    sheet: rect(0, 0, 60, 60),
    minimumGap,
    parts: [part('frame', [rect(0, 0, 60, 60)], 1, [0], [rect(10, 10, 40, 40), ...islands]), small],
  })
}

function testFillsCapacityAndReportsOverflow(): void {
  // 45 + 6 + 45 = 96 ≤ 100, so exactly a 2×2 grid of 45 mm squares fits.
  const req = request({ parts: [part('sq', [rect(0, 0, 45, 45)], 5, [0, 90])] })
  const result = nest(req)
  assert(countPlaced(result, 'sq') === 4, `expected 4 squares placed, got ${countPlaced(result, 'sq')}`)
  assert(unplacedCount(result, 'sq') === 1, 'the fifth square is reported as unplaced')
  const closest = assertValidLayout(req, result, 'capacity')
  assert(closest <= req.minimumGap + 0.05, `packing is tight: closest pair ${closest}`)
}

function testGapComesFromTheCaller(): void {
  const footprint = [rect(0, 0, 20, 20)]
  for (const gap of [0, 3, 12]) {
    const req = request({ minimumGap: gap, parts: [part('sq', footprint, 9)] })
    const result = nest(req)
    const closest = assertValidLayout(req, result, `gap ${gap}`)
    assert(Math.abs(closest - gap) < 0.05, `gap ${gap}: neighbours sit at the gap, got ${closest}`)
  }

  // The placer hands the gap to expandFootprint and uses nothing else: an
  // expansion that ignores it decides the spacing on its own.
  const seen: number[] = []
  const req = request({
    minimumGap: 1,
    expandFootprint: (rings, minimumGap) => {
      seen.push(minimumGap)
      return expandByHalfGap(rings, 10)
    },
    parts: [part('sq', footprint, 4)],
  })
  const result = nest(req)
  assert(seen.length > 0 && seen.every((value) => value === 1), 'expandFootprint receives the caller gap')
  const closest = assertValidLayout({ ...req, minimumGap: 10 }, result, 'custom expansion')
  assert(closest >= 10 - GAP_TOLERANCE, `custom expansion governs spacing, got ${closest}`)
}

function testObstaclesKeepTheGap(): void {
  const clamp = rect(40, 0, 20, 30)
  const req = request({ obstacles: [clamp], parts: [part('sq', [rect(0, 0, 25, 25)], 6, [0, 90])] })
  const result = nest(req)
  assert(result.placements.length > 0, 'parts are placed around the obstacle')
  assertValidLayout(req, result, 'obstacle')
}

function testNonRectangularSheet(): void {
  // L-shaped sheet: the top-right 60×60 corner is missing.
  const sheet: NestRing = [
    { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 60 }, { x: 100, y: 60 }, { x: 100, y: 100 }, { x: 0, y: 100 },
  ]
  const req = request({ sheet, parts: [part('sq', [rect(0, 0, 30, 30)], 8, [0])] })
  const result = nest(req)
  assert(countPlaced(result, 'sq') === 3, `three 30 mm squares fit the L, got ${countPlaced(result, 'sq')}`)
  assertValidLayout(req, result, 'L sheet')
}

function testRoundSheet(): void {
  const sheet: NestRing = Array.from({ length: 64 }, (_, i) => ({
    x: 50 + 50 * Math.cos((i / 64) * Math.PI * 2),
    y: 50 + 50 * Math.sin((i / 64) * Math.PI * 2),
  }))
  const req = request({ sheet, minimumGap: 3, parts: [part('sq', [rect(0, 0, 10, 10)], 5)] })
  const result = nest(req)
  assert(countPlaced(result, 'sq') === 5, `squares fit a round sheet, got ${countPlaced(result, 'sq')}`)
  assertValidLayout(req, result, 'round sheet')
}

function testRotationSetIsRespected(): void {
  // A 90×10 strip only fits a 50-wide sheet when turned a quarter.
  const strip = [rect(0, 0, 90, 10)]
  const tall = rect(0, 0, 50, 200)
  const grain = request({ sheet: tall, parts: [part('strip', strip, 2, [0, 180])] })
  const grainResult = nest(grain)
  assert(grainResult.placements.length === 0, 'grain mode never turns the strip')
  assert(unplacedCount(grainResult, 'strip') === 2, 'both strips reported unplaced')

  const free = request({ sheet: tall, parts: [part('strip', strip, 2, [0, 90, 180, 270])] })
  const freeResult = nest(free)
  assert(freeResult.placements.length === 2, 'quarter turns let both strips fit')
  assert(freeResult.placements.every((p) => p.rotation === 90 || p.rotation === 270), 'strips are turned')
  assertValidLayout(free, freeResult, 'rotated strips')

  // On a sheet where the strip fits either way, 0/180 must still never yield 90.
  const wide = request({ sheet: rect(0, 0, 200, 200), parts: [part('strip', strip, 6, [0, 180])] })
  const wideResult = nest(wide)
  assert(wideResult.placements.every((p) => p.rotation === 0 || p.rotation === 180), 'only 0/180 used')
}

function testSmallPartsStillPlacedAfterOverflow(): void {
  const req = request({
    parts: [
      part('big', [rect(0, 0, 60, 60)], 3),
      part('small', [rect(0, 0, 10, 10)], 4),
    ],
  })
  const result = nest(req)
  assert(countPlaced(result, 'big') === 1 && unplacedCount(result, 'big') === 2, 'one big part fits')
  assert(countPlaced(result, 'small') === 4, 'small parts fill the remaining space')
  assertValidLayout(req, result, 'mixed')
}

function testNonConvexPartsNeverOverlap(): void {
  const req = request({
    sheet: rect(0, 0, 220, 160),
    minimumGap: 4,
    parts: [part('gear', [gear(12, 20, 14)], 12, [0, 90, 180, 270])],
  })
  const result = nest(req)
  assert(result.placements.length >= 6, `gears are placed, got ${result.placements.length}`)
  assertValidLayout(req, result, 'gears')
}

function testMultiRingPartMovesRigidly(): void {
  // An "i": a stem and a separate dot, one part.
  const letter = [rect(0, 10, 6, 30), rect(0, 0, 6, 6)]
  const req = request({ minimumGap: 3, parts: [part('i', letter, 10, [0, 90])] })
  const result = nest(req)
  assert(result.placements.length > 0, 'letters are placed')
  assertValidLayout(req, result, 'letter i')
}

function testExactFitIsAccepted(): void {
  const req = request({ parts: [part('sheet-sized', [rect(0, 0, 100, 100)], 2)] })
  const result = nest(req)
  assert(countPlaced(result, 'sheet-sized') === 1, 'a part exactly the sheet size fits once')
  assert(unplacedCount(result, 'sheet-sized') === 1, 'the second copy is reported')
  assertValidLayout(req, result, 'exact fit')
}

function testGravityCorner(): void {
  const footprint = [rect(0, 0, 20, 10)]
  const toMax = request({ minimumGap: 2, gravity: { x: -1, y: -1 }, parts: [part('p', footprint, 1)] })
  const [first] = nest(toMax).placements
  assert(first.translation.x === 80 && first.translation.y === 90, `first part in the max corner, got ${JSON.stringify(first.translation)}`)
  const bottomLeft = request({ minimumGap: 2, gravity: { x: 1, y: -1 }, parts: [part('p', footprint, 3)] })
  const result = nest(bottomLeft)
  assertValidLayout(bottomLeft, result, 'gravity')
  assert(result.placements.every((p) => p.translation.y + 10 >= 100 - 1e-9 - 20), 'parts hug the max-Y edge')
  assert(result.placements[0].translation.x === 0 && result.placements[0].translation.y === 90, 'first part at min X, max Y')
}

function testSmallPartsGoInsideAHole(): void {
  // 10 + 6 + 10 ≤ 40 − 2·6: a 2×2 block of 10 mm squares fits the hole with
  // the full gap to its edge, and nothing fits anywhere else.
  const req = frameRequest(part('sq', [rect(0, 0, 10, 10)], 5), 6)
  const result = nest(req)
  assert(countPlaced(result, 'frame') === 1, 'the frame is placed')
  assert(countPlaced(result, 'sq') === 4, `four squares go in the hole, got ${countPlaced(result, 'sq')}`)
  assert(unplacedCount(result, 'sq') === 1, 'the fifth square is reported')
  assertValidLayout(req, result, 'hole')

  const noHoles = request({ ...req, parts: req.parts.map((entry) => ({ ...entry, holes: undefined })) })
  assert(countPlaced(nest(noHoles), 'sq') === 0, 'without holes nothing fits')
}

function testHoleKeepsTheFullGap(): void {
  // A 30 mm square needs 30 + 2·gap ≤ 40: it fits with a 4 mm gap, not a 6 mm one.
  const square = part('sq', [rect(0, 0, 30, 30)], 1)
  const fits = frameRequest(square, 4)
  const fitsResult = nest(fits)
  assert(countPlaced(fitsResult, 'sq') === 1, 'fits the hole at gap 4')
  const closest = assertValidLayout(fits, fitsResult, 'gap 4')
  assert(closest <= 4 + 0.05, `the square sits at the gap from the hole's edge, got ${closest}`)
  assert(countPlaced(nest(frameRequest(square, 6)), 'sq') === 0, 'does not fit the hole at gap 6')
}

function testIslandInsideAHoleIsAvoided(): void {
  // A 10 mm island of material in the middle of the hole, wound clockwise.
  const island = [...rect(25, 25, 10, 10)].reverse()
  const req = frameRequest(part('sq', [rect(0, 0, 8, 8)], 12), 3, [island])
  const result = nest(req)
  assert(countPlaced(result, 'sq') >= 4, `squares surround the island, got ${countPlaced(result, 'sq')}`)
  assertValidLayout(req, result, 'island')
}

function testRoundHole(): void {
  // The frame around a round hole is four corner pieces whose no-fit polygons
  // close into a ring; the free positions are the hole that ring encloses.
  const circle: NestRing = Array.from({ length: 64 }, (_, i) => ({
    x: 30 + 20 * Math.cos((i / 64) * Math.PI * 2),
    y: 30 + 20 * Math.sin((i / 64) * Math.PI * 2),
  }))
  const req = request({
    sheet: rect(0, 0, 60, 60),
    minimumGap: 3,
    parts: [part('frame', [rect(0, 0, 60, 60)], 1, [0], [circle]), part('sq', [rect(0, 0, 8, 8)], 6)],
  })
  const result = nest(req)
  assert(countPlaced(result, 'sq') >= 4, `squares go in the round hole, got ${countPlaced(result, 'sq')}`)
  assertValidLayout(req, result, 'round hole')
}

function testRotatedHost(): void {
  // A 60×30 frame with an off-centre hole only fits a 30×60 sheet turned, so
  // the hole moves with the rotation.
  const req = request({
    sheet: rect(0, 0, 30, 60),
    minimumGap: 2,
    parts: [
      part('frame', [rect(0, 0, 60, 30)], 1, [0, 90], [rect(3, 3, 24, 24)]),
      part('sq', [rect(0, 0, 8, 8)], 4, [0, 90]),
    ],
  })
  const result = nest(req)
  assert(result.placements.find((p) => p.partId === 'frame')?.rotation === 90, 'the frame is turned')
  assert(countPlaced(result, 'sq') === 4, `squares fill the turned hole, got ${countPlaced(result, 'sq')}`)
  assertValidLayout(req, result, 'rotated host')
}

/**
 * Grows axis-aligned rectangles by exactly half the gap, with no rounding
 * pad: whatever the grid rounding of a rotated shape costs must be paid for by
 * the placer itself (#867).
 */
function exactRectHalfGap(rings: NestRing[], minimumGap: number): NestRing[] {
  return rings.map((ring) => {
    const xs = ring.map((p) => p.x)
    const ys = ring.map((p) => p.y)
    const half = minimumGap / 2
    const minX = Math.min(...xs) - half
    const minY = Math.min(...ys) - half
    return rect(minX, minY, Math.max(...xs) + half - minX, Math.max(...ys) + half - minY)
  })
}

function testOddAnglesKeepTheExactGap(): void {
  // Every angle off the quarter turns rounds the rotated shapes to the integer
  // grid. Copies at one shared angle touch along parallel edges, so a grid
  // loss shows up as a gap just short of the minimum.
  const lists = [
    ...Array.from({ length: 45 }, (_, index) => [index * 2 + 1]),
    [0, 7, 13, 30, 45],
    Array.from({ length: 24 }, (_, index) => index * 15),
  ]
  for (const rotations of lists) {
    const req = request({
      minimumGap: 6,
      expandFootprint: exactRectHalfGap,
      parts: [part('long', [rect(0, 0, 37, 9)], 6, rotations), part('sq', [rect(0, 0, 13, 13)], 6, rotations)],
    })
    const result = nest(req)
    assert(result.placements.length >= 6, `${rotations.join('/')}°: parts are placed`)
    assert(
      result.placements.every((p) => rotations.includes(p.rotation)),
      `${rotations.join('/')}°: only the allowed angles are used`,
    )
    assertValidLayout(req, result, `${rotations.join('/')}°`)
  }
}

function testDeterministic(): void {
  const build = () => request({
    parts: [
      part('gear', [gear(8, 15, 11)], 5, [0, 90, 180, 270]),
      part('sq', [rect(0, 0, 12, 12)], 6, [0, 90]),
      part('frame', [rect(0, 0, 50, 50)], 2, [0, 90], [rect(8, 8, 30, 30)]),
    ],
  })
  const first = JSON.stringify(nest(build()))
  const second = JSON.stringify(nest(build()))
  assert(first === second, 'identical input gives identical output')
}

function testRejectsInvalidInput(): void {
  const expectThrow = (label: string, run: () => void) => {
    let threw = false
    try {
      run()
    } catch {
      threw = true
    }
    assert(threw, `${label} is rejected`)
  }
  const sq = [rect(0, 0, 10, 10)]
  expectThrow('negative gap', () => nest(request({ minimumGap: -1, parts: [part('a', sq, 1)] })))
  expectThrow('NaN gap', () => nest(request({ minimumGap: Number.NaN, parts: [part('a', sq, 1)] })))
  expectThrow('duplicate id', () => nest(request({ parts: [part('a', sq, 1), part('a', sq, 1)] })))
  expectThrow('fractional quantity', () => nest(request({ parts: [part('a', sq, 1.5)] })))
  expectThrow('no rotation', () => nest(request({ parts: [part('a', sq, 1, [])] })))
  expectThrow('empty footprint', () => nest(request({ parts: [part('a', [], 1)] })))
  expectThrow('holes without shrinkHoles', () => nest(request({
    shrinkHoles: undefined,
    parts: [part('a', [rect(0, 0, 30, 30)], 1, [0], [rect(5, 5, 20, 20)])],
  })))
}

const tests: [string, () => void][] = [
  ['fills capacity and reports overflow', testFillsCapacityAndReportsOverflow],
  ['gap comes from the caller', testGapComesFromTheCaller],
  ['obstacles keep the gap', testObstaclesKeepTheGap],
  ['non-rectangular sheet', testNonRectangularSheet],
  ['round sheet', testRoundSheet],
  ['rotation set is respected', testRotationSetIsRespected],
  ['small parts still placed after overflow', testSmallPartsStillPlacedAfterOverflow],
  ['non-convex parts never overlap', testNonConvexPartsNeverOverlap],
  ['multi-ring part moves rigidly', testMultiRingPartMovesRigidly],
  ['exact fit is accepted', testExactFitIsAccepted],
  ['gravity corner', testGravityCorner],
  ['small parts go inside a hole', testSmallPartsGoInsideAHole],
  ['a hole keeps the full gap', testHoleKeepsTheFullGap],
  ['an island inside a hole is avoided', testIslandInsideAHoleIsAvoided],
  ['a round hole', testRoundHole],
  ['a rotated host carries its hole', testRotatedHost],
  ['odd angles keep the exact gap', testOddAnglesKeepTheExactGap],
  ['deterministic', testDeterministic],
  ['rejects invalid input', testRejectsInvalidInput],
]

let failed = 0
for (const [name, run] of tests) {
  try {
    run()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}\n    ${(error as Error).message}`)
  }
}
if (failed > 0) {
  console.error(`\n${failed} nesting packer test(s) failed`)
  process.exit(1)
}
console.log('\nAll nesting packer tests passed')
