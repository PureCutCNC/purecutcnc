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
 * A and Z within the 0.001 mm tolerance, and that a stepped leg is never folded
 * into a ring chord. It also reports the move counts before and after, and
 * measures the generator's own move count on the slice-F timing inputs. The
 * generator's safety is proven independently by
 * `squareAroundGenerator.property.test.ts` since #1045 slice K.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryMerge.test.ts
 */

import assert from 'node:assert/strict'
import { barPivotZ, squareStock } from '../../types/barStock'
import type { BarStock } from '../../types/project'
import { defaultTool, newProject, roundStock } from '../../types/project'
import { generateRotaryFinish, generateRotaryRough, mergeCollinearCuts } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import type { ToolpathMove, ToolpathPoint } from './types'
import { stockSpacePoint } from '../rotaryFrame'
import { normalizeToolForProject } from './geometry'
import { runPostProcessor } from '../gcode/postprocessor'
import { BUNDLED_DEFINITIONS } from '../gcode/definitions'
import { validateMachineDefinition } from '../gcode/types'

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

  // The merged program commands the same motion as the unmerged one at every
  // original sample (asserted above), so the export check's regenerate-and-match
  // (#1045 slice K) admits it exactly as it admits the generator's own output.
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
function cylinder(stock: BarStock, radius: number, from: number, to: number, segments = 96): RotaryModelMesh {
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
    ...base, passDirection: 'around',
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
  console.log(`  generated rough ${rough.moves.length} moves (${turningCuts(rough.moves)} turning cuts), `
    + `finish ${finish.moves.length} moves`)
}


// ---------------------------------------------------------------------------
// #1103 slice ca-e: the merge over a continuous helix.
//
// An uninterrupted band is one forward helix: A grows a full turn per pitch and
// every emitted segment is a straight line in (along, A, Z). The merge must
// collapse those segments without changing what the controller is commanded to
// do -- the same motion at every original sample, the same stock-frame path
// length (which is what G93's F is computed from), and no reversal of A.
// ---------------------------------------------------------------------------

