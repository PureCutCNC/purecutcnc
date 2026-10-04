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
 * Issue #939: the step/slope predicate, the surface lighting gradient and the
 * wall outline rule, run from the shader source itself (see
 * `glslScalar.testSupport.ts`).
 */
import { compileScalarGlsl } from './glslScalar.testSupport'
import {
  OUTLINE_CORNER_SHIFT_CELLS,
  OUTLINE_TURN_GLSL,
  SHALLOW_SLOPE_CELLS,
  SLOPE_GRADIENT_GLSL,
  STEP_GLSL,
} from './heightfieldShader'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertClose(actual: number, expected: number, tolerance: number, message: string): void {
  assert(Math.abs(actual - expected) <= tolerance, `${message} (got ${actual}, expected ${expected})`)
}

const shader = compileScalarGlsl(`${STEP_GLSL}\n${SLOPE_GRADIENT_GLSL}`)

/** Height of a cell, with everything outside the profile cut through like the shader's `cellHeight`. */
function heightAt(profile: readonly number[], index: number, stockBottomZ: number): number {
  return index < 0 || index >= profile.length ? stockBottomZ : profile[index]
}

/** Is the edge between cells `index` and `index + 1` a step? */
function edgeIsStep(profile: readonly number[], index: number, cellSize: number, stockBottomZ = 0): boolean {
  return shader.edgeIsStep(
    heightAt(profile, index, stockBottomZ),
    heightAt(profile, index + 1, stockBottomZ),
    heightAt(profile, index - 1, stockBottomZ),
    heightAt(profile, index + 2, stockBottomZ),
    stockBottomZ,
    cellSize,
  ) as boolean
}

type HeightField = (col: number, row: number) => number

/**
 * The surface gradient at (localX, localY) inside a cell, in height change per
 * cell on each axis: the same thirteen lookups, four predicate calls and two
 * `axisGradient` calls as the shader's `surfaceNormal`.
 */
function surfaceGradient(
  height: HeightField,
  col: number,
  row: number,
  localX: number,
  localY: number,
  wide: number,
  cellSize: number,
  stockBottomZ = 0,
): { x: number; z: number } {
  const at = (dx: number, dz: number): number => height(col + dx, row + dz)
  const center = at(0, 0)
  const stepWest = shader.edgeIsStep(at(-1, 0), center, at(-2, 0), at(1, 0), stockBottomZ, cellSize)
  const stepEast = shader.edgeIsStep(center, at(1, 0), at(-1, 0), at(2, 0), stockBottomZ, cellSize)
  const stepNorth = shader.edgeIsStep(at(0, -1), center, at(0, -2), at(0, 1), stockBottomZ, cellSize)
  const stepSouth = shader.edgeIsStep(center, at(0, 1), at(0, -1), at(0, 2), stockBottomZ, cellSize)
  return {
    x: shader.axisGradient(
      at(-2, 0), at(-1, 0), center, at(1, 0), at(2, 0),
      at(-1, -1), at(0, -1), at(1, -1),
      at(-1, 1), at(0, 1), at(1, 1),
      stepWest, stepEast, stepNorth, stepSouth,
      localX, localY, wide, stockBottomZ, cellSize,
    ) as number,
    z: shader.axisGradient(
      at(0, -2), at(0, -1), center, at(0, 1), at(0, 2),
      at(-1, -1), at(-1, 0), at(-1, 1),
      at(1, -1), at(1, 0), at(1, 1),
      stepNorth, stepSouth, stepWest, stepEast,
      localY, localX, wide, stockBottomZ, cellSize,
    ) as number,
  }
}

/** A field that only varies along X, from a profile; cut through outside it. */
function alongX(profile: readonly number[], stockBottomZ = 0): HeightField {
  return (col) => heightAt(profile, col, stockBottomZ)
}

/** The same field turned a quarter turn, so the Z axis gets the same test. */
function turned(field: HeightField): HeightField {
  return (col, row) => field(row, col)
}

/**
 * What the simulation stores for a ball finish: each cell holds the lowest
 * point any pass of the ball reached above it, on a base that may tilt.
 */
