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
 * A plasma operation is a real through-cut (issue #961, slice F).
 *
 * The toolpath is a real `generatePlasmaProfileToolpath` result built the way
 * `../toolpaths/plasma.test.ts` builds its project and torch, replayed on a grid
 * whose cell is a quarter of the kerf wide — the width the kernel resolves.
 *
 * Mutations this suite is meant to kill:
 * - restoring the plasma early return in `replayItemIntoGrid` → the
 *   `simulateOperationHeightfield` test removes no cells;
 * - using the move's own Z instead of `grid.stockBottomZ` for a torch → the
 *   within-kerf cells never reach the stock bottom;
 * - doubling the plasma radius → cells a kerf-and-a-half from the path are cut.
 *
 * Run with: npx tsx src/engine/simulation/replayPlasma.test.ts
 */

import assert from 'node:assert/strict'
import type { Operation, Project, SketchFeature, SketchProfile } from '../../types/project'
import { getStockBounds, newProject } from '../../types/project'
import { defaultPlasmaTool } from '../../toolPolicy'
import { projectWithFeatures } from '../../test/projectFixtures'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { generatePlasmaProfileToolpath } from '../toolpaths/plasma'
import type { ToolpathMove, ToolpathResult } from '../toolpaths/types'
import { applyMoveToGrid, moveIsMaterialRemoving, simulateOperationHeightfield, simulateReplayItemsHeightfield } from './replay'
import type { SimulationGrid, SimulationReplayItem } from './types'

/** The fixture torch's diameter is 2 mm, so the kerf is 2 mm and the radius 1 mm. */
const KERF_WIDTH = 2
const TOOL_RADIUS = KERF_WIDTH / 2
/** Cell size the tests assert against: a quarter of the kerf. */
const CELL_SIZE = KERF_WIDTH / 4

function square(x: number, y: number, w: number, h = w): SketchProfile {
  return {
    start: { x, y },
    segments: [
      { type: 'line', to: { x: x + w, y } },
      { type: 'line', to: { x: x + w, y: y + h } },
      { type: 'line', to: { x, y: y + h } },
      { type: 'line', to: { x, y } },
    ],
    closed: true,
  }
}

function feature(id: string, operation: SketchFeature['operation'], profile = square(20, 20, 60)): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    operation,
    folderId: null,
    visible: true,
    locked: false,
    z_top: 6,
    z_bottom: 0,
    sketch: { profile, dimensions: [], constraints: [], origin: { x: 0, y: 0 }, orientationAngle: 0 },
  }
}

/** The plasma.test.ts fixture: a 100×80 sheet, a 2 mm torch and one part square. */
function fixture(features: SketchFeature[] = [feature('part', 'add')]): Project {
  const project = newProject('Plasma replay fixture', 'mm')
  project.stock.thickness = 6
  project.tools = [{ ...defaultPlasmaTool('mm'), id: 'torch', name: 'Torch', diameter: KERF_WIDTH, cutHeight: 1.5, defaultFeed: 2200 }]
  return projectWithFeatures(project, features)
}

function op(project: Project, ids = ['part'], patch: Partial<Operation> = {}): Operation {
  return { ...defaultOperationForTarget(project, 'plasma_profile', 'rough', { source: 'features', featureIds: ids }, 0), ...patch }
}

function generate(project: Project, operation = op(project)): ToolpathResult {
  return generatePlasmaProfileToolpath(project, operation)
}

/**
 * A grid at a quarter of the kerf over the stock and every move's own extent
 * (a lead-in can start off the sheet), with a two-kerf margin.
 */
function makeGrid(moves: readonly ToolpathMove[]): SimulationGrid {
  let minX = 0
  let maxX = 100
  let minY = 0
  let maxY = 80
  for (const move of moves) {
    minX = Math.min(minX, move.from.x, move.to.x)
    maxX = Math.max(maxX, move.from.x, move.to.x)
    minY = Math.min(minY, move.from.y, move.to.y)
    maxY = Math.max(maxY, move.from.y, move.to.y)
  }
  const margin = KERF_WIDTH
  const originX = Math.floor((minX - margin) / CELL_SIZE) * CELL_SIZE
  const originY = Math.floor((minY - margin) / CELL_SIZE) * CELL_SIZE
  const cols = Math.ceil((maxX + margin - originX) / CELL_SIZE)
  const rows = Math.ceil((maxY + margin - originY) / CELL_SIZE)
  return {
    cols,
    rows,
    cellSize: CELL_SIZE,
    originX,
    originY,
    stockTopZ: 6,
    stockBottomZ: 0,
    topZ: new Float32Array(cols * rows).fill(6),
  }
}

function cutMoves(toolpath: ToolpathResult): ToolpathMove[] {
  return toolpath.moves.filter((move) => moveIsMaterialRemoving(move))
}

