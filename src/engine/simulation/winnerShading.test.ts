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
 * Issue #1209: winner-move shading. The flat kernel records which move set each
 * cell's height, and the surface shader evaluates those moves exactly inside
 * the cell. These tests pin the four things that makes true:
 *
 *  - recording winners leaves every height byte-identical;
 *  - the winner does not depend on the order moves arrive in (the tie rule),
 *    so playback ends with the batch's winners;
 *  - the shader's per-move math (`WINNER_CUT_GLSL`, run from its own source)
 *    is the kernel's;
 *  - the winners of the 2×2 cells around a point, plus each one's neighbour in
 *    cut order, rebuild the exact height almost everywhere — and a playback
 *    clamp never shows a cut ahead of the tool.
 */

import { newProject } from '../../types/project'
import type { ToolpathMove, ToolpathResult } from '../toolpaths/types'
import { compileScalarGlsl } from './glslScalar.testSupport'
import { createSimulationGrid } from './grid'
import { createHeightfieldMaterial } from './heightfieldShader'
import { createHeightfieldTexture } from './gpuMesh'
import { MOVE_TABLE_STRIDE, WINNER_NONE, WINNER_UNKNOWN, type SimulationMoveTable } from './moveTable'
import { PlaybackController } from './playback'
import { applyMoveToGrid, replayItemsIntoGrid } from './replay'
import type { SimulationGrid, SimulationReplayItem } from './types'
import { WINNER_CUT_GLSL, WINNER_NO_CUT } from './winnerShader'
import { moveToolUniform } from './winnerShading'
import * as THREE from 'three'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const glsl = compileScalarGlsl(WINNER_CUT_GLSL)
const winnerCutZ = glsl.winnerCutZ as (...args: Array<number | boolean>) => number
const winnerCutSlope = glsl.winnerCutSlope as (...args: Array<number | boolean>) => number

let seed = 1209
function random(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}

const move = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): ToolpathMove =>
  ({ kind: 'cut', from: { x: x0, y: y0, z: z0 }, to: { x: x1, y: y1, z: z1 } })

const item = (toolType: SimulationReplayItem['toolType'], toolRadius: number, moves: ToolpathMove[], vBitAngle: number | null = null): SimulationReplayItem => ({
  operationId: toolType, operationName: toolType, toolRef: toolType, toolType, toolRadius, vBitAngle,
  toolpath: { moves } as unknown as ToolpathResult,
})

/** A block about 40 mm square at the given detail. */
function blockGrid(detail: number): SimulationGrid {
  const project = newProject('winners', 'mm')
  const grid = createSimulationGrid(project, { targetLongAxisCells: detail })
  assert(grid.winners !== undefined && grid.moveTable !== undefined, 'a flat block records winners')
  return grid
}

/**
 * Ball raster passes 1 mm apart, a V-bit groove, a ramped flat route that
 * cuts through, and a plunge: every profile, ramps, a through cut and a feather
 * edge where the ball meets the stock bottom.
 */
function syntheticJob(grid: SimulationGrid): SimulationReplayItem[] {
  const x0 = grid.originX
  const y0 = grid.originY
  const top = grid.stockTopZ
  const width = grid.cols * grid.cellSize
  const height = grid.rows * grid.cellSize
  const raster: ToolpathMove[] = []
  for (let k = 0; k * 1 < width; k += 1) {
    const x = x0 + 0.3 + k
    // Segments shorter than a cell, as a surface finish emits them, sloping
    // down the stock.
    const segments = Math.ceil(height / (0.8 * grid.cellSize))
    for (let s = 0; s < segments; s += 1) {
      const ya = y0 + (s / segments) * height
      const yb = y0 + ((s + 1) / segments) * height
      raster.push(move(x, ya, top - 1 - (s / segments) * (top - 1), x, yb, top - 1 - ((s + 1) / segments) * (top - 1)))
    }
  }
  return [
    item('ball_endmill', 3, raster),
    item('v_bit', 3, [move(x0 + 2, y0 + height * 0.3, top - 0.8, x0 + width - 2, y0 + height * 0.35, top - 0.8)], 60),
    item('flat_endmill', 2, [
      move(x0 + width * 0.6, y0 - 3, top, x0 + width * 0.6, y0 + height + 3, -1),
      move(x0 + width * 0.6, y0 + height + 3, -1, x0 + width * 0.6 + 2.3, y0 - 3, -1),
    ]),
    item('drill', 1.5, [move(x0 + width * 0.2, y0 + height * 0.8, top, x0 + width * 0.2, y0 + height * 0.8, top - 3)]),
  ]
}

