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
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { roundStock, roundStockCentre, roundStockLength } from '../../types/project'
import type { Clamp, RoundStock } from '../../types/project'
import { aroundFrame, unwrapToolpath, wrapPoint } from '../aroundFrame'
import { deserializeImportedMesh } from '../importedMesh'
import { toolSpacePoint } from '../rotaryFrame'
import { buildHeightMap, chooseHeightMapCellSize, computeXYBounds, safeToolTipZAt } from './finishSurfaceParallel'
import { generateRotaryFinish, generateRotaryRough, rotaryAlongRange, sampleRotaryModel, turnedModelPositions } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import type { NormalizedTool, RotaryRoughLeft, ToolpathMove, ToolpathPoint } from './types'
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

/**
 * A coaxial surface of revolution around the bar's axis: one closed ring of
 * `segments` points at each of `steps` positions along the bar, with the ring's
 * radius given by `radiusAt(along)`. Unlike `prism`'s constant cross-section,
 * the radius varies along the bar, so the sampled height at an along position
 * changes when a pass reads the wrong (mirrored) row.
 */
function lathe(
  stock: RoundStock,
  radiusAt: (along: number) => number,
  alongStart: number,
  alongEnd: number,
  steps: number,
  segments: number,
): RotaryModelMesh {
  const centre = roundStockCentre(stock)
  const radius = stock.thickness / 2
  const positions: number[] = []
  const index: number[] = []
  for (let s = 0; s <= steps; s++) {
    const along = alongStart + (alongEnd - alongStart) * s / steps
    const r = radiusAt(along)
    for (let j = 0; j < segments; j++) {
      const t = 2 * Math.PI * j / segments
      const across = centre + r * Math.cos(t)
      const up = radius + r * Math.sin(t)
      if (stock.axis === 'x') positions.push(along, across, up)
      else positions.push(across, along, up)
    }
  }
  for (let s = 0; s < steps; s++) {
    for (let j = 0; j < segments; j++) {
      const j2 = (j + 1) % segments
      const a = s * segments + j
      const b = s * segments + j2
      const c = (s + 1) * segments + j2
      const d = (s + 1) * segments + j
      index.push(a, b, c, a, c, d)
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

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

{
  // Issue #1015 slice J: turning is toolSpacePoint inlined (the rotation is
  // computed once per angle, straight into the output Float32Array), so it must
  // still agree with the frozen frame function vertex for vertex on arbitrary
  // geometry, not only on the prisms above. A few thousand random vertices at
  // random angles on both bar axes; the generator is seeded so a failure is
  // reproducible. Both sides are compared as the Float32 the output stores, and
  // the relative tolerance is 1e-9.
  let state = 0x9e3779b9
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const RANDOM_VERTICES = 4096
  const RANDOM_ANGLES = 8
  for (const axis of ['x', 'y'] as const) {
    const stock = roundStock(40, 80, axis, axis === 'x' ? { x: -3, y: 7 } : { x: 7, y: -3 })
    const positions = new Float32Array(RANDOM_VERTICES * 3)
    for (let i = 0; i < positions.length; i++) positions[i] = (random() - 0.5) * 60
    for (let a = 0; a < RANDOM_ANGLES; a++) {
      const angle = (random() - 0.5) * 1440
      const turned = turnedModelPositions(positions, stock, angle)
      const expected = new Float32Array(positions.length)
      for (let i = 0; i < positions.length; i += 3) {
        const point = toolSpacePoint({ x: positions[i], y: positions[i + 1], z: positions[i + 2] }, angle, stock)
        expected[i] = point.x
        expected[i + 1] = point.y
        expected[i + 2] = point.z
      }
      for (let i = 0; i < turned.length; i++) {
        const relative = Math.abs(turned[i] - expected[i]) / Math.max(1, Math.abs(expected[i]))
        assert.ok(relative <= 1e-9,
          `random turning ${axis} angle ${angle} vertex ${i / 3} component ${i % 3}: got ${turned[i]}, toolSpacePoint ${expected[i]}`)
      }
    }
  }
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
/**
 * Review fix 1: a turning link rises to the bar's surface plus a 1 mm
 * clearance (`min(safeRadius, R + 1)`), never above the retract height. These
 * tests use millimetre tools, so the clearance is 1 mm.
 */
const LINK_CLEARANCE = 1
const FINISH_LINK_TIP = Math.min(FINISH_SAFE, FINISH_RADIUS + LINK_CLEARANCE)
const FINISH_LINK_Z = FINISH_RADIUS + FINISH_LINK_TIP
/** Rule 1: `ceil(2 pi R / stepover)` passes, evenly round the bar. */
function finishPasses(stepover: number): number {
  return Math.ceil((2 * Math.PI * FINISH_RADIUS) / stepover)
}

function finishStock(axis: 'x' | 'y'): RoundStock {
  // Across-axis translation catches code that assumes the centre equals R.
  return roundStock(40, 60, axis, axis === 'x' ? { x: 0, y: 7 } : { x: 7, y: 0 })
}

/**
 * The same D40 bar, only as long as the [10, 30] the finish tests cut. A bar
 * longer than the model builds retained-bar stubs (the generator samples the
 * bar beyond the cut range so the cutter's side cannot enter it); a bar that is
 * exactly the cut range has none, which keeps these geometry tests about the
 * model. The retained bar has its own tests below.
 */
function insetStock(axis: 'x' | 'y'): RoundStock {
  return axis === 'x'
    ? roundStock(40, 20, 'x', { x: 10, y: 7 })
    : roundStock(40, 20, 'y', { x: 7, y: 10 })
}

for (const axis of ['x', 'y'] as const) {
  const stock = insetStock(axis)
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
  // The opening move only positions the tool at safeRadius over the first
  // sample: from and to are the same point, the way `pushRapidAndPlunge` opens
  // when no previous position exists. It used to start at the cutting tip, which
  // read as if the tool began buried, then rapid up to safe height.
  assert.deepEqual(result.moves[0].from, result.moves[0].to, `${axis} entry rapid only positions the tool`)
  approx(result.moves[0].from.z, FINISH_RADIUS + FINISH_SAFE, `${axis} entry rapid is at safeRadius`)
  approx(along(result.moves[0].from), FINISH_BASE.alongStart, `${axis} entry rapid is over the first sample`)
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
  // cylinder has the same surface at every angle (rule 5). The link's rise,
  // turn and drop moves sit at the bar's surface instead (fix 1) and never
  // move along the bar, so they are excluded here.
  for (const move of result.moves) {
    for (const p of [move.from, move.to]) {
      approx(across(p), centre, `${axis} ${move.kind} over the centreline`)
      assert.ok(p.a !== undefined, `${axis} ${move.kind} point carries a`)
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), `${axis} ${move.kind} point is finite`)
      assert.ok(p.z >= FINISH_RADIUS - 1e-9, `${axis} ${move.kind} never below the centreline`)
    }
    if (move.kind === 'cut' && along(move.from) !== along(move.to)) {
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

  // Rule 6 + review fix 1: between passes the link turns at the same along
  // position -- never moving along the bar -- one link per pass boundary,
  // always to the next pass angle. It rises to the bar's surface plus a
  // clearance and comes back down, so the turn is in air whatever the model
  // does between the two pass angles. The old rule turned at the higher of the
  // two end tips, which is *inside* the model between them: on a square prism
  // of half-width 10 in this bar the 34.29 -> 51.43 degree link ran at tip
  // radius 13.598 while the 45 degree corner needed 14.141. The prism block
  // below measures the clearance against the sampler directly.
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
    approx(move.from.z, FINISH_LINK_Z, `${axis} link turns at the bar surface plus clearance`, 1e-9)
    assert.ok(move.from.z < FINISH_RADIUS + FINISH_SAFE, `${axis} link stays below the retract height`)
    // Every pass's own end tip survives the merge: a move at that pass angle
    // starts or ends exactly on it.
    const endTip = FINISH_RADIUS + sampling.tipRadius[pass][alongCount - 1]
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

  // Rule 5 + 6 (review): a coaxial model whose radius varies along the bar, and
  // varies asymmetrically about the middle, so a return pass that read
  // `tipRadius[k][i]` at position `along[n-1-i]` would put every point at its
  // mirror's height. The profile is axisymmetric, so the right height at an
  // along position is the forward pass's own sample there; the wrong one is the
  // same row read at the mirrored index. This is the case every symmetric test
  // model could not see.
  {
    const waveStepover = 6
    const wavePasses = finishPasses(waveStepover)
    const waveAlong = Array.from({ length: 21 }, (_, i) => FINISH_BASE.alongStart + i)
    const wave = lathe(stock, (x) => 4 + 3 * Math.sin(2 * Math.PI * (x - 10) / 13), FINISH_BASE.alongStart, FINISH_BASE.alongEnd, 200, 64)
    const waveResult = generateRotaryFinish('op-wave', wave, stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover: waveStepover, sampleSpacing: 1 }, {})
    const waveSampling = sampleRotaryModel(wave, stock, FINISH_PASS_MM, {
      anglesDeg: Array.from({ length: wavePasses }, (_, k) => k * (360 / wavePasses)),
      along: waveAlong,
      requestedCellSize: FINISH_BASE.requestedCellSize,
    }, [])
    const waveIndexAt = (p: number): number => {
      let best = -1
      let bestDistance = Infinity
      waveAlong.forEach((value, j) => {
        const distance = Math.abs(value - p)
        if (distance < bestDistance) { bestDistance = distance; best = j }
      })
      assert.ok(bestDistance < 1e-9, `${axis} emitted along ${p} is a sample position`)
      return best
    }
    // A steep step (slice I) emits a vertical leg plus a horizontal one instead
    // of a single diagonal, so an emitted endpoint at a sample can sit at that
    // sample's own tip or at a neighbour's -- the higher one on a rise, the
    // first one's on a fall. Either way it must be the *pass's own* row: the
    // mirrored row a return-pass bug would read is far away on this wave and
    // matches neither.
    const nearOwnSample = (pass: number, j: number, z: number): boolean =>
      [j - 1, j, j + 1].some((n) => n >= 0 && n < waveAlong.length
        && Math.abs(z - (FINISH_RADIUS + waveSampling.tipRadius[pass][n])) <= TOLERANCE)
    let waveChecks = 0
    for (const move of waveResult.moves) {
      if (move.kind !== 'cut') continue
      const fromAngle = move.from.a as number
      const toAngle = move.to.a as number
      if (fromAngle !== toAngle) {
        // The turn between two passes, at the shared end position, at the bar's
        // surface plus the clearance (review fix 1). Its height no longer comes
        // from the tips, so the mirrored return-pass read now shows in the cut
        // points below rather than here.
        const next = Math.round(toAngle / (360 / wavePasses))
        assert.equal(next, Math.round(fromAngle / (360 / wavePasses)) + 1, `${axis} wave link turns to the next pass`)
        approx(along(move.to), along(move.from), `${axis} wave link stays at its along position`)
        approx(move.to.z, move.from.z, `${axis} wave link keeps the height it reached`)
        approx(move.to.z, FINISH_LINK_Z, `${axis} wave link turns at the bar surface plus clearance`, 1e-9)
        waveChecks++
        continue
      }
      if (along(move.from) === along(move.to)) {
        // A vertical move is either the link's own rise or drop at the shared
        // end (one end at the turn height, the other the pass's end tip) or a
        // steep step's leg between two neighbouring samples (both ends at tips).
        const j = waveIndexAt(along(move.from))
        const heights = [move.from.z, move.to.z]
        if (heights.some((height) => Math.abs(height - FINISH_LINK_Z) <= 1e-9)) {
          // The link's rise (or drop) can merge with the steep step's vertical
          // leg at the same along position, so its lower end is this sample's
          // tip or a neighbour's.
          const pass = Math.round(fromAngle / (360 / wavePasses))
          const lower = heights.find((height) => Math.abs(height - FINISH_LINK_Z) > 1e-9) ?? heights[0]
          assert.ok(nearOwnSample(pass, j, lower), `${axis} wave link rise/drop starts at a pass tip`)
        } else {
          const pass = Math.round(fromAngle / (360 / wavePasses))
          for (const height of heights) {
            assert.ok(nearOwnSample(pass, j, height),
              `${axis} wave split leg at along ${waveAlong[j]} sits at a neighbouring sample of its own pass`)
          }
        }
        waveChecks++
        continue
      }
      const pass = Math.round(fromAngle / (360 / wavePasses))
      for (const end of ['from', 'to'] as const) {
        const j = waveIndexAt(along(move[end]))
        // The pass's own sample at this along position (or a neighbour's on a
        // steep step); the axisymmetric model makes it the right height on
        // every pass.
        assert.ok(nearOwnSample(pass, j, move[end].z),
          `${axis} wave pass ${pass} height at along ${waveAlong[j]} is its own row's`)
        approx(waveSampling.tipRadius[pass][j], waveSampling.tipRadius[0][j],
          `${axis} wave pass ${pass} samples along ${waveAlong[j]} like the forward pass`)
        waveChecks++
      }
    }
    assert.ok(waveChecks > 20, `${axis} the asymmetric wave checked real points (${waveChecks})`)
  }

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
      approx(acrossSheet, frame.zero + wrapped.a * frame.circumference / 360, `${axis} move ${index} ${key} sheet across`)
      approx(flat.z, wrapped.z - FINISH_RADIUS, `${axis} move ${index} ${key} sheet height is the tip radius`)
      // The wrap of the sheet point is the emitted point. The angle is compared
      // with a tolerance because unwrapping subtracts the zero line (the bar's
      // centreline) and re-wrapping adds it back, so float rounding can move the
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

  // Rule 4: stock to leave, normal to the surface for a ball. Only the moves
  // that run along the bar carry the tip: the link's rise, turn and drop sit at
  // the bar's surface (fix 1).
  const s = 0.3
  const stock2 = generateRotaryFinish('op', cylinder, stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover, stockToLeave: s }, {})
  for (const move of stock2.moves) {
    if (move.kind !== 'cut' || along(move.from) === along(move.to)) continue
    approx(move.from.z, FINISH_RADIUS + RC + s, `${axis} cylinder stock to leave tip`, 0.02)
    approx(move.to.z, FINISH_RADIUS + RC + s, `${axis} cylinder stock to leave tip`, 0.02)
  }
  const flatTop = generateRotaryFinish('op', prism(stock, SQUARE), stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover, stockToLeave: s }, {})
  const atZero = flatTop.moves.filter((move) => move.kind === 'cut' && move.from.a === 0 && move.to.a === 0 && along(move.from) !== along(move.to))
  assert.ok(atZero.length >= 1, `${axis} square prism has a 0 degree pass`)
  for (const move of atZero) {
    approx(move.from.z, FINISH_RADIUS + W + s, `${axis} flat top stock to leave tip`)
    approx(move.to.z, FINISH_RADIUS + W + s, `${axis} flat top stock to leave tip`)
  }
  // Zero stock leaves the sampler's own value: the straight pass is z = R + w.
  const noStock = generateRotaryFinish('op', prism(stock, SQUARE), stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover }, {})
  for (const move of noStock.moves) {
    if (move.kind !== 'cut' || move.from.a !== 0 || move.to.a !== 0 || along(move.from) === along(move.to)) continue
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
    if (move.kind !== 'cut' || along(move.from) === along(move.to)) continue
    for (const p of [move.from, move.to]) approx(p.z, FINISH_RADIUS + RC, `${axis} flat end mill z = R + rc`)
  }
}

