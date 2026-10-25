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
 * Height-map thin features (issue #1050).
 *
 * The raster samples each cell at its centre, so before #1050 a triangle that
 * contained no centre added nothing and a feature narrower than a cell was
 * invisible: a 0.02 mm fin or a 1 mm tube on a 1 mm grid was cut straight
 * through. A triangle that covers no centre now raises every cell it overlaps
 * to the highest point of the triangle inside that cell. These tests pin both
 * kernels (the flat raster and the fused rotary one), the clipped maximum and
 * its cellRise semantics, and the field reproductions.
 *
 * Run with: npx tsx src/engine/toolpaths/thinFeatureHeightMap.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, newProject, rectProfile, type Operation, type Project, type SketchFeature, type Tool } from '../../types/project'
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { projectWithFeatures } from '../../test/projectFixtures'
import { generateFinishSurfaceToolpath } from './finishSurface'
import { buildHeightMap } from './finishSurfaceParallel'
import { generateRotaryFinish, generateRotaryRough } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import type { NormalizedTool } from './types'
import { buildRotaryHeightMap } from './rotaryRaster'

const BALL_2: NormalizedTool = {
  id: 'ball-2', name: '2 mm ball', sourceUnits: 'mm', units: 'mm', type: 'ball_endmill',
  diameter: 2, radius: 1, vBitAngle: null, flutes: 2, material: 'carbide',
  defaultRpm: 0, defaultFeed: 0, defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}

/** A flat mesh: two triangles of a thin horizontal strip at `z`. */
function thinStrip(
  x0: number, x1: number, y0: number, y1: number, z: number,
): { positions: Float32Array; index: Uint32Array } {
  return {
    positions: new Float32Array([
      x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z,
    ]),
    index: new Uint32Array([0, 1, 2, 0, 2, 3]),
  }
}

/** Count the cells whose value is finite and at least `z`. */
function cellsAtLeast(data: Float32Array, z: number): number {
  let count = 0
  for (const value of data) if (value >= z - 1e-6) count += 1
  return count
}

function testThinFinRaisesItsCells(): void {
  console.log('Testing a thin fin that covers no cell centre...')
  // 0.02 mm wide at x 0.46-0.48, 0.1 mm cells: no cell centre falls inside it.
  const strip = thinStrip(0.46, 0.48, 0.25, 0.75, 10)
  const map = buildHeightMap(strip.positions, strip.index, { minX: 0, maxX: 1, minY: 0, maxY: 1 }, 0.1)
  const lifted = cellsAtLeast(map.data, 10)
  assert(lifted > 0, 'a thin fin that covers no cell centre must raise the cells it overlaps')
  // The fin crosses six 0.1 mm rows in its one 0.1 mm column.
  assert.equal(lifted, 6, `the fin raises exactly the six cells it passes through (got ${lifted})`)
  for (let i = 0; i < map.data.length; i++) {
    const row = Math.floor(i / map.width), col = i % map.width
    const expected = col === 4 && row >= 2 && row <= 7 ? 10 : Number.NEGATIVE_INFINITY
    assert.equal(map.data[i], expected, `cell ${col},${row} is ${expected}`)
  }
  // The rotary kernel must produce the exact same map for the same geometry.
  const centre = 0.5, pivot = 0
  const along = new Float32Array([0.46, 0.48, 0.48])
  const across = new Float64Array([-0.25, -0.25, 0.25])
  const up = new Float64Array([10, 10, 10])
  const rotary = buildRotaryHeightMap({
    axis: 'x', centre, pivot, cos: 1, sin: 0,
    geometry: { section: interleave(across, up), along },
  }, { minX: 0, maxX: 1, minY: 0, maxY: 1 }, 0.1)
  assert.deepEqual(rotary, map, 'the fused rotary kernel matches the flat raster for a thin fin')
  console.log('thin fin: every overlapped cell lifted, both kernels agree')
}

/** `(across, up)` pairs into the kernel's `a0, u0, a1, u1, ...` layout. */
function interleave(across: Float64Array, up: Float64Array): Float64Array {
  const out = new Float64Array(across.length * 2)
  for (let i = 0; i < across.length; i++) {
    out[i * 2] = across[i]
    out[i * 2 + 1] = up[i]
  }
  return out
}

