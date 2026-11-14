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
 * Issue #939: the step/slope predicate and the scalar helpers of the surface
 * lighting gradient, run from the shader source itself (see
 * `glslScalar.testSupport.ts`).
 *
 * What runs here is `STEP_GLSL` and `SLOPE_GRADIENT_GLSL` as shipped. The
 * shader's `surfaceNormal` — the thirteen texture lookups and how they are
 * wired into those helpers — is vector GLSL this file cannot run; the
 * `surfaceGradient` helper below restates that wiring in TypeScript. The
 * assembled shaders are covered by the rendered tests in
 * `e2e/viewportViews.smoke.spec.ts`.
 */
import { compileScalarGlsl } from './glslScalar.testSupport'
import { EDGE_CROSSING_STRIDE } from './edgeCrossings'
import {
  OUTLINE_NORMAL_NONE,
  OUTLINE_OFFSET_SCALE,
  OUTLINE_WALL_GLSL,
  SHALLOW_SLOPE_CELLS,
  SLOPE_GRADIENT_GLSL,
  STEP_GLSL,
} from './heightfieldShader'
import { applyMoveToGrid, replayItemsIntoGrid } from './replay'
import type { SimulationGrid, SimulationReplayItem } from './types'

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

  // A one-cell tab against the part, at any height more than half a cell below
  // the part's top. The kerf's drop on the far side of the tab is a wall, not a
  // gradient for the tab-to-part step to continue — otherwise a tall tab's wall
  // turns into a shaded slope.
  for (const tabHeight of [1, 3, 5, 8, 12, 16, 19, 19.4]) {
    const tab = [0, 0, tabHeight, 20, 20]
    assert(edgeIsStep(tab, 1, 1), `kerf to ${tabHeight} mm tab is a step`)
    assert(edgeIsStep(tab, 2, 1), `${tabHeight} mm one-cell tab to part is a step`)
    const mirrored = [...tab].reverse()
    assert(edgeIsStep(mirrored, 1, 1) && edgeIsStep(mirrored, 2, 1), `${tabHeight} mm tab is a step from either side`)
  }

  // The exception: a tab whose top is at or below half a cell under the part's.
  // Its wall up from the kerf is still a wall; its step up to the part is a
  // slope, like any other material-to-material step that shallow.
  for (const tabHeight of [19.5, 19.8]) {
    const nearTopTab = [0, tabHeight, 20, 20]
    assert(edgeIsStep(nearTopTab, 0, 1), `kerf to ${tabHeight} mm tab is a step`)
    assert(!edgeIsStep(nearTopTab, 1, 1), `${tabHeight} mm tab to the 20 mm part is a slope`)
    const mirrored = [...nearTopTab].reverse()
    assert(edgeIsStep(mirrored, 2, 1) && !edgeIsStep(mirrored, 1, 1), `${tabHeight} mm tab is the same from either side`)
  }

  // A cut-through rim is a wall however thin the skin beside it is, including
  // at or below half a cell.
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

  // The bound is in cells and applies to real steps too: a pocket floor more
  // than half a cell down keeps its crisp wall, one at or below half a cell
  // shades as a slope.
  assert(SHALLOW_SLOPE_CELLS === 0.5, 'the cases below are written for a half-cell bound')
  assert(!edgeIsStep([20, 20, 19.6, 19.6], 1, 1), 'a pocket 0.4 cell deep shades as a slope')
  assert(!edgeIsStep([20, 20, 19.5, 19.5], 1, 1), 'a pocket exactly half a cell deep shades as a slope')
  assert(edgeIsStep([20, 20, 19.4, 19.4], 1, 1), 'a pocket 0.6 cell deep keeps its wall')
  assert(!edgeIsStep([19.5, 19.5, 20, 20], 1, 1) && edgeIsStep([19.4, 19.4, 20, 20], 1, 1), 'the same from the pocket side')
  // The same depths on 2 mm cells are 0.2, 0.25 and 0.3 cell: all slopes. A
  // 1 mm step, half a cell, still is; 1.2 mm is a wall.
  assert(!edgeIsStep([20, 20, 19.4, 19.4], 1, 2), 'a 0.6 mm pocket on 2 mm cells is 0.3 cell deep: a slope')
  assert(!edgeIsStep([20, 20, 19, 19], 1, 2), 'a 1 mm pocket on 2 mm cells is exactly half a cell deep: a slope')
  assert(edgeIsStep([20, 20, 18.8, 18.8], 1, 2), 'a 1.2 mm pocket on 2 mm cells keeps its wall')
  const justOver = SHALLOW_SLOPE_CELLS + 0.1
  const justUnder = SHALLOW_SLOPE_CELLS - 0.1
  for (const cellSize of [0.1, 1, 2.5]) {
    assert(edgeIsStep([20, 20, 20 - justOver * cellSize, 20 - justOver * cellSize], 1, cellSize), `${justOver}-cell pocket wall is a step at cell ${cellSize}`)
    assert(!edgeIsStep([20, 20, 20 - justUnder * cellSize, 20 - justUnder * cellSize], 1, cellSize), `${justUnder}-cell step is a slope at cell ${cellSize}`)
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

// ── Issue #973: walls along the cut outline ─────────────────────────────

interface Point { x: number; z: number }

/** Corner offsets and the wall direction, as `OUTLINE_PASS_FRAGMENT_GLSL` unpacks them. */
function unpackCorner(packed: number): { x: number; z: number; direction: number | null } {
  const direction = Math.floor(packed / 65536)
  const zCode = Math.floor((packed - direction * 65536) / 256)
  const xCode = packed - direction * 65536 - zCode * 256
  return {
    x: (xCode - 127) / OUTLINE_OFFSET_SCALE,
    z: (zCode - 127) / OUTLINE_OFFSET_SCALE,
    direction: direction === OUTLINE_NORMAL_NONE ? null : (direction * Math.PI) / 254,
  }
}

/** The shipped corner solve, run against one height field and its crossings. */
function outlineOf(
  height: HeightField,
  crossing: (col: number, row: number, channel: number) => number = () => 0,
  cellSize = 1,
  stockBottomZ = 0,
): {
  /** Where grid corner (x, z) is drawn, in cells. */
  corner: (x: number, z: number) => Point
  /** The wall's line angle at the corner, radians in [0, π), or null. */
  direction: (x: number, z: number) => number | null
  /** Does the corner move at all. */
  moves: (x: number, z: number) => boolean
  /** Is the grid edge leaving the corner in a direction a wall. */
  wallFrom: (x: number, z: number, dirX: number, dirZ: number) => boolean
  /** Every corner in the window that a wall touches. */
  wallCorners: (minX: number, maxX: number, minZ?: number, maxZ?: number) => Array<{ grid: Point; drawn: Point; direction: number | null }>
} {
  const compiled = compileScalarGlsl(`${STEP_GLSL}\n${OUTLINE_WALL_GLSL}`, { cellHeightAt: height, cellCrossing: crossing })
  const solve = (x: number, z: number) => unpackCorner(compiled.outlineCornerSolve(x, z, stockBottomZ, cellSize) as number)
  const wallFrom = (x: number, z: number, dirX: number, dirZ: number): boolean =>
    compiled.wallFrom(x, z, dirX, dirZ, stockBottomZ, cellSize) as boolean
  const corner = (x: number, z: number): Point => { const o = solve(x, z); return { x: x + o.x, z: z + o.z } }
  return {
    corner,
    direction: (x, z) => solve(x, z).direction,
    moves: (x, z) => { const o = solve(x, z); return o.x !== 0 || o.z !== 0 },
    wallFrom,
    wallCorners: (minX, maxX, minZ = minX, maxZ = maxX) => {
      const found: Array<{ grid: Point; drawn: Point; direction: number | null }> = []
      for (let z = minZ; z <= maxZ; z += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          if (wallFrom(x, z, 1, 0) || wallFrom(x, z, -1, 0) || wallFrom(x, z, 0, 1) || wallFrom(x, z, 0, -1)) {
            const o = solve(x, z)
            found.push({ grid: { x, z }, drawn: { x: x + o.x, z: z + o.z }, direction: o.direction })
          }
        }
      }
      return found
    },
  }
}

