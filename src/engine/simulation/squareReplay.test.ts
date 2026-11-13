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
 * Shared-heightfield behavior of a square blank (issue #1016 C2).
 *
 * The replacement model removes the exact square material kernel: a square
 * blank is the round bar's radial heightfield whose cells START at the blank's
 * true cross section (`createSimulationGrid` + `seedSquareTopZ`), and every
 * later step — cutting, statistics, playback, reset — is the round/flat path
 * with no square branch. These tests bite that contract:
 *
 *  - the grid seeds r(θ) per across cell and keeps an immutable baseline;
 *  - the shared kernel lowers corner cells above the inscribed radius, never
 *    raises a cell, ignores a tool above the envelope, and follows normal
 *    round behavior for angle-changing moves;
 *  - a wrapped square grid goes through the round seam copies;
 *  - playback, subdivision, seeks and reset match a batch replay and restore
 *    the prior base grid;
 *  - statistics measure each cell against its own baseline (a virgin square
 *    reports zero removed), not against the uniform corner envelope;
 *  - the actual generated rough keeps untouched ends square and the actual
 *    generated finish replays and seeks identically.
 *
 * Run with: npx tsx src/engine/simulation/squareReplay.test.ts
 */

import { applyMoveToGrid, simulateReplayItemsHeightfield } from './replay'
import { PlaybackController, cloneSimulationGrid } from './playback'
import { createSimulationGrid } from './grid'
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { generateRotaryFinish, generateRotaryRough } from '../toolpaths/rotaryModel'
import { buildRotaryCylinder } from '../rotaryCylinder'
import type { SimulationGrid } from './types'
import type { AroundFrame } from '../aroundFrame'
import type { ToolpathMove } from '../toolpaths/types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) < epsilon
}

/** A project whose stock is the unrolled Around sheet for a square blank. */
function sheetProject(side: number, axis: 'x' | 'y', zero: number, alongLength = 80, alongStart = 0): {
  project: ReturnType<typeof newProject>
  frame: AroundFrame
} {
  const circumference = Math.PI * side
  const radius = side / 2
  const frame: AroundFrame = {
    axis,
    centre: zero,
    radius,
    zero,
    sheetStart: zero - circumference / 2,
    circumference,
  }
  const xMin = axis === 'x' ? alongStart : zero - circumference / 2
  const xMax = axis === 'x' ? alongStart + alongLength : zero + circumference / 2
  const yMin = axis === 'x' ? zero - circumference / 2 : alongStart
  const yMax = axis === 'x' ? zero + circumference / 2 : alongStart + alongLength
  const project = newProject('square', 'mm')
  project.stock = { ...project.stock, profile: rectProfile(xMin, yMin, xMax - xMin, yMax - yMin), thickness: radius }
  return { project, frame }
}

/** The production initialization path: a square blank seeded as a heightfield. */
function squareGrid(side: number, axis: 'x' | 'y', zero: number, targetLongAxisCells = 96, alongLength = 80): SimulationGrid {
  const { project, frame } = sheetProject(side, axis, zero, alongLength)
  return createSimulationGrid(project, {
    squareBar: { side, frame },
    targetLongAxisCells,
  })
}

function gridsEqual(a: SimulationGrid, b: SimulationGrid, epsilon = 1e-6): boolean {
  if (a.topZ.length !== b.topZ.length) return false
  for (let i = 0; i < a.topZ.length; i += 1) {
    if (!approx(a.topZ[i], b.topZ[i], epsilon)) return false
  }
  return true
}

/** Cells lowered since creation, the deepest loss, and any cell that rose. */
function measure(grid: SimulationGrid): { changed: number; maxLoss: number; raised: number } {
  let changed = 0
  let maxLoss = 0
  let raised = 0
  const baseline = grid.initialTopZ!
  for (let i = 0; i < grid.topZ.length; i += 1) {
    const loss = baseline[i] - grid.topZ[i]
    if (loss > 1e-9) changed += 1
    if (loss > maxLoss) maxLoss = loss
    if (loss < -1e-9) raised += 1
  }
  return { changed, maxLoss, raised }
}

