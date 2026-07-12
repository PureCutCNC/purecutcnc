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
 * Unit tests for Line rendering helpers in csg.ts.
 *
 * Run with: npx tsx src/engine/lineRendering.test.ts
 */

import { closeLinePolygonIfNeeded } from './profilePolyline'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── closeLinePolygonIfNeeded ────────────────────────────────────────

function testClosedLinePolygonCloses() {
  const input: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]]
  const result = closeLinePolygonIfNeeded(input, true)

  assert(result.length === 5, 'closed line appends closing point')
  assert(result[0][0] === 0 && result[0][1] === 0, 'closed line starts at origin')
  assert(
    result[result.length - 1][0] === 0 && result[result.length - 1][1] === 0,
    'closed line ends at origin (same as first point)',
  )
  // The original input is not mutated.
  assert(input.length === 4, 'original polygon is not mutated')
}

function testOpenLinePolygonUnchanged() {
  const input: [number, number][] = [[0, 0], [10, 0], [10, 10]]
  const result = closeLinePolygonIfNeeded(input, false)

  assert(result.length === 3, 'open line keeps point count')
  assert(result === input, 'open line returns the same array reference')
  assert(
    result[result.length - 1][0] === 10 && result[result.length - 1][1] === 10,
    'open line ends at last input point',
  )
}

function testClosedFalseOnClosedShapeLeavesItOpen() {
  // When shouldClose is false, the polygon is left as-is even if the
  // shape itself is geometrically closed — this is the correct behavior
  // for open Line features and non-Line features.
  const input: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]]
  const result = closeLinePolygonIfNeeded(input, false)

  assert(result.length === 4, 'shouldClose=false keeps original count')
  assert(result === input, 'shouldClose=false returns same array reference')
  assert(
    result[result.length - 1][0] === 0 && result[result.length - 1][1] === 10,
    'shouldClose=false ends at last input point, not first',
  )
}

function testEmptyPolygon() {
  const result = closeLinePolygonIfNeeded([], true)
  assert(result.length === 0, 'empty polygon stays empty')
}

function testSinglePointPolygon() {
  // A single-point closed polygon appends the start point.
  const result = closeLinePolygonIfNeeded([[5, 5]], true)
  assert(result.length === 2, 'single-point closed appends closing')
  assert(result[0][0] === 5 && result[1][0] === 5, 'both points match')
}

// ── Entry point ─────────────────────────────────────────────────────

testClosedLinePolygonCloses()
testOpenLinePolygonUnchanged()
testClosedFalseOnClosedShapeLeavesItOpen()
testEmptyPolygon()
testSinglePointPolygon()

console.log('✅ lineRendering.test.ts — all assertions passed')
