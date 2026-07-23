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
 * Unit tests for linear-move optimization finalizer.
 * Run with: npx tsx src/engine/toolpaths/linearMoveOptimization.test.ts
 */

import { optimizeLinearMoves } from './linearMoveOptimization'
import type { ToolpathMove, ToolpathResult } from './types'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function pt(x: number, y: number, z: number) {
  return { x, y, z }
}

function move(
  kind: ToolpathMove['kind'],
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  z: number,
  overrides?: Partial<Pick<ToolpathMove, 'source' | 'feedScale'>>,
): ToolpathMove {
  return {
    kind,
    from: pt(fromX, fromY, z),
    to: pt(toX, toY, z),
    ...overrides,
  }
}

function result(overrides?: Partial<ToolpathResult>): ToolpathResult {
  return {
    operationId: 'op-1',
    moves: [],
    warnings: [],
    bounds: null,
    ...overrides,
  }
}

// ── Zero-length moves ────────────────────────────────────────────────

function testZeroLengthMovesRemoved() {
  console.log('Testing zero-length moves are removed...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 10, 0, -1),
        move('cut', 10, 0, 10, 0, -1), // zero-length
        move('cut', 10, 0, 10, 10, -1), // corner — non-collinear with first
      ],
      bounds: { minX: 0, minY: 0, minZ: -1, maxX: 10, maxY: 10, maxZ: -1 },
    }),
  )

  assert(r.moves.length === 2, 'zero-length move removed, corner keeps remaining moves separate')
  assert(r.moves[0].from.x === 0 && r.moves[0].to.x === 10, 'first move intact')
  assert(r.moves[1].from.x === 10 && r.moves[1].from.y === 0 && r.moves[1].to.y === 10, 'third move shifted to index 1')
  assert(r.bounds!.minX === 0 && r.bounds!.maxX === 10 && r.bounds!.maxY === 10, 'bounds recomputed')

  console.log('Zero-length moves removed: PASSED')
}

function testAllMovesZeroLength() {
  console.log('Testing all moves zero-length...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 5, 5, 5, 5, -1),
        move('cut', 5, 5, 5, 5, -1),
      ],
    }),
  )

  assert(r.moves.length === 0, 'all zero-length moves removed')
  assert(r.bounds === null, 'bounds null for empty moves')

  console.log('All moves zero-length: PASSED')
}

// ── Collinear merge ──────────────────────────────────────────────────

function testCollinearMergeSameFeedScale() {
  console.log('Testing collinear merge with same feedScale...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 10, 0, -1, { feedScale: 0.5, source: 'slot' }),
        move('cut', 10, 0, 20, 0, -1, { feedScale: 0.5, source: 'slot' }),
        move('cut', 20, 0, 30, 0, -1, { feedScale: 0.5, source: 'slot' }),
      ],
    }),
  )

  assert(r.moves.length === 1, 'three collinear moves merged into one')
  assert(r.moves[0].from.x === 0 && r.moves[0].to.x === 30, 'merged from first from to last to')
  assert(r.moves[0].kind === 'cut', 'kind preserved')
  assert(r.moves[0].feedScale === 0.5, 'feedScale preserved')
  assert(r.moves[0].source === 'slot', 'source preserved')
  assert(r.bounds!.minX === 0 && r.bounds!.maxX === 30, 'bounds cover merged segment')

  console.log('Collinear merge same feedScale: PASSED')
}

function testCollinearMergeUndefinedFeedScale() {
  console.log('Testing collinear merge with both undefined feedScale...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 5, 0, -2),
        move('cut', 5, 0, 15, 0, -2),
      ],
    }),
  )

  assert(r.moves.length === 1, 'merged when both feedScale undefined')
  assert(r.moves[0].feedScale === undefined, 'feedScale stays undefined')
  assert(r.moves[0].from.x === 0 && r.moves[0].to.x === 15, 'merged correctly')

  console.log('Collinear merge undefined feedScale: PASSED')
}

function testCollinearMergeDiagonal() {
  console.log('Testing collinear merge on diagonal moves...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 10, 10, -1),
        move('cut', 10, 10, 20, 20, -1),
      ],
    }),
  )

  assert(r.moves.length === 1, 'diagonal collinear moves merged')
  assert(r.moves[0].from.x === 0 && r.moves[0].from.y === 0, 'first from preserved')
  assert(r.moves[0].to.x === 20 && r.moves[0].to.y === 20, 'last to preserved')

  console.log('Collinear merge diagonal: PASSED')
}

