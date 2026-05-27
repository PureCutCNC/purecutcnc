/**
 * Tests for the ApplyMoveResult / PlaybackController boundary-tracking contract
 * introduced to fix simulation playback walls disappearing when cells are cut
 * through to stockBottomZ (PR #103).
 *
 * Run with: npx tsx src/engine/simulation/playback.test.ts
 */

import { PlaybackController, type PlaybackToolInfo } from './playback'
import { applyMoveToGrid } from './replay'
import type { ToolpathMove } from '../toolpaths/types'
import type { SimulationGrid } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeFullGrid(): SimulationGrid {
  // 3x3 unit grid, stock from z=0 to z=10, all cells full.
  // Cell centers are at (0.5, 0.5), (1.5, 0.5), (2.5, 0.5), (0.5, 1.5), ...
  return {
    originX: 0,
    originY: 0,
    cellSize: 1,
    cols: 3,
    rows: 3,
    stockBottomZ: 0,
    stockTopZ: 10,
    topZ: new Float32Array(9).fill(10),
  }
}

function stationaryCut(x: number, y: number, z: number): ToolpathMove {
  return { kind: 'cut', from: { x, y, z }, to: { x, y, z } }
}

function testPartialCutDoesNotReportCellCleared(): void {
  const grid = makeFullGrid()
  // Flat endmill at center of cell (1,1), tip at z=5 — cuts material away from
  // topZ=10 down to z=5, but the cell still has material above stockBottomZ.
  const result = applyMoveToGrid(grid, stationaryCut(1.5, 1.5, 5), 0.4, 'flat_endmill', null)

  assert(result.changedCount === 1, `expected one cell to change, got ${result.changedCount}`)
  assert(grid.topZ[1 * 3 + 1] === 5, `expected center cell topZ=5, got ${grid.topZ[1 * 3 + 1]}`)
  assert(
    result.anyCellCleared === false,
    'partial cut that leaves material above stockBottomZ must not set anyCellCleared',
  )
}

function testFullCutToStockBottomReportsCellCleared(): void {
  const grid = makeFullGrid()
  // Flat endmill at center of cell (1,1), tip at z=-0.5 — clamped at stockBottomZ=0,
  // so the cell transitions from material to empty.
  const result = applyMoveToGrid(grid, stationaryCut(1.5, 1.5, -0.5), 0.4, 'flat_endmill', null)

  assert(result.changedCount === 1, `expected one cell to change, got ${result.changedCount}`)
  assert(grid.topZ[1 * 3 + 1] === 0, `expected center cell topZ to clamp to stockBottomZ, got ${grid.topZ[1 * 3 + 1]}`)
  assert(
    result.anyCellCleared === true,
    'cell transition from material to stockBottomZ must set anyCellCleared',
  )
}

function testRepeatedFullCutDoesNotRereportCleared(): void {
  const grid = makeFullGrid()
  applyMoveToGrid(grid, stationaryCut(1.5, 1.5, -0.5), 0.4, 'flat_endmill', null)
  // Second cut on the already-empty cell should not change anything and must
  // not falsely report another clear transition.
  const result = applyMoveToGrid(grid, stationaryCut(1.5, 1.5, -0.5), 0.4, 'flat_endmill', null)
  assert(result.changedCount === 0, `expected no changes on second cut, got ${result.changedCount}`)
  assert(
    result.anyCellCleared === false,
    'repeated cut on already-empty cell must not report anyCellCleared again',
  )
}

const flatTool: PlaybackToolInfo = { toolType: 'flat_endmill', toolRadius: 0.4, vBitAngle: null }

function testPlaybackControllerBoundaryChangedOnCutThrough(): void {
  const baseGrid = makeFullGrid()
  const controller = new PlaybackController(baseGrid, [stationaryCut(1.5, 1.5, -0.5)], flatTool, {
    maxSegmentLength: 0,
  })

  assert(
    controller.getBoundaryChanged() === false,
    'PlaybackController must start with boundaryChanged=false',
  )

  controller.advance(1)

  assert(
    controller.getBoundaryChanged() === true,
    'PlaybackController must set boundaryChanged when a cut-through occurs',
  )

  controller.clearBoundaryChanged()
  assert(
    controller.getBoundaryChanged() === false,
    'clearBoundaryChanged() must reset the flag',
  )
}

function testPlaybackControllerBoundaryUnchangedForPartialCut(): void {
  const baseGrid = makeFullGrid()
  const controller = new PlaybackController(baseGrid, [stationaryCut(1.5, 1.5, 5)], flatTool, {
    maxSegmentLength: 0,
  })

  controller.advance(1)

  assert(
    controller.getBoundaryChanged() === false,
    'partial cut that leaves material must not set boundaryChanged on the controller',
  )
}

function testPlaybackControllerResetForcesBoundaryRebuild(): void {
  const baseGrid = makeFullGrid()
  const controller = new PlaybackController(baseGrid, [stationaryCut(1.5, 1.5, 5)], flatTool, {
    maxSegmentLength: 0,
  })
  controller.advance(1)
  controller.clearBoundaryChanged()

  controller.reset()
  assert(
    controller.getBoundaryChanged() === true,
    'reset() must force a boundary rebuild so walls match the base grid state',
  )
}

testPartialCutDoesNotReportCellCleared()
testFullCutToStockBottomReportsCellCleared()
testRepeatedFullCutDoesNotRereportCleared()
testPlaybackControllerBoundaryChangedOnCutThrough()
testPlaybackControllerBoundaryUnchangedForPartialCut()
testPlaybackControllerResetForcesBoundaryRebuild()
console.log('playback boundary-tracking tests passed')
