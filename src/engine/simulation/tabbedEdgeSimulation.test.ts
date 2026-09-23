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

/** Issue #829: real rectangle → Edge Out → automatic tabs → replay. */
import { defaultTool, newProject } from '../../types/project'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { useProjectStore } from '../../store/projectStore'
import { computeOperationToolpath } from '../toolpaths/generateOperation'
import { createSimulationGrid } from './grid'
import { PlaybackController } from './playback'
import { simulateOperationHeightfield } from './replay'
import type { SimulationGrid } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function heightAt(grid: SimulationGrid, x: number, y: number): number {
  const col = Math.floor((x - grid.originX) / grid.cellSize)
  const row = Math.floor((y - grid.originY) / grid.cellSize)
  return grid.topZ[row * grid.cols + col]
}

useProjectStore.setState({ project: newProject('Tab simulation regression', 'mm') })
let store = useProjectStore.getState()
store.addRectFeature('Part', 10, 10, 50, 40, 5)
const feature = resolvedProjectFeatures(useProjectStore.getState().project)[0]
const tool = { ...defaultTool('mm', 1), id: 'tab-tool', diameter: 6 }
useProjectStore.setState({ project: { ...useProjectStore.getState().project, tools: [tool] } })
store = useProjectStore.getState()
const operationId = store.addOperation('edge_route_outside', 'rough', { source: 'features', featureIds: [feature.id] })
assert(operationId !== null, 'edge operation must be created')
useProjectStore.getState().autoPlaceTabsForOperation(operationId)
const project = useProjectStore.getState().project
const operation = project.operations.find((item) => item.id === operationId)
assert(operation !== undefined, 'edge operation must exist')
assert(project.tabs.length === 4, 'rectangle should receive four automatic tabs')
const toolpath = computeOperationToolpath(project, operation)?.result
assert(toolpath !== undefined, 'edge operation must produce a toolpath')

for (const detail of [180, 600]) {
  const finalGrid = simulateOperationHeightfield(project, operation, toolpath, { targetLongAxisCells: detail }).grid
  // Points on the cutter's outside route: each tab keeps 3 mm of stock,
  // while both adjacent spans are real through-cuts.
  for (const [x, y, flankA, flankB] of [
    [35, 7.5, [25, 7.5], [45, 7.5]],
    [35, 52.5, [25, 52.5], [45, 52.5]],
    [7.5, 30, [7.5, 20], [7.5, 40]],
    [62.5, 30, [62.5, 20], [62.5, 40]],
  ] as const) {
    assert(heightAt(finalGrid, x, y) >= 2.9, `detail ${detail}: tab at (${x},${y}) must retain stock`)
    assert(heightAt(finalGrid, flankA[0], flankA[1]) === 0, `detail ${detail}: first flank must be through-cut`)
    assert(heightAt(finalGrid, flankB[0], flankB[1]) === 0, `detail ${detail}: second flank must be through-cut`)
  }

  const playback = new PlaybackController(createSimulationGrid(project, { targetLongAxisCells: detail }), toolpath.moves, {
    toolType: 'flat_endmill', toolRadius: 3, vBitAngle: null,
  })
  playback.seekToFraction(0.5)
  assert(heightAt(playback.liveGrid, 35, 7.5) >= heightAt(finalGrid, 35, 7.5), 'mid-playback cannot remove more tab stock than final')
  playback.seekToFraction(1)
  assert(heightAt(playback.liveGrid, 35, 7.5) === heightAt(finalGrid, 35, 7.5), 'playback and final tab heights must agree')
  assert(heightAt(playback.liveGrid, 25, 7.5) === 0, 'playback must retain the real through-cut beside the tab')
}

console.log('tabbed edge simulation tests passed')