function ballScallopProfile(options: {
  cells: number
  cellSize: number
  ballRadius: number
  stepover: number
  phase: number
  baseZ: number
  baseSlope: number
}): number[] {
  const { cells, cellSize, ballRadius, stepover, phase, baseZ, baseSlope } = options
  const profile: number[] = []
  for (let cell = 0; cell < cells; cell += 1) {
    const x = (cell + 0.5) * cellSize
    const nearestPass = Math.round((x - phase) / stepover)
    let scallop = Infinity
    for (let pass = nearestPass - 1; pass <= nearestPass + 1; pass += 1) {
      const offset = x - (phase + pass * stepover)
      if (Math.abs(offset) < ballRadius) {
        scallop = Math.min(scallop, ballRadius - Math.sqrt(ballRadius * ballRadius - offset * offset))
      }
    }
    profile.push(Math.fround(baseZ + baseSlope * x + scallop))
  }
  return profile
}

// The issue's case: a 20" guitar top at detail 1360, a 1/4" ball at a 0.0016"
// scallop — a 0.04" stepover, so each pass spans under three cells.
const GUITAR_CELL = 20 / 1360
const BALL_RADIUS = 0.125

function testShallowScallopIsSlope(): void {
  console.log('Testing a ball scallop sampled at ~3 cells per pass classifies as slope...')
  let edges = 0
  let reversals = 0
  // 2.7, 3 and exactly 4 cells per pass: the last lines the passes up with the
  // grid, which samples every scallop as two low cells and two high ones.
  for (const stepover of [0.04, 3 * GUITAR_CELL, 4 * GUITAR_CELL]) {
    for (const baseSlope of [0, 0.03, -0.1]) {
      for (let phaseStep = 0; phaseStep < 16; phaseStep += 1) {
        const profile = ballScallopProfile({
          cells: 60,
          cellSize: GUITAR_CELL,
          ballRadius: BALL_RADIUS,
          stepover,
          phase: (phaseStep / 16) * stepover,
          baseZ: 0.4,
          baseSlope,
        })
        for (let index = 2; index < profile.length - 3; index += 1) {
          edges += 1
          const before = profile[index] - profile[index - 1]
          const center = profile[index + 1] - profile[index]
          const after = profile[index + 2] - profile[index + 1]
          if (center !== 0 && before * center <= 0 && after * center <= 0) reversals += 1
          assert(
            !edgeIsStep(profile, index, GUITAR_CELL),
            `scallop edge ${index} must be a slope (stepover ${stepover}, base slope ${baseSlope}, phase ${phaseStep}/16: `
              + `${profile.slice(index - 1, index + 3).join(', ')})`,
          )
        }
      }
    }
  }
  // The case is only worth testing if it holds the edges the old rule got
  // wrong: ones whose gradient reverses on both sides, so nothing "continues".
  assert(reversals > edges / 20, `profile must reverse its gradient often (${reversals} of ${edges} edges)`)
  console.log(`shallow scallop: PASSED (${edges} edges, ${reversals} with the gradient reversing on both sides)`)
}

function testTabBridgeAndCutThroughStaySteps(): void {
  console.log('Testing tab bridges and cut-through rims stay steps (issue #829)...')
  // Kerf → 3 mm tab → 20 mm part, the reported staircase, on 1 mm cells.
  const staircase = [0, 0, 3, 3, 20, 20]
  assert(edgeIsStep(staircase, 1, 1), 'kerf-to-tab edge is a step')
  assert(edgeIsStep(staircase, 3, 1), 'tab-to-part edge is a step')
  assert(!edgeIsStep(staircase, 2, 1), 'two cells of tab top at one height have nothing to draw')

  // A tab bridge one cell wide, through-cut on both sides.
  const bridge = [0, 0, 3, 0, 0]
  assert(edgeIsStep(bridge, 1, 1) && edgeIsStep(bridge, 2, 1), 'both walls of a one-cell tab bridge are steps')

  // A one-cell tab against the part, at any height. The kerf's drop on the far
  // side of the tab is a wall, not a gradient for the tab-to-part step to
  // continue — otherwise a tall tab's wall turns into a shaded slope.
  for (const tabHeight of [1, 3, 5, 8, 12, 16, 19]) {
    const tab = [0, 0, tabHeight, 20, 20]
    assert(edgeIsStep(tab, 1, 1), `kerf to ${tabHeight} mm tab is a step`)
    assert(edgeIsStep(tab, 2, 1), `${tabHeight} mm one-cell tab to part is a step`)
    const mirrored = [...tab].reverse()
    assert(edgeIsStep(mirrored, 1, 1) && edgeIsStep(mirrored, 2, 1), `${tabHeight} mm tab is a step from either side`)
  }

  // A cut-through rim is a wall however thin the skin beside it is, including
  // thinner than the shallow-slope bound.
  for (const skin of [0.05, 0.2, 0.5, 5]) {
    assert(edgeIsStep([skin, skin, 0, 0], 1, 1), `rim of a ${skin} mm skin is a step`)
    assert(edgeIsStep([0, 0, skin, skin], 1, 1), `rim of a ${skin} mm skin is a step from the kerf side`)
  }

  // The stock's own border is a rim too.
  assert(edgeIsStep([20, 20, 20], -1, 1) && edgeIsStep([20, 20, 20], 2, 1), 'stock perimeter edges are steps')
  console.log('tab bridge and cut-through: PASSED')
}

