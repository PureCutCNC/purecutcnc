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
 * The wrapped simulation uses the cutter's true width (issue #1016 C2-F8).
 *
 * The kernel used to treat the unrolled sheet as flat milling: a cell at arc
 * length `u` from the tool line was `u` away. Physically the cutter points along
 * the pass ray, so a cell at radius `r` and angle `D = u / R0` is `r·sin D`
 * across the cutter and `r·cos D` along it. That is why the old sheet lowered
 * retained square corners by up to 0.92 mm (flat) at spots the cutter never
 * reaches, and why it under-removed round-bar groove walls cut below `R0`.
 *
 * ## What the tests bite
 *
 *  - **Per-cell parity against a dense physical oracle.** The oracle rebuilds
 *    the exact cutter solid (flat cylinder bottomed at the tip, ball nose plus
 *    shank, V-bit cone plus shank), samples *points along the ray* by bisection
 *    (no closed form shared with the kernel), and returns the new surface.
 *    Random moves on round and square grids, both bar axes, all three profiles.
 *  - **The ray middle.** A square corner cell beyond the cutter's radial exit
 *    must stay put: one radius per cell cannot represent the surviving shell.
 *    The old arc-length sheet lowered it.
 *  - **The ball shank.** A surface cell the nose cannot reach but the shank
 *    above the nose does must be cut.
 *  - **The 25 mm square-to-round case.** Zero cells lowered in the retained
 *    ends (both flat and ball), and the band still reaches the target.
 *  - **A round-bar groove.** The whole heightfield matches the oracle.
 *  - **Seam copies**, playback batch == subdivided, and reset.
 *
 * Mutations these assertions were checked against, each applied alone and
 * reverted: the arc-length mapping (`sin D` → `D`, and the pre-F8 flat kernel
 * that used `u` itself); lowering a cell the cutter passes through the middle
 * of; ignoring the ball shank; and the old fixed-radius search box, which
 * silently skipped cuttable cells once a groove went below the frame radius.
 *
 * Run with: npx tsx src/engine/simulation/wrappedCutterGeometry.test.ts
 */

import assert from 'node:assert/strict'
import { barCentre, barPivotZ, squareStock } from '../../types/barStock'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import type {
  BarStock, Operation, Project, SketchFeature, ToolType,
} from '../../types/project'
import { computeMeshBounds, serializeImportedMesh } from '../importedMesh'
import { cpuRatio } from '../../test/cpuRatio'
import { projectWithFeatures } from '../../test/projectFixtures'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import { buildSimulationSetupInput } from '../../app/simulationSetup'
import type { SimulationSetupInput } from '../../app/simulationSetup'
import { computeSimulationResult, simulationBuildOptions } from '../../app/simulationCompute'
import { generateRotaryOperation } from '../toolpaths/rotaryOperation'
import { rotaryAlongRange } from '../toolpaths/rotaryModel'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { resolveFinishModelSurface } from '../toolpaths/finishModelSurface'
import { createSimulationGrid } from './grid'
import { PlaybackController, cloneSimulationGrid } from './playback'
import { applyMoveToGrid, moveIsMaterialRemoving } from './replay'
import type { SimulationGrid } from './types'
import type { AroundFrame } from '../aroundFrame'
import type { ToolpathMove, ToolpathResult } from '../toolpaths/types'

// ── the physical oracle ──────────────────────────────────────────────
//
// Independent of `cutterRayInterval`: it tests a point against the cutter's
// real solid and walks the ray by bisection. Every profile is written from its
// geometry, not from a solved interval.

const SOLID_EPSILON = 1e-9

/** Is the point (radius `r`, `angle` from the tool line, `along` offset) in the cutter? */
function insideCutterSolid(
  toolType: ToolType,
  toolRadius: number,
  tipRadius: number,
  vBitAngle: number | null,
  alongOffset: number,
  angle: number,
  r: number,
): boolean {
  const radius = toolRadius
  const x = r * Math.cos(angle)
  const y = r * Math.sin(angle)
  const radialSq = y * y + alongOffset * alongOffset
  const radiusSq = radius * radius + SOLID_EPSILON

  if (toolType === 'flat_endmill' || toolType === 'drill') {
    return x >= tipRadius - SOLID_EPSILON && radialSq <= radiusSq
  }

  if (toolType === 'ball_endmill') {
    const centre = tipRadius + radius
    const inSphere = (x - centre) * (x - centre) + radialSq <= radiusSq
    const inShank = x >= centre - SOLID_EPSILON && radialSq <= radiusSq
    return inSphere || inShank
  }

  // v_bit
  const includedAngle = Math.max(1, Math.min(179, vBitAngle ?? 60))
  const slope = Math.tan((includedAngle * Math.PI) / 360)
  const coneHeight = x - tipRadius
  const inCone = coneHeight >= -SOLID_EPSILON
    && radialSq <= coneHeight * coneHeight * slope * slope + SOLID_EPSILON
    && coneHeight <= radius / slope + SOLID_EPSILON
  const inShank = coneHeight >= radius / slope - SOLID_EPSILON && radialSq <= radiusSq
  return inCone || inShank
}

/**
 * The new surface radius the cutter leaves on one ray: unchanged unless the
 * cutter's solid contains the current surface point (the "cutter reaches the
 * outside" rule a single-radius heightfield needs), otherwise the lower
 * boundary of the removed span, found by bisection against the exact solid.
 */
function oracleTop(
  toolType: ToolType,
  toolRadius: number,
  tipRadius: number,
  vBitAngle: number | null,
  alongOffset: number,
  angle: number,
  top: number,
  stockBottomZ: number,
): number {
  if (top <= stockBottomZ) return top
  const inside = (r: number): boolean =>
    insideCutterSolid(toolType, toolRadius, tipRadius, vBitAngle, alongOffset, angle, r)
  if (!inside(top)) return top
  // The ray's removed span is one interval whose lower end cannot be below the
  // cutter's tip; this bracket is strictly outside the solid.
  let outside = -Math.abs(tipRadius) - toolRadius - 1
  let bottom = top
  for (let i = 0; i < 60; i += 1) {
    const middle = (outside + bottom) / 2
    if (inside(middle)) bottom = middle
    else outside = middle
  }
  return Math.max(stockBottomZ, bottom)
}

