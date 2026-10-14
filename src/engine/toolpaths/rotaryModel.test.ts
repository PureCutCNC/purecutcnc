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

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { roundStock, roundStockCentre } from '../../types/project'
import type { RoundStock } from '../../types/project'
import { aroundFrame, unwrapToolpath, wrapPoint } from '../aroundFrame'
import { deserializeImportedMesh } from '../importedMesh'
import { toolSpacePoint } from '../rotaryFrame'
import { computeXYBounds } from './finishSurfaceParallel'
import { generateRotaryFinish, sampleRotaryModel, turnedModelPositions } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import type { NormalizedTool } from './types'
import type { ToolpathWarning } from './warningCodes'

const BALL: NormalizedTool = {
  id: 'ball-3', name: '3 mm ball nose', sourceUnits: 'mm', units: 'mm',
  type: 'ball_endmill', diameter: 3, radius: 1.5, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}
const CELL = 0.05
const W = 4
const RC = 6
const SEGMENTS = 128
// Polygon sag = rc*(1-cos(pi/128)) < 0.002 mm. Cell-centre sampling
// near these smooth contacts costs at most two cells (0.1 mm); the square's
// steepest tested face has slope 1. At 45° missing the exact corner adds
// at most one cell. 0.11 mm covers both plus Float32 rounding.
const TOLERANCE = 0.11