/** The shader's evaluation of table entry `index` at (px, py). */
function tableCut(grid: SimulationGrid, table: SimulationMoveTable, index: number, px: number, py: number, maxT = 1): number {
  const d = table.data
  const o = index * MOVE_TABLE_STRIDE
  const tool = moveToolUniform(table.tools[d[o + 3]])
  return winnerCutZ(d[o], d[o + 1], d[o + 2], d[o + 4], d[o + 5], d[o + 6], tool.x, tool.y, tool.z, px, py, grid.stockBottomZ, maxT)
}

/** The exact height: every entry of the table, up to the playback progress. */
function exactHeight(grid: SimulationGrid, px: number, py: number, current = Infinity, elapsed = 1): number {
  const table = grid.moveTable!
  let h = grid.stockTopZ
  for (let i = 0; i < table.count && i <= current; i += 1) {
    h = Math.min(h, tableCut(grid, table, i, px, py, i === current ? elapsed : 1))
  }
  return h
}

/**
 * What the shader evaluates at (px, py): the winners of the 2×2 cells whose
 * centres surround the point, each with its neighbour on either side in cut
 * order, entries past the playback progress skipped. Null when a winner is
 * unknown (the shader then keeps the sampled surface).
 */
function shaderHeight(grid: SimulationGrid, px: number, py: number, current = Infinity, elapsed = 1, neighbours = 1): number | null {
  const table = grid.moveTable!
  const winners = grid.winners!
  const cx = (px - grid.originX) / grid.cellSize - 0.5
  const cy = (py - grid.originY) / grid.cellSize - 0.5
  const lowX = Math.floor(cx)
  const lowY = Math.floor(cy)
  let h = grid.stockTopZ
  const seen = new Set<number>()
  for (let corner = 0; corner < 4; corner += 1) {
    const col = lowX + (corner & 1)
    const row = lowY + (corner >> 1)
    if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) continue
    const w = winners[row * grid.cols + col]
    if (w === WINNER_UNKNOWN) return null
    if (w === WINNER_NONE || seen.has(w)) continue
    seen.add(w)
    const slot = table.data[w * MOVE_TABLE_STRIDE + 3]
    for (let step = -neighbours; step <= neighbours; step += 1) {
      const c = w + step
      if (c < 0 || c >= table.count || c > current) continue
      if (step !== 0 && table.data[c * MOVE_TABLE_STRIDE + 3] !== slot) continue
      h = Math.min(h, tableCut(grid, table, c, px, py, c === current ? elapsed : 1))
    }
  }
  return h
}

function testHeightsUnchanged(): void {
  for (const detail of [120, 333]) {
    const withWinners = blockGrid(detail)
    const { winners: _w, moveTable: _t, ...rest } = withWinners
    const without: SimulationGrid = { ...rest, topZ: new Float32Array(withWinners.topZ) }
    if (rest.edgeCrossings) without.edgeCrossings = new Uint8Array(rest.edgeCrossings)
    const job = syntheticJob(withWinners)
    replayItemsIntoGrid(withWinners, job)
    replayItemsIntoGrid(without, job)
    let differing = 0
    for (let i = 0; i < withWinners.topZ.length; i += 1) if (withWinners.topZ[i] !== without.topZ[i]) differing += 1
    assert(differing === 0, `recording winners must not move a height (detail ${detail}: ${differing} cells differ)`)
    let recorded = 0
    for (let i = 0; i < withWinners.winners!.length; i += 1) if (withWinners.winners![i] < WINNER_UNKNOWN) recorded += 1
    assert(recorded > withWinners.winners!.length / 2, `most cells are cut and must name a winner (${recorded})`)
    assert(withWinners.moveTable!.tools.length === 4, 'one tool slot per cutter')
  }
  console.log('heights unchanged with winners: PASSED')
}

