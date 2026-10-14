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
import { roundStock, roundStockCentre } from '../../types/project'
import type { Clamp, RoundStock } from '../../types/project'
import { aroundFrame, unwrapToolpath, wrapPoint } from '../aroundFrame'
import { deserializeImportedMesh } from '../importedMesh'
import { toolSpacePoint } from '../rotaryFrame'
import { computeXYBounds } from './finishSurfaceParallel'
import { generateRotaryFinish, generateRotaryRough, rotaryAlongRange, sampleRotaryModel, turnedModelPositions } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import type { NormalizedTool, ToolpathPoint } from './types'
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
        // The link's own rise or drop at the shared end: one end is the pass's
        // own end tip, the other the turn height.
        const j = waveIndexAt(along(move.from))
        const tip = FINISH_RADIUS + waveSampling.tipRadius[0][j]
        const heights = [move.from.z, move.to.z]
        assert.ok(heights.includes(FINISH_LINK_Z), `${axis} wave link rise/drop reaches the turn height`)
        assert.ok(heights.some((height) => Math.abs(height - tip) <= TOLERANCE), `${axis} wave link rise/drop starts at the pass tip`)
        waveChecks++
        continue
      }
      const pass = Math.round(fromAngle / (360 / wavePasses))
      for (const end of ['from', 'to'] as const) {
        const j = waveIndexAt(along(move[end]))
        // The forward pass's sample at this along position; the axisymmetric
        // model makes it the right height on every pass.
        approx(move[end].z, FINISH_RADIUS + waveSampling.tipRadius[0][j], `${axis} wave pass ${pass} height at along ${waveAlong[j]}`)
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
  // Between runs the tool is at safeRadius (retract + traverse) or plunging.
  for (const move of result.moves) {
    if (move.kind === 'rapid') assert.equal(move.to.z, safeZ, 'off-axis rapid reaches safeRadius')
    if (move.kind === 'plunge') assert.equal(move.from.z, safeZ, 'off-axis plunge starts at safeRadius')
  }
  const rapids = result.moves.filter((move) => move.kind === 'rapid')
  for (const move of rapids) {
    // A retract may start at the cut, but any rapid that travels is at
    // safeRadius for its whole length: never across standing material.
    if (move.from.x !== move.to.x || move.from.y !== move.to.y) {
      assert.equal(move.from.z, safeZ, 'off-axis traverse starts at safeRadius')
    }
  }
  const traverses = rapids.filter((move) => move.from.z === safeZ && move.from.x !== move.to.x)
  assert.ok(traverses.length >= 1, 'the gap between the two model pieces forces a safe traverse')
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
    let checked = 0
    let skipped = 0
    let links = 0
    for (let m = 0; m < result.moves.length; m++) {
      const move = result.moves[m]
      if (m) assert.deepEqual(move.from, result.moves[m - 1].to, `${axis} rough moves connected`)
      assert.ok(move.to.a! >= move.from.a!, `${axis} rough angles never reset across layers`)
      if (move.kind === 'rapid') {
        assert.equal(move.to.z, 20 + params.safeRadius, `${axis} every rapid reaches safe radius`)
        if (position(move.from) !== position(move.to) || move.from.a !== move.to.a) {
          assert.equal(move.from.z, 20 + params.safeRadius, `${axis} traverse starts at safe radius`)
        }
        continue
      }
      if (move.kind === 'plunge') assert.equal(move.from.z, 20 + params.safeRadius, `${axis} run plunge starts safe`)
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
  let traverses = 0
  for (let i = 0; i < split.moves.length; i++) {
    const move = split.moves[i]
    if (i) assert.deepEqual(move.from, split.moves[i - 1].to, `${axis} split runs stay connected`)
    if (move.kind === 'rapid') {
      assert.equal(move.to.z, 20 + params.safeRadius, `${axis} between runs rapid reaches safeRadius`)
      if (position(move.from) !== position(move.to) || move.from.a !== move.to.a) {
        assert.equal(move.from.z, 20 + params.safeRadius, `${axis} no traverse inside standing material`)
        traverses++
      }
    }
    if (move.kind === 'plunge') assert.equal(move.from.z, 20 + params.safeRadius, `${axis} split run entry plunges from safeRadius`)
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
}
console.log('engine/toolpaths/rotaryModel.test.ts: slice C assertions passed')

{
  // Hashes every move kind and endpoint of the fixture, including point order
  // and exact numeric values. The count and hash moved from slice B's
  // (7411 / 6f841fac...) with the slice-F review fix (the fixture's ends leave
  // the line over the centreline through `NaN` samples, which the finish must
  // not cut down to the axis), and again with slice G's review fixes: the
  // turning link now turns at the bar's surface plus a clearance instead of the
  // higher end tip, and Douglas--Peucker keeps every point a chord would drop
  // more than 1 um away. The goal is unchanged -- any later change to the
  // generator's geometry shows up as a diff here rather than only in a move
  // count -- but this is the fixed output.
  const result = generateRotaryFinish('op-fixture', fixture, STOCK, BALL, {
    stepover: 0.5, sampleSpacing: 0.2, stockToLeave: 0, alongStart: 0, alongEnd: 150,
    safeRadius: 21.6, requestedCellSize: fixtureCell,
  }, {})
  assert.equal(result.moves.length, 7296, 'finish fixture keeps its move count')
  assert.equal(createHash('sha256').update(JSON.stringify(result.moves)).digest('hex'),
    'fa7ee977eb20508b33cb1f222e66385503590dccfa4b12582a41f6c60f767fc1', 'finish fixture keeps its exact points')
}