{
  // Rule 4: a model that dips below the axis is clamped to the floor and named
  // once, at the first place it happens. The plate sits wholly below the
  // centreline at 0 degrees: its own top face is at radius -3, well under the
  // tool's, so the tool would have to reach below zero there.
  const stock = insetStock('x')
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
  // Rule 4 (review): the warning is about the value *before* clamping, so the
  // stock offset is in the value that decides it -- `raw + stockToLeave < 0`.
  // Leaving stock must not hide a model that still needs a cut below the
  // centreline, which is exactly what gating on `stockToLeave === 0` did.
  const stock = insetStock('x')
  const plate = prism(stock, [[-2, -9], [2, -9], [2, -3], [-2, -3]])
  const result = generateRotaryFinish('op-7s', plate, stock, FINISH_PASS_MM,
    { ...FINISH_BASE, stepover: 20, stockToLeave: 0.5 }, {})
  assert.ok(result.moves.length > 0, 'below centreline with stock still generates moves')
  for (const move of result.moves) {
    for (const p of [move.from, move.to]) assert.ok(p.z >= FINISH_RADIUS - 1e-9, 'no point below the centreline with stock')
  }
  const below = result.warnings.filter((warning) => warning.code === 'rotaryBelowCentreline')
  assert.equal(below.length, 1, 'exactly one below-centreline warning with stock to leave')
  assert.equal(below[0].params?.operation, 'op-7s')
  assert.equal(below[0].params?.along, FINISH_BASE.alongStart, 'the place with stock is at alongStart')
  assert.equal(below[0].params?.angle, 0, 'the place with stock is at 0 degrees')
}

{
  // Rule 4 (review): the warning names the along position of the offending
  // *sample*, so it must not be mirrored with the pass either. Two passes put
  // the first offense on the odd (180 degree) pass, where the old code reported
  // `alongAt(1, i)` -- the mirror position -- rather than along[i]. The block
  // sits above the axis at 0 degrees (nothing below zero, so pass 0 is clean)
  // and only near alongStart; at 180 degrees it turns below the axis, and the
  // warning must name along = 10, not the mirrored 30.
  const stock = insetStock('x')
  const block = prism(stock, [[-2, 4], [2, 4], [2, 6], [-2, 6]], [10, 14])
  const result = generateRotaryFinish('op-7o', block, stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover: 100 }, {})
  const below = result.warnings.filter((warning) => warning.code === 'rotaryBelowCentreline')
  assert.equal(below.length, 1, 'exactly one below-centreline warning on the odd pass')
  assert.equal(below[0].params?.angle, 180, 'the offending pass is the 180 degree one')
  assert.equal(below[0].params?.along, FINISH_BASE.alongStart, 'the warning names the sample position, not its mirror')
  for (const move of result.moves) {
    for (const p of [move.from, move.to]) assert.ok(p.z >= FINISH_RADIUS - 1e-9, 'no point below the centreline on the odd pass')
  }
}

{
  // Rule 3 (review): in a valley the stock offset is normal to the surface, not
  // vertical, and that is where enlarging the tool changes the answer. The
  // model is a coaxial block whose top face carries a V-valley, walls at 45
  // degrees, apex 3 mm above the axis. A ball in a 45-degree V rests with its
  // centre r*sqrt(2) above the apex, so its tip is `apex + r*(sqrt(2) - 1)`.
  // Plain r = 2 gives 3 + 0.828 = 3.828 mm; enlarged r = 2.5 gives
  // 3 + 1.036 = 4.036 mm. The generator must sample with the enlarged ball and
  // add s, giving 4.536 mm -- while "add s to the plain tip" would give
  // 4.328 mm. The hand-computed difference is s*(sqrt(2) - 1) = 0.2071 mm.
  const stock = insetStock('x')
  const apexAlong = 20
  const halfWidth = 3
  const topUp = 6
  const apexUp = topUp - halfWidth
  const acrossHalf = 8
  const sheet = (() => {
    const centre = roundStockCentre(stock)
    const radius = stock.thickness / 2
    const up = (along: number): number => {
      const d = Math.abs(along - apexAlong)
      return d >= halfWidth ? topUp : apexUp + d
    }
    const xs: number[] = []
    for (let x = 10; x <= 30 + 1e-9; x += CELL) xs.push(x)
    const ys: number[] = []
    for (let y = -acrossHalf; y <= acrossHalf + 1e-9; y += 1) ys.push(y)
    const positions: number[] = []
    const index: number[] = []
    for (const x of xs) for (const y of ys) {
      const z = radius + up(x)
      if (stock.axis === 'x') positions.push(x, centre + y, z)
      else positions.push(centre + y, x, z)
    }
    const cols = ys.length
    for (let i = 0; i < xs.length - 1; i++) {
      for (let j = 0; j < ys.length - 1; j++) {
        const a = i * cols + j
        const b = (i + 1) * cols + j
        const c = (i + 1) * cols + j + 1
        const d = i * cols + j + 1
        index.push(a, b, c, a, c, d)
      }
    }
    return { positions: new Float32Array(positions), index: new Uint32Array(index) }
  })()
  const s = 0.5
  const enlarged: NormalizedTool = { ...FINISH_PASS_MM, radius: FINISH_PASS_MM.radius + s, diameter: FINISH_PASS_MM.diameter + 2 * s }
  const plainTip = sampleRotaryModel(sheet, stock, FINISH_PASS_MM, { anglesDeg: [0], along: [apexAlong], requestedCellSize: CELL }, []).tipRadius[0][0]
  const enlargedTip = sampleRotaryModel(sheet, stock, enlarged, { anglesDeg: [0], along: [apexAlong], requestedCellSize: CELL }, []).tipRadius[0][0]
  assert.ok(plainTip < enlargedTip, `the enlarged ball rests higher in the valley (${plainTip.toFixed(4)} < ${enlargedTip.toFixed(4)})`)
  const result = generateRotaryFinish('op-valley', sheet, stock, FINISH_PASS_MM,
    { ...FINISH_BASE, stepover: 20, sampleSpacing: 1, stockToLeave: s }, {})
  const apexAlongAxis = (p: { x: number; y: number; z: number }): number => stock.axis === 'x' ? p.x : p.y
  const atApex = result.moves
    .filter((move) => move.kind === 'cut' && move.from.a === 0 && move.to.a === 0)
    .flatMap((move) => [move.from, move.to])
    .filter((p) => Math.abs(apexAlongAxis(p) - apexAlong) < 1e-9)
  assert.ok(atApex.length > 0, 'the 0 degree pass reaches the valley apex')
  const generatedTip = atApex[0].z - FINISH_RADIUS
  // What the code says it does: the enlarged ball's tip plus s.
  approx(generatedTip, enlargedTip + s, 'valley result equals the enlarged tool plus s', 1e-6)
  // What "stock without enlarging the tool" would give, and the hand-computed gap.
  const handDifference = s * (Math.SQRT2 - 1)
  assert.ok(generatedTip > plainTip + s, `valley result is above plain + s (${generatedTip.toFixed(4)} > ${(plainTip + s).toFixed(4)})`)
  approx(generatedTip - (plainTip + s), handDifference, 'valley gap from plain + s is s*(sqrt(2)-1)', 0.005)
}

{
  // Rule 4: a model poking above the bar's surface is air, so the tip is
  // clamped at R rather than followed into the air. A tall narrow spike makes
  // the clamp the only thing keeping every point at or below the bar's top. The
  // link's rise/turn/drop moves are at the bar's surface plus the clearance
  // (fix 1) and do not run along the bar, so the tip checks skip them.
  const stock = insetStock('x')
  const spike = prism(stock, [[-2, -2], [2, -2], [0, 26]])
  const stepover = 20
  const result = generateRotaryFinish('op-8', spike, stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover }, {})
  const cutPoints = result.moves
    .filter((move) => move.kind === 'cut' && move.from.x !== move.to.x)
    .flatMap((move) => [move.from, move.to])
  assert.ok(cutPoints.length > 0, 'the spike generates cuts')
  assert.ok(cutPoints.some((p) => p.z === FINISH_RADIUS + FINISH_RADIUS), 'a tip over the spike is clamped to the bar surface')
  for (const p of cutPoints) assert.ok(p.z <= FINISH_RADIUS + FINISH_RADIUS + 1e-9, 'no tip above the bar surface')
}