function testWallsAndSlopesKeepTheirClass(): void {
  console.log('Testing isolated walls stay steps and machined slopes stay slopes...')
  const pocket = [20, 20, 20, 10, 10, 10]
  assert(edgeIsStep(pocket, 2, 1), 'a pocket wall is a step')
  const terraces = [20, 20, 15, 15, 10, 10]
  assert(edgeIsStep(terraces, 1, 1) && edgeIsStep(terraces, 3, 1), 'stepdown terraces are steps')
  const thinWall = [5, 5, 20, 5, 5]
  assert(edgeIsStep(thinWall, 1, 1) && edgeIsStep(thinWall, 2, 1), 'a one-cell wall between two pockets is two steps')

  // The shallow bound is in cells: a pocket floor just over half a cell down
  // keeps its crisp wall, one within it shades as a slope.
  const justOver = SHALLOW_SLOPE_CELLS + 0.1
  const justUnder = SHALLOW_SLOPE_CELLS - 0.1
  for (const cellSize of [0.1, 1, 2.5]) {
    assert(edgeIsStep([20, 20, 20 - justOver * cellSize, 20 - justOver * cellSize], 1, cellSize), `${justOver}-cell pocket wall is a step at cell ${cellSize}`)
    assert(!edgeIsStep([20, 20, 20 - justUnder * cellSize, 20 - justUnder * cellSize], 1, cellSize), `${justUnder}-cell ripple is a slope at cell ${cellSize}`)
  }

  // A V-flank: 3 mm per cell on both sides of a ridge, far too steep to be
  // shallow, a slope because every step continues the one beside it.
  const ridge = Array.from({ length: 11 }, (_, index) => 20 - 3 * Math.abs(index - 5))
  for (let index = 1; index < ridge.length - 2; index += 1) {
    assert(!edgeIsStep(ridge, index, 1), `V-flank edge ${index} is a slope`)
  }

  // A ball roundover sampled finely: the height change grows cell by cell.
  const roundover = Array.from({ length: 28 }, (_, index) => 10 + Math.sqrt(9 - (index * 0.1) ** 2))
  for (let index = 1; index < roundover.length - 2; index += 1) {
    assert(!edgeIsStep(roundover, index, 0.1), `roundover edge ${index} is a slope`)
  }
  console.log('walls and slopes: PASSED')
}

