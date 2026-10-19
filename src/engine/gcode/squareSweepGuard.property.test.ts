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
 * #1045 slice F: a seeded property test of the square guard against an
 * independent standing-material reference.
 *
 * Every seed builds a random square blank (side 10-60 mm, length 20-1,000 mm), a
 * random flat or ball cutter (0.2-12 mm diameter) and a program of 1-4
 * operations mixing non-turning (along) cuts and turning (around) cuts at
 * random tip radii and A spans, including sweeps beyond a full turn, with
 * random stepdown and radial stock to leave. The guard decides whether the
 * program may post. The reference then asks the queued programs the question
 * the guard is supposed to have answered:
 *
 * > does any turning cut remove more radial material than the operation's own
 * > bound, at any point of its commanded sweep?
 *
 * The reference is written independently of `squareSweepGuard.ts`. It keeps its
 * own **finer** standing-material grid (0.5 degree angle bins by 0.25 mm along
 * bins over the cut window, against the guard's 0.5 degree by `r/4`), initialised
 * from the blank's own boundary and lowered through the **exact cutter body**:
 * a flat's disc `tip / cos(dTheta)` with its cylinder exit, a ball's sphere near
 * and far roots. It samples the commanded motion at no coarser than one of its
 * own cells, so an engagement that peaks between two of the guard's samples is
 * still seen. It never calls the guard, `sampleRotaryModel`, or any generator
 * helper.
 *
 * The contract asserted is conservativeness: **every program the guard admits
 * is safe in the reference** — no turning cut exceeds its operation's bound plus
 * the guard's own stated tolerance. The test also reports the false-refusal rate
 * on programs the generator itself emits for a normal square-to-round
 * rough + finish, which must be zero.
 *
 * Run with: npx tsx src/engine/gcode/squareSweepGuard.property.test.ts
 */

import assert from 'node:assert/strict'
import { barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import type { SquareStock } from '../../types/project'
import type { Operation, OperationTarget, Project } from '../../types/project'
import { defaultTool, getStockBounds, newProject } from '../../types/project'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { generateRotaryFinish, generateRotaryRough } from '../toolpaths/rotaryModel'
import type { RotaryModelMesh } from '../toolpaths/rotaryModel'
import { createSquareSweepState, guardSquareOperation } from './squareSweepGuard'
import type { SquareGuardVerdict } from './squareSweepGuard'
import type { EmittedSquareCutter } from '../squareRotarySafety'
import type { ToolpathMove, ToolpathPoint } from '../toolpaths/types'

// ── random source ──────────────────────────────────────────────────────────

let randomState = 0x1045f00d
function random(): number {
  randomState = (randomState + 0x6d2b79f5) >>> 0
  let t = randomState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (lo: number, hi: number): number => lo + (hi - lo) * random()

// ── the independent reference ──────────────────────────────────────────────
//
// A polar grid of the material still standing: angle bins by along bins, each
// the largest radius standing in the cell, initialised from the square's own
// boundary. It is deliberately blind to the guard's cells and tolerances.

const REF_ANGLE_BINS = 720
const REF_ANGLE_BIN_DEGREES = 360 / REF_ANGLE_BINS
const REF_ALONG_BIN = 0.25

interface Reference {
  alongStart: number
  alongBins: number
  material: Float64Array
}

/** The square blank's radius along the ray at `angleDeg`, from its half-side. */
function blankRadius(halfSide: number, angleDeg: number): number {
  const radians = angleDeg * Math.PI / 180
  return halfSide / Math.max(Math.abs(Math.cos(radians)), Math.abs(Math.sin(radians)))
}

function createReference(stock: SquareStock, alongStart: number, alongEnd: number): Reference {
  const alongBins = Math.max(1, Math.ceil((alongEnd - alongStart) / REF_ALONG_BIN))
  const material = new Float64Array(alongBins * REF_ANGLE_BINS)
  const halfSide = stock.thickness / 2
  const row = new Float64Array(REF_ANGLE_BINS)
  for (let k = 0; k < REF_ANGLE_BINS; k++) row[k] = blankRadius(halfSide, (k + 0.5) * REF_ANGLE_BIN_DEGREES)
  for (let i = 0; i < alongBins; i++) material.set(row, i * REF_ANGLE_BINS)
  return { alongStart, alongBins, material }
}

/**
 * The near (`contact`) and far (`exit`) radii at which the cutter body meets a
 * ray `dTheta` off its axis at along offset `dx`, or `null` when it misses. The
 * two roots of a flat's disc/cylinder interval and a ball's sphere interval; the
 * reference's own copy, not the guard's.
 */
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
  // The shank above the ball is a cylinder of the same radius; a ray that meets
  // it leaves no standing material above the sphere's far root there either.
  const shankStart = centre / cos
  const shankExit = Math.abs(sin) > 1e-12 ? Math.sqrt(radiusSq - alongSq) / Math.abs(sin) : Number.POSITIVE_INFINITY
  return {
    contact: Math.max(0, centre * cos - root),
    exit: shankStart <= shankExit ? Math.max(sphereExit, shankExit) : sphereExit,
  }
}

/**
 * Run one cutter sample through the reference: lower every cell whose standing
 * material is inside the body (its top is at or below the `exit`), and return
 * the deepest radial engagement seen.
 */
function referenceSample(
  reference: Reference,
  along: number,
  angle: number,
  tip: number,
  cutterRadius: number,
  ball: boolean,
): number {
  const { material, alongBins, alongStart } = reference
  const alongIndex = Math.floor((along - alongStart) / REF_ALONG_BIN)
  const spanAlong = Math.ceil(cutterRadius / REF_ALONG_BIN) + 1
  const i0 = Math.max(0, alongIndex - spanAlong)
  const i1 = Math.min(alongBins - 1, alongIndex + spanAlong)
  const halfSpan = tip > 0 ? Math.asin(Math.min(1, cutterRadius / tip)) : Math.PI
  const halfSpanBins = Math.min(REF_ANGLE_BINS, Math.ceil(halfSpan / (REF_ANGLE_BIN_DEGREES * Math.PI / 180)) + 1)
  const wrapped = ((angle % 360) + 360) % 360
  const baseBin = Math.floor(wrapped / REF_ANGLE_BIN_DEGREES)
  let engagement = Number.NEGATIVE_INFINITY
  for (let i = i0; i <= i1; i++) {
    const dx = alongStart + (i + 0.5) * REF_ALONG_BIN - along
    if (dx * dx >= cutterRadius * cutterRadius) continue
    for (let offset = -halfSpanBins; offset <= halfSpanBins; offset++) {
      const k = ((baseBin + offset) % REF_ANGLE_BINS + REF_ANGLE_BINS) % REF_ANGLE_BINS
      const cellAngle = (k + 0.5) * REF_ANGLE_BIN_DEGREES
      let delta = cellAngle - angle
      while (delta > 180) delta -= 360
      while (delta < -180) delta += 360
      const span = bodySpan(ball, cutterRadius, tip, delta * Math.PI / 180, dx)
      if (span === null) continue
      const index = i * REF_ANGLE_BINS + k
      const materialRadius = material[index]
      if (!(materialRadius > 0) || span.exit < materialRadius) continue
      const depth = materialRadius - span.contact
      if (depth > engagement) engagement = depth
      if (span.contact < materialRadius) material[index] = span.contact
    }
  }
  return engagement
}

/** The reference's engagement for one move: its interior, not just its end. */
function referenceMove(
  reference: Reference,
  move: ToolpathMove,
  pivot: number,
  cutterRadius: number,
  ball: boolean,
  alongOf: (point: ToolpathPoint) => number,
): number {
  const fromAlong = alongOf(move.from)
  const toAlong = alongOf(move.to)
  const fromAngle = move.from.a ?? 0
  const toAngle = move.to.a ?? fromAngle
  const steps = Math.max(1,
    Math.ceil(Math.abs(toAngle - fromAngle) / REF_ANGLE_BIN_DEGREES),
    Math.ceil(Math.abs(toAlong - fromAlong) / REF_ALONG_BIN))
  let engagement = Number.NEGATIVE_INFINITY
  for (let step = 0; step <= steps; step++) {
    const fraction = step / steps
    const depth = referenceSample(
      reference,
      fromAlong + (toAlong - fromAlong) * fraction,
      fromAngle + (toAngle - fromAngle) * fraction,
      move.from.z + (move.to.z - move.from.z) * fraction - pivot,
      cutterRadius,
      ball,
    )
    if (depth > engagement) engagement = depth
  }
  return engagement
}

// ── random programs ────────────────────────────────────────────────────────

const TARGET: OperationTarget = { source: 'stock' }

interface ProgramOperation {
  operation: Operation
  moves: ToolpathMove[]
  /** The finish's radial stock, or the rough's stepdown: what the operation's cut may take. */
  nominalBound: number
  turning: boolean
}

function projectFor(stock: SquareStock, cutter: EmittedSquareCutter): Project {
  const project = newProject('square guard property', 'mm')
  project.meta.projectType = 'rotary'
  project.stock = stock
  project.tools = [{
    ...defaultTool('mm', 1),
    id: cutter.id,
    name: cutter.id,
    units: 'mm',
    type: cutter.type === 'ball_endmill' ? 'ball_endmill' : 'flat_endmill',
    diameter: cutter.diameter,
  }]
  return project
}

function point(stock: SquareStock, along: number, tip: number, angle: number): ToolpathPoint {
  const pivot = barPivotZ(stock)
  return stock.axis === 'x'
    ? { x: along, y: stock.thickness / 2, z: pivot + tip, a: angle }
    : { x: stock.thickness / 2, y: along, z: pivot + tip, a: angle }
}

function travel(stock: SquareStock): number {
  return barMaxRadius(stock) + 1
}

/**
 * One random program: 1-4 operations, each either a non-turning along pass or
 * a turning around pass, with random tips, A spans (including more than a full
 * turn) and cut positions inside a bounded window.
 */
function randomProgram(stock: SquareStock, project: Project): ProgramOperation[] {
  const halfSide = stock.thickness / 2
  const alongMid = between(0, Math.max(0, stockLength(stock) - 20)) + 10
  const windowLow = Math.max(2, alongMid - 10)
  const windowHigh = Math.min(stockLength(stock) - 2, alongMid + 10)
  const operations: ProgramOperation[] = []
  const count = 1 + Math.floor(random() * 4)
  for (let index = 0; index < count; index++) {
    const finish = index > 0 && random() < 0.45
    const around = random() < 0.6
    const stepdown = between(0.3, 3)
    const stockToLeaveRadial = between(0, 0.8)
    const operation: Operation = {
      ...defaultOperationForTarget(
        project,
        finish ? 'rotary_finish' : 'rotary_rough',
        finish ? 'finish' : 'rough',
        TARGET,
        index,
      ),
      rotaryPassDirection: around ? 'around' : 'along',
      ...(finish ? { stockToLeaveRadial } : { stepdown, stockToLeaveRadial }),
    }
    const moves: ToolpathMove[] = []
    const cuts = 1 + Math.floor(random() * 3)
    let controller = 0
    for (let cutIndex = 0; cutIndex < cuts; cutIndex++) {
      const along = between(windowLow, windowHigh)
      const angle = between(0, 360)
      moves.push({
        kind: 'rapid',
        from: point(stock, along, travel(stock), controller),
        to: point(stock, along, travel(stock), angle),
      })
      controller = angle
      // A tip random in [0, material + slack]: many are unsafe and refused, and
      // the admitted ones are the interesting ones.
      const surface = blankRadius(halfSide, angle)
      const tip = Math.max(0, surface - between(-1, 1.4) * Math.max(stepdown, stockToLeaveRadial + 0.2))
      if (around) {
        const span = between(2, 60) * (random() < 0.15 ? 8 : 1)
        const lowerTip = Math.max(0, tip - between(0, stepdown * 0.4))
        moves.push({
          kind: 'cut',
          from: point(stock, along, tip, controller),
          to: point(stock, along, lowerTip, controller + span),
        })
        controller += span
      } else {
        const spanAlong = between(0.5, 6)
        moves.push({
          kind: 'cut',
          from: point(stock, along, tip, controller),
          to: point(stock, Math.min(stockLength(stock) - 0.5, along + spanAlong), tip, controller),
        })
      }
    }
    operations.push({
      operation,
      moves,
      nominalBound: finish ? stockToLeaveRadial : stepdown,
      turning: around,
    })
  }
  return operations
}

function stockLength(stock: SquareStock): number {
  const bounds = getStockBounds(stock)
  return stock.axis === 'x' ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY
}

// ── the property ───────────────────────────────────────────────────────────

const SEEDS = 220

console.log(`Testing the ${SEEDS}-seed square guard conservativeness property...`)
{
  let admitted = 0
  let refused = 0
  let resolutionRefused = 0
  let turningCuts = 0
  let worstExcess = Number.NEGATIVE_INFINITY
  let worstNominalExcess = Number.NEGATIVE_INFINITY
  for (let seed = 0; seed < SEEDS; seed++) {
    const side = between(10, 60)
    const length = between(20, 1000)
    const stock = squareStock(side, length, 'x', { x: 0, y: 0 })
    const ball = random() < 0.5
    const radius = between(0.1, 6)
    const cutter: EmittedSquareCutter = {
      id: `seed-${seed}`,
      units: 'mm',
      type: ball ? 'ball_endmill' : 'flat_endmill',
      diameter: 2 * radius,
      radius,
    }
    const project = projectFor(stock, cutter)
    const state = createSquareSweepState(stock, radius)
    const program = randomProgram(stock, project)
    // The guard's own stated tolerance, computed here from its published
    // formula (one angular bin of the blank's surface, the ball's radial change
    // across half an along bin, and the emitted-Z rounding) so the reference
    // compares against the same bound the guard was given.
    const guardTolerance = barMaxRadius(stock) * (0.5 * Math.PI / 180)
      + (ball ? radius - Math.sqrt(Math.max(0, radius * radius - (state.alongBin / 2) ** 2)) : 0)
      + 0.0005
    if (state.resolutionRefused) {
      resolutionRefused++
      refused++
      continue
    }
    const verdicts: SquareGuardVerdict[] = []
    // The allowance a finish over an earlier rough may take: the same nominal
    // policy the guard documents, recomputed here from the operations alone.
    let allowance = 0
    for (const entry of program) {
      const before = allowance
      const verdict = guardSquareOperation(state, {
        operation: entry.operation,
        moves: entry.moves,
        cutter,
        entryAngle: null,
        direction: 1,
        travelZ: barPivotZ(stock) + travel(stock),
        roundingAllowance: 0.0005,
      })
      verdicts.push(verdict)
      if (!verdict.admitted) break
      if (entry.operation.kind === 'rotary_rough') {
        allowance = Math.max(allowance, entry.operation.stepdown + entry.operation.stockToLeaveRadial)
      }
      entry.nominalBound = (entry.operation.kind === 'rotary_finish'
        ? (entry.operation.stockToLeaveRadial ?? 0) + before
        : entry.operation.stepdown ?? 0)
      entry.nominalBound += guardTolerance
    }
    if (!verdicts.every((verdict) => verdict.admitted)) {
      refused++
      continue
    }
    admitted++
    // Every admitted program is now checked by the independent reference.
    const pivot = barPivotZ(stock)
    const alongOf = (point2: ToolpathPoint): number => stock.axis === 'x' ? point2.x : point2.y
    const allMoves = program.flatMap((entry) => entry.moves)
    const cutAlongs = allMoves.flatMap((move) => [alongOf(move.from), alongOf(move.to)])
    const windowLow = Math.max(0, Math.min(...cutAlongs) - radius - 2)
    const windowHigh = Math.min(stockLength(stock), Math.max(...cutAlongs) + radius + 2)
    const reference = createReference(stock, windowLow, windowHigh)
    let allowanceBefore = 0
    for (const entry of program) {
      const entryBound = (entry.operation.kind === 'rotary_finish'
        ? (entry.operation.stockToLeaveRadial ?? 0) + allowanceBefore
        : entry.operation.stepdown ?? 0)
        + guardTolerance
      if (entry.operation.kind === 'rotary_rough') {
        allowanceBefore = Math.max(allowanceBefore, (entry.operation.stepdown ?? 0) + (entry.operation.stockToLeaveRadial ?? 0))
      }
      let moveController = 0
      for (const move of entry.moves) {
        const hasAngle = move.from.a !== undefined || move.to.a !== undefined
        const end = !hasAngle || move.to.a === undefined ? moveController : move.to.a
        const turns = end !== moveController
        const lowTip = Math.min(move.from.z, move.to.z) - pivot
        if (move.kind !== 'rapid' && lowTip < travel(stock)) {
          const depth = referenceMove(reference, move, pivot, radius, ball, alongOf)
          if (turns) {
            turningCuts++
            worstExcess = Math.max(worstExcess, depth - entryBound)
            worstNominalExcess = Math.max(worstNominalExcess, depth - entry.nominalBound)
            assert.ok(depth <= entryBound + 1e-6,
              `seed ${seed} ${cutter.type} r=${radius.toFixed(3)}: the guard admitted a turning cut whose reference depth ${depth.toFixed(4)} exceeds its bound ${entryBound.toFixed(4)}`)
          }
        }
        moveController = end
      }
    }
  }
  console.log(`  seeds ${SEEDS}: admitted ${admitted}, refused ${refused} (${resolutionRefused} refused because the grid cannot resolve the cutter), ${turningCuts} turning cuts checked`)
  console.log(`  worst reference engagement minus its tolerance-inclusive bound: ${worstExcess.toFixed(6)} mm`)
  console.log(`  worst reference engagement minus the nominal bound: ${worstNominalExcess.toFixed(6)} mm`)
  assert.ok(admitted > 20, `the property exercised admitted programs (${admitted})`)
}

// ---------------------------------------------------------------------------
// False refusals: the generator's own programs for a Frank-like square-to-round
// must all post, or the guard is too conservative to be usable.
// ---------------------------------------------------------------------------

/** A coaxial cylinder surface: a square-to-round model inside the blank. */
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

console.log('Testing that the guard admits the generator\'s normal square programs...')
{
  const stock = squareStock(20, 40, 'x', { x: 0, y: 0 })
  const model = cylinder(stock, 5, 12, 28)
  const pivot = barPivotZ(stock)
  const travelZ = pivot + travel(stock)
  const base = {
    stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 12, alongEnd: 28,
    safeRadius: 30, requestedCellSize: 0.05,
  }
  let admitted = 0
  let refused = 0
  const cases: Array<{ label: string; tool: EmittedSquareCutter; direction: 'around' | 'along' }> = [
    { label: 'flat around', tool: { id: 'flat-4', units: 'mm', type: 'flat_endmill', diameter: 4, radius: 2 }, direction: 'around' },
    { label: 'ball around', tool: { id: 'ball-3', units: 'mm', type: 'ball_endmill', diameter: 3, radius: 1.5 }, direction: 'around' },
    { label: 'flat along', tool: { id: 'flat-4', units: 'mm', type: 'flat_endmill', diameter: 4, radius: 2 }, direction: 'along' },
    { label: 'ball along', tool: { id: 'ball-3', units: 'mm', type: 'ball_endmill', diameter: 3, radius: 1.5 }, direction: 'along' },
  ]
  for (const entry of cases) {
    const project = projectFor(stock, entry.tool)
    const tool = defaultTool('mm', 1)
    const normalized = {
      id: entry.tool.id, name: entry.tool.id, sourceUnits: 'mm' as const, units: 'mm' as const,
      type: entry.tool.type === 'ball_endmill' ? 'ball_endmill' as const : 'flat_endmill' as const,
      diameter: entry.tool.diameter, radius: entry.tool.radius, vBitAngle: null,
      flutes: tool.flutes, material: tool.material, defaultRpm: 0, defaultFeed: 0,
      defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
    }
    const rough = generateRotaryRough(`prop-rough-${entry.label}`, model, stock, normalized, {
      ...base, stepdown: 2, passDirection: entry.direction,
    }, {})
    const finish = generateRotaryFinish(`prop-finish-${entry.label}`, model, stock, normalized, {
      ...base, passDirection: entry.direction, ...(entry.direction === 'around' ? { squareRoughBefore: true } : {}),
    }, {})
    assert.deepEqual(rough.warnings, [], `${entry.label}: the generated rough warns about nothing`)
    assert.deepEqual(finish.warnings, [], `${entry.label}: the generated finish warns about nothing`)
    const roughOp: Operation = {
      ...defaultOperationForTarget(project, 'rotary_rough', 'rough', TARGET, 0),
      rotaryPassDirection: entry.direction,
      stepdown: 2,
      stockToLeaveRadial: 0,
    }
    const finishOp: Operation = {
      ...defaultOperationForTarget(project, 'rotary_finish', 'finish', TARGET, 1),
      rotaryPassDirection: entry.direction,
      stockToLeaveRadial: 0,
    }
    const state = createSquareSweepState(stock, entry.tool.radius)
    const first = guardSquareOperation(state, {
      operation: roughOp, moves: rough.moves, cutter: entry.tool, entryAngle: 0,
      direction: 1, travelZ, roundingAllowance: 0.0005,
    })
    const second = guardSquareOperation(state, {
      operation: finishOp, moves: finish.moves, cutter: entry.tool, entryAngle: 0,
      direction: 1, travelZ, roundingAllowance: 0.0005,
    })
    if (first.admitted && second.admitted) admitted++
    else {
      refused++
      console.log(`  ${entry.label}: refused (${JSON.stringify(first)} / ${JSON.stringify(second)})`)
    }
  }
  console.log(`  generator programs: ${admitted}/${cases.length} admitted, ${refused} false refusals`)
  assert.equal(refused, 0, 'a normal square-to-round rough + finish is never falsely refused')
}

console.log('engine/gcode/squareSweepGuard.property.test.ts: all assertions passed')