// ── Boundaries ───────────────────────────────────────────────────────

function testFeedScaleMismatchPreventsMerge() {
  console.log('Testing feedScale mismatch prevents merge...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 10, 0, -1, { feedScale: 0.5 }),
        move('cut', 10, 0, 20, 0, -1, { feedScale: 1.0 }),
        move('cut', 20, 0, 30, 0, -1, { feedScale: 0.5 }),
      ],
    }),
  )

  assert(r.moves.length === 3, 'feedScale mismatch keeps moves separate')
  assert(r.moves[0].feedScale === 0.5, 'first feedScale intact')
  assert(r.moves[1].feedScale === 1.0, 'second feedScale intact')

  console.log('FeedScale mismatch prevents merge: PASSED')
}

function testFeedScaleDefinedVsUndefinedPreventsMerge() {
  console.log('Testing defined vs undefined feedScale boundary...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 10, 0, -1),
        move('cut', 10, 0, 20, 0, -1, { feedScale: 0.8 }),
      ],
    }),
  )

  assert(r.moves.length === 2, 'undefined→defined feedScale keeps moves separate')

  console.log('Defined vs undefined feedScale boundary: PASSED')
}

function testSourceBoundaryPreventsMerge() {
  console.log('Testing source boundary prevents merge...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 10, 0, -1, { source: 'ring' }),
        move('cut', 10, 0, 20, 0, -1, { source: 'slot' }),
      ],
    }),
  )

  assert(r.moves.length === 2, 'different sources not merged')
  assert(r.moves[0].source === 'ring', 'first source intact')
  assert(r.moves[1].source === 'slot', 'second source intact')

  console.log('Source boundary prevents merge: PASSED')
}

function testSourceDefinedVsUndefinedPreventsMerge() {
  console.log('Testing defined vs undefined source boundary...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 10, 0, -1),
        move('cut', 10, 0, 20, 0, -1, { source: 'tagged' }),
      ],
    }),
  )

  assert(r.moves.length === 2, 'undefined→defined source keeps moves separate')

  console.log('Defined vs undefined source boundary: PASSED')
}

function testKindBoundaryPreventsMerge() {
  console.log('Testing kind boundary prevents merge...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('rapid', 0, 0, 10, 0, 5),
        move('cut', 10, 0, 20, 0, -1),
      ],
    }),
  )

  assert(r.moves.length === 2, 'rapid→cut boundary not merged')
  assert(r.moves[0].kind === 'rapid', 'first kind intact')
  assert(r.moves[1].kind === 'cut', 'second kind intact')

  console.log('Kind boundary prevents merge: PASSED')
}

function testZChangePreventsMerge() {
  console.log('Testing Z change prevents merge...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 10, 0, -1),
        move('cut', 10, 0, 20, 0, -2),
      ],
    }),
  )

  assert(r.moves.length === 2, 'different Z not merged')

  console.log('Z change prevents merge: PASSED')
}

function testNonConstantZPreventsMerge() {
  console.log('Testing non-constant-Z (helical) move prevents merge...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        { kind: 'cut', from: pt(0, 0, -1), to: pt(10, 0, -2) },
        move('cut', 10, 0, 20, 0, -2),
      ],
    }),
  )

  assert(r.moves.length === 2, 'helical first move not merged')

  console.log('Non-constant-Z prevents merge: PASSED')
}

function testCornerPreventsMerge() {
  console.log('Testing 90° corner prevents merge...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 10, 0, -1),
        move('cut', 10, 0, 10, 10, -1),
      ],
    }),
  )

  assert(r.moves.length === 2, '90° corner not merged')

  console.log('Corner prevents merge: PASSED')
}

function testReversalPreventsMerge() {
  console.log('Testing direction reversal prevents merge...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 10, 0, -1),
        move('cut', 10, 0, 0, 0, -1), // same line, opposite direction
      ],
    }),
  )

  assert(r.moves.length === 2, 'reversal not merged')

  console.log('Reversal prevents merge: PASSED')
}

function testGapPreventsMerge() {
  console.log('Testing non-contiguous gap prevents merge...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 10, 0, -1),
        move('cut', 15, 0, 25, 0, -1), // gap from 10 to 15
      ],
    }),
  )

  assert(r.moves.length === 2, 'gap keeps moves separate')

  console.log('Gap prevents merge: PASSED')
}

// ── Bounds ───────────────────────────────────────────────────────────

