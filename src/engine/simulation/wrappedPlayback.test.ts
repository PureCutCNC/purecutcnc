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
 * A part-played wrapped move cuts only the material the cutter has reached
 * (issue #1048).
 *
 * The wrapped kernel resolves every cell against the source move the playback
 * piece came from. A multi-turn engrave (a thread, a twisted flute, a ring) has
 * periodic images and a nearest pose for a cell that can lie a whole turn
 * *ahead* of the piece being played, so playback removed a slot the cutter had
 * not reached yet; the slot travelled with the tool. Batch replay looked right
 * because it applies the whole move at once.
 *
 * The oracle here is independent of the fix: batch-replay the toolpath
 * truncated at the playback fraction (every earlier move whole, the current
 * one ending at the fraction). That is, by definition, what the cutter has
 * reached at that instant — a flat replay of the played prefix, not a value
 * produced by `PlaybackController` or by anything the fix computes.
 *
 * What this test bites:
 *  - a hand-built thread (one pitch per turn, three turns) with a flat, ball
 *    and V-bit cutter, at five playback fractions and at the finish;
 *  - a Flutes-like twisted line and an around-the-bar ring, which exercise the
 *    same seam images through a different approach direction;
 *  - Frank's #1048 project (`src/engine/simulation/wrappedPlayback.fixture.camj`),
 *    loaded through the real project and toolpath path: at 2 % and 6 % no cell
 *    may be lowered past the truncated replay.
 *
 * Mutations checked: `advance()` returning immediately fails the fixture's
 * symmetric/removal check, and restoring the nearest-pose batch ceiling on a
 * partial piece fails the ascending ramp at 10 % (0.373 > one cell).
 *
 * Run with: npx tsx src/engine/simulation/wrappedPlayback.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decodeProjectFormat } from '../../store/helpers/projectFormat'
import { buildSimulationSetupInput } from '../../app/simulationSetup'
import { simulationBuildOptions } from '../../app/simulationCompute'
import { findOperationTool } from '../../toolPolicy'
import { computeOperationToolpath } from '../toolpaths/generateOperation'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { setupForOperation } from '../setupOrientation'
import type { ToolType } from '../../types/project'
import type { ToolpathMove } from '../toolpaths/types'
import { createSimulationGrid } from './grid'
import { PlaybackController } from './playback'
import type { PlaybackOptions, PlaybackToolInfo } from './playback'
import { applyMoveToGrid, moveIsMaterialRemoving } from './replay'
import type { SimulationGrid } from './types'

const FRACTIONS = [0.1, 0.25, 0.5, 0.75, 0.9]

/** A round bar unrolled: one circumference across, `radius = period / 2π`. */
function roundGrid(period: number, alongLength: number, alongCells: number): SimulationGrid {
  const radius = period / (2 * Math.PI)
  const cellSize = alongLength / alongCells
  const acrossCells = Math.round(period / cellSize)
  return {
    cols: alongCells,
    rows: acrossCells,
    cellSize,
    originX: 0,
    originY: -period / 2,
    stockBottomZ: 0,
    stockTopZ: radius,
    wrap: { axis: 'y', period },
    topZ: new Float32Array(alongCells * acrossCells).fill(radius),
  }
}

function moveLength(move: ToolpathMove): number {
  return Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y, move.to.z - move.from.z)
}

function interpolate(move: ToolpathMove, fraction: number): { x: number; y: number; z: number } {
  return {
    x: move.from.x + (move.to.x - move.from.x) * fraction,
    y: move.from.y + (move.to.y - move.from.y) * fraction,
    z: move.from.z + (move.to.z - move.from.z) * fraction,
  }
}

function cloneGrid(grid: SimulationGrid): SimulationGrid {
  return { ...grid, topZ: new Float32Array(grid.topZ) }
}

/**
 * Batch replay of the path truncated at `fraction` of its total length: every
 * move before the cut point whole, the current one ending there. This is the
 * material the cutter has reached, and the oracle every playback frame is
 * measured against.
 */