/** A flat grid of unit cells at the origin, with edge crossings, as `createSimulationGrid` makes one. */
function stampGrid(size: number, top = 20): SimulationGrid {
  return {
    originX: 0, originY: 0, cellSize: 1, cols: size, rows: size, stockBottomZ: 0, stockTopZ: top,
    topZ: new Float32Array(size * size).fill(top),
    edgeCrossings: new Uint8Array(size * size * EDGE_CROSSING_STRIDE),
  }
}

/**
 * The two ways crossings are recorded (issue #973): playback cuts move by move
 * and records as it goes; a static view replays everything, then records them
 * for the final outline. Every stamped test runs both.
 */
type StampMode = 'playback' | 'static'
let stampMode: StampMode = 'playback'
const pendingCuts = new WeakMap<SimulationGrid, SimulationReplayItem[]>()

function cut(
  grid: SimulationGrid, from: { x: number; y: number }, to: { x: number; y: number }, z: number, radius: number,
  toolType: SimulationReplayItem['toolType'] = 'flat_endmill',
): void {
  const move = { kind: 'cut' as const, from: { ...from, z }, to: { ...to, z } }
  if (stampMode === 'playback') {
    applyMoveToGrid(grid, move, radius, toolType, null)
    return
  }
  const items = pendingCuts.get(grid) ?? []
  items.push({
    operationId: 'test', operationName: 'test', toolRef: null, toolType, toolRadius: radius, vBitAngle: null,
    toolpath: { moves: [move] } as unknown as SimulationReplayItem['toolpath'],
  })
  pendingCuts.set(grid, items)
}

