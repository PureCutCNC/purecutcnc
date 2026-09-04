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

import { arcBaseline, bendShapesToBaseline, pathBaseline, type BendableShape, type TextTemplateBounds } from './baseline'
import { getProfileBounds, type Point, type SketchProfile } from '../types/project'

const epsilon = 1e-6

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function close(actual: number, expected: number, message: string, tolerance = epsilon) {
  assert(Math.abs(actual - expected) < tolerance, `${message}: expected ${expected}, got ${actual}`)
}

/** A unit-square "glyph" whose feet sit on y = 1, matching the skeleton font data. */
function boxGlyph(index: number, x: number, width = 1): BendableShape & { glyphIndex: number } {
  const profile: SketchProfile = {
    start: { x, y: 0 },
    segments: [
      { type: 'line', to: { x: x + width, y: 0 } },
      { type: 'line', to: { x: x + width, y: 1 } },
      { type: 'line', to: { x, y: 1 } },
      { type: 'line', to: { x, y: 0 } },
    ],
    closed: true,
  }
  return { profile, glyphIndex: index }
}

/** Three unit glyphs side by side: a run 3 wide, 1 tall, feet on y = 1. */
function threeGlyphRun(): Array<BendableShape & { glyphIndex: number }> {
  return [boxGlyph(1, 0), boxGlyph(2, 1), boxGlyph(3, 2)]
}

const runBounds: TextTemplateBounds = { minX: 0, maxX: 3, minY: 0, maxY: 1, width: 3, height: 1 }

function centerOf(shape: BendableShape): Point {
  const bounds = getProfileBounds(shape.profile)
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
}

function diagonalOf(shape: BendableShape): number {
  const bounds = getProfileBounds(shape.profile)
  return Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
}

function lineProfile(points: Point[]): SketchProfile {
  return {
    start: points[0]!,
    segments: points.slice(1).map((to) => ({ type: 'line' as const, to })),
    closed: false,
  }
}

function testPositiveAnglesRunClockwiseOnScreen() {
  // Sketch space is Y-down and the exact-rotate field already treats positive
  // degrees as clockwise, so 90 must land at 6 o'clock, not 12.
  const baseline = arcBaseline(10, 90, 90, 'cw')
  assert(baseline, 'arc baseline should build')
  const anchorPoint = baseline.at(0).point
  close(anchorPoint.x, 0, 'anchor x at 90 degrees')
  close(anchorPoint.y, 10, 'anchor y at 90 degrees is below centre (6 oclock)')

  const top = arcBaseline(10, 270, 90, 'cw')
  assert(top, 'top baseline should build')
  close(top.at(0).point.y, -10, '270 degrees is 12 oclock')
  console.log('clockwise-positive angle convention: PASSED')
}

function testClockwiseStandsTextOutsideAndUprightAtTheTop() {
  // The classic top-of-badge case: text over the top of a circle, reading
  // normally, letters standing away from the centre.
  const baseline = arcBaseline(100, 270, 60, 'cw')
  assert(baseline, 'baseline should build')
  const bent = bendShapesToBaseline(threeGlyphRun(), runBounds, baseline, 'center', 'natural', 'follow')

  const middle = bent.shapes[1]!
  const centre = centerOf(middle)
  close(centre.x, 0, 'middle glyph sits at the top of the circle', 1e-3)
  assert(centre.y < 0, 'middle glyph is above the centre')

  // Glyph feet were at y = 1 (the on-curve line), the body above it. Upright
  // means the body is further from the centre than the feet.
  const bounds = getProfileBounds(middle.profile)
  close(bounds.maxY, -100, 'feet land on the circle', 1e-3)
  assert(bounds.minY < bounds.maxY, 'body extends away from the centre, so the text is upright')

  // Reading order runs left to right across the top.
  assert(centerOf(bent.shapes[0]!).x < centre.x, 'first glyph is left of the middle');
  assert(centerOf(bent.shapes[2]!).x > centre.x, 'last glyph is right of the middle')
  console.log('cw stands text outside the arc, upright at the top: PASSED')
}

function testCounterClockwiseHangsTextBelowTheArcUprightAtTheBottom() {
  // The bottom-of-badge case: `ccw` writes under the bottom of the circle, and
  // the letters hang *below* the curve rather than sitting inside the ring —
  // symmetric with `cw` sitting on top of it. That is what attaching the run's
  // top edge buys, and it is why `attach` is derived from direction.
  const baseline = arcBaseline(100, 90, 60, 'ccw')
  assert(baseline, 'baseline should build')
  const bent = bendShapesToBaseline(threeGlyphRun(), runBounds, baseline, 'center', 'natural', 'follow', 'top')

  const middle = bent.shapes[1]!
  const bounds = getProfileBounds(middle.profile)
  close(bounds.minY, 100, 'the run\'s top edge lands on the circle at 6 oclock', 1e-3)
  assert(bounds.maxY > 100, 'and the body hangs below it, outside the circle')
  assert(centerOf(bent.shapes[0]!).x < centerOf(bent.shapes[2]!).x, 'still reads left to right')
  console.log('ccw hangs text below the arc, upright at the bottom: PASSED')
}

