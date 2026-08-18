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

import type { CutDirection, Point } from '../../types/project'
import { applyContourDirection } from './geometry'
import { cutOffsetRegionRecursive } from './pocket'
import type { ResolvedPocketRegion, ToolpathMove } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function planarCuts(moves: ToolpathMove[], z: number): ToolpathMove[] {
  return moves.filter((move) =>
    move.kind === 'cut'
    && Math.abs(move.from.z - z) <= 1e-9
    && Math.abs(move.to.z - z) <= 1e-9
    && Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) > 1e-9)
}

function pointSegmentDistance(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= 1e-18) return Math.hypot(point.x - from.x, point.y - from.y)
  const t = Math.max(0, Math.min(1,
    ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t))
}

function cutDistance(point: Point, cuts: ToolpathMove[]): number {
  return Math.min(...cuts.map((move) => pointSegmentDistance(point, move.from, move.to)))
}

function denseContourSamples(contour: Point[], spacing: number): Point[] {
  const samples: Point[] = []
  for (let index = 0; index < contour.length; index += 1) {
    const from = contour[index]
    const to = contour[(index + 1) % contour.length]
    const count = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / spacing))
    for (let sample = 0; sample < count; sample += 1) {
      const t = sample / count
      samples.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    }
  }
  return samples
}

function emitRoot(
  region: ResolvedPocketRegion,
  direction: CutDirection,
  smoothRadius: number | undefined,
  cleanup: boolean,
): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  cutOffsetRegionRecursive(
    moves,
    region,
    -1,
    5,
    100,
    10,
    null,
    direction,
    undefined,
    'outer-first',
    smoothRadius,
    undefined,
    undefined,
    undefined,
    cleanup ? { enabled: true } : undefined,
  )
  return moves
}

function testRootRingRoundsAndCleans(direction: CutDirection): void {
  const outer: Point[] = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
  ]
  const region: ResolvedPocketRegion = {
    outer, islands: [], targetFeatureIds: [], islandFeatureIds: [],
  }
  const legacyCuts = planarCuts(emitRoot(region, direction, 8, false), -1)
  const cleanupCuts = planarCuts(emitRoot(region, direction, 8, true), -1)
  assert(legacyCuts.length === 4, `${direction}: legacy root remains the four sharp sides`)
  assert(cleanupCuts.length > legacyCuts.length, `${direction}: rounded root adds transition and cleanup motion`)
  const directedSource = applyContourDirection([outer], direction)[0]
  for (const sample of denseContourSamples(directedSource, 0.2)) {
    assert(cutDistance(sample, cleanupCuts) <= 1e-7,
      `${direction}: cleanup retains the exact legacy wall-centre coverage`)
  }
}

function testDisabledIsByteIdentical(): void {
  const region: ResolvedPocketRegion = {
    outer: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
    islands: [],
    targetFeatureIds: [],
    islandFeatureIds: [],
  }
  const absent = emitRoot(region, 'conventional', undefined, false)
  const explicitlyNoCleanup = emitRoot(region, 'conventional', undefined, true)
  assert(JSON.stringify(absent) === JSON.stringify(explicitlyNoCleanup),
    'no smoothing radius keeps the legacy stream byte-identical')
}

testRootRingRoundsAndCleans('conventional')
testRootRingRoundsAndCleans('climb')
testDisabledIsByteIdentical()
console.log('wallCornerCleanup integration tests: PASSED')