/** The stamped grid's outline: heights clamp at the grid's edge like the texture, crossings read 0 there. */
function stampedOutline(grid: SimulationGrid): ReturnType<typeof outlineOf> {
  const pending = pendingCuts.get(grid)
  if (pending) {
    replayItemsIntoGrid(grid, pending)
    pendingCuts.delete(grid)
  }
  const inside = (value: number, count: number) => Math.min(count - 1, Math.max(0, value))
  return outlineOf(
    (col, row) => grid.topZ[inside(row, grid.rows) * grid.cols + inside(col, grid.cols)],
    (col, row, channel) => (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows
      ? 0
      : grid.edgeCrossings![(row * grid.cols + col) * EDGE_CROSSING_STRIDE + channel]),
    grid.cellSize,
    grid.stockBottomZ,
  )
}

function rmsOf(values: number[]): number {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length)
}

/** Angle between two line directions, in degrees, ignoring which way they run. */
function lineAngleDegrees(a: number, b: number): number {
  const difference = Math.abs(a - b) % Math.PI
  return (Math.min(difference, Math.PI - difference) * 180) / Math.PI
}

function testCircularCutFollowsTheTool(): void {
  console.log('Testing a stamped circular slot is drawn on the tool\'s real edge...')
  for (const depth of [-0.1, 6]) {
    const grid = stampGrid(120)
    const centre = { x: 60.3, y: 59.7 }
    const radius = 40
    const tool = 4.3
    const segments = 400
    for (let i = 0; i < segments; i += 1) {
      const a0 = (i / segments) * 2 * Math.PI
      const a1 = ((i + 1) / segments) * 2 * Math.PI
      cut(grid,
        { x: centre.x + radius * Math.cos(a0), y: centre.y + radius * Math.sin(a0) },
        { x: centre.x + radius * Math.cos(a1), y: centre.y + radius * Math.sin(a1) },
        depth, tool)
    }
    const corners = stampedOutline(grid).wallCorners(0, 120)
    assert(corners.length > 600, `circle must have wall corners to check (${corners.length})`)
    // The slot's two edges, as the 400-segment path really cuts them.
    const error = (point: Point): number => {
      const distance = Math.hypot(point.x - centre.x, point.z - centre.y)
      return Math.min(Math.abs(distance - (radius + tool)), Math.abs(distance - (radius - tool)))
    }
    const drawn = corners.map(({ drawn }) => error(drawn))
    const onGrid = corners.map(({ grid: point }) => error(point))
    const lighting = corners.map(({ drawn, direction }) => {
      assert(direction !== null, `corner ${drawn.x},${drawn.z} has a wall direction`)
      // The tangent of a circle about the centre.
      return lineAngleDegrees(direction!, Math.atan2(drawn.z - centre.y, drawn.x - centre.x) + Math.PI / 2)
    })
    assert(rmsOf(drawn) < 0.02, `depth ${depth}: drawn outline rms ${rmsOf(drawn).toFixed(3)} cell must be under 0.02`)
    assert(Math.max(...drawn) < 0.05, `depth ${depth}: every corner within 0.05 cell of the cut (${Math.max(...drawn).toFixed(3)})`)
    assert(rmsOf(onGrid) > 0.3, `depth ${depth}: cell edges are the worse outline (${rmsOf(onGrid).toFixed(3)})`)
    assert(rmsOf(lighting) < 2 && Math.max(...lighting) < 6, `depth ${depth}: walls light along the circle (rms ${rmsOf(lighting).toFixed(2)}°, worst ${Math.max(...lighting).toFixed(2)}°)`)
    console.log(`  depth ${depth}: rms ${rmsOf(onGrid).toFixed(3)} → ${rmsOf(drawn).toFixed(3)} cell, worst ${Math.max(...onGrid).toFixed(3)} → ${Math.max(...drawn).toFixed(3)}; lighting rms ${rmsOf(lighting).toFixed(2)}°`)
  }
  console.log('circular slot: PASSED')
}

