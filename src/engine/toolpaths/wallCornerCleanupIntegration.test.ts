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

import { readFileSync } from 'node:fs'

import type { CutDirection, Point, Project } from '../../types/project'
import { normalizeProject } from '../../store/helpers/projectFormat'
import { applyContourDirection } from './geometry'
import { cutOffsetRegionRecursive, generatePocketToolpath } from './pocket'
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

/**
 * The wall ring rounds only when the operation asks for it. Rounding it costs
 * the coverage the wall needs, so it is paired with a cleanup loop and priced
 * in cycle time; that is a decision for the job, not a default. The interior
 * rings are governed by `roundOutsideCorners` alone and must not move with it.
 */
function testWallCleanupIsOptIn(): void {
  const project = normalizeProject(
    JSON.parse(readFileSync('src/engine/test-fixtures/pocket-feed-reduction.camj', 'utf8')) as Project,
  )
  const operation = project.operations.find((candidate) => candidate.kind === 'pocket')
  assert(operation !== undefined, 'the fixture must contain a pocket operation')
  assert(operation.roundOutsideCorners === true, 'the fixture rounds corners')

  const { cleanWallCorners: _absent, ...withoutField } = operation
  const off = generatePocketToolpath(project, withoutField)
  const explicitlyOff = generatePocketToolpath(project, { ...operation, cleanWallCorners: false })
  const on = generatePocketToolpath(project, { ...operation, cleanWallCorners: true })

  assert(JSON.stringify(off.moves) === JSON.stringify(explicitlyOff.moves),
    'a missing flag and an explicit false produce the same stream')

  // The wall ring's own corners: sharp when the cleanup is off, and reached by
  // a transition when it is on. Four corners of the tool-centre rectangle.
  const corners: Point[] = [
    { x: 0.625, y: 0.625 }, { x: 3.375, y: 0.625 },
    { x: 0.625, y: 2.375 }, { x: 3.375, y: 2.375 },
  ]
  const touches = (moves: ToolpathMove[], point: Point): boolean => moves.some((move) =>
    move.kind === 'cut' && Math.hypot(move.to.x - point.x, move.to.y - point.y) <= 1e-9)
  for (const corner of corners) {
    assert(touches(off.moves, corner),
      'with the cleanup off the wall ring drives into its sharp corner')
  }
  const offCuts = off.moves.filter((move) => move.kind === 'cut').length
  const onCuts = on.moves.filter((move) => move.kind === 'cut').length
  assert(onCuts > offCuts, `enabling the cleanup adds motion (${offCuts} -> ${onCuts})`)

  // The flag moves the wall ring and nothing else. The fixture's pocket is
  // 0.5..3.5 x 0.5..2.5, so its wall ring rides at one tool radius (0.125) and
  // the next ring in at 0.205; anything beyond halfway between them belongs to
  // the interior, and every one of those moves must be untouched.
  const toWall = (x: number, y: number): number => Math.min(
    Math.abs(x - 0.5), Math.abs(3.5 - x), Math.abs(y - 0.5), Math.abs(2.5 - y),
  )
  // Both endpoints, not the midpoint: the link that hands off from the wall
  // ring has one end on it and legitimately moves when the wall ring does.
  const interior = (moves: ToolpathMove[]): ToolpathMove[] => moves.filter((move) =>
    move.kind === 'cut'
    && toWall(move.from.x, move.from.y) > 0.165
    && toWall(move.to.x, move.to.y) > 0.165)
  // Subset, not equality: the wall cleanup loops swing a radius inward and so
  // land in the interior half of the split themselves. What must hold is that
  // every interior move the flag-off stream cuts is still cut with the flag on
  // — the flag adds wall motion and rewrites nothing.
  const key = (move: ToolpathMove): string =>
    `${move.from.x},${move.from.y}->${move.to.x},${move.to.y}`
  const interiorOff = interior(off.moves)
  const onKeys = new Set(on.moves.filter((move) => move.kind === 'cut').map(key))
  assert(interiorOff.length > 400,
    `the interior actually has motion to compare (${interiorOff.length})`)
  const missing = interiorOff.filter((move) => !onKeys.has(key(move)))
  // The one thing that legitimately moves with the wall ring is the link that
  // hands off to it: change what a link arrives at and its shape follows. Such
  // a move travels toward the wall. An interior *ring* move does not, so a flag
  // that reached the interior rings would show up here immediately.
  assert(missing.every((move) =>
    toWall(move.to.x, move.to.y) < toWall(move.from.x, move.from.y) - 1e-9),
  `the wall flag touches only links heading for the wall (${missing.length} of ${interiorOff.length} moves)`)
  assert(missing.length <= 4,
    `and only a handful of them (${missing.length})`)

  // And the interior answers to roundOutsideCorners on its own.
  const unrounded = generatePocketToolpath(project, { ...operation, roundOutsideCorners: false, cleanWallCorners: true })
  assert(interior(unrounded.moves).length < interiorOff.length / 4,
    'clearing roundOutsideCorners collapses the interior regardless of the wall flag')
}

testRootRingRoundsAndCleans('conventional')
testRootRingRoundsAndCleans('climb')
testDisabledIsByteIdentical()
testWallCleanupIsOptIn()
console.log('wallCornerCleanup integration tests: PASSED')
