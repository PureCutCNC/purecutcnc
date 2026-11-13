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

import assert from 'node:assert/strict'
import { newProject, rectProfile } from '../../types/project'
import { foldToolpath } from '../aroundFold'
import type { AroundFrame } from '../aroundFrame'
import type { ToolpathMove, ToolpathResult } from '../toolpaths/types'
import { createSimulationGrid } from './grid'
import { PlaybackController, cloneSimulationGrid } from './playback'
import { applyMoveToGrid, simulateReplayItemsHeightfield } from './replay'

/** One circumference of the sheet, and the bar radius it implies. */
const CIRCUMFERENCE = 40
const BAR_RADIUS = CIRCUMFERENCE / (2 * Math.PI)
/** The radius as the heightfield stores it (Float32). */
const SURFACE = Math.fround(BAR_RADIUS)

for (const axis of ['x', 'y'] as const) {
  // A physically consistent unrolled bar: the sheet is one circumference across
  // and the material's surface is the frame radius. F8 resolves the cutter's
  // true solid, so a surface at any other radius is not a round bar at all.
  const frame: AroundFrame = {
    axis, centre: 15, radius: BAR_RADIUS, zero: 15, sheetStart: -5, circumference: CIRCUMFERENCE,
  }
  const across = axis === 'x' ? 'y' : 'x'
  const point = (along: number, offset: number): { x: number; y: number; z: number } => axis === 'x'
    ? { x: along, y: -5 + offset, z: 3 }
    : { x: -5 + offset, y: along, z: 3 }
  const project = newProject()
  project.stock = { ...project.stock, thickness: BAR_RADIUS, profile: axis === 'x' ? rectProfile(0, -5, 60, 40) : rectProfile(-5, 0, 40, 60) }
  const wrap = { axis: across, period: 40 } as const
  const base = createSimulationGrid(project, { targetLongAxisCells: 120, wrap })
  assert.deepEqual(base.wrap, wrap)
  assert.deepEqual(cloneSimulationGrid(base).wrap, wrap)
  const source: ToolpathMove = { kind: 'cut', from: point(10, 0), to: point(50, 100) }
  const original: ToolpathResult = { operationId: 'around', moves: [source], bounds: null, warnings: [] }
  const folded = foldToolpath(original, frame)
  const expectedPieces: ToolpathMove[] = [
    { kind: 'cut', from: point(10, 0), to: point(26, 40) },
    { kind: 'cut', from: point(26, 0), to: point(42, 40) },
    { kind: 'cut', from: point(42, 0), to: point(50, 20) },
  ]
  const expected = cloneSimulationGrid(base)
  for (const move of expectedPieces) applyMoveToGrid(expected, move, 1.5, 'flat_endmill', null)
  const staticResult = simulateReplayItemsHeightfield(project, [{
    operationId: 'around', operationName: 'around', toolRef: null, toolType: 'flat_endmill', toolRadius: 1.5, vBitAngle: null, toolpath: folded,
  }], { targetLongAxisCells: 120, wrap })
  assert.deepEqual(staticResult.grid.topZ, expected.topZ, '2.5-turn folded replay matches three independently written pieces')
  const playback = new PlaybackController(base, folded.moves, { toolType: 'flat_endmill', toolRadius: 1.5, vBitAngle: null }, { maxSegmentLength: 0 })
  playback.advance(playback.totalPathLength + 1)
  assert(playback.isFinished())
  assert.deepEqual(playback.liveGrid.topZ, expected.topZ, 'finished playback equals static replay')
  playback.seekToFraction(0.3)
  playback.seekToFraction(1)
  assert.deepEqual(playback.liveGrid.topZ, expected.topZ, 'backward and forward scrubbing retain periodic cuts')

  for (const offset of [0.75, 39.25]) {
    const grid = cloneSimulationGrid(base)
    const flat = cloneSimulationGrid(base)
    delete flat.wrap
    const move: ToolpathMove = { kind: 'cut', from: point(20, offset), to: point(30, offset) }
    const changed = applyMoveToGrid(grid, move, 1.5, 'flat_endmill', null)
    applyMoveToGrid(flat, move, 1.5, 'flat_endmill', null)
    const index = (along: number, acrossIndex: number): number => axis === 'x' ? acrossIndex * grid.cols + along : along * grid.cols + acrossIndex
    const last = (axis === 'x' ? grid.rows : grid.cols) - 1
    // F8 lowers a cell to the cutter's true surface, so the flat bottom reads
    // `tip / cos(angle)` rather than exactly the tip; the seam contract is that
    // both ends are still cut, not that the old exact value survives.
    assert(grid.topZ[index(50, 0)] < BAR_RADIUS - 1e-6, `${axis}: low seam is cut (${grid.topZ[index(50, 0)]})`)
    assert(grid.topZ[index(50, last)] < BAR_RADIUS - 1e-6, `${axis}: high seam is cut by the shifted cutter (${grid.topZ[index(50, last)]})`)
    assert.equal(flat.topZ[index(50, offset < 20 ? last : 0)], SURFACE, 'unwrapped cutter reaches only one end')
    const actualChanges = Array.from(grid.topZ).filter((height) => height < SURFACE).length
    assert.equal(changed.changedCount, actualChanges, 'both disjoint copies contribute changedCount')
    assert(changed.dirtyRegion)
    for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) {
      if (grid.topZ[row * grid.cols + col] === SURFACE) continue
      assert(col >= changed.dirtyRegion.colMin && col <= changed.dirtyRegion.colMax && row >= changed.dirtyRegion.rowMin && row <= changed.dirtyRegion.rowMax, 'dirty region unites both ends')
    }
  }
}

// The existing replay.test.ts reference fixture runs unmodified for flat grids,
// including ramps, plunges and bottom clipping for every cutter type.
await import('./replay.test')
console.log('Around replay tests passed')
