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
 * Tests for playback move preparation.
 *
 * Run with: npx tsx src/engine/simulation/playback.test.ts
 */

import { PlaybackController, subdivideMoves } from './playback'
import type { PlaybackToolInfo } from './playback'
import type { SimulationGrid } from './types'
import type { ToolpathMove } from '../toolpaths/types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) < epsilon
}

function flatGrid(): SimulationGrid {
  const cols = 40
  const rows = 4
  return {
    cols,
    rows,
    cellSize: 1,
    originX: 0,
    originY: 0,
    stockTopZ: 0,
    stockBottomZ: -10,
    topZ: new Float32Array(cols * rows).fill(0),
  }
}

const FLAT_TOOL: PlaybackToolInfo = { toolType: 'flat_endmill', toolRadius: 1, vBitAngle: null }

function testSubdividePreservesMoveMetadata(): void {
  console.log('Testing subdivideMoves preserves feedScale and source on sub-segments...')
  const moves: ToolpathMove[] = [
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, feedScale: 0.1, source: 'slot' },
  ]
  const out = subdivideMoves(moves, 2)

  assert(out.length === 5, `expected 5 sub-segments, got ${out.length}`)
  assert(out.every((move) => move.feedScale === 0.1), 'every sub-segment should carry the source move feedScale')
  assert(out.every((move) => move.source === 'slot'), 'every sub-segment should carry the source move source tag')
  assert(out.every((move) => move.kind === 'cut'), 'every sub-segment should keep the move kind')
  // Sub-segments tile the original move contiguously from start to end.
  assert(approx(out[0].from.x, 0) && approx(out[out.length - 1].to.x, 10), 'sub-segments should span the original move')
  for (let i = 1; i < out.length; i += 1) {
    assert(approx(out[i].from.x, out[i - 1].to.x), 'sub-segments should be contiguous')
  }
  console.log('subdivideMoves preserves move metadata: PASSED')
}

function testSubdivideLeavesShortMovesUntouched(): void {
  console.log('Testing subdivideMoves leaves short moves (and their metadata) untouched...')
  const move: ToolpathMove = { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, feedScale: 0.5 }
  const out = subdivideMoves([move], 2)
  assert(out.length === 1, 'a move shorter than the max segment length should not be split')
  assert(out[0].feedScale === 0.5, 'short move should retain feedScale')
  console.log('subdivideMoves short-move passthrough: PASSED')
}

function testReducedFeedMoveAdvancesSlower(): void {
  console.log('Testing feed-scaled advance covers less geometry on reduced-feed cuts...')
  // Two equal-length cuts: the first at full feed, the second at 10% feed.
  // The subdivision cap is disabled so each cut stays a single move.
  const moves: ToolpathMove[] = [
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 } },
    { kind: 'cut', from: { x: 10, y: 0, z: 0 }, to: { x: 20, y: 0, z: 0 }, feedScale: 0.1 },
  ]
  const controller = new PlaybackController(flatGrid(), moves, FLAT_TOOL, {
    maxSegmentLength: 0,
    referenceFeedPerSecond: 5,
  })

  // Budget of 10 finishes the full-feed cut exactly (ratio 1 → 10 geometry).
  controller.advance(10)
  assert(approx(controller.getDistanceTraveled(), 10), `full-feed cut should consume budget 1:1, got ${controller.getDistanceTraveled()}`)
  assert(controller.getMoveIndex() === 1, 'should now be on the reduced-feed cut')

  // A further budget of 10 only covers 10 × 0.1 = 1 unit of the reduced cut.
  controller.advance(10)
  assert(approx(controller.getDistanceTraveled(), 11), `reduced cut should cover 0.1× the budget, got total ${controller.getDistanceTraveled()}`)
  assert(!controller.isFinished(), 'reduced cut should not be finished after only 1 of 10 units')
  console.log('reduced-feed advance is slower: PASSED')
}

function testDisabledReferenceFeedIsConstantSpeed(): void {
  console.log('Testing advance is constant-speed geometric when no reference feed is set...')
  const moves: ToolpathMove[] = [
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 20, y: 0, z: 0 }, feedScale: 0.1 },
  ]
  const controller = new PlaybackController(flatGrid(), moves, FLAT_TOOL, { maxSegmentLength: 0 })
  // No referenceFeedPerSecond → feedScale ignored for motion, budget == geometry.
  controller.advance(5)
  assert(approx(controller.getDistanceTraveled(), 5), `legacy advance should be 1:1 geometric, got ${controller.getDistanceTraveled()}`)
  console.log('disabled reference feed is constant-speed: PASSED')
}

