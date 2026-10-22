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
 * The square blank in the rotary sampler (#1016 C2-S3).
 *
 * The blank is the physical box (side × length), the turning pivot is the box
 * centre at `side / 2`, and the largest radius is the corner `side / √2`.
 * Nothing here pretends the blank is round: containment is the box, the
 * retained material beyond the cut range is a square prism, angular sampling
 * and travel heights use the corner radius, and the sampled tips may exceed the
 * inscribed radius because a corner is material.
 *
 * The physical sweep is the independent reference: every cut, plunge and link
 * move is walked in tenth-of-radius steps, the real cutter (flat disc / ball
 * lower hemisphere) is mapped back into the unturned blank through the frozen
 * `stockSpacePoint` rotation, and every cutter point is tested against the
 * **analytic** target cylinder and the **analytic** retained box — never the
 * height map the generator used. Mutations checked against these assertions:
 * - corner envelope replaced by `side / 2` (`barMaxRadius` → inscribed): the
 *   pass-count and travel-height assertions fail
 * - the rough's layer-skip radius widened back to the corner (`S` = max
 *   radius): the flat-direction above-surface air-cut assertion fails
 *   (#1016 C2-F2)
 * - pivot shifted to `maxRadius`: the pivot-contract, travel-height and
 *   retained-corner checks fail
 * - retained square replaced by a round stub: the direct stub-geometry and
 *   sampled-stub checks fail, and the physical sweep's retained-column check
 *   fails (after #1016 C2-F7 the generator no longer rides the corner, so the
 *   sweep -- not a lifted pass -- is what measures the corner now)
 * Run with: npx tsx src/engine/toolpaths/squareRotaryModel.test.ts
 */

import assert from 'node:assert/strict'
import { barCentre, barInscribedRadius, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { getStockBounds, roundStock } from '../../types/project'
import type { BarStock, RoundStock, SquareStock } from '../../types/project'
import { stockSpacePoint, toolSpacePoint } from '../rotaryFrame'
import { chooseHeightMapCellSize } from './finishSurfaceParallel'
import { generateRotaryFinish, generateRotaryRough, sampleRotaryModel, turnedModelPositions } from './rotaryModel'
import type { RotaryFinishParams, RotaryModelMesh } from './rotaryModel'
import { squareBlankRetainedStub } from './squareRotaryStock'
import type { NormalizedTool, ToolpathMove } from './types'

const BALL: NormalizedTool = {
  id: 'ball-2', name: '2 mm ball nose', sourceUnits: 'mm', units: 'mm',
  type: 'ball_endmill', diameter: 4, radius: 2, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}
const FLAT: NormalizedTool = { ...BALL, id: 'flat-2', name: '4 mm flat end mill', type: 'flat_endmill' }

const SIDE = 20
const LENGTH = 60
const TARGET_RADIUS = 6
const BAND_START = 18
const BAND_END = 42

function approx(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: got ${actual}, expected ${expected}`)
}

/** An open coaxial tube of `radius`; the physical reference is the analytic cylinder. */
function cylinderMesh(stock: BarStock, radius: number, alongStart: number, alongEnd: number, segments = 192): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const along of [alongStart, alongEnd]) {
    for (let i = 0; i < segments; i++) {
      const t = 2 * Math.PI * i / segments
      const across = centre + radius * Math.cos(t)
      const up = pivot + radius * Math.sin(t)
      if (stock.axis === 'x') positions.push(along, across, up)
      else positions.push(across, along, up)
    }
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments
    index.push(i, j, segments + j, i, segments + j, segments + i)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/** The cutter's own sample points, relative to the tool tip in the project frame. */
function cutterOffsets(tool: NormalizedTool): ReadonlyArray<readonly [number, number, number]> {
  const r = tool.radius
  const points: Array<readonly [number, number, number]> = [[0, 0, 0]]
  const ring = (ringRadius: number, count: number): void => {
    const dz = tool.type === 'ball_endmill' ? r - Math.sqrt(Math.max(0, r * r - ringRadius * ringRadius)) : 0
    for (let i = 0; i < count; i++) {
      const t = 2 * Math.PI * i / count
      points.push([ringRadius * Math.cos(t), ringRadius * Math.sin(t), dz])
    }
  }
  ring(0.5 * r, 8)
  ring(r, 12)
  if (tool.type === 'ball_endmill') ring(0.85 * r, 10)
  return points
}

/**
 * Walk every cut, plunge and link move of both generators in
 * tenth-of-cutter-radius steps, map the **real** cutter back into the unturned
 * blank through the frozen `stockSpacePoint` rotation, and measure how far it
 * enters the **analytic** target cylinder and the **analytic** retained box.
 * The reference never reads the height map the generator used.
 */
function sweep(
  stock: BarStock,
  tool: NormalizedTool,
  mesh: RotaryModelMesh,
  params: RotaryFinishParams & { stepdown: number },
  targetRadius: number,
): { retained: number; target: number; moves: number } {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const halfSide = barInscribedRadius(stock)
  const bounds = getStockBounds(stock)
  const blankStart = stock.axis === 'x' ? bounds.minX : bounds.minY
  const blankEnd = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  const offsets = cutterOffsets(tool)
  let retained = 0
  let target = 0
  let movesWalked = 0
  for (const result of [
    generateRotaryFinish('shoulder-finish', mesh, stock, tool, params, {}),
    generateRotaryRough('shoulder-rough', mesh, stock, tool, params, {}),
  ]) {
    assert.ok(result.moves.length > 0, 'the coarse shoulder case produces motion')
    for (const move of result.moves) {
      if (move.kind === 'rapid') continue
      movesWalked++
      const a0 = move.from.a ?? 0
      const a1 = move.to.a ?? a0
      const dx = move.to.x - move.from.x
      const dy = move.to.y - move.from.y
      const dz = move.to.z - move.from.z
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / (0.1 * tool.radius)))
      for (let step = 0; step <= steps; step++) {
        const f = step / steps
        const px = move.from.x + dx * f
        const py = move.from.y + dy * f
        const pz = move.from.z + dz * f
        const angle = a0 + (a1 - a0) * f
        for (const offset of offsets) {
          const point = stockSpacePoint({ x: px + offset[0], y: py + offset[1], z: pz + offset[2], a: angle }, stock)
          const l = stock.axis === 'x' ? point.x : point.y
          const across = (stock.axis === 'x' ? point.y : point.x) - centre
          const up = point.z - pivot
          // Target: the analytic coaxial cylinder between its end faces.
          if (l >= params.alongStart && l <= params.alongEnd) {
            const radial = Math.hypot(across, up)
            if (radial < targetRadius) target = Math.max(target, Math.min(targetRadius - radial, l - params.alongStart, params.alongEnd - l))
          }
          // Retained: the analytic box outside the cut range, inside the blank.
          if (l >= blankStart && l <= blankEnd && Math.abs(across) < halfSide && Math.abs(up) < halfSide) {
            const depth = l < params.alongStart
              ? Math.min(params.alongStart - l, l - blankStart)
              : l > params.alongEnd ? Math.min(l - params.alongEnd, blankEnd - l) : 0
            if (depth > 0) retained = Math.max(retained, Math.min(depth, halfSide - Math.abs(across), halfSide - Math.abs(up)))
          }
        }
      }
    }
  }
  return { retained, target, moves: movesWalked }
}

const SQUARE: SquareStock = squareStock(SIDE, LENGTH, 'x')
const ROUND_SAME_BOX: RoundStock = roundStock(SIDE, LENGTH, 'x')
// The blank's own numbers, computed from the side — not from the helpers under
// test — so a pivot or envelope mutation cannot move the expectations with it.
const H = SIDE / 2
const MAX_R = SIDE * Math.SQRT1_2
const PIVOT = SIDE / 2
const CENTRE = SIDE / 2
// The helper contract these numbers pin: the box centre, the inscribed radius,
// the corner radius and the pivot.
assert.equal(barCentre(SQUARE), CENTRE, 'barCentre is the box centre')
assert.equal(barInscribedRadius(SQUARE), H, 'barInscribedRadius is side / 2')
assert.equal(barPivotZ(SQUARE), PIVOT, 'barPivotZ is side / 2, never the corner radius')
approx(barMaxRadius(SQUARE), MAX_R, 'barMaxRadius is the corner radius')

const PARAMS = {
  stepover: 4, stepdown: 3, sampleSpacing: 1, stockToLeave: 0,
  alongStart: BAND_START, alongEnd: BAND_END, safeRadius: 5, requestedCellSize: 0.25,
}

/** Number of distinct pass angles a result uses (each angle reduced into one turn). */
function distinctAngles(moves: readonly ToolpathMove[]): number {
  const angles = new Set<number>()
  for (const move of moves) {
    if (move.to.a !== undefined) angles.add(Math.round((move.to.a % 360 + 360) % 360 * 1e6) / 1e6)
  }
  return angles.size
}

// ── 1. Containment is the physical box, not a circle ──────────────────
{
  const target = cylinderMesh(SQUARE, TARGET_RADIUS, BAND_START, BAND_END, 64)
  const basePositions = Array.from(target.positions)
  const baseIndex = Array.from(target.index)
  // (a) A vertex in a corner region — inside the box, outside the inscribed
  // circle. A circle rule would call this outside the blank.
  const cornerVertex = [30, CENTRE + H - 1, PIVOT + H - 1]
  const corner = { positions: new Float32Array([...basePositions, ...cornerVertex]), index: new Uint32Array(baseIndex) }
  const cornerWarnings = generateRotaryFinish('corner', corner, SQUARE, BALL, PARAMS, {}).warnings
  assert.ok(!cornerWarnings.some((w) => w.code === 'rotaryModelOutsideBar'),
    'a corner-region vertex is inside the physical box')
  // The same vertex on the round bar of the same box is outside it.
  assert.ok(generateRotaryFinish('corner-round', corner, ROUND_SAME_BOX, BALL, PARAMS, {}).warnings
    .some((w) => w.code === 'rotaryModelOutsideBar'),
  'the same corner-region vertex is outside the round bar')
  // (b) A vertex outside the box's flat but inside the circumscribed (corner)
  // circle. A maxRadius / circumscribed rule would call this inside the blank.
  const flatVertex = [30, CENTRE + MAX_R - 1.15, PIVOT]
  const flat = { positions: new Float32Array([...basePositions, ...flatVertex]), index: new Uint32Array(baseIndex) }
  assert.ok(Math.hypot(flatVertex[1] - CENTRE, flatVertex[2] - PIVOT) < MAX_R, 'the test vertex is inside the corner circle')
  assert.ok(generateRotaryFinish('flat', flat, SQUARE, BALL, PARAMS, {}).warnings
    .some((w) => w.code === 'rotaryModelOutsideBar'),
  'past the flat is outside the physical box even inside the corner circle')
  console.log('square model: containment is the physical box on every flat')
}

// ── 2. Retained stock is a closed square prism at the true pivot ──────
{
  const stub = squareBlankRetainedStub(SQUARE, 1, BAND_START)
  assert.ok(stub, 'a non-empty span builds a stub')
  assert.equal(stub.positions.length, 8 * 3, 'four corners at each end')
  assert.equal(stub.index.length, 12 * 3, 'four side quads and two caps')
  const corners = new Set<string>()
  const alongValues = new Set<number>()
  for (let i = 0; i < stub.positions.length; i += 3) {
    const across = stub.positions[i + 1]
    const up = stub.positions[i + 2]
    alongValues.add(stub.positions[i])
    corners.add(`${across.toFixed(6)},${up.toFixed(6)}`)
    approx(Math.abs(across - CENTRE), H, 'stub across is a flat', 1e-6)
    approx(Math.abs(up - PIVOT), H, 'stub up is a flat', 1e-6)
  }
  assert.equal(corners.size, 4, 'exactly the box corners, so it is a square and not a cylinder')
  assert.deepEqual([...alongValues].sort((a, b) => a - b), [1, BAND_START], 'the stub spans exactly the retained span')
  // Sampled through the real seam: at 45° the corner reads the full corner
  // radius; on a flat it reads half the side. A round stub would read half the
  // side at both.
  const along = [2, 6, 10, 14]
  const sampled = sampleRotaryModel(stub, SQUARE, BALL, { anglesDeg: [0, 45, 90], along, requestedCellSize: 0.1 }, [])
  sampled.tipRadius.forEach((row, index) => {
    const angle = sampled.anglesDeg[index]
    for (let i = 0; i < along.length; i++) {
      approx(row[i], angle % 90 === 0 ? H : MAX_R, `retained stub ${angle}° along ${along[i]}`, 0.12)
    }
  })
  // The retainer the generators build is square too, but #1016 C2-F7 pulls the
  // cutter centre one cutter radius inside each stubbed end, so a pass no longer
  // rides the retained corner: a stepover that puts a pass on exactly 45° cuts
  // at the model radius and its centre never leaves the band.
  const band = cylinderMesh(SQUARE, TARGET_RADIUS, BAND_START, BAND_END)
  const retained = generateRotaryFinish('retained', band, SQUARE, BALL, { ...PARAMS, stepover: 2 * Math.PI * MAX_R / 8 }, {})
  // The real cutting moves, not the inter-run links that sit one clearance
  // higher at the travel height (and would mask the corner).
  const at45 = retained.moves.filter((m) => m.kind === 'cut' && m.to.a === 45 && m.to.z < PIVOT + MAX_R + 0.5)
  assert.ok(at45.length > 0, 'the 45° pass cuts')
  // The finish only follows the model (2026-10-22 decision), so the pass that
  // must not ride the retained corner is its model-following cut at A45.
  const min45 = Math.min(...at45.map((m) => m.to.z)) - PIVOT
  assert.ok(min45 < H, `the 45° finish pass no longer rides the retained corner (${min45} < ${H})`)
  approx(min45, TARGET_RADIUS, 'the 45° finish pass cuts the model radius', 0.05)
  const inset = BALL.radius
  for (const move of retained.moves) {
    if (move.kind === 'rapid') continue
    for (const point of [move.from, move.to]) {
      assert.ok(point.x >= BAND_START + inset - 1e-9 && point.x <= BAND_END - inset + 1e-9,
        `the cutter centre stays one radius inside the band (${point.x})`)
    }
  }
  assert.equal(squareBlankRetainedStub(SQUARE, 5, 5), null, 'empty span has no stub')
  assert.equal(squareBlankRetainedStub(SQUARE, 5, 3), null, 'reversed span has no stub')
  console.log('square model: retained ends are closed square prisms at the pivot')
}

// ── 3. Angular sampling is conservative at the corner radius ──────────
{
  const mesh = cylinderMesh(SQUARE, TARGET_RADIUS, BAND_START, BAND_END)
  const roundMesh = cylinderMesh(ROUND_SAME_BOX, TARGET_RADIUS, BAND_START, BAND_END)
  const squareMoves = generateRotaryFinish('passes-square', mesh, SQUARE, BALL, PARAMS, {}).moves
  const roundMoves = generateRotaryFinish('passes-round', roundMesh, ROUND_SAME_BOX, BALL, PARAMS, {}).moves
  const squarePasses = Math.ceil(2 * Math.PI * MAX_R / PARAMS.stepover)
  const roundPasses = Math.ceil(2 * Math.PI * barInscribedRadius(ROUND_SAME_BOX) / PARAMS.stepover)
  assert.equal(distinctAngles(squareMoves), squarePasses, 'square passes are spaced for the corner radius')
  assert.equal(distinctAngles(roundMoves), roundPasses, 'round passes are spaced for the surface radius')
  assert.ok(squarePasses > roundPasses, 'the corner radius demands more passes than the inscribed circle')
  assert.ok(squareMoves.length > 0 && roundMoves.length > 0, 'both generators produce motion')
  console.log(`square model: ${squarePasses} conservative passes vs ${roundPasses} round`)
}

// ── 4. Layers are numbered from the corner but start at the material ──
{
  const mesh = cylinderMesh(SQUARE, TARGET_RADIUS, BAND_START, BAND_END)
  const result = generateRotaryRough('rough', mesh, SQUARE, FLAT, PARAMS, {})
  assert.ok(result.moves.length > 0, 'the square rough produces motion')
  const layers = Math.ceil((MAX_R - TARGET_RADIUS) / PARAMS.stepdown)
  assert.equal(layers, 3, 'layers are still counted from the corner radius')
  const usedLayers = new Set(result.moves.filter((m) => m.kind !== 'rapid').map((m) => Math.floor(m.to.a! / 360)))
  assert.deepEqual([...usedLayers].sort((a, b) => a - b), [0, 1, 2], 'the corner passes still cut from the first layer')
  // A flat's blank surface is half the side, not the corner. The old rough
  // emitted two flat-direction layers wholly above it (corner − stepdown and
  // corner − 2·stepdown); the first layer that reaches the material is now the
  // first one below the flat surface, and it bites less than one stepdown.
  const baseAngle = (a: number): number => ((a % 360) + 360) % 360
  // The shoulder-refined ends start at the blank's own surface (10); the layer
  // cuts are the ones below it.
  const flatCuts = result.moves.filter((m) => m.kind === 'cut'
    && baseAngle(m.to.a ?? 0) === 0 && m.to.z - PIVOT < H - 1e-9
    && m.to.x >= BAND_START + 2 - 1e-9 && m.to.x <= BAND_END - 2 + 1e-9)
  assert.ok(flatCuts.length > 0, 'the flat direction still cuts')
  // Nothing may cut above the flat at all: the old layer 0 did, one stepdown
  // below the corner (11.142 on this blank).
  const aboveSurface = result.moves.filter((m) => m.kind === 'cut'
    && baseAngle(m.to.a ?? 0) === 0 && m.to.z - PIVOT > H + 1e-9 && m.to.z - PIVOT <= MAX_R + 1e-9)
  assert.deepEqual(aboveSurface, [], 'no flat-direction cut is emitted above the blank surface')
  const firstTip = Math.max(...flatCuts.map((m) => m.to.z)) - PIVOT
  approx(firstTip, MAX_R - 2 * PARAMS.stepdown, 'the first flat cut is the first layer below the surface', 1e-6)
  assert.ok(H - firstTip <= PARAMS.stepdown + 1e-9,
    `the first flat cut is no deeper than one stepdown (${(H - firstTip).toFixed(4)})`)
  assert.ok(flatCuts.every((m) => m.to.z - PIVOT < MAX_R - PARAMS.stepdown - 1e-9),
    'no flat-direction cut is emitted at the corner-radius layer')
  // Every between-run move clears the corner envelope plus the 1 mm clearance.
  const travelZ = PIVOT + MAX_R + 1
  let checked = 0
  for (let i = 0; i < result.moves.length; i++) {
    const move = result.moves[i]
    if (move.kind !== 'rapid') continue
    assert.ok(move.to.z >= travelZ - 1e-9, `rapid ${i} clears the corner envelope`)
    if (i > 0 && i < result.moves.length - 1) {
      assert.ok(Math.abs(move.to.z - travelZ) < 1e-9, `rapid ${i} travels at the corner envelope plus 1 mm`)
      checked++
    }
  }
  assert.ok(checked > 0, 'the between-run travel height is exercised')
  console.log(`square model: ${layers} layers from corner radius ${MAX_R.toFixed(4)}, travel ${travelZ.toFixed(4)}`)
}

// ── 5. Physical sweep: finite cutters against the analytic blank ──────
//
// Seeded cases on both axes, mm and inch, flat and ball cutters. Every cut,
// plunge and link move is walked; the real cutter is mapped into the unturned
// blank through the frozen rotation and tested against the analytic target
// cylinder and the analytic retained box. The measured penetration is compared
// with the per-case discretization allowance, never a fitted constant.
{
  let state = 0x1016c253 >>> 0
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const CASES: Array<{ axis: 'x' | 'y'; tool: NormalizedTool; scale: number; units: 'mm' | 'inch' }> = []
  for (const axis of ['x', 'y'] as const) {
    for (const units of ['mm', 'inch'] as const) {
      const scale = units === 'mm' ? 1 : 0.03937007874015748
      for (const type of ['flat_endmill', 'ball_endmill'] as const) {
        const radius = (1 + random() * 1.5) * scale
        CASES.push({ axis, units, scale, tool: { ...BALL, type, units, radius, diameter: radius * 2 } })
      }
    }
  }

  let worstModel = 0
  let worstRetained = 0
  let worstCentreline = 0
  let worstRapid = 0
  let worstRatio = 0
  let movesWalked = 0
  let stepsWalked = 0

  for (const [caseIndex, testCase] of CASES.entries()) {
    const { axis, tool, scale } = testCase
    const square = squareStock(SIDE * scale, LENGTH * scale, axis)
    // Literal blank geometry from the side, independent of the helpers.
    const h = SIDE * scale / 2
    const bigR = SIDE * scale * Math.SQRT1_2
    const pivot = SIDE * scale / 2
    const centre = h
    const targetRadius = TARGET_RADIUS * scale
    const bandStart = BAND_START * scale
    const bandEnd = BAND_END * scale
    const blankEnd = LENGTH * scale
    const cell = 0.2 * scale
    const sampleSpacing = 1 * scale
    const mesh = cylinderMesh(square, targetRadius, bandStart, bandEnd, 96)
    const params = {
      stepover: 3 * scale, stepdown: 2 * scale, sampleSpacing, stockToLeave: 0,
      alongStart: bandStart, alongEnd: bandEnd, safeRadius: 4 * scale, requestedCellSize: cell,
    }
    const offsets = cutterOffsets(tool)
    const travelZ = pivot + bigR + scale
    const interpolation = tool.type === 'ball_endmill' ? sampleSpacing * sampleSpacing / (8 * tool.radius) : 0
    const tolerance = cell + 0.001 * scale + interpolation
    let caseModel = 0
    let caseRetained = 0

    for (const result of [
      generateRotaryFinish(`sweep-finish-${caseIndex}`, mesh, square, tool, params, {}),
      generateRotaryRough(`sweep-rough-${caseIndex}`, mesh, square, tool, params, {}),
    ]) {
      assert.ok(result.moves.length > 0, `case ${caseIndex} produces motion`)
      const first = result.moves[0]
      assert.equal(first.kind, 'rapid', `case ${caseIndex} opens with a rapid`)
      assert.deepEqual(first.from, first.to, `case ${caseIndex} positions before cutting`)
      assert.equal(result.moves[result.moves.length - 1].kind, 'rapid', `case ${caseIndex} ends with a retract`)
      for (const move of result.moves) {
        if (move.kind === 'rapid') {
          // A vertical retract leaves the cut tip and rises; only where the
          // move also travels or turns must both ends already clear the blank.
          worstRapid = Math.max(worstRapid, travelZ - Math.max(move.from.z, move.to.z))
          if (move.from.x !== move.to.x || move.from.y !== move.to.y || move.from.a !== move.to.a) {
            worstRapid = Math.max(worstRapid, travelZ - Math.min(move.from.z, move.to.z))
          }
          continue
        }
        movesWalked++
        const a0 = move.from.a ?? 0
        const a1 = move.to.a ?? a0
        const dx = move.to.x - move.from.x
        const dy = move.to.y - move.from.y
        const dz = move.to.z - move.from.z
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / (0.1 * tool.radius)))
        for (let s = 0; s <= steps; s++) {
          const f = s / steps
          stepsWalked++
          const px = move.from.x + dx * f
          const py = move.from.y + dy * f
          const pz = move.from.z + dz * f
          worstCentreline = Math.max(worstCentreline, pivot - pz)
          const angle = a0 + (a1 - a0) * f
          for (const offset of offsets) {
            // The frozen tool → unturned-stock map, point by point.
            const stockPoint = stockSpacePoint({ x: px + offset[0], y: py + offset[1], z: pz + offset[2], a: angle }, square)
            const l = square.axis === 'x' ? stockPoint.x : stockPoint.y
            const la = (square.axis === 'x' ? stockPoint.y : stockPoint.x) - centre
            const lu = stockPoint.z - pivot
            // Target: the analytic coaxial cylinder between its two end faces.
            if (l >= bandStart && l <= bandEnd) {
              const radial = Math.hypot(la, lu)
              if (radial < targetRadius) caseModel = Math.max(caseModel, Math.min(targetRadius - radial, l - bandStart, bandEnd - l))
            }
            // Retained: the analytic box outside the cut range, inside the blank.
            if (l >= 0 && l <= blankEnd && Math.abs(la) < h && Math.abs(lu) < h) {
              const depth = l < bandStart
                ? Math.min(bandStart - l, l)
                : l > bandEnd ? Math.min(l - bandEnd, blankEnd - l) : 0
              if (depth > 0) caseRetained = Math.max(caseRetained, Math.min(depth, h - Math.abs(la), h - Math.abs(lu)))
            }
          }
        }
      }
    }
    worstModel = Math.max(worstModel, caseModel)
    worstRetained = Math.max(worstRetained, caseRetained)
    const ratio = Math.max(caseModel, caseRetained) / tolerance
    if (ratio > 1) {
      console.log(`  case ${caseIndex} ${axis} ${testCase.units} ${tool.type} r=${tool.radius.toFixed(4)}: `
        + `target ${caseModel.toFixed(5)}, retained ${caseRetained.toFixed(5)}, tolerance ${tolerance.toFixed(5)}, ratio ${ratio.toFixed(3)}`)
    }
    worstRatio = Math.max(worstRatio, ratio)
  }
  assert.ok(movesWalked > 0, 'the sweep walks real motion')
  assert.ok(worstRatio <= 1, `no cutter enters the target or the retained square beyond the discretization allowance `
    + `(ratio ${worstRatio.toFixed(3)}; worst target ${worstModel.toFixed(4)}, worst retained ${worstRetained.toFixed(4)})`)
  assert.ok(worstCentreline <= 1e-6, `no cut, plunge or link goes below the pivot (${worstCentreline.toExponential(2)})`)
  assert.ok(worstRapid <= 1e-6, `every rapid clears the corner envelope (${worstRapid.toExponential(2)})`)
  console.log(`square sweep: ${CASES.length} cases, ${movesWalked} moves in ${stepsWalked} steps, `
    + `worst target ${worstModel.toFixed(4)}, worst retained ${worstRetained.toFixed(4)}, worst ratio ${worstRatio.toFixed(3)}`)
}

// ── 6. The machined band reaches the target; the square supports remain ─
{
  const mesh = cylinderMesh(SQUARE, TARGET_RADIUS, BAND_START, BAND_END)
  const rough = generateRotaryRough('final', mesh, SQUARE, FLAT, PARAMS, {})
  const lastLayer = Math.max(...rough.moves.filter((m) => m.kind !== 'rapid').map((m) => Math.floor(m.to.a! / 360)))
  const finalCuts = rough.moves.filter((m) => m.kind === 'cut' && m.to.a !== undefined && Math.floor(m.to.a / 360) === lastLayer)
  assert.ok(finalCuts.length > 0, 'the final layer cuts')
  const lowestTip = Math.min(...finalCuts.map((m) => m.to.z)) - PIVOT
  // The grid samples cell centres of the polygonal cylinder, so the reached
  // radius sits within one cell plus the tessellation sagitta of the analytic
  // target — and never below it.
  const gridAllowance = PARAMS.requestedCellSize + 0.01
  assert.ok(lowestTip >= TARGET_RADIUS - gridAllowance && lowestTip <= TARGET_RADIUS + 1e-6,
    `the final layer reaches the cylinder target radius (${lowestTip}, allowance ${gridAllowance})`)
  // Response to inputs: stepdown, stepover and stock to leave all change output.
  const fewerLayers = generateRotaryRough('final-large-step', mesh, SQUARE, FLAT, { ...PARAMS, stepdown: 9 }, {})
  assert.notDeepEqual(fewerLayers.moves, rough.moves, 'stepdown changes the rough output')
  const finerAngles = generateRotaryFinish('finish-fine', mesh, SQUARE, BALL, { ...PARAMS, stepover: 2 }, {})
  const coarseAngles = generateRotaryFinish('finish-coarse', mesh, SQUARE, BALL, PARAMS, {})
  assert.ok(distinctAngles(finerAngles.moves) > distinctAngles(coarseAngles.moves), 'stepover changes the pass count')
  const leave = generateRotaryFinish('finish-leave', mesh, SQUARE, BALL, { ...PARAMS, stockToLeave: 0.5 }, {})
  assert.notDeepEqual(leave.moves, coarseAngles.moves, 'stock to leave changes the finish output')
  assert.ok(leave.moves.every((move) => move.to.z >= PIVOT), 'stock to leave never cuts below the pivot')
  const inchSquare = squareStock(SIDE * 0.0254, LENGTH * 0.0254, 'x')
  const inch = generateRotaryFinish('finish-inch', cylinderMesh(inchSquare, TARGET_RADIUS * 0.0254, BAND_START * 0.0254, BAND_END * 0.0254, 64),
    inchSquare, { ...BALL, units: 'inch', radius: BALL.radius * 0.0254, diameter: BALL.diameter * 0.0254 },
    { ...PARAMS, stepover: PARAMS.stepover * 0.0254, sampleSpacing: PARAMS.sampleSpacing * 0.0254,
      requestedCellSize: PARAMS.requestedCellSize * 0.0254,
      alongStart: BAND_START * 0.0254, alongEnd: BAND_END * 0.0254 }, {})
  assert.ok(inch.moves.length > 0, 'an inch square blank generates motion')
  console.log(`square model: final layer reaches r=${TARGET_RADIUS} with the square supports retained`)
}

// ── 7. Turned positions still equal the frozen frame on a square ──────
{
  const mesh = cylinderMesh(SQUARE, TARGET_RADIUS, BAND_START, BAND_END, 32)
  const original = mesh.positions.slice()
  for (const angle of [0, 22.5, 45, -137, 450]) {
    const turned = turnedModelPositions(mesh.positions, SQUARE, angle)
    for (let i = 0; i < turned.length; i += 3) {
      const expected = toolSpacePoint({ x: original[i], y: original[i + 1], z: original[i + 2] }, angle, SQUARE)
      assert.deepEqual(Array.from(turned.slice(i, i + 3)), Array.from(new Float32Array([expected.x, expected.y, expected.z])),
        `square turning angle ${angle} vertex ${i / 3}`)
    }
  }
  assert.equal(PIVOT, SIDE / 2, 'the square pivot is the box centre, not the corner radius')
  console.log('square model: turning is the frozen pivot rotation, vertex for vertex')
}

// ── 8. Coarse and misaligned spacing at the retained shoulder ─────────
//
// The correction's exact repro (#1016 C2-S3): a 20 x 60 square blank, a
// 12 mm-radius target band 18..42, a 4 mm flat end mill, `sampleSpacing` 12
// (three along samples) and 45 included. Before the shoulder refinement the
// single 30 -> 18 move at 45 dropped the cutter's back rim **0.490904 mm**
// inside the retained square; the 8.125 mm rise over the 12 mm span is gentler
// than the steep-step guard's 45-degree threshold at that spacing, so the guard
// never fired.
//
// Every case below walks the real cutter (flat disc / ball lower hemisphere)
// along every cut, plunge and link move, maps it through the frozen
// `stockSpacePoint` rotation and tests it against the **analytic** retained box
// at both band ends and the **analytic** target cylinder. The spacing is
// coarser than the cutter footprint (`2 * radius`) in every case, and the
// seeded grids are deliberately misaligned so no sample lands on the shoulder.
// No timing assertions.
{
  // The exact manager repro.
  const managerParams = {
    stepover: 2 * Math.PI * MAX_R / 8, sampleSpacing: 12, stockToLeave: 0,
    alongStart: BAND_START, alongEnd: BAND_END, safeRadius: 20, requestedCellSize: 0.05, stepdown: 3,
  }
  const managerMesh = cylinderMesh(SQUARE, TARGET_RADIUS, BAND_START, BAND_END)
  const manager = sweep(SQUARE, FLAT, managerMesh, managerParams, TARGET_RADIUS)
  const managerAllowance = managerParams.requestedCellSize + 1e-3
  assert.ok(manager.retained <= managerAllowance,
    `the exact coarse-shoulder repro stays inside one height-map cell (${manager.retained.toFixed(6)} <= ${managerAllowance})`)
  // The single straight move that gouged is gone: before the correction this
  // segment existed and its rim sat 0.490904 mm inside the retained square.
  const spansShoulder = generateRotaryFinish('manager-shape', managerMesh, SQUARE, FLAT, managerParams, {}).moves.some(
    (move) => move.kind === 'cut' && move.from.a === 45 && move.to.a === 45
      && Math.min(move.from.x, move.to.x) === BAND_START && Math.max(move.from.x, move.to.x) === 30)
  assert.ok(!spansShoulder, 'the coarse shoulder is no longer spanned by one straight move at 45 degrees')
  console.log(`square shoulder: exact repro retained penetration ${manager.retained.toFixed(6)} mm `
    + `(allowance ${managerAllowance.toFixed(4)}), ${manager.moves} moves`)

  // Seeded coarse / misaligned cases on both axes, mm and inch, on- and
  // off-origin, flat and ball, with and without stock to leave. Spacings 12 and
  // 7.3 mm (project units) are both larger than the 2.4-4.8 mm cutter footprint,
  // and neither divides the 24 mm band, so the intervals cross the shoulder
  // reach off-grid. Stock to leave widens the sampling footprint, moving the
  // step further inside the range.
  const scaleOf = (units: 'mm' | 'inch'): number => units === 'mm' ? 1 : 0.03937007874015748
  let worstRetained = 0
  let worstTarget = 0
  let cases = 0
  for (const axis of ['x', 'y'] as const) {
    for (const units of ['mm', 'inch'] as const) {
      for (const offset of [false, true]) {
        for (const type of ['flat_endmill', 'ball_endmill'] as const) {
          for (const leave of [0, 0.8]) {
            const scale = scaleOf(units)
            const stock = squareStock(SIDE * scale, LENGTH * scale, axis, offset ? { x: 11 * scale, y: -7 * scale } : { x: 0, y: 0 })
            const bounds = getStockBounds(stock)
            const lower = axis === 'x' ? bounds.minX : bounds.minY
            const targetRadius = TARGET_RADIUS * scale
            const bandStart = lower + BAND_START * scale
            const bandEnd = bandStart + (BAND_END - BAND_START) * scale
            const radius = (1.2 + (cases % 3) * 0.6) * scale
            const tool: NormalizedTool = { ...BALL, type, units, radius, diameter: radius * 2 }
            const spacing = (cases % 2 === 0 ? 12 : 7.3) * scale
            const params = {
              stepover: 2 * Math.PI * barMaxRadius(stock) / (7 + (cases % 3)), stepdown: 2 * scale,
              sampleSpacing: spacing, stockToLeave: leave * scale, alongStart: bandStart, alongEnd: bandEnd,
              safeRadius: 4 * scale, requestedCellSize: 0.05 * scale,
            }
            assert.ok(spacing > 2 * radius, `case ${cases} spacing is coarser than the cutter footprint`)
            const mesh = cylinderMesh(stock, targetRadius, bandStart, bandEnd, 96)
            const measured = sweep(stock, tool, mesh, params, targetRadius)
            const allowance = params.requestedCellSize + 1e-3 * scale
            assert.ok(measured.retained <= allowance, `case ${cases} (${axis}/${units}/${offset ? 'off' : 'on'}/${type}/leave ${leave}) `
              + `does not enter the retained square (${measured.retained.toFixed(6)} <= ${allowance.toFixed(6)})`)
            assert.ok(measured.target <= allowance, `case ${cases} (${axis}/${units}/${offset ? 'off' : 'on'}/${type}/leave ${leave}) `
              + `does not gouge the target cylinder (${measured.target.toFixed(6)} <= ${allowance.toFixed(6)})`)
            worstRetained = Math.max(worstRetained, measured.retained)
            worstTarget = Math.max(worstTarget, measured.target)
            cases++
          }
        }
      }
    }
  }
  assert.ok(cases === 32, 'both axes, mm and inch, on and off origin, flat and ball, with and without stock to leave are all exercised')
  console.log(`square shoulder: ${cases} coarse/misaligned cases, worst retained ${worstRetained.toFixed(6)}, `
    + `worst target ${worstTarget.toFixed(6)}`)
}

// ── 9. The refined grid is budgeted and the shoulder cap is proven ────
//
// Two independent safety gaps from the pass-2 review of the shoulder
// refinement (#1016 C2-S3):
//
// (a) `rotaryRefusal` bounds the *uniform* `passes x (intervals + 1)` grid, but
//     the shoulder refinement then adds up to `2 * MAX_SHOULDER_SAMPLES`
//     positions. A 100,000-pass operation with a tiny finite cell passed the
//     uniform bound at 300,000 samples and then asked for ~8e8. The generator
//     must refuse the **refined** count before an angle row is allocated or an
//     angle is sampled.
// (b) `MAX_SHOULDER_SAMPLES` can widen the added spacing past the cell the
//     sampler actually uses, which invalidates the one-cell proof. The proof is
//     evaluated at a flat -- the smallest cell any angle of the turn uses -- and
//     the job is refused when the capped spacing cannot honour it, never
//     accepted at a coarser tolerance in silence.
{
  // A generator run whose `onAngle` throws: in the corrected code the refusal
  // happens before the sampler, so the hook never fires. The thrown error turns
  // a regression (the refactor deleting the guard) into a fast failure instead
  // of an ~8e8-sample allocation.
  const runBeforeSampling = <T>(
    run: (onAngle: (done: number, total: number) => void) => T,
    label: string,
  ): { result: T; sampled: boolean } => {
    let sampled = false
    try {
      const result = run(() => { sampled = true; throw new Error('sampling started') })
      return { result, sampled }
    } catch (error) {
      assert.fail(`${label}: the job must refuse before sampling (${String(error)})`)
    }
  }

  // (a) The refined-count guard: the uniform bound the old check applied passes
  // (100,000 passes x 3 uniform positions = 300,000), but the refined grid is
  // 100,000 x ~8,193 = ~8.2e8 and must be refused first.
  const refinedMesh = cylinderMesh(SQUARE, TARGET_RADIUS, BAND_START, BAND_END)
  const refinedParams = {
    stepover: (2 * Math.PI * MAX_R) / 100000, stepdown: 3, sampleSpacing: 12, stockToLeave: 0,
    alongStart: BAND_START, alongEnd: BAND_END, safeRadius: 20, requestedCellSize: 1e-6,
  }
  const uniformPositions = Math.ceil((refinedParams.alongEnd - refinedParams.alongStart) / refinedParams.sampleSpacing) + 1
  assert.ok(100000 * uniformPositions <= 16_000_000, 'the uniform bound the old guard checked passes for this job')
  for (const [label, run] of [
    ['refined count (finish)', (onAngle: (done: number, total: number) => void) =>
      generateRotaryFinish('refined-count-finish', refinedMesh, SQUARE, FLAT, refinedParams, { onAngle })],
    ['refined count (rough)', (onAngle: (done: number, total: number) => void) =>
      generateRotaryRough('refined-count-rough', refinedMesh, SQUARE, FLAT, refinedParams, { onAngle })],
  ] as const) {
    const { result, sampled } = runBeforeSampling(run, label)
    assert.equal(sampled, false, `${label}: no angle row is allocated or sampled`)
    assert.deepEqual(result.moves, [], `${label}: the refused job emits no motion`)
    assert.deepEqual(result.warnings.map((w) => w.code), ['operationStepoverRatioRange'],
      `${label}: refuses with the sampling-ratio code`)
  }

  // (b) The collapsed-span refusal wins. A 0.4 x 0.5 blank with a 4 mm cutter
  // (radius 2) cannot hold a band longer than the cutter's diameter, so after
  // #1016 C2-F7 pulls the centre one cutter radius inside each stubbed end the
  // cutter-centre span is empty: the job refuses with `rotaryNoRoom` before any
  // grid work, whatever the requested cell would have done. Both axes, mm and
  // inch, on and off origin, flat and ball, both ends (a misaligned band) and
  // stock to leave on and off.
  const scaleOf = (units: 'mm' | 'inch'): number => units === 'mm' ? 1 : 0.03937007874015748
  let collapsedRefusals = 0
  for (const axis of ['x', 'y'] as const) {
    for (const units of ['mm', 'inch'] as const) {
      for (const offset of [false, true]) {
        for (const type of ['flat_endmill', 'ball_endmill'] as const) {
          for (const leave of [0, 0.8]) {
            const scale = scaleOf(units)
            const stock = squareStock(0.4 * scale, 0.5 * scale, axis, offset ? { x: 0.13 * scale, y: -0.07 * scale } : { x: 0, y: 0 })
            const bounds = getStockBounds(stock)
            const lower = axis === 'x' ? bounds.minX : bounds.minY
            const upper = axis === 'x' ? bounds.maxX : bounds.maxY
            const length = 0.5 * scale
            const start = lower + 0.2 * length
            const end = start + 0.25 * length
            const tool: NormalizedTool = { ...BALL, type, units, radius: 2 * scale, diameter: 4 * scale }
            const params = {
              stepover: 0.5 * scale, stepdown: 0.2 * scale, sampleSpacing: 0.1 * scale, stockToLeave: leave * scale,
              alongStart: start, alongEnd: end, safeRadius: 5 * scale, requestedCellSize: 4.4e-4 * scale,
            }
            assert.ok(start > lower && end < upper, 'the misaligned band leaves a retained shoulder at both ends')
            const mesh = cylinderMesh(stock, 0.08 * scale, start, end, 32)
            const label = `collapsed span (${axis}/${units}/${offset ? 'off' : 'on'}/${type}/leave ${leave})`
            const { result, sampled } = runBeforeSampling(
              (onAngle) => generateRotaryFinish('collapsed-span', mesh, stock, tool, params, { onAngle }),
              label,
            )
            assert.equal(sampled, false, `${label}: no angle is sampled`)
            assert.deepEqual(result.moves, [], `${label}: emits no motion`)
            assert.deepEqual(result.warnings.map((w) => w.code), ['rotaryNoRoom'],
              `${label}: the empty span wins over the requested sampling density`)
            collapsedRefusals++
          }
        }
      }
    }
  }
  assert.equal(collapsedRefusals, 32, 'both axes, mm and inch, on and off origin, flat and ball, both ends and both stock values are exercised')

  // (b2) The capped-spacing guard still refuses a span that survives. A long,
  // thin 0.1 x 8.5 mm blank with a 4.2 mm radius cutter leaves a 0.05 mm
  // cutter-centre span, while the requested 1e-3 cell is below
  // `zone / MAX_SHOULDER_SAMPLES`: the cap widens the added shoulder spacing
  // past the flat-aligned effective cell (the height-map cell cap does not widen
  // that one), so the job refuses before sampling instead of accepting a coarser
  // shoulder resolution. Both axes and both cutter shapes.
  let cappedRefusals = 0
  for (const axis of ['x', 'y'] as const) {
    for (const type of ['flat_endmill', 'ball_endmill'] as const) {
      const stock = squareStock(0.1, 8.5, axis)
      const bounds = getStockBounds(stock)
      const lower = axis === 'x' ? bounds.minX : bounds.minY
      const upper = axis === 'x' ? bounds.maxX : bounds.maxY
      const start = lower + 0.02
      const end = upper - 0.03
      const tool: NormalizedTool = { ...BALL, type, units: 'mm', radius: 4.2, diameter: 8.4 }
      const params = {
        stepover: 0.5, stepdown: 0.2, sampleSpacing: 0.1, stockToLeave: 0,
        alongStart: start, alongEnd: end, safeRadius: 5, requestedCellSize: 1e-3,
      }
      assert.ok(start + tool.radius < end - tool.radius, 'the cap fixture still leaves a cutter-centre span')
      const label = `capped spacing (${axis}/${type})`
      const { result, sampled } = runBeforeSampling(
        (onAngle) => generateRotaryFinish('capped-cell', cylinderMesh(stock, 0.02, start, end, 32), stock, tool, params, { onAngle }),
        label,
      )
      assert.equal(sampled, false, `${label}: no angle is sampled`)
      assert.deepEqual(result.moves, [], `${label}: emits no motion`)
      assert.deepEqual(result.warnings.map((w) => w.code), ['operationStepoverRatioRange'], `${label}: refuses`)
      cappedRefusals++
    }
  }
  assert.equal(cappedRefusals, 4, 'both axes and both cutter shapes exercise the capped-spacing guard')

  // The same geometry with a requested cell one step *above* the cap still
  // generates -- the guard refuses only the spacing that cannot honour the
  // effective cell, it is not a blanket refusal of capped jobs.
  {
    let nearCapCases = 0
    for (const axis of ['x', 'y'] as const) {
      const stock = squareStock(0.1, 8.5, axis)
      const bounds = getStockBounds(stock)
      const lower = axis === 'x' ? bounds.minX : bounds.minY
      const upper = axis === 'x' ? bounds.maxX : bounds.maxY
      const start = lower + 0.02
      const end = upper - 0.03
      const tool: NormalizedTool = { ...BALL, type: 'flat_endmill', units: 'mm', radius: 4.2, diameter: 8.4 }
      const params = {
        stepover: 0.5, stepdown: 0.2, sampleSpacing: 0.1, stockToLeave: 0,
        alongStart: start, alongEnd: end, safeRadius: 5, requestedCellSize: 1.1e-3,
      }
      const near = generateRotaryFinish('near-cap', cylinderMesh(stock, 0.02, start, end, 32), stock, tool, params, {})
      assert.ok(near.moves.length > 0, `near-cap (${axis}) still generates`)
      assert.deepEqual(near.warnings, [], `near-cap (${axis}) raises no warning`)
      nearCapCases++
    }
    assert.equal(nearCapCases, 2, 'near-cap jobs generate on both axes')
  }

  // (c) The bound is *proven* when the cap binds on a real part: the manager
  // geometry (20 x 60, band 18..42) at a requested cell far below the sampler's
  // effective cell. The cap widens the added spacing to
  // `zone / MAX_SHOULDER_SAMPLES`, but the guard admits it because that spacing
  // is still inside the **narrowest** effective cell (the flat-aligned one, the
  // worst case for resolving the step). The residual the sweep measures is the
  // drop's height-map quantization, bounded by the **widest** effective cell
  // (the corner-aligned one, the worst case for the map itself). The test uses
  // that widest effective cell -- several orders above the requested 1e-6 --
  // and never the requested one.
  for (const axis of ['x', 'y'] as const) {
    for (const units of ['mm', 'inch'] as const) {
      for (const type of ['flat_endmill', 'ball_endmill'] as const) {
        for (const leave of [0, 0.8]) {
          const scale = scaleOf(units)
          const stock = squareStock(SIDE * scale, LENGTH * scale, axis)
          const bounds = getStockBounds(stock)
          const lower = axis === 'x' ? bounds.minX : bounds.minY
          const upper = axis === 'x' ? bounds.maxX : bounds.maxY
          const bandStart = lower + BAND_START * scale
          const bandEnd = bandStart + (BAND_END - BAND_START) * scale
          const tool: NormalizedTool = { ...BALL, type, units, radius: 2 * scale, diameter: 4 * scale }
          const params = {
            stepover: (2 * Math.PI * barMaxRadius(stock)) / 8, stepdown: 3 * scale, sampleSpacing: 12 * scale,
            stockToLeave: leave * scale, alongStart: bandStart, alongEnd: bandEnd, safeRadius: 20 * scale,
            requestedCellSize: 1e-6,
          }
          const centre = barCentre(stock)
          const envelope = barMaxRadius(stock)
          const samplingBounds = axis === 'x'
            ? { minX: lower, maxX: upper, minY: centre - envelope, maxY: centre + envelope }
            : { minX: centre - envelope, maxX: centre + envelope, minY: lower, maxY: upper }
          const effectiveCell = chooseHeightMapCellSize(samplingBounds, params.requestedCellSize, [])
          assert.ok(effectiveCell > params.requestedCellSize * 1000,
            `the cap widens the effective cell far above the requested one (${effectiveCell})`)
          const measured = sweep(stock, tool, cylinderMesh(stock, TARGET_RADIUS * scale, bandStart, bandEnd, 96), params, TARGET_RADIUS * scale)
          const allowance = effectiveCell + 1e-3 * scale
          assert.ok(measured.retained <= allowance, `cap-bound retained (${axis}/${units}/${type}/leave ${leave}) `
            + `stays within the effective cell (${measured.retained.toFixed(6)} <= ${allowance.toFixed(6)})`)
          assert.ok(measured.target <= allowance, `cap-bound target (${axis}/${units}/${type}/leave ${leave}) `
            + `stays within the effective cell (${measured.target.toFixed(6)} <= ${allowance.toFixed(6)})`)
        }
      }
    }
  }
  console.log('square count: refined-count and shoulder-cap refusals happen before allocation; the cap bound is proven')
}

// ── 9. an unusable radial allowance refuses instead of cutting to the axis ──
//
// The correction's exact repro (#1016 C2 M1): a 4 mm ball (2 mm radius) with a
// -2 mm radial
// allowance gives the sampler a zero radius, every sample reads "no model",
// and the rough maps that empty space to radius 0, posting thousands of moves
// down to the pivot. The allowance and the derived sampling radius are
// validated before sampling, and the sampler itself reports invalid tool
// geometry as "no rows", never as a NaN row that means "no model here".
{
  const mesh = cylinderMesh(SQUARE, TARGET_RADIUS, BAND_START, BAND_END)
  const params = { ...PARAMS, stepover: 3, stepdown: 2 }
  const valid = generateRotaryRough('valid-allowance', mesh, SQUARE, BALL, params, {})
  assert.ok(valid.moves.length > 0, 'the fixture generates with a valid allowance')
  const validLeave = generateRotaryRough('valid-allowance-leave', mesh, SQUARE, BALL, { ...params, stockToLeave: 0.5 }, {})
  assert.ok(validLeave.moves.length > 0, 'a valid positive allowance still generates')
  assert.deepEqual(validLeave.warnings, [], 'a valid allowance raises no warning')

  // -2 gives a zero sampling radius on this 2 mm radius ball, -3 a negative one; both
  // also fail the non-negative allowance rule. NaN and Infinity fail finiteness.
  for (const allow of [-2, -3, NaN, Infinity]) {
    for (const generate of [generateRotaryRough, generateRotaryFinish]) {
      const result = generate(`invalid-${String(allow)}`, mesh, SQUARE, BALL, { ...params, stockToLeave: allow }, {})
      assert.deepEqual(result.moves, [], `allowance ${String(allow)}: ${generate.name} emits no moves`)
      assert.deepEqual(result.warnings.map((warning) => warning.code), ['rotaryStockToLeaveInvalid'],
        `allowance ${String(allow)}: ${generate.name} says why`)
      assert.equal(result.bounds, null, `allowance ${String(allow)}: ${generate.name} has no bounds`)
    }
  }

  // The sampler distinguishes invalid geometry from empty space: no angle rows
  // at all and `valid: false`, rather than rows of NaN that the rough would
  // map to a cut down the axis.
  const invalidSampling = sampleRotaryModel(mesh, SQUARE, { ...BALL, radius: -1, diameter: -2 }, {
    anglesDeg: [0, 45], along: [BAND_START, BAND_END], requestedCellSize: PARAMS.requestedCellSize,
  }, [])
  assert.equal(invalidSampling.valid, false, 'the sampler reports invalid tool geometry')
  assert.deepEqual(invalidSampling.anglesDeg, [], 'invalid geometry produced no angle rows')
  assert.deepEqual(invalidSampling.tipRadius, [], 'invalid geometry cannot look like empty space')
}

console.log('engine/toolpaths/squareRotaryModel.test.ts: all assertions passed')