{
  // Review item 2: a NaN sample is "no model under the tool", and the finish
  // must not cut the centreline there -- that was full-width, full-depth
  // slotting with a finishing tool, silently. Two off-axis prisms (across
  // 8..12, up 8..12 in a 40 mm bar, so only one pass angle meets them) with a
  // 5 mm gap split a pass into two runs. The finish cuts where the model is,
  // retracts to safeRadius across the gap, and emits nothing on a pass the
  // model never reaches.
  const stock = insetStock('x')
  const cross: readonly (readonly [number, number])[] = [[8, 8], [12, 8], [12, 12], [8, 12]]
  const pieceA = prism(stock, cross, [10, 14])
  const pieceB = prism(stock, cross, [19, 23])
  const positions = new Float32Array(pieceA.positions.length + pieceB.positions.length)
  positions.set(pieceA.positions)
  positions.set(pieceB.positions, pieceA.positions.length)
  const index = new Uint32Array(pieceA.index.length + pieceB.index.length)
  index.set(pieceA.index)
  index.set(Array.from(pieceB.index, (i) => i + pieceA.positions.length / 3), pieceA.index.length)
  const offAxis = { positions, index }
  const stepover = 20
  const passes = finishPasses(stepover)
  const angles = Array.from({ length: passes }, (_, k) => k * (360 / passes))
  const intervals = Math.max(1, Math.ceil(Math.abs(FINISH_BASE.alongEnd - FINISH_BASE.alongStart) / FINISH_BASE.sampleSpacing))
  const along = Array.from({ length: intervals + 1 }, (_, i) => FINISH_BASE.alongStart + (FINISH_BASE.alongEnd - FINISH_BASE.alongStart) * i / intervals)
  const sampling = sampleRotaryModel(offAxis, stock, FINISH_PASS_MM, {
    anglesDeg: angles, along, requestedCellSize: FINISH_BASE.requestedCellSize,
  }, [])
  const result = generateRotaryFinish('op-offaxis', offAxis, stock, FINISH_PASS_MM, { ...FINISH_BASE, stepover }, {})
  const safeZ = FINISH_RADIUS + FINISH_SAFE
  assert.ok(result.moves.length > 0, 'off-axis prisms still cut where the model is')
  // The pass that meets the model cuts; the ones that do not emit nothing.
  const cutAngles = new Set(result.moves
    .filter((move) => move.kind === 'cut' && move.from.a === move.to.a)
    .map((move) => move.from.a as number))
  assert.ok(!cutAngles.has(0), 'the 0 degree pass has no model under the tool and emits nothing')
  assert.ok(cutAngles.size > 0 && cutAngles.size < passes, `only the passes over the model cut (${cutAngles.size} of ${passes})`)
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    for (const p of [move.from, move.to]) {
      const k = angles.indexOf(p.a as number)
      assert.ok(k >= 0, `off-axis cut point angle ${p.a} is a pass angle`)
      const j = along.findIndex((value) => Math.abs(value - p.x) < 1e-9)
      assert.ok(j >= 0, `off-axis cut point along ${p.x} is a sample position`)
      assert.ok(Number.isFinite(sampling.tipRadius[k][j]),
        `off-axis pass ${k} along ${along[j]} really has the model under the tool`)
      // No NaN sample became a centreline cut: the model never dips below R.
      assert.ok(p.z > FINISH_RADIUS + 1e-9, 'no off-axis cut at the centreline')
    }
  }
  // Between runs the tool travels at the bar's surface plus a clearance, the
  // same height as a turning link (slice H); `safeRadius` is only the entry and
  // the final retract. The strict rule has its own block below.
  const travelZ = FINISH_RADIUS + Math.min(FINISH_SAFE, FINISH_RADIUS + LINK_CLEARANCE)
  const rapids = result.moves.filter((move) => move.kind === 'rapid')
  for (const move of rapids) {
    // A retract may start at the cut, but any rapid that travels is at the
    // travel height for its whole length: never across standing material.
    if (move.from.x !== move.to.x || move.from.y !== move.to.y) {
      assert.equal(move.from.z, travelZ, 'off-axis traverse starts at the bar plus clearance')
    }
  }
  assert.equal(rapids.at(-1)!.to.z, safeZ, 'off-axis last move retracts to safeRadius')
  const traverses = rapids.filter((move) => move.from.z === travelZ && move.from.x !== move.to.x)
  assert.ok(traverses.length >= 1, 'the gap between the two model pieces forces a traverse at the bar plus clearance')
  for (let i = 1; i < result.moves.length; i++) {
    assert.deepEqual(result.moves[i].from, result.moves[i - 1].to, `off-axis move ${i} is connected`)
  }
}

{
  // Review fix 1: a turning link rises to the bar's surface plus a clearance, so
  // it is in air whatever the model does between the two pass angles. A square
  // prism of half-width 10 in a 40 mm bar, a 6 mm ball and a 6 mm stepover puts
  // the passes at k * 17.142857 degrees; the 34.29 -> 51.43 link used to turn
  // at the higher of the two end tips, tip radius 13.598, while the corner at
  // 45 degrees needs 14.141 -- a 0.542 mm gouge, in the finish and the rough,
  // on both bar axes.
  for (const axis of ['x', 'y'] as const) {
    const stock = insetStock(axis)
    const square10 = prism(stock, [[-10, -10], [10, -10], [10, 10], [-10, 10]])
    const ball6: NormalizedTool = { ...BALL, id: 'ball-6', name: '6 mm ball nose', diameter: 6, radius: 3 }
    const linkTip = Math.min(FINISH_SAFE, FINISH_RADIUS + LINK_CLEARANCE)
    for (const generate of [generateRotaryFinish, generateRotaryRough]) {
      const result = generate('op-link', square10, stock, ball6, { ...FINISH_BASE, stepover: 6, stepdown: 4 }, {})
      const links = result.moves.filter((move) =>
        move.kind === 'cut' && move.from.a !== undefined && move.to.a !== undefined && move.from.a !== move.to.a)
      assert.ok(links.length > 0, `${axis} the prism exercises turning links`)
      for (const move of links) {
        assert.equal(move.from.z, move.to.z, `${axis} link turns at one height`)
        assert.ok(move.to.z - FINISH_RADIUS >= FINISH_RADIUS + LINK_CLEARANCE - 1e-9,
          `${axis} link tip radius is at least R + clearance`)
        approx(move.to.z - FINISH_RADIUS, linkTip, `${axis} link turns at min(safeRadius, R + clearance)`, 1e-9)
        // Independent of the generator: sample the model at one degree steps
        // across the link's sweep, at the link's own along position, and check
        // the turn clears the safe tip everywhere the model is under the tool.
        const from = move.from.a as number
        const to = move.to.a as number
        const sweep: number[] = []
        for (let angle = from; angle < to; angle += 1) sweep.push(angle)
        sweep.push(to)
        const sampled = sampleRotaryModel(square10, stock, ball6, {
          anglesDeg: sweep, along: [axis === 'x' ? move.from.x : move.from.y], requestedCellSize: CELL,
        }, [])
        for (const row of sampled.tipRadius) {
          if (!Number.isFinite(row[0])) continue
          assert.ok(move.to.z - FINISH_RADIUS >= row[0] - TOLERANCE,
            `${axis} link ${from.toFixed(2)} -> ${to.toFixed(2)} clears the model (${(move.to.z - FINISH_RADIUS).toFixed(3)} >= ${row[0].toFixed(3)})`)
        }
      }
    }
  }
}

{
  // Review fix 2: `rotaryAlongRange` limits the tool *centre* to the model's
  // along extent, so at the model's end the cutter's side reaches a tool radius
  // past it into the bar that is meant to stay and hold the part. An off-axis
  // prism (across 8..12, up 8..12) spanning along 10..30 in a 60 mm bar, zero
  // supports and a 2 mm flat end mill: the rough used to plunge to the
  // centreline at along 10 and take the bar at 9.5. The generator now samples
  // the retained bar -- two coaxial cylinders at the bar's radius, one from each
  // bar end to the cut range -- alongside the model, so the tool-shape sampling
  // lifts the tip at the model's ends by itself.
  const modelMin = 10
  const modelMax = 30
  // Facet sagitta (minRenderHeight, 0.01 mm) and one 0.05 mm height-map cell
  // are the slack a sampled bar surface can sit below the true one.
  const EPSILON = 0.05
  for (const axis of ['x', 'y'] as const) {
    const stock = finishStock(axis)
    const radius = stock.thickness / 2
    const mesh = prism(stock, [[8, 8], [12, 8], [12, 12], [8, 12]], [modelMin, modelMax])
    const alongOf = (p: { x: number; y: number }): number => axis === 'x' ? p.x : p.y
    /**
     * The radial depth of the deepest cutter point lying outside the model's
     * along extent, or Infinity when the cutter stays inside it. The retained
     * region is that bar; a cutter point there below the bar's surface is a
     * gouge. `tip` is the tool tip on the centreline: a flat end mill is the
     * disc of radius r at the tip height, a ball the sphere of radius r whose
     * lowest point is the tip.
     */
    const retainedDepth = (tip: ToolpathPoint, tool: NormalizedTool): number => {
      const r = tool.radius
      const along = alongOf(tip)
      const lowCrosses = along - r < modelMin
      const highCrosses = along + r > modelMax
      if (!lowCrosses && !highCrosses) return Infinity
      if (tool.type === 'flat_endmill') {
        const depth = Math.abs(tip.z - radius)
        return depth < radius ? depth : Infinity
      }
      const halfWidth = Math.sqrt(r * r - Math.min(Math.abs(modelMin - along), r) ** 2)
      const highHalfWidth = Math.sqrt(r * r - Math.min(Math.abs(along - modelMax), r) ** 2)
      const depth = Math.abs(tip.z + r - radius)
      let worst = Infinity
      if (lowCrosses) worst = Math.min(worst, Math.max(0, depth - halfWidth))
      if (highCrosses) worst = Math.min(worst, Math.max(0, depth - highHalfWidth))
      return Math.min(worst, radius)
    }
    for (const tool of [FLAT_2, FINISH_PASS_MM]) {
      for (const generate of [generateRotaryFinish, generateRotaryRough]) {
        const result = generate('op-retained', mesh, stock, tool, { ...FINISH_BASE, stepover: 20, stepdown: 4 }, {})
        assert.ok(result.moves.length > 0, `${axis} ${tool.type} ${generate.name} cuts the off-axis prism`)
        for (const move of result.moves) {
          if (move.kind === 'rapid') continue
          for (const point of [move.from, move.to]) {
            const depth = retainedDepth(point, tool)
            assert.ok(depth >= radius - EPSILON,
              `${axis} ${tool.type} ${generate.name} ${move.kind} at along ${alongOf(point).toFixed(3)} stays out of the retained bar (${depth.toFixed(4)} >= ${(radius - EPSILON).toFixed(4)})`)
          }
        }
      }
    }
  }
}

{
  // Slice I item 1: a cut move interpolates between two samples, so a step
  // steeper than the samples are apart used to cut the corner even though every
  // sample's own tip was safe. A coaxial stepped lathe (radius 4 inside
  // 10..20, 7 inside 20..30) sampled every 1 mm makes a 3 mm step at along 20,
  // three times the spacing. The rule emits a vertical leg at the lower sample
  // plus a horizontal one at the higher tip, not one diagonal. The cutter is
  // checked against the exact surface of revolution at every step of every
  // move: the lathe is axisymmetric, so the surface under a cutter point is the
  // profile at that point's own along position.
  for (const axis of ['x', 'y'] as const) {
    const stock = insetStock(axis)
    const radius = stock.thickness / 2
    const profile = (along: number): number => along < 20 ? 4 : 7
    const mesh = lathe(stock, profile, 10, 30, 400, 64)
    const mill: NormalizedTool = { ...BALL, id: 'flat-1', name: '1 mm flat end mill', type: 'flat_endmill', diameter: 1, radius: 0.5 }
    const tolerance = CELL + 0.02
    const cutter: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0, 0], [0.5, 0, 0], [-0.5, 0, 0], [0, 0.5, 0], [0, -0.5, 0],
    ]
    const alongOf = (p: { x: number; y: number }): number => axis === 'x' ? p.x : p.y
    for (const generate of [generateRotaryFinish, generateRotaryRough]) {
      const result = generate('op-step', mesh, stock, mill,
        { ...FINISH_BASE, stepover: 20, sampleSpacing: 1, stepdown: 4 }, {})
      let checked = 0
      for (const move of result.moves) {
        if (move.kind === 'rapid') continue
        const dx = move.to.x - move.from.x
        const dy = move.to.y - move.from.y
        const dz = move.to.z - move.from.z
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / (0.1 * mill.radius)))
        for (let s = 0; s <= steps; s++) {
          const f = s / steps
          const px = move.from.x + dx * f
          const py = move.from.y + dy * f
          const pz = move.from.z + dz * f
          const along = axis === 'x' ? px : py
          const across = (axis === 'x' ? py : px) - roundStockCentre(stock)
          const up = pz - radius
          for (const [ox, oy, oz] of cutter) {
            const pointAlong = along + (axis === 'x' ? ox : oy)
            if (pointAlong < 10 || pointAlong > 30) continue
            const pointAcross = across + (axis === 'x' ? oy : ox)
            const radial = Math.hypot(pointAcross, up + oz)
            assert.ok(radial >= profile(pointAlong) - tolerance,
              `${axis} ${generate.name} ${move.kind} clears the step (along ${pointAlong.toFixed(3)}: radial ${radial.toFixed(3)} < ${profile(pointAlong)})`)
            checked++
          }
        }
      }
      assert.ok(checked > 0, `${axis} ${generate.name} checked cutter points against the step`)
    }
    // The rule's own shape: the 19 -> 20 pair is a vertical leg at the lower
    // sample then an along leg at the higher tip, never one diagonal. Removing
    // the rule or widening the threshold to ten times the spacing brings the
    // diagonal back; the cutter check above and these two assertions catch it.
    const finish = generateRotaryFinish('op-step-shape', mesh, stock, mill, { ...FINISH_BASE, stepover: 20, sampleSpacing: 1 }, {})
    const rise = finish.moves.filter((move) => move.kind === 'cut' && move.from.a === 0 && move.to.a === 0
      && alongOf(move.from) === 19 && alongOf(move.to) === 19)
    assert.equal(rise.length, 1, `${axis} the step rises vertically at the lower sample`)
    approx(rise[0].from.z, radius + 4, `${axis} the vertical leg starts at the lower sample's tip`, 0.02)
    approx(rise[0].to.z, radius + 7, `${axis} the vertical leg reaches the higher tip`, 0.02)
    const highRun = finish.moves.filter((move) => move.kind === 'cut' && move.from.a === 0 && move.to.a === 0
      && alongOf(move.from) === 19 && alongOf(move.to) > 19)
    assert.ok(highRun.length >= 1, `${axis} the step runs along at the higher tip`)
    for (const move of highRun) {
      approx(move.from.z, radius + 7, `${axis} the along leg starts at the higher tip`, 0.02)
      approx(move.to.z, radius + 7, `${axis} the along leg ends at the higher tip`, 0.02)
    }
  }
}