/** Replay one move through the oracle, cell by cell. */
function oracleApplyMove(
  grid: SimulationGrid,
  topZ: Float32Array,
  move: ToolpathMove,
  toolRadius: number,
  toolType: ToolType,
  vBitAngle: number | null,
): void {
  const acrossIsX = grid.wrap!.axis === 'x'
  const frameRadius = grid.wrap!.period / (2 * Math.PI)
  const x0 = move.from.x
  const y0 = move.from.y
  const segDx = move.to.x - x0
  const segDy = move.to.y - y0
  const segDz = move.to.z - move.from.z
  const lengthSq = segDx * segDx + segDy * segDy
  const stationary = lengthSq <= 1e-12
  const stationaryZ = Math.min(move.from.z, move.to.z)

  for (let row = 0; row < grid.rows; row += 1) {
    const y = grid.originY + (row + 0.5) * grid.cellSize
    for (let col = 0; col < grid.cols; col += 1) {
      const x = grid.originX + (col + 0.5) * grid.cellSize
      let t = 0
      if (!stationary) {
        t = ((x - x0) * segDx + (y - y0) * segDy) / lengthSq
        if (t < 0) t = 0
        else if (t > 1) t = 1
      }
      const tip = stationary ? stationaryZ : move.from.z + segDz * t
      const alongCell = acrossIsX ? y : x
      const acrossCell = acrossIsX ? x : y
      const alongOffset = alongCell - (acrossIsX ? y0 + segDy * t : x0 + segDx * t)
      const angle = (acrossCell - (acrossIsX ? x0 + segDx * t : y0 + segDy * t)) / frameRadius
      const idx = row * grid.cols + col
      const next = oracleTop(toolType, toolRadius, tip, vBitAngle, alongOffset, angle, topZ[idx], grid.stockBottomZ)
      if (next < topZ[idx] - 1e-9) topZ[idx] = next
    }
  }
}

// ── fixtures ─────────────────────────────────────────────────────────

/** A round bar unrolled: one circumference across, `radius = period / 2π`. */
function roundGrid(period: number, alongLength: number, alongCells: number, axis: 'x' | 'y'): SimulationGrid {
  const radius = period / (2 * Math.PI)
  const cellSize = alongLength / alongCells
  const acrossCells = Math.round(period / cellSize)
  const acrossAxis = axis === 'x' ? 'y' : 'x'
  return {
    cols: axis === 'x' ? alongCells : acrossCells,
    rows: axis === 'x' ? acrossCells : alongCells,
    cellSize,
    originX: axis === 'x' ? 0 : -period / 2,
    originY: axis === 'x' ? -period / 2 : 0,
    stockBottomZ: 0,
    stockTopZ: radius,
    wrap: { axis: acrossAxis, period },
    topZ: new Float32Array(alongCells * acrossCells).fill(radius),
  }
}

/** The production square initialization: true cross section, nominal pivot. */
function squareGridFor(
  side: number,
  alongLength: number,
  alongCells: number,
  axis: 'x' | 'y',
): { grid: SimulationGrid; frame: AroundFrame } {
  const circumference = Math.PI * side
  const radius = side / 2
  const frame: AroundFrame = {
    axis,
    centre: 0,
    radius,
    zero: 0,
    sheetStart: -circumference / 2,
    circumference,
  }
  const xMin = axis === 'x' ? 0 : -circumference / 2
  const xMax = axis === 'x' ? alongLength : circumference / 2
  const yMin = axis === 'x' ? -circumference / 2 : 0
  const yMax = axis === 'x' ? circumference / 2 : alongLength
  const project = newProject('wrapped', 'mm')
  project.stock = { ...project.stock, profile: rectProfile(xMin, yMin, xMax - xMin, yMax - yMin), thickness: radius }
  const targetLongAxisCells = Math.max(alongCells, Math.round(circumference / (alongLength / alongCells)))
  const grid = createSimulationGrid(project, {
    squareBar: { side, frame },
    targetLongAxisCells,
    wrap: { axis: axis === 'x' ? 'y' : 'x', period: circumference },
  })
  return { grid, frame }
}

function gridDistance(a: SimulationGrid, b: SimulationGrid): { max: number; cells: number } {
  let max = 0
  let cells = 0
  for (let i = 0; i < a.topZ.length; i += 1) {
    const delta = Math.abs(a.topZ[i] - b.topZ[i])
    if (delta > 1e-9) cells += 1
    if (delta > max) max = delta
  }
  return { max, cells }
}

/** Assert every cell of `actual` matches the oracle's replay of the same moves. */
function assertMatchesOracle(
  base: SimulationGrid,
  moves: readonly ToolpathMove[],
  toolRadius: number,
  toolType: ToolType,
  vBitAngle: number | null,
  label: string,
): number {
  const actual = cloneSimulationGrid(base)
  const expected = new Float32Array(base.topZ)
  for (const move of moves) {
    applyMoveToGrid(actual, move, toolRadius, toolType, vBitAngle)
    oracleApplyMove(base, expected, move, toolRadius, toolType, vBitAngle)
  }
  let worst = 0
  let worstCell = -1
  for (let i = 0; i < expected.length; i += 1) {
    const delta = Math.abs(actual.topZ[i] - expected[i])
    if (delta > worst) {
      worst = delta
      worstCell = i
    }
  }
  const scale = Math.max(1, base.stockTopZ)
  assert(
    worst <= 1e-5 * scale,
    `${label}: kernel must match the dense oracle (max ${worst} at cell ${worstCell}: `
    + `${actual.topZ[worstCell]} vs ${expected[worstCell]})`,
  )
  return worst
}

/** A reproducible LCG, so a failing case is reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Random interior cuts. They stay `clearance` away from the sheet's across edges
 * so no seam copy is in play and the oracle is the one move.
 */
function randomMoves(
  random: () => number,
  count: number,
  alongMin: number,
  alongMax: number,
  acrossSpan: number,
  clearance: number,
  tipMin: number,
  tipMax: number,
): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  const acrossHalf = acrossSpan / 2 - clearance
  for (let i = 0; i < count; i += 1) {
    const alongFrom = alongMin + random() * (alongMax - alongMin) * 0.8
    const alongTo = alongFrom + (random() - 0.5) * (alongMax - alongMin) * 0.3
    const acrossFrom = (random() - 0.5) * 2 * acrossHalf
    const acrossTo = acrossFrom + (random() - 0.5) * 2 * acrossHalf * 0.3
    const z = tipMin + random() * (tipMax - tipMin)
    moves.push({
      kind: 'cut',
      from: { x: alongFrom, y: acrossFrom, z },
      to: { x: alongTo, y: acrossTo, z: z - random() * 0.5 },
    })
  }
  return moves
}

