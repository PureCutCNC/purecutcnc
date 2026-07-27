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

import { greedyNearestNeighbor, xyDistanceSquared } from './geometry'

interface Candidate {
  id: string
  position: { x: number; y: number }
  exit?: { x: number; y: number }
  originalIndex: number
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function ids(items: Candidate[]): string {
  return items.map((item) => item.id).join(',')
}

function testXyDistanceSquared(): void {
  console.log('Testing squared XY distance...')
  assert(xyDistanceSquared({ x: -1, y: 2 }, { x: 2, y: 6 }) === 25, 'distance should ignore extra fields and square XY deltas')
  console.log('squared XY distance: PASSED')
}

function testKeepsFirstItemAndUsesSeparateExit(): void {
  console.log('Testing implicit seeding and separate exit point...')
  const candidates: Candidate[] = [
    { id: 'first', position: { x: 0, y: 0 }, exit: { x: 10, y: 0 }, originalIndex: 0 },
    { id: 'near-exit', position: { x: 9, y: 0 }, originalIndex: 1 },
    { id: 'near-start', position: { x: 1, y: 0 }, originalIndex: 2 },
  ]

  const ordered = greedyNearestNeighbor(candidates, {
    positionOf: (candidate) => candidate.position,
    exitOf: (candidate) => candidate.exit ?? candidate.position,
  })

  assert(ids(ordered) === 'first,near-exit,near-start', `unexpected order: ${ids(ordered)}`)
  console.log('implicit seeding and separate exit point: PASSED')
}

function testTieBehaviorAndCachedPositions(): void {
  console.log('Testing tie behavior and one-time position evaluation...')
  const candidates: Candidate[] = [
    { id: 'high', position: { x: -1, y: 0 }, originalIndex: 2 },
    { id: 'low', position: { x: 1, y: 0 }, originalIndex: 1 },
  ]
  const positionCalls = new Map<string, number>()

  const tieBroken = greedyNearestNeighbor(candidates, {
    positionOf: (candidate) => {
      positionCalls.set(candidate.id, (positionCalls.get(candidate.id) ?? 0) + 1)
      return candidate.position
    },
    start: { x: 0, y: 0 },
    tieBreakOf: (candidate) => candidate.originalIndex,
  })
  const firstEncountered = greedyNearestNeighbor(candidates, {
    positionOf: (candidate) => candidate.position,
    start: { x: 0, y: 0 },
  })

  assert(ids(tieBroken) === 'low,high', `tie-break should prefer lower original index: ${ids(tieBroken)}`)
  assert(ids(firstEncountered) === 'high,low', `without a tie-break the first candidate should win: ${ids(firstEncountered)}`)
  assert([...positionCalls.values()].every((calls) => calls === 1), 'each position should be evaluated exactly once')
  console.log('tie behavior and cached positions: PASSED')
}

function testDoesNotMutateStartPoint(): void {
  console.log('Testing explicit start point is not mutated...')
  const start = { x: 5, y: 5 }
  const candidates: Candidate[] = [
    { id: 'first', position: { x: 7, y: 5 }, originalIndex: 0 },
    { id: 'second', position: { x: 9, y: 5 }, originalIndex: 1 },
  ]

  const ordered = greedyNearestNeighbor(candidates, {
    positionOf: (candidate) => candidate.position,
    start,
  })

  assert(ids(ordered) === 'first,second', `unexpected order: ${ids(ordered)}`)
  assert(start.x === 5 && start.y === 5, 'caller-owned start point should be unchanged')
  console.log('explicit start point immutability: PASSED')
}

function testEmptyAndSingleInputs(): void {
  console.log('Testing empty and single-item inputs...')
  const empty: Candidate[] = []
  const single: Candidate[] = [{ id: 'only', position: { x: 0, y: 0 }, originalIndex: 0 }]

  assert(greedyNearestNeighbor(empty, { positionOf: (candidate) => candidate.position }) === empty, 'empty input should be returned unchanged')
  assert(greedyNearestNeighbor(single, { positionOf: (candidate) => candidate.position }) === single, 'single input should be returned unchanged')
  console.log('empty and single-item inputs: PASSED')
}

try {
  testXyDistanceSquared()
  testKeepsFirstItemAndUsesSeparateExit()
  testTieBehaviorAndCachedPositions()
  testDoesNotMutateStartPoint()
  testEmptyAndSingleInputs()
  console.log('\nAll geometry tests PASSED.')
} catch (error) {
  console.error(error)
  throw error
}