function testTieRuleIsOrderIndependent(): void {
  // Two flat passes at the same depth, the second offset so it contains some
  // cells more deeply. Whichever order they arrive in, each cell names the
  // move whose footprint holds its centre more deeply.
  const passes = [move(10, 0, 5, 10, 40, 5), move(12.4, 0, 5, 12.4, 40, 5)]
  const results: Uint32Array[] = []
  for (const order of [[0, 1], [1, 0]]) {
    const grid = blockGrid(200)
    const table = grid.moveTable!
    table.tools.push({ toolType: 'flat_endmill', toolRadius: 3, vBitAngle: null })
    // Fixed table indices whatever the order: entry i is pass i.
    for (const pass of passes) {
      const o = table.count * MOVE_TABLE_STRIDE
      table.data.set([pass.from.x, pass.from.y, pass.from.z, 0, pass.to.x, pass.to.y, pass.to.z, 0], o)
      table.count += 1
    }
    for (const i of order) applyMoveToGrid(grid, passes[i], 3, 'flat_endmill', null, passes[i], 1, i)
    results.push(new Uint32Array(grid.winners!))
    const cell = (x: number) => grid.winners![Math.floor((20 - grid.originY) / grid.cellSize) * grid.cols + Math.floor((x - grid.originX) / grid.cellSize)]
    assert(cell(9.1) === 0, 'a cell deep inside the first pass names it')
    assert(cell(13.3) === 1, 'a cell deep inside the second pass names it')
  }
  assert(results[0].every((w, i) => w === results[1][i]), 'the winners must not depend on the order of the moves')
  console.log('tie rule is order independent: PASSED')
}

function testPlaybackWinnersMatchBatch(): void {
  const base = blockGrid(160)
  const job = syntheticJob(base)
  // The prior operations form the base; a level route plays. (A ramp played in
  // part already leaves heights a little different from a whole-move replay —
  // the kernel takes Z at the closest point of whatever piece it is given — so
  // parity is pinned where the heights themselves agree.)
  replayItemsIntoGrid(base, job.slice(0, 2))
  const x = base.originX + base.cols * base.cellSize * 0.6
  const far = base.originY + base.rows * base.cellSize + 3
  const route = item('flat_endmill', 2, [move(x, base.originY - 3, 1, x, far, 1), move(x, far, 1, x + 2.3, base.originY - 3, 1)])
  const tool = { toolType: route.toolType, toolRadius: route.toolRadius, vBitAngle: route.vBitAngle }
  const finished = new PlaybackController(base, route.toolpath.moves, tool)
  finished.seekToFraction(1)
  assert(finished.isFinished(), 'a seek to the end finishes playback')
  const baseCount = base.moveTable!.count
  assert(finished.liveGrid.moveTable!.count > baseCount, 'playback appends its pieces after the base table')
  assert(base.moveTable!.count === baseCount, 'the base table is never modified')
  for (const steps of [7, 53, 197]) {
    const stepped = new PlaybackController(base, route.toolpath.moves, tool)
    for (let i = 0; i < steps + 2 && !stepped.isFinished(); i += 1) stepped.advance(stepped.totalPathLength / steps)
    assert(stepped.isFinished(), `stepping ${steps} pieces finishes`)
    assert(stepped.liveGrid.winners!.every((w, i) => w === finished.liveGrid.winners![i]), `winners after ${steps} steps equal a direct seek`)
    assert(stepped.liveGrid.topZ.every((z, i) => z === finished.liveGrid.topZ[i]), `heights after ${steps} steps equal a direct seek`)
    stepped.seekToFraction(0.3)
    stepped.seekToFraction(1)
    assert(stepped.liveGrid.winners!.every((w, i) => w === finished.liveGrid.winners![i]), 'a backward seek restores and replays the winners')
    stepped.reset()
    assert(stepped.liveGrid.winners!.every((w, i) => w === base.winners![i]), 'reset restores the base winners')
  }
  // Base winners keep their meaning in the live table.
  const live = finished.liveGrid.moveTable!
  for (let i = 0; i < baseCount * MOVE_TABLE_STRIDE; i += 1) {
    assert(live.data[i] === base.moveTable!.data[i], 'the live table starts with the base table')
  }
  const progress = finished.getWinnerProgress()
  assert(progress.index === live.count && progress.fraction === 1, 'a finished playback reports the whole table')
  console.log('playback winners match batch: PASSED')
}