/** The across cell nearest a material angle, for corner/flat probes. */
function acrossIndexForAngle(grid: SimulationGrid, frame: AroundFrame, angle: number): number {
  const acrossOrigin = frame.axis === 'x' ? grid.originY : grid.originX
  const acrossCount = frame.axis === 'x' ? grid.rows : grid.cols
  const target = frame.zero + angle * frame.radius
  const index = Math.round((target - acrossOrigin) / grid.cellSize - 0.5)
  return Math.max(0, Math.min(acrossCount - 1, index))
}

function cellIndex(grid: SimulationGrid, frame: AroundFrame, along: number, acrossIndex: number): number {
  const alongOrigin = frame.axis === 'x' ? grid.originX : grid.originY
  const alongCount = frame.axis === 'x' ? grid.cols : grid.rows
  const alongIndex = Math.max(0, Math.min(alongCount - 1, Math.round((along - alongOrigin) / grid.cellSize - 0.5)))
  return frame.axis === 'x' ? acrossIndex * grid.cols + alongIndex : alongIndex * grid.cols + acrossIndex
}

// ---------------------------------------------------------------------------
// The shared kernel on a square-seeded heightfield.
// ---------------------------------------------------------------------------

function testLowersCornersAboveInscribedRadiusAndNeverRaises(): void {
  console.log('Testing the shared kernel lowers corner cells above the inscribed radius and never raises...')
  const side = 20
  const { project, frame } = sheetProject(side, 'x', 0)
  const grid = createSimulationGrid(project, { squareBar: { side, frame }, targetLongAxisCells: 96 })

  const cornerAcross = acrossIndexForAngle(grid, frame, Math.PI / 4)
  const cornerIdx = cellIndex(grid, frame, grid.originX + grid.cols * grid.cellSize / 2, cornerAcross)
  assert(
    grid.initialTopZ![cornerIdx] > side / 2 + 1,
    `a near-corner cell must stand above the inscribed radius ${side / 2}, got ${grid.initialTopZ![cornerIdx]}`,
  )

  const acrossCoordinate = grid.originY + (cornerAcross + 0.5) * grid.cellSize
  const alongFrom = grid.originX + grid.cellSize
  const alongTo = grid.originX + grid.cols * grid.cellSize - grid.cellSize
  const cut = (z: number): ToolpathMove => ({
    kind: 'cut',
    from: { x: alongFrom, y: acrossCoordinate, z },
    to: { x: alongTo, y: acrossCoordinate, z },
  })

  // A flat pass at 10 — the nominal inscribed radius — must reach up and lower
  // a corner cell that starts above it.
  const atInscribed = new PlaybackController(
    grid,
    [cut(side / 2)],
    { toolType: 'flat_endmill', toolRadius: 2, vBitAngle: null },
    { maxSegmentLength: 0 },
  )
  atInscribed.seekToFraction(1)
  const lowered = atInscribed.liveGrid.topZ[cornerIdx]
  assert(approx(lowered, side / 2, 1e-4), `a pass at the inscribed radius must floor the corner cell at ${side / 2}, got ${lowered}`)
  assert(lowered < grid.initialTopZ![cornerIdx], 'the corner cell must be lowered')
  assert(measure(atInscribed.liveGrid).raised === 0, 'a cut must never raise a cell')

  // Sequentially deeper passes lower monotonically; the deepest tool wins.
  const sequential = squareGrid(side, 'x', 0)
  let previous = new Float32Array(sequential.topZ)
  for (const z of [12, 8, 10]) {
    applyMoveToGrid(sequential, cut(z), 2, 'flat_endmill', null)
    for (let i = 0; i < sequential.topZ.length; i += 1) {
      assert(sequential.topZ[i] <= previous[i] + 1e-9, 'a cut must only lower cells')
    }
    previous = new Float32Array(sequential.topZ)
  }
  assert(approx(sequential.topZ[cornerIdx], 8, 1e-4), 'the deepest pass must own the cell height')

  // A higher tool is a no-op: it cannot pull material back up.
  const beforeHigher = new Float32Array(sequential.topZ)
  const higher = applyMoveToGrid(sequential, cut(side * 2), 2, 'flat_endmill', null)
  assert(higher.changedCount === 0, `a higher tool must remove nothing, got ${higher.changedCount}`)
  for (let i = 0; i < sequential.topZ.length; i += 1) {
    assert(sequential.topZ[i] === beforeHigher[i], 'a higher tool must not mutate the grid')
  }
  console.log(
    `corner lowering, monotonicity and higher-tool no-op: PASSED `
    + `(corner ${grid.initialTopZ![cornerIdx].toFixed(4)} -> ${lowered.toFixed(4)})`,
  )
}