function testBoundsRecomputedAfterMerge() {
  console.log('Testing bounds recomputed after merge...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, -5, 10, -5, -2),
        move('cut', 10, -5, 30, -5, -2),
        move('cut', 30, -5, 30, 15, -2),
      ],
      bounds: { minX: 0, minY: -5, minZ: -2, maxX: 10, maxY: -5, maxZ: -2 },
    }),
  )

  assert(r.moves.length === 2, 'first two merged, third is corner')
  assert(r.bounds!.minX === 0, 'minX from merged segment')
  assert(r.bounds!.maxX === 30, 'maxX covers corner')
  assert(r.bounds!.minY === -5, 'minY from merged segment')
  assert(r.bounds!.maxY === 15, 'maxY covers corner')

  console.log('Bounds recomputed after merge: PASSED')
}

function testBoundsNullForEmptyMoves() {
  console.log('Testing bounds null for all-zero moves...')

  const r = optimizeLinearMoves(
    result({
      moves: [move('cut', 1, 1, 1, 1, 0)],
    }),
  )

  assert(r.moves.length === 0, 'zero move removed')
  assert(r.bounds === null, 'bounds null')

  console.log('Bounds null for empty moves: PASSED')
}

// ── Non-mutation ─────────────────────────────────────────────────────

function testDoesNotMutateInput() {
  console.log('Testing input result is not mutated...')

  const moves: ToolpathMove[] = [
    move('cut', 0, 0, 10, 0, -1),
    move('cut', 10, 0, 20, 0, -1),
  ]
  const input = result({ moves, bounds: { minX: 0, minY: 0, minZ: -1, maxX: 20, maxY: 0, maxZ: -1 } })

  const output = optimizeLinearMoves(input)

  assert(input.moves.length === 2, 'input moves unchanged')
  assert(input.moves !== output.moves, 'moves array is a different reference')
  assert(input !== (output as unknown as typeof input), 'result object is different reference')
  assert(input.bounds !== output.bounds, 'bounds object is different reference')

  console.log('Non-mutation: PASSED')
}

function testEmptyMovesReturnsSameResult() {
  console.log('Testing empty moves returns same result reference...')

  const input = result({ moves: [] })
  const output = optimizeLinearMoves(input)

  assert(input === (output as unknown as typeof input), 'empty input returned as-is')

  console.log('Empty moves returns same result: PASSED')
}

function testNoOptimizationReturnsSameResult() {
  console.log('Testing no-optimization returns same result reference...')

  const input = result({
    moves: [
      move('cut', 0, 0, 10, 0, -1),
      move('cut', 10, 10, 20, 10, -1), // corner — not mergeable
    ],
  })
  const output = optimizeLinearMoves(input)

  assert(input === (output as unknown as typeof input), 'unoptimized result returned as-is')

  console.log('No-optimization returns same result: PASSED')
}

// ── Metadata preservation ────────────────────────────────────────────

function testDrillCyclesPreserved() {
  console.log('Testing drillCycles preserved through optimization...')

  const drillCycles = [
    { x: 5, y: 5, clearZ: 2, retractZ: 2, bottomZ: -3, drillType: 'simple' as const },
  ]
  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 10, 0, -1),
        move('cut', 10, 0, 10, 0, -1), // zero-length
        move('cut', 10, 0, 20, 0, -1),
      ],
      drillCycles,
    }),
  )

  assert(r.drillCycles === drillCycles, 'drillCycles reference preserved')
  assert(r.drillCycles!.length === 1, 'drillCycles content intact')

  console.log('DrillCycles preserved: PASSED')
}

function testWarningsPreserved() {
  console.log('Testing warnings preserved...')

  const warnings = [{ code: 'noToolAssigned' as const, params: {} }]
  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 10, 0, -1),
        move('cut', 10, 0, 20, 0, -1),
      ],
      warnings,
    }),
  )

  assert(r.warnings === warnings, 'warnings reference preserved')

  console.log('Warnings preserved: PASSED')
}

function testCollidingMetadataPreserved() {
  console.log('Testing collidingClampIds and collidingMoveIndices preserved...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 10, 0, -1),
        move('cut', 10, 0, 20, 0, -1),
      ],
      collidingClampIds: ['clamp-1'],
      collidingMoveIndices: [0, 1],
    }),
  )

  assert(r.collidingClampIds!.length === 1, 'collidingClampIds preserved')
  assert(r.collidingMoveIndices!.length === 2, 'collidingMoveIndices preserved')

  console.log('Colliding metadata preserved: PASSED')
}