function batchReplayTruncated(
  base: SimulationGrid,
  moves: readonly ToolpathMove[],
  fraction: number,
  tool: PlaybackToolInfo,
): SimulationGrid {
  const grid = cloneGrid(base)
  const total = moves.reduce((sum, move) => sum + moveLength(move), 0)
  let remaining = total * fraction
  for (const move of moves) {
    const length = moveLength(move)
    if (remaining >= length) {
      if (moveIsMaterialRemoving(move)) {
        applyMoveToGrid(grid, move, tool.toolRadius, tool.toolType, tool.vBitAngle)
      }
      remaining -= length
      continue
    }
    if (remaining > 0 && moveIsMaterialRemoving(move)) {
      const point = interpolate(move, remaining / length)
      applyMoveToGrid(
        grid,
        { ...move, from: { ...move.from }, to: { ...move.to, ...point } },
        tool.toolRadius,
        tool.toolType,
        tool.vBitAngle,
      )
    }
    break
  }
  return grid
}

interface Deviation {
  max: number
  cells: number
  loweredBeyond: number
  loweredBeyondMax: number
}

function deviation(actual: SimulationGrid, oracle: SimulationGrid): Deviation {
  let max = 0
  let cells = 0
  let loweredBeyond = 0
  let loweredBeyondMax = 0
  for (let index = 0; index < actual.topZ.length; index += 1) {
    const delta = actual.topZ[index] - oracle.topZ[index]
    const magnitude = Math.abs(delta)
    if (magnitude > 1e-9) cells += 1
    if (magnitude > max) max = magnitude
    if (-delta > loweredBeyondMax) loweredBeyondMax = -delta
    if (delta < -1e-9) loweredBeyond += 1
  }
  return { max, cells, loweredBeyond, loweredBeyondMax }
}

/** Cells the grid lowered below its base — material actually removed. */
function removedCells(grid: SimulationGrid, base: SimulationGrid): number {
  let removed = 0
  for (let index = 0; index < grid.topZ.length; index += 1) {
    if (grid.topZ[index] < base.topZ[index] - 1e-9) removed += 1
  }
  return removed
}

/**
 * The playback was asked for fraction `fraction`; assert it equals the batch
 * replay of the truncated path within one cell height in **both** directions,
 * and that both actually removed material (a disabled playback would otherwise
 * compare clean against an untouched grid).
 */
function assertPlaybackAtFraction(
  base: SimulationGrid,
  moves: ToolpathMove[],
  tool: PlaybackToolInfo,
  options: PlaybackOptions,
  fraction: number,
  label: string,
): void {
  const oracle = batchReplayTruncated(base, moves, fraction, tool)
  const playback = new PlaybackController(base, moves, tool, options)
  playback.seekToFraction(fraction)
  const delta = deviation(playback.liveGrid, oracle)
  // One cell height is the grid's only height resolution; the fix is expected
  // far inside it, but the bound keeps the assertion honest. Both directions are
  // checked: a frame may neither cut material the cutter has not reached nor
  // hold material the truncated replay has removed.
  assert(
    delta.max <= base.cellSize,
    `${label} @ ${fraction}: playback differs from the truncated replay by ${delta.max.toFixed(4)} `
    + `(> one cell height ${base.cellSize.toFixed(4)}) at ${delta.cells} cell(s)`,
  )
  assert(
    removedCells(playback.liveGrid, base) > 0,
    `${label} @ ${fraction}: playback must remove material, not leave the stock untouched`,
  )
  assert(
    removedCells(oracle, base) > 0,
    `${label} @ ${fraction}: the truncated replay must remove material to compare against`,
  )
  console.log(
    `  ${label} @ ${fraction}: max ${delta.max.toExponential(2)} at ${delta.cells} cells `
    + `(${delta.loweredBeyond} past the truncation, worst ${delta.loweredBeyondMax.toExponential(2)})`,
  )
}