function testAboveEnvelopeAngleMovingLinkRemovesNothing(): void {
  console.log('Testing an angle-moving link above the corner envelope removes nothing...')
  const grid = squareGrid(20, 'x', 0)
  const maxRadius = 20 * Math.SQRT1_2
  const move: ToolpathMove = {
    kind: 'cut',
    from: { x: grid.originX + 10, y: grid.originY + 2, z: maxRadius + 1 },
    to: { x: grid.originX + grid.cols * grid.cellSize - 10, y: grid.originY + grid.rows * grid.cellSize - 2, z: maxRadius + 0.5 },
  }
  const result = applyMoveToGrid(grid, move, 5, 'flat_endmill', null)
  assert(result.changedCount === 0, `an above-envelope link must remove nothing, got ${result.changedCount}`)
  assert(result.dirtyRegion === null, 'an above-envelope link must not dirty a region')
  assert(measure(grid).changed === 0, 'no cell may be lowered by an above-envelope link')
  console.log('above-envelope angle-moving link: PASSED')
}

function testChangingAngleMovesFollowRoundBehavior(): void {
  console.log('Testing a changing-angle move follows normal round behavior instead of refusing...')
  const grid = squareGrid(20, 'x', 0)
  // Diagonal across the sheet: the across coordinate changes while the tool
  // travels, which is an ordinary swept cut now — no square-only support
  // regime and no refusal.
  const move: ToolpathMove = {
    kind: 'cut',
    from: { x: grid.originX + 2, y: grid.originY + 2, z: 9 },
    to: { x: grid.originX + grid.cols * grid.cellSize - 2, y: grid.originY + grid.rows * grid.cellSize - 2, z: 9 },
  }
  const result = applyMoveToGrid(grid, move, 3, 'flat_endmill', null)
  assert(result.changedCount > 0, 'the diagonal pass must remove material')
  const loss = measure(grid)
  assert(loss.raised === 0, 'a changing-angle move must never raise a cell')
  assert(loss.maxLoss > 1, `the diagonal must really lower corner-standing cells, got ${loss.maxLoss}`)

  // The same link lifted above the envelope stays inert, so the behavior above
  // is cutting, not indiscriminate lowering.
  const lifted = squareGrid(20, 'x', 0)
  const liftedResult = applyMoveToGrid(lifted, {
    ...move,
    from: { ...move.from, z: 20 },
    to: { ...move.to, z: 20 },
  }, 3, 'flat_endmill', null)
  assert(liftedResult.changedCount === 0, 'the same link raised above the envelope must remove nothing')
  console.log('changing-angle move on the shared path: PASSED')
}