{
  // Slice I item 2: travel is always the bar's surface plus the clearance, and
  // the operation's first positioning move and final retract go to the higher
  // of that and `safeRadius`. On this 40 mm bar a rapid height of 40.2 (tip
  // radius 20.2) used to cap every internal turn and traverse at 40.2 -- a fifth
  // of a millimetre above the bar instead of the clearance.
  const stock = insetStock('x')
  const cylinder = prism(stock, CIRCLE)
  const safeRadius = 20.2
  const travelZ = 2 * FINISH_RADIUS + LINK_CLEARANCE
  const rapidHeight = Math.max(FINISH_RADIUS + safeRadius, travelZ)
  assert.ok(rapidHeight > FINISH_RADIUS + safeRadius, 'the case really exercises the cap')
  for (const generate of [generateRotaryFinish, generateRotaryRough]) {
    const result = generate('op-clearance', cylinder, stock, FINISH_PASS_MM,
      { ...FINISH_BASE, stepover: 20, stepdown: 4, safeRadius }, {})
    assert.ok(result.moves.length > 0, `${generate.name} produces moves`)
    approx(result.moves[0].to.z, rapidHeight, 'first positioning move is at the rapid height', 1e-9)
    approx(result.moves.at(-1)!.to.z, rapidHeight, 'final retract is at the rapid height', 1e-9)
    let links = 0
    for (const move of result.moves) {
      if (move.kind === 'rapid') {
        assert.ok(Math.max(move.from.z, move.to.z) >= travelZ - 1e-9, 'every rapid reaches the clearance above the bar')
        continue
      }
      if (move.from.a !== undefined && move.to.a !== undefined && move.from.a !== move.to.a) {
        approx(move.from.z, travelZ, 'a turning link turns at the bar plus the clearance', 1e-9)
        approx(move.to.z, travelZ, 'a turning link keeps the clearance height', 1e-9)
        links++
      }
    }
    assert.ok(links > 0, `${generate.name} exercises a turning link`)
  }
}

{
  // Slice H: inside one operation every move between runs -- the retract off a
  // run, the traverse to the next run, and the turning link -- travels at the
  // bar's surface plus a clearance (the same height as the link), never at
  // `safeRadius`. `safeRadius` is only the operation's first positioning move
  // and its final retract. Before this, every gap retracted fully to
  // `safeRadius`, which on a many-layer rough is hundreds of full retracts, and
  // `safeRadius` is the project's rapid height, often far above the bar.
  //
  // Two models, because the two generators split a pass for different reasons:
  // the finish leaves a `NaN` sample (no model under the tool) uncut, so two
  // off-axis prisms with an air gap between them split its passes; the rough
  // removes every sample down to the layer, so a pass splits only where the
  // material is already low enough, which two ridges do.
  const safeZ = FINISH_RADIUS + FINISH_SAFE
  const travelZ = FINISH_RADIUS + Math.min(FINISH_SAFE, FINISH_RADIUS + LINK_CLEARANCE)
  const checkTravel = (label: string, moves: readonly ToolpathMove[]): void => {
    const rapids = moves.filter((move) => move.kind === 'rapid')
    assert.ok(rapids.length >= 3, `${label} has several moves between runs (${rapids.length} rapids)`)
    approx(rapids[0].to.z, safeZ, `${label} first positioning move is at safeRadius`, 1e-9)
    approx(rapids.at(-1)!.to.z, safeZ, `${label} final retract is at safeRadius`, 1e-9)
    for (let i = 0; i < rapids.length; i++) {
      const move = rapids[i]
      // A retract may start at the cut, so measure the height the rapid reaches:
      // no rapid ever travels below the bar plus the clearance.
      assert.ok(Math.max(move.from.z, move.to.z) >= travelZ - 1e-9,
        `${label} rapid ${i} never travels below R + clearance`)
      if (i === 0 || i === rapids.length - 1) continue
      assert.equal(move.to.z, travelZ, `${label} inter-run rapid ${i} reaches R + clearance`)
      if (move.from.x !== move.to.x || move.from.y !== move.to.y) {
        assert.equal(move.from.z, travelZ, `${label} traverse ${i} stays at R + clearance`)
      }
    }
    for (let i = 1; i < moves.length; i++) {
      assert.deepEqual(moves[i].from, moves[i - 1].to, `${label} move ${i} is connected`)
    }
  }
  for (const axis of ['x', 'y'] as const) {
    const stock = insetStock(axis)
    const cross: readonly (readonly [number, number])[] = [[8, 8], [12, 8], [12, 12], [8, 12]]
    const pieceA = prism(stock, cross, [10, 14])
    const pieceB = prism(stock, cross, [19, 23])
    const positions = new Float32Array(pieceA.positions.length + pieceB.positions.length)
    positions.set(pieceA.positions)
    positions.set(pieceB.positions, pieceA.positions.length)
    const index = new Uint32Array(pieceA.index.length + pieceB.index.length)
    index.set(pieceA.index)
    index.set(Array.from(pieceB.index, (i) => i + pieceA.positions.length / 3), pieceA.index.length)
    const finish = generateRotaryFinish('op-travel', { positions, index }, stock, FINISH_PASS_MM,
      { ...FINISH_BASE, stepover: 20 }, {})
    checkTravel(`${axis} finish`, finish.moves)

    const ridge = lathe(stock, (x) => 3 + (x - 10) / 10 + 23 * Math.exp(-((x - 15) ** 2)) + 21 * Math.exp(-((x - 24) ** 2)), 10, 30, 200, 64)
    const rough = generateRotaryRough('op-travel', ridge, stock, { ...FLAT_2, radius: 0.1, diameter: 0.2 },
      { ...FINISH_BASE, stepover: 22, sampleSpacing: 1, stockToLeave: 0, stepdown: 5 }, {})
    checkTravel(`${axis} rough`, rough.moves)
  }
}

{
  // Review item 5: a model poking outside the bar is machined as air. The
  // operation still generates, and says so once.
  const stock = insetStock('x')
  for (const generate of [generateRotaryFinish, generateRotaryRough]) {
    const params = { ...FINISH_BASE, stepover: 20, stepdown: 4 }
    const inside = generate('op-inside', prism(stock, SQUARE), stock, FINISH_PASS_MM, params, {})
    assert.equal(inside.warnings.filter((w) => w.code === 'rotaryModelOutsideBar').length, 0,
      'a model inside the bar raises no outside-bar warning')
    const radial = generate('op-poke', prism(stock, [[-2, 18], [2, 18], [2, 22], [-2, 22]]), stock, FINISH_PASS_MM, params, {})
    assert.equal(radial.warnings.filter((w) => w.code === 'rotaryModelOutsideBar').length, 1,
      'a vertex farther from the axis than R warns exactly once')
    const beyond = generate('op-beyond', prism(stock, SQUARE, [50, 70]), stock, FINISH_PASS_MM, params, {})
    assert.equal(beyond.warnings.filter((w) => w.code === 'rotaryModelOutsideBar').length, 1,
      'a vertex past the bar end warns exactly once')
    const flush = generate('op-flush', prism(stock, [[-2, -2], [2, -2], [0, 20]]), stock, FINISH_PASS_MM, params, {})
    assert.equal(flush.warnings.filter((w) => w.code === 'rotaryModelOutsideBar').length, 0,
      'a vertex exactly on the bar surface is not outside it')
  }
}

{
  // Review item 6: a zero or non-finite stepover / sample spacing used to be
  // floored at 1e-9, which asks for about 6e10 samples and hangs the worker; a
  // bar with no positive radius has no surface to cut. Both generators refuse.
  const stock = insetStock('x')
  const cylinder = prism(stock, CIRCLE)
  for (const generate of [generateRotaryFinish, generateRotaryRough]) {
    const base = { ...FINISH_BASE, stepover: 20, stepdown: 4 }
    for (const stepover of [0, -1, NaN, Infinity]) {
      const result = generate('op-bad-stepover', cylinder, stock, FINISH_PASS_MM, { ...base, stepover }, {})
      assert.deepEqual(result.moves, [], `stepover ${stepover} emits no moves`)
      assert.deepEqual(result.warnings.map((w) => w.code), ['operationStepoverRatioRange'], `stepover ${stepover} warns`)
    }
    for (const sampleSpacing of [0, -1, NaN, Infinity]) {
      const result = generate('op-bad-spacing', cylinder, stock, FINISH_PASS_MM, { ...base, sampleSpacing }, {})
      assert.deepEqual(result.moves, [], `sample spacing ${sampleSpacing} emits no moves`)
      assert.deepEqual(result.warnings.map((w) => w.code), ['operationStepoverRatioRange'], `sample spacing ${sampleSpacing} warns`)
    }
    const degenerate = generate('op-degenerate', cylinder, { ...stock, thickness: 0 }, FINISH_PASS_MM, base, {})
    assert.deepEqual(degenerate.moves, [], 'a bar with no radius emits no moves')
    assert.deepEqual(degenerate.warnings.map((w) => w.code), ['aroundStockMismatch'], 'a bar with no radius is refused')
  }
}

{
  // Rule 10: progress and stopping pass straight through to the sampler.
  const stock = insetStock('x')
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
  const stock = insetStock('x')
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
  // Review fix 3: the merge dropped a point whenever it was within tolerance of
  // the line from the last kept point to the *next original* point, and never
  // rechecked the points already dropped against the final segment. On a gently
  // curved coaxial profile r(x) = 6 - 0.001 (x - 20)^2 sampled every 0.05 mm
  // against a 0.001 mm tolerance every individual step looked straight and the
  // whole run collapsed into one chord 0.0995 mm below the surface -- 100 times
  // the tolerance. Douglas--Peucker replaces a run only when every point of it
  // is within the tolerance of the replacing segment.
  const stock = roundStock(40, 20, 'x', { x: 10, y: 7 })
  const profile = (x: number): number => 6 - 0.001 * (x - 20) ** 2
  const alongStart = 10
  const alongEnd = 30
  const spacing = 0.05
  const intervals = Math.round((alongEnd - alongStart) / spacing)
  const along = Array.from({ length: intervals + 1 }, (_, i) => alongStart + (alongEnd - alongStart) * i / intervals)
  const curvature = lathe(stock, profile, alongStart, alongEnd, 800, 64)
  const result = generateRotaryFinish('op-merge', curvature, stock, FINISH_PASS_MM,
    { ...FINISH_BASE, stepover: 100, sampleSpacing: spacing }, {})
  // The sampler's own tips at the pass's sample positions: no stubs (the bar is
  // exactly the profile's extent) and no stock to leave, so these are the points
  // the merge saw before it dropped any.
  const raw = sampleRotaryModel(curvature, stock, FINISH_PASS_MM, {
    anglesDeg: [0], along, requestedCellSize: FINISH_BASE.requestedCellSize,
  }, []).tipRadius[0]
  const passPoints: ToolpathPoint[] = []
  for (const move of result.moves) {
    if (move.kind !== 'cut' || move.from.a !== 0 || move.to.a !== 0 || move.from.x === move.to.x) continue
    if (passPoints.length === 0) passPoints.push(move.from)
    passPoints.push(move.to)
  }
  assert.ok(passPoints.length >= 2, 'the curved 0 degree pass produces a merged path')
  const tolerance = 0.001
  const distanceToSegment = (px: number, pz: number, a: ToolpathPoint, b: ToolpathPoint): number => {
    const dx = b.x - a.x
    const dz = b.z - a.z
    const lengthSq = dx * dx + dz * dz
    if (lengthSq <= 1e-18) return Math.hypot(px - a.x, pz - a.z)
    const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / lengthSq))
    return Math.hypot(px - (a.x + t * dx), pz - (a.z + t * dz))
  }
  let worstDistance = 0
  let worstDrop = 0
  for (let i = 0; i < along.length; i++) {
    const x = along[i]
    const z = FINISH_RADIUS + raw[i]
    let coveringDistance = Infinity
    let coveringZ = NaN
    for (let s = 0; s + 1 < passPoints.length; s++) {
      const a = passPoints[s]
      const b = passPoints[s + 1]
      if (x < Math.min(a.x, b.x) - 1e-9 || x > Math.max(a.x, b.x) + 1e-9) continue
      const distance = distanceToSegment(x, z, a, b)
      if (distance < coveringDistance) {
        coveringDistance = distance
        coveringZ = b.x === a.x ? a.z : a.z + (b.z - a.z) * ((x - a.x) / (b.x - a.x))
      }
    }
    assert.ok(Number.isFinite(coveringDistance), `sample along ${x} is covered by the merged path`)
    assert.ok(coveringDistance <= tolerance + 1e-9,
      `every sample lies within the tolerance of the segment that replaces it (along ${x}: ${coveringDistance})`)
    // Douglas--Peucker bounds the *perpendicular* distance; the profile's
    // steepest slope is 0.02, so the vertical drop can exceed it by at most
    // 0.02 per cent.
    assert.ok(coveringZ >= z - tolerance * 1.001,
      `the merged path is not below its samples by more than the tolerance (along ${x}: ${z - coveringZ})`)
    worstDistance = Math.max(worstDistance, coveringDistance)
    worstDrop = Math.max(worstDrop, z - coveringZ)
  }
  assert.ok(worstDistance > 0, 'the profile really is curved (the merge had something to fit)')
  assert.ok(passPoints.length >= 5, `the curved run keeps a segmented path (${passPoints.length} points), not one chord`)
  console.log(`rotary merge fixture: ${passPoints.length} points from ${along.length} samples, `
    + `worst distance ${worstDistance.toExponential(2)} mm, worst drop ${worstDrop.toExponential(2)} mm`)
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
  // The link's rise/turn/drop moves sit at the bar's surface plus clearance
  // (fix 1); only the moves running along the bar carry the cut tip.
  const tip = Math.max(...cuts.filter((move) => move.from.x !== move.to.x).flatMap((move) => [move.from.z, move.to.z])) - 20
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