/** At the finish the playback must equal the batch replay exactly. */
function assertPlaybackFinishesAsBatch(
  base: SimulationGrid,
  moves: ToolpathMove[],
  tool: PlaybackToolInfo,
  options: PlaybackOptions,
  label: string,
): void {
  const batch = cloneGrid(base)
  for (const move of moves) {
    if (moveIsMaterialRemoving(move)) {
      applyMoveToGrid(batch, move, tool.toolRadius, tool.toolType, tool.vBitAngle)
    }
  }
  const playback = new PlaybackController(base, moves, tool, options)
  playback.seekToFraction(1)
  const delta = deviation(playback.liveGrid, batch)
  assert(
    delta.max === 0,
    `${label}: finished playback must equal the batch exactly (max ${delta.max} at ${delta.cells} cells)`,
  )
  assert(
    removedCells(playback.liveGrid, base) > 0,
    `${label}: finished playback must remove material, not leave the stock untouched`,
  )
  console.log(`  ${label}: finished playback equals the batch exactly`)
}

// ── a hand-built thread: three turns, one pitch of along advance per turn ──

const THREAD_PERIOD = 2 * Math.PI * 5
const THREAD_GRID = roundGrid(THREAD_PERIOD, 20, 140)
const THREAD_PROFILES: Array<{ label: string; toolType: ToolType; toolRadius: number; vBitAngle: number | null }> = [
  { label: 'flat', toolType: 'flat_endmill', toolRadius: 1, vBitAngle: null },
  { label: 'ball', toolType: 'ball_endmill', toolRadius: 1, vBitAngle: null },
  { label: 'v-bit', toolType: 'v_bit', toolRadius: 1, vBitAngle: 30 },
]

function threadMoves(): ToolpathMove[] {
  // One move, three turns. The pitch (1) is within the tool radius, as in
  // Frank's project, so the next turn's image reaches the current footprint.
  return [{
    kind: 'cut',
    from: { x: 2, y: 0, z: 3 },
    to: { x: 2 + 3 * 1, y: 3 * THREAD_PERIOD, z: 3 },
  }]
}

function testThread(): void {
  console.log('Testing a part-played thread (3 turns, one pitch per turn)...')
  for (const profile of THREAD_PROFILES) {
    const tool: PlaybackToolInfo = {
      toolType: profile.toolType,
      toolRadius: profile.toolRadius,
      vBitAngle: profile.vBitAngle,
    }
    const moves = threadMoves()
    const options: PlaybackOptions = { maxSegmentLength: 2 }
    for (const fraction of FRACTIONS) {
      assertPlaybackAtFraction(THREAD_GRID, moves, tool, options, fraction, `thread/${profile.label}`)
    }
    assertPlaybackFinishesAsBatch(THREAD_GRID, moves, tool, options, `thread/${profile.label}`)
  }
  console.log('part-played thread: PASSED')
}

// ── a Flutes-like twisted line ───────────────────────────────────────

function testTwistedLine(): void {
  console.log('Testing a part-played Flutes-like twisted line...')
  const period = 2 * Math.PI * 4
  const grid = roundGrid(period, 16, 120)
  const moves: ToolpathMove[] = [
    {
      kind: 'cut',
      from: { x: 1, y: -0.5 * period, z: 2.5 },
      to: { x: 1 + 4 * 0.6, y: -0.5 * period + 4 * period, z: 2.5 },
    },
  ]
  for (const profile of [
    { label: 'ball', toolType: 'ball_endmill' as const, toolRadius: 0.8, vBitAngle: null },
    { label: 'v-bit', toolType: 'v_bit' as const, toolRadius: 0.8, vBitAngle: 60 },
  ]) {
    const tool: PlaybackToolInfo = {
      toolType: profile.toolType,
      toolRadius: profile.toolRadius,
      vBitAngle: profile.vBitAngle,
    }
    const options: PlaybackOptions = { maxSegmentLength: 1.5 }
    for (const fraction of FRACTIONS) {
      assertPlaybackAtFraction(grid, moves, tool, options, fraction, `twisted/${profile.label}`)
    }
    assertPlaybackFinishesAsBatch(grid, moves, tool, options, `twisted/${profile.label}`)
  }
  console.log('part-played twisted line: PASSED')
}