/** Swap the along/across axes of a move for a `'y'` bar, whose grid is transposed. */
function onAxis(move: ToolpathMove, axis: 'x' | 'y'): ToolpathMove {
  if (axis === 'x') return move
  return {
    ...move,
    from: { x: move.from.y, y: move.from.x, z: move.from.z },
    to: { x: move.to.y, y: move.to.x, z: move.to.z },
  }
}

// ── 1. random moves against the dense oracle ─────────────────────────

interface Profile {
  toolType: ToolType
  toolRadius: number
  vBitAngle: number | null
}

const PROFILES: Profile[] = [
  { toolType: 'flat_endmill', toolRadius: 1.6, vBitAngle: null },
  { toolType: 'ball_endmill', toolRadius: 2, vBitAngle: null },
  { toolType: 'v_bit', toolRadius: 1.5, vBitAngle: 90 },
]

const ROUND_RADIUS = 5
const ROUND_PERIOD = 2 * Math.PI * ROUND_RADIUS
const ALONG_LENGTH = 12
const ALONG_CELLS = 30
const SQUARE_SIDE = 10

function testRandomMovesMatchTheOracle(): void {
  console.log('Testing random wrapped moves against the dense physical oracle...')
  let cases = 0
  let worst = 0
  for (const axis of ['x', 'y'] as const) {
    for (const profile of PROFILES) {
      const random = seeded(0x1016f8 + axis.charCodeAt(0) * 7 + profile.toolRadius * 13)
      const moves = randomMoves(random, 6, 1, ALONG_LENGTH - 1, ROUND_PERIOD, 2 * profile.toolRadius + 2, 1.2, 4.2)
        .map((move) => onAxis(move, axis))
      const round = roundGrid(ROUND_PERIOD, ALONG_LENGTH, ALONG_CELLS, axis)
      const before = new Float32Array(round.topZ)
      const measured = assertMatchesOracle(
        round, moves, profile.toolRadius, profile.toolType, profile.vBitAngle, `round/${axis}/${profile.toolType}`,
      )
      // Fixture sanity: the moves really remove material, so the parity is not
      // a comparison of two untouched grids.
      const cut = cloneSimulationGrid(round)
      for (const move of moves) applyMoveToGrid(cut, move, profile.toolRadius, profile.toolType, profile.vBitAngle)
      let removed = 0
      for (let i = 0; i < before.length; i += 1) if (cut.topZ[i] < before[i] - 1e-9) removed += 1
      assert(removed > 20, `round/${axis}/${profile.toolType}: fixture must cut, got ${removed} cells`)

      const { grid: square } = squareGridFor(SQUARE_SIDE, ALONG_LENGTH, ALONG_CELLS, axis)
      const squareWorst = assertMatchesOracle(
        square, moves, profile.toolRadius, profile.toolType, profile.vBitAngle, `square/${axis}/${profile.toolType}`,
      )
      cases += 2
      worst = Math.max(worst, measured, squareWorst)
    }
  }
  console.log(`random oracle parity: PASSED (${cases} grids, max delta ${worst.toExponential(2)})`)
}

// ── 2. the ray middle keeps the outer shell ──────────────────────────

function cellAt(grid: SimulationGrid, frame: AroundFrame, along: number, angleDeg: number): number {
  const acrossOrigin = frame.axis === 'x' ? grid.originY : grid.originX
  const acrossCount = frame.axis === 'x' ? grid.rows : grid.cols
  const acrossTarget = frame.zero + (angleDeg * frame.circumference) / 360
  const acrossIndex = Math.max(0, Math.min(acrossCount - 1, Math.round((acrossTarget - acrossOrigin) / grid.cellSize - 0.5)))
  const alongOrigin = frame.axis === 'x' ? grid.originX : grid.originY
  const alongCount = frame.axis === 'x' ? grid.cols : grid.rows
  const alongIndex = Math.max(0, Math.min(alongCount - 1, Math.round((along - alongOrigin) / grid.cellSize - 0.5)))
  return frame.axis === 'x' ? acrossIndex * grid.cols + alongIndex : alongIndex * grid.cols + acrossIndex
}

function cellCentre(grid: SimulationGrid, index: number): { x: number; y: number } {
  const col = index % grid.cols
  const row = Math.floor(index / grid.cols)
  return { x: grid.originX + (col + 0.5) * grid.cellSize, y: grid.originY + (row + 0.5) * grid.cellSize }
}

function testRayMiddleKeepsTheOuterShell(): void {
  console.log('Testing a cutter through the middle of a ray leaves the outer shell...')
  const { grid, frame } = squareGridFor(SQUARE_SIDE, ALONG_LENGTH, ALONG_CELLS, 'x')
  // The corner cell stands at side·√½ = 7.071, well above the nominal radius 5.
  const cornerIndex = cellAt(grid, frame, ALONG_LENGTH / 2, 45)
  const baseline = grid.topZ[cornerIndex]
  assert(baseline > 6.9, `fixture: the corner cell stands at ${baseline}`)
  const corner = cellCentre(grid, cornerIndex)

  // Tool 0.9 mm across from the corner cell: inside the cutter's unrolled
  // footprint (radius 1), but the corner's own radius puts its surface outside
  // the cutter's radial exit (1 / sin(0.9 / 5) = 5.58 < 7.071).
  const radius = 1
  const move: ToolpathMove = {
    kind: 'plunge',
    from: { x: corner.x, y: corner.y - 0.9, z: 5 },
    to: { x: corner.x, y: corner.y - 0.9, z: 4 },
  }
  const result = applyMoveToGrid(grid, move, radius, 'flat_endmill', null)
  assert(result.changedCount > 0, 'the plunge must cut somewhere, so the corner test is not vacuous')
  assert(
    grid.topZ[cornerIndex] === baseline,
    `the corner cell is beyond the cutter's radial exit and must not move (${grid.topZ[cornerIndex]} vs ${baseline})`,
  )
  // The old arc-length sheet measured `u = 0.9 < 1` and lowered the corner to
  // its tip; the exact solid does not reach it.
  assert(baseline > 4, 'fixture: the old sheet would have lowered this cell')

  // And the oracle agrees: the surface point is outside the solid.
  const topZ = new Float32Array([baseline])
  const single: SimulationGrid = {
    ...grid,
    cols: 1,
    rows: 1,
    originX: corner.x - grid.cellSize / 2,
    originY: corner.y - grid.cellSize / 2,
    topZ,
  }
  oracleApplyMove(single, topZ, move, radius, 'flat_endmill', null)
  assert(topZ[0] === baseline, `the oracle also leaves the corner (${topZ[0]})`)
  console.log(`ray middle: PASSED (corner ${baseline.toFixed(4)} kept; cutter exit ${(1 / Math.sin(0.9 / 5)).toFixed(4)})`)
}