function testStraightSlotAtAnyAngle(): void {
  console.log('Testing a straight slot is drawn straight at any angle, and lit along itself...')
  for (const degrees of [0, 4, 17, 30, 45, 63, 88, 135]) {
    const angle = (degrees * Math.PI) / 180
    const grid = stampGrid(64)
    const middle = { x: 32.37, y: 31.79 }
    const tool = 3.2
    const along = { x: Math.cos(angle), y: Math.sin(angle) }
    cut(grid, { x: middle.x - 40 * along.x, y: middle.y - 40 * along.y }, { x: middle.x + 40 * along.x, y: middle.y + 40 * along.y }, -0.1, tool)
    const corners = stampedOutline(grid).wallCorners(8, 56)
    assert(corners.length > 40, `${degrees}°: slot must have wall corners to check (${corners.length})`)
    let worst = 0
    let worstLight = 0
    const errors: number[] = []
    for (const { drawn, direction } of corners) {
      const across = (drawn.x - middle.x) * -along.y + (drawn.z - middle.y) * along.x
      errors.push(Math.abs(Math.abs(across) - tool))
      worst = Math.max(worst, errors[errors.length - 1])
      assert(direction !== null, `${degrees}°: corner ${drawn.x},${drawn.z} has a wall direction`)
      worstLight = Math.max(worstLight, lineAngleDegrees(direction!, angle))
    }
    // Crossings and directions are stored in bytes: 1/254 cell, 1.4°.
    assert(rmsOf(errors) < 0.02, `${degrees}°: the slot's edge drawn within 0.02 cell rms (${rmsOf(errors).toFixed(3)})`)
    assert(worst < 0.05, `${degrees}°: every corner within 0.05 cell of the slot's edge (worst ${worst.toFixed(3)} cell)`)
    console.log(`  ${degrees}°: rms ${rmsOf(errors).toFixed(3)}, worst ${worst.toFixed(3)} cell off the edge; lighting within ${worstLight.toFixed(2)}°`)
    assert(worstLight < 1.5, `${degrees}°: walls light along the slot (worst ${worstLight.toFixed(2)}°)`)
  }
  console.log('straight slot: PASSED')
}

function testBallBottomingOutEndsOnItsRealEdge(): void {
  console.log('Testing a ball nose that cuts through ends where it leaves the stock bottom...')
  // A 6-cell ball, its tip 1 below the stock bottom: through where its surface
  // is under the bottom, out to sqrt(6² - 5²) from its path, then a thin skin.
  const grid = stampGrid(64)
  const ball = 6
  cut(grid, { x: -10, y: 30.43 }, { x: 74, y: 30.43 }, -1, ball, 'ball_endmill')
  const edge = Math.sqrt(ball * ball - (ball - 1) * (ball - 1))
  const outline = stampedOutline(grid)
  const corners = outline.wallCorners(4, 60).filter(({ drawn }) => Math.abs(Math.abs(drawn.z - 30.43) - edge) < 1)
  assert(corners.length > 80, `the through cut must have edge corners to check (${corners.length})`)
  const errors = corners.map(({ drawn }) => Math.abs(Math.abs(drawn.z - 30.43) - edge))
  assert(Math.max(...errors) < 0.03, `every corner on the through cut's real edge (worst ${Math.max(...errors).toFixed(3)} cell)`)
  console.log('ball through cut: PASSED')
}