function testGradientIsContinuousAndExact(): void {
  console.log('Testing the lighting gradient is continuous across cell borders and exact on a plane...')
  // A plane has one gradient everywhere, shallow or steep, sharp or widened.
  for (const [slopeX, slopeZ] of [[0.05, -0.3], [3, 0.2], [-7, 4]]) {
    const plane: HeightField = (col, row) => 500 + slopeX * col + slopeZ * row
    for (const local of [0, 0.25, 0.5, 1]) {
      for (const wide of [0, 0.5, 1]) {
        const gradient = surfaceGradient(plane, 4, 4, local, 1 - local, wide, 1)
        assertClose(gradient.x, slopeX, 1e-9, `plane ${slopeX}/${slopeZ} X at local ${local}, wide ${wide}`)
        assertClose(gradient.z, slopeZ, 1e-9, `plane ${slopeX}/${slopeZ} Z at local ${local}, wide ${wide}`)
      }
    }
  }

  // A shallow finished surface: scallops along X on a base that also rolls
  // gently along Z, so every line differs from its neighbors.
  const scallops = ballScallopProfile({
    cells: 40, cellSize: GUITAR_CELL, ballRadius: BALL_RADIUS, stepover: 0.04, phase: 0.011, baseZ: 0.4, baseSlope: 0.02,
  })
  const surface: HeightField = (col, row) =>
    scallops[col] * (1 + 0.002 * Math.sin(row * 0.7)) + 0.004 * Math.sin(row * 0.45 + col * 0.2)
  const centralX = (col: number, row: number): number => (surface(col + 1, row) - surface(col - 1, row)) / 2
  for (const field of [surface, turned(surface)]) {
    const axis = field === surface ? 'x' : 'z'
    const along = (col: number, row: number, localAlong: number, localAcross: number, wide: number): number =>
      field === surface
        ? surfaceGradient(field, col, row, localAlong, localAcross, wide, GUITAR_CELL).x
        : surfaceGradient(field, row, col, localAcross, localAlong, wide, GUITAR_CELL).z
    for (let col = 4; col < scallops.length - 5; col += 1) {
      for (const row of [7, 8]) {
        // At a cell's centre, up close: the central difference, averaged 1:6:1
        // with the lines either side.
        assertClose(
          along(col, row, 0.5, 0.5, 0),
          0.125 * centralX(col, row - 1) + 0.75 * centralX(col, row) + 0.125 * centralX(col, row + 1),
          1e-9,
          `${axis}: centre gradient at cell ${col},${row}`,
        )
        for (const offset of [0, 0.3, 1]) {
          // Leaving one cell and entering the next along the axis must not
          // change the lighting, at any zoom.
          for (const wide of [0, 0.4, 1]) {
            assertClose(
              along(col, row, 1, offset, wide),
              along(col + 1, row, 0, offset, wide),
              1e-9,
              `${axis}: continuous along the axis after cell ${col},${row} (across ${offset}, wide ${wide})`,
            )
          }
          // Nor across it, up close. (Zoomed out the cell's own line is used
          // alone; a cell is under a pixel by then.)
          assertClose(
            along(col, row, offset, 1, 0),
            along(col, row + 1, offset, 0, 0),
            1e-9,
            `${axis}: continuous across the axis after cell ${col},${row} (along ${offset})`,
          )
        }
      }
    }
  }
  console.log('gradient continuity: PASSED')
}