function testWrappedSquareGridUsesTheRoundSeamCopies(): void {
  console.log('Testing a wrapped square grid goes through the round seam copies...')
  const side = 20
  const circumference = Math.PI * side
  const { project, frame } = sheetProject(side, 'x', 0)
  const wrap = { axis: 'y' as const, period: circumference }
  const options = { squareBar: { side, frame }, targetLongAxisCells: 96 }
  const wrapped = createSimulationGrid(project, { ...options, wrap })
  const plain = createSimulationGrid(project, options)

  // An interior pass is inside the sheet, so the wrap adds no seam copy. F8
  // made the wrapped kernel resolve the cutter's true solid, so it is now
  // deliberately NOT the flat sheet's result any more: the two must differ, and
  // only the wrapped one is the physical answer.
  const interior: ToolpathMove = { kind: 'cut', from: { x: 10, y: 0, z: 6 }, to: { x: 60, y: 2, z: 6 } }
  applyMoveToGrid(wrapped, interior, 4, 'flat_endmill', null)
  applyMoveToGrid(plain, interior, 4, 'flat_endmill', null)
  const interiorDelta = (() => {
    let max = 0
    let cells = 0
    for (let i = 0; i < wrapped.topZ.length; i += 1) {
      const delta = Math.abs(wrapped.topZ[i] - plain.topZ[i])
      if (delta > 1e-9) cells += 1
      max = Math.max(max, delta)
    }
    return { max, cells }
  })()
  assert(interiorDelta.cells > 20, `the wrapped pass must use the true cutter width (${interiorDelta.cells} cells)`)
  assert(interiorDelta.max > 1e-3, `the true-width difference must be material (max ${interiorDelta.max})`)

  // A pass one period beyond the sheet is the same material via the seam copy.
  const low = wrapped.originY
  const atSeam = (y: number): SimulationGrid => {
    const grid = createSimulationGrid(project, { ...options, wrap })
    applyMoveToGrid(grid, { kind: 'cut', from: { x: 15, y, z: 6 }, to: { x: 65, y, z: 6 } }, 4, 'flat_endmill', null)
    return grid
  }
  assert(
    gridsEqual(atSeam(low + 1), atSeam(low + 1 + circumference)),
    'the seam copy must map a pass one period out onto the same material',
  )
  console.log('wrapped square grid seam copies: PASSED')
}

// ---------------------------------------------------------------------------
// Playback: the round path, base-grid reset included.
// ---------------------------------------------------------------------------

const TOOL = { toolType: 'flat_endmill' as const, toolRadius: 4, vBitAngle: null }

function playbackMoves(): ToolpathMove[] {
  return [
    { kind: 'plunge', from: { x: 30, y: 0, z: 14 }, to: { x: 30, y: 0, z: 4 } },
    { kind: 'cut', from: { x: 30, y: 0, z: 4 }, to: { x: 70, y: 0, z: 4 } },
    { kind: 'cut', from: { x: 30, y: 10, z: 6 }, to: { x: 70, y: 10, z: 6 } },
  ]
}

function testPlaybackMatchesBatchReplay(): void {
  console.log('Testing square playback, subdivision and seeks match a batch replay...')
  const moves = playbackMoves()

  const batch = squareGrid(20, 'x', 0)
  for (const move of moves) applyMoveToGrid(batch, move, TOOL.toolRadius, TOOL.toolType, null)

  const stepped = new PlaybackController(squareGrid(20, 'x', 0), moves, TOOL, { maxSegmentLength: 0 })
  stepped.seekToFraction(1)
  assert(gridsEqual(stepped.liveGrid, batch), 'stepped playback must match the batch replay')

  const subdivided = new PlaybackController(squareGrid(20, 'x', 0), moves, TOOL, { maxSegmentLength: TOOL.toolRadius * 2 })
  subdivided.seekToFraction(1)
  assert(gridsEqual(subdivided.liveGrid, batch), 'subdivided playback must match the batch replay')

  const chained = new PlaybackController(squareGrid(20, 'x', 0), moves, TOOL, { maxSegmentLength: 0 })
  chained.seekToFraction(0.4)
  chained.seekToFraction(0.75)
  chained.seekToFraction(1)
  assert(gridsEqual(chained.liveGrid, batch), 'chained forward seeks must match a fresh replay')

  chained.seekToFraction(0.1)
  const early = new PlaybackController(squareGrid(20, 'x', 0), moves, TOOL, { maxSegmentLength: 0 })
  early.seekToFraction(0.1)
  assert(gridsEqual(chained.liveGrid, early.liveGrid), 'a backward seek must restore the earlier state')

  for (let i = 0; i < batch.topZ.length; i += 1) {
    assert(
      stepped.liveGrid.topZ[i] === subdivided.liveGrid.topZ[i],
      'batch and subdivided playback must be byte-identical',
    )
  }
  console.log('square playback parity: PASSED')
}