function testDebugToolpathPreserved() {
  console.log('Testing debugToolpath flag preserved...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('cut', 0, 0, 10, 0, -1, { source: 'dbg' }),
        move('cut', 10, 0, 20, 0, -1, { source: 'dbg' }),
      ],
      debugToolpath: true,
    }),
  )

  assert(r.debugToolpath === true, 'debugToolpath preserved')
  assert(r.moves.length === 1, 'merged despite debug flag')

  console.log('DebugToolpath preserved: PASSED')
}

// ── Edge cases ───────────────────────────────────────────────────────

function testSingleMovePassesThrough() {
  console.log('Testing single move passes through...')

  const input = result({ moves: [move('cut', 0, 0, 10, 0, -1)] })
  const r = optimizeLinearMoves(input)

  assert(r.moves.length === 1, 'single move intact')
  assert(r.moves[0].from.x === 0 && r.moves[0].to.x === 10, 'move unchanged')

  console.log('Single move passes through: PASSED')
}

function testMixedKindsNotMerged() {
  console.log('Testing mixed rapid/plunge/cut chain...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('rapid', -5, 0, 0, 0, 5),
        { kind: 'plunge' as const, from: pt(0, 0, 5), to: pt(0, 0, -1) },
        move('cut', 0, 0, 10, 0, -1),
        move('cut', 10, 0, 20, 0, -1),
        move('cut', 20, 0, 30, 0, -1),
        move('rapid', 30, 0, 35, 0, 5),
      ],
    }),
  )

  assert(r.moves.length === 4, 'three collinear cuts merged, others kept')
  assert(r.moves[0].kind === 'rapid', 'rapid intact')
  assert(r.moves[1].kind === 'plunge', 'plunge intact')
  assert(r.moves[2].kind === 'cut', 'cut merged')
  assert(r.moves[2].from.x === 0 && r.moves[2].to.x === 30, 'cut merged range')
  assert(r.moves[3].kind === 'rapid', 'final rapid intact')

  console.log('Mixed kinds not merged: PASSED')
}

function testLeadInOutPreserved() {
  console.log('Testing lead_in/lead_out boundaries preserved...')

  const r = optimizeLinearMoves(
    result({
      moves: [
        move('rapid', 0, 0, 5, 0, 5),
        { kind: 'plunge' as const, from: pt(5, 0, 5), to: pt(5, 0, -1) },
        move('lead_in', 5, 0, 7, 0, -1),
        move('cut', 7, 0, 15, 0, -1),
        move('cut', 15, 0, 20, 0, -1),
        move('lead_out', 20, 0, 22, 0, -1),
        move('rapid', 22, 0, 25, 0, 5),
      ],
    }),
  )

  assert(r.moves.length === 6, 'each kind boundary preserved, two cuts merged')
  assert(r.moves[2].kind === 'lead_in', 'lead_in intact')
  assert(r.moves[3].kind === 'cut', 'cut intact (merged)')
  assert(r.moves[3].from.x === 7 && r.moves[3].to.x === 20, 'cut merged range')
  assert(r.moves[4].kind === 'lead_out', 'lead_out intact')

  console.log('Lead_in/out boundaries preserved: PASSED')
}

try {
  testZeroLengthMovesRemoved()
  testAllMovesZeroLength()
  testCollinearMergeSameFeedScale()
  testCollinearMergeUndefinedFeedScale()
  testCollinearMergeDiagonal()
  testFeedScaleMismatchPreventsMerge()
  testFeedScaleDefinedVsUndefinedPreventsMerge()
  testSourceBoundaryPreventsMerge()
  testSourceDefinedVsUndefinedPreventsMerge()
  testKindBoundaryPreventsMerge()
  testZChangePreventsMerge()
  testNonConstantZPreventsMerge()
  testCornerPreventsMerge()
  testReversalPreventsMerge()
  testGapPreventsMerge()
  testBoundsRecomputedAfterMerge()
  testBoundsNullForEmptyMoves()
  testDoesNotMutateInput()
  testEmptyMovesReturnsSameResult()
  testNoOptimizationReturnsSameResult()
  testDrillCyclesPreserved()
  testWarningsPreserved()
  testCollidingMetadataPreserved()
  testDebugToolpathPreserved()
  testSingleMovePassesThrough()
  testMixedKindsNotMerged()
  testLeadInOutPreserved()
  console.log('\nAll linearMoveOptimization tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