function testGradientLeavesStepsOut(): void {
  console.log('Testing a flat top beside a step takes no gradient from it...')
  // Kerf → tab → part again: every tread is flat right up to both rims, at any
  // zoom. The widened stencil reaches two cells out, across the step.
  const staircase = [0, 0, 0, 3, 3, 20, 20, 20]
  for (const field of [alongX(staircase), turned(alongX(staircase))]) {
    for (const index of [3, 4, 5, 6]) {
      for (const local of [0, 0.5, 1]) {
        for (const wide of [0, 0.5, 1]) {
          const gradient = surfaceGradient(field, index, index, local, local, wide, 1)
          assert(
            gradient.x === 0 && gradient.z === 0,
            `tread ${index} (height ${staircase[index]}) stays flat at local ${local}, wide ${wide} (${gradient.x}, ${gradient.z})`,
          )
        }
      }
    }
  }

  // A slope that ends at a wall keeps its own gradient and takes none of the
  // wall's 14 mm drop, nor anything from the floor beyond it.
  const slopeToWall = [20, 19.8, 19.6, 19.4, 5, 5, 5]
  const wallToSlope = [...slopeToWall].reverse()
  for (const wide of [0, 0.5, 1]) {
    const atRim = surfaceGradient(alongX(slopeToWall), 3, 0, 1, 0.5, wide, 1).x
    assert(atRim <= 0 && atRim >= -0.2 - 1e-9, `slope rim gradient stays within the slope's own (${atRim}, wide ${wide})`)
    assert(surfaceGradient(alongX(slopeToWall), 4, 0, 0, 0.5, wide, 1).x === 0, `floor beside the wall stays flat (wide ${wide})`)
    const atMirroredRim = surfaceGradient(alongX(wallToSlope), 3, 0, 0, 0.5, wide, 1).x
    assert(atMirroredRim >= 0 && atMirroredRim <= 0.2 + 1e-9, `mirrored slope rim gradient stays within the slope's own (${atMirroredRim}, wide ${wide})`)
    assert(surfaceGradient(alongX(wallToSlope), 2, 0, 1, 0.5, wide, 1).x === 0, `floor before the wall stays flat (wide ${wide})`)
  }

  // A flat top beside a finished slope, a wall between them: rows below 10 are
  // a 20 mm flat top, rows from 10 up a surface near 8 mm that falls 0.3 mm per
  // cell along X. Neither face may borrow the other's gradient through the
  // neighboring line, right up to the rim.
  const faces: HeightField = (col, row) => (row < 10 ? 20 : 8 - 0.3 * col)
  for (const field of [faces, turned(faces)]) {
    const read = (col: number, row: number, localAlong: number, localAcross: number, wide: number): number =>
      field === faces
        ? surfaceGradient(field, col, row, localAlong, localAcross, wide, 1).x
        : surfaceGradient(field, row, col, localAcross, localAlong, wide, 1).z
    for (const localAlong of [0, 0.5, 1]) {
      for (const wide of [0, 0.5]) {
        assert(read(5, 9, localAlong, 1, wide) === 0, `flat top stays flat at the rim (along ${localAlong}, wide ${wide})`)
        assertClose(read(5, 10, localAlong, 0, wide), -0.3, 1e-9, `slope keeps its own gradient at the rim (along ${localAlong}, wide ${wide})`)
      }
    }
  }

  // Past the cell's own two edges the stencil asks no predicate: an edge is
  // used only when it is certain to be a slope.
  const outer = (from: number, to: number, cellSize: number): number =>
    shader.shallowSlopeDelta(from, to, 99, 0, cellSize) as number
  assertClose(outer(10, 10.3, 1), 0.3, 1e-12, 'a shallow outer edge is used')
  assert(outer(10, 10.3, 0.5) === 99, 'the same edge is not shallow on smaller cells')
  assert(outer(10, 12, 1) === 99, 'a tall outer edge repeats the inner one')
  assert(outer(0, 0.3, 1) === 99 && outer(0.3, 0, 1) === 99, 'an outer edge onto a cut-through cell repeats the inner one')
  console.log('gradient leaves steps out: PASSED')
}

function testWideningAveragesNarrowScallopsOnly(): void {
  console.log('Testing the widened stencil removes a 3-cell scallop but keeps a well-sampled one...')
  const rippleStrength = (cellSize: number, wide: number): number => {
    const profile = ballScallopProfile({
      cells: 400, cellSize, ballRadius: BALL_RADIUS, stepover: 0.04, phase: 0.007, baseZ: 0.4, baseSlope: 0,
    })
    let sum = 0
    let count = 0
    for (let index = 3; index < profile.length - 3; index += 1) {
      sum += (surfaceGradient(alongX(profile), index, 0, 0.5, 0.5, wide, cellSize).x / cellSize) ** 2
      count += 1
    }
    return Math.sqrt(sum / count)
  }
  // Guitar top: under three cells per pass. Widening must flatten the ripple.
  const narrow = rippleStrength(GUITAR_CELL, 1) / rippleStrength(GUITAR_CELL, 0)
  assert(narrow < 0.3, `widening must remove most of a 2.7-cell scallop (kept ${(narrow * 100).toFixed(0)} %)`)
  // A 4" part at the same detail: ~13 cells per pass. Its scallops are real
  // on-screen detail and must survive.
  const wellSampled = rippleStrength(4 / 1360, 1) / rippleStrength(4 / 1360, 0)
  assert(wellSampled > 0.8, `widening must keep a 13-cell scallop (kept ${(wellSampled * 100).toFixed(0)} %)`)
  console.log(`widening: PASSED (keeps ${(narrow * 100).toFixed(0)} % of a 2.7-cell scallop, ${(wellSampled * 100).toFixed(0)} % of a 13-cell one)`)
}

// ── Part 2: walls along the cut outline ────────────────────────────────

interface Point { x: number; z: number }