function testPlaybackPreservesBaselineAndResetsToBase(): void {
  console.log('Testing playback shares and preserves the baseline and reset restores the prior base...')
  const base = squareGrid(20, 'x', 0)
  const baseline = new Float32Array(base.initialTopZ!)
  const controller = new PlaybackController(base, playbackMoves(), TOOL, { maxSegmentLength: 0 })

  assert(!('squareBar' in controller.liveGrid), 'a playback grid must not gain a runtime square descriptor')
  assert(controller.liveGrid.initialTopZ === base.initialTopZ, 'the immutable baseline must ride along by reference')
  assert(controller.liveGrid.topZ !== base.topZ, 'live playback must own its mutable heights')
  assert(cloneSimulationGrid(base).initialTopZ === base.initialTopZ, 'the clone must share the baseline')

  controller.seekToFraction(1)
  assert(measure(controller.liveGrid).changed > 0, 'playback must actually cut the square grid')
  controller.reset()
  assert(gridsEqual(controller.liveGrid, base), 'reset must restore the exact base grid')
  for (let i = 0; i < base.topZ.length; i += 1) {
    assert(controller.liveGrid.topZ[i] === base.topZ[i], 'reset must restore every cell, corners included')
  }
  const dirty = controller.getDirtyRegion()
  assert(dirty !== null, 'reset must mark the whole grid dirty so the GPU re-uploads')
  assert(dirty!.colMax === base.cols - 1 && dirty!.rowMax === base.rows - 1, 'reset must dirty the full grid')

  controller.seekToFraction(1)
  controller.seekToFraction(0)
  for (let i = 0; i < baseline.length; i += 1) {
    assert(base.initialTopZ![i] === baseline[i], 'the baseline must never be written')
  }
  for (let i = 0; i < base.topZ.length; i += 1) {
    assert(controller.liveGrid.topZ[i] === base.topZ[i], 'a backward seek to zero must restore the base grid')
  }
  console.log('playback baseline and base reset: PASSED')
}

// ---------------------------------------------------------------------------
// Statistics against each cell's own starting height.
// ---------------------------------------------------------------------------

function testStatsMeasureEachCellsBaseline(): void {
  console.log('Testing square statistics measure each cell against its own baseline...')
  const side = 20
  const { project, frame } = sheetProject(side, 'x', 0)
  const options = { squareBar: { side, frame }, targetLongAxisCells: 96 }

  // A virgin square reports nothing removed, even though most cells stand
  // below the corner envelope `stockTopZ`.
  const virgin = simulateReplayItemsHeightfield(project, [], options)
  assert(virgin.stats.removedCellCount === 0, `a virgin square must remove nothing, got ${virgin.stats.removedCellCount}`)
  assert(virgin.stats.maxRemovedDepth === 0, `a virgin square must have zero depth, got ${virgin.stats.maxRemovedDepth}`)
  let minBaseline = Infinity
  for (const value of virgin.grid.initialTopZ!) minBaseline = Math.min(minBaseline, value)
  assert(approx(virgin.stats.minTopZ, minBaseline, 1e-5), `minTopZ must be the lowest baseline ${minBaseline}, got ${virgin.stats.minTopZ}`)

  // The uniform alternative would classify nearly the whole virgin surface as
  // removed — the mutation this test exists to kill.
  let uniformRemoved = 0
  for (const value of virgin.grid.topZ) if (value < virgin.grid.stockTopZ - 1e-9) uniformRemoved += 1
  assert(uniformRemoved > virgin.grid.topZ.length / 2, 'fixture: a uniform comparison would misclassify the virgin square')

  // After a real cut, every statistic must equal the per-cell baseline
  // computation exactly.
  const item = {
    operationId: 'stats',
    operationName: 'stats',
    toolRef: null,
    toolType: 'flat_endmill' as const,
    toolRadius: 6,
    vBitAngle: null,
    toolpath: {
      operationId: 'stats',
      moves: [
        { kind: 'cut' as const, from: { x: 20, y: 0, z: 5 }, to: { x: 60, y: 0, z: 5 } },
        { kind: 'plunge' as const, from: { x: 40, y: 7, z: 14 }, to: { x: 40, y: 7, z: 3 } },
      ],
      warnings: [],
      bounds: null,
    },
  }
  const cut = simulateReplayItemsHeightfield(project, [item], options)
  let removed = 0
  let minTopZ = cut.grid.stockTopZ
  let maxDepth = 0
  for (let i = 0; i < cut.grid.topZ.length; i += 1) {
    const z = cut.grid.topZ[i]
    minTopZ = Math.min(minTopZ, z)
    if (z < cut.grid.initialTopZ![i] - 1e-9) removed += 1
    maxDepth = Math.max(maxDepth, cut.grid.initialTopZ![i] - z)
  }
  assert(removed > 0, 'the cut must remove material')
  assert(cut.stats.removedCellCount === removed, `removed cells must be ${removed}, got ${cut.stats.removedCellCount}`)
  assert(approx(cut.stats.minTopZ, minTopZ, 1e-9), `minTopZ must be ${minTopZ}, got ${cut.stats.minTopZ}`)
  assert(approx(cut.stats.maxRemovedDepth, maxDepth, 1e-9), `max depth must be ${maxDepth}, got ${cut.stats.maxRemovedDepth}`)
  console.log(`square baseline statistics: PASSED (${removed} cells, max depth ${maxDepth.toFixed(3)})`)
}