// ── 3. the ball shank ────────────────────────────────────────────────

function testBallShank(): void {
  console.log('Testing the ball shank reaches a surface the nose cannot...')
  const grid = roundGrid(ROUND_PERIOD, ALONG_LENGTH, ALONG_CELLS, 'x')
  const radius = 1
  const tip = 0.5
  const angle = 0.1
  // Any surface cell; put the tool 0.5 mm (at R0 = 5, an angle of 0.1 rad) away.
  const cellAlong = ALONG_LENGTH / 2
  const cell = cellAt(grid, { axis: 'x', centre: 0, radius: ROUND_RADIUS, zero: 0, sheetStart: -ROUND_PERIOD / 2, circumference: ROUND_PERIOD }, cellAlong, 0)
  const centre = cellCentre(grid, cell)
  const toolX = centre.x
  const toolY = centre.y - angle * ROUND_RADIUS
  const move: ToolpathMove = { kind: 'cut', from: { x: toolX, y: toolY, z: tip }, to: { x: toolX, y: toolY, z: tip } }
  const before = grid.topZ[cell]
  assert(Math.abs(before - ROUND_RADIUS) < 1e-4, 'fixture: the probe cell starts on the round surface')

  // The nose alone ends at (tip + rt)·cos + sqrt(rt² - (tip+rt)²sin²) = 2.481;
  // the surface at 5 is beyond it, so without the shank this cell would be left
  // alone (the "cutter passed through the middle" rule). The shank is a
  // cylinder of radius rt above the centre, so the ray passes through it and
  // the union reaches the surface: the cut floor is the nose's lower boundary.
  const centreRadius = tip + radius
  const sphereExit = centreRadius * Math.cos(angle)
    + Math.sqrt(radius * radius - centreRadius * centreRadius * Math.sin(angle) * Math.sin(angle))
  const sphereEntry = centreRadius * Math.cos(angle)
    - Math.sqrt(radius * radius - centreRadius * centreRadius * Math.sin(angle) * Math.sin(angle))
  assert(sphereExit < before - 1, `fixture: the nose's exit ${sphereExit} is below the surface ${before}`)
  applyMoveToGrid(grid, move, radius, 'ball_endmill', null)
  assert(
    Math.abs(grid.topZ[cell] - sphereEntry) < 1e-4,
    `the shank must carry the ray through the surface, to ${sphereEntry}, got ${grid.topZ[cell]}`,
  )
  const topZ = new Float32Array([before])
  oracleApplyMove({
    ...grid, cols: 1, rows: 1,
    originX: centre.x - grid.cellSize / 2, originY: centre.y - grid.cellSize / 2,
    topZ,
  }, topZ, move, radius, 'ball_endmill', null)
  assert(Math.abs(topZ[0] - sphereEntry) < 1e-4, `the oracle agrees on the shank cut (${topZ[0]})`)
  console.log(`ball shank: PASSED (surface ${before} -> ${grid.topZ[cell].toFixed(6)}; nose exit ${sphereExit.toFixed(4)})`)
}


/**
 * A V-bit whose tip is below the turning pivot: the cone is entirely below the
 * bar's centre and only its shank (the cylinder of the cutter radius above the
 * truncation) can reach the material.
 */
function testDeepVBitShank(): void {
  console.log('Testing a V-bit whose cone sits below the pivot cuts through its shank...')
  const grid = roundGrid(ROUND_PERIOD, ALONG_LENGTH, ALONG_CELLS, 'x')
  const toolRadius = 2
  const tip = -5
  assert(tip < -toolRadius / Math.tan((60 * Math.PI) / 360), 'fixture: the truncation is below the pivot')
  const move: ToolpathMove = {
    kind: 'plunge',
    from: { x: ALONG_LENGTH / 2, y: 0, z: tip + 1 },
    to: { x: ALONG_LENGTH / 2, y: 0, z: tip },
  }
  const worst = assertMatchesOracle(grid, [move], toolRadius, 'v_bit', 60, 'deep v-bit shank')
  const cut = cloneSimulationGrid(grid)
  applyMoveToGrid(cut, move, toolRadius, 'v_bit', 60)
  let cleared = 0
  for (let i = 0; i < cut.topZ.length; i += 1) if (cut.topZ[i] < 1e-6) cleared += 1
  assert(cleared > 0, 'the deep V-bit shank must clear material to the pivot')
  console.log(`deep v-bit shank: PASSED (${cleared} cells cleared, max delta ${worst.toExponential(2)})`)
}

/**
 * A ball whose nose sits below the pivot: the sphere is entirely under the bar
 * and only the shank (a cylinder of the cutter radius above the sphere centre)
 * reaches material. This also exercises the ball entry-radius skip's guard: the
 * cheap lower bound is only valid for a tip above the pivot.
 */
function testDeepBallShank(): void {
  console.log('Testing a ball whose nose sits below the pivot cuts through its shank...')
  const grid = roundGrid(ROUND_PERIOD, ALONG_LENGTH, ALONG_CELLS, 'x')
  const toolRadius = 1.5
  const tip = -4
  const move: ToolpathMove = {
    kind: 'plunge',
    from: { x: ALONG_LENGTH / 2, y: 0, z: tip + 1 },
    to: { x: ALONG_LENGTH / 2, y: 0, z: tip },
  }
  const worst = assertMatchesOracle(grid, [move], toolRadius, 'ball_endmill', null, 'deep ball shank')
  const cut = cloneSimulationGrid(grid)
  applyMoveToGrid(cut, move, toolRadius, 'ball_endmill', null)
  let cleared = 0
  for (let i = 0; i < cut.topZ.length; i += 1) if (cut.topZ[i] < 1e-6) cleared += 1
  assert(cleared > 0, 'the deep ball shank must clear material to the pivot')
  console.log(`deep ball shank: PASSED (${cleared} cells cleared, max delta ${worst.toExponential(2)})`)
}

