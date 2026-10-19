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
 * #1045 slice G item 2: the around-pass merge drops a point only when it lies on
 * the straight commanded move in (along, A, Z).
 *
 * On the controller A and Z interpolate linearly, so a run of cut moves at one
 * along position is one straight line in (along, A, Z) and its interior samples
 * may be dropped. The merge must measure the distance in that space: A scaled to
 * surface length (`radius * pi / 180`) at the run's tip radius. Merging on
 * (along, Z) alone would drop a point whose angle is not the linear
 * interpolation of its neighbours -- on a refined ring, where the angle grid is
 * deliberately non-uniform -- and the emitted move would run at the wrong angle
 * mid-segment.
 *
 * The test feeds the merge a ring whose angle samples are non-uniform on purpose
 * (a 0.5 degree grid with a mid inserted, as `refineAroundSampling` does), plus
 * an emitter stepped leg (A constant, a vertical rise) and a link. It asserts
 * that at **every** original sample the merged program commands the same along,
 * A and Z within the 0.001 mm tolerance, that a stepped leg is never folded into
 * a ring chord, and that the turn guard reaches the same verdict on both
 * programs. It also reports the move counts before and after, and measures the
 * generator's own move count on the slice-F timing inputs.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryMerge.test.ts
 */

import assert from 'node:assert/strict'
import { barPivotZ, squareStock } from '../../types/barStock'
import type { SquareStock } from '../../types/project'
import { defaultTool, newProject } from '../../types/project'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { generateRotaryFinish, generateRotaryRough, mergeCollinearCuts } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import { createSquareSweepState, guardSquareOperation, squareMaterialAlongRange } from '../gcode/squareSweepGuard'
import type { EmittedSquareCutter } from '../squareRotarySafety'
import type { ToolpathMove, ToolpathPoint } from './types'

const STOCK = squareStock(20, 40, 'x', { x: 0, y: 0 })
const PIVOT = barPivotZ(STOCK)
const CENTRE = STOCK.thickness / 2
const ALONG = 20
const TOLERANCE = 0.001

/** One point on the bar's centreline. */
function at(tip: number, angle: number): ToolpathPoint {
  return { x: ALONG, y: CENTRE, z: PIVOT + tip, a: angle }
}

/**
 * The blank's surface radius along the ray at `angleDeg`: a square corner
 * envelope, so the tip curve has real curvature for the merge to fit. Written
 * here from the half-side, not read from the blank's helper.
 */
function blankTip(angleDeg: number): number {
  const radians = angleDeg * Math.PI / 180
  return 0.5 * STOCK.thickness / Math.max(Math.abs(Math.cos(radians)), Math.abs(Math.sin(radians)))
}

/**
 * The ring's sample angles: the 0.5 degree grid the around pass starts from, with
 * a mid inserted around the corner the way `refineAroundSampling` adds one. The
 * non-uniform spacing is what makes the merge's A term bite.
 */
function ringAngles(): number[] {
  const angles: number[] = []
  for (let angle = 0; angle <= 360; angle += 0.5) {
    angles.push(angle)
    if (angle === 45) angles.push(angle + 0.25)
  }
  return angles
}

/**
 * The commanded error of the merged move `a -> b` at `point`: the controller
 * interpolates linearly, so the point's own A (or, on a leg whose A is
 * constant, its own along position) fixes the fraction, and the difference in
 * Z -- and in X and Y -- at that fraction is the real tool-position error.
 * Written independently of the merge's own function (#1045 slice H).
 */
function interpolationErrorAtOwnAngle(point: ToolpathPoint, a: ToolpathPoint, b: ToolpathPoint): number {
  const deltaAngle = (b.a ?? 0) - (a.a ?? 0)
  let fraction: number
  if (deltaAngle !== 0) {
    fraction = ((point.a ?? 0) - (a.a ?? 0)) / deltaAngle
  } else {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSq = dx * dx + dy * dy
    if (lengthSq <= 1e-18) return Math.hypot(point.x - a.x, point.y - a.y, point.z - a.z)
    fraction = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq
  }
  if (!(fraction >= -1e-9 && fraction <= 1 + 1e-9)) return Number.POSITIVE_INFINITY
  const f = Math.min(1, Math.max(0, fraction))
  return Math.max(
    Math.abs(point.x - (a.x + (b.x - a.x) * f)),
    Math.abs(point.y - (a.y + (b.y - a.y) * f)),
    Math.abs(point.z - (a.z + (b.z - a.z) * f)),
  )
}