// Slice C: asymmetric models in both frames expose mirrored return-pass heights.
for (const axis of ['x', 'y'] as const) {
  const stock = roundStock(40, 150, axis, axis === 'x' ? { x: 0, y: 7 } : { x: 7, y: 0 })
  const cone = lathe(stock, (x) => 3 + x / 10, 5, 145, 70, 64)
  const modelAlong = { min: 5, max: 145 }
  const supports = { chuckEnd: 10, tailEnd: 15 }
  const clamp = (type: 'chuck' | 'tailstock', min: number, length: number): Clamp => ({
    id: type, name: type, type, visible: true, height: 60,
    ...(axis === 'x' ? { x: min, y: -20, w: length, h: 80 } : { x: -20, y: min, w: 80, h: length }),
  })
  // Review item 4: the tool's side must not enter a support, so a support
  // greater than 0 is kept clear by its own length plus the tool's radius (1.5
  // for BALL). A support of 0 means no support and adds nothing: the model's
  // own extent still limits the range.
  assert.deepEqual(rotaryAlongRange(stock, [], modelAlong, BALL, supports), { start: 11.5, end: 133.5 }, `${axis} range without chuck`)
  assert.deepEqual(rotaryAlongRange(stock, [], modelAlong, BALL, { chuckEnd: 0, tailEnd: 0 }),
    { start: 5, end: 145 }, `${axis} zero supports add no tool radius`)
  assert.deepEqual(rotaryAlongRange(stock, [], modelAlong, BALL, { chuckEnd: 10, tailEnd: 0 }),
    { start: 11.5, end: 145 }, `${axis} only the chuck end pays the tool radius`)
  assert.deepEqual(rotaryAlongRange(stock, [], modelAlong, BALL, { chuckEnd: 0, tailEnd: 15 }),
    { start: 5, end: 133.5 }, `${axis} only the tail end pays the tool radius`)
  assert.deepEqual(rotaryAlongRange(stock, [clamp('chuck', 149, 40)], modelAlong, BALL, supports),
    { start: 16.5, end: 138.5 }, `${axis} upper chuck swaps support ends`)
  assert.deepEqual(rotaryAlongRange(stock, [clamp('tailstock', 132, 40)], modelAlong, BALL, supports),
    { start: 11.5, end: 130.5 }, `${axis} tailstock inner edge includes tool radius`)
  assert.deepEqual(rotaryAlongRange(stock, [clamp('chuck', -40, 58)], modelAlong, BALL, supports),
    { start: 19.5, end: 133.5 }, `${axis} lower chuck inner edge includes tool radius`)
  assert.deepEqual(rotaryAlongRange(stock, [], { min: 20, max: 100 }, BALL, supports),
    { start: 20, end: 100 }, `${axis} range intersects model to keep attachments`)
  assert.equal(rotaryAlongRange(stock, [], modelAlong, BALL, { chuckEnd: 80, tailEnd: 80 }), null, `${axis} overlapping supports have no room`)
  assert.equal(rotaryAlongRange(stock, [], { min: 140, max: 145 }, BALL, supports), null, `${axis} model outside support range has no room`)
  assert.equal(rotaryAlongRange(stock, [], modelAlong, BALL, { chuckEnd: 75, tailEnd: 75 }), null, `${axis} touching supports have no room`)
  for (const generate of [generateRotaryFinish, generateRotaryRough]) {
    const result = generate('empty', cone, stock, BALL, { ...FINISH_BASE, stepover: 20, stepdown: 2, alongStart: 80, alongEnd: 70 }, {})
    assert.deepEqual(result.moves, [], `${axis} empty range generates no moves`)
    assert.deepEqual(result.warnings, [{ code: 'rotaryNoRoom', params: { operation: 'empty' } }], `${axis} empty range warns exactly once`)
    assert.equal(result.bounds, null)
  }
}

for (const axis of ['x', 'y'] as const) {
  const stock = insetStock(axis)
  const position = (p: { x: number; y: number }): number => axis === 'x' ? p.x : p.y
  const cone = lathe(stock, (x) => 2 + (x - 10) * 0.55, 10, 30, 80, 64)
  const params = { ...FINISH_BASE, stepover: 22, sampleSpacing: 1, stepdown: 4, stockToLeave: 0.3 }
  const passes = finishPasses(params.stepover)
  const along = Array.from({ length: 21 }, (_, i) => 10 + i)
  const angles = Array.from({ length: passes }, (_, k) => k * (360 / passes))
  for (const tool of [BALL, FLAT_2]) {
    const enlarged = { ...tool, radius: tool.radius + params.stockToLeave, diameter: tool.diameter + 2 * params.stockToLeave }
    const sampled = sampleRotaryModel(cone, stock, enlarged, { anglesDeg: angles, along, requestedCellSize: CELL }, [])
    const targets = sampled.tipRadius.map((row) => Array.from(row, (r) => Math.min(20, Math.max(0, r + params.stockToLeave))))
    const lowest = Math.min(...targets.flat())
    const layers = Math.ceil((20 - lowest) / params.stepdown)
    const progress: number[][] = []
    const result = generateRotaryRough('cone', cone, stock, tool, params, { onAngle: (done, total) => { progress.push([done, total]) } })
    assert.deepEqual(progress, angles.map((_, k) => [k + 1, passes]), `${axis} rough samples once per angle for all layers`)
    assert.equal(result.warnings.length, 0, `${axis} rough cone has no warnings`)
    assert.ok(result.moves.length > 0)
    assert.equal(Math.max(...result.moves.map((m) => Math.floor(m.to.a! / 360))) + 1, layers, `${axis} exact layer count`)
    const depths = targets.map((row) => row.map(() => Infinity))
    const travelZ = 20 + Math.min(params.safeRadius, 20 + LINK_CLEARANCE)
    let checked = 0
    let skipped = 0
    let links = 0
    for (let m = 0; m < result.moves.length; m++) {
      const move = result.moves[m]
      if (m) assert.deepEqual(move.from, result.moves[m - 1].to, `${axis} rough moves connected`)
      assert.ok(move.to.a! >= move.from.a!, `${axis} rough angles never reset across layers`)
      if (move.kind === 'rapid') {
        // Slice H: only the opening positioning move and the closing retract go
        // to safeRadius; every retract and traverse between runs travels at the
        // bar's surface plus the clearance.
        if (m === 0) {
          assert.deepEqual(move.from, move.to, `${axis} rough opens by positioning at safeRadius`)
          assert.equal(move.to.z, 20 + params.safeRadius, `${axis} first move is at safeRadius`)
        } else if (m === result.moves.length - 1) {
          assert.equal(move.to.z, 20 + params.safeRadius, `${axis} final retract is at safeRadius`)
        } else {
          assert.equal(move.to.z, travelZ, `${axis} inter-run rapid reaches the bar plus clearance`)
          if (position(move.from) !== position(move.to) || move.from.a !== move.to.a) {
            assert.equal(move.from.z, travelZ, `${axis} traverse stays at the bar plus clearance`)
          }
        }
        continue
      }
      if (move.kind === 'plunge') {
        assert.equal(move.from.z, m === 1 ? 20 + params.safeRadius : travelZ, `${axis} run plunge starts at the travel height`)
      }
      if (move.from.a !== move.to.a) {
        assert.equal(position(move.from), position(move.to), `${axis} finish-style link stays at shared end`)
        assert.ok([10, 30].includes(position(move.to)), `${axis} only bar-end links at depth`)
        assert.equal(move.from.z, move.to.z, `${axis} end link turns at one height`)
        // Review fix 1: the end link turns at the bar's surface plus the
        // clearance, not at the higher of the two layer targets.
        approx(move.to.z - 20, Math.min(params.safeRadius, 20 + LINK_CLEARANCE), `${axis} rough end link turns above the bar`, 1e-9)
        links++
        continue
      }
      const layer = Math.floor(move.to.a! / 360) + 1
      const pass = Math.round((move.to.a! - (layer - 1) * 360) / (360 / passes))
      const level = Math.max(lowest, 20 - layer * params.stepdown)
      const previous = 20 - (layer - 1) * params.stepdown
      const from = position(move.from), to = position(move.to)
      if (move.kind === 'cut' && from !== to) {
        assert.ok(pass % 2 === 0 ? to > from : to < from, `${axis} rough passes alternate direction`)
      }
      for (let j = 0; j < along.length; j++) {
        const x = along[j]
        if (x < Math.min(from, to) - 1e-9 || x > Math.max(from, to) + 1e-9) continue
        const tip = from === to ? move.to.z - 20 : move.from.z - 20 + (move.to.z - move.from.z) * (x - from) / (to - from)
        assert.ok(tip >= targets[pass][j] - 0.0011, `${axis} rough never cuts below target`)
        // Pure vertical rise/drop links can be above the layer's target.
        if (from !== to || move.kind === 'plunge') {
          assert.ok(targets[pass][j] < previous, `${axis} air skipped at later layer`)
          approx(tip, Math.max(targets[pass][j], level), `${axis} layer target is clamped, last layer exact`, 0.0011)
          depths[pass][j] = Math.min(depths[pass][j], tip)
          checked++
        }
      }
    }
    // A final layer can have a single sample, reached by a plunge or a
    // finish-style turn/drop without an along segment.
    for (const move of result.moves) {
      if (move.kind === 'rapid') continue
      for (const p of [move.from, move.to]) {
        const layer = Math.floor(p.a! / 360)
        const pass = Math.round((p.a! - layer * 360) / (360 / passes))
        const j = along.findIndex((x) => Math.abs(x - position(p)) < 1e-9)
        if (j >= 0) depths[pass][j] = Math.min(depths[pass][j], p.z - 20)
      }
    }
    for (let pass = 0; pass < passes; pass++) for (let j = 0; j < along.length; j++) {
      approx(depths[pass][j], targets[pass][j], `${axis} deepest cone sample equals final target`, 0.0011)
      for (let layer = 1; layer <= layers; layer++) if (targets[pass][j] >= 20 - (layer - 1) * params.stepdown) skipped++
    }
    assert.ok(links > 0, `${axis} cone exercises finish-style links`)
    assert.ok(checked > 100 && skipped > 0, `${axis} cone checks real cuts and skipped air`)
    const cutTips = result.moves.filter((m) => m.kind !== 'rapid').map((m) => m.to.z - 20)
    approx(Math.min(...cutTips), lowest, `${axis} no layer below lowest target`, 1e-9)
    const stopped = generateRotaryRough('cone-stop', cone, stock, tool, params, { shouldStop: () => true })
    assert.deepEqual(stopped, { operationId: 'cone-stop', moves: [], warnings: [], bounds: null }, `${axis} rough stop discards all output`)
    let done = 0
    const partial = generateRotaryRough('partial', cone, stock, tool, params, {
      onAngle: (count) => { done = count }, shouldStop: () => done === 2,
    })
    assert.equal(done, 2, `${axis} rough partial stop forwards progress`)
    assert.deepEqual(partial, { operationId: 'partial', moves: [], warnings: [], bounds: null }, `${axis} partial stop discards all output`)
    const refused = generateRotaryRough('unsupported', cone, stock, VBIT, params, {})
    assert.deepEqual(refused.warnings.map((w) => w.code), ['rotaryToolUnsupported'], `${axis} rough refuses unsupported tools`)
    assert.deepEqual(refused.moves, [])
    for (const stepdown of [0, -1, NaN, Infinity]) {
      const invalid = generateRotaryRough('invalid', cone, stock, tool, { ...params, stepdown }, {})
      assert.deepEqual(invalid.warnings.map((w) => w.code), ['stepdownPositive'], `${axis} rough refuses invalid stepdown`)
      assert.deepEqual(invalid.moves, [])
    }
  }

  // Two uneven ridges split a pass into three runs even on the first layer.
  const ridge = lathe(stock, (x) => 3 + (x - 10) / 10 + 23 * Math.exp(-((x - 15) ** 2)) + 21 * Math.exp(-((x - 24) ** 2)), 10, 30, 200, 64)
  const tool = { ...FLAT_2, radius: 0.1, diameter: 0.2 }
  const splitParams = { ...params, stockToLeave: 0, stepdown: 5 }
  const splitTargets = sampleRotaryModel(ridge, stock, tool, { anglesDeg: angles, along, requestedCellSize: CELL }, []).tipRadius
  const split = generateRotaryRough('runs', ridge, stock, tool, splitParams, {})
  assert.ok(split.moves.filter((m) => m.kind === 'plunge' && m.to.a === 0).length >= 3, `${axis} ridge forces separated runs`)
  const splitTravelZ = 20 + Math.min(params.safeRadius, 20 + LINK_CLEARANCE)
  let traverses = 0
  for (let i = 0; i < split.moves.length; i++) {
    const move = split.moves[i]
    if (i) assert.deepEqual(move.from, split.moves[i - 1].to, `${axis} split runs stay connected`)
    if (move.kind === 'rapid') {
      // Slice H: only the opening move and the closing retract use safeRadius.
      if (i === 0) {
        assert.deepEqual(move.from, move.to, `${axis} split path opens by positioning at safeRadius`)
        assert.equal(move.to.z, 20 + params.safeRadius, `${axis} split first move is at safeRadius`)
      } else if (i === split.moves.length - 1) {
        assert.equal(move.to.z, 20 + params.safeRadius, `${axis} split final retract is at safeRadius`)
      } else {
        assert.equal(move.to.z, splitTravelZ, `${axis} between runs rapid reaches the bar plus clearance`)
        if (position(move.from) !== position(move.to) || move.from.a !== move.to.a) {
          assert.equal(move.from.z, splitTravelZ, `${axis} no traverse inside standing material`)
          traverses++
        }
      }
    }
    if (move.kind === 'plunge') {
      assert.equal(move.from.z, i === 1 ? 20 + params.safeRadius : splitTravelZ, `${axis} split run entry plunges from the travel height`)
    }
    if (move.kind !== 'cut' || move.from.a !== move.to.a || position(move.from) === position(move.to)) continue
    const layer = Math.floor(move.to.a! / 360)
    const pass = Math.round((move.to.a! - layer * 360) / (360 / passes))
    for (let j = 0; j < along.length; j++) {
      if (along[j] < Math.min(position(move.from), position(move.to)) || along[j] > Math.max(position(move.from), position(move.to))) continue
      assert.ok(splitTargets[pass][j] < 20 - layer * splitParams.stepdown, `${axis} no cut links across an air gap between runs`)
    }
  }
  assert.ok(traverses > passes, `${axis} split runs exercise real safe traverses`)
}