// ---------------------------------------------------------------------------
// Generated paths through the shared replay.
// ---------------------------------------------------------------------------

/** A real square-stock project and its Around frame, for generated paths. */
function generatedProject(side: number, length: number, label: string): {
  stock: ReturnType<typeof squareStock>
  project: ReturnType<typeof newProject>
  frame: AroundFrame
} {
  const stock = squareStock(side, length, 'x')
  const zero = barCentre(stock)
  const frame: AroundFrame = {
    axis: 'x',
    centre: zero,
    radius: side / 2,
    zero,
    sheetStart: zero - Math.PI * side / 2,
    circumference: Math.PI * side,
  }
  const project = newProject(label, 'mm')
  project.stock = {
    ...project.stock,
    profile: rectProfile(0, frame.sheetStart, length, frame.circumference),
    thickness: side / 2,
  }
  return { stock, project, frame }
}

/** Stock-space moves become pivot-referenced sheet moves, as the app wraps them. */
function toSheet(move: ToolpathMove, pivot: number): ToolpathMove {
  return {
    ...move,
    from: { ...move.from, z: move.from.z - pivot },
    to: { ...move.to, z: move.to.z - pivot },
  }
}

function testActualGeneratedRoughKeepsUntouchedEnds(): void {
  console.log('Testing the actual generated rough replays on the shared path and keeps its ends square...')
  const side = 20
  const length = 100
  const { stock, project, frame } = generatedProject(side, length, 'rough')
  const blank = newProject('rough', 'mm')
  const tool = normalizeToolForProject({ ...defaultTool('mm', 1), type: 'flat_endmill', diameter: 16 }, blank)
  const mesh = buildRotaryCylinder(stock, { diameter: 12, alongStart: 20, alongEnd: 80 }, 'mm')
  const rough = generateRotaryRough('rough', mesh, stock, tool, {
    stepover: 2 * Math.PI * barMaxRadius(stock) / 8,
    stepdown: 9,
    stockToLeave: 0,
    sampleSpacing: 12,
    requestedCellSize: 0.25,
    alongStart: 20,
    alongEnd: 80,
    safeRadius: 25,
  }, {})
  assert(rough.moves.length > 0, 'the generated rough must produce motion')

  const grid = createSimulationGrid(project, { squareBar: { side, frame }, targetLongAxisCells: 180 })
  const pivot = barPivotZ(stock)
  for (const move of rough.moves) {
    if (move.kind !== 'cut' && move.kind !== 'plunge' && move.kind !== 'lead_in' && move.kind !== 'lead_out') continue
    applyMoveToGrid(grid, toSheet(move, pivot), tool.radius, 'flat_endmill', null)
  }

  const loss = measure(grid)
  assert(loss.changed > 0, 'the generated rough must remove material through the shared kernel')
  assert(loss.raised === 0, 'the rough replay must never raise a cell')

  // Untouched axial ends keep the square cross section exactly: nothing beyond
  // the tool's reach of the 20..80 band may move, corners included.
  const endMargin = tool.radius + grid.cellSize
  let endCells = 0
  let maxBaselineEnd = 0
  for (let col = 0; col < grid.cols; col += 1) {
    const along = grid.originX + (col + 0.5) * grid.cellSize
    if (along > 20 - endMargin && along < 80 + endMargin) continue
    for (let row = 0; row < grid.rows; row += 1) {
      const idx = row * grid.cols + col
      assert(grid.topZ[idx] === grid.initialTopZ![idx], `untouched end cell (${col},${row}) must keep its square height`)
      maxBaselineEnd = Math.max(maxBaselineEnd, grid.initialTopZ![idx])
      endCells += 1
    }
  }
  assert(endCells > 0, 'fixture: the rough band must leave untouched end cells')
  assert(maxBaselineEnd > side / 2 + 1, 'fixture: the untouched ends must include a corner rise')
  console.log(`generated rough ends stay square: PASSED (${loss.changed} cells cut, max depth ${loss.maxLoss.toFixed(3)})`)
}

