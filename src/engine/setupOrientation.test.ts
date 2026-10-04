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
 * Setup orientation transforms and face-local depth (issue #944).
 *
 * The stock used throughout is deliberately off the project origin and not
 * square — 100 × 80 × 20 with its corner at (10, 5) — so a transform that
 * pivots about the wrong point, or about the project origin, cannot land on
 * the expected numbers by accident. Its centre is (60, 45) and mid-thickness
 * is 10.
 *
 * Mutations these assertions were checked against:
 * - pivot taken from the stock corner instead of its centre
 *   → "half turn about X/Y" and "the stock maps onto itself" fail;
 * - Z left alone, or negated without the pivot (`-z`)
 *   → "half turn about X/Y" and "Z stays inside [0, thickness]" fail;
 * - the half turn applied at 0° → "0° returns the point itself" fails;
 * - the two axes swapped → "half turn about X" and "about Y" fail;
 * - `isSupportedSetupOrientation` accepting any angle → "other angles are
 *   rejected" fails;
 * - `depthFromFace` reading the wrong face → "depth from each face" fails;
 * - `spanFromFaceDepth` swapping a reversed span → "a reversed depth is
 *   refused" fails.
 *
 * Run with: npx tsx src/engine/setupOrientation.test.ts
 */

import { defaultStock, defaultTopSetup, newProject, rectProfile } from '../types/project'
import type { MachineOrigin, MachiningSetup, SetupOrientation, Stock } from '../types/project'
import {
  canonicalToSetupPoint,
  depthFromFace,
  isSupportedSetupOrientation,
  orientationForFace,
  setupFace,
  setupFlipsArcDirection,
  setupForOperation,
  setupFrame,
  setupFrameForOperation,
  setupOriginInCanonical,
  setupPivot,
  setupToCanonicalPoint,
  spanFromFaceDepth,
} from './setupOrientation'
import type { SetupPoint } from './setupOrientation'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  )
}

function assertThrows(run: () => unknown, label: string): void {
  try {
    run()
  } catch {
    return
  }
  throw new Error(`Assertion failed: ${label}: expected a throw`)
}

const STOCK: Stock = { ...defaultStock(), profile: rectProfile(10, 5, 100, 80), thickness: 20 }
const TOP: SetupOrientation = { axis: 'x', angleDeg: 0 }
const BOTTOM_X: SetupOrientation = { axis: 'x', angleDeg: 180 }
const BOTTOM_Y: SetupOrientation = { axis: 'y', angleDeg: 180 }