/** The outline rule compiled against one height field, plus the corner it yields. */
function outlineOf(height: HeightField, cellSize = 1, stockBottomZ = 0): {
  /** Where grid corner (x, z) is drawn, in cells. */
  corner: (x: number, z: number) => Point
  /** Does the corner move at all. */
  moves: (x: number, z: number) => boolean
  /** Is the grid edge leaving the corner in a direction a wall. */
  wallFrom: (x: number, z: number, dirX: number, dirZ: number) => boolean
  /** Every corner in the window that a wall touches. */
  wallCorners: (min: number, max: number) => Array<{ grid: Point; drawn: Point }>
} {
  const compiled = compileScalarGlsl(`${STEP_GLSL}\n${OUTLINE_TURN_GLSL}`, { cellHeightAt: height })
  const turn = (x: number, z: number): number => compiled.outlineCornerTurn(x, z, stockBottomZ, cellSize) as number
  const wallFrom = (x: number, z: number, dirX: number, dirZ: number): boolean =>
    compiled.wallFrom(x, z, dirX, dirZ, stockBottomZ, cellSize) as boolean
  // The same mapping from turn code to offset as the shader's outlineCornerOffset.
  const corner = (x: number, z: number): Point => {
    const code = turn(x, z)
    if (code === 0) return { x, z }
    return {
      x: x + OUTLINE_CORNER_SHIFT_CELLS * (code === 1 || code === 3 ? 1 : -1),
      z: z + OUTLINE_CORNER_SHIFT_CELLS * (code === 1 || code === 2 ? 1 : -1),
    }
  }
  return {
    corner,
    moves: (x, z) => turn(x, z) !== 0,
    wallFrom,
    wallCorners: (min, max) => {
      const found: Array<{ grid: Point; drawn: Point }> = []
      for (let z = min; z <= max; z += 1) {
        for (let x = min; x <= max; x += 1) {
          if (wallFrom(x, z, 1, 0) || wallFrom(x, z, -1, 0) || wallFrom(x, z, 0, 1) || wallFrom(x, z, 0, -1)) {
            found.push({ grid: { x, z }, drawn: corner(x, z) })
          }
        }
      }
      return found
    },
  }
}

/** A cell holds what its centre sees, as the simulation's replay does. */
function sampled(inside: (x: number, z: number) => boolean, high: number, low: number): HeightField {
  return (col, row) => (inside(col + 0.5, row + 0.5) ? high : low)
}

function testDiagonalWallIsStraight(): void {
  console.log('Testing a 45° wall is drawn straight, close to the real edge...')
  let checked = 0
  // Both diagonals, material on either side, the real edge anywhere between
  // two cell centres; a through cut, a pocket floor, and a skin thinner than
  // the shallow-slope bound beside a through cut (still a wall: it is a rim).
  for (const [high, low] of [[20, 0], [20, 5], [0.3, 0]]) {
    for (const sign of [1, -1]) {
      for (const materialAbove of [true, false]) {
        for (const offset of [0.1, 0.3, 0.5, 0.7, 0.9]) {
          // The real edge is the line z - sign * x = offset.
          const side = (x: number, z: number): number => z - sign * x - offset
          const field = sampled((x, z) => (side(x, z) > 0) === materialAbove, high, low)
          const corners = outlineOf(field).wallCorners(-8, 8)
            .filter(({ grid }) => Math.abs(grid.x) <= 6 && Math.abs(grid.z) <= 6)
          assert(corners.length >= 20, `diagonal must have wall corners to check (${corners.length})`)
          const distance = (point: Point): number => Math.abs(side(point.x, point.z)) / Math.SQRT2
          const line = corners[0].drawn.z - sign * corners[0].drawn.x
          let worstGrid = 0
          for (const { grid, drawn } of corners) {
            checked += 1
            assertClose(drawn.z - sign * drawn.x, line, 1e-9, `corner ${grid.x},${grid.z} lies on the one straight wall (${high} over ${low}, sign ${sign}, offset ${offset})`)
            assert(distance(drawn) <= 0.29, `corner ${grid.x},${grid.z} is within 0.29 cell of the real edge (${distance(drawn)})`)
            worstGrid = Math.max(worstGrid, distance(grid))
          }
          // On cell edges the same wall zigzags up to 0.64 cell off the real edge.
          assert(worstGrid > distance(corners[0].drawn) + 0.2, `cell-edge placement is the worse one (${worstGrid})`)
        }
      }
    }
  }
  console.log(`diagonal wall: PASSED (${checked} corners)`)
}