/**
 * The pair is symmetric about the circle: `cw` sits on top of it, `ccw` hangs
 * below it, and neither ends up inside the ring.
 */
function testDirectionsSitOnOppositeSidesOfTheSameCircle() {
  const top = arcBaseline(100, 270, 60, 'cw')
  const bottom = arcBaseline(100, 90, 60, 'ccw')
  assert(top && bottom, 'both baselines should build')
  const above = bendShapesToBaseline(threeGlyphRun(), runBounds, top, 'center', 'natural', 'follow', 'bottom')
  const below = bendShapesToBaseline(threeGlyphRun(), runBounds, bottom, 'center', 'natural', 'follow', 'top')

  // Distance from the centre, which is the origin in template space.
  const aboveBounds = getProfileBounds(above.shapes[1]!.profile)
  const belowBounds = getProfileBounds(below.shapes[1]!.profile)
  assert(Math.abs(aboveBounds.minY) > 100, 'cw body sits outside the circle at the top')
  assert(belowBounds.maxY > 100, 'ccw body sits outside the circle at the bottom')
  console.log('cw and ccw sit on opposite sides of the same circle: PASSED')
}

function testTheSameInputInvertsWhenTheDirectionFlips() {
  const clockwise = arcBaseline(100, 270, 60, 'cw')
  const counter = arcBaseline(100, 270, 60, 'ccw')
  assert(clockwise && counter, 'both baselines should build')
  const a = bendShapesToBaseline(threeGlyphRun(), runBounds, clockwise, 'center', 'natural', 'follow')
  const b = bendShapesToBaseline(threeGlyphRun(), runBounds, counter, 'center', 'natural', 'follow')

  const feetA = getProfileBounds(a.shapes[1]!.profile).maxY
  const feetB = getProfileBounds(b.shapes[1]!.profile).minY
  close(feetA, -100, 'cw feet on the circle at the top')
  close(feetB, -100, 'ccw feet on the circle at the top too')
  // Inverted: the cw body climbs away from the centre, the ccw body drops toward it.
  // This is the raw operator's contract and it is why flipping the *control* has
  // to move the run to the other half of the circle rather than only reversing
  // travel — see `testFlippingDirectionMovesTheRunToTheBottom` in
  // `src/store/textLayout.test.ts`. Reversing travel alone leaves the run at 12
  // o'clock reading backwards, i.e. upside down.
  assert(getProfileBounds(a.shapes[1]!.profile).minY < -100, 'cw body is outside the circle')
  assert(getProfileBounds(b.shapes[1]!.profile).maxY > -100, 'ccw body is inside the circle')
  console.log('direction flips which side of the arc glyphs stand on: PASSED')
}

function testAnchorPlacesTheRunRelativeToTheAngle() {
  const baseline = arcBaseline(100, 270, 60, 'cw')
  assert(baseline, 'baseline should build')
  const at = (anchor: 'start' | 'center' | 'end') =>
    bendShapesToBaseline(threeGlyphRun(), runBounds, baseline, anchor, 'natural', 'follow').shapes

  const start = at('start')
  const center = at('center')
  const end = at('end')

  // Anchor 'start' runs forward from 12 oclock, 'end' arrives at it, 'center'
  // straddles it. Clockwise from the top means increasing x.
  assert(centerOf(start[0]!).x > -1, 'start anchor begins at the angle')
  assert(centerOf(end[2]!).x < 1, 'end anchor finishes at the angle')
  close(centerOf(center[1]!).x, 0, 'center anchor straddles the angle', 1e-3)
  assert(centerOf(start[1]!).x > centerOf(center[1]!).x, 'start anchor sits after the centre anchor')
  assert(centerOf(end[1]!).x < centerOf(center[1]!).x, 'end anchor sits before the centre anchor')
  console.log('anchor positions the run against the angle: PASSED')
}

