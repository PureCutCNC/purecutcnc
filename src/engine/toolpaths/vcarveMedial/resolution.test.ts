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

import type { Point } from '../../../types/project'
import { convertLength } from '../../../utils/units'
import {
  MEDIAL_SAMPLE_BUDGET_PER_REGION,
  resolveMedialResolution,
} from './resolution'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) < epsilon
}

function rect(w: number, h: number): Point[] {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ]
}

function testResolutionScalesWithShortSpan(): void {
  const large = resolveMedialResolution({ outer: rect(20, 10), islands: [] })
  const small = resolveMedialResolution({ outer: rect(2, 1), islands: [] })
  assert(large !== null && small !== null, 'expected valid rectangle resolutions')
  assert(approx(large.resolution, 0.25), `expected 0.25 mm, got ${large.resolution}`)
  assert(approx(small.resolution, 0.025), `expected 0.025 mm, got ${small.resolution}`)
  assert(approx(large.resolution / small.resolution, 10), 'resolution should follow geometry scale')
}

function testLargeShapeKeepsScaleRelativeResolution(): void {
  const result = resolveMedialResolution({ outer: rect(100, 100), islands: [] })
  assert(result !== null, 'expected a valid large-shape resolution')
  assert(
    approx(result.resolution, 2.5),
    `expected 2.5 project-unit resolution, got ${result.resolution}`,
  )
  assert(!result.budgetLimited, 'ordinary large square should not hit the sample budget')
}

function testResolutionIsUnitEquivalent(): void {
  const mm = resolveMedialResolution({ outer: rect(25.4, 12.7), islands: [] })
  const inch = resolveMedialResolution({ outer: rect(1, 0.5), islands: [] })
  assert(mm !== null && inch !== null, 'expected valid unit-equivalent resolutions')
  const inchAsMm = convertLength(inch.resolution, 'inch', 'mm')
  assert(approx(mm.resolution, inchAsMm), `${mm.resolution} mm != ${inchAsMm} mm`)
}

function testDegenerateRegionIsRejected(): void {
  const result = resolveMedialResolution({
    outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
    islands: [],
  })
  assert(result === null, 'collinear region should not produce a resolution')
}

function testSampleBudgetOverridesShapeResolution(): void {
  const result = resolveMedialResolution({ outer: rect(100_000, 1), islands: [] })
  assert(result !== null, 'expected a valid long-region resolution')
  const expectedFloor = (200_000 + 2) / MEDIAL_SAMPLE_BUDGET_PER_REGION
  assert(approx(result.budgetFloor, expectedFloor), 'unexpected sample-budget floor')
  assert(approx(result.resolution, expectedFloor), 'budget floor should become the effective resolution')
  assert(result.budgetLimited, 'expected the long region to report budget limiting')
}

try {
  testResolutionScalesWithShortSpan()
  testLargeShapeKeepsScaleRelativeResolution()
  testResolutionIsUnitEquivalent()
  testDegenerateRegionIsRejected()
  testSampleBudgetOverridesShapeResolution()
  console.log('resolution.test.ts: all tests PASSED')
} catch (error) {
  console.error(error)
  throw error
}
