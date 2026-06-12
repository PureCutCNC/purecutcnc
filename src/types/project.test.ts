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
 * Unit tests for segmentEndPoint — the discriminated-union narrow that replaced
 * the `(seg as any).to` casts at the segment boundary.
 *
 * Run with: npx tsx src/types/project.test.ts
 */

import type { ArcSegment, CircleSegment, LineSegment, Point } from './project'
import { segmentEndPoint } from './project'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const start: Point = { x: 1, y: 2 }

function testLineReturnsTo() {
  const seg: LineSegment = { type: 'line', to: { x: 5, y: 7 } }
  const end = segmentEndPoint(seg, start)
  assert(end.x === 5 && end.y === 7, 'line segment ends at its `to`')
  console.log('line returns to: PASSED')
}

function testArcReturnsTo() {
  const seg: ArcSegment = { type: 'arc', to: { x: 8, y: 9 }, center: { x: 0, y: 0 }, clockwise: true }
  const end = segmentEndPoint(seg, start)
  assert(end.x === 8 && end.y === 9, 'arc segment ends at its `to`')
  console.log('arc returns to: PASSED')
}

function testCircleReturnsProfileStart() {
  // A circle carries a `to`, but its traversal endpoint is the profile start.
  const seg: CircleSegment = { type: 'circle', to: { x: 99, y: 99 }, center: { x: 0, y: 0 }, clockwise: false }
  const end = segmentEndPoint(seg, start)
  assert(end === start, 'circle returns the profileStart, not its `to`')
  assert(end.x === 1 && end.y === 2, 'circle endpoint equals profileStart coords')
  console.log('circle returns profileStart: PASSED')
}

try {
  testLineReturnsTo()
  testArcReturnsTo()
  testCircleReturnsProfileStart()
  console.log('\nAll segmentEndPoint tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