// ── 4. the 25 mm square-to-round case ────────────────────────────────
//
// The measured case: a 25 mm square blank (default chuck), a Ø20 × 30 mm target
// from x = 10 to 40 with a 6 mm cutter at a 0.4 stepover. The chuck limits the
// cut to x = 18..40, so the retained lower stub is x < 18. The old flat-sheet
// kernel lowered 626 retained-end cells (up to 0.985 mm, flat) and 249 (0.773 mm,
// ball) where the real cutter never reaches the corner material.

const STUB_SIDE = 25
const STUB_LENGTH = 100
const STUB_TARGET_RADIUS = 10

function coaxialCylinder(stock: BarStock, radius: number, from: number, to: number, segments = 192): {
  positions: Float32Array
  index: Uint32Array
} {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const along of [from, to]) {
    for (let i = 0; i < segments; i += 1) {
      const t = (2 * Math.PI * i) / segments
      positions.push(along, centre + radius * Math.cos(t), pivot + radius * Math.sin(t))
    }
  }
  for (let i = 0; i < segments; i += 1) {
    const j = (i + 1) % segments
    index.push(i, j, segments + j, i, segments + j, segments + i)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

function modelAlongExtent(project: Project, model: SketchFeature): { min: number; max: number } {
  const surface = resolveFinishModelSurface(project, [model])
  assert(surface, 'fixture: the stub model resolves')
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < surface.mesh.positions.length; i += 3) {
    min = Math.min(min, surface.mesh.positions[i])
    max = Math.max(max, surface.mesh.positions[i])
  }
  return { min, max }
}

interface StubFixture {
  project: Project
  operation: Operation
  tool: ReturnType<typeof normalizeToolForProject>
  moves: ToolpathMove[]
  along: { start: number; end: number }
  simulation: ReturnType<typeof computeSimulationResult>
  /** The setup's exact replay input, so the timing test can rebuild its grid and moves. */
  setupInput: SimulationSetupInput
  /** Re-runs the same fixture's simulation (used by the retained-end checks). */
  runSimulation: () => ReturnType<typeof computeSimulationResult>
  /** Time spent building and replaying the simulation grid, milliseconds. */
  simulationMs: number
}