/** Distance from (x, y) to the nearest point of a material-removing move. */
function distanceToPath(x: number, y: number, moves: readonly ToolpathMove[]): number {
  let best = Number.POSITIVE_INFINITY
  for (const move of moves) {
    const dx = move.to.x - move.from.x
    const dy = move.to.y - move.from.y
    const lengthSq = dx * dx + dy * dy
    const t = lengthSq <= 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - move.from.x) * dx + (y - move.from.y) * dy) / lengthSq))
    const distance = Math.hypot(x - (move.from.x + dx * t), y - (move.from.y + dy * t))
    if (distance < best) best = distance
  }
  return best
}

function cellCenter(grid: SimulationGrid, col: number, row: number): { x: number; y: number } {
  return {
    x: grid.originX + (col + 0.5) * grid.cellSize,
    y: grid.originY + (row + 0.5) * grid.cellSize,
  }
}

function cellIndexAt(grid: SimulationGrid, x: number, y: number): number {
  const col = Math.max(0, Math.min(grid.cols - 1, Math.floor((x - grid.originX) / grid.cellSize)))
  const row = Math.max(0, Math.min(grid.rows - 1, Math.floor((y - grid.originY) / grid.cellSize)))
  return row * grid.cols + col
}

function testKernelCutsOneKerfThrough(toolpath: ToolpathResult): void {
  console.log('Testing a plasma move cuts one kerf through the full sheet...')
  const moves = cutMoves(toolpath)
  assert.ok(moves.length > 0, 'the plasma path has torch-on moves')
  const grid = makeGrid(moves)

  for (const move of moves) {
    applyMoveToGrid(grid, move, TOOL_RADIUS, 'plasma', null)
  }

  let insideKerf = 0
  let outsideKerf = 0
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const { x, y } = cellCenter(grid, col, row)
      const distance = distanceToPath(x, y, moves)
      const topZ = grid.topZ[row * grid.cols + col]
      if (distance <= TOOL_RADIUS - CELL_SIZE) {
        assert.equal(topZ, grid.stockBottomZ, `cell (${col}, ${row}) at ${distance} from the path must be cut through`)
        insideKerf += 1
      } else if (distance >= TOOL_RADIUS + CELL_SIZE) {
        assert.equal(topZ, grid.stockTopZ, `cell (${col}, ${row}) at ${distance} from the path must be untouched`)
        outsideKerf += 1
      }
    }
  }

  // Not vacuous: the kerf band and the untouched sheet both exist.
  assert.ok(insideKerf > 100, `expected a meaningful kerf band, got ${insideKerf} cells`)
  assert.ok(outsideKerf > 100, `expected untouched sheet cells, got ${outsideKerf}`)
  console.log(`kernel cuts one kerf through: PASSED (${insideKerf} cut, ${outsideKerf} untouched)`)
}

function testPierceIsCutThrough(toolpath: ToolpathResult): void {
  console.log('Testing the pierce point is cut through...')
  const moves = cutMoves(toolpath)
  const grid = makeGrid(moves)
  for (const move of moves) {
    applyMoveToGrid(grid, move, TOOL_RADIUS, 'plasma', null)
  }

  const pierce = toolpath.moves.find((move) => move.kind === 'plunge')
  assert.ok(pierce, 'the plasma path has a pierce (plunge) move')
  const index = cellIndexAt(grid, pierce.to.x, pierce.to.y)
  assert.equal(grid.topZ[index], grid.stockBottomZ, 'the cell holding the pierce is cut through')
  console.log('pierce is cut through: PASSED')
}

function testMoveZDoesNotMatter(toolpath: ToolpathResult): void {
  console.log('Testing the move Z does not change a plasma cut...')
  const project = fixture()
  const targetLongAxisCells = targetCellsFor(project)
  const raised: ToolpathResult = {
    ...toolpath,
    moves: toolpath.moves.map((move) => ({
      ...move,
      from: { ...move.from, z: move.from.z + 10 },
      to: { ...move.to, z: move.to.z + 10 },
    })),
  }

  const base = simulateReplayItemsHeightfield(project, [plasmaItem(toolpath)], { targetLongAxisCells })
  const lifted = simulateReplayItemsHeightfield(project, [plasmaItem(raised)], { targetLongAxisCells })

  assert.ok(base.stats.removedCellCount > 0, 'the un-raised plasma path removes cells')
  assert.deepEqual(base.grid.topZ, lifted.grid.topZ, 'the cut is identical whatever Z the torch path carries')
  console.log('move Z does not change a plasma cut: PASSED')
}