function testCircleWallFollowsTheOutline(): void {
  console.log('Testing a circular wall follows the circle more closely than cell edges do...')
  const centre = { x: 0.37, z: -0.21 }
  for (const radius of [6.2, 20.3]) {
    for (const island of [true, false]) {
      const field = sampled((x, z) => (Math.hypot(x - centre.x, z - centre.z) < radius) === island, 20, 0)
      const corners = outlineOf(field).wallCorners(-Math.ceil(radius) - 3, Math.ceil(radius) + 3)
      assert(corners.length > 6 * radius, `circle must have wall corners to check (${corners.length})`)
      const error = (point: Point): number => Math.abs(Math.hypot(point.x - centre.x, point.z - centre.z) - radius)
      const rms = (pick: (corner: { grid: Point; drawn: Point }) => Point): number =>
        Math.sqrt(corners.reduce((sum, corner) => sum + error(pick(corner)) ** 2, 0) / corners.length)
      const worst = (pick: (corner: { grid: Point; drawn: Point }) => Point): number =>
        Math.max(...corners.map((corner) => error(pick(corner))))
      const drawnRms = rms((corner) => corner.drawn)
      const gridRms = rms((corner) => corner.grid)
      assert(drawnRms < 0.6 * gridRms, `radius ${radius}: outline error must drop (rms ${drawnRms.toFixed(3)} vs ${gridRms.toFixed(3)} on cell edges)`)
      assert(worst((corner) => corner.drawn) <= 0.5, `radius ${radius}: every wall corner within half a cell of the circle (${worst((corner) => corner.drawn).toFixed(3)})`)
      assert(worst((corner) => corner.drawn) <= worst((corner) => corner.grid) + 1e-9, `radius ${radius}: no corner ends up further off than on cell edges`)
      console.log(`  radius ${radius} ${island ? 'island' : 'hole'}: rms ${gridRms.toFixed(3)} → ${drawnRms.toFixed(3)} cell, worst ${worst((corner) => corner.grid).toFixed(3)} → ${worst((corner) => corner.drawn).toFixed(3)}`)
    }
  }
  console.log('circular wall: PASSED')
}

function testThinFeaturesAndRealCornersStayPut(): void {
  console.log('Testing a one-cell tab bridge, islands, holes and real corners are left alone...')
  const still = (name: string, field: HeightField): void => {
    const outline = outlineOf(field)
    for (let z = -6; z <= 12; z += 1) {
      for (let x = -6; x <= 12; x += 1) {
        assert(!outline.moves(x, z), `${name}: corner ${x},${z} must not move`)
      }
    }
  }

  // Issue #829's bridge: a 3 mm tab one cell wide across a six-cell kerf,
  // between the 20 mm part and the 20 mm stock.
  const bridge: HeightField = (col, row) => (row < 0 || row >= 6 ? 20 : col === 0 ? 3 : 0)
  still('tab bridge', bridge)
  still('tab bridge, turned', turned(bridge))
  // It keeps its walls: both sides along its length, and a wall up to the part
  // and the stock at each end.
  const bridgeOutline = outlineOf(bridge)
  for (let z = 0; z < 6; z += 1) {
    assert(bridgeOutline.wallFrom(0, z, 0, 1) && bridgeOutline.wallFrom(1, z, 0, 1), `tab bridge side walls at row ${z}`)
  }
  assert(bridgeOutline.wallFrom(0, 0, 1, 0) && bridgeOutline.wallFrom(0, 6, 1, 0), 'tab bridge end walls')

  // One-cell islands and holes: four turns the same way round, never a jog.
  still('one-cell tab', (col, row) => (col === 2 && row === 2 ? 3 : 0))
  still('one-cell island on a floor', (col, row) => (col === 2 && row === 2 ? 20 : 5))
  still('one-cell hole', (col, row) => (col === 2 && row === 2 ? 0 : 20))
  still('one-cell-wide wall', (col) => (col === 2 ? 20 : 5))
  still('one-cell-wide slot', (_col, row) => (row === 2 ? 0 : 20))

  // A rectangle's corners are real corners and stay sharp.
  still('rectangular pocket', (col, row) => (col >= 0 && col < 7 && row >= 1 && row < 5 ? 4 : 20))
  still('rectangular part', (col, row) => (col >= 0 && col < 7 && row >= 1 && row < 5 ? 20 : 0))
  // An L-shaped part too: its inside corner turns once, with no turn back.
  still('L-shaped part', (col, row) => (col >= 0 && row >= 0 && (col < 3 || row < 3) && col < 8 && row < 8 ? 20 : 0))

  // Where three faces meet there is no jog to straighten, at the junction or
  // next to it: 20 mm stock, a 5 mm floor, and a 12 mm ledge between them.
  const ledgeAtTurn: HeightField = (col, row) => (col < 0 ? 20 : row >= 0 ? 5 : col === 0 ? 12 : 5)
  still('three faces at the turn', ledgeAtTurn)
  still('three faces at the turn, turned', turned(ledgeAtTurn))
  const ledgePastTurn: HeightField = (col, row) => (row >= 0 ? (col >= 0 ? 5 : 20) : col >= 1 ? 12 : 20)
  still('three faces past the turn', ledgePastTurn)
  still('three faces past the turn, turned', turned(ledgePastTurn))

  // A corner where three walls meet is a junction, not a turn, even when the
  // outline turns back right beside it: 20 mm stock, a 5 mm floor, and a
  // one-cell 30 mm post standing in the corner between them.
  const post: HeightField = (col, row) => (col < 0 ? 20 : row >= 0 ? 5 : col === 0 ? 30 : 5)
  assert(!outlineOf(post).moves(0, 0), 'three walls meeting: the junction must not move')
  assert(!outlineOf(turned(post)).moves(0, 0), 'three walls meeting, turned: the junction must not move')

  // A plateau whose diagonal edge falls away as a steep ramp: tall edges, but
  // slopes the surface shades, not walls.
  const rampOff: HeightField = (col, row) => 60 - 3 * Math.max(0, col - row)
  still('plateau falling away as a ramp', rampOff)
  still('plateau falling away as a ramp, turned', turned(rampOff))

  // Slopes have no walls to move: a finished surface, a V-ridge, a steep ramp
  // across the grid.
  const scallops = ballScallopProfile({
    cells: 40, cellSize: 1, ballRadius: 8.5, stepover: 2.7, phase: 0.4, baseZ: 30, baseSlope: 0.02,
  })
  still('finished surface', (col, row) => scallops[col + 10] + 0.05 * Math.sin(row * 0.6))
  still('V-ridge', (col) => 40 - 3 * Math.abs(col - 3))
  still('steep ramp across the grid', (col, row) => 100 + 1.3 * col + 2.1 * row)
  console.log('thin features and real corners: PASSED')
}