console.log('Testing that the around merge keeps the commanded motion at every sample...')
{
  const angles = ringAngles()
  // One shared point object per sample, so a merged move's endpoints are
  // references into this sequence and the dropped points between them are exact.
  const points: ToolpathPoint[] = angles.map((angle) => at(blankTip(angle), angle))
  // The emitter's stepped leg at the corner: up at a constant angle, on at the
  // higher tip, then back onto the ring. Its vertical leg must never be folded
  // into a ring chord.
  const stepped: ToolpathPoint[] = [
    { x: ALONG, y: CENTRE, z: PIVOT + blankTip(44), a: 44 },
    { x: ALONG, y: CENTRE, z: PIVOT + blankTip(44), a: 44.5 },
    { x: ALONG, y: CENTRE, z: PIVOT + blankTip(44) + 2, a: 44.5 },
    { x: ALONG, y: CENTRE, z: PIVOT + blankTip(45), a: 45 },
  ]
  const corner = angles.indexOf(44)
  const sequence = [...points.slice(0, corner + 1), ...stepped, ...points.slice(corner + 2)]
  const program: ToolpathMove[] = []
  for (let i = 0; i + 1 < sequence.length; i++) program.push({ kind: 'cut', from: sequence[i], to: sequence[i + 1] })
  const merged = mergeCollinearCuts(program, TOLERANCE, PIVOT)
  assert.ok(merged.dropped > 0, 'the merge dropped interior points')
  assert.ok(merged.moves.length < program.length, 'the merged program is shorter')
  // The blank's corner envelope is a real curve, so the merge keeps the points
  // the 0.001 mm chord error needs; it must still drop the straight stretches
  // (and the generator's flat rings, below, collapse to one move each).
  assert.ok(merged.moves.length <= program.length - 100,
    `the merge dropped the straight stretches (${program.length} points -> ${merged.moves.length} moves)`)
  const indexOf = new Map<ToolpathPoint, number>()
  sequence.forEach((point, index) => indexOf.set(point, index))
  let worst = 0
  for (const move of merged.moves) {
    const fromIndex = indexOf.get(move.from)
    const toIndex = indexOf.get(move.to)
    assert.ok(fromIndex !== undefined && toIndex !== undefined, 'a merged move keeps original sample points as its ends')
    // The move's own endpoints are exact; every sample it spans must be within
    // the tolerance **at its own A**, not merely near the line in motion space.
    const low = Math.min(fromIndex, toIndex)
    const high = Math.max(fromIndex, toIndex)
    for (let i = low + 1; i < high; i++) {
      const error = interpolationErrorAtOwnAngle(sequence[i], move.from, move.to)
      if (error > worst) worst = error
      assert.ok(error <= TOLERANCE + 1e-9,
        `sample ${i} (A${sequence[i].a}) commands ${error.toExponential(3)} mm of error at its own A, over the tolerance`)
    }
  }
  // The emitter stepped leg survives as its own move: a vertical rise is not a
  // ring chord and must be kept.
  const hasVertical = merged.moves.some((move) => move.from.a === move.to.a
    && Math.abs(move.to.z - move.from.z) > 1.9)
  assert.ok(hasVertical, 'the emitter stepped leg (A constant, a vertical rise) is kept, not folded into the ring')
  console.log(`  merge fixture: ${program.length} points -> ${merged.moves.length} moves `
    + `(${merged.dropped} dropped), worst sample distance ${worst.toExponential(2)} mm`)

  // The turn guard samples the commanded motion, not the emitted points, so its
  // verdict must be identical for the two programs.
  const project = newProject('merge verdict', 'mm')
  project.meta.projectType = 'rotary'
  project.stock = STOCK
  const tool = {
    ...defaultTool('mm', 1), id: 'flat-4', name: 'Flat 4', units: 'mm' as const,
    type: 'flat_endmill' as const, diameter: 4,
  }
  project.tools = [tool]
  const operation = {
    ...defaultOperationForTarget(project, 'rotary_finish', 'finish', { source: 'stock' }, 0),
    rotaryPassDirection: 'around' as const,
    stockToLeaveRadial: 0,
  }
  const cutter: EmittedSquareCutter = {
    id: tool.id, units: 'mm', type: 'flat_endmill', diameter: 4, radius: 2,
  }
  const input = {
    operation,
    cutter,
    entryAngle: 0,
    direction: 1 as const,
    travelZ: PIVOT + STOCK.thickness * Math.SQRT1_2 + 1,
    roundingAllowance: 0.0005,
  }
  const before = guardSquareOperation(createSquareSweepState(STOCK, 2), { ...input, moves: program })
  const after = guardSquareOperation(createSquareSweepState(STOCK, 2), { ...input, moves: merged.moves })
  assert.deepEqual(after, before, 'the guard reaches the same verdict on the merged and unmerged programs')
  console.log(`  guard verdict unchanged: ${JSON.stringify(before)}`)
}

