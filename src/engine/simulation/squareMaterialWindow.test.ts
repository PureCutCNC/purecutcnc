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
 * The per-move angle window of the square-material kernel (issue #1016 C2-P3).
 *
 * A cell only loses material where the tool body reaches its ray, so
 * `applySquareMoveToGrid` now iterates just the across cells inside a proven
 * `|θ| ≤ atan(rt / tipMin)` window instead of searching every cell all the way
 * round the bar. This file holds that window to three independent checks:
 *
 *   1. **Exactness.** A seeded, asymmetric move set is replayed twice through
 *      the same code — once with the window, once with `legacyFullLoop` — and
 *      every `topZ` value and every `squareMaterial` entry must be bit-identical
 *      after every call, as must each call's `changedCount` and `dirtyRegion`.
 *      The set covers flat and ball cutters, several radii, tips well above,
 *      just above, at and below the pivot, both rotation senses, explicit `a`
 *      and across-coordinate moves, seam-crossing windows, plunges, long and
 *      short moves, and an asymmetric pre-cut grid.
 *   2. **The bound is necessary.** For sampled moves, every cell whose ray is
 *      outside the proven bound is run through the full per-cell search on an
 *      isolated one-cell sheet and must cut nothing — the window may widen, but
 *      it may never narrow past the proof. Cells inside the bound are the
 *      positive control that the isolated harness can see a cut at all.
 *   3. **It pays.** On a `squareSimulation.test.ts`-style job (side 12, length
 *      30, ball rough, detail 60) the cells searched drop by the factor stated
 *      in `testFixtureCellCountDrop`, with the band count unchanged.
 *
 * Mutations this was checked against, each applied on its own and reverted:
 * - window 2× too narrow (`atan(rt / tipMin / 2)`) → 1 fails;
 * - the seam case dropping the wrapped range (`merged` only keeps the first
 *   range / the periodic copies are not both emitted) → 1 fails;
 * - the sign of the explicit-angle mapping flipped (`a − materialAngle`) → 1
 *   and 2 fail;
 * - the `tipMin ≤ 0` fallback removed (the guard in `angleWindowBound` always
 *   returns a bound) → 1 fails.
 *
 * Run with: node --import tsx src/engine/simulation/squareMaterialWindow.test.ts
 */

import assert from 'node:assert/strict'
import { applySquareMoveToGrid, squareSurfaceRadius } from './squareMaterial'
import type { TestedCellStats } from './squareMaterial'
import { createSimulationGrid } from './grid'
import { barCentre, barPivotZ, squareStock } from '../../types/barStock'
import { defaultTool, newProject, rectProfile, type ToolType } from '../../types/project'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { generateRotaryRough } from '../toolpaths/rotaryModel'
import { buildRotaryCylinder } from '../rotaryCylinder'
import type { SimulationGrid } from './types'
import type { AroundFrame } from '../aroundFrame'
import type { ToolpathMove } from '../toolpaths/types'

const TWO_PI = Math.PI * 2
const SIDE = 12
const CIRCUMFERENCE = Math.PI * SIDE
const STOCK_TOP = SIDE * Math.SQRT1_2
/** The property sheet: a coarse but not degenerate sampling of one turn. */
const CELL_SIZE = 0.5
const ALONG_LENGTH = 12

function emptyTested(): TestedCellStats {
  return { tested: 0, withBand: 0 }
}

// ---------------------------------------------------------------------------
// Sheets and comparison
// ---------------------------------------------------------------------------

/**
 * The production square sheet: pivot on the true centre, one nominal
 * circumference across, `ALONG_LENGTH` of bar along. `topZ` is the blank's own
 * cross section, exactly as `createSimulationGrid` seeds it.
 */
function makeSheet(axis: 'x' | 'y', alongStart = 0): SimulationGrid {
  const frame: AroundFrame = {
    axis,
    centre: 0,
    radius: SIDE / 2,
    zero: 0,
    sheetStart: -CIRCUMFERENCE / 2,
    circumference: CIRCUMFERENCE,
  }
  const xMin = axis === 'x' ? alongStart : -CIRCUMFERENCE / 2
  const xMax = axis === 'x' ? alongStart + ALONG_LENGTH : CIRCUMFERENCE / 2
  const yMin = axis === 'x' ? -CIRCUMFERENCE / 2 : alongStart
  const yMax = axis === 'x' ? CIRCUMFERENCE / 2 : alongStart + ALONG_LENGTH
  const cols = Math.round((xMax - xMin) / CELL_SIZE)
  const rows = Math.round((yMax - yMin) / CELL_SIZE)
  const topZ = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const across = axis === 'x' ? yMin + (row + 0.5) * CELL_SIZE : xMin + (col + 0.5) * CELL_SIZE
      topZ[row * cols + col] = squareSurfaceRadius(SIDE, across * TWO_PI / CIRCUMFERENCE)
    }
  }
  return {
    originX: xMin,
    originY: yMin,
    cellSize: CELL_SIZE,
    cols,
    rows,
    stockBottomZ: 0,
    stockTopZ: STOCK_TOP,
    squareBar: { side: SIDE, frame },
    initialTopZ: new Float32Array(topZ),
    topZ,
  }
}