function testActualGeneratedFinishReplaysAndSeeks(): void {
  console.log('Testing the actual generated finish replays and seeks identically...')
  const side = 20
  const { stock, project, frame } = generatedProject(side, 100, 'finish')
  const blank = newProject('finish', 'mm')
  const tool = normalizeToolForProject({ ...defaultTool('mm', 1), type: 'ball_endmill', diameter: 8 }, blank)
  const mesh = buildRotaryCylinder(stock, { diameter: 12, alongStart: 20, alongEnd: 80 }, 'mm')
  const finish = generateRotaryFinish('finish', mesh, stock, tool, {
    stepover: 2 * Math.PI * barMaxRadius(stock) / 16,
    stockToLeave: 0,
    sampleSpacing: 8,
    requestedCellSize: 0.25,
    alongStart: 20,
    alongEnd: 80,
    safeRadius: 25,
  }, {})
  assert(finish.moves.length > 0, 'the generated finish must produce motion')

  const pivot = barPivotZ(stock)
  const moves = finish.moves
    .filter((move) => move.kind === 'cut' || move.kind === 'plunge' || move.kind === 'lead_in' || move.kind === 'lead_out')
    .map((move) => toSheet(move, pivot))
  assert(moves.length > 0, 'the generated finish must have replayable motion')

  const makeGrid = (): SimulationGrid => createSimulationGrid(project, {
    squareBar: { side, frame },
    targetLongAxisCells: 120,
  })
  const batch = makeGrid()
  for (const move of moves) applyMoveToGrid(batch, move, tool.radius, 'ball_endmill', null)
  assert(measure(batch).changed > 0, 'the generated finish must remove material')

  const options = { toolType: 'ball_endmill' as const, toolRadius: tool.radius, vBitAngle: null }
  const playback = new PlaybackController(makeGrid(), moves, options, { maxSegmentLength: 0 })
  playback.seekToFraction(1)
  assert(gridsEqual(playback.liveGrid, batch), 'generated finish playback must match the batch replay')

  playback.seekToFraction(0.5)
  const halfway = new PlaybackController(makeGrid(), moves, options, { maxSegmentLength: 0 })
  halfway.seekToFraction(0.5)
  assert(gridsEqual(playback.liveGrid, halfway.liveGrid), 'a backward finish seek must restore the earlier state')
  console.log('generated finish path and playback seeking: PASSED')
}

try {
  testLowersCornersAboveInscribedRadiusAndNeverRaises()
  testAboveEnvelopeAngleMovingLinkRemovesNothing()
  testChangingAngleMovesFollowRoundBehavior()
  testWrappedSquareGridUsesTheRoundSeamCopies()
  testPlaybackMatchesBatchReplay()
  testPlaybackPreservesBaselineAndResetsToBase()
  testStatsMeasureEachCellsBaseline()
  testActualGeneratedRoughKeepsUntouchedEnds()
  testActualGeneratedFinishReplaysAndSeeks()
  console.log('\nAll square shared-heightfield tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