{
  const tool = { ...FLAT_2, radius: 3, diameter: 6 }
  const params = { stepover: 2, stepdown: 2, sampleSpacing: 0.5, stockToLeave: 0,
    alongStart: 0, alongEnd: 150, safeRadius: 23.1, requestedCellSize: 0.1 }
  const bounds = computeXYBounds(fixture.positions)
  const range = rotaryAlongRange(STOCK, [], { min: bounds.minX, max: bounds.maxX }, tool, { chuckEnd: 0, tailEnd: 0 })
  assert.ok(range, 'rough fixture has a model range')
  params.alongStart = range.start
  params.alongEnd = range.end
  const start = performance.now()
  const result = generateRotaryRough('rough-fixture', fixture, STOCK, tool, params, {})
  const elapsed = performance.now() - start
  assert.ok(result.moves.length > 0, 'rough fixture generates moves')
  const layers = new Set(result.moves.filter((m) => m.kind !== 'rapid').map((m) => Math.floor(m.to.a! / 360)))
  console.log(`rotaryRough fixture: ${elapsed.toFixed(1)} ms, ${layers.size} layers, ${result.moves.length} moves`)
  // The rough side of the same frozen matrix as the finish hash below: the
  // value was captured from the baseline 116f050d module and must not move when
  // the generators are widened to `BarStock` (#1016 C2-S3). The round bar is
  // the regression gate for the square work; a square-only change that leaks a
  // different cap, pass count, layer start or travel height into the round path
  // fails here.
  //
  // Re-captured for #1045 slice D: the band's upper end (X = 60.48) is inside
  // the bar, so the C2-F7 cutter-centre pull-in now keeps the tool one radius
  // inside the retained end. The span's last along position moves from 60.48
  // to 57.48 (every position shifts with the pulled span), the count drops
  // 2217 -> 2092, and the whole point list moves. The finish below uses the
  // full 0..150 band (both ends meet the bar) and is unchanged.
  assert.equal(result.moves.length, 2092, 'rough fixture keeps its move count')
  assert.equal(createHash('sha256').update(JSON.stringify(result.moves)).digest('hex'),
    'd559ac4d79d6c9716d0c7183f1d40ab8b4f4f5ace3493c23edbcf31c6b111386', 'rough fixture keeps its exact points')
  assert.deepEqual(result.warnings, [], 'rough fixture keeps its warnings')
  {
    // Slice H: the retract and the traverse between runs now hop over the bar
    // instead of going out to `safeRadius`, so the rough fixture's retract count
    // and total rapid travel are the numbers the change is measured by. Reported,
    // not asserted.
    const rapids = result.moves.filter((move) => move.kind === 'rapid')
    const length = (move: typeof rapids[number]): number => Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y, move.to.z - move.from.z)
    const retracts = rapids.filter((move) => move.from.z !== move.to.z && move.from.x === move.to.x && move.from.y === move.to.y)
    console.log(`rotaryRough fixture rapids: ${retracts.length} retracts, ${rapids.length} rapids, `
      + `${rapids.reduce((total, move) => total + length(move), 0).toFixed(1)} mm rapid travel`)
  }
}
console.log('engine/toolpaths/rotaryModel.test.ts: slice C assertions passed')

{
  // Hashes every move kind and endpoint of the fixture, including point order
  // and exact numeric values. The count and hash moved from slice B's
  // (7411 / 6f841fac...) with the slice-F review fix (the fixture's ends leave
  // the line over the centreline through `NaN` samples, which the finish must
  // not cut down to the axis), again with slice G's review fixes (the turning
  // link now turns at the bar's surface plus a clearance instead of the higher
  // end tip, and Douglas--Peucker keeps every point a chord would drop more than
  // 1 um away), and again with slice H (the retract and traverse between runs
  // travel at the bar's surface plus the clearance, not at `safeRadius`; the
  // fixture's ends leave `NaN` samples, so its passes split into runs and the
  // move count happens to stay the same while the heights change), and again
  // with slice I (the travel height is no longer capped by `safeRadius`, and a
  // step steeper than the sample spacing in a run -- the fixture's real mesh has
  // them at its steep walls -- is a vertical leg plus a horizontal one instead of
  // one diagonal). The goal is unchanged -- any later change to the generator's
  // geometry shows up as a diff here rather than only in a move count -- but this
  // is the fixed output.
  const result = generateRotaryFinish('op-fixture', fixture, STOCK, BALL, {
    stepover: 0.5, sampleSpacing: 0.2, stockToLeave: 0, alongStart: 0, alongEnd: 150,
    safeRadius: 21.6, requestedCellSize: fixtureCell,
  }, {})
  assert.equal(result.moves.length, 8844, 'finish fixture keeps its move count')
  assert.equal(createHash('sha256').update(JSON.stringify(result.moves)).digest('hex'),
    'e9067d81a3ad5bc657224f7f908db815dd16aaa8fefdd48de885211025d706e6', 'finish fixture keeps its exact points')
}

// ---------------------------------------------------------------------------
// Slice R: an along finish clears the material above its own finish surface in
// its own stepdown layers, unless an earlier rough already left it within one
// stepdown.
// ---------------------------------------------------------------------------
{
  const stock = roundStock(20, 20)
  const pivot = stock.thickness / 2
  const cylinder = lathe(stock, () => 5, 0, 20, 80, 64)
  const params = {
    stepover: 20, sampleSpacing: 1, stockToLeave: 0,
    alongStart: 0, alongEnd: 20, safeRadius: 30, requestedCellSize: CELL,
  }
  const clearing = generateRotaryFinish('along-clear', cylinder, stock, FINISH_PASS_MM,
    { ...params, stepdown: 1 }, {})
  assert.deepEqual(clearing.warnings, [], 'along clear warns about nothing')
  // 10 mm bar radius, 5 mm finish surface, 1 mm layers: 9, 8, 7 and 6 are the
  // clearing layers, then the finish pass at 5.
  const alongCuts = (moves: readonly ToolpathMove[]): ToolpathMove[] => moves.filter((move) =>
    move.kind === 'cut' && move.from.a === move.to.a && move.from.x !== move.to.x)
  const tips = new Set(alongCuts(clearing.moves)
    .map((move) => Math.round((move.to.z - pivot) * 1e6) / 1e6))
  const hasTip = (value: number): boolean => [...tips].some((tip) => Math.abs(tip - value) <= 0.02)
  for (const layer of [9, 8, 7, 6]) assert.ok(hasTip(layer), `along clear cuts layer ${layer}`)
  assert.ok(hasTip(5), 'the finish pass follows the model at the finish surface')
  const lowest = Math.min(...clearing.moves
    .filter((move) => move.kind !== 'rapid')
    .flatMap((move) => [move.from.z, move.to.z]))
  assert.ok(lowest >= pivot + 5 - TOLERANCE, 'along clear never cuts below the finish surface')
  // The entry plunges straight to the first clearing layer, one stepdown below
  // the bar, not to the finish surface.
  const entry = clearing.moves.find((move) => move.kind === 'plunge')
  assert.ok(entry, 'along clear has an entry plunge')
  approx(entry!.to.z - pivot, 9, 'the entry plunges to the first clearing layer')

  // A rough that already left the finish surface plus 0.4 mm (less than one
  // 1 mm stepdown) contributes no clearing: the finish motion is the finish
  // pass alone, which is exactly the pre-slice-R motion.
  const left: RotaryRoughLeft = {
    angles: [0, 90, 180, 270], along: [0, 20],
    tips: [[5.4, 5.4], [5.4, 5.4], [5.4, 5.4], [5.4, 5.4]],
    stepdown: 3, stockToLeave: 0, cutterRadius: 2, ball: false, passDirection: 'along',
  }
  const skipped = generateRotaryFinish('along-rough-left', cylinder, stock, FINISH_PASS_MM,
    { ...params, stepdown: 1, roughLeft: [left] }, {})
  assert.deepEqual(skipped.warnings, [], 'rough-left finish warns about nothing')
  const skippedLayers = new Set(alongCuts(skipped.moves)
    .map((move) => Math.round((move.to.z - pivot) * 1e6) / 1e6))
  assert.ok([...skippedLayers].length > 0, 'the rough-left finish still cuts')
  assert.ok([...skippedLayers].every((tip) => Math.abs(tip - 5) <= 0.02),
    'a rough within one stepdown emits no clearing layer above the finish surface')
  const finishSurface = (moves: readonly ToolpathMove[]): ToolpathMove[] =>
    alongCuts(moves).filter((move) => (move.from.a ?? 0) < 360
      && Math.abs(move.to.z - pivot - 5) <= 0.02)
  assert.deepEqual(finishSurface(skipped.moves), finishSurface(clearing.moves),
    'the finish pass itself is unchanged by the clearing layers above it')
  // Captured from the generator at 39cecfef (before slice R): a finish whose
  // earlier rough left the surface within one stepdown is byte-identical to the
  // pre-slice finish pass.
  assert.equal(createHash('sha256').update(JSON.stringify(skipped.moves)).digest('hex'),
    'd36dab1914ef17ea275c14ea1392bbcc4458dd650ff27dc8c8905c4584717ac9',
    'a rough that left less than one stepdown keeps the finish byte-identical')
}

// ---------------------------------------------------------------------------
// Slice I: a seeded property test against the exact model geometry.
//
// A hand-picked case missed something in every review pass, so this walks 30
// seeded random cases -- a round bar (each axis, diameter 20-60 mm), one to
// three disjoint boxes and coaxial / off-axis cylinders inside it (some flush
// with the bar's ends), random end supports including zero, and a 1-6 mm ball
// nose or flat end mill. Both generators run with coarse settings. For every
// cut, plunge and turning-link move the move is walked in steps of at most a
// tenth of the tool radius; at each step the real cutter (a disc of the tool
// radius at the tip for a flat end mill, the ball's lower hemisphere for a ball
// nose) is mapped back into the unturned bar's frame through the frozen rotary
// rotation and every cutter point is tested against the exact solids, computed
// directly from the boxes and cylinders -- not the height map.
//
// Tolerance: the target the generators compute comes from a height map of cell
// size `c` sampled at cell centres, from the polygonal facets of the cylinders
// (sagitta <= the 3D view's minimum render height) and, for a ball, from the
// between-sample interpolation (`s^2 / (8r)` for spacing `s` and ball radius
// `r`). Stock to leave is zero in every case, so a cutter point may sit at most
// `TOLERANCE` inside the model -- or inside the retained bar -- without being a
// real gouge. The cutter itself is sampled on a coarse ring set, which is
// reported with the measured worst penetration per check.
// ---------------------------------------------------------------------------

