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

import {
  buildGeodesicDistanceField,
  extractConstantDistanceContours,
  type ConstantDistanceField,
  type ConstantScallopGrid,
} from './constantScallopField'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function grid(width: number, height: number, zAt: (col: number, row: number) => number): ConstantScallopGrid {
  const cutterLocationZ = new Float64Array(width * height)
  const valid = new Uint8Array(width * height)
  valid.fill(1)
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) cutterLocationZ[row * width + col] = zAt(col, row)
  }
  return { width, height, originX: 0, originY: 0, cellSize: 1, cutterLocationZ, valid }
}

function testFlatDistanceUsesNearestBoundary(): void {
  const field = buildGeodesicDistanceField(grid(7, 7, () => 4))
  assert(field, 'flat field should resolve')
  assert(Math.abs(field.distance[3 * 7 + 3] - 3) < 1e-9, `centre distance should be 3, got ${field.distance[24]}`)
}

function testInclinedDistanceUsesTrue3DEdgeLength(): void {
  const field = buildGeodesicDistanceField(grid(7, 101, (col) => col))
  assert(field, 'inclined field should resolve')
  const centre = 50 * 7 + 3
  const expected = 3 * Math.sqrt(2)
  assert(Math.abs(field.distance[centre] - expected) < 1e-9,
    `inclined distance should be ${expected}, got ${field.distance[centre]}`)
}

function testHoleAndDisconnectedComponentsSeedIndependently(): void {
  const input = grid(9, 7, () => 0)
  for (let row = 0; row < input.height; row += 1) input.valid[row * input.width + 4] = 0
  input.valid[3 * input.width + 1] = 0
  const field = buildGeodesicDistanceField(input)
  assert(field, 'disconnected field should resolve')
  assert(field.distance[3 * input.width + 2] === 0, 'cell beside a hole must be a seed')
  assert(Number.isFinite(field.distance[3 * input.width + 6]), 'second component must receive distances')
}

function testLevelSetsJoinIntoStableClosedContours(): void {
  const field = buildGeodesicDistanceField(grid(9, 9, () => 0))
  assert(field, 'contour field should resolve')
  const first = extractConstantDistanceContours(field, 2)
  const second = extractConstantDistanceContours(field, 2)
  assert(first.length > 0, 'distance field should emit an inset contour')
  assert(first.some((contour) => contour.closed), 'square inset should join into a closed contour')
  assert(JSON.stringify(first) === JSON.stringify(second), 'contour extraction must be deterministic')
}

function testAmbiguousCellProducesTwoDeterministicSegments(): void {
  const field: ConstantDistanceField = {
    width: 2,
    height: 2,
    originX: 0,
    originY: 0,
    cellSize: 1,
    cutterLocationZ: new Float64Array(4),
    valid: new Uint8Array([1, 1, 1, 1]),
    distance: new Float64Array([2, 0, 2, 0]),
  }
  const contours = extractConstantDistanceContours(field, 1)
  assert(contours.length === 2, `ambiguous cell should emit two fragments, got ${contours.length}`)
  assert(contours.every((contour) => !contour.closed && contour.points.length === 2),
    'ambiguous fragments should remain two-point open contours')
}

function run(): void {
  testFlatDistanceUsesNearestBoundary()
  testInclinedDistanceUsesTrue3DEdgeLength()
  testHoleAndDisconnectedComponentsSeedIndependently()
  testLevelSetsJoinIntoStableClosedContours()
  testAmbiguousCellProducesTwoDeterministicSegments()
  console.log('constantScallopField tests passed')
}

run()