function testNaturalFitKeepsGlyphSizeAndFillScalesItUniformly() {
  const wide = arcBaseline(100, 270, 120, 'cw')
  assert(wide, 'baseline should build')

  const natural = bendShapesToBaseline(threeGlyphRun(), runBounds, wide, 'center', 'natural', 'follow')
  close(natural.scale, 1, 'natural fit never rescales')
  close(natural.runLength, 3, 'natural run keeps its own width')
  close(diagonalOf(natural.shapes[1]!), Math.SQRT2, 'natural glyph keeps its size', 1e-3)

  const fill = bendShapesToBaseline(threeGlyphRun(), runBounds, wide, 'center', 'fill', 'follow')
  close(fill.runLength, wide.span, 'fill run spans exactly the requested sweep')
  close(fill.scale, wide.span / 3, 'fill scale is span over natural width')
  // Uniform: the glyph grew by the same factor in both axes, so its aspect ratio held.
  close(diagonalOf(fill.shapes[1]!) / diagonalOf(natural.shapes[1]!), fill.scale, 'glyph scaled uniformly', 1e-3)
  console.log('natural keeps size, fill scales uniformly: PASSED')
}

function testFillNeverDistortsLetterformsAtAnySpan() {
  // The anti-distortion guarantee, the one that matters for a CNC app: a glyph
  // must keep its aspect ratio whether it is crammed or stretched.
  for (const sweep of [10, 45, 180, 359]) {
    const baseline = arcBaseline(50, 270, sweep, 'cw')
    assert(baseline, `baseline for sweep ${sweep}`)
    const bent = bendShapesToBaseline(threeGlyphRun(), runBounds, baseline, 'center', 'fill', 'follow')
    const bounds = getProfileBounds(bent.shapes[1]!.profile)
    const ratio = (bounds.maxX - bounds.minX) / (bounds.maxY - bounds.minY)
    // A square glyph rotated onto the arc stays square; the bbox of a rotated
    // square is still square, so the ratio holds at 1.
    close(ratio, 1, `glyph aspect ratio at sweep ${sweep}`, 1e-2)
  }
  console.log('fill never distorts letterforms: PASSED')
}

function testOverflowIsReportedRatherThanCrammed() {
  const tight = arcBaseline(1, 270, 10, 'cw')
  assert(tight, 'baseline should build')
  const natural = bendShapesToBaseline(threeGlyphRun(), runBounds, tight, 'center', 'natural', 'follow')
  assert(natural.overflows, 'a natural run longer than the span reports overflow')
  close(natural.scale, 1, 'overflow does not silently rescale')

  const filled = bendShapesToBaseline(threeGlyphRun(), runBounds, tight, 'center', 'fill', 'follow')
  assert(!filled.overflows, 'fill resolves the overflow')
  console.log('overflow is reported, not crammed: PASSED')
}

function testFixedOrientationMovesGlyphsWithoutRotatingThem() {
  // A tight radius, so the 3-unit run really does wrap (~57 degrees) and the
  // outer glyphs are rotated enough to tell the two modes apart. On a large
  // circle a short run is nearly straight and this would measure nothing.
  const baseline = arcBaseline(3, 270, 120, 'cw')
  assert(baseline, 'baseline should build')
  const fixed = bendShapesToBaseline(threeGlyphRun(), runBounds, baseline, 'center', 'natural', 'fixed')
  const follow = bendShapesToBaseline(threeGlyphRun(), runBounds, baseline, 'center', 'natural', 'follow')

  // A fixed square stays axis-aligned, so its bbox is exactly 1 x 1.
  const fixedBounds = getProfileBounds(fixed.shapes[0]!.profile)
  close(fixedBounds.maxX - fixedBounds.minX, 1, 'fixed glyph keeps its axis-aligned width')
  close(fixedBounds.maxY - fixedBounds.minY, 1, 'fixed glyph keeps its axis-aligned height')

  // The follow variant rotates the outer glyphs, widening their bbox.
  const followBounds = getProfileBounds(follow.shapes[0]!.profile)
  assert(followBounds.maxX - followBounds.minX > 1.05, 'follow glyph is rotated off axis')

  // Positions still track the curve in both cases.
  assert(centerOf(fixed.shapes[0]!).x < centerOf(fixed.shapes[2]!).x, 'fixed glyphs still spread along the arc')
  console.log('fixed orientation places without rotating: PASSED')
}

function testPathBaselineFollowsAStraightGuideAndItsTangent() {
  const guide = lineProfile([{ x: 0, y: 0 }, { x: 100, y: 0 }])
  const baseline = pathBaseline(guide, 0, 100, 'start', false)
  assert(baseline, 'path baseline should build')
  close(baseline.span, 100, 'span is the picked range')
  close(baseline.at(0).point.x, 0, 'anchor at the range start')
  close(baseline.at(40).point.x, 40, 'arc length maps to distance along the line')
  close(baseline.at(0).tangent.x, 1, 'tangent points along travel')
  console.log('path baseline follows the guide: PASSED')
}