/** A solid in the unturned bar's own frame: `l` along the bar, `a` across from the centreline, `u` above it. */
type LocalSolid =
  | {
      readonly kind: 'box'
      readonly l0: number
      readonly l1: number
      readonly a0: number
      readonly a1: number
      readonly u0: number
      readonly u1: number
    }
  | {
      readonly kind: 'cylinder'
      readonly l0: number
      readonly l1: number
      readonly a0: number
      readonly u0: number
      readonly radius: number
    }

/**
 * How far a bar-frame point lies inside the union of `solids`, 0 outside. The
 * solids are generated disjoint, so the maximum over them is the union's own
 * depth; a point in a gap is outside all of them.
 */
function insideModel(solids: readonly LocalSolid[], l: number, a: number, u: number): number {
  let worst = 0
  for (const solid of solids) {
    if (l < solid.l0 || l > solid.l1) continue
    let depth: number
    if (solid.kind === 'box') {
      if (a < solid.a0 || a > solid.a1 || u < solid.u0 || u > solid.u1) continue
      depth = Math.min(l - solid.l0, solid.l1 - l, a - solid.a0, solid.a1 - a, u - solid.u0, solid.u1 - u)
    } else {
      const d = Math.hypot(a - solid.a0, u - solid.u0)
      if (d > solid.radius) continue
      depth = Math.min(l - solid.l0, solid.l1 - l, solid.radius - d)
    }
    if (depth > worst) worst = depth
  }
  return worst
}