function approx(actual: number, expected: number, label: string, tolerance = TOLERANCE): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: got ${actual}, expected ${expected}`)
}

/** Closed extrusion: two triangulated caps and triangulated side quads. */
function prism(stock: RoundStock, crossSection: readonly (readonly [number, number])[], ends = [10, 30]): RotaryModelMesh {
  const positions: number[] = []
  const index: number[] = []
  const centre = roundStockCentre(stock)
  const radius = stock.thickness / 2
  for (const along of ends) {
    for (const [across, up] of crossSection) {
      positions.push(...(stock.axis === 'x'
        ? [along, centre + across, radius + up]
        : [centre + across, along, radius + up]))
    }
  }
  const n = crossSection.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    index.push(i, j, n + j, i, n + j, n + i)
  }
  for (let i = 1; i < n - 1; i++) index.push(0, i + 1, i, n, n + i, n + i + 1)
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

const SQUARE = [[-W, -W], [W, -W], [W, W], [-W, W]] as const
const CIRCLE = Array.from({ length: SEGMENTS }, (_, i): readonly [number, number] => {
  const t = 2 * Math.PI * i / SEGMENTS
  return [RC * Math.cos(t), RC * Math.sin(t)]
})

for (const axis of ['x', 'y'] as const) {
  // Deliberately translated across-axis stock: catches using R as the centre.
  const stock = roundStock(40, 80, axis, axis === 'x' ? { x: 0, y: 7 } : { x: 7, y: 0 })
  const mesh = prism(stock, SQUARE)
  const original = mesh.positions.slice()
  for (const angle of [0, 22.5, 90, -137, 450]) {
    const turned = turnedModelPositions(mesh.positions, stock, angle)
    for (let i = 0; i < turned.length; i += 3) {
      const expected = toolSpacePoint({ x: original[i], y: original[i + 1], z: original[i + 2] }, angle, stock)
      // Output is Float32, so compare to the same representable coordinates.
      assert.deepEqual(Array.from(turned.slice(i, i + 3)), Array.from(new Float32Array([expected.x, expected.y, expected.z])),
        `turning ${axis} ${angle} vertex ${i / 3}`)
    }
  }
  assert.deepEqual(turnedModelPositions(mesh.positions, stock, 0), original, `turning ${axis} zero identity`)
  const fullTurn = turnedModelPositions(mesh.positions, stock, 360)
  original.forEach((value, i) => approx(fullTurn[i], value, `turning ${axis} 360 identity`, 1e-9))
  assert.deepEqual(mesh.positions, original, 'turning preserves source positions')

  const anglesDeg = [450, -45, 0, 35, 90, 150, 225, 315, 720]
  const along = [15, 20, 25, 33]
  const cylinder = sampleRotaryModel(prism(stock, CIRCLE), stock, BALL, { anglesDeg, along, requestedCellSize: CELL }, [])
  assert.deepEqual(cylinder.anglesDeg, anglesDeg, 'cylinder preserves angle order and range')
  assert.deepEqual(cylinder.along, along, 'cylinder preserves along positions')
  assert.equal(cylinder.stopped, false)
  for (const [a, row] of cylinder.tipRadius.entries()) {
    for (let i = 0; i < 3; i++) approx(row[i], RC, `cylinder ${axis} ${anglesDeg[a]} along ${along[i]}`)
    assert.ok(Number.isNaN(row[3]), `cylinder ${axis} free travel beyond end is NaN`)
  }

  // At 0°, flat top z=w. At 45°, top corner is at y=0,z=sqrt(2)*w;
  // a ball centred above it touches that corner, giving tip radius sqrt(2)*w.
  // At theta=22.5°, tilted top face is z=w/cos(theta)+y*tan(theta).
  // Maximising z-rt+sqrt(rt²-y²) puts contact at y=rt*sin(theta),
  // giving (w+rt)/cos(theta)-rt. This contact lies inside the face.
  const theta = Math.PI / 8
  const expected = [W, (W + BALL.radius) / Math.cos(theta) - BALL.radius, Math.SQRT2 * W]
  const square = sampleRotaryModel(mesh, stock, BALL, { anglesDeg: [0, 22.5, 45], along: [15, 20, 25], requestedCellSize: CELL }, [])
  square.tipRadius.forEach((row, a) => row.forEach((value, i) => approx(value, expected[a], `square ${axis} angle ${square.anglesDeg[a]} along ${i}`)))

  // Negative radii are valid; callers decide whether to cut below the axis.
  const low = prism(stock, [[-2, -7], [2, -7], [2, -5], [-2, -5]])
  const below = sampleRotaryModel(low, stock, BALL, { anglesDeg: [0], along: [20], requestedCellSize: CELL }, [])
  approx(below.tipRadius[0][0], -5, `negative radius ${axis}`)
}

const STOCK = roundStock(40, 150)
const MESH = prism(STOCK, SQUARE)
{
  const calls: number[][] = []
  const options = { anglesDeg: [0, 20, 40, 60], along: [15, 25], requestedCellSize: CELL,
    onAngle: (done: number, total: number) => { calls.push([done, total]) } }
  const complete = sampleRotaryModel(MESH, STOCK, BALL, options, [])
  assert.equal(complete.tipRadius.length, 4, 'progress complete rows')
  assert.deepEqual(calls, [[1, 4], [2, 4], [3, 4], [4, 4]], 'progress once per completed angle')
  calls.length = 0
  let stopChecks = 0
  const partial = sampleRotaryModel(MESH, STOCK, BALL, { ...options,
    shouldStop: () => { stopChecks++; return calls.length === 2 } }, [])
  assert.deepEqual(partial.anglesDeg, [0, 20], 'stopping completed angles')
  assert.equal(partial.tipRadius.length, 2, 'stopping two rows')
  assert.equal(partial.stopped, true, 'stopping flag')
  assert.equal(stopChecks, 3, 'stopping checked before each angle')
  assert.deepEqual(calls, [[1, 4], [2, 4]], 'stopping progress only completed angles')
  const immediate = sampleRotaryModel(MESH, STOCK, BALL, { ...options, shouldStop: () => true }, [])
  assert.deepEqual(immediate.tipRadius, [], 'immediate stop has no rows')
  assert.equal(immediate.stopped, true)
  const empty = sampleRotaryModel(MESH, STOCK, BALL, { ...options, anglesDeg: [] }, [])
  assert.equal(empty.stopped, false, 'empty angle list is complete')
}
{
  const warnings: ToolpathWarning[] = [{ code: 'surfaceSilhouetteDegenerate' }]
  const result = sampleRotaryModel(MESH, STOCK, BALL, { anglesDeg: [0, 22.5, 45], along: [], requestedCellSize: 1e-6 }, warnings)
  assert.equal(result.tipRadius.length, 3, 'warnings all angles completed')
  assert.equal(warnings.filter((warning) => warning.code === 'surfaceHeightMapReduced').length, 1, 'warnings capped map deduplicated')
  assert.equal(warnings[0].code, 'surfaceSilhouetteDegenerate', 'warnings preserve caller warnings')
  sampleRotaryModel(MESH, STOCK, BALL, { anglesDeg: [0], along: [], requestedCellSize: 1e-6 }, warnings)
  assert.equal(warnings.filter((warning) => warning.code === 'surfaceHeightMapReduced').length, 1, 'warnings preserve existing cap warning')
}

/** Load and fit the measurement's real mesh inside D40,L150, with 1 mm radial margin. */
function fixtureMesh(): RotaryModelMesh {
  const project = JSON.parse(readFileSync(new URL('../test-fixtures/3d-imported-block-test3.camj', import.meta.url), 'utf8')) as {
    modelAssets: Record<string, Parameters<typeof deserializeImportedMesh>[0]>
  }
  const asset = project.modelAssets['model-asset-f4e6f18b-f62d-4c6a-8009-b46d7d581c5b']
  assert.ok(asset, 'fixture asset exists')
  const mesh = deserializeImportedMesh(asset)
  assert.ok(mesh, 'fixture deserializes')
  const p = mesh.positions
  const bounds = computeXYBounds(p)
  let minZ = Infinity, maxZ = -Infinity
  for (let i = 2; i < p.length; i += 3) { minZ = Math.min(minZ, p[i]); maxZ = Math.max(maxZ, p[i]) }
  const cy = (bounds.minY + bounds.maxY) / 2
  const cz = (minZ + maxZ) / 2
  let circumradius = 0
  for (let i = 0; i < p.length; i += 3) circumradius = Math.max(circumradius, Math.hypot(p[i + 1] - cy, p[i + 2] - cz))
  const scale = Math.min(150 / Math.max(1e-9, bounds.maxX - bounds.minX), 19 / Math.max(1e-9, circumradius))
  const positions = new Float32Array(p.length)
  for (let i = 0; i < p.length; i += 3) {
    positions[i] = (p[i] - bounds.minX) * scale
    positions[i + 1] = 20 + (p[i + 1] - cy) * scale
    positions[i + 2] = 20 + (p[i + 2] - cz) * scale
  }
  return { positions, index: new Uint32Array(mesh.index) }
}
const fixture = fixtureMesh()
const fixtureAlong = Array.from({ length: 751 }, (_, i) => i * 0.2)
const fixtureCell = Math.min(BALL.radius / 3, 0.1)
{
  // Closed square end pieces fix the bounds at 30° and 120°; the closed
  // asymmetric triangular middle gives different surfaces at along=20.
  // A plain square prism has identical surfaces after a quarter turn and
  // would let the shared-host mutation survive.
  const pieces = [prism(STOCK, SQUARE, [10, 12]), prism(STOCK, SQUARE, [28, 30]),
    prism(STOCK, [[-2, -2], [2, -2], [1, 3]], [15, 25])]
  const positions: number[] = []
  const index: number[] = []
  for (const piece of pieces) {
    const offset = positions.length / 3
    positions.push(...piece.positions)
    index.push(...Array.from(piece.index, (i) => i + offset))
  }
  const mesh = { positions: new Float32Array(positions), index: new Uint32Array(index) }
  const anglesDeg = [30, 120]
  const bounds = anglesDeg.map((angle) => computeXYBounds(turnedModelPositions(mesh.positions, STOCK, angle)))
  assert.deepEqual(bounds[0], bounds[1], 'cache turned boxes are exactly equal')
  const options = { anglesDeg, along: [16, 20, 24], requestedCellSize: CELL }
  const together = sampleRotaryModel(mesh, STOCK, BALL, options, [])
  const alone = anglesDeg.map((angle) => sampleRotaryModel(mesh, STOCK, BALL, { ...options, anglesDeg: [angle] }, []).tipRadius[0])
  assert.notDeepEqual(alone[0], alone[1], 'cache orientations really have different samples')
  together.tipRadius.forEach((row, i) => assert.deepEqual(row, alone[i], `cache angle ${anglesDeg[i]} matches fresh call`))
}
{
  const start = performance.now()
  const result = sampleRotaryModel(fixture, STOCK, BALL, {
    anglesDeg: Array.from({ length: 36 }, (_, i) => i * 10), along: fixtureAlong, requestedCellSize: fixtureCell,
  }, [])
  const elapsed = performance.now() - start
  assert.equal(result.tipRadius.length, 36, 'fixture timing completed all 36 angles')
  assert.ok(result.tipRadius.some((row) => row.some(Number.isFinite)), 'fixture timing sampled model')
  console.log(`rotaryModel fixture: ${(elapsed / 36).toFixed(3)} ms/angle (${elapsed.toFixed(1)} ms, 36 angles, 3 mm ball, cell ${fixtureCell} mm)`)
}

// ---------------------------------------------------------------------------
// Slice B: generateRotaryFinish.
// ---------------------------------------------------------------------------

const FINISH_RADIUS = 20
const FINISH_SAFE = 30
const FINISH_PASS_MM: NormalizedTool = { ...BALL, id: 'ball-2', name: '2 mm ball nose', diameter: 4, radius: 2 }
const FLAT_2: NormalizedTool = { ...BALL, id: 'flat-2', name: '4 mm flat end mill', type: 'flat_endmill', diameter: 4, radius: 2 }
const VBIT: NormalizedTool = { ...BALL, id: 'v-60', name: '60 degree V-bit', type: 'v_bit', vBitAngle: 60 }
const FINISH_BASE = { sampleSpacing: 2, stockToLeave: 0, alongStart: 10, alongEnd: 30, safeRadius: FINISH_SAFE, requestedCellSize: CELL }
/** Rule 1: `ceil(2 pi R / stepover)` passes, evenly round the bar. */
function finishPasses(stepover: number): number {
  return Math.ceil((2 * Math.PI * FINISH_RADIUS) / stepover)
}

function finishStock(axis: 'x' | 'y'): RoundStock {
  // Across-axis translation catches code that assumes the centre equals R.
  return roundStock(40, 60, axis, axis === 'x' ? { x: 0, y: 7 } : { x: 7, y: 0 })
}

for (const axis of ['x', 'y'] as const) {
  const stock = finishStock(axis)
  const centre = roundStockCentre(stock)
  const cylinder = prism(stock, CIRCLE)
  const along = (p: { x: number; y: number; z: number }): number => axis === 'x' ? p.x : p.y
  const across = (p: { x: number; y: number; z: number }): number => axis === 'x' ? p.y : p.x
  const stepover = 2
  const passes = finishPasses(stepover)
  const result = generateRotaryFinish('op', cylinder, stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover }, {})
  assert.equal(result.operationId, 'op')
  assert.deepEqual(result.warnings, [], `${axis} cylinder has no warning`)
  // The raw sampler's tips at the same sample positions, for the end-tip
  // checks below. One pass's sample count follows rule 2.
  const alongCount = Math.max(1, Math.ceil(Math.abs(FINISH_BASE.alongEnd - FINISH_BASE.alongStart) / FINISH_BASE.sampleSpacing)) + 1
  // The generator's own angle arithmetic: k * (360 / passes), not k * 360 / passes.
  const exactAngles = Array.from({ length: passes }, (_, k) => k * (360 / passes))
  const sampling = sampleRotaryModel(cylinder, stock, FINISH_PASS_MM, {
    anglesDeg: exactAngles,
    along: Array.from({ length: alongCount }, (_, i) => FINISH_BASE.alongStart + (FINISH_BASE.alongEnd - FINISH_BASE.alongStart) * i / (alongCount - 1)),
    requestedCellSize: FINISH_BASE.requestedCellSize,
  }, [])
  assert.equal(sampling.tipRadius.length, passes, `${axis} raw sampling covers every pass`)

  // Entry and exit (rule 7).
  assert.equal(result.moves[0].kind, 'rapid', `${axis} first move is a rapid`)
  approx(result.moves[0].to.z, FINISH_RADIUS + FINISH_SAFE, `${axis} entry rapid reaches safeRadius`)
  assert.equal(result.moves[1].kind, 'plunge', `${axis} entry plunges`)
  approx(result.moves[1].from.z, FINISH_RADIUS + FINISH_SAFE, `${axis} plunge starts at safeRadius`)
  assert.ok(result.moves[1].to.z < result.moves[1].from.z, `${axis} plunge descends`)
  assert.equal(result.moves.at(-1)!.kind, 'rapid', `${axis} last move is a rapid`)
  approx(result.moves.at(-1)!.to.z, FINISH_RADIUS + FINISH_SAFE, `${axis} retract to safeRadius`)
  assert.ok(result.moves.at(-1)!.from.z < FINISH_RADIUS + FINISH_SAFE, `${axis} retract starts at the last tip`)
  // Rule 7: the whole path is connected, and only the entry and the final
  // retract are not cuts.
  for (let i = 1; i < result.moves.length; i++) {
    assert.deepEqual(result.moves[i].from, result.moves[i - 1].to, `${axis} move ${i} is connected`)
  }
  assert.ok(result.moves.slice(2, -1).every((move) => move.kind === 'cut'), `${axis} interior moves are cuts`)

  // Every cutting point is the tool over the centreline at z = R + rc: the
  // cylinder has the same surface at every angle (rule 5).
  for (const move of result.moves) {
    for (const p of [move.from, move.to]) {
      approx(across(p), centre, `${axis} ${move.kind} over the centreline`)
      assert.ok(p.a !== undefined, `${axis} ${move.kind} point carries a`)
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), `${axis} ${move.kind} point is finite`)
      assert.ok(p.z >= FINISH_RADIUS - 1e-9, `${axis} ${move.kind} never below the centreline`)
    }
    if (move.kind === 'cut') {
      approx(move.from.z, FINISH_RADIUS + RC, `${axis} cut from z = R + rc`)
      approx(move.to.z, FINISH_RADIUS + RC, `${axis} cut to z = R + rc`)
    }
  }

  // Rule 1: n evenly spaced passes at k * 360 / n. A link move carries a
  // changing angle, so every cut move's `from` angle names a pass; the distinct
  // set is the whole angle list.
  const passAngles = [...new Set(result.moves.filter((move) => move.kind === 'cut' && move.from.a !== undefined).map((move) => move.from.a as number))]
  assert.equal(passAngles.length, passes, `${axis} pass count ceil(2 pi R / stepover)`)
  const targetAngles = Array.from({ length: passes }, (_, k) => k * 360 / passes)
  for (const target of targetAngles) {
    assert.ok(passAngles.some((angle) => Math.abs(angle - target) < 1e-9), `${axis} pass angle ${target}`)
  }

  // Rule 6: between passes the link turns at the same along position -- never
  // moving along the bar -- one link per pass boundary, always to the next pass
  // angle, and its two ends are the pass end tips. The upstream sampler gives
  // the tip at each pass end, so the link height must equal the higher of the
  // two and each endpoint is the pass's own end tip (the link joins them).
  const linkMoves = result.moves.filter((move) =>
    move.kind === 'cut' && move.from.a !== undefined && move.to.a !== undefined && move.from.a !== move.to.a)
  assert.equal(linkMoves.length, passes - 1, `${axis} one link per pass boundary`)
  for (const move of linkMoves) {
    const endAlong = along(move.from)
    approx(along(move.to), endAlong, `${axis} link never moves along the bar`)
    approx(move.to.z, move.from.z, `${axis} link keeps the height it reached`)
    const pass = Math.round((move.from.a as number) / (360 / passes))
    const next = Math.round((move.to.a as number) / (360 / passes))
    assert.equal(next, pass + 1, `${axis} link only turns to the next pass`)
    const endIndex = alongCount - 1
    const previousTip = sampling.tipRadius[pass][endIndex]
    const nextTip = sampling.tipRadius[next][endIndex]
    approx(move.from.z, FINISH_RADIUS + Math.max(previousTip, nextTip), `${axis} link at the higher end tip`)
    assert.ok(move.from.z >= FINISH_RADIUS + Math.min(previousTip, nextTip) - 1e-9, `${axis} link is not below the lower tip`)
    // Every pass's own end tip survives the merge: a move at that pass angle
    // starts or ends exactly on it.
    const endTip = FINISH_RADIUS + sampling.tipRadius[pass][endIndex]
    assert.ok(
      result.moves.some((other) => other.kind === 'cut' && other.from.a === move.from.a && along(other.from) === endAlong && other.from.z === endTip),
      `${axis} pass ${pass} keeps its end tip as a point`,
    )
  }

  // Rule 6: passes alternate direction -- even ones run from alongStart to
  // alongEnd, odd ones back. Every cut move stays within its own pass's lane,
  // so the direction is judged from the move's own endpoints.
  result.moves.forEach((move, index) => {
    if (move.kind !== 'cut' || move.from.a !== move.to.a || move.from.a === undefined) return
    const delta = along(move.to) - along(move.from)
    if (Math.abs(delta) < 1e-9) return
    const pass = Math.round(move.from.a / (360 / passes))
    assert.ok(pass % 2 === 0 ? delta > 0 : delta < 0, `${axis} move ${index} of pass ${pass} runs ${pass % 2 === 0 ? 'forward' : 'backward'}`)
  })

  // Rule 5: the same path on the sheet, and wrapPoint of it exactly (this is
  // what makes export, the 3D view and the simulation read it unchanged).
  const frame = aroundFrame(stock)
  const sheet = unwrapToolpath(result, frame)
  for (const move of sheet.moves) {
    for (const p of [move.from, move.to]) assert.ok(!('a' in p), `${axis} unwrapped point drops a`)
  }
  result.moves.forEach((move, index) => {
    for (const key of ['from', 'to'] as const) {
      const wrapped = move[key]
      const flat = sheet.moves[index][key]
      assert.ok(wrapped.a !== undefined, `${axis} move ${index} ${key} has a`)
      const acrossSheet = axis === 'x' ? flat.y : flat.x
      approx(acrossSheet, frame.sheetStart + wrapped.a * frame.circumference / 360, `${axis} move ${index} ${key} sheet across`)
      approx(flat.z, wrapped.z - FINISH_RADIUS, `${axis} move ${index} ${key} sheet height is the tip radius`)
      // The wrap of the sheet point is the emitted point. The angle is compared
      // with a tolerance because unwrapping subtracts sheetStart (a stock
      // bound) and re-wrapping adds it back, so float rounding can move the
      // angle by one ulp while every coordinate stays exact.
      const rewrapped = wrapPoint(flat, frame)
      assert.deepEqual({ x: rewrapped.x, y: rewrapped.y, z: rewrapped.z }, { x: wrapped.x, y: wrapped.y, z: wrapped.z },
        `${axis} move ${index} ${key} is wrapPoint of its sheet point`)
      approx(rewrapped.a as number, wrapped.a, `${axis} move ${index} ${key} rewrapped angle`, 1e-9)
    }
  })

  // Rule 4 + 6 + 7: nothing cut or linked outside the requested along range,
  // and every non-boundary move is a cut.
  for (const move of result.moves) {
    for (const p of [move.from, move.to]) {
      assert.ok(along(p) >= FINISH_BASE.alongStart - 1e-9 && along(p) <= FINISH_BASE.alongEnd + 1e-9, `${axis} point inside the along range`)
    }
  }

  // Rule 4: stock to leave, normal to the surface for a ball.
  const s = 0.3
  const stock2 = generateRotaryFinish('op', cylinder, stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover, stockToLeave: s }, {})
  for (const move of stock2.moves) {
    if (move.kind !== 'cut') continue
    approx(move.from.z, FINISH_RADIUS + RC + s, `${axis} cylinder stock to leave tip`, 0.02)
    approx(move.to.z, FINISH_RADIUS + RC + s, `${axis} cylinder stock to leave tip`, 0.02)
  }
  const flatTop = generateRotaryFinish('op', prism(stock, SQUARE), stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover, stockToLeave: s }, {})
  const atZero = flatTop.moves.filter((move) => move.kind === 'cut' && move.from.a === 0 && move.to.a === 0)
  assert.ok(atZero.length >= 1, `${axis} square prism has a 0 degree pass`)
  for (const move of atZero) {
    approx(move.from.z, FINISH_RADIUS + W + s, `${axis} flat top stock to leave tip`)
    approx(move.to.z, FINISH_RADIUS + W + s, `${axis} flat top stock to leave tip`)
  }
  // Zero stock leaves the sampler's own value: the straight pass is z = R + w.
  const noStock = generateRotaryFinish('op', prism(stock, SQUARE), stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover }, {})
  for (const move of noStock.moves) {
    if (move.kind !== 'cut' || move.from.a !== 0 || move.to.a !== 0) continue
    approx(move.from.z, FINISH_RADIUS + W, `${axis} flat top zero stock tip`)
    approx(move.to.z, FINISH_RADIUS + W, `${axis} flat top zero stock tip`)
  }

  // Rule 8: a V-bit is refused outright.
  const refused = generateRotaryFinish('op', cylinder, stock, VBIT, { ...FINISH_BASE, stepover }, {})
  assert.deepEqual(refused.moves, [], `${axis} V-bit has no moves`)
  assert.deepEqual(refused.warnings.map((warning) => warning.code), ['rotaryToolUnsupported'], `${axis} V-bit warning`)
  assert.equal(refused.bounds, null, `${axis} V-bit has no bounds`)

  // A flat end mill on the coaxial cylinder: z = R + rc, no stock.
  const flat = generateRotaryFinish('op', cylinder, stock, FLAT_2, { ...FINISH_BASE, stepover }, {})
  for (const move of flat.moves) {
    if (move.kind !== 'cut') continue
    for (const p of [move.from, move.to]) approx(p.z, FINISH_RADIUS + RC, `${axis} flat end mill z = R + rc`)
  }
}

{
  // Rule 4: a model that dips below the axis is clamped to the floor and named
  // once, at the first place it happens. The plate sits wholly below the
  // centreline at 0 degrees: its own top face is at radius -3, well under the
  // tool's, so the tool would have to reach below zero there.
  const stock = finishStock('x')
  const plate = prism(stock, [[-2, -9], [2, -9], [2, -3], [-2, -3]])
  const stepover = 20
  const result = generateRotaryFinish('op-7', plate, stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover }, {})
  assert.ok(result.moves.length > 0, 'below centreline still generates moves')
  for (const move of result.moves) {
    for (const p of [move.from, move.to]) assert.ok(p.z >= FINISH_RADIUS - 1e-9, 'no point below the centreline')
  }
  const below = result.warnings.filter((warning) => warning.code === 'rotaryBelowCentreline')
  assert.equal(below.length, 1, 'exactly one below-centreline warning')
  assert.equal(below[0].params?.operation, 'op-7')
  const along = below[0].params?.along as number
  const angle = below[0].params?.angle as number
  assert.equal(along, FINISH_BASE.alongStart, 'the first below-centreline place is at alongStart')
  assert.equal(angle, 0, 'the first below-centreline place is at 0 degrees')
  // The 0 degree pass clamps to the centreline floor.
  assert.ok(result.moves.some((move) => move.kind === 'cut' && move.from.a === 0 && move.from.z === FINISH_RADIUS), 'the 0 degree pass is on the centreline')
}

{
  // Rule 4: a model poking above the bar's surface is air, so the tip is
  // clamped at R rather than followed into the air. A tall narrow spike makes
  // the clamp the only thing keeping every point at or below the bar's top.
  const stock = finishStock('x')
  const spike = prism(stock, [[-2, -2], [2, -2], [0, 26]])
  const stepover = 20
  const result = generateRotaryFinish('op-8', spike, stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover }, {})
  const cutPoints = result.moves.filter((move) => move.kind === 'cut').flatMap((move) => [move.from, move.to])
  assert.ok(cutPoints.length > 0, 'the spike generates cuts')
  assert.ok(cutPoints.some((p) => p.z === FINISH_RADIUS + FINISH_RADIUS), 'a tip over the spike is clamped to the bar surface')
  for (const p of cutPoints) assert.ok(p.z <= FINISH_RADIUS + FINISH_RADIUS + 1e-9, 'no tip above the bar surface')
}

{
  // Rule 10: progress and stopping pass straight through to the sampler.
  const stock = finishStock('x')
  const mesh = prism(stock, CIRCLE)
  const progress: number[][] = []
  const complete = generateRotaryFinish('op', mesh, stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover: 10 }, {
    onAngle: (done, total) => { progress.push([done, total]) },
  })
  const passes = finishPasses(10)
  assert.deepEqual(progress, Array.from({ length: passes }, (_, i) => [i + 1, passes]), 'progress once per angle')
  const stopped = generateRotaryFinish('op', mesh, stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover: 10 }, { shouldStop: () => true })
  assert.deepEqual(stopped.moves, [], 'stopped returns no moves')
  assert.deepEqual(stopped.warnings, [], 'stopped returns no warning')
  assert.equal(stopped.bounds, null, 'stopped has no bounds')
  assert.ok(complete.moves.length > 0, 'the complete run is not vacuous')
}

{
  // Rule 9: a pass over a flat stretch keeps its first and last point and drops
  // the middle; a curved stretch keeps its points. The bar is sampled every
  // 1 mm so the count of moves on one pass says exactly how many points lived.
  const stock = finishStock('x')
  const stepover = 20
  const spacing = 1
  // A pass's moves are the cut moves whose two ends carry the same angle; the
  // link's turn is the one that changes angle, so it never lands in this list.
  const passMoves = (moves: typeof flat.moves, pass: number): typeof flat.moves =>
    moves.filter((move) => move.kind === 'cut' && move.from.a === move.to.a && move.from.a === pass * (360 / finishPasses(stepover)))
  const alongStart = FINISH_BASE.alongStart
  const alongEnd = FINISH_BASE.alongEnd
  // 21 samples 1 mm apart. A move endpoint strictly inside (alongStart,
  // alongEnd) can only be a sample the merge chose to keep.
  const interiorKept = (moves: typeof flat.moves): number[] => {
    const points: number[] = []
    for (const move of moves) for (const p of [move.from, move.to]) {
      if (p.x > alongStart + 1e-9 && p.x < alongEnd - 1e-9) points.push(p.x)
    }
    return [...new Set(points)].sort((a, b) => a - b)
  }
  const flat = generateRotaryFinish('op', prism(stock, SQUARE), stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover, sampleSpacing: spacing }, {})
  const zero = passMoves(flat.moves, 0)
  assert.ok(zero.length >= 1, 'the flat 0 degree pass is present')
  assert.deepEqual(interiorKept(zero), [], 'a flat pass drops every interior sample, keeping both ends')
  // The pass still spans the whole range, so nothing was trimmed with the
  // dropped points.
  const zeroEnds = zero.flatMap((move) => [move.from.x, move.to.x])
  assert.equal(Math.min(...zeroEnds), alongStart, 'merged flat pass keeps its first point')
  assert.equal(Math.max(...zeroEnds), alongEnd, 'merged flat pass keeps its last point')
  // A ball sits on the bar's centreline at x = 20 and sticks 8 mm over it, so a
  // pass runs up and back down: the tip is not collinear, and its points
  // survive the merge. A closed fan-and-cap mesh is enough for the height map.
  const ball = (() => {
    const centre = roundStockCentre(stock)
    const radius = stock.thickness / 2
    const cx = 20, cy = centre, cz = radius + 8, r = 6
    const rings = 16, slices = 32
    const positions: number[] = []
    const index: number[] = []
    const vertex = (ri: number, si: number): number => {
      const phi = Math.PI * ri / rings
      const theta = 2 * Math.PI * si / slices
      positions.push(cx + r * Math.sin(phi) * Math.cos(theta), cy + r * Math.sin(phi) * Math.sin(theta), cz + r * Math.cos(phi))
      return positions.length / 3 - 1
    }
    const first: number[][] = []
    for (let ri = 0; ri <= rings; ri++) first.push(Array.from({ length: slices }, (_, si) => vertex(ri, si)))
    for (let ri = 0; ri < rings; ri++) for (let si = 0; si < slices; si++) {
      const sj = (si + 1) % slices
      index.push(first[ri][si], first[ri + 1][si], first[ri + 1][sj], first[ri][si], first[ri + 1][sj], first[ri][sj])
    }
    return { positions: new Float32Array(positions), index: new Uint32Array(index) }
  })()
  const curved = generateRotaryFinish('op', ball, stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover, sampleSpacing: spacing }, {})
  const curvedZero = passMoves(curved.moves, 0)
  const curvedKept = interiorKept(curvedZero)
  assert.ok(curvedKept.length >= 3, `a curved 0 degree pass keeps its points (${curvedKept.length} interior)`)
  assert.ok(curvedKept.length < 19, `the curved pass still merged some points (${curvedKept.length} interior)`)
  const peak = curvedZero.reduce((best, move) => Math.max(best, move.from.z, move.to.z), 0)
  const ends = Math.max(curvedZero[0].from.z, curvedZero.at(-1)!.to.z)
  assert.ok(peak > ends + 0.1, `the curved pass really rises: peak ${peak.toFixed(3)} over ends ${ends.toFixed(3)}`)
}

{
  // Fixture (report): slice A's real mesh in a 40 mm bar, 3 mm ball, stepover
  // 0.5 mm, sample spacing 0.2 mm. Only "it runs and produces moves" is asserted.
  const start = performance.now()
  const result = generateRotaryFinish('op-fixture', fixture, STOCK, BALL, {
    stepover: 0.5, sampleSpacing: 0.2, stockToLeave: 0, alongStart: 0, alongEnd: 150,
    safeRadius: 20 + 1.6, requestedCellSize: fixtureCell,
  }, {})
  const elapsed = performance.now() - start
  const passes = finishPasses(0.5)
  const angles = new Set<number>()
  for (const move of result.moves) {
    if (move.kind !== 'cut' || move.from.a === undefined) continue
    angles.add(move.from.a)
  }
  const cuts = result.moves.filter((move) => move.kind === 'cut')
  const tip = Math.max(...cuts.flatMap((move) => [move.from.z, move.to.z])) - 20
  assert.ok(result.moves.length > 0, 'fixture produces moves')
  assert.ok(angles.size === passes, `fixture covers every pass angle (${angles.size} of ${passes})`)
  assert.ok(tip <= 20 + 1e-6, `fixture stays within the bar (${tip.toFixed(3)})`)
  // Rule 9's before/after counts. Before the merge the path is one move per
  // sample interval on each pass, three moves per link (rise/turn/drop), and
  // the entry rapid plus plunge and the final retract. Reported, not asserted.
  const samplesPerPass = Math.max(1, Math.ceil(Math.abs(150 - 0) / 0.2)) + 1
  const before = passes * (samplesPerPass - 1) + 3 * (passes - 1) + 3
  console.log(`rotaryFinish fixture: ${elapsed.toFixed(1)} ms, ${angles.size} angles, `
    + `${before} moves before merging -> ${result.moves.length} after (${cuts.length} cut), `
    + `tip max ${tip.toFixed(3)} mm, warnings ${result.warnings.map((warning) => warning.code).join(',') || 'none'}`)
}

console.log('engine/toolpaths/rotaryModel.test.ts: all assertions passed')