function testMaterialCornersStaySharp(): void {
  console.log('Testing where two cuts cross, the corners left between them stay sharp...')
  const grid = stampGrid(64)
  const tool = 3
  const row = 30.3
  const column = 31.6
  cut(grid, { x: -10, y: row }, { x: 74, y: row }, -0.1, tool)
  cut(grid, { x: column, y: -10 }, { x: column, y: 74 }, -0.1, tool)
  // Away from the grid's border, where the slots leave the stock.
  const corners = stampedOutline(grid).wallCorners(2, 62)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const sharp = { x: column + sx * tool, z: row + sz * tool }
      const nearest = Math.min(...corners.map(({ drawn }) => Math.hypot(drawn.x - sharp.x, drawn.z - sharp.z)))
      assert(nearest < 0.05, `a corner sits on the sharp corner at ${sharp.x},${sharp.z} (nearest ${nearest.toFixed(3)} cell)`)
    }
  }
  // Every corner lies on one of the four edges the two slots leave.
  const worst = Math.max(...corners.map(({ drawn }) => Math.min(
    Math.abs(Math.abs(drawn.z - row) - tool) + Math.max(0, tool - Math.abs(drawn.x - column)),
    Math.abs(Math.abs(drawn.x - column) - tool) + Math.max(0, tool - Math.abs(drawn.z - row)),
  )))
  assert(worst < 0.05, `every corner on the cut's real edge (worst ${worst.toFixed(3)} cell)`)
  console.log('sharp corners: PASSED')
}

function testTabBridgeKeepsItsWidth(): void {
  console.log('Testing a stamped tab bridge narrower than a cell keeps its walls and its real width (#829)...')
  for (const width of [0.8, 0.3]) {
    const grid = stampGrid(64)
    const tool = 3
    // The bridge runs along Z around column 30's centre, between two through slots.
    const left = 30.5 - width / 2
    const right = 30.5 + width / 2
    cut(grid, { x: left - tool, y: -10 }, { x: left - tool, y: 74 }, -0.1, tool)
    cut(grid, { x: right + tool, y: -10 }, { x: right + tool, y: 74 }, -0.1, tool)
    const outline = stampedOutline(grid)
    for (let z = 10; z < 50; z += 1) {
      assert(outline.wallFrom(30, z, 0, 1) && outline.wallFrom(31, z, 0, 1), `width ${width}: bridge side walls at row ${z}`)
      const drawnWidth = outline.corner(31, z).x - outline.corner(30, z).x
      assert(Math.abs(drawnWidth - width) < 0.02, `width ${width}: drawn bridge ${drawnWidth.toFixed(3)} wide at row ${z}`)
    }
  }
  console.log('tab bridge: PASSED')
}

function testPassesAtOneDepthUnite(): void {
  console.log('Testing two passes at one depth leave the wall on the outer one, in either order...')
  for (const depth of [-0.1, 8]) {
    for (const outerFirst of [false, true]) {
      const grid = stampGrid(48)
      const passes = [20.2, 20.53]
      if (outerFirst) passes.reverse()
      for (const y of passes) cut(grid, { x: -10, y }, { x: 58, y }, depth, 3)
      const corners = stampedOutline(grid).wallCorners(6, 42, 21, 26)
      assert(corners.length > 20, `depth ${depth}: the outer edge must have corners (${corners.length})`)
      for (const { drawn } of corners) {
        // The inner pass's edge is a third of a cell nearer; bytes hold 1/254 cell.
        assertClose(drawn.z, 23.53, 0.02, `depth ${depth}, outer ${outerFirst ? 'first' : 'second'}: corner at x ${drawn.x} on the outer pass's edge`)
      }
    }
  }
  console.log('passes at one depth: PASSED')
}