function testSingleJogMovesBothItsCorners(): void {
  console.log('Testing a single jog on a straight wall moves exactly its two corners...')
  // Material at rows >= 0 left of column 0, rows >= 1 from column 0 on: one
  // one-cell jog in a wall along X.
  const jog: HeightField = (col, row) => (row >= (col < 0 ? 0 : 1) ? 20 : 0)
  for (const [name, field, first, second] of [
    ['along X', jog, { x: 0, z: 0, toX: -1, toZ: 1 }, { x: 0, z: 1, toX: 1, toZ: -1 }],
    ['along Z', turned(jog), { x: 0, z: 0, toX: 1, toZ: -1 }, { x: 1, z: 0, toX: -1, toZ: 1 }],
  ] as const) {
    const outline = outlineOf(field)
    for (let z = -5; z <= 5; z += 1) {
      for (let x = -5; x <= 5; x += 1) {
        const drawn = outline.corner(x, z)
        const expected = [first, second].find((corner) => corner.x === x && corner.z === z)
        assertClose(drawn.x - x, expected ? expected.toX * OUTLINE_CORNER_SHIFT_CELLS : 0, 1e-12, `${name}: corner ${x},${z} X offset`)
        assertClose(drawn.z - z, expected ? expected.toZ * OUTLINE_CORNER_SHIFT_CELLS : 0, 1e-12, `${name}: corner ${x},${z} Z offset`)
      }
    }
  }
  console.log('single jog: PASSED')
}

try {
  testShallowScallopIsSlope()
  testTabBridgeAndCutThroughStaySteps()
  testWallsAndSlopesKeepTheirClass()
  testGradientIsContinuousAndExact()
  testGradientLeavesStepsOut()
  testWideningAveragesNarrowScallopsOnly()
  testDiagonalWallIsStraight()
  testCircleWallFollowsTheOutline()
  testThinFeaturesAndRealCornersStayPut()
  testSingleJogMovesBothItsCorners()
  console.log('\nAll heightfield shader tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