function testPathAnchorCentresTheRunInsideThePickedSpan() {
  const guide = lineProfile([{ x: 0, y: 0 }, { x: 100, y: 0 }])
  const baseline = pathBaseline(guide, 20, 80, 'center', false)
  assert(baseline, 'path baseline should build')
  close(baseline.span, 60, 'span is the offset window')
  close(baseline.at(0).point.x, 50, 'centre anchor sits at the midpoint of the window')

  const bent = bendShapesToBaseline(threeGlyphRun(), runBounds, baseline, 'center', 'natural', 'follow')
  close(centerOf(bent.shapes[1]!).x, 50, 'a natural run centres inside the window', 1e-3)
  console.log('path centre anchor sits inside the picked span: PASSED')
}

function testReversedWalksTheGuideBackwardsAndFlipsTheTangent() {
  const guide = lineProfile([{ x: 0, y: 0 }, { x: 100, y: 0 }])
  const forward = pathBaseline(guide, 0, 100, 'start', false)
  const backward = pathBaseline(guide, 0, 100, 'start', true)
  assert(forward && backward, 'both baselines should build')

  close(backward.at(0).point.x, 100, 'reversed starts at the far end')
  close(backward.at(40).point.x, 60, 'reversed walks back along the guide')
  close(backward.at(0).tangent.x, -1, 'reversed tangent points the other way')

  // Flipping travel flips which side of the curve the glyphs stand on.
  const up = bendShapesToBaseline(threeGlyphRun(), runBounds, forward, 'start', 'natural', 'follow')
  const down = bendShapesToBaseline(threeGlyphRun(), runBounds, backward, 'start', 'natural', 'follow')
  assert(getProfileBounds(up.shapes[0]!.profile).minY < 0, 'forward glyphs stand above the guide')
  assert(getProfileBounds(down.shapes[0]!.profile).maxY > 0, 'reversed glyphs stand below the guide')
  console.log('reversed flips travel and the standing side: PASSED')
}

function testDegenerateLayoutsReturnNullRatherThanNaNGeometry() {
  assert(arcBaseline(0, 0, 90, 'cw') === null, 'zero radius has no baseline')
  assert(arcBaseline(-5, 0, 90, 'cw') === null, 'negative radius has no baseline')
  assert(arcBaseline(Number.NaN, 0, 90, 'cw') === null, 'NaN radius has no baseline')
  assert(arcBaseline(10, Number.NaN, 90, 'cw') === null, 'NaN angle has no baseline')

  const empty: SketchProfile = { start: { x: 0, y: 0 }, segments: [], closed: false }
  assert(pathBaseline(empty, 0, 0, 'start', false) === null, 'an empty guide has no baseline')

  const guide = lineProfile([{ x: 0, y: 0 }, { x: 10, y: 0 }])
  assert(pathBaseline(guide, 8, 2, 'start', false) === null, 'crossed offsets on an open guide are rejected')
  assert(pathBaseline(guide, 0, 50, 'start', false) === null, 'an offset past the end is rejected')
  console.log('degenerate layouts return null: PASSED')
}

function testAnEmptyRunIsLeftAlone() {
  const baseline = arcBaseline(10, 0, 90, 'cw')
  assert(baseline, 'baseline should build')
  const bent = bendShapesToBaseline([], runBounds, baseline, 'center', 'fill', 'follow')
  assert(bent.shapes.length === 0, 'no shapes in, no shapes out')
  close(bent.scale, 1, 'an empty run reports no scaling')
  assert(!bent.overflows, 'an empty run cannot overflow')
  console.log('empty run is left alone: PASSED')
}

testPositiveAnglesRunClockwiseOnScreen()
testClockwiseStandsTextOutsideAndUprightAtTheTop()
testCounterClockwiseHangsTextBelowTheArcUprightAtTheBottom()
testDirectionsSitOnOppositeSidesOfTheSameCircle()
testTheSameInputInvertsWhenTheDirectionFlips()
testAnchorPlacesTheRunRelativeToTheAngle()
testNaturalFitKeepsGlyphSizeAndFillScalesItUniformly()
testFillNeverDistortsLetterformsAtAnySpan()
testOverflowIsReportedRatherThanCrammed()
testFixedOrientationMovesGlyphsWithoutRotatingThem()
testPathBaselineFollowsAStraightGuideAndItsTangent()
testPathAnchorCentresTheRunInsideThePickedSpan()
testReversedWalksTheGuideBackwardsAndFlipsTheTangent()
testDegenerateLayoutsReturnNullRatherThanNaNGeometry()
testAnEmptyRunIsLeftAlone()