function testWithoutCrossingsNothingMoves(): void {
  console.log('Testing that with no crossings recorded, a tab bridge, islands, holes and real corners stay on cell edges...')
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

  // One-cell islands and holes.
  still('one-cell tab', (col, row) => (col === 2 && row === 2 ? 3 : 0))
  still('one-cell island on a floor', (col, row) => (col === 2 && row === 2 ? 20 : 5))
  still('one-cell hole', (col, row) => (col === 2 && row === 2 ? 0 : 20))
  still('one-cell-wide wall', (col) => (col === 2 ? 20 : 5))
  still('one-cell-wide slot', (_col, row) => (row === 2 ? 0 : 20))

  // A rectangle's corners stay sharp.
  still('rectangular pocket', (col, row) => (col >= 0 && col < 7 && row >= 1 && row < 5 ? 4 : 20))
  still('rectangular part', (col, row) => (col >= 0 && col < 7 && row >= 1 && row < 5 ? 20 : 0))
  // An L-shaped part too.
  still('L-shaped part', (col, row) => (col >= 0 && row >= 0 && (col < 3 || row < 3) && col < 8 && row < 8 ? 20 : 0))

  // Where three faces meet: 20 mm stock, a 5 mm floor, and a 12 mm ledge.
  const ledgeAtTurn: HeightField = (col, row) => (col < 0 ? 20 : row >= 0 ? 5 : col === 0 ? 12 : 5)
  still('three faces at the turn', ledgeAtTurn)
  still('three faces at the turn, turned', turned(ledgeAtTurn))
  const ledgePastTurn: HeightField = (col, row) => (row >= 0 ? (col >= 0 ? 5 : 20) : col >= 1 ? 12 : 20)
  still('three faces past the turn', ledgePastTurn)
  still('three faces past the turn, turned', turned(ledgePastTurn))

  // Three walls meeting at a one-cell 30 mm post in the corner.
  const post: HeightField = (col, row) => (col < 0 ? 20 : row >= 0 ? 5 : col === 0 ? 30 : 5)
  assert(!outlineOf(post).moves(0, 0), 'three walls meeting: the junction must not move')
  assert(!outlineOf(turned(post)).moves(0, 0), 'three walls meeting, turned: the junction must not move')

  // A plateau whose diagonal edge falls away as a steep ramp: tall edges, but
  // slopes the surface shades, not walls.
  const rampOff: HeightField = (col, row) => 60 - 3 * Math.max(0, col - row)
  still('plateau falling away as a ramp', rampOff)
  still('plateau falling away as a ramp, turned', turned(rampOff))

  // Slopes have no walls: a finished surface, a V-ridge, a steep ramp.
  const scallops = ballScallopProfile({
    cells: 40, cellSize: 1, ballRadius: 8.5, stepover: 2.7, phase: 0.4, baseZ: 30, baseSlope: 0.02,
  })
  still('finished surface', (col, row) => scallops[col + 10] + 0.05 * Math.sin(row * 0.6))
  still('V-ridge', (col) => 40 - 3 * Math.abs(col - 3))
  still('steep ramp across the grid', (col, row) => 100 + 1.3 * col + 2.1 * row)
  console.log('no crossings, nothing moves: PASSED')
}


try {
  testShallowScallopIsSlope()
  testTabBridgeAndCutThroughStaySteps()
  testWallsAndSlopesKeepTheirClass()
  testGradientIsContinuousAndExact()
  testGradientLeavesStepsOut()
  testWideningAveragesNarrowScallopsOnly()
  for (const mode of ['playback', 'static'] as const) {
    stampMode = mode
    console.log(`\n— crossings recorded as in ${mode === 'playback' ? 'playback (move by move)' : 'a static view (after the replay)'} —`)
    testCircularCutFollowsTheTool()
    testStraightSlotAtAnyAngle()
    testBallBottomingOutEndsOnItsRealEdge()
    testMaterialCornersStaySharp()
    testTabBridgeKeepsItsWidth()
    testPassesAtOneDepthUnite()
  }
  testWithoutCrossingsNothingMoves()
  console.log('\nAll heightfield shader tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