// ── an around-the-bar ring: A sweeps 0 → 360 at fixed along ──────────

function testRing(): void {
  console.log('Testing a part-played around-the-bar ring...')
  const period = 2 * Math.PI * 6
  const grid = roundGrid(period, 14, 120)
  const moves: ToolpathMove[] = [
    // Starts at the zero line and runs exactly one turn across, so the second
    // half is reached only through the seam image.
    { kind: 'cut', from: { x: 6, y: 0, z: 2 }, to: { x: 6, y: period, z: 2 } },
  ]
  const tool: PlaybackToolInfo = { toolType: 'flat_endmill', toolRadius: 1, vBitAngle: null }
  const options: PlaybackOptions = { maxSegmentLength: 1.2 }
  for (const fraction of FRACTIONS) {
    assertPlaybackAtFraction(grid, moves, tool, options, fraction, 'ring')
  }
  assertPlaybackFinishesAsBatch(grid, moves, tool, options, 'ring')
  console.log('part-played ring: PASSED')
}

// ── an ascending ramp: the batch used to under-cut what the cutter swept ──

/**
 * The reviewer's case (issue #1048 review): a radius-5 bar and a radius-1
 * cutter rising from Z 1 to Z 4 over X 2 → 10 at 0.1-mm cells. At 25 % the
 * cutter at X = 4 has already passed the cell at (4.95, -0.258) with its bottom
 * at 1.75; the nearest pose is X = 4.95 at Z 2.106. The batch used to leave
 * 2.109 (the nearest pose), while the truncated replay of the played prefix
 * left 1.752. The swept batch now agrees with the prefix, and every profile
 * must match its truncated replay in both directions at every fraction.
 */
function testAscendingRamp(): void {
  console.log('Testing an ascending ramp (flat, ball, V-bit)...')
  const period = 2 * Math.PI * 5
  const grid = roundGrid(period, 20, 200)
  const moves: ToolpathMove[] = [
    { kind: 'cut', from: { x: 2, y: 0, z: 1 }, to: { x: 10, y: 0, z: 4 } },
  ]
  const profiles: Array<{ label: string; toolType: ToolType; vBitAngle: number | null }> = [
    { label: 'flat', toolType: 'flat_endmill', vBitAngle: null },
    { label: 'ball', toolType: 'ball_endmill', vBitAngle: null },
    { label: 'v-bit', toolType: 'v_bit', vBitAngle: 30 },
  ]
  // The reviewer's cell: the old batch left 2.109 there, the played prefix
  // 1.752. Cell centres are at 0.1 mm, so this is the cell containing it.
  const col = Math.round((4.95 - grid.originX) / grid.cellSize - 0.5)
  const row = Math.round((-0.258 - grid.originY) / grid.cellSize - 0.5)
  const reviewerCell = row * grid.cols + col
  const flat = profiles[0]
  const batch = cloneGrid(grid)
  applyMoveToGrid(batch, moves[0], 1, flat.toolType, flat.vBitAngle)
  assert(
    batch.topZ[reviewerCell] < 2 && Math.abs(batch.topZ[reviewerCell] - 1.752) < grid.cellSize,
    `ramp/flat: the batch must cut the reviewer's cell to the swept 1.752, got ${batch.topZ[reviewerCell]}`,
  )
  console.log(`  ramp/flat @ reviewer cell: batch leaves ${batch.topZ[reviewerCell].toFixed(4)} (was 2.109)`)

  for (const profile of profiles) {
    const tool: PlaybackToolInfo = { toolType: profile.toolType, toolRadius: 1, vBitAngle: profile.vBitAngle }
    const options: PlaybackOptions = { maxSegmentLength: 2 }
    for (const fraction of FRACTIONS) {
      assertPlaybackAtFraction(grid, moves, tool, options, fraction, `ramp/${profile.label}`)
    }
    assertPlaybackFinishesAsBatch(grid, moves, tool, options, `ramp/${profile.label}`)
  }
  console.log('ascending ramp: PASSED')
}