function testSeekIsGeometricDespiteFeedScaling(): void {
  console.log('Testing seek lands on the geometric target even with reduced-feed moves...')
  const moves: ToolpathMove[] = [
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 } },
    { kind: 'cut', from: { x: 10, y: 0, z: 0 }, to: { x: 20, y: 0, z: 0 }, feedScale: 0.1 },
  ]
  const controller = new PlaybackController(flatGrid(), moves, FLAT_TOOL, {
    maxSegmentLength: 0,
    referenceFeedPerSecond: 5,
  })
  assert(approx(controller.totalPathLength, 20), `path length should be 20, got ${controller.totalPathLength}`)
  // Seeking to 75% must land at geometric distance 15, not be slowed by the
  // reduced-feed second half.
  controller.seekToFraction(0.75)
  assert(approx(controller.getDistanceTraveled(), 15), `seek to 0.75 should land at geometric 15, got ${controller.getDistanceTraveled()}`)
  console.log('seek stays geometric: PASSED')
}

function gridsEqual(a: SimulationGrid, b: SimulationGrid): boolean {
  if (a.topZ.length !== b.topZ.length) return false
  for (let i = 0; i < a.topZ.length; i += 1) {
    if (!approx(a.topZ[i], b.topZ[i], 1e-6)) return false
  }
  return true
}

function slotMoves(): ToolpathMove[] {
  return [
    { kind: 'plunge', from: { x: 5, y: 2, z: 0 }, to: { x: 5, y: 2, z: -2 } },
    { kind: 'cut', from: { x: 5, y: 2, z: -2 }, to: { x: 35, y: 2, z: -2 } },
  ]
}

function testForwardSeekMatchesFreshReplay(): void {
  console.log('Testing forward seek from a mid-path state matches a fresh replay...')
  const incremental = new PlaybackController(flatGrid(), slotMoves(), FLAT_TOOL)
  incremental.seekToDistance(8)
  incremental.seekToDistance(20)
  incremental.seekToDistance(27.5)

  const fresh = new PlaybackController(flatGrid(), slotMoves(), FLAT_TOOL)
  fresh.seekToDistance(27.5)

  assert(approx(incremental.getDistanceTraveled(), 27.5), `incremental seeks should land at 27.5, got ${incremental.getDistanceTraveled()}`)
  assert(gridsEqual(incremental.liveGrid, fresh.liveGrid), 'chained forward seeks must produce the same grid as one fresh seek')
  console.log('forward seek matches fresh replay: PASSED')
}

function testBackwardSeekRestoresEarlierState(): void {
  console.log('Testing backward seek restores the same grid as seeking there directly...')
  const controller = new PlaybackController(flatGrid(), slotMoves(), FLAT_TOOL)
  controller.seekToDistance(30)
  controller.seekToDistance(10)

  const reference = new PlaybackController(flatGrid(), slotMoves(), FLAT_TOOL)
  reference.seekToDistance(10)

  assert(approx(controller.getDistanceTraveled(), 10), `backward seek should land at 10, got ${controller.getDistanceTraveled()}`)
  assert(gridsEqual(controller.liveGrid, reference.liveGrid), 'backward seek must restore un-cut material')
  console.log('backward seek restores earlier state: PASSED')
}

function testDirtyRegionAccumulatesUntilCleared(): void {
  console.log('Testing the dirty region accumulates across steps and resets dirty the full grid...')
  const controller = new PlaybackController(flatGrid(), slotMoves(), FLAT_TOOL)

  controller.advance(5)
  const first = controller.getDirtyRegion()
  assert(first !== null, 'cutting should produce a dirty region')

  controller.advance(10)
  const accumulated = controller.getDirtyRegion()
  assert(accumulated !== null, 'dirty region should persist until cleared')
  assert(
    accumulated!.colMax >= first!.colMax,
    'dirty region should accumulate (grow) across advances when not cleared',
  )

  controller.clearDirtyRegion()
  assert(controller.getDirtyRegion() === null, 'clearDirtyRegion should empty the region')

  // A backward seek resets to the base grid — cells rise, so the whole grid is dirty.
  controller.seekToDistance(2)
  const afterReset = controller.getDirtyRegion()
  const grid = controller.liveGrid
  assert(afterReset !== null, 'reset should mark a dirty region')
  assert(
    afterReset!.colMin === 0 && afterReset!.rowMin === 0
    && afterReset!.colMax === grid.cols - 1 && afterReset!.rowMax === grid.rows - 1,
    'reset must dirty the entire grid (restored cells rise, which cut tracking never reports)',
  )
  console.log('dirty region accumulation and reset: PASSED')
}

try {
  testSubdividePreservesMoveMetadata()
  testSubdivideLeavesShortMovesUntouched()
  testReducedFeedMoveAdvancesSlower()
  testDisabledReferenceFeedIsConstantSpeed()
  testSeekIsGeometricDespiteFeedScaling()
  testForwardSeekMatchesFreshReplay()
  testBackwardSeekRestoresEarlierState()
  testDirtyRegionAccumulatesUntilCleared()
  console.log('\nAll playback tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