function testSliverUsesTheClippedMax(): void {
  console.log('Testing a smooth sliver is clipped to each cell...')
  // A long, thin triangle on the plane z = x (slope 1). It misses every cell
  // centre (row 0's centres sit at y = 0.5, the sliver at y 0.25-0.26).
  const positions = new Float32Array([
    0, 0.25, 0,
    4, 0.25, 4,
    0, 0.26, 0,
  ])
  const index = new Uint32Array([0, 1, 2])
  const map = buildHeightMap(positions, index, { minX: 0, maxX: 4, minY: 0, maxY: 1 }, 1, { trackCellRise: true })
  // Each x cell's true maximum is at its right edge: 1, 2, 3 and 4.
  const expected = [1, 2, 3, 4]
  for (let col = 0; col < 4; col++) {
    assert.ok(Math.abs(map.data[col] - expected[col]) < 1e-6,
      `cell ${col} is the clipped maximum ${expected[col]}, not the triangle's global maximum 4 (got ${map.data[col]})`)
  }
  // The mutation that uses the triangle's global maximum raises every cell to
  // 4; on a neat row that is three cells too high. Bound it to one cell of
  // slope, which is the most the clip can add.
  for (let col = 0; col < 4; col++) {
    assert.ok(map.data[col] - expected[col] <= 1 + 1e-9,
      `cell ${col} is over-raised by at most one cell of the plane's slope`)
  }
  // A no-centre triangle's clipped maximum is exact inside the cell, so it
  // needs no rise allowance and must not inflate `cellRise` (the one scalar the
  // around sampler adds to every sample). A centre-sampled triangle would
  // contribute its half-cell rise here.
  assert.equal(map.cellRise, 0,
    'a clipped no-centre triangle adds no cellRise; its value is already exact')
  console.log('sliver: clipped maximum, no global-max over-raise, cellRise kept')
}

