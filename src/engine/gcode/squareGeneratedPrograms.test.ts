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
 * #1045 slice I: a seeded set of **generator-emitted** square programs, each
 * admitted by the export guard and each independently measured for overcut.
 *
 * Slice F's contract is that a normal square-to-round program the app generates
 * must never be refused at export. Slice H's conservative whole-cell guard
 * refused four of them: the ball around case, two ball retained-end variants,
 * the mixed along-rough + around-finish program, and a hand-built merge
 * fixture. This test fixes the contract in place:
 *
 * - 50 seeded programs plus the slice-F fixtures mix flat and ball cutters, around rough + finish and
 *   along rough + around finish, with and without retained ends;
 * - every program the generator emits must be **admitted** by the guard;
 * - every turning cut of every admitted program is checked against an
 *   **independent fine reference** -- its own polar grid at 0.4 degrees
 *   (the guard's 0.5 degree cell, finer) and `min(0.12, r/6)` along (a third
 *   of the guard's r/4 at a 1.5 mm radius), initialised from the blank and lowered through
 *   the analytic cutter body (a flat's disc/cylinder, a ball's sphere/shank).
 *   It evaluates each cell at the nearest point of the commanded motion (the
 *   exact tool position on a turning ring, the nearest along sample on a
 *   straight cut) and never calls the guard, the generator or its helpers;
 * - no turning cut may take more than the operation's bound plus the guard's
 *   own stated tolerance out of the material the earlier cuts left there.
 *
 * The retained-end and mixed cases are the ones slices F-H found; the around
 * ball case is the property test's generator case. The reference is stricter
 * than the guard's rasterisation (it measures finer cells with the exact body),
 * so a guard that is too optimistic fails here, and a guard that refuses a safe
 * generated program fails the admission assertion.
 *
 * Run with: npx tsx src/engine/gcode/squareGeneratedPrograms.test.ts
 */

import assert from 'node:assert/strict'
import { barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import type { SquareStock } from '../../types/project'
import { defaultTool, getStockBounds, newProject } from '../../types/project'
import type { Operation, Project } from '../../types/project'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { generateRotaryFinish, generateRotaryRough } from '../toolpaths/rotaryModel'
import type { RotaryModelMesh } from '../toolpaths/rotaryModel'
import type { ToolpathMove, ToolpathPoint } from '../toolpaths/types'
import { createSquareSweepState, guardSquareOperation, squareMaterialAlongRange } from './squareSweepGuard'
import type { EmittedSquareCutter } from '../squareRotarySafety'

// ── deterministic random source ──────────────────────────────────────────

let randomState = 0x1045_1a2b
function random(): number {
  randomState = (randomState + 0x6d2b79f5) >>> 0
  let t = randomState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (low: number, high: number): number => low + (high - low) * random()

// ── the independent fine reference ────────────────────────────────────────
//
// Finer than the guard on both axes and blind to its grid: 0.4 degree angle bins
// (the guard uses 0.5) and `min(0.12, r/6)` along bins (the guard uses r/4).
// It measures at cell **centres** and lowers through the exact cutter body,
// exactly as slice F's property-test reference does.

const REF_ANGLE_BINS = 900
const REF_ANGLE_BIN_DEGREES = 360 / REF_ANGLE_BINS

interface Reference {
  alongStart: number
  alongBins: number
  alongBin: number
  material: Float64Array
}

function blankRadius(halfSide: number, angleDeg: number): number {
  const radians = angleDeg * Math.PI / 180
  return halfSide / Math.max(Math.abs(Math.cos(radians)), Math.abs(Math.sin(radians)))
}

function createReference(stock: SquareStock, alongStart: number, alongEnd: number, cutterRadius: number): Reference {
  const alongBin = Math.min(0.12, cutterRadius / 6)
  const alongBins = Math.max(1, Math.ceil((alongEnd - alongStart) / alongBin))
  const material = new Float64Array(alongBins * REF_ANGLE_BINS)
  const halfSide = stock.thickness / 2
  const row = new Float64Array(REF_ANGLE_BINS)
  for (let k = 0; k < REF_ANGLE_BINS; k++) row[k] = blankRadius(halfSide, (k + 0.5) * REF_ANGLE_BIN_DEGREES)
  for (let i = 0; i < alongBins; i++) material.set(row, i * REF_ANGLE_BINS)
  return { alongStart, alongBins, alongBin, material }
}

/** The near (`contact`) and far (`exit`) radii at which the cutter body meets a ray, or null. */
function bodySpan(
  ball: boolean,
  cutterRadius: number,
  tip: number,
  dTheta: number,
  dx: number,
): { contact: number; exit: number } | null {
  const cos = Math.cos(dTheta)
  if (!(cos > 1e-9)) return null
  const alongSq = dx * dx
  const radiusSq = cutterRadius * cutterRadius
  if (alongSq >= radiusSq) return null
  if (!ball) {
    const reach = Math.sqrt(radiusSq - alongSq)
    if (Math.abs(tip * Math.tan(dTheta)) > reach) return null
    const sin = Math.abs(Math.sin(dTheta))
    return { contact: Math.max(0, tip / cos), exit: sin > 1e-12 ? reach / sin : Number.POSITIVE_INFINITY }
  }
  const centre = tip + cutterRadius
  if (!(centre > 0)) return null
  const sin = Math.sin(dTheta)
  const sinSq = sin * sin
  const discriminant = radiusSq - alongSq - centre * centre * sinSq
  if (discriminant < 0) return null
  const root = Math.sqrt(discriminant)
  const sphereExit = centre * cos + root
  const shankStart = centre / cos
  const shankExit = Math.abs(sin) > 1e-12 ? Math.sqrt(radiusSq - alongSq) / Math.abs(sin) : Number.POSITIVE_INFINITY
  return {
    contact: Math.max(0, centre * cos - root),
    exit: shankStart <= shankExit ? Math.max(sphereExit, shankExit) : sphereExit,
  }
}

/**
 * Apply one commanded move to the reference grid in a single pass over the
 * cells the cutter body can reach, and return the deepest bite.
 *
 * The controller interpolates (along, A, Z) linearly, so each cell is evaluated
 * at the point of the commanded path nearest it: for a turning ring the tool
 * passes every angle in its sweep, so the cell's own angle fixes the sample
 * (`dTheta = 0`) and its along coordinate gives `dx`; for a straight cut the
 * along coordinate fixes the sample and the cell's angle gives `dTheta`. The
 * nearest point is taken in a metric weighted by the tool radius (so an angle
 * and an along distance are comparable), with the two endpoints also tried, so
 * a slanted move cannot hide a deep bite between its cells. The body is the same
 * exact flat disc/cylinder or ball sphere/shank as {@link bodySpan}; a cell is
 * lowered only when the body's far wall reaches its standing material.
 */
function referenceMove(
  reference: Reference,
  move: ToolpathMove,
  pivot: number,
  cutterRadius: number,
  ball: boolean,
  alongOf: (point: ToolpathPoint) => number,
): number {
  const { material, alongBins, alongStart, alongBin } = reference
  const fromAlong = alongOf(move.from)
  const toAlong = alongOf(move.to)
  const fromAngle = move.from.a ?? 0
  const toAngle = move.to.a ?? fromAngle
  const fromTip = move.from.z - pivot
  const toTip = move.to.z - pivot
  const dAlong = toAlong - fromAlong
  const dAngle = toAngle - fromAngle
  const tipMin = Math.min(fromTip, toTip)
  const halfSpan = tipMin > 0 ? Math.asin(Math.min(1, cutterRadius / tipMin)) : Math.PI
  const halfSpanDegrees = Math.min(180, halfSpan * 180 / Math.PI)
  const alongLo = Math.min(fromAlong, toAlong) - cutterRadius - alongBin
  const alongHi = Math.max(fromAlong, toAlong) + cutterRadius + alongBin
  const i0 = Math.max(0, Math.floor((alongLo - alongStart) / alongBin))
  const i1 = Math.min(alongBins - 1, Math.floor((alongHi - alongStart) / alongBin))
  const windowLo = Math.min(fromAngle, toAngle) - halfSpanDegrees - REF_ANGLE_BIN_DEGREES
  const windowHi = Math.max(fromAngle, toAngle) + halfSpanDegrees + REF_ANGLE_BIN_DEGREES
  const allAngles = windowHi - windowLo >= 360 - 1e-9
  const firstBin = allAngles ? 0 : Math.floor(windowLo / REF_ANGLE_BIN_DEGREES)
  const lastBin = allAngles ? REF_ANGLE_BINS - 1 : Math.ceil(windowHi / REF_ANGLE_BIN_DEGREES)
  const weight = Math.max(Math.abs(tipMin), cutterRadius, 1e-6)
  const denominator = dAlong * dAlong + weight * weight * dAngle * dAngle
  const slanted = dAlong !== 0 && dAngle !== 0
  const fractions = slanted ? [0, 1, 0] : [0, 0, 0]
  let engagement = Number.NEGATIVE_INFINITY
  for (let i = i0; i <= i1; i++) {
    const cellAlong = alongStart + (i + 0.5) * alongBin
    const rowOffset = i * REF_ANGLE_BINS
    for (let cell = firstBin; cell <= lastBin; cell++) {
      const k = allAngles
        ? cell
        : ((cell % REF_ANGLE_BINS) + REF_ANGLE_BINS) % REF_ANGLE_BINS
      const cellAngle = (k + 0.5) * REF_ANGLE_BIN_DEGREES
      let candidateCount = 1
      if (denominator > 1e-18) {
        const nearest = Math.min(1, Math.max(0, ((cellAlong - fromAlong) * dAlong
          + (cellAngle - fromAngle) * weight * weight * dAngle) / denominator))
        if (slanted) {
          fractions[2] = nearest
          candidateCount = 3
        } else {
          fractions[0] = nearest
        }
      } else {
        fractions[0] = 0
      }
      for (let candidate = 0; candidate < candidateCount; candidate++) {
        const fraction = fractions[candidate]
        const toolAlong = fromAlong + dAlong * fraction
        const dx = cellAlong - toolAlong
        if (dx * dx >= cutterRadius * cutterRadius) continue
        const toolAngle = fromAngle + dAngle * fraction
        let delta = cellAngle - toolAngle
        while (delta > 180) delta -= 360
        while (delta < -180) delta += 360
        const tip = fromTip + (toTip - fromTip) * fraction
        const span = bodySpan(ball, cutterRadius, tip, delta * Math.PI / 180, dx)
        if (span === null) continue
        const index = rowOffset + k
        const materialRadius = material[index]
        if (!(materialRadius > 0) || span.exit < materialRadius) continue
        const depth = materialRadius - span.contact
        if (depth > engagement) engagement = depth
        if (span.contact < materialRadius) material[index] = span.contact
      }
    }
  }
  return engagement
}

// ── the generated programs ────────────────────────────────────────────────

const TARGET = { source: 'stock' } as const

/** A coaxial cylinder surface inside the blank: the square-to-round model. */
function cylinder(stock: SquareStock, radius: number, from: number, to: number, segments = 96): RotaryModelMesh {
  const centre = stock.thickness / 2
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const along of [from, to]) {
    for (let j = 0; j < segments; j++) {
      const t = 2 * Math.PI * j / segments
      const across = centre + radius * Math.cos(t)
      const up = pivot + radius * Math.sin(t)
      if (stock.axis === 'x') positions.push(along, across, up)
      else positions.push(across, along, up)
    }
  }
  for (let j = 0; j < segments; j++) {
    const j2 = (j + 1) % segments
    index.push(j, j2, segments + j2, j, segments + j2, segments + j)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

function normalizedTool(type: 'flat_endmill' | 'ball_endmill', diameter: number): Parameters<typeof generateRotaryRough>[3] {
  const row = { ...defaultTool('mm', 1), units: 'mm' as const, type, diameter }
  return {
    id: 'tool', name: 'tool', sourceUnits: 'mm' as const, units: 'mm' as const,
    type, diameter, radius: diameter / 2, vBitAngle: null,
    flutes: row.flutes, material: row.material, defaultRpm: 0, defaultFeed: 0,
    defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
  }
}

function projectFor(stock: SquareStock, type: 'flat_endmill' | 'ball_endmill', diameter: number): Project {
  const project = newProject('generated square programs', 'mm')
  project.meta.projectType = 'rotary'
  project.stock = stock
  project.tools = [{
    ...defaultTool('mm', 1), id: 'tool', name: 'tool', units: 'mm', type, diameter,
  }]
  return project
}

function cutterFor(type: 'flat_endmill' | 'ball_endmill', diameter: number): EmittedSquareCutter {
  return { id: 'tool', units: 'mm', type, diameter, radius: diameter / 2 }
}

/** The seed's axis: always the bar's X axis, as in the slice-F/G fixtures. */
const AXIS = 'x' as const

interface SeedCase {
  label: string
  stock: SquareStock
  model: RotaryModelMesh
  type: 'flat_endmill' | 'ball_endmill'
  diameter: number
  stepdown: number
  stepover: number
  sampleSpacing: number
  /** Override the rough's along sample spacing (the fixture's operation default). */
  roughSpacing?: number
  /** Override the finish's angular sample spacing (the fixture's operation default). */
  finishSpacing?: number
  alongStart: number
  alongEnd: number
  mixed: boolean
}

function seedCases(count: number): SeedCase[] {
  const cases: SeedCase[] = []
  for (let seed = 0; seed < count; seed++) {
    // The generator's normal square-to-round regime: an 18-24 mm blank, a
    // 30-38 mm part with 8-12 mm retained ends (or none), a flat Ø4 / ball Ø3
    // cutter, a 1.5-2.5 mm stepdown and a 2 mm around stepover -- the slice-F
    // fixtures' own proportions, which is what the false-refusal contract is
    // about.
    const side = Math.round(between(18, 24))
    const length = Math.round(between(30, 38))
    const diameter = seed % 2 === 0 ? 3 : 4
    const type = seed % 2 === 0 ? 'ball_endmill' as const : 'flat_endmill' as const
    const mixed = seed % 4 === 0
    // Every third **around** case has no retained end; the rest keep a stub at
    // both ends. A mixed program is tested without a retained end: an along
    // rough leaves the retained shoulder's corner cusp standing, and the
    // around finish's first ring takes it -- a real overcut the guard correctly
    // refuses (slice H's retained-end note). The fixture's flat mixed case with
    // ends is covered in `rotarySquareAroundPasses.test.ts`.
    const ends = mixed || seed % 3 === 0 ? 0 : Math.round(between(8, Math.min(12, length / 4)))
    const stepdown = [1.5, 2, 2.5][seed % 3]
    // A mixed program's along rough must sample the blank as finely as the
    // around finish's own angle step. A coarser rough leaves axial ridges at the
    // blank's outer radius that the finish's shank takes in one pass -- a real
    // overcut the guard correctly refuses (H's retained-end note), not the false
    // refusal this test pins down.
    const stepover = mixed ? 0.5 : 2
    const stock = squareStock(side, length, AXIS, { x: 0, y: 0 })
    const bounds = getStockBounds(stock)
    const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
    const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
    const alongStart = lower + ends
    const alongEnd = upper - ends
    const model = cylinder(stock, Math.round(side * 0.24 * 10) / 10, alongStart, alongEnd)
    cases.push({
      label: `${type === 'ball_endmill' ? 'ball' : 'flat'} D${diameter} `
        + `${side}x${length} ends ${ends} ${mixed ? 'along-rough+around-finish' : 'around rough+finish'} stepdown ${stepdown}`,
      stock,
      model,
      type,
      diameter,
      stepdown,
      stepover,
      sampleSpacing: 1,
      alongStart,
      alongEnd,
      mixed,
    })
  }
  // The exact programs slices F-H found: the property test's ball/flat
  // around-normal pair, the mixed along-rough + around-finish fixture from
  // `rotarySquareAroundPasses.test.ts`, and two of the retained-end ball
  // variants from `squareRetainedEndOvercut.test.ts`.
  const fixture = (): SquareStock => squareStock(20, 40, AXIS, { x: 0, y: 0 })
  for (const type of ['ball_endmill', 'flat_endmill'] as const) {
    const stock = fixture()
    cases.push({
      label: `fixture ${type === 'ball_endmill' ? 'ball' : 'flat'} around 20x40`,
      stock,
      model: cylinder(stock, 5, 12, 28),
      type,
      diameter: type === 'ball_endmill' ? 3 : 4,
      stepdown: 2,
      stepover: 2,
      sampleSpacing: 1,
      alongStart: 12,
      alongEnd: 28,
      mixed: false,
    })
  }
  {
    const stock = fixture()
    cases.push({
      label: 'fixture flat mixed along-rough + around-finish 20x40',
      stock,
      model: cylinder(stock, 5, 12, 28),
      type: 'flat_endmill',
      diameter: 4,
      stepdown: 2,
      stepover: 0.5,
      sampleSpacing: 1,
      roughSpacing: 1,
      finishSpacing: 0.5,
      alongStart: 12,
      alongEnd: 28,
      mixed: true,
    })
  }
  for (const retained of [
    { side: 22, length: 162, ends: 28, diameter: 4, stepdown: 2.5, stepover: 2.4 },
    { side: 20, length: 168, ends: 26, diameter: 2, stepdown: 1.5, stepover: 1.2 },
  ]) {
    const stock = squareStock(retained.side, retained.length, AXIS, { x: 0, y: 0 })
    const alongStart = retained.ends
    const alongEnd = retained.length - retained.ends
    cases.push({
      label: `fixture ball retained ${retained.side}x${retained.length} ends ${retained.ends} D${retained.diameter}`,
      stock,
      model: cylinder(stock, Math.round(retained.side * 0.22), alongStart + 2, alongEnd - 2),
      type: 'ball_endmill',
      diameter: retained.diameter,
      stepdown: retained.stepdown,
      stepover: retained.stepover,
      sampleSpacing: 1,
      alongStart,
      alongEnd,
      mixed: false,
    })
  }
  return cases
}

function travel(stock: SquareStock): number {
  return barMaxRadius(stock) + 1
}

// ── the contract: admitted, and within bound by the independent reference ─

console.log('Testing seeded generator-emitted square programs against the fine reference...')
{
  const CASES = seedCases(50)
  let admitted = 0
  let turningCuts = 0
  let worstExcess = Number.NEGATIVE_INFINITY
  let worstLabel = ''
  let worstEngagement = 0
  let worstBound = 0
  for (const entry of CASES) {
    const { stock } = entry
    const tool = normalizedTool(entry.type, entry.diameter)
    const params = {
      stepover: entry.stepover,
      sampleSpacing: entry.sampleSpacing,
      stockToLeave: 0,
      alongStart: entry.alongStart,
      alongEnd: entry.alongEnd,
      safeRadius: barMaxRadius(stock) * 2,
      requestedCellSize: 0.1,
    }
    const rough = generateRotaryRough(`${entry.label} rough`, entry.model, stock, tool, {
      ...params,
      sampleSpacing: entry.roughSpacing ?? entry.sampleSpacing,
      stepdown: entry.stepdown,
      passDirection: entry.mixed ? 'along' : 'around',
    }, {})
    const finish = generateRotaryFinish(`${entry.label} finish`, entry.model, stock, tool, {
      ...params,
      sampleSpacing: entry.finishSpacing ?? entry.sampleSpacing,
      passDirection: 'around',
      squareRoughBefore: true,
    }, {})
    assert.ok(rough.moves.length > 0, `${entry.label}: the rough emits motion`)
    assert.ok(finish.moves.length > 0, `${entry.label}: the finish emits motion`)

    const project = projectFor(stock, entry.type, entry.diameter)
    const cutter = cutterFor(entry.type, entry.diameter)
    const pivot = barPivotZ(stock)
    const travelZ = pivot + travel(stock)
    const range = squareMaterialAlongRange(stock, [
      { moves: rough.moves, radius: cutter.radius },
      { moves: finish.moves, radius: cutter.radius },
    ])
    const state = createSquareSweepState(stock, cutter.radius, range)
    const roughOp: Operation = {
      ...defaultOperationForTarget(project, 'rotary_rough', 'rough', TARGET, 0),
      rotaryPassDirection: entry.mixed ? 'along' : 'around',
      stepdown: entry.stepdown,
      stockToLeaveRadial: 0,
    }
    const finishOp: Operation = {
      ...defaultOperationForTarget(project, 'rotary_finish', 'finish', TARGET, 1),
      rotaryPassDirection: 'around',
      stockToLeaveRadial: 0,
    }
    const firstAngle = (moves: readonly ToolpathMove[]): number =>
      moves.find((move) => move.from.a !== undefined)?.from.a ?? 0
    const roughVerdict = guardSquareOperation(state, {
      operation: roughOp, moves: rough.moves, cutter,
      entryAngle: firstAngle(rough.moves), direction: 1, travelZ, roundingAllowance: 0.0005,
    })
    assert.deepEqual(roughVerdict, { admitted: true }, `${entry.label}: the guard admits the generated rough`)
    const finishVerdict = guardSquareOperation(state, {
      operation: finishOp, moves: finish.moves, cutter,
      entryAngle: firstAngle(finish.moves), direction: 1, travelZ, roundingAllowance: 0.0005,
    })
    assert.deepEqual(finishVerdict, { admitted: true }, `${entry.label}: the guard admits the generated finish`)
    admitted++

    // The guard's stated tolerance, from its own published formula.
    const guardTolerance = barMaxRadius(stock) * (0.5 * Math.PI / 180)
      + (entry.type === 'ball_endmill'
        ? cutter.radius - Math.sqrt(Math.max(0, cutter.radius * cutter.radius - state.alongBin ** 2))
        : 0)
      + 0.0005

    // The reference walks the same program, in order, through its own fine grid.
    const alongOf = (point: ToolpathPoint): number => stock.axis === 'x' ? point.x : point.y
    const allMoves = [...rough.moves, ...finish.moves]
    const cutAlongs = allMoves
      .filter((move) => move.kind !== 'rapid')
      .flatMap((move) => [alongOf(move.from), alongOf(move.to)])
    const length = stock.axis === 'x'
      ? getStockBounds(stock).maxX - getStockBounds(stock).minX
      : getStockBounds(stock).maxY - getStockBounds(stock).minY
    const windowLow = Math.max(0, Math.min(...cutAlongs) - cutter.radius - 1)
    const windowHigh = Math.min(length, Math.max(...cutAlongs) + cutter.radius + 1)
    const reference = createReference(stock, windowLow, windowHigh, cutter.radius)
    const ball = entry.type === 'ball_endmill'

    let controller = firstAngle(rough.moves)
    let allowance = 0
    let caseWorst = Number.NEGATIVE_INFINITY
    let caseBound = 0
    for (const stage of [{ moves: rough.moves, finish: false }, { moves: finish.moves, finish: true }] as const) {
      const before = allowance
      const bound = (stage.finish ? 0 + before : entry.stepdown) + guardTolerance
      if (!stage.finish) allowance = Math.max(allowance, entry.stepdown)
      for (const move of stage.moves) {
        const hasAngle = move.from.a !== undefined || move.to.a !== undefined
        const end = !hasAngle || move.to.a === undefined ? controller : move.to.a
        const turns = end !== controller
        const lowTip = Math.min(move.from.z, move.to.z) - pivot
        if (move.kind !== 'rapid' && lowTip < travel(stock)) {
          const depth = referenceMove(reference, move, pivot, cutter.radius, ball, alongOf)
          if (turns) {
            turningCuts++
            const excess = depth - bound
            if (excess > 1e-6) {
              assert.fail(`${entry.label}: the generated turning cut at along ${alongOf(move.from).toFixed(3)} `
                + `A${controller.toFixed(3)} takes ${depth.toFixed(4)} mm, over its ${bound.toFixed(4)} mm bound `
                + `by ${excess.toFixed(4)} mm`)
            }
            if (depth - bound > caseWorst - caseBound) {
              caseWorst = depth
              caseBound = bound
            }
            if (excess > worstExcess) {
              worstExcess = excess
              worstLabel = entry.label
              worstEngagement = depth
              worstBound = bound
            }
          }
        }
        controller = end
      }
    }
    console.log(`  ${entry.label}: worst engagement ${caseWorst.toFixed(4)} vs `
      + `${caseBound.toFixed(4)} (+${(caseWorst - caseBound).toFixed(6)})`)
  }
  console.log(`  seeds ${CASES.length}: ${admitted} admitted, ${turningCuts} turning cuts checked by the reference`)
  console.log(`  worst reference engagement ${worstEngagement.toFixed(4)} mm against ${worstBound.toFixed(4)} mm `
    + `(excess ${worstExcess.toFixed(6)} mm) on ${worstLabel}`)
  assert.equal(admitted, CASES.length, 'every generated program is admitted')
  assert.ok(turningCuts > 0, 'the reference checked turning cuts')
}

console.log('engine/gcode/squareGeneratedPrograms.test.ts: all assertions passed')