// ── Frank's #1048 project, through the real project/toolpath path ────

interface ThreadFixture {
  grid: SimulationGrid
  moves: ToolpathMove[]
  tool: PlaybackToolInfo
  options: PlaybackOptions
}

function loadThreadFixture(): ThreadFixture {
  const raw = readFileSync(
    new URL('./wrappedPlayback.fixture.camj', import.meta.url),
    'utf8',
  )
  const project = decodeProjectFormat(JSON.parse(raw)).project
  const operation = project.operations.find((entry) => entry.name === 'Thread Engrave')
  assert(operation !== undefined, 'fixture: the Thread Engrave operation is present')
  const envelope = computeOperationToolpath(project, operation)
  assert(envelope !== null && envelope.result.moves.length > 0, 'fixture: the thread has a toolpath')
  const setup = setupForOperation(project, operation)
  assert(setup !== null, 'fixture: the operation names a setup')
  const input = buildSimulationSetupInput(project, setup, new Map([[operation.id, envelope.result]]))
  assert(input !== null, 'fixture: the Around setup yields a simulation input')
  const toolpath = input.toolpaths.get(operation.id)
  assert(toolpath !== undefined && toolpath.moves.length > 0, 'fixture: the setup frame keeps the path')
  const toolRecord = findOperationTool(input.project, operation)
  assert(toolRecord !== null, 'fixture: the operation resolves its tool')
  const tool = normalizeToolForProject(toolRecord, input.project)
  return {
    grid: createSimulationGrid(input.project, simulationBuildOptions(input, 140)),
    moves: toolpath.moves,
    tool: { toolType: toolRecord.type, toolRadius: tool.radius, vBitAngle: tool.vBitAngle },
    options: { maxSegmentLength: tool.radius * 2 },
  }
}

function testFrankFixture(): void {
  console.log('Testing Frank\'s #1048 thread at 2 % and 6 %...')
  const fixture = loadThreadFixture()
  const { grid, moves, tool, options } = fixture
  assert(Math.abs(grid.stockTopZ - 0.375) < 1e-12, `fixture: the round bar radius is ${grid.stockTopZ}`)
  assert(grid.wrap !== undefined, 'fixture: the fixture simulates on a wrapped sheet')
  for (const fraction of [0.02, 0.06]) {
    const oracle = batchReplayTruncated(grid, moves, fraction, tool)
    const playback = new PlaybackController(grid, moves, tool, options)
    // Play to the fraction the way the viewport does: a forward advance by the
    // path distance, not a seek (no feed reference, so distance is the budget).
    playback.advance(playback.totalPathLength * fraction)
    const delta = deviation(playback.liveGrid, oracle)
    // Symmetric, both directions: a disabled playback leaves the whole stock
    // untouched, which is a difference of the full cut depth.
    assert(
      delta.max <= grid.cellSize,
      `fixture @ ${fraction}: playback differs from the truncated replay by ${delta.max.toFixed(4)} `
      + `(> one cell height ${grid.cellSize.toFixed(4)}) at ${delta.cells} cell(s)`,
    )
    const playbackCut = removedCells(playback.liveGrid, grid)
    const oracleCut = removedCells(oracle, grid)
    assert(playbackCut > 0, `fixture @ ${fraction}: playback must remove material`)
    assert(oracleCut > 0, `fixture @ ${fraction}: the replay cut material to compare against`)
    console.log(
      `  fixture @ ${fraction}: ${playbackCut} playback cut cells (${oracleCut} in the replay), `
      + `max deviation ${delta.max.toExponential(2)}`,
    )
  }
  console.log('Frank\'s #1048 thread: PASSED')
}

testThread()
testTwistedLine()
testRing()
testAscendingRamp()
testFrankFixture()