function testRapidsCutNothing(): void {
  console.log('Testing a rapids-only plasma path cuts nothing...')
  const project = fixture()
  const rapidOnly: ToolpathResult = {
    operationId: 'op-rapids',
    moves: [
      { kind: 'rapid', from: { x: 10, y: 10, z: 8 }, to: { x: 70, y: 60, z: 8 } },
      { kind: 'rapid', from: { x: 70, y: 60, z: 8 }, to: { x: 20, y: 20, z: 8 } },
    ],
    warnings: [],
    bounds: null,
  }

  const result = simulateReplayItemsHeightfield(project, [plasmaItem(rapidOnly)], { targetLongAxisCells: targetCellsFor(project) })
  assert.equal(result.stats.removedCellCount, 0, 'rapids remove no material')
  assert.equal(result.stats.processedMoveCount, 0, 'rapids are not replayed as cuts')
  console.log('rapids-only path cuts nothing: PASSED')
}

/**
 * The part side of the drawn part line stays uncut, within one cell. For an
 * outside contour the part is inside the square; for a hole it is outside.
 */
function testPartSideStaysUncutOutside(): void {
  console.log('Testing the part side of an outside contour stays uncut...')
  const project = fixture()
  const moves = cutMoves(generate(project))
  const grid = makeGrid(moves)
  for (const move of moves) {
    applyMoveToGrid(grid, move, TOOL_RADIUS, 'plasma', null)
  }

  // The part square is drawn 20..80 in both axes; a cell more than one cell
  // inside every wall is part material the kerf edge must not reach.
  let checked = 0
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const { x, y } = cellCenter(grid, col, row)
      const partClearance = Math.min(x - 20, 80 - x, y - 20, 80 - y)
      if (partClearance > CELL_SIZE) {
        assert.equal(grid.topZ[row * grid.cols + col], grid.stockTopZ, `part cell (${col}, ${row}) must stay uncut`)
        checked += 1
      }
    }
  }
  assert.ok(checked > 1000, `expected a meaningful part area, got ${checked} cells`)
  console.log(`outside contour part side uncut: PASSED (${checked} cells)`)
}

function testPartSideStaysUncutHole(): void {
  console.log('Testing the part side of a hole stays uncut...')
  const project = fixture([feature('part', 'add'), feature('hole', 'subtract', square(35, 35, 30))])
  const holeOperation = op(project, ['hole'])
  const moves = cutMoves(generate(project, holeOperation))
  const grid = makeGrid(moves)
  for (const move of moves) {
    applyMoveToGrid(grid, move, TOOL_RADIUS, 'plasma', null)
  }

  // The hole is drawn 35..65; the part is outside it, so a cell more than one
  // cell outside every hole wall must stay uncut.
  let checked = 0
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const { x, y } = cellCenter(grid, col, row)
      const insideHole = x > 35 && x < 65 && y > 35 && y < 65
      const holeClearance = Math.min(Math.abs(x - 35), Math.abs(x - 65), Math.abs(y - 35), Math.abs(y - 65))
      if (!insideHole && holeClearance > CELL_SIZE) {
        assert.equal(grid.topZ[row * grid.cols + col], grid.stockTopZ, `part cell (${col}, ${row}) must stay uncut`)
        checked += 1
      }
    }
  }
  assert.ok(checked > 1000, `expected a meaningful part area, got ${checked} cells`)
  console.log(`hole part side uncut: PASSED (${checked} cells)`)
}

function testSimulateOperationFindsTheTorch(): void {
  console.log('Testing simulateOperationHeightfield simulates a plasma operation...')
  const project = fixture()
  const operation = op(project)
  const result = simulateOperationHeightfield(project, operation, generate(project, operation), {
    targetLongAxisCells: targetCellsFor(project),
  })

  assert.ok(!result.warnings.some((warning) => warning.code === 'replayNoTool'), 'a torch is a usable tool for its operation')
  assert.ok(result.stats.removedCellCount > 0, 'the plasma operation removes material')
  assert.ok(result.stats.processedMoveCount > 0, 'the plasma operation replays its torch-on moves')
  console.log(`simulateOperationHeightfield on plasma: PASSED (${result.stats.removedCellCount} cells)`)
}

function plasmaItem(toolpath: ToolpathResult): SimulationReplayItem {
  return {
    operationId: toolpath.operationId,
    operationName: 'Plasma cut',
    toolRef: 'torch',
    toolType: 'plasma',
    toolRadius: TOOL_RADIUS,
    vBitAngle: null,
    toolpath,
  }
}

/** A cell count that makes the resolved grid at most a quarter of the kerf wide. */
function targetCellsFor(project: Project): number {
  const bounds = getStockBounds(project.stock)
  const longest = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
  return Math.ceil(longest / CELL_SIZE)
}

try {
  const outside = generate(fixture())
  assert.ok(outside.moves.length > 0, 'the outside contour generates')

  testKernelCutsOneKerfThrough(outside)
  testPierceIsCutThrough(outside)
  testMoveZDoesNotMatter(outside)
  testRapidsCutNothing()
  testPartSideStaysUncutOutside()
  testPartSideStaysUncutHole()
  testSimulateOperationFindsTheTorch()

  console.log('\nAll plasma replay tests PASSED.')
} catch (error) {
  console.error(error)
  throw error
}