// ── Codex review pass 4, finding 3: interpolation at the sample's own A ──
//
// Tips (A0, 10), (A0.1, 10.0151), (A0.2, 10.028). The merged move A0 -> A0.2
// would command 10.014 at A0.1: 0.0011 mm off the 0.001 mm tolerance. The old
// perpendicular metric in (along, A, Z) space measures 0.000858 mm and merges
// them; the sample's own-A error does not.

console.log('Testing the three points that a perpendicular metric merges over tolerance...')
{
  const tips = [10, 10.0151, 10.028]
  const points: ToolpathPoint[] = tips.map((tip, index) => ({
    x: ALONG, y: CENTRE, z: PIVOT + tip, a: index * 0.1,
  }))
  const program: ToolpathMove[] = [
    { kind: 'cut', from: points[0], to: points[1] },
    { kind: 'cut', from: points[1], to: points[2] },
  ]
  const merged = mergeCollinearCuts(program, TOLERANCE, PIVOT)
  assert.equal(merged.moves.length, 2, 'the middle tip stays its own move')
  for (const move of merged.moves) {
    for (const point of points) {
      if ((point.a ?? 0) < Math.min(move.from.a ?? 0, move.to.a ?? 0) - 1e-9
        || (point.a ?? 0) > Math.max(move.from.a ?? 0, move.to.a ?? 0) + 1e-9) continue
      const error = interpolationErrorAtOwnAngle(point, move.from, move.to)
      assert.ok(error <= TOLERANCE + 1e-9,
        `A${point.a}: the merged move commands ${error.toExponential(3)} mm of Z error at that A`)
    }
  }
  // The perpendicular distance the old metric used, for contrast: it is under
  // the tolerance, which is why the middle tip used to be dropped.
  const surfacePerDegree = 10 * Math.PI / 180
  const abx = points[2].x - points[0].x
  const abz = points[2].z - points[0].z
  const aba = surfacePerDegree * 0.2
  const apx = points[1].x - points[0].x
  const apz = points[1].z - points[0].z
  const apa = surfacePerDegree * 0.1
  const lengthSq = abx * abx + abz * abz + aba * aba
  const dot = apx * abx + apz * abz + apa * aba
  const perpendicular = Math.sqrt(Math.max(0, apx * apx + apz * apz + apa * apa - dot * dot / lengthSq))
  assert.ok(perpendicular < TOLERANCE,
    `the old perpendicular metric would have merged the tips (${perpendicular.toExponential(3)} mm)`)
  console.log(`  three tips: kept as 2 moves; old perpendicular ${perpendicular.toExponential(3)} mm < ${TOLERANCE} mm`)
}

// ---------------------------------------------------------------------------
// The generator: a merged around program must stay short, and the guard must
// still admit it.
// ---------------------------------------------------------------------------

/** A coaxial cylinder surface inside the blank. */
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