function testShaderMathIsTheKernels(): void {
  // One cell centred on the point: the kernel's height there is the shader's.
  const profiles: Array<[SimulationReplayItem['toolType'], number, number | null]> = [
    ['flat_endmill', 2, null], ['ball_endmill', 3, null], ['v_bit', 4, 60], ['v_bit', 2, 90], ['plasma', 0.8, null], ['drill', 1.5, null],
  ]
  let checked = 0
  for (const [toolType, radius, angle] of profiles) {
    for (let n = 0; n < 300; n += 1) {
      const m = move(random() * 10, random() * 10, 2 + random() * 6, random() * 10, random() * 10, 2 + random() * 6)
      if (n % 7 === 0) { m.to.x = m.from.x; m.to.y = m.from.y }
      const px = random() * 10
      const py = random() * 10
      const cell: SimulationGrid = {
        originX: px - 0.5, originY: py - 0.5, cellSize: 1, cols: 1, rows: 1, stockBottomZ: 0, stockTopZ: 100,
        topZ: new Float32Array([100]),
      }
      applyMoveToGrid(cell, m, radius, toolType, angle)
      const tool = moveToolUniform({ toolType, toolRadius: radius, vBitAngle: angle })
      const shader = winnerCutZ(m.from.x, m.from.y, m.from.z, m.to.x, m.to.y, m.to.z, tool.x, tool.y, tool.z, px, py, 0, 1)
      const kernel = cell.topZ[0] === 100 ? WINNER_NO_CUT : cell.topZ[0]
      if (shader >= WINNER_NO_CUT) {
        assert(kernel >= WINNER_NO_CUT || kernel >= 100 - 1e-6, `${toolType}: the shader misses a cut the kernel makes`)
        continue
      }
      assert(Math.abs(shader - Math.min(kernel, 100)) < 1e-4, `${toolType}: shader ${shader} vs kernel ${kernel}`)
      // The slope is the derivative of the same surface.
      const e = 1e-5
      for (const alongX of [true, false]) {
        const slope = winnerCutSlope(m.from.x, m.from.y, m.from.z, m.to.x, m.to.y, m.to.z, tool.x, tool.y, tool.z, px, py, 0, 1, alongX)
        const ahead = winnerCutZ(m.from.x, m.from.y, m.from.z, m.to.x, m.to.y, m.to.z, tool.x, tool.y, tool.z, px + (alongX ? e : 0), py + (alongX ? 0 : e), 0, 1)
        const behind = winnerCutZ(m.from.x, m.from.y, m.from.z, m.to.x, m.to.y, m.to.z, tool.x, tool.y, tool.z, px - (alongX ? e : 0), py - (alongX ? 0 : e), 0, 1)
        if (ahead >= WINNER_NO_CUT || behind >= WINNER_NO_CUT) continue
        const numeric = (ahead - behind) / (2 * e)
        // Skip the kinks (segment ends, the stock bottom), where one side differs.
        if (Math.abs((ahead - shader) / e - (shader - behind) / e) > 1e-2 * Math.max(1, Math.abs(numeric))) continue
        assert(Math.abs(slope - numeric) < 1e-3 * Math.max(1, Math.abs(numeric)), `${toolType}: slope ${slope} vs ${numeric}`)
      }
      checked += 1
    }
  }
  assert(checked > 500, `enough points inside a cutter's reach (${checked})`)
  console.log('shader math is the kernel\'s: PASSED')
}

function measureAccuracy(grid: SimulationGrid, neighbours: number): { share: number; unknown: number } {
  let within = 0
  let unknown = 0
  const samples = 6000
  for (let n = 0; n < samples; n += 1) {
    const px = grid.originX + random() * grid.cols * grid.cellSize
    const py = grid.originY + random() * grid.rows * grid.cellSize
    const shader = shaderHeight(grid, px, py, Infinity, 1, neighbours)
    if (shader === null) { unknown += 1; continue }
    if (shader - exactHeight(grid, px, py) <= 1e-4) within += 1
  }
  return { share: within / (samples - unknown), unknown }
}