/** The production path and simulation for one stub fixture. */
function stubFixture(toolType: ToolType, detailCells: number): StubFixture {
  const stock = squareStock(STUB_SIDE, STUB_LENGTH, 'x')
  const base = newProject('wrapped stub', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 25
  base.stock = stock
  base.tools = [{
    ...defaultTool('mm', 1),
    id: 't1',
    type: toolType,
    diameter: 6,
    defaultStepover: 0.4,
    defaultStepdown: 1,
  }]
  const mesh = coaxialCylinder(stock, STUB_TARGET_RADIUS, 10, 40)
  base.modelAssets = {
    asset: serializeImportedMesh(
      { positions: mesh.positions, index: mesh.index, bounds: computeMeshBounds(mesh.positions) },
      'stl',
    ),
  }
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const model: SketchFeature = {
    id: 'model', name: 'Model', kind: 'stl', operation: 'model', authoringFace: 'top', folderId: null,
    sketch: {
      profile: rectProfile(10, centre - STUB_TARGET_RADIUS, 30, 2 * STUB_TARGET_RADIUS),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    stl: { format: 'stl', meshAssetId: 'asset', scale: 1, axisSwap: 'none' },
    z_top: pivot + STUB_TARGET_RADIUS, z_bottom: pivot - STUB_TARGET_RADIUS,
    visible: true, locked: false,
  }
  const around: SketchFeature = {
    ...model, id: 'sketch', name: 'Sketch', kind: 'rect', operation: 'subtract', stl: null,
    authoringFace: 'around', z_top: pivot + STUB_SIDE / 2, z_bottom: pivot - STUB_SIDE / 2,
  }
  const project = projectWithFeatures(base, [model, around])
  project.setups.push({
    ...project.setups[0], id: 'around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 },
  })
  project.activeSetupId = 'around'
  project.clamps = [{ ...defaultRoundWorkholding('chuck', stock, 'mm'), id: 'chuck', name: 'Chuck', visible: true }]
  const operation: Operation = {
    ...defaultOperationForTarget(
      project, 'rotary_finish', 'finish', { source: 'features', featureIds: ['model'] }, 0,
    ),
    setupId: 'around',
    stockToLeaveRadial: 0,
    stepover: 0.4,
    stepdown: 2,
  }
  project.operations = [operation]
  const tool = normalizeToolForProject(project.tools[0], project)
  const along = rotaryAlongRange(
    stock, project.clamps, modelAlongExtent(project, model), tool, { chuckEnd: 0, tailEnd: 0 },
  )
  assert(along, 'fixture: the stub case has room between its supports')
  const toolpath: ToolpathResult = generateRotaryOperation(project, operation)
  assert(toolpath.moves.length > 0, 'fixture: the stub program cuts')
  assert.deepEqual(toolpath.warnings, [], 'fixture: the stub program generates without a warning')
  const setup = project.setups.find((entry) => entry.id === 'around')
  assert(setup, 'fixture: the Around setup exists')
  const paths = new Map([[operation.id, toolpath]])
  const setupInput = buildSimulationSetupInput(project, setup, paths)
  assert(setupInput, 'fixture: the Around setup yields a simulation input')
  const runSimulation = (): ReturnType<typeof computeSimulationResult> => computeSimulationResult({
    setupInput,
    project,
    simulationMode: 'visible',
    simulationDetailCells: detailCells,
    selectedInSetup: null,
    paths,
  })
  const started = performance.now()
  const simulation = runSimulation()
  const simulationMs = performance.now() - started
  return {
    project, operation, tool, moves: toolpath.moves, along, simulation, setupInput, runSimulation, simulationMs,
  }
}

function testSquareToRoundRetainedEnds(): void {
  console.log('Testing the 25 mm square-to-round retained ends (flat and ball)...')
  const detail = 280
  for (const toolType of ['flat_endmill', 'ball_endmill'] as const) {
    const fixture = stubFixture(toolType, detail)
    const grid = fixture.simulation.grid
    const baseline = grid.initialTopZ!
    assert(baseline, 'fixture: a square grid carries its baseline')
    const cellSize = grid.cellSize

    let retainedCells = 0
    let retainedLowered = 0
    let worstRetainedDrop = 0
    let bandCells = 0
    let worstBandTop = -Infinity
    const bandStart = fixture.along.start + fixture.tool.radius
    const bandEnd = fixture.along.end - fixture.tool.radius
    for (let row = 0; row < grid.rows; row += 1) {
      for (let col = 0; col < grid.cols; col += 1) {
        const along = grid.originX + (col + 0.5) * cellSize
        const index = row * grid.cols + col
        const top = grid.topZ[index]
        if (along < fixture.along.start - 1e-9) {
          retainedCells += 1
          const drop = baseline[index] - top
          if (drop > 1e-9) {
            retainedLowered += 1
            if (drop > worstRetainedDrop) worstRetainedDrop = drop
          }
        } else if (along >= bandStart && along <= bandEnd) {
          bandCells += 1
          if (top > worstBandTop) worstBandTop = top
        }
      }
    }
    // The fixture's chuck limits the cut to x = 18, so "retained" means the
    // stub below it; the fixture assertion keeps that meaning from drifting.
    assert(Math.abs(fixture.along.start - 18) < 1e-6, `${toolType}: fixture cut starts at x = 18`)
    assert(retainedCells > 0, `${toolType}: fixture has retained end cells`)
    assert(
      retainedLowered === 0,
      `${toolType}: no retained-end cell may be lowered (${retainedLowered} cells, worst ${worstRetainedDrop})`,
    )
    assert(bandCells > 0, `${toolType}: fixture has band cells`)
    // The band still reaches the target: not F8's rule, but a guard that the
    // exact solid did not stop removing material where the cutter does reach.
    assert(
      worstBandTop <= STUB_TARGET_RADIUS + 0.3,
      `${toolType}: the band reaches the target (worst ${worstBandTop} vs ${STUB_TARGET_RADIUS + 0.3})`,
    )
    console.log(
      `  ${toolType}: ${retainedCells} retained cells, 0 lowered; band worst ${worstBandTop.toFixed(4)} `
      + `(${detail} detail, ${fixture.moves.length} moves, ${fixture.simulationMs.toFixed(1)} ms)`,
    )
  }
}

// ── 5. a round-bar groove ────────────────────────────────────────────

function testRoundGrooveMatchesOracle(): void {
  console.log('Testing a round-bar groove matches the dense oracle through its walls...')
  const grid = roundGrid(ROUND_PERIOD, ALONG_LENGTH, ALONG_CELLS, 'x')
  const toolRadius = 1.5
  const grooveRadius = 3
  const moves: ToolpathMove[] = []
  for (let along = 4; along <= 8 + 1e-9; along += 0.25) {
    moves.push({
      kind: 'cut',
      from: { x: along, y: -(Math.PI / 2) * ROUND_RADIUS, z: grooveRadius },
      to: { x: along, y: (Math.PI / 2) * ROUND_RADIUS, z: grooveRadius },
    })
  }
  const worst = assertMatchesOracle(grid, moves, toolRadius, 'flat_endmill', null, 'round groove')
  const cut = cloneSimulationGrid(grid)
  for (const move of moves) applyMoveToGrid(cut, move, toolRadius, 'flat_endmill', null)
  // The groove walls are the cells between the nominal surface and the floor.
  let wallCells = 0
  for (let i = 0; i < cut.topZ.length; i += 1) {
    const top = cut.topZ[i]
    if (top > grooveRadius + 1e-6 && top < ROUND_RADIUS - 1e-6) wallCells += 1
  }
  assert(wallCells > 20, `fixture: the groove has walls to compare (${wallCells} cells)`)
  console.log(`round groove: PASSED (${moves.length} passes, ${wallCells} wall cells, max delta ${worst.toExponential(2)})`)
}

// ── 6. playback batch == subdivided, and reset ───────────────────────

function playbackMoves(): ToolpathMove[] {
  return [
    { kind: 'plunge', from: { x: 3, y: 0, z: 6 }, to: { x: 3, y: 0, z: 3 } },
    { kind: 'cut', from: { x: 3, y: 0, z: 3 }, to: { x: 9, y: 1.5, z: 3 } },
    { kind: 'cut', from: { x: 9, y: -2, z: 3.5 }, to: { x: 2, y: 2.5, z: 4 } },
  ]
}

function testPlaybackParityAndReset(): void {
  console.log('Testing wrapped playback batch == subdivided and reset...')
  const tool = { toolType: 'flat_endmill' as const, toolRadius: 1.5, vBitAngle: null }
  const fixtures: Array<{ label: string; grid: SimulationGrid; moves: ToolpathMove[] }> = [
    { label: 'round', grid: roundGrid(ROUND_PERIOD, ALONG_LENGTH, ALONG_CELLS, 'x'), moves: playbackMoves() },
    {
      label: 'square',
      grid: squareGridFor(SQUARE_SIDE, ALONG_LENGTH, ALONG_CELLS, 'x').grid,
      moves: playbackMoves(),
    },
  ]
  for (const { label, grid, moves } of fixtures) {
    const batch = cloneSimulationGrid(grid)
    for (const move of moves) applyMoveToGrid(batch, move, tool.toolRadius, tool.toolType, null)

    const stepped = new PlaybackController(grid, moves, tool, { maxSegmentLength: 1 })
    assert(stepped.getMoveCount() > moves.length, `${label}: fixture must actually subdivide the moves`)
    stepped.seekToFraction(1)
    const whole = gridDistance(stepped.liveGrid, batch)
    assert(whole.max === 0, `${label}: subdivided playback must match the batch exactly (max ${whole.max})`)

    const chained = new PlaybackController(grid, moves, tool, { maxSegmentLength: 1 })
    chained.seekToFraction(0.37)
    chained.seekToFraction(1)
    const seeked = gridDistance(chained.liveGrid, batch)
    assert(seeked.max === 0, `${label}: a partial seek then a full replay must match the batch (max ${seeked.max})`)

    chained.reset()
    const reset = gridDistance(chained.liveGrid, grid)
    assert(reset.max === 0, `${label}: reset must restore the base grid exactly (max ${reset.max})`)
    console.log(`  ${label}: ${stepped.getMoveCount()} pieces, exact batch/seek/reset`)
  }
  console.log('wrapped playback parity: PASSED')
}

// ── 7. seam copies ───────────────────────────────────────────────────

function shiftedAcross(move: ToolpathMove, axis: 'x' | 'y', shift: number): ToolpathMove {
  const acrossAxis = axis === 'x' ? 'y' : 'x'
  return {
    ...move,
    from: { ...move.from, [acrossAxis]: move.from[acrossAxis] + shift },
    to: { ...move.to, [acrossAxis]: move.to[acrossAxis] + shift },
  }
}

function testSeamCopies(): void {
  console.log('Testing wrapped seam copies are exact under the true cutter...')
  let worst = 0
  for (const axis of ['x', 'y'] as const) {
    for (const profile of PROFILES) {
      const period = axis === 'x' ? ROUND_PERIOD : 2 * Math.PI * ROUND_RADIUS
      const low = -period / 2
      for (const across of [low + 0.4, low - 0.4]) {
        const move = onAxis({
          kind: 'cut',
          from: { x: 6, y: across, z: 2.2 },
          to: { x: 7, y: across, z: 2.2 },
        }, axis)
        const a = roundGrid(period, ALONG_LENGTH, ALONG_CELLS, axis)
        const b = roundGrid(period, ALONG_LENGTH, ALONG_CELLS, axis)
        applyMoveToGrid(a, move, profile.toolRadius, profile.toolType, profile.vBitAngle)
        applyMoveToGrid(
          b,
          shiftedAcross(move, axis, period),
          profile.toolRadius,
          profile.toolType,
          profile.vBitAngle,
        )
        const delta = gridDistance(a, b)
        worst = Math.max(worst, delta.max)
        assert(
          delta.max === 0,
          `${axis}/${profile.toolType}/${across < low ? 'outside' : 'inside'}: a seam copy must be a pure `
          + `translation (max delta ${delta.max} at ${delta.cells} cells)`,
        )
      }
    }
  }
  console.log(`seam copies: PASSED (max delta ${worst})`)
}

// ── 8. finished playback at an overlapping seam (F8b repro 1) ────────

/**
 * The reviewer's case: a wrapped move whose own across span crosses the whole
 * sheet, so its periodic images overlap the same cells. The batch used to apply
 * every original cell first and every shifted copy afterwards, while playback
 * applied them per piece; the two orders left two cells 0.30558 mm apart.
 */
function testFinishedPlaybackMatchesBatchAtSeamOverlap(): void {
  console.log('Testing finished playback == batch where seam copies overlap...')
  const grid = roundGrid(ROUND_PERIOD, 18, 30, 'x')
  assert(Math.abs(grid.cellSize - 0.6) < 1e-12, `fixture: cell ${grid.cellSize}`)
  const move: ToolpathMove = {
    kind: 'cut',
    from: { x: 5.6, y: -15.35, z: 2.34 },
    to: { x: 7.2, y: 13.84, z: 2.72 },
  }
  const tool = { toolType: 'flat_endmill' as const, toolRadius: 3.3, vBitAngle: null }
  const batch = cloneSimulationGrid(grid)
  applyMoveToGrid(batch, move, tool.toolRadius, tool.toolType, tool.vBitAngle)

  // The cell the reviewer reported: x = 8.7, y = 14.592036…, batch 2.44548.
  const col = Math.round((8.7 - grid.originX) / grid.cellSize - 0.5)
  const row = Math.round((14.592036732051032 - grid.originY) / grid.cellSize - 0.5)
  const idx = row * grid.cols + col
  assert(
    Math.abs(batch.topZ[idx] - 2.445481777191162) < 1e-4,
    `fixture: the batch cell is at ${batch.topZ[idx]} (expected ~2.44548)`,
  )

  const cases: Array<[string, { maxSegmentLength?: number }]> = [
    ['default', {}],
    ['fine', { maxSegmentLength: 0.1 }],
    ['whole', { maxSegmentLength: 0 }],
  ]
  for (const [label, options] of cases) {
    const playback = new PlaybackController(grid, [move], tool, options)
    playback.seekToFraction(1)
    const finished = gridDistance(playback.liveGrid, batch)
    assert(
      finished.max === 0,
      `${label}: finished playback must equal the batch exactly (max ${finished.max} at ${finished.cells} cells; `
      + `batch ${batch.topZ[idx]} vs playback ${playback.liveGrid.topZ[idx]})`,
    )
    assert(playback.liveGrid.topZ[idx] === batch.topZ[idx], `${label}: the reported cell must agree`)

    const chained = new PlaybackController(grid, [move], tool, options)
    chained.seekToFraction(0.37)
    chained.seekToFraction(1)
    const partial = gridDistance(chained.liveGrid, batch)
    assert(partial.max === 0, `${label}: a partial seek then a full replay must equal the batch (max ${partial.max})`)
  }
  console.log(`seam-overlap playback: PASSED (${batch.topZ[idx]} everywhere, 3 subdivisions)`)
}

// ── 9. partial playback clips the elapsed footprint (F8b repro 2) ────

/** A wrapped test grid with an explicit origin, so a cell centre can sit at 0. */
function explicitWrappedGrid(
  period: number, cols: number, rows: number, cellSize: number,
  originX: number, originY: number, stockTopZ: number,
): SimulationGrid {
  return {
    cols,
    rows,
    cellSize,
    originX,
    originY,
    stockBottomZ: 0,
    stockTopZ,
    wrap: { axis: 'y', period },
    topZ: new Float32Array(cols * rows).fill(stockTopZ),
  }
}

/**
 * The reviewer's second case: the cutter reaches a cell before that cell's
 * projected parent parameter. At X = 4.5 the r = 1 cutter already contains the
 * cell centred at (5, 0) (it is 0.5 mm away), so it must be at 2 there; a cell
 * at (7, 0) is still 2.5 mm ahead and must stay at the stock radius.
 */
function testPartialPlaybackClipsElapsedFootprint(): void {
  console.log('Testing partial playback cuts only the elapsed footprint...')
  const cellSize = 0.5
  const grid = explicitWrappedGrid(ROUND_PERIOD, 30, 63, cellSize, -0.25, -15.75, ROUND_RADIUS)
  const targetIdx = 31 * 30 + 10
  const aheadIdx = 31 * 30 + 14
  assert(Math.abs(grid.originX + 10.5 * cellSize - 5) < 1e-12, 'fixture: the target cell is centred at x = 5')
  assert(Math.abs(grid.originY + 31.5 * cellSize) < 1e-12, 'fixture: the target cell is centred at y = 0')

  const move: ToolpathMove = { kind: 'cut', from: { x: 0, y: 0, z: 2 }, to: { x: 10, y: 0, z: 2 } }
  const tool = { toolType: 'flat_endmill' as const, toolRadius: 1, vBitAngle: null }
  const batch = cloneSimulationGrid(grid)
  applyMoveToGrid(batch, move, tool.toolRadius, tool.toolType, tool.vBitAngle)
  assert(Math.abs(batch.topZ[targetIdx] - 2) < 1e-6, `fixture: the batch cuts the target to ${batch.topZ[targetIdx]}`)
  assert(Math.abs(batch.topZ[aheadIdx] - 2) < 1e-6, `fixture: the batch cuts the ahead cell to ${batch.topZ[aheadIdx]}`)

  const playback = new PlaybackController(grid, [move], tool)
  playback.advance(4.5)
  assert(Math.abs(playback.getPose().x - 4.5) < 1e-9, `fixture: the cutter is at ${playback.getPose().x}`)
  assert(
    Math.abs(playback.liveGrid.topZ[targetIdx] - 2) < 1e-6,
    `the elapsed footprint must cut the cell at (5, 0) to 2, got ${playback.liveGrid.topZ[targetIdx]}`,
  )
  assert(
    playback.liveGrid.topZ[aheadIdx] === ROUND_RADIUS,
    `a cell beyond the elapsed footprint must not be cut yet, got ${playback.liveGrid.topZ[aheadIdx]}`,
  )

  playback.advance(1e9)
  const finished = gridDistance(playback.liveGrid, batch)
  assert(finished.max === 0, `finishing the move must equal the batch (max ${finished.max})`)
  console.log('elapsed footprint: PASSED (cell at (5,0) is 2 at X = 4.5; (7,0) still 5)')
}

// ── 10. wrapped ball replay timing (F8b fix 3) ───────────────────────
//
// Ratio against an invariant reference, never an absolute budget. The subject
// is the wrapped ball replay of the 25 mm square-to-round program: the exact
// moves the simulator applies, on the grid `computeSimulationResult` builds,
// with the grid reset from the pristine baseline between runs. The reference
// does the same replay on the same moves and grid through the flat, non-wrapped
// kernel, which never enters the wrapped across box — so only the wrapped
// kernel's own search box can move the ratio. Both details land on the same
// baseline ratio (2.4–2.7), so this measures the kernel's constant factor, not
// the fixture size.
//
// The old full flat `π/2 · R0` across reach is the regression this guards: it
// widens the wrapped box to the whole half sheet, so the wrapped column grows
// while the flat reference stays fixed. Repeated runs on this machine
// (2026-10-18, `cpuRatio`, subject 5 reps / reference 3):
//   tight ball reach:       ratio 2.44–2.74 (wrapped 19–323 ms, flat 7.7–123 ms)
//   full flat box mutation: ratio 11.98–14.39 (wrapped 94–1,634 ms, flat 7.2–121 ms)
// The flat reference stayed put across the mutation, so it is not contaminated.
// Limit 5.7 is the geometric midpoint of the worst pair,
// sqrt(2.74 × 11.98) = 5.73: about 2.1x headroom either side.
const BALL_REPLAY_RATIO_LIMIT = 5.7

function ballReplayLanes(fixture: StubFixture, detail: number): {
  wrapped: { setup: () => void; run: () => void }
  flat: { setup: () => void; run: () => void }
} {
  const pristine = createSimulationGrid(
    fixture.setupInput.project,
    simulationBuildOptions(fixture.setupInput, detail),
  )
  const wrapped = cloneSimulationGrid(pristine)
  const flat = cloneSimulationGrid(pristine)
  // No wrap means `applyMoveToGrid` takes the untouched flat kernel.
  delete flat.wrap

  const moves: ToolpathMove[] = []
  for (const operation of fixture.setupInput.operations) {
    if (!operation.enabled || !operation.showToolpath || !operation.toolRef) continue
    const toolpath = fixture.setupInput.toolpaths.get(operation.id)
    if (!toolpath) continue
    for (const move of toolpath.moves) {
      if (moveIsMaterialRemoving(move)) moves.push(move)
    }
  }
  assert(moves.length > 0, 'fixture: the replay has cutting moves')

  const reset = (grid: SimulationGrid) => (): void => { grid.topZ.set(pristine.topZ) }
  const replay = (grid: SimulationGrid) => (): void => {
    for (const move of moves) {
      applyMoveToGrid(grid, move, fixture.tool.radius, 'ball_endmill', null)
    }
  }
  return {
    wrapped: { setup: reset(wrapped), run: replay(wrapped) },
    flat: { setup: reset(flat), run: replay(flat) },
  }
}

function testBallReplayTiming(): void {
  console.log('Testing wrapped ball replay timing on the square-to-round fixture...')
  for (const detail of [280, 1120] as const) {
    const fixture = stubFixture('ball_endmill', detail)
    const lanes = ballReplayLanes(fixture, detail)
    // Warm the JIT outside the measured region.
    lanes.wrapped.run()
    lanes.flat.run()
    const { ratio, subjectMs, referenceMs } = cpuRatio(lanes.wrapped, lanes.flat)
    console.log(
      `  ball ${detail}: wrapped ${subjectMs.toFixed(1)} ms vs flat reference `
      + `${referenceMs.toFixed(1)} ms (ratio ${ratio.toFixed(2)})`,
    )
    assert(referenceMs > 0, 'reference must do measurable work or the ratio is meaningless')
    assert(
      ratio < BALL_REPLAY_RATIO_LIMIT,
      `wrapped ball replay at detail ${detail} cost ${ratio.toFixed(2)}x the flat-kernel `
      + `reference (limit ${BALL_REPLAY_RATIO_LIMIT}x; ${subjectMs.toFixed(1)} ms vs `
      + `${referenceMs.toFixed(1)} ms CPU) — check that the wrapped across box still uses `
      + 'the profile-specific reach instead of the full flat π/2 · R0 bound',
    )
  }
}

testRandomMovesMatchTheOracle()
testRayMiddleKeepsTheOuterShell()
testBallShank()
testDeepVBitShank()
testDeepBallShank()
testSquareToRoundRetainedEnds()
testRoundGrooveMatchesOracle()
testPlaybackParityAndReset()
testSeamCopies()
testFinishedPlaybackMatchesBatchAtSeamOverlap()
testPartialPlaybackClipsElapsedFootprint()
testBallReplayTiming()
console.log('\nAll wrapped cutter geometry tests PASSED.')
