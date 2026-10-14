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
import { deserializeImportedMesh } from '../importedMesh'
import { toolSpacePoint } from '../rotaryFrame'
import { computeXYBounds } from './finishSurfaceParallel'
import { sampleRotaryModel, turnedModelPositions } from './rotaryModel'
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
console.log('engine/toolpaths/rotaryModel.test.ts: all assertions passed')