function testWinnersRebuildTheExactHeight(): void {
  const grid = blockGrid(160)
  replayItemsIntoGrid(grid, syntheticJob(grid))
  const { share, unknown } = measureAccuracy(grid, 1)
  assert(unknown === 0, 'a replayed block has no unknown cells')
  assert(share >= 0.995, `the 2×2 winners and their neighbours must rebuild the exact height (${(100 * share).toFixed(2)}% within 1e-4)`)
  // Without the neighbours in cut order the short raster segments are missed.
  const bare = measureAccuracy(grid, 0)
  assert(bare.share < share, `the cut-order neighbours must matter (${(100 * bare.share).toFixed(2)}% without)`)
  console.log(`winners rebuild the exact height: PASSED (${(100 * share).toFixed(2)}% within 1e-4; ${(100 * bare.share).toFixed(2)}% without neighbours)`)
}

function testPlaybackClampShowsNothingAhead(): void {
  // Halfway along a long flat pass: the shader shows the cut behind the tool
  // and none ahead of it, even inside the cells the cut has already won.
  const base = blockGrid(160)
  const pass = move(base.originX + 20, base.originY - 5, 5, base.originX + 20, base.originY + 45, 5)
  const controller = new PlaybackController(base, [pass], { toolType: 'flat_endmill', toolRadius: 3, vBitAngle: null }, { maxSegmentLength: 100 })
  controller.seekToDistance(25)
  const { index, fraction } = controller.getWinnerProgress()
  assert(fraction > 0.4 && fraction < 0.6, `playback is partway through its one piece (${fraction})`)
  const grid = controller.liveGrid
  const toolY = controller.getPose().y
  let behind = 0
  let ahead = 0
  for (let n = 0; n < 2000; n += 1) {
    const px = pass.from.x - 2.5 + random() * 5
    const py = toolY - 6 + random() * 12
    const shader = shaderHeight(grid, px, py, index, fraction)
    assert(shader !== null, 'the live grid names its winners')
    const reached = (py - toolY) * (py - toolY) + (px - pass.from.x) * (px - pass.from.x) <= 9 || py <= toolY
    if (!reached) {
      ahead += 1
      assert(shader > 5 + 1e-6, `no cut ahead of the tool at (${px.toFixed(2)}, ${py.toFixed(2)})`)
    } else if (Math.abs(px - pass.from.x) < 2.9) {
      behind += 1
      assert(Math.abs(shader - 5) < 1e-6, 'the cut behind the tool is shown')
    }
  }
  assert(ahead > 100 && behind > 100, 'points on both sides of the tool were checked')
  console.log('playback clamp shows nothing ahead of the tool: PASSED')
}

function testOtherScenesKeepTheirShader(): void {
  const grid = blockGrid(60)
  const texture = createHeightfieldTexture(grid)
  const plain = createHeightfieldMaterial(texture, grid, new THREE.Color('#888888'))
  assert(!plain.fragmentShader.includes('winnerSurface'), 'no winner shading without its data')
  const roundBar = { axis: 'x' as const, pivot: 5, radius: 5, centre: 20, length: 40 }
  const shading = { uniforms: {}, invalidate() {}, update() {}, setProgress() {}, dispose() {} }
  const round = createHeightfieldMaterial(texture, grid, new THREE.Color('#888888'), undefined, roundBar, undefined, undefined, shading)
  assert(!round.fragmentShader.includes('winnerSurface'), 'a flat round bar keeps its shader')
  const block = createHeightfieldMaterial(texture, grid, new THREE.Color('#888888'), undefined, undefined, undefined, undefined, shading)
  assert(block.fragmentShader.includes('winnerSurface') && block.vertexShader.includes('vSheet'), 'a block with winners compiles the winner variant')
  const wrapped = createSimulationGrid(newProject('wrapped', 'mm'), { targetLongAxisCells: 60, wrap: { axis: 'y', period: 30 } })
  assert(wrapped.winners === undefined && wrapped.moveTable === undefined, 'an Around grid records no winners')
  texture.dispose()
  console.log('other scenes keep their shader: PASSED')
}

testHeightsUnchanged()
testTieRuleIsOrderIndependent()
testPlaybackWinnersMatchBatch()
testShaderMathIsTheKernels()
testWinnersRebuildTheExactHeight()
testPlaybackClampShowsNothingAhead()
testOtherScenesKeepTheirShader()
console.log('All winner shading tests PASSED.')