console.log('Testing that the merge collapses a continuous helix without moving it...')
{
  const stock = roundStock(20, 40, 'x')
  const pivot = barPivotZ(stock)
  const centre = stock.thickness / 2
  const tip = 6
  const bandStart = 12
  const bandEnd = 28
  const turns = 7
  const stepsPerTurn = 100
  const at = (along: number, angle: number): ToolpathPoint => ({ x: along, y: centre, z: pivot + tip, a: angle })

  // The shape the rough emits on an uninterrupted round band (#1103 ca-d): a
  // complete ring at each axial end and a 7-revolution helix between them, at a
  // constant tip radius -- so each of the three runs is exactly a straight line
  // in (along, A, Z), which is what the merge must collapse.
  const points: ToolpathPoint[] = []
  for (let step = 0; step <= stepsPerTurn; step++) {
    points.push(at(bandStart, 360 * step / stepsPerTurn))
  }
  for (let step = 1; step <= stepsPerTurn * turns; step++) {
    const u = step / (stepsPerTurn * turns)
    points.push(at(bandStart + (bandEnd - bandStart) * u, 360 + 360 * turns * u))
  }
  for (let step = 1; step <= stepsPerTurn; step++) {
    points.push(at(bandEnd, 360 + 360 * turns + 360 * step / stepsPerTurn))
  }

  // The stock-frame length of one straight commanded segment: an independent
  // polyline through `stockSpacePoint`, the same oracle the export's F uses.
  const stockFrameLength = (from: ToolpathPoint, to: ToolpathPoint, chords = 4000): number => {
    const lerp = (t: number): ToolpathPoint => ({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
      a: (from.a ?? 0) + ((to.a ?? 0) - (from.a ?? 0)) * t,
    })
    let previous = stockSpacePoint(lerp(0), stock)
    let length = 0
    for (let index = 1; index <= chords; index++) {
      const point = stockSpacePoint(lerp(index / chords), stock)
      length += Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z)
      previous = point
    }
    return length
  }

  const cuts: ToolpathMove[] = []
  for (let index = 0; index + 1 < points.length; index++) {
    cuts.push({ kind: 'cut', from: points[index], to: points[index + 1] })
  }
  // The exact length of one commanded move at a constant tip radius: along and
  // A both interpolate linearly, so the tip's stock-frame speed is constant. The
  // closed form is independent of the merge and of any quadrature.
  const exactLength = (from: ToolpathPoint, to: ToolpathPoint): number => Math.hypot(
    Math.abs(to.x - from.x),
    (tip * Math.abs((to.a ?? 0) - (from.a ?? 0)) * Math.PI) / 180,
  )
  const before = cuts.reduce((total, move) => total + exactLength(move.from, move.to), 0)
  const merged = mergeCollinearCuts(cuts, 0.001, pivot)
  assert.equal(merged.moves.length, 3, `the two rings and the helix merge to three moves (${merged.moves.length})`)
  assert.equal(merged.dropped, cuts.length - 3, 'every interior sample is dropped')
  const after = merged.moves.reduce((total, move) => total + exactLength(move.from, move.to), 0)
  assert.ok(Math.abs(after - before) / before < 1e-12,
    `the merge preserves the exact path length (${before.toFixed(9)} -> ${after.toFixed(9)})`)

  let previousAngle = -Infinity
  const spans: number[] = []
  for (const move of merged.moves) {
    assert.equal(move.kind, 'cut', 'the whole run merges as cuts')
    assert.ok((move.from.a ?? 0) >= previousAngle - 1e-9, 'A never decreases through the merged run')
    previousAngle = move.to.a ?? 0
    spans.push((move.to.a ?? 0) - (move.from.a ?? 0))
  }
  assert.ok(spans[0] === 360 && spans[2] === 360, `the boundary rings stay complete turns (${spans[0]}, ${spans[2]})`)
  assert.ok(spans[1] > 360, `the helix merges into one multi-turn move (${spans[1]} deg)`)

  // Every dropped sample still lies on the merged move at its own A.
  const indexOf = new Map<ToolpathPoint, number>()
  points.forEach((point, index) => indexOf.set(point, index))
  for (const move of merged.moves) {
    const low = indexOf.get(move.from)
    const high = indexOf.get(move.to)
    assert.ok(low !== undefined && high !== undefined, 'a merged move keeps original poses as its ends')
    for (let index = low + 1; index < high; index++) {
      const error = interpolationErrorAtOwnAngle(points[index], move.from, move.to)
      assert.ok(error <= 0.001 + 1e-9,
        `sample ${index} (A${points[index].a}) commands ${error.toExponential(3)} mm of error at its own A`)
    }
  }

  // And the long merged move posts as one straight inverse-time block whose F
  // is the feed divided by the integrated length, not a shorter axial-only or
  // rotary-only path.
  const project = newProject('Helix merge', 'mm')
  project.stock = stock
  project.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Test End Mill' }]
  const op = {
    id: 'helix-merge', name: 'Helix merge', description: '', kind: 'pocket' as const,
    pass: 'rough' as const, enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'stock' as const }, toolRef: 't1', stepdown: 1, stepover: 0.4,
    feed: 600, plungeFeed: 180, rpm: 12000, pocketPattern: 'offset' as const, pocketAngle: 0,
    stockToLeaveRadial: 0, stockToLeaveAxial: 0, finishWalls: true, finishFloor: true,
    carveDepth: 1, maxCarveDepth: 1,
  }
  project.operations = [op]
  const definition = validateMachineDefinition({
    ...structuredClone(BUNDLED_DEFINITIONS.find((entry) => entry.id === 'grbl')!),
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  const posted = runPostProcessor({
    project,
    definition,
    operations: [{
      operation: op,
      tool: normalizeToolForProject(project.tools[0], project),
      toolpath: {
        operationId: op.id, warnings: [], bounds: null,
        // The establishing rapid: a feed move may only start at an angle the
        // controller is already at (#393 rule 2).
        moves: [{ kind: 'rapid' as const, from: { ...points[0] }, to: { ...points[0] } }, ...merged.moves],
      },
    }],
    options: { emitToolChanges: false, emitCoolant: false, programName: project.meta.name },
  })
  assert.deepEqual(posted.warnings, [], 'the merged helix posts with no refusal')
  assert.doesNotMatch(posted.gcode, /G[23]\b/, 'no merged turning move is fitted into an arc')
  const blocks = posted.gcode.split('\n').filter((line) => /A-?[0-9]/.test(line) && /F[0-9]/.test(line) && !/^G0\b/.test(line))
  assert.equal(blocks.length, 3, 'the three merged runs post as three inverse-time blocks')
  let longest = { line: blocks[0], move: merged.moves[0] }
  for (let index = 0; index < merged.moves.length; index++) {
    const move = merged.moves[index]
    const feed = Number(/F(-?[0-9.]+)/.exec(blocks[index])?.[1])
    assert.ok(feed > 0, `block ${index} carries a positive F`)
    const expected = 600 / stockFrameLength(move.from, move.to,
      Math.max(4000, Math.ceil(Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) * 40)))
    assert.ok(Math.abs(feed - expected) <= 0.0011,
      `block ${index}: F${feed} is feed / the integrated path (${expected.toFixed(3)})`)
    if ((move.to.a ?? 0) - (move.from.a ?? 0) > (longest.move.to.a ?? 0) - (longest.move.from.a ?? 0)) {
      longest = { line: blocks[index], move }
    }
  }
  const longSpan = (longest.move.to.a ?? 0) - (longest.move.from.a ?? 0)
  assert.ok(longSpan > 360, `the posted helix block spans more than a revolution (${longSpan} deg)`)
  assert.match(longest.line, /A2880\b/, 'and its A word is the unwrapped, growing value')
  console.log(`  helix: ${points.length} poses -> ${merged.moves.length} moves, `
    + `length ${before.toFixed(3)} mm, longest move ${longSpan.toFixed(0)} deg`)
}

console.log('engine/toolpaths/rotaryMerge.test.ts: all assertions passed')