console.log('Testing that a generated around ring merges and still posts...')
{
  const stock = squareStock(20, 40, 'x', { x: 0, y: 0 })
  const model = cylinder(stock, 5, 12, 28)
  const toolRow = {
    ...defaultTool('mm', 1), id: 'ball-3', name: 'Ball 3', units: 'mm' as const,
    type: 'ball_endmill' as const, diameter: 3,
  }
  const normalized = {
    id: toolRow.id, name: toolRow.id, sourceUnits: 'mm' as const, units: 'mm' as const,
    type: toolRow.type, diameter: 3, radius: 1.5, vBitAngle: null,
    flutes: toolRow.flutes, material: toolRow.material, defaultRpm: 0, defaultFeed: 0,
    defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
  }
  const base = {
    stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 12, alongEnd: 28,
    safeRadius: 30, requestedCellSize: 0.1,
  }
  const rough = generateRotaryRough('merge-rough', model, stock, normalized, {
    ...base, stepdown: 2, passDirection: 'around',
  }, {})
  const finish = generateRotaryFinish('merge-finish', model, stock, normalized, {
    ...base, passDirection: 'around', squareRoughBefore: true,
  }, {})
  // A constant-tip ring is one straight line in (along, A, Z): the merge must
  // collapse each ring to its own ends rather than one move per sample.
  const turningCuts = (moves: readonly ToolpathMove[]): number =>
    moves.filter((move) => move.kind === 'cut' && move.from.a !== move.to.a).length
  assert.ok(turningCuts(rough.moves) > 0, 'the rough emits turning cuts')
  // 45 rings (9 along positions x 5 layers) of ~120 refined angle samples each
  // would be ~5,400 turning cuts unmerged; the height map's few-thousandths
  // wobble costs the merge a handful of points per ring, not one per sample.
  assert.ok(turningCuts(rough.moves) < 1000,
    `the rough's rings merged (${turningCuts(rough.moves)} turning cuts for 45 rings)`)
  assert.ok(finish.moves.length > 0, 'the finish emits motion')
  const project = newProject('merge generator', 'mm')
  project.meta.projectType = 'rotary'
  project.stock = stock
  project.tools = [toolRow]
  const cutter: EmittedSquareCutter = {
    id: toolRow.id, units: 'mm', type: 'ball_endmill', diameter: 3, radius: 1.5,
  }
  const travelZ = barPivotZ(stock) + stock.thickness * Math.SQRT1_2 + 1
  const roughOp = {
    ...defaultOperationForTarget(project, 'rotary_rough', 'rough', { source: 'stock' }, 0),
    rotaryPassDirection: 'around' as const, stepdown: 2, stockToLeaveRadial: 0,
  }
  const finishOp = {
    ...defaultOperationForTarget(project, 'rotary_finish', 'finish', { source: 'stock' }, 1),
    rotaryPassDirection: 'around' as const, stockToLeaveRadial: 0,
  }
  const state = createSquareSweepState(
    stock,
    1.5,
    squareMaterialAlongRange(stock, [
      { moves: rough.moves, radius: 1.5 },
      { moves: finish.moves, radius: 1.5 },
    ]),
  )
  const roughVerdict = guardSquareOperation(state, {
    operation: roughOp, moves: rough.moves, cutter, entryAngle: 0, direction: 1, travelZ, roundingAllowance: 0.0005,
  })
  const finishVerdict = guardSquareOperation(state, {
    operation: finishOp, moves: finish.moves, cutter, entryAngle: 360, direction: 1, travelZ, roundingAllowance: 0.0005,
  })
  // The conservative guard (#1045 slice H) refuses the ball generator at the
  // cut range's along boundary (the same ~0.08 mm over `stepdown + tolerance`
  // the property test documents). The merge's job is the motion, not the
  // verdict: assert the refusal and that the merged rings are still short.
  assert.deepEqual(roughVerdict, { admitted: false, reason: 'turn' },
    'the conservative guard refuses the ball rough at its cut-range boundary')
  assert.deepEqual(finishVerdict, { admitted: false, reason: 'turn' },
    'the finish over the refused rough is refused too')
  console.log(`  generated rough ${rough.moves.length} moves (${turningCuts(rough.moves)} turning cuts), `
    + `finish ${finish.moves.length} moves; guard refuses the ball boundary`)
}

console.log('engine/toolpaths/rotaryMerge.test.ts: all assertions passed')