/** A closed rectangular bar with a thin fin standing on top of it. */
function finModel(stock: ReturnType<typeof squareStock>, alongTo: number): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  const box = (x0: number, x1: number, a0: number, a1: number, u0: number, u1: number): void => {
    const base = positions.length / 3
    const corners: Array<[number, number, number]> = [
      [x0, a0, u0], [x1, a0, u0], [x1, a1, u0], [x0, a1, u0],
      [x0, a0, u1], [x1, a0, u1], [x1, a1, u1], [x0, a1, u1],
    ]
    for (const [x, a, u] of corners) positions.push(x, centre + a, pivot + u)
    const faces = [
      [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
      [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
    ]
    for (const [a, b, c] of faces) index.push(base + a, base + b, base + c)
  }
  // The base ends at up 0; the fin rises 10 mm from it, and is 0.02 mm wide.
  box(0, alongTo, -5, 5, -5, 0)
  box(0, alongTo, -0.01, 0.01, 0, 10)
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

function testRotaryAroundFinishSeesTheFin(): void {
  console.log('Testing the rotary around finish on a 0.02 mm fin...')
  const stock = squareStock(30, 20, 'x')
  const pivot = barPivotZ(stock)
  const mesh = finModel(stock, 20)
  const result = generateRotaryFinish('fin', mesh, stock, BALL_2, {
    stepover: 0.5, sampleSpacing: 0.5, stockToLeave: 0,
    alongStart: 0, alongEnd: 20, safeRadius: barMaxRadius(stock) + 2,
    requestedCellSize: 0.1, passDirection: 'around',
  }, {})
  assert.deepEqual(result.warnings, [], 'the fin finish raises no warning')
  // At A = 0 the fin stands straight up on the sample line; the required tip is
  // its 10 mm top. Before #1050 the height map saw only the base and the ring
  // descended to 5 (the independent required tip was 10).
  let seen = 0
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    const fromAngle = ((move.from.a ?? 0) % 360 + 360) % 360
    const toAngle = ((move.to.a ?? 0) % 360 + 360) % 360
    if (fromAngle > 1e-6 && fromAngle < 360 - 1e-6) continue
    if (toAngle > 1e-6 && toAngle < 360 - 1e-6) continue
    for (const point of [move.from, move.to]) {
      if (point.x < 2 || point.x > 18) continue
      seen += 1
      assert.ok(point.z - pivot >= 10 - 1e-6,
        `the A0 ring clears the 10 mm fin at x ${point.x.toFixed(3)} (tip ${(point.z - pivot).toFixed(4)})`)
    }
  }
  assert.ok(seen > 0, 'the A0 ring has cuts over the fin')
  console.log(`rotary around fin: ${seen} A0 cut points at or above the fin top`)
}

function testTinyBlankRoughDoesNotCutIntoTheTube(): void {
  console.log('Testing the #1095 tiny blank rough...')
  const stock = squareStock(3, 6, 'x')
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  // The reproduction's 1 mm diameter tube, radius 0.5, along 0.6-5.4.
  const segments = 96
  const positions: number[] = []
  const index: number[] = []
  for (const along of [0.6, 5.4]) {
    for (let i = 0; i < segments; i++) {
      const angle = (2 * Math.PI * i) / segments
      positions.push(along, centre + 0.5 * Math.cos(angle), pivot + 0.5 * Math.sin(angle))
    }
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments
    index.push(i, j, segments + j, i, segments + j, segments + i)
  }
  const mesh: RotaryModelMesh = { positions: new Float32Array(positions), index: new Uint32Array(index) }
  const stockToLeave = 0.5
  const samplingRadius = BALL_2.radius + stockToLeave
  const cellSize = 1
  const params = {
    stepover: 1, stepdown: 0.5, sampleSpacing: 0.5,
    alongStart: 0.6, alongEnd: 5.4, safeRadius: barMaxRadius(stock) * 2,
    requestedCellSize: cellSize, stockToLeave,
  } as const
  const minTip = (moves: ReturnType<typeof generateRotaryRough>['moves']): number => {
    let min = Number.POSITIVE_INFINITY
    for (const move of moves) {
      if (move.kind !== 'cut') continue
      min = Math.min(min, move.from.z - pivot, move.to.z - pivot)
    }
    return min
  }
  const along = generateRotaryRough('tiny-along', mesh, stock, BALL_2, { ...params, passDirection: 'along' }, {})
  const alongMin = minTip(along.moves)
  // Before #1050 the map missed the tube and the rough descended to 0.3685,
  // 0.13 mm into the model. The map now records the tube's full height.
  assert.ok(alongMin >= 0.5 - 1e-6,
    `the along rough does not cut into the tube (tip ${alongMin.toFixed(4)} >= 0.5)`)
  // The along sampler reads the cell as a point at its centre. On a cell that
  // is one whole ball radius wide, a sample at the cell corner is at most
  // `R - sqrt(R^2 - cell^2/2)` below the cell's height. Bound the remaining gap
  // to model + stock by exactly that, rather than pretending it is zero.
  const pointSampleAllowance = samplingRadius - Math.sqrt(samplingRadius * samplingRadius - cellSize * cellSize / 2)
  const required = 0.5 + stockToLeave
  assert.ok(alongMin >= required - pointSampleAllowance - 1e-6,
    `the along rough stays within the sampler's point-sample allowance of model + stock `
    + `(${alongMin.toFixed(4)} >= ${(required - pointSampleAllowance).toFixed(4)})`)
  // Around mode pads the cell by half its diagonal and adds the rise, so it
  // meets model + stock with no such allowance.
  const around = generateRotaryRough('tiny-around', mesh, stock, BALL_2, { ...params, passDirection: 'around' }, {})
  const aroundMin = minTip(around.moves)
  assert.ok(aroundMin >= required - 1e-6,
    `the around rough leaves model + stock to leave (tip ${aroundMin.toFixed(4)} >= ${required.toFixed(4)})`)
  console.log(`tiny blank: along ${alongMin.toFixed(4)}, around ${aroundMin.toFixed(4)}, required ${required}`)
}

/** An ASCII STL of a 20 x 10 base plate with a 0.02 mm wide, 10 mm high fin. */
function finStlDataUrl(): string {
  const lines: string[] = ['solid fin']
  const triangle = (a: readonly number[], b: readonly number[], c: readonly number[]): void => {
    lines.push('  facet normal 0 0 0', '    outer loop')
    for (const point of [a, b, c]) lines.push(`      vertex ${point.join(' ')}`)
    lines.push('    endloop', '  endfacet')
  }
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void => {
    const v: Record<string, [number, number, number]> = {
      b0: [x0, y0, z0], b1: [x1, y0, z0], b2: [x1, y1, z0], b3: [x0, y1, z0],
      t0: [x0, y0, z1], t1: [x1, y0, z1], t2: [x1, y1, z1], t3: [x0, y1, z1],
    }
    const faces: Array<[keyof typeof v, keyof typeof v, keyof typeof v]> = [
      ['b0', 'b2', 'b1'], ['b0', 'b3', 'b2'], ['t0', 't1', 't2'], ['t0', 't2', 't3'],
      ['b0', 'b1', 't1'], ['b0', 't1', 't0'], ['b1', 'b2', 't2'], ['b1', 't2', 't1'],
      ['b2', 'b3', 't3'], ['b2', 't3', 't2'], ['b3', 'b0', 't0'], ['b3', 't0', 't3'],
    ]
    for (const [a, b, c] of faces) triangle(v[a], v[b], v[c])
  }
  box(0, 20, 0, 10, 0, 1)
  box(9.99, 10.01, 0, 10, 1, 10)
  lines.push('endsolid fin')
  return `data:model/stl;base64,${btoa(`${lines.join('\n')}\n`)}`
}

function finishFinProject(): { project: Project; operation: Operation } {
  const tool: Tool = {
    ...defaultTool('mm', 1),
    id: 'tool1', name: '2 mm ball endmill', type: 'ball_endmill',
    diameter: 2, defaultStepdown: 1, defaultStepover: 1, maxCutDepth: 10,
  }
  const feature: SketchFeature = {
    id: 'model1', name: 'Fin', kind: 'stl',
    stl: {
      format: 'stl', fileData: finStlDataUrl(), scale: 1, axisSwap: 'none',
      silhouettePaths: [[
        { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 },
      ]],
    },
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 20, 10), origin: { x: 0, y: 0 },
      orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation: 'model', z_top: 10, z_bottom: 0, visible: true, locked: false,
  }
  const project = projectWithFeatures({ ...newProject('fin', 'mm'), tools: [tool] }, [feature])
  const operation: Operation = {
    id: 'finish1', name: 'Finish', kind: 'finish_surface', pass: 'finish',
    enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'features', featureIds: ['model1'] }, toolRef: 'tool1',
    stepdown: 1, stepover: 1, feed: 800, plungeFeed: 300, rpm: 18000,
    pocketPattern: 'parallel', pocketAngle: 0,
    stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: true, finishFloor: true, carveDepth: 1, maxCarveDepth: 1,
    cutDirection: 'conventional', machiningOrder: 'feature_first',
  }
  return { project, operation }
}

function testFlatParallelFinishSeesTheFin(): void {
  console.log('Testing the flat parallel finish on the same 0.02 mm fin...')
  const { project, operation } = finishFinProject()
  const result = generateFinishSurfaceToolpath(project, operation)
  let seen = 0
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    for (const point of [move.from, move.to]) {
      // The fin's whole width plus the raster cell: nothing cut here may be
      // below its 10 mm top.
      if (Math.abs(point.x - 10) > 0.02) continue
      seen += 1
      assert.ok(point.z >= 10 - 1e-6,
        `the parallel finish clears the 10 mm fin at (${point.x.toFixed(3)}, ${point.y.toFixed(3)}) `
        + `(cut z ${point.z.toFixed(4)})`)
    }
  }
  assert.ok(seen > 0, 'the parallel finish has cuts over the fin')
  console.log(`flat parallel fin: ${seen} cuts at or above the fin top`)
}

testThinFinRaisesItsCells()
testSliverUsesTheClippedMax()
testRotaryAroundFinishSeesTheFin()
testTinyBlankRoughDoesNotCutIntoTheTube()
testFlatParallelFinishSeesTheFin()
console.log('thin feature height map: all reproductions passed')