/** Triangulate one solid into the bar's project frame, appending to `positions` / `index`. */
function appendSolid(stock: RoundStock, solid: LocalSolid, positions: number[], index: number[]): void {
  const centre = roundStockCentre(stock)
  const radius = stock.thickness / 2
  const vertex = (l: number, a: number, u: number): number => {
    if (stock.axis === 'x') positions.push(l, centre + a, radius + u)
    else positions.push(centre + a, l, radius + u)
    return positions.length / 3 - 1
  }
  if (solid.kind === 'box') {
    const v = [
      vertex(solid.l0, solid.a0, solid.u0), vertex(solid.l1, solid.a0, solid.u0),
      vertex(solid.l0, solid.a1, solid.u0), vertex(solid.l1, solid.a1, solid.u0),
      vertex(solid.l0, solid.a0, solid.u1), vertex(solid.l1, solid.a0, solid.u1),
      vertex(solid.l0, solid.a1, solid.u1), vertex(solid.l1, solid.a1, solid.u1),
    ]
    // Six quads, each two triangles; the winding does not matter to the height map.
    for (const [x, y, z] of [[0, 1, 3], [0, 3, 2], [4, 5, 7], [4, 7, 6], [0, 1, 5], [0, 5, 4],
      [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 3, 7], [1, 7, 5]]) {
      index.push(v[x], v[y], v[z])
    }
    return
  }
  const segments = 32
  const rings: number[] = []
  for (const l of [solid.l0, solid.l1]) {
    for (let i = 0; i < segments; i++) {
      const t = 2 * Math.PI * i / segments
      rings.push(vertex(l, solid.a0 + solid.radius * Math.cos(t), solid.u0 + solid.radius * Math.sin(t)))
    }
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments
    index.push(rings[i], rings[j], rings[segments + j], rings[i], rings[segments + j], rings[segments + i])
  }
  for (let i = 1; i < segments - 1; i++) {
    index.push(rings[0], rings[i + 1], rings[i])
    index.push(rings[segments], rings[segments + i], rings[segments + i + 1])
  }
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

{
  const prng = (() => {
    let state = 0x10150001 >>> 0
    return (): number => {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  })()
  const CASES = 30
  const startedAt = performance.now()
  const CLEARANCE = 1
  const FACET_SAG = 0.01
  let movesWalked = 0
  let stepsWalked = 0
  let rapidsWalked = 0
  let worstModel = 0
  let worstModelWhere = ''
  let worstRetained = 0
  let worstRetainedWhere = ''
  let worstCentreline = 0
  let worstCentrelineWhere = ''
  let worstRapid = 0
  let worstRapidWhere = ''
  // The tallest discretization slack any single case can legitimately show.
  let tolerance = 0

  for (let seedIndex = 0; seedIndex < CASES; seedIndex++) {
    const axis: 'x' | 'y' = prng() < 0.5 ? 'x' : 'y'
    const diameter = 20 + prng() * 40
    const length = 30 + prng() * 40
    const stock = roundStock(diameter, length, axis)
    const R = stock.thickness / 2
    const centre = roundStockCentre(stock)
    let modelMin = prng() * length * 0.3
    let modelMax = length - prng() * length * 0.3
    if (prng() < 0.35) modelMin = 0
    if (prng() < 0.35) modelMax = length
    if (modelMax - modelMin < 8) modelMax = Math.min(length, modelMin + 8)

    // One to three solids in a row, disjoint (a small along gap between them so
    // a cutter point is inside at most one and the union depth is exact).
    const pieceCount = 1 + Math.floor(prng() * 3)
    const partSpan = (modelMax - modelMin) / pieceCount
    const gap = Math.min(1, partSpan * 0.15)
    const solids: LocalSolid[] = []
    for (let piece = 0; piece < pieceCount; piece++) {
      const l0 = modelMin + piece * partSpan + (piece > 0 ? gap / 2 : 0)
      const l1 = modelMin + (piece + 1) * partSpan - (piece < pieceCount - 1 ? gap / 2 : 0)
      if (l1 - l0 < 0.5) continue
      if (prng() < 0.45) {
        const halfAcross = 0.06 * R + prng() * 0.3 * R
        const halfUp = 0.05 * R + prng() * 0.2 * R
        const maxCentreUp = Math.sqrt(Math.max(0, (0.88 * R) ** 2 - halfAcross * halfAcross)) - halfUp
        const centreUp = halfUp + 0.05 * R + prng() * Math.max(0, maxCentreUp - halfUp - 0.05 * R)
        const maxCentreAcross = Math.sqrt(Math.max(0, (0.88 * R) ** 2 - (centreUp + halfUp) ** 2)) - halfAcross
        const centreAcross = (prng() * 2 - 1) * Math.max(0, maxCentreAcross)
        solids.push({
          kind: 'box', l0, l1,
          a0: centreAcross - halfAcross, a1: centreAcross + halfAcross,
          u0: centreUp - halfUp, u1: centreUp + halfUp,
        })
      } else if (prng() < 0.5) {
        // Coaxial: it straddles the axis, but the cutter only ever meets its top.
        solids.push({ kind: 'cylinder', l0, l1, a0: 0, u0: 0, radius: 0.1 * R + prng() * 0.6 * R })
      } else {
        const cylinderRadius = 0.05 * R + prng() * 0.22 * R
        const maxDistance = 0.88 * R - cylinderRadius
        const centreUp = 0.15 * R + prng() * Math.max(0, maxDistance - 0.15 * R)
        const maxCentreAcross = Math.sqrt(Math.max(0, maxDistance * maxDistance - centreUp * centreUp))
        const centreAcross = (prng() * 2 - 1) * maxCentreAcross * 0.85
        solids.push({ kind: 'cylinder', l0, l1, a0: centreAcross, u0: centreUp, radius: cylinderRadius })
      }
    }
    if (solids.length === 0) solids.push({ kind: 'cylinder', l0: modelMin, l1: modelMax, a0: 0, u0: 0, radius: 0.5 * R })

    const toolRadius = 0.5 + prng() * 2.5
    const tool: NormalizedTool = {
      ...BALL,
      id: `property-${seedIndex}`,
      name: `${toolRadius * 2} mm property tool`,
      type: prng() < 0.5 ? 'ball_endmill' : 'flat_endmill',
      diameter: toolRadius * 2,
      radius: toolRadius,
    }
    const sampleSpacing = Math.max(0.5, tool.radius * 0.5)
    const requestedCellSize = Math.min(0.15, tool.radius / 3)
    // The height map's cell and the sample spacing set how far a correct target
    // can sit from the exact surface (plus the cylinder facets).
    const interpolation = tool.type === 'ball_endmill' ? sampleSpacing * sampleSpacing / (8 * tool.radius) : 0
    tolerance = Math.max(tolerance, requestedCellSize + FACET_SAG + interpolation)

    let supports = {
      chuckEnd: prng() < 0.4 ? 0 : prng() * R * 0.4,
      tailEnd: prng() < 0.4 ? 0 : prng() * R * 0.4,
    }
    let range = rotaryAlongRange(stock, [], { min: modelMin, max: modelMax }, tool, supports)
    if (!range) {
      supports = { chuckEnd: 0, tailEnd: 0 }
      range = rotaryAlongRange(stock, [], { min: modelMin, max: modelMax }, tool, supports)
    }
    assert.ok(range, `property ${seedIndex} leaves a cut range`)

    const positions: number[] = []
    const index: number[] = []
    for (const solid of solids) appendSolid(stock, solid, positions, index)
    const mesh: RotaryModelMesh = { positions: new Float32Array(positions), index: new Uint32Array(index) }
    const params = {
      stepover: R * (0.5 + prng() * 0.5),
      sampleSpacing,
      stepdown: R * (0.5 + prng() * 0.5),
      stockToLeave: 0,
      alongStart: range.start,
      alongEnd: range.end,
      safeRadius: R + 5,
      requestedCellSize,
    }
    const offsets = cutterOffsets(tool)
    const travelZ = 2 * R + CLEARANCE
    const safeZ = Math.max(R + params.safeRadius, travelZ)

    const walk = (moves: readonly ToolpathMove[], label: string): void => {
      if (moves.length === 0) return
      // The operation's first positioning move and its final retract are at the
      // rapid height; every rapid in between reaches at least the travel height.
      assert.equal(moves[0].kind, 'rapid', `property ${seedIndex} ${label} opens with a rapid`)
      assert.equal(moves[0].from.z, moves[0].to.z, `property ${seedIndex} ${label} positions before cutting`)
      approx(moves[0].to.z, safeZ, `property ${seedIndex} ${label} entry at the rapid height`, 1e-9)
      const last = moves[moves.length - 1]
      assert.equal(last.kind, 'rapid', `property ${seedIndex} ${label} ends with a rapid`)
      approx(last.to.z, safeZ, `property ${seedIndex} ${label} retract to the rapid height`, 1e-9)
      for (const move of moves) {
        const where = `seed ${seedIndex} ${label} ${move.kind} `
          + `(${move.from.x.toFixed(3)}, ${move.from.y.toFixed(3)}, ${move.from.z.toFixed(3)}) -> `
          + `(${move.to.x.toFixed(3)}, ${move.to.y.toFixed(3)}, ${move.to.z.toFixed(3)})`
        if (move.kind === 'rapid') {
          rapidsWalked++
          const high = Math.max(move.from.z, move.to.z)
          if (travelZ - high > worstRapid) {
            worstRapid = travelZ - high
            worstRapidWhere = where
          }
          if (move.from.x !== move.to.x || move.from.y !== move.to.y) {
            const low = Math.min(move.from.z, move.to.z)
            if (travelZ - low > worstRapid) {
              worstRapid = travelZ - low
              worstRapidWhere = where
            }
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
          if (R - pz > worstCentreline) {
            worstCentreline = R - pz
            worstCentrelineWhere = where
          }
          const t = (a0 + (a1 - a0) * f) * Math.PI / 180
          const cos = Math.cos(t)
          const sin = Math.sin(t)
          for (const offset of offsets) {
            const wx = px + offset[0]
            const wy = py + offset[1]
            const wz = pz + offset[2]
            const across = (axis === 'x' ? wy : wx) - centre
            const up = wz - R
            const l = axis === 'x' ? wx : wy
            const la = across * cos + up * sin
            const lu = -across * sin + up * cos
            const depth = insideModel(solids, l, la, lu)
            if (depth > worstModel) {
              worstModel = depth
              worstModelWhere = `${where} a=${(a0 + (a1 - a0) * f).toFixed(2)} local(${l.toFixed(3)}, ${la.toFixed(3)}, ${lu.toFixed(3)}) cutter +(${offset[0].toFixed(3)}, ${offset[1].toFixed(3)}, ${offset[2].toFixed(3)})`
            }
            // The retained bar is the full-radius bar outside the cut range:
            // entering it costs the least of the distance past its end face and
            // the depth below its curved surface.
            const radial = Math.hypot(la, lu)
            const retained = radial >= R ? 0
              : l < range.start ? Math.max(0, Math.min(range.start - l, l, R - radial))
                : l > range.end ? Math.max(0, Math.min(l - range.end, length - l, R - radial))
                  : 0
            if (retained > worstRetained) {
              worstRetained = retained
              worstRetainedWhere = `${where} a=${(a0 + (a1 - a0) * f).toFixed(2)} local(${l.toFixed(3)}, ${la.toFixed(3)}, ${lu.toFixed(3)}) cutter +(${offset[0].toFixed(3)}, ${offset[1].toFixed(3)}, ${offset[2].toFixed(3)})`
            }
          }
        }
      }
    }

    walk(generateRotaryFinish(`property-finish-${seedIndex}`, mesh, stock, tool, params, {}).moves, 'finish')
    walk(generateRotaryRough(`property-rough-${seedIndex}`, mesh, stock, tool, params, {}).moves, 'rough')
  }

  console.log(`rotary property: ${CASES} cases, ${movesWalked} cut/plunge/link moves in ${stepsWalked} steps, `
    + `${rapidsWalked} rapids`)
  assert.ok(movesWalked > 0, 'the property cases cut real moves')
  assert.ok(worstModel <= tolerance, `no case cuts into the model by more than the tolerance `
    + `(${worstModel.toFixed(4)} <= ${tolerance.toFixed(4)}): ${worstModelWhere}`)
  assert.ok(worstRetained <= tolerance, `no case cuts into the retained bar by more than the tolerance `
    + `(${worstRetained.toFixed(4)} <= ${tolerance.toFixed(4)}): ${worstRetainedWhere}`)
  assert.ok(worstCentreline <= 1e-6, `no cut, plunge or link goes below the centreline `
    + `(${worstCentreline.toExponential(2)}): ${worstCentrelineWhere}`)
  assert.ok(worstRapid <= 1e-6, `every rapid reaches the travel height `
    + `(${worstRapid.toExponential(2)}): ${worstRapidWhere}`)
  console.log(`rotary property worst: model ${worstModel.toFixed(4)} mm, retained bar ${worstRetained.toFixed(4)} mm, `
    + `below centreline ${worstCentreline.toExponential(2)} mm, rapid ${worstRapid.toExponential(2)} mm, `
    + `tolerance ${tolerance.toFixed(4)} mm, ${((performance.now() - startedAt) / 1000).toFixed(1)} s`)
}
// ---------------------------------------------------------------------------
// Slice L: the strip-culled sampler against the full-map reference.
//
// `sampleRotaryModel` now rasterises only the rows (X bar) or columns (Y bar)
// the samples read, and only the triangles whose cross-section arc can reach
// them. The reference below is the sampler this replaced -- turn every vertex,
// build the whole height map, read the same tool tip -- and the two must agree
// bit for bit rather than within a tolerance: keeping the grid and the
// per-cell arithmetic identical is the whole point, so a moved bound or a
// dropped triangle shows up as a different Float32, not a slightly different
// number. The meshes are deliberately asymmetric and loaded with the cull's
// hard cases: triangles crossing the axis, long thin triangles spanning nearly
// half a turn, and a fine radial rake whose triangles sit just inside and just
// outside the strip at many directions.
// ---------------------------------------------------------------------------

/** The sampler slice L replaced: full turn, full height map, same tip read. */
function referenceSample(
  mesh: RotaryModelMesh,
  stock: RoundStock,
  tool: NormalizedTool,
  anglesDeg: readonly number[],
  along: readonly number[],
  requestedCellSize: number,
): Float32Array[] {
  const radius = stock.thickness / 2
  const centre = roundStockCentre(stock)
  const rows: Float32Array[] = []
  for (const angle of anglesDeg) {
    const turned = turnedModelPositions(mesh.positions, stock, angle)
    const bbox = computeXYBounds(turned)
    const cellSize = chooseHeightMapCellSize(bbox, requestedCellSize, [])
    const heightMap = buildHeightMap(turned, mesh.index, bbox, cellSize)
    const row = new Float32Array(along.length)
    for (let i = 0; i < along.length; i++) {
      const x = stock.axis === 'x' ? along[i] : centre
      const y = stock.axis === 'x' ? centre : along[i]
      const z = safeToolTipZAt(x, y, heightMap, tool)
      row[i] = z === Number.NEGATIVE_INFINITY ? NaN : z - radius
    }
    rows.push(row)
  }
  return rows
}

/** Bit-for-bit tip comparison, where two `NaN`s are equal. */
function sameTip(actual: Float32Array, expected: Float32Array, label: string): void {
  assert.equal(actual.length, expected.length, `${label}: row length`)
  for (let i = 0; i < actual.length; i++) {
    if (Number.isNaN(actual[i]) || Number.isNaN(expected[i])) {
      assert.ok(Number.isNaN(actual[i]) && Number.isNaN(expected[i]),
        `${label}[${i}]: NaN mismatch (${actual[i]} vs ${expected[i]})`)
      continue
    }
    assert.ok(Object.is(actual[i], expected[i]), `${label}[${i}]: ${actual[i]} vs ${expected[i]}`)
  }
}

/**
 * Asymmetric seeded triangles for the strip test. Random vertices anywhere in a
 * disc wider than the bar make triangles that cross the axis and land at every
 * distance from it; the deliberate cases add a long thin triangle through the
 * axis at many directions, thin triangles whose vertices span nearly half a
 * turn, and a fine radial rake so triangles sit just inside and just outside
 * the strip at sixteen directions.
 */
function stripTestMesh(stock: RoundStock, seed: number): RotaryModelMesh {
  const centre = roundStockCentre(stock)
  const radius = stock.thickness / 2
  const length = roundStockLength(stock)
  const positions: number[] = []
  const index: number[] = []
  const vertex = (along: number, across: number, up: number): number => {
    if (stock.axis === 'x') positions.push(along, centre + across, radius + up)
    else positions.push(centre + across, along, radius + up)
    return positions.length / 3 - 1
  }
  const triangle = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
  ): void => {
    index.push(vertex(a[0], a[1], a[2]), vertex(b[0], b[1], b[2]), vertex(c[0], c[1], c[2]))
  }
  let state = seed >>> 0
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const alongMin = 4
  const alongMax = length - 4
  const along = (): number => alongMin + random() * (alongMax - alongMin)
  // Every triangle is compact along the bar: the height map's cost is the area
  // of a triangle's cell bounding box, and a triangle whose vertices span the
  // whole bar would cost more to rasterise than the whole rest of the fixture.
  const near = (l: number): number => l + (random() - 0.5) * 0.6

  for (let t = 0; t < 900; t++) {
    const l = along()
    const tri: Array<[number, number, number]> = []
    for (let v = 0; v < 3; v++) {
      const r = radius * 1.2 * Math.sqrt(random())
      const a = random() * 2 * Math.PI
      tri.push([near(l), r * Math.cos(a), r * Math.sin(a)])
    }
    triangle(tri[0], tri[1], tri[2])
  }
  // Long thin triangles through the axis, at many directions.
  for (let k = 0; k < 24; k++) {
    const a = ((k * 15 + 7) * Math.PI) / 180
    const l = along()
    triangle(
      [l, -radius * 1.05 * Math.cos(a), -radius * 1.05 * Math.sin(a)],
      [l, radius * 1.05 * Math.cos(a), radius * 1.05 * Math.sin(a)],
      [l, 0.4 * Math.cos(a + Math.PI / 2), 0.4 * Math.sin(a + Math.PI / 2)],
    )
  }
  // Thin triangles whose directions span nearly half a turn.
  for (let k = 0; k < 12; k++) {
    const a = ((k * 29 + 3) * Math.PI) / 180
    const l = along()
    triangle(
      [l, 0.3 * Math.cos(a), 0.3 * Math.sin(a)],
      [l, 0.3 * Math.cos(a + 2.6), 0.3 * Math.sin(a + 2.6)],
      [l, radius * 0.9 * Math.cos(a + 1.3), radius * 0.9 * Math.sin(a + 1.3)],
    )
  }
  // Radial rake through the strip's half-width, sixteen directions.
  for (let k = 0; k < 16; k++) {
    const a = ((k * 22.5 + 5) * Math.PI) / 180
    const l = along()
    for (let i = 0; i < 120; i++) {
      const r = 0.01 + i * 0.03
      triangle(
        [l, (r - 0.02) * Math.cos(a), (r - 0.02) * Math.sin(a)],
        [l, (r + 0.02) * Math.cos(a + 0.004), (r + 0.02) * Math.sin(a + 0.004)],
        [l, r * Math.cos(a - 0.004), r * Math.sin(a - 0.004)],
      )
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

{
  const CELLS = [0.05, 0.2]
  const TOOLS: NormalizedTool[] = [
    BALL,
    { ...BALL, id: 'flat-strip', name: '3 mm flat', type: 'flat_endmill' },
    { ...BALL, id: 'ball-strip-6', name: '6 mm ball', diameter: 6, radius: 3 },
  ]
  // Dense enough that many angles put a rake triangle exactly at the strip edge,
  // and offset so no angle lines up with the rake's own directions.
  const angles = Array.from({ length: 160 }, (_, k) => -90 + k * 1.5 + 0.31)
  let compared = 0
  for (const axis of ['x', 'y'] as const) {
    for (const [diameter, length] of [[40, 60], [14, 36]] as const) {
      const stock = roundStock(diameter, length, axis, axis === 'x' ? { x: -3, y: 5 } : { x: 5, y: -3 })
      const mesh = stripTestMesh(stock, 0x5eed + (axis === 'x' ? 1 : 2) * 977 + diameter)
      const along = [6, length / 2, length - 6, length / 2 + 0.013]
      for (const cell of CELLS) {
        for (const tool of TOOLS) {
          const label = `${axis} D${diameter} ${tool.id} cell ${cell}`
          const reference = referenceSample(mesh, stock, tool, angles, along, cell)
          const sampled = sampleRotaryModel(mesh, stock, tool, { anglesDeg: angles, along, requestedCellSize: cell }, [])
          assert.deepEqual(sampled.anglesDeg, angles, `${label}: angles`)
          for (let k = 0; k < angles.length; k++) {
            sameTip(sampled.tipRadius[k], reference[k], `${label} angle ${angles[k].toFixed(2)}`)
            compared += along.length
          }
        }
      }
    }
  }
  assert.ok(compared > 0, 'the strip test compared real samples')
  console.log(`rotary strip: ${compared} tips bit-identical to the full-map reference`)
}
// ── invalid radial allowance refuses, on a round bar too ──────
//
// The same destructive path exists on a round bar: a negative or non-finite
// allowance destroys the sampler's radius, every sample reads "no model", and
// the rough maps that to radius 0 (the pivot). Round output for a valid
// allowance is unchanged; only an unusable one refuses.
{
  const stock = roundStock(40, 60, 'x')
  const mesh = prism(stock, CIRCLE)
  const params = { ...FINISH_BASE, stepover: 20, stepdown: 4 }
  const valid = generateRotaryRough('round-valid', mesh, stock, FINISH_PASS_MM, params, {})
  assert.ok(valid.moves.length > 0, 'a valid round allowance generates motion')
  assert.deepEqual(valid.warnings, [], 'a valid round allowance raises no warning')
  const validLeave = generateRotaryFinish('round-valid-leave', mesh, stock, FINISH_PASS_MM, { ...params, stockToLeave: 0.5 }, {})
  assert.ok(validLeave.moves.length > 0, 'a valid positive round allowance still generates')

  // -2 gives a zero sampling radius on this 2 mm radius ball, -3 a negative one; both
  // also fail the non-negative allowance rule. NaN and Infinity fail finiteness.
  for (const allow of [-2, -3, NaN, Infinity]) {
    for (const generate of [generateRotaryRough, generateRotaryFinish]) {
      const result = generate(`round-invalid-${String(allow)}`, mesh, stock, FINISH_PASS_MM, { ...params, stockToLeave: allow }, {})
      assert.deepEqual(result.moves, [], `round allowance ${String(allow)}: ${generate.name} emits no moves`)
      assert.deepEqual(result.warnings.map((warning) => warning.code), ['rotaryStockToLeaveInvalid'],
        `round allowance ${String(allow)}: ${generate.name} says why`)
      assert.equal(result.bounds, null, `round allowance ${String(allow)}: ${generate.name} has no bounds`)
    }
  }
  // The sampler distinguishes invalid geometry from empty space: no angle rows
  // at all and `valid: false`, rather than rows of NaN that the rough would map
  // to a cut down the axis.
  const invalidSampling = sampleRotaryModel(mesh, stock, { ...FINISH_PASS_MM, radius: -1, diameter: -4 }, {
    anglesDeg: [0, 90], along: [FINISH_BASE.alongStart, FINISH_BASE.alongEnd], requestedCellSize: CELL,
  }, [])
  assert.equal(invalidSampling.valid, false, 'the round sampler reports invalid tool geometry')
  assert.deepEqual(invalidSampling.anglesDeg, [], 'invalid round geometry produced no angle rows')
  assert.deepEqual(invalidSampling.tipRadius, [], 'invalid round geometry cannot look like empty space')
}
console.log('engine/toolpaths/rotaryModel.test.ts: slice I property assertions passed')