/** Twice the signed area of a → b → c in the XY plane; its sign is the turn sense. */
function turnSense(a: SetupPoint, b: SetupPoint, c: SetupPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function testPivot(): void {
  console.log('Testing the pivot is the stock centre at mid-thickness...')
  assertEqual(setupPivot(STOCK), { x: 60, y: 45, z: 10 }, 'pivot')
}

function testIdentityAtZero(): void {
  console.log('Testing 0° returns the point itself...')
  const point = { x: 12, y: 7, z: 3 }
  for (const axis of ['x', 'y'] as const) {
    const frame = setupFrame({ axis, angleDeg: 0 }, STOCK)
    // The same object, not an equal one: Top must add no arithmetic at all.
    assert(canonicalToSetupPoint(point, frame) === point, `0° about ${axis} returns the point itself`)
    assert(setupToCanonicalPoint(point, frame) === point, `0° about ${axis} inverse returns the point itself`)
  }
  assertEqual(point, { x: 12, y: 7, z: 3 }, 'the input is not mutated')
}

function testHalfTurns(): void {
  console.log('Testing a half turn is the mirror plus the Z flip...')
  const point = { x: 12, y: 7, z: 3 }
  // About X: (x, y, z) → (x, 2·cy − y, thickness − z) with cy = 45.
  assertEqual(canonicalToSetupPoint(point, setupFrame(BOTTOM_X, STOCK)), { x: 12, y: 83, z: 17 }, 'half turn about X')
  // About Y: (x, y, z) → (2·cx − x, y, thickness − z) with cx = 60.
  assertEqual(canonicalToSetupPoint(point, setupFrame(BOTTOM_Y, STOCK)), { x: 108, y: 7, z: 17 }, 'half turn about Y')
  assertEqual(point, { x: 12, y: 7, z: 3 }, 'the input is not mutated')
}

function testStockMapsOntoItself(): void {
  console.log('Testing the turned stock occupies the same box...')
  for (const orientation of [BOTTOM_X, BOTTOM_Y]) {
    const frame = setupFrame(orientation, STOCK)
    const corners: SetupPoint[] = []
    for (const x of [10, 110]) for (const y of [5, 85]) for (const z of [0, 20]) corners.push({ x, y, z })
    const turned = corners.map((corner) => canonicalToSetupPoint(corner, frame))
    const range = (axis: keyof SetupPoint) => [
      Math.min(...turned.map((corner) => corner[axis])),
      Math.max(...turned.map((corner) => corner[axis])),
    ]
    assertEqual([range('x'), range('y'), range('z')], [[10, 110], [5, 85], [0, 20]], `the stock maps onto itself about ${orientation.axis}`)
    // The bottom face ends up on top, and the top face on the table.
    assertEqual(canonicalToSetupPoint({ x: 60, y: 45, z: 0 }, frame).z, 20, `Z stays inside [0, thickness] about ${orientation.axis}: bottom face up`)
    assertEqual(canonicalToSetupPoint({ x: 60, y: 45, z: 20 }, frame).z, 0, `Z stays inside [0, thickness] about ${orientation.axis}: top face down`)
  }
}

function testRoundTrip(): void {
  console.log('Testing canonical ↔ setup-local round trips both ways...')
  const points: SetupPoint[] = [
    { x: 12, y: 7, z: 3 },
    { x: 110, y: 85, z: 20 },
    { x: -4.25, y: 130.5, z: -1.5 },
    { x: 60, y: 45, z: 10 },
  ]
  for (const orientation of [TOP, BOTTOM_X, BOTTOM_Y]) {
    const frame = setupFrame(orientation, STOCK)
    for (const point of points) {
      const label = `${orientation.angleDeg}° about ${orientation.axis} at ${JSON.stringify(point)}`
      assertEqual(setupToCanonicalPoint(canonicalToSetupPoint(point, frame), frame), point, `canonical → local → canonical, ${label}`)
      assertEqual(canonicalToSetupPoint(setupToCanonicalPoint(point, frame), frame), point, `local → canonical → local, ${label}`)
    }
  }
  // The pivot is the one point a half turn leaves where it was.
  assertEqual(canonicalToSetupPoint({ x: 60, y: 45, z: 10 }, setupFrame(BOTTOM_X, STOCK)), { x: 60, y: 45, z: 10 }, 'the pivot is fixed')
}

function testOtherAnglesRejected(): void {
  console.log('Testing other angles are rejected...')
  const unsupported: SetupOrientation[] = [
    { axis: 'x', angleDeg: 90 },
    { axis: 'y', angleDeg: 45 },
    { axis: 'x', angleDeg: -180 },
    { axis: 'x', angleDeg: 360 },
    { axis: 'y', angleDeg: 179.999 },
    { axis: 'x', angleDeg: Number.NaN },
    { axis: 'z' as SetupOrientation['axis'], angleDeg: 180 },
  ]
  for (const orientation of unsupported) {
    const label = `${orientation.angleDeg}° about ${String(orientation.axis)}`
    assert(!isSupportedSetupOrientation(orientation), `${label} is not supported`)
    assertThrows(() => setupFrame(orientation, STOCK), `${label}: setupFrame`)
    assertThrows(() => setupFace({ orientation }), `${label}: setupFace`)
    assertThrows(() => setupFlipsArcDirection(orientation), `${label}: setupFlipsArcDirection`)
    // A frame built by hand must not slip an unsupported turn past the transform.
    const forged = { orientation, pivot: setupPivot(STOCK) }
    assertThrows(() => canonicalToSetupPoint({ x: 1, y: 2, z: 3 }, forged), `${label}: canonicalToSetupPoint`)
    assertThrows(() => setupToCanonicalPoint({ x: 1, y: 2, z: 3 }, forged), `${label}: setupToCanonicalPoint`)
  }
  for (const orientation of [TOP, { axis: 'y', angleDeg: 0 } as const, BOTTOM_X, BOTTOM_Y]) {
    assert(isSupportedSetupOrientation(orientation), `${orientation.angleDeg}° about ${orientation.axis} is supported`)
  }
}

function testFace(): void {
  console.log('Testing the face is derived from the orientation...')
  assertEqual(setupFace({ orientation: TOP }), 'top', '0° is Top')
  assertEqual(setupFace({ orientation: { axis: 'y', angleDeg: 0 } }), 'top', '0° about Y is Top')
  assertEqual(setupFace({ orientation: BOTTOM_X }), 'bottom', '180° about X is Bottom')
  assertEqual(setupFace({ orientation: BOTTOM_Y }), 'bottom', '180° about Y is Bottom')
  assertEqual(orientationForFace('top'), { axis: 'x', angleDeg: 0 }, 'orientation for Top')
  assertEqual(orientationForFace('bottom', 'y'), { axis: 'y', angleDeg: 180 }, 'orientation for Bottom about Y')
}

function testArcDirection(): void {
  console.log('Testing a half turn reverses XY arc direction...')
  assert(!setupFlipsArcDirection(TOP), 'Top keeps arc direction')
  assert(setupFlipsArcDirection(BOTTOM_X), 'Bottom about X flips arc direction')
  assert(setupFlipsArcDirection(BOTTOM_Y), 'Bottom about Y flips arc direction')

  // The flag has to agree with what the transform does to three points on an arc.
  const arc: SetupPoint[] = [{ x: 30, y: 20, z: 5 }, { x: 40, y: 30, z: 5 }, { x: 30, y: 40, z: 5 }]
  const sense = turnSense(arc[0], arc[1], arc[2])
  for (const orientation of [TOP, BOTTOM_X, BOTTOM_Y]) {
    const frame = setupFrame(orientation, STOCK)
    const [a, b, c] = arc.map((point) => canonicalToSetupPoint(point, frame))
    const flipped = Math.sign(turnSense(a, b, c)) !== Math.sign(sense)
    assert(flipped === setupFlipsArcDirection(orientation), `${orientation.angleDeg}° about ${orientation.axis}: the flag matches the geometry`)
  }
}

function testSharedOrigin(): void {
  console.log('Testing the shared origin: centreline stays put, off-centre mirrors...')
  const origin = (x: number, y: number): MachineOrigin => ({ name: 'Origin', x, y, z: 20, visible: true })
  const aboutX = setupFrame(BOTTOM_X, STOCK)
  const aboutY = setupFrame(BOTTOM_Y, STOCK)

  // Top: the origin is where it was placed.
  assertEqual(setupOriginInCanonical(origin(10, 85), setupFrame(TOP, STOCK)), { x: 10, y: 85, z: 20 }, 'Top origin')
  // On the X flip's centreline (y = 45) the planar position does not move;
  // the origin is now on the other stock face, which is the one facing up.
  assertEqual(setupOriginInCanonical(origin(10, 45), aboutX), { x: 10, y: 45, z: 0 }, 'centreline origin, flip about X')
  assertEqual(setupOriginInCanonical(origin(60, 85), aboutY), { x: 60, y: 85, z: 0 }, 'centreline origin, flip about Y')
  // Off the centreline it mirrors across the flip axis.
  assertEqual(setupOriginInCanonical(origin(10, 85), aboutX), { x: 10, y: 5, z: 0 }, 'off-centre origin, flip about X')
  assertEqual(setupOriginInCanonical(origin(10, 85), aboutY), { x: 110, y: 85, z: 0 }, 'off-centre origin, flip about Y')
}

function testOperationSetupLookup(): void {
  console.log('Testing an operation resolves to its setup frame...')
  const project = newProject('Lookup', 'mm')
  project.stock = STOCK
  const bottom: MachiningSetup = { ...defaultTopSetup(), id: 'setup-bottom', name: 'Bottom', orientation: BOTTOM_Y }
  project.setups = [defaultTopSetup(), bottom]

  assert(setupForOperation(project, { id: 'op1' }) === null, 'an operation without a setup reads as Top')
  assert(setupFrameForOperation(project, { id: 'op1' }) === undefined, 'no frame without a setup')
  assert(setupFrameForOperation(project, { id: 'op1', setupId: 'setup-top' }) === undefined, 'no frame for a Top setup')
  assert(setupForOperation(project, { id: 'op1', setupId: 'setup-bottom' }) === project.setups[1], 'the named setup is returned')
  assertEqual(
    setupFrameForOperation(project, { id: 'op1', setupId: 'setup-bottom' }),
    { orientation: BOTTOM_Y, pivot: { x: 60, y: 45, z: 10 } },
    'the Bottom frame',
  )
  // A setup that does not exist must not quietly export as Top.
  assertThrows(() => setupForOperation(project, { id: 'op1', setupId: 'gone' }), 'a dangling setup id')
  assertThrows(() => setupFrameForOperation(project, { id: 'op1', setupId: 'gone' }), 'a dangling setup id has no frame')
  // Nor may a setup turned to an angle this build cannot machine.
  project.setups = [{ ...bottom, orientation: { axis: 'x', angleDeg: 90 } }]
  assertThrows(() => setupFrameForOperation(project, { id: 'op1', setupId: 'setup-bottom' }), 'an unsupported setup angle')
}

function testFaceDepth(): void {
  console.log('Testing depth from each face...')
  const stock = { thickness: 20 }
  const cases: Array<[string, { z_top: number; z_bottom: number }, { start: number; end: number }, { start: number; end: number }]> = [
    // label, stock span, depth from top, depth from bottom
    ['pocket open at the top', { z_top: 20, z_bottom: 14 }, { start: 0, end: 6 }, { start: 14, end: 20 }],
    ['pocket open at the bottom', { z_top: 5, z_bottom: 0 }, { start: 15, end: 20 }, { start: 0, end: 5 }],
    ['floating inside the stock', { z_top: 12, z_bottom: 5 }, { start: 8, end: 15 }, { start: 5, end: 12 }],
    ['through', { z_top: 20, z_bottom: 0 }, { start: 0, end: 20 }, { start: 0, end: 20 }],
    ['standing proud of the top', { z_top: 26, z_bottom: 20 }, { start: -6, end: 0 }, { start: 20, end: 26 }],
  ]
  for (const [label, span, fromTop, fromBottom] of cases) {
    const before = { ...span }
    assertEqual(depthFromFace(span, 'top', stock), fromTop, `${label}: depth from top`)
    assertEqual(depthFromFace(span, 'bottom', stock), fromBottom, `${label}: depth from bottom`)
    // The view never rewrites the span it was given.
    assertEqual(span, before, `${label}: the stored span is untouched`)
    // And the span comes back intact — floating and partial depths included.
    assertEqual(spanFromFaceDepth(fromTop, 'top', stock), span, `${label}: back from top`)
    assertEqual(spanFromFaceDepth(fromBottom, 'bottom', stock), span, `${label}: back from bottom`)
  }

  console.log('Testing a reversed depth is refused, never swapped...')
  assertEqual(spanFromFaceDepth({ start: 8, end: 3 }, 'top', stock), null, 'a reversed depth is refused from top')
  assertEqual(spanFromFaceDepth({ start: 8, end: 3 }, 'bottom', stock), null, 'a reversed depth is refused from bottom')
  assertEqual(spanFromFaceDepth({ start: 0, end: Number.NaN }, 'bottom', stock), null, 'a non-finite depth is refused')
  assertEqual(spanFromFaceDepth({ start: 4, end: 4 }, 'bottom', stock), { z_top: 4, z_bottom: 4 }, 'a zero-height span is a span')

  // The face-local depth agrees with the setup transform: a depth below the
  // upward face is the same distance below local `thickness`.
  const frame = setupFrame(BOTTOM_X, STOCK)
  const floor = canonicalToSetupPoint({ x: 60, y: 45, z: 5 }, frame)
  assertEqual(STOCK.thickness - floor.z, depthFromFace({ z_top: 5, z_bottom: 0 }, 'bottom', STOCK).end, 'depth from bottom matches setup-local Z')
}

testPivot()
testIdentityAtZero()
testHalfTurns()
testStockMapsOntoItself()
testRoundTrip()
testOtherAnglesRejected()
testFace()
testArcDirection()
testSharedOrigin()
testOperationSetupLookup()
testFaceDepth()

console.log('setup orientation tests passed')