/** A deep copy: the interval arrays may share, the maps and heights may not. */
function cloneSheet(source: SimulationGrid): SimulationGrid {
  const material = new Map<number, readonly number[]>()
  for (const [key, intervals] of source.squareMaterial ?? []) material.set(key, intervals)
  return {
    ...source,
    topZ: new Float32Array(source.topZ),
    initialTopZ: source.initialTopZ ? new Float32Array(source.initialTopZ) : undefined,
    squareMaterial: material,
  }
}

/** Every stored height must be the same number, bit for bit. */
function assertSameTopZ(a: SimulationGrid, b: SimulationGrid, label: string): void {
  assert.equal(a.topZ.length, b.topZ.length, `${label}: grid shapes differ`)
  assert.equal(a.squareMaterial?.size ?? 0, b.squareMaterial?.size ?? 0, `${label}: material map sizes differ`)
  for (let index = 0; index < a.topZ.length; index += 1) {
    if (a.topZ[index] !== b.topZ[index]) {
      assert.fail(`${label}: cell ${index} topZ ${a.topZ[index]} vs ${b.topZ[index]}`)
    }
  }
}

/** Every surviving interval must be the same numbers, in the same order. */
function assertSameMaterial(a: SimulationGrid, b: SimulationGrid, label: string): void {
  const keys = [...(a.squareMaterial?.keys() ?? [])].sort((left, right) => left - right)
  const otherKeys = [...(b.squareMaterial?.keys() ?? [])].sort((left, right) => left - right)
  assert.deepEqual(keys, otherKeys, `${label}: different cells carry material`)
  for (const key of keys) {
    const left = a.squareMaterial!.get(key)!
    const right = b.squareMaterial!.get(key)!
    if (left.length !== right.length) {
      assert.fail(`${label}: cell ${key} interval count ${left.length} vs ${right.length}`)
    }
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) {
        assert.fail(`${label}: cell ${key} endpoint ${i} ${left[i]} vs ${right[i]}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Seeded move set
// ---------------------------------------------------------------------------

/** mulberry32: a deterministic, dependency-free generator. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface SeededMove {
  label: string
  move: ToolpathMove
  toolRadius: number
  toolType: ToolType
  /** The window centre sits next to the sheet's seam: the window is two ranges. */
  seam: boolean
}

/** The sheet's across coordinate for a material angle, on the nominal cylinder. */
function acrossForAngle(angle: number): number {
  return angle * CIRCUMFERENCE / TWO_PI
}

/**
 * A deterministic asymmetric move set. Every category the handoff names is
 * generated at least a few times: flat and ball, radii from 0.5 to 3, tips
 * well above the pivot, just above it, exactly on it, just below it and well
 * below it, both rotation senses, explicit `a` and across-coordinate moves,
 * seam-crossing windows, plunges, long and short moves, and moves above the
 * corner envelope. `seamMoves` counts the seam cases so a regression in the
 * generator cannot quietly drop that coverage.
 */
function seededMoves(seed: number, count: number, axis: 'x' | 'y'): { moves: SeededMove[]; seamMoves: number } {
  const random = mulberry32(seed)
  const radii = [0.5, 0.8, 1.2, 1.6, 2.2, 3.0]
  const tipClasses = (): { from: number; to: number } => {
    const pick = random()
    if (pick < 0.16) {
      // Above the whole blank: the O(1) envelope rejection.
      const z = STOCK_TOP + random() * 4
      return { from: z, to: z - random() * 2 }
    }
    if (pick < 0.52) {
      const z = 3 + random() * 4
      return { from: z, to: z + (random() - 0.5) * 2.5 }
    }
    if (pick < 0.72) {
      const z = 0.3 + random() * 0.9
      return { from: z, to: z + (random() - 0.5) * 0.4 }
    }
    if (pick < 0.82) {
      // Exactly on the pivot, then a hair above it: both have no tan bound.
      const z = random() < 0.5 ? 0 : 1e-12
      return { from: z, to: z }
    }
    // Below the pivot: the radial floor can never force `cos θ > 0`.
    const z = -0.2 - random() * 3
    return { from: z, to: z - random() }
  }

  const moves: SeededMove[] = []
  let seamMoves = 0
  for (let index = 0; index < count; index += 1) {
    const toolType: ToolType = random() < 0.5 ? 'flat_endmill' : 'ball_endmill'
    const toolRadius = radii[Math.floor(random() * radii.length)]
    const explicit = random() < 0.5
    const plunge = random() < 0.22
    const forward = random() < 0.5
    const longMove = random() < 0.6
    const tips = tipClasses()

    const fromAlong = -1 + random() * (ALONG_LENGTH + 2)
    const travel = longMove ? 2 + random() * ALONG_LENGTH : 0.2 + random() * 1.5
    const toAlong = plunge ? fromAlong : fromAlong + (forward ? travel : -travel)

    // A seam-crossing window means the tool's own angle sits next to the sheet'
    // edge, so the |θ| ≤ bound set is split between the two ends of the sheet.
    const seam = random() < 0.2
    let angleDeg = 0
    let across: number
    if (explicit) {
      angleDeg = seam
        ? (random() < 0.5 ? 180 : -180) + (random() - 0.5) * 8
        : (random() - 0.5) * 720
      across = acrossForAngle(angleDeg * Math.PI / 180)
    } else {
      // The across-coordinate branch: a constant-angle move needs the same
      // across position at both ends.
      across = seam
        ? (random() < 0.5 ? -1 : 1) * (CIRCUMFERENCE / 2 - random() * 1.5)
        : (random() - 0.5) * CIRCUMFERENCE
    }
    if (seam) seamMoves += 1

    const fromAcross = across
    const toAcross = explicit && random() < 0.35 ? fromAcross + (random() - 0.5) * 4 : fromAcross
    const at = (along: number, acrossValue: number, z: number): ToolpathMove['from'] => {
      const point: ToolpathMove['from'] = axis === 'x'
        ? { x: along, y: acrossValue, z }
        : { x: acrossValue, y: along, z }
      if (explicit) point.a = angleDeg
      return point
    }
    moves.push({
      label: `move ${index} (${toolType}, rt ${toolRadius}, ${explicit ? 'explicit' : 'across'}, ${plunge ? 'plunge' : 'cut'}${seam ? ', seam' : ''})`,
      move: {
        kind: plunge ? 'plunge' : 'cut',
        from: at(fromAlong, fromAcross, tips.from),
        to: at(toAlong, toAcross, tips.to),
      },
      toolRadius,
      toolType,
      seam,
    })
  }
  return { moves, seamMoves }
}

// ---------------------------------------------------------------------------
// 1. The window stores exactly what the full loop stores
// ---------------------------------------------------------------------------

function testWindowMatchesFullLoop(): void {
  console.log('Testing the angle window stores exactly what the full every-cell loop stores...')
  for (const axis of ['x', 'y'] as const) {
    const seed = axis === 'x' ? 20261017 : 20261018
    // An asymmetric pre-cut: a handful of passes on one half of the bar, at
    // different angles and depths, so the material map the two runs start from
    // is neither empty nor symmetric.
    const preCut = seededMoves(seed + 7, 12, axis).moves
    const start = makeSheet(axis)
    for (const { move, toolRadius, toolType } of preCut) {
      applySquareMoveToGrid(start, move, toolRadius, toolType)
    }
    assert(start.squareMaterial !== undefined && start.squareMaterial.size > 20, `${axis}: the pre-cut must write real material`)

    const { moves, seamMoves } = seededMoves(seed, 200, axis)
    assert(seamMoves > 5, `${axis}: the seeded set must include seam-crossing windows, got ${seamMoves}`)

    const full = cloneSheet(start)
    const windowed = cloneSheet(start)
    const fullStats = emptyTested()
    const windowStats = emptyTested()
    let bandsSeen = 0
    let changedCalls = 0

    for (const { label, move, toolRadius, toolType } of moves) {
      const fullCall = emptyTested()
      const fullResult = applySquareMoveToGrid(full, move, toolRadius, toolType, {
        legacyFullLoop: true,
        testedCells: fullCall,
      })
      const windowCall = emptyTested()
      const windowResult = applySquareMoveToGrid(windowed, move, toolRadius, toolType, {
        testedCells: windowCall,
      })

      assert.equal(windowResult.changedCount, fullResult.changedCount, `${axis} ${label}: changedCount`)
      assert.deepEqual(windowResult.dirtyRegion, fullResult.dirtyRegion, `${axis} ${label}: dirtyRegion`)
      // Exact equality after every call, so a divergence names the move that
      // caused it instead of only the final grid.
      assertSameTopZ(full, windowed, `${axis} ${label}`)
      assertSameMaterial(full, windowed, `${axis} ${label}`)

      fullStats.tested += fullCall.tested
      fullStats.withBand += fullCall.withBand
      windowStats.tested += windowCall.tested
      windowStats.withBand += windowCall.withBand
      bandsSeen += fullCall.withBand
      if (fullResult.changedCount > 0) changedCalls += 1
    }

    assert(bandsSeen > 500, `${axis}: the seeded set must find real removal bands, got ${bandsSeen}`)
    assert(changedCalls > 50, `${axis}: the seeded set must actually change material, got ${changedCalls} calls`)
    // The window must not lose a single band: the same cells see the same cuts.
    assert.equal(
      windowStats.withBand,
      fullStats.withBand,
      `${axis}: every band the full loop finds must still be found (${windowStats.withBand} vs ${fullStats.withBand})`,
    )
    assert(
      windowStats.tested < fullStats.tested,
      `${axis}: the window must search fewer cells (${windowStats.tested} vs ${fullStats.tested})`,
    )
    console.log(
      `${axis}: ${moves.length} moves, ${bandsSeen} band cells, tested ${windowStats.tested} vs ${fullStats.tested} ` +
        `full-loop cells (${(100 * windowStats.tested / fullStats.tested).toFixed(1)} %)`,
    )
  }
}

// ---------------------------------------------------------------------------
// 2. Every cell outside the proven bound is honestly empty
// ---------------------------------------------------------------------------

/**
 * The documented angle of a cell's ray from the tool, re-derived here from the
 * sheet's own coordinates rather than imported: explicit `a` maps the material
 * angle minus the program angle, and a move without one maps the across
 * difference through the frame. `thetaAt` in the kernel must agree with this.
 */
function documentedTheta(
  move: ToolpathMove,
  axis: 'x' | 'y',
  across: number,
  anglePerAcross: number,
): number {
  const explicit = move.from.a !== undefined && move.to.a !== undefined
  const raw = explicit
    ? across * anglePerAcross - move.from.a! * Math.PI / 180
    : (across - (axis === 'x' ? move.from.y : move.from.x)) * anglePerAcross
  let wrapped = raw % TWO_PI
  if (wrapped > Math.PI) wrapped -= TWO_PI
  else if (wrapped <= -Math.PI) wrapped += TWO_PI
  return wrapped
}

/**
 * A sheet with material in exactly one cell. Running the whole move through the
 * full per-cell search then answers a single question: does the tool remove
 * anything from *this* ray?
 */
function isolatedCellSheet(
  axis: 'x' | 'y',
  along: number,
  acrossIndex: number,
  radius: number,
): { grid: SimulationGrid; index: number } {
  const shape = makeSheet(axis)
  const acrossCount = axis === 'x' ? shape.rows : shape.cols
  assert(acrossIndex >= 0 && acrossIndex < acrossCount, `isolated cell ${acrossIndex} is off the sheet`)
  const alongOrigin = axis === 'x' ? shape.originX : shape.originY
  const alongCount = axis === 'x' ? shape.cols : shape.rows
  const alongIndex = Math.max(0, Math.min(alongCount - 1, Math.floor((along - alongOrigin) / CELL_SIZE)))
  const col = axis === 'x' ? alongIndex : acrossIndex
  const row = axis === 'x' ? acrossIndex : alongIndex
  const index = row * shape.cols + col

  const topZ = new Float32Array(shape.cols * shape.rows)
  topZ[index] = radius
  const initialTopZ = new Float32Array(topZ)
  return {
    index,
    grid: {
      ...shape,
      topZ,
      initialTopZ,
      squareMaterial: new Map<number, readonly number[]>(),
    },
  }
}

function testBoundIsNecessary(): void {
  console.log('Testing every cell outside the proven bound cuts nothing through the full search...')
  for (const axis of ['x', 'y'] as const) {
    const seed = axis === 'x' ? 771016 : 771017
    const { moves } = seededMoves(seed, 60, axis)
    const shape = makeSheet(axis)
    const frame = shape.squareBar!.frame
    const anglePerAcross = TWO_PI / frame.circumference
    const acrossCount = axis === 'x' ? shape.rows : shape.cols
    const cellStep = anglePerAcross * CELL_SIZE
    let outsideChecked = 0
    let insideCuts = 0
    let movesWithBound = 0

    for (const { label, move, toolRadius, toolType } of moves) {
      const tipMin = Math.min(move.from.z, move.to.z)
      if (!(tipMin > 0)) continue
      const bound = Math.atan(toolRadius / tipMin)
      if (!(bound < Math.PI)) continue
      movesWithBound += 1
      const fromAlong = axis === 'x' ? move.from.x : move.from.y
      const toAlong = axis === 'x' ? move.to.x : move.to.y
      const along = (fromAlong + toAlong) / 2
      // One cell of slack covers the index rounding; cells at or inside the
      // bound are the positive control, never the thing under test.
      const outside = bound + cellStep

      for (let c = 0; c < acrossCount; c += 1) {
        const across = (axis === 'x' ? shape.originY : shape.originX) + (c + 0.5) * CELL_SIZE
        const theta = documentedTheta(move, axis, across, anglePerAcross)
        const radius = squareSurfaceRadius(SIDE, across * anglePerAcross)
        if (Math.abs(theta) <= outside) {
          const { grid } = isolatedCellSheet(axis, along, c, radius)
          const inside = applySquareMoveToGrid(grid, move, toolRadius, toolType, { legacyFullLoop: true })
          if (inside.changedCount > 0) insideCuts += 1
          continue
        }
        const { grid } = isolatedCellSheet(axis, along, c, radius)
        const outsideResult = applySquareMoveToGrid(grid, move, toolRadius, toolType, { legacyFullLoop: true })
        assert.equal(
          outsideResult.changedCount,
          0,
          `${axis} ${label}: cell ${c} at |theta| ${(Math.abs(theta) * 180 / Math.PI).toFixed(1)}° ` +
            `is outside the ${(bound * 180 / Math.PI).toFixed(1)}° bound but the full search cut it`,
        )
        outsideChecked += 1
      }
    }

    assert(movesWithBound > 20, `${axis}: the sample must include bounded moves, got ${movesWithBound}`)
    assert(outsideChecked > 300, `${axis}: the sample must check real outside cells, got ${outsideChecked}`)
    assert(insideCuts > 20, `${axis}: the positive control must cut inside the bound, got ${insideCuts}`)
    console.log(`${axis}: ${movesWithBound} bounded moves, ${outsideChecked} outside cells cut nothing, ${insideCuts} inside cells cut`)
  }
}

// ---------------------------------------------------------------------------
// 3. The window pays on a squareSimulation.test.ts-style job
// ---------------------------------------------------------------------------

/**
 * The share of the full loop's cells this fixture still searches. Measured at
 * 13.1 % (158,320 of 1,206,000) with the window and 100 % without it; the
 * assertion allows 25 %, so a roughly 2× regression is still green while a
 * window that stopped being applied at all (or went 2× too narrow) fails.
 */
const FIXTURE_TESTED_SHARE = 0.25

function testFixtureCellCountDrop(): void {
  console.log('Testing the tested-cell count drops on a squareSimulation.test.ts-style job...')
  const length = 30
  const detail = 60
  const stock = squareStock(SIDE, length, 'x')
  const blank = newProject('window fixture', 'mm')
  const tool = normalizeToolForProject(
    { ...defaultTool('mm', 1), type: 'ball_endmill', diameter: 2 },
    blank,
  )
  // The same job the app test builds: a rotary rough over a prism inside the
  // blank, production generator, real square stock.
  const mesh = buildRotaryCylinder(stock, { diameter: 8, alongStart: 3, alongEnd: 27 }, 'mm')
  const rough = generateRotaryRough('window fixture', mesh, stock, tool, {
    stepover: 0.8,
    stepdown: 1,
    stockToLeave: 0.4,
    sampleSpacing: 12,
    requestedCellSize: 0.25,
    alongStart: 0,
    alongEnd: length,
    safeRadius: 25,
  }, {})
  assert(rough.moves.length > 100, `the generated rough must produce a real path, got ${rough.moves.length} moves`)

  const zero = barCentre(stock)
  const frame: AroundFrame = {
    axis: 'x',
    centre: zero,
    radius: SIDE / 2,
    zero,
    sheetStart: zero - CIRCUMFERENCE / 2,
    circumference: CIRCUMFERENCE,
  }
  const sheet = newProject('window sheet', 'mm')
  sheet.stock = {
    ...sheet.stock,
    profile: rectProfile(0, frame.sheetStart, length, CIRCUMFERENCE),
    thickness: SIDE / 2,
  }
  const makeGrid = (): SimulationGrid => createSimulationGrid(sheet, {
    squareBar: { side: SIDE, frame },
    targetLongAxisCells: detail,
  })

  // The generated moves are in stock space; the sheet's radial axis is
  // pivot-referenced, exactly as the app unwraps it.
  const pivot = barPivotZ(stock)
  const moves = rough.moves.map((move) => ({
    ...move,
    from: { ...move.from, z: move.from.z - pivot },
    to: { ...move.to, z: move.to.z - pivot },
  }))

  const replay = (fullLoop: boolean): { grid: SimulationGrid; stats: TestedCellStats; changed: number } => {
    const grid = makeGrid()
    const stats = emptyTested()
    let changed = 0
    for (const move of moves) {
      const result = applySquareMoveToGrid(grid, move, tool.radius, tool.type, {
        ...(fullLoop ? { legacyFullLoop: true } : {}),
        testedCells: stats,
      })
      changed += result.changedCount
    }
    return { grid, stats, changed }
  }

  const full = replay(true)
  const windowed = replay(false)

  assert(windowed.stats.tested > 0, 'the windowed run must search real cells')
  assert(full.stats.withBand > 0, 'the fixture must cut real material')
  assert.equal(
    windowed.stats.withBand,
    full.stats.withBand,
    `every band the full loop finds must still be found (${windowed.stats.withBand} vs ${full.stats.withBand})`,
  )
  assert.equal(windowed.changed, full.changed, 'the fixture must change the same cells')
  assertSameTopZ(full.grid, windowed.grid, 'fixture')
  assertSameMaterial(full.grid, windowed.grid, 'fixture')

  const share = windowed.stats.tested / full.stats.tested
  assert(
    share < FIXTURE_TESTED_SHARE,
    `the window must search under ${FIXTURE_TESTED_SHARE * 100} % of the full loop's cells, got ${(share * 100).toFixed(1)} % ` +
      `(${windowed.stats.tested} vs ${full.stats.tested})`,
  )
  console.log(
    `fixture: ${moves.length} moves, ${full.stats.withBand} band cells; tested ${windowed.stats.tested} vs ` +
      `${full.stats.tested} full-loop cells (${(share * 100).toFixed(1)} %), changed ${windowed.changed} cells`,
  )
}

testWindowMatchesFullLoop()
testBoundIsNecessary()
testFixtureCellCountDrop()

console.log('square-material angle window tests passed')
