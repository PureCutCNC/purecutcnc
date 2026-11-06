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
import { roundStock } from '../../types/project'
import { barCentre, barPivotZ } from '../../types/barStock'
import { buildHeightMap, computeXYBounds, safeToolTipZAt } from './finishSurfaceParallel'
import type { HeightMap, HeightMapBuildOptions, HeightMapWindow } from './finishSurfaceParallel'
import { sampleRotaryModel, turnedModelPositions } from './rotaryModel'
import { buildRotaryHeightMap, buildRotaryRasterGeometry } from './rotaryRaster'
import type { RotaryRasterGeometry } from './rotaryRaster'
import type { NormalizedTool } from './types'

const tool: NormalizedTool = {
  id: 'ball', name: 'ball', sourceUnits: 'mm', units: 'mm', type: 'ball_endmill',
  diameter: 3, radius: 1.5, vBitAngle: null, flutes: 2, material: 'carbide',
  defaultRpm: 0, defaultFeed: 0, defaultPlungeFeed: 0, defaultStepdown: 1,
  defaultStepover: 0.5, maxCutDepth: 0,
}

/**
 * A mesh whose triangles deliberately do not line up with the raster's cell
 * lattice: most of them are far smaller than a cell, some start exactly on a
 * grid line (the `floor` boundary), some are degenerate, and one spans the whole
 * map. The fused kernel must reproduce the general kernel's map for each.
 */
function buildFixture(axis: 'x' | 'y'): { positions: Float32Array; index: Uint32Array; stock: ReturnType<typeof roundStock> } {
  const stock = roundStock(20, 40, axis, { x: -3, y: 7 })
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const coordinates: number[] = []
  const indices: number[] = []
  const add = (along: number, acrossOffset: number, upOffset: number): void => {
    coordinates.push(...(axis === 'x'
      ? [along, centre + acrossOffset, pivot + upOffset]
      : [centre + acrossOffset, along, pivot + upOffset]))
    indices.push(indices.length)
  }
  // A broad triangle crossing the whole map, including exact grid boundaries.
  add(0, -6, 0)
  add(20, 6, 0)
  add(20, -6, 0)
  // Small off-lattice triangles, both windings, one zero-area triangle.
  for (let t = 0; t < 600; t++) {
    const along = (t % 200) * 0.1
    const acrossOffset = Math.sin(t * 0.7) * 5
    const upOffset = 2 + Math.cos(t * 0.3) * 3
    add(along, acrossOffset - 0.15, upOffset)
    add(along + (t % 9 === 0 ? 0 : 0.012), acrossOffset + 0.15, upOffset + 0.3)
    add(along + 0.02, acrossOffset, upOffset - 0.2)
  }
  add(5, 0, 0)
  add(5, 0, 0)
  add(5, 0, 0)
  return { positions: new Float32Array(coordinates), index: new Uint32Array(indices), stock }
}

for (const axis of ['x', 'y'] as const) {
  const { positions, index, stock } = buildFixture(axis)
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  for (const angle of [0, 35, -137, 89.9999, 360, 720]) {
    const turned = turnedModelPositions(positions, stock, angle)
    const bbox = computeXYBounds(turned)
    const t = angle * Math.PI / 180
    for (const cellSize of [0.4, 0.73, 2]) {
      const margin = Math.ceil(tool.radius / cellSize) + 1
      const cross = Math.floor((centre - (axis === 'x' ? bbox.minY : bbox.minX)) / cellSize)
      const axial = Math.floor((centre - (axis === 'x' ? bbox.minX : bbox.minY)) / cellSize)
      const windows = [
        undefined,
        axis === 'x'
          ? { minRow: cross - margin, maxRow: cross + margin }
          : { minCol: cross - margin, maxCol: cross + margin },
        axis === 'x'
          ? { minCol: axial - margin, maxCol: axial + margin }
          : { minRow: axial - margin, maxRow: axial + margin },
        axis === 'x'
          ? { minRow: cross - margin, maxRow: cross + margin, minCol: axial - margin, maxCol: axial + margin }
          : { minRow: axial - margin, maxRow: axial + margin, minCol: cross - margin, maxCol: cross + margin },
      ]
      for (const trackCellRise of [false, true]) {
        for (const triangles of [undefined, new Uint32Array([0, 9, 3, 90, 270, 5400])]) {
          for (const window of windows) {
            const options: HeightMapBuildOptions = {
              ...(window ? { window } : {}),
              trackCellRise,
              ...(triangles ? { triangles } : {}),
            }
            const expected = buildHeightMap(turned, index, bbox, cellSize, options)
            const actual = buildRotaryHeightMap({
              axis, centre, pivot, cos: Math.cos(t), sin: Math.sin(t),
              geometry: buildRotaryRasterGeometry(positions, index, axis, centre, pivot),
            }, bbox, cellSize, options)
            assert.deepEqual(actual, expected,
              `raster identity ${axis} A${angle} cell${cellSize} rise${trackCellRise} window${JSON.stringify(window)}`)
          }
        }
      }
      // The tip row the sampler reads must be the one the old turned-mesh path
      // would produce, lift included. The pad is the sampler's own: **one cell**,
      // since #1155 rn-c widened the conservative read from half a cell diagonal
      // (see `runRotaryAngleJob`). A map records each cell's surface at the
      // cell's centre, so material that ends inside the next cell is recorded
      // only when that cell's centre is inside it, and the last centre that does
      // hold it can be a whole cell from the material's edge.
      const window = axis === 'x'
        ? { minRow: cross - margin, maxRow: cross + margin }
        : { minCol: cross - margin, maxCol: cross + margin }
      const map = buildHeightMap(turned, index, bbox, cellSize, { window, trackCellRise: true })
      const along = [0, 0.2, 1, 5.2, 10, 19, 20]
      const expected = new Float32Array(along.map((position) => {
        const z = safeToolTipZAt(axis === 'x' ? position : centre,
          axis === 'x' ? centre : position, map, tool, cellSize)
        const raw = Math.fround(z === -Infinity ? NaN : z - pivot)
        return Number.isFinite(raw) ? Math.fround(raw + Math.min(map.cellRise ?? 0, cellSize)) : raw
      }))
      const actual = sampleRotaryModel({ positions, index }, stock, tool, {
        anglesDeg: [angle], along, requestedCellSize: cellSize, conservativeCellBounds: true,
      }, [])
      assert.deepEqual(actual.tipRadius[0], expected, `tip-row identity ${axis} A${angle} cell${cellSize}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Seeded parity, sequential reuse and retained-wall metadata
// ---------------------------------------------------------------------------

/**
 * Deterministic 32-bit PRNG (mulberry32). A seeded comparison is only a test if
 * a failure can be replayed, so nothing here reads `Math.random` and no case
 * depends on which other test file ran first.
 */
function makeRandom(seed: number): {
  next: () => number
  int: (maxExclusive: number) => number
  range: (min: number, max: number) => number
} {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (maxExclusive: number): number => Math.floor(next() * maxExclusive),
    range: (min: number, max: number): number => min + (max - min) * next(),
  }
}

interface RasterCase {
  /** Turn angle, in degrees. */
  readonly angle: number
  readonly cellSize: number
  readonly trackCellRise: boolean
  /** Added to all four sides of the turned bounds, which moves the grid origin. */
  readonly pad: number
  readonly window?: HeightMapWindow
  /** Triangle **index offsets** (multiples of three), the form both kernels take. */
  readonly triangles?: Uint32Array
}

interface RasterFixture {
  readonly seed: number
  readonly axis: 'x' | 'y'
  readonly positions: Float32Array
  readonly index: Uint32Array
  readonly stock: ReturnType<typeof roundStock>
  readonly wallTriangleStart: number | undefined
  readonly cases: readonly RasterCase[]
}

/** Cell sizes that land the same triangle on a centre for one call and not the next. */
const CELL_SIZES = [0.3, 0.37, 0.55, 0.8, 1.13, 1.7] as const

/**
 * One seeded mesh and the sequence of calls made against it. The triangles are
 * deliberately unrelated to the cell lattice: a base spanning the whole map,
 * specks far smaller than a cell (most of them cover no centre), grid-aligned
 * edges, thin slivers whose clipped maximum changes cell by cell, a degenerate
 * triple, and a wall-marked tail of high triangles plus a 0.02 wide fin. That
 * mix is what the #1050 centre, clip and wall paths branch on.
 */
function seededFixture(seed: number): RasterFixture {
  const rnd = makeRandom(seed)
  const axis: 'x' | 'y' = rnd.int(2) === 0 ? 'x' : 'y'
  const length = rnd.range(12, 30)
  const diameter = rnd.range(8, 20)
  const at = { x: rnd.range(-4, 4), y: rnd.range(-4, 4) }
  const stock = roundStock(diameter, length, axis, at)
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const alongStart = axis === 'x' ? at.x : at.y

  const coordinates: number[] = []
  const index: number[] = []
  const vertex = (along: number, across: number, up: number): void => {
    index.push(coordinates.length / 3)
    if (axis === 'x') coordinates.push(along, centre + across, pivot + up)
    else coordinates.push(centre + across, along, pivot + up)
  }
  const triangle = (a: readonly number[], b: readonly number[], c: readonly number[]): void => {
    vertex(a[0], a[1], a[2])
    vertex(b[0], b[1], b[2])
    vertex(c[0], c[1], c[2])
  }

  // A base covering the whole map, plus a tilted one so `cellRise` is not zero.
  const baseUp = -diameter * 0.45 + rnd.range(0, diameter * 0.25)
  triangle([alongStart, -diameter * 0.6, baseUp],
    [alongStart + length, diameter * 0.6, baseUp],
    [alongStart + length, -diameter * 0.6, baseUp])
  triangle([alongStart, -diameter * 0.6, baseUp - 0.5],
    [alongStart, diameter * 0.6, baseUp + 1.2],
    [alongStart + length, diameter * 0.6, baseUp - 0.25])
  // Specks: sizes from far below a cell to several cells across.
  const sizes = [0.01, 0.05, 0.15, 0.4, 1.2]
  const speckCount = 80 + rnd.int(80)
  for (let i = 0; i < speckCount; i++) {
    const along = alongStart + rnd.range(0, length)
    const across = rnd.range(-diameter * 0.5, diameter * 0.5)
    const up = rnd.range(-diameter * 0.4, diameter * 0.5)
    const scale = sizes[rnd.int(sizes.length)] * (rnd.next() < 0.25 ? rnd.range(0.2, 1) : 1)
    triangle(
      [along, across, up],
      [along + rnd.range(-0.75, 0.75) * scale, across + scale, up + rnd.range(-0.4, 0.4) * scale],
      [along + scale * 0.7, across - scale * 0.4, up + rnd.range(-0.4, 0.6) * scale],
    )
  }
  // Degenerate triples: zero projected area must contribute nothing.
  for (let i = 0; i < 2; i++) {
    const along = alongStart + rnd.range(0, length)
    const across = rnd.range(-diameter * 0.4, diameter * 0.4)
    const up = rnd.range(-diameter * 0.2, diameter * 0.2)
    triangle([along, across, up], [along, across, up], [along, across, up])
  }
  // Slivers: thin in the turned cross axis and spanning several cells along the
  // bar, so the clipped maximum differs from the triangle's global maximum.
  for (let i = 0; i < 3; i++) {
    const across = rnd.range(-diameter * 0.35, diameter * 0.35)
    const start = alongStart + rnd.range(0, length * 0.4)
    const run = length * rnd.range(0.25, 0.6)
    const z0 = rnd.range(-diameter * 0.25, diameter * 0.25)
    const slope = [0.2, 0.7, 1.5][rnd.int(3)]
    triangle(
      [start, across, z0],
      [start + run, across + 0.01, z0 + slope * run],
      [start + run * 0.5, across + 0.02, z0 + slope * run * 0.5],
    )
  }

  const modelTriangleCount = Math.floor(index.length / 3)
  // Wall tail: high triangles (so a clipped contribution is a local peak) plus
  // a 0.02 wide fin that no centre of any cell size below covers.
  const wallCount = 12 + rnd.int(24)
  for (let i = 0; i < wallCount; i++) {
    const along = alongStart + rnd.range(0, length)
    const across = rnd.range(-diameter * 0.5, diameter * 0.5)
    const up = rnd.range(diameter * 0.15, diameter * 0.65)
    const scale = [0.01, 0.1, 0.5][rnd.int(3)]
    triangle(
      [along, across, up],
      [along + scale, across + scale, up],
      [along + scale * 0.5, across - scale * 0.5, up + rnd.range(0.1, 1) * scale],
    )
  }
  const finAcross = rnd.range(-diameter * 0.3, diameter * 0.3)
  const finUp = rnd.range(diameter * 0.3, diameter * 0.6)
  const finStart = alongStart + rnd.range(0, length * 0.3)
  const finRun = length * rnd.range(0.3, 0.6)
  triangle([finStart, finAcross, finUp],
    [finStart + finRun, finAcross + 0.02, finUp],
    [finStart + finRun, finAcross, finUp])

  const triangleCount = Math.floor(index.length / 3)
  const pickCellSize = (): number => CELL_SIZES[rnd.int(CELL_SIZES.length)]
  const cell0 = pickCellSize()
  let cell1 = pickCellSize()
  if (cell1 === cell0) cell1 = cell0 === CELL_SIZES[0] ? CELL_SIZES[2] : CELL_SIZES[0]
  const cell2 = pickCellSize()
  const subset = (count: number): Uint32Array => {
    const picks = new Uint32Array(count)
    for (let i = 0; i < count; i++) picks[i] = rnd.int(triangleCount) * 3
    return picks
  }
  const rows = (): HeightMapWindow => ({ minRow: rnd.int(18) - 2, maxRow: rnd.int(18) - 2 })
  const cols = (): HeightMapWindow => ({ minCol: rnd.int(18) - 2, maxCol: rnd.int(18) - 2 })

  const cases: RasterCase[] = [
    // The reference: full map, every triangle, angle zero.
    { angle: 0, cellSize: cell0, trackCellRise: rnd.next() < 0.5, pad: 0 },
    // A different angle, cell size and triangle subset in a row window.
    {
      angle: rnd.range(-180, 180), cellSize: cell1, trackCellRise: rnd.next() < 0.5, pad: 0,
      window: rows(), triangles: subset(3 + rnd.int(8)),
    },
    // The first case's cell size at a moved grid origin, in a column window.
    {
      angle: rnd.range(-180, 180), cellSize: cell0, trackCellRise: rnd.next() < 0.5, pad: 2.5,
      window: cols(), triangles: subset(3 + rnd.int(8)),
    },
    // Both window axes, sometimes inverted (the early return).
    {
      angle: rnd.range(-180, 180), cellSize: cell2, trackCellRise: rnd.next() < 0.5, pad: 0,
      window: { ...cols(), ...rows() },
    },
    // The first case's angle, cell size, bounds and origin again: a cached axial
    // range hit, with different triangles and a different window.
    {
      angle: 0, cellSize: cell0, trackCellRise: rnd.next() < 0.5, pad: 0,
      window: cols(), triangles: subset(2 + rnd.int(6)),
    },
  ]

  return {
    seed,
    axis,
    positions: new Float32Array(coordinates),
    index: new Uint32Array(index),
    stock,
    wallTriangleStart: modelTriangleCount,
    cases,
  }
}

interface PreparedCase {
  readonly label: string
  readonly turned: Float32Array
  readonly bbox: { minX: number; maxX: number; minY: number; maxY: number }
  readonly cellSize: number
  readonly options: HeightMapBuildOptions
  readonly cos: number
  readonly sin: number
}

/** Everything a call needs, derivable from the fixture alone. */
function prepareCases(fixture: RasterFixture): PreparedCase[] {
  const { positions, stock, wallTriangleStart } = fixture
  return fixture.cases.map((c, i) => {
    const turned = turnedModelPositions(positions, stock, c.angle)
    const bounds = computeXYBounds(turned)
    const angle = (c.angle * Math.PI) / 180
    const window = c.window ? JSON.stringify(c.window) : 'full'
    const triangles = c.triangles ? `${c.triangles.length} triangles` : 'every triangle'
    return {
      label: `seed ${fixture.seed} case ${i}: A${c.angle.toFixed(3)} cell ${c.cellSize} `
        + `pad ${c.pad} ${window} ${triangles} rise ${c.trackCellRise}`,
      turned,
      bbox: {
        minX: bounds.minX - c.pad,
        maxX: bounds.maxX + c.pad,
        minY: bounds.minY - c.pad,
        maxY: bounds.maxY + c.pad,
      },
      cellSize: c.cellSize,
      options: {
        ...(c.window ? { window: c.window } : {}),
        trackCellRise: c.trackCellRise,
        ...(c.triangles ? { triangles: c.triangles } : {}),
        ...(wallTriangleStart !== undefined ? { wallTriangleStart } : {}),
      },
      cos: Math.cos(angle),
      sin: Math.sin(angle),
    }
  })
}

/** What the seeded cases actually exercised, so a parity pass cannot be vacuous. */
interface RasterStats {
  maxCellRise: number
  cellsWithModel: number
  cellsWithWall: number
  cellsWithBoth: number
  finiteModelOnly: number
}

function recordRasterStats(map: HeightMap, stats: RasterStats): void {
  if (map.cellRise !== undefined && map.cellRise > stats.maxCellRise) stats.maxCellRise = map.cellRise
  const coverage = map.wallCoverage
  if (coverage === undefined) return
  for (const byte of coverage) {
    if ((byte & 1) !== 0) stats.cellsWithModel += 1
    if ((byte & 2) !== 0) stats.cellsWithWall += 1
    if (byte === 3) stats.cellsWithBoth += 1
  }
  if (map.modelOnly !== undefined) {
    for (const value of map.modelOnly) {
      if (Number.isFinite(value)) stats.finiteModelOnly += 1
    }
  }
}

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233] as const
const rasterStats: RasterStats = {
  maxCellRise: 0, cellsWithModel: 0, cellsWithWall: 0, cellsWithBoth: 0, finiteModelOnly: 0,
}
let seededCallCount = 0

for (const seed of SEEDS) {
  const fixture = seededFixture(seed)
  const { axis, positions, index, stock } = fixture
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const prepared = prepareCases(fixture)
  const freshGeometry = (): RotaryRasterGeometry =>
    buildRotaryRasterGeometry(positions, index, axis, centre, pivot)
  const mapOf = (p: PreparedCase, geometry: RotaryRasterGeometry): HeightMap => buildRotaryHeightMap(
    { axis, centre, pivot, cos: p.cos, sin: p.sin, geometry },
    p.bbox, p.cellSize, p.options,
  )

  // The invariant: the general kernel over the turned mesh, exactly.
  const expected = prepared.map((p) => buildHeightMap(p.turned, index, p.bbox, p.cellSize, p.options))
  prepared.forEach((p, i) => {
    assert.deepEqual(mapOf(p, freshGeometry()), expected[i], `seeded parity — ${p.label}`)
    recordRasterStats(expected[i], rasterStats)
  })
  seededCallCount += prepared.length

  // Reuse: one geometry object -- with its cached axial ranges -- across every
  // case, forward and then reversed. A stale cache entry or a scratch buffer an
  // earlier call did not reset changes a later map, and the reversal catches a
  // call that only looks right after the one before it.
  const reused = freshGeometry()
  prepared.forEach((p, i) => {
    assert.deepEqual(mapOf(p, reused), expected[i], `sequential reuse (forward) — ${p.label}`)
  })
  for (let i = prepared.length - 1; i >= 0; i--) {
    assert.deepEqual(mapOf(prepared[i], reused), expected[i], `sequential reuse (reverse) — ${prepared[i].label}`)
  }
}

assert.ok(rasterStats.maxCellRise > 0,
  'the seeded cases rasterise a sloped centre sample, so a non-zero cellRise is compared')
assert.ok(rasterStats.cellsWithWall > 0, 'the seeded cases rasterise wall-covered cells')
assert.ok(rasterStats.cellsWithModel > 0, 'the seeded cases rasterise model-covered cells')
assert.ok(rasterStats.cellsWithBoth > 0,
  'the seeded cases rasterise cells covered by both a model and a retained wall')
assert.ok(rasterStats.finiteModelOnly > 0,
  'the seeded cases record a finite model-only height beside a wall')
console.log(`seeded parity: ${SEEDS.length} fixtures x ${seededCallCount / SEEDS.length} calls, `
  + `max cellRise ${rasterStats.maxCellRise.toFixed(4)}, `
  + `${rasterStats.cellsWithModel} model / ${rasterStats.cellsWithWall} wall / `
  + `${rasterStats.cellsWithBoth} both-covered / ${rasterStats.finiteModelOnly} model-only cells`)

/**
 * Retained-wall bookkeeping (issue #1095 slice D) on a 10 x 10 grid of 0.1
 * cells, in the regions the coverage byte has to tell apart. Only the model
 * carries a centre sample in the first; model and wall both do in the second;
 * only a wall does in the third; a thin wall fin raises two cells no centre
 * covers in the fourth; a 0.02 wide model strip raises two cells a wall covers
 * by centre, which is the one contribution `data` hides and only `modelOnly`
 * records; and a sloped wall fin raises one cell below the triangle's global
 * maximum, which is what the clipped maximum has to do instead.
 *
 * A flat frame (`cos` 1, `sin` 0, centre and pivot 0) makes the turned map the
 * same map `buildHeightMap` sees, so the values below are the general kernel's
 * own, and the rotary kernel must reproduce them byte for byte.
 */
function testRetainedWallMetadata(): void {
  console.log('Testing retained-wall metadata through the fused rotary kernel...')
  const positions: number[] = []
  const index: number[] = []
  const quad = (x0: number, x1: number, y0: number, y1: number, z: number): void => {
    const base = positions.length / 3
    positions.push(x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z)
    index.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  /** A strip whose z rises linearly with y from 0 at `y0` to `top` at `y1`. */
  const slopedStrip = (x0: number, x1: number, y0: number, y1: number, top: number): void => {
    const base = positions.length / 3
    positions.push(x0, y0, 0, x1, y0, 0, x1, y1, top, x0, y1, top)
    index.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  // Model: a block of its own, the block a wall also covers, and a strip that
  // only the clip pass can reach inside a wall-only cell. Every edge sits
  // between cell boundaries on purpose: a vertex on a grid line rounds outward
  // in Float32 and legitimately reaches the next cell, which would blur which
  // region each assertion is about.
  quad(0.01, 0.19, 0.01, 0.19, 1)
  quad(0.41, 0.59, 0.41, 0.59, 1)
  quad(0.86, 0.88, 0.41, 0.59, 3)
  const wallTriangleStart = Math.floor(index.length / 3)
  // Wall: the second block's top, a block no model reaches, a thin fin, and a
  // sloped fin whose top rises from 0 to 9 over its y span (so its clipped
  // maximum in the lower cell is 4.5, half its global maximum).
  quad(0.41, 0.59, 0.41, 0.59, 5)
  quad(0.81, 0.99, 0.41, 0.59, 5)
  quad(0.46, 0.48, 0.21, 0.39, 9)
  slopedStrip(0.26, 0.28, 0.71, 0.89, 9)

  const flatPositions = new Float32Array(positions)
  const flatIndex = new Uint32Array(index)
  const bbox = { minX: 0, maxX: 1, minY: 0, maxY: 1 }
  const options: HeightMapBuildOptions = { wallTriangleStart, trackCellRise: true }
  const expected = buildHeightMap(flatPositions, flatIndex, bbox, 0.1, options)
  const actual = buildRotaryHeightMap({
    axis: 'x', centre: 0, pivot: 0, cos: 1, sin: 0,
    geometry: buildRotaryRasterGeometry(flatPositions, flatIndex, 'x', 0, 0),
  }, bbox, 0.1, options)
  assert.deepEqual(actual, expected, 'the fused rotary kernel reproduces the wall bookkeeping exactly')

  const cell = (col: number, row: number): { data: number; coverage: number; modelOnly: number } => {
    const idx = row * expected.width + col
    return {
      data: expected.data[idx],
      coverage: expected.wallCoverage![idx],
      modelOnly: expected.modelOnly![idx],
    }
  }
  assert.deepEqual(cell(0, 0), { data: 1, coverage: 1, modelOnly: -Infinity },
    'a model-only cell keeps its surface and records no model-only split')
  assert.deepEqual(cell(1, 1), { data: 1, coverage: 1, modelOnly: -Infinity },
    'the whole model-only block is covered, not one sampled cell')
  assert.deepEqual(cell(4, 4), { data: 5, coverage: 3, modelOnly: 1 },
    'a cell both cover reads the wall top and keeps the model height beside it')
  assert.deepEqual(cell(5, 5), { data: 5, coverage: 3, modelOnly: 1 },
    'the whole both-covered block carries the split')
  assert.deepEqual(cell(9, 4), { data: 5, coverage: 2, modelOnly: -Infinity },
    'a wall-only cell reads the wall top and no model height')
  assert.deepEqual(cell(8, 4), { data: 5, coverage: 3, modelOnly: 3 },
    'a clipped model contribution lands in a wall cell without changing its top')
  assert.deepEqual(cell(8, 5), { data: 5, coverage: 3, modelOnly: 3 },
    'both wall cells the strip clips record the clipped model height')
  assert.deepEqual(cell(4, 2), { data: 9, coverage: 2, modelOnly: -Infinity },
    'a thin wall fin raises the cell no centre covers and marks it a wall')
  assert.deepEqual(cell(4, 3), { data: 9, coverage: 2, modelOnly: -Infinity },
    'the fin raises both cells it passes through')
  assert.deepEqual(cell(4, 1), { data: -Infinity, coverage: 0, modelOnly: -Infinity },
    'a cell nothing covers stays empty in all three arrays')
  assert.deepEqual(cell(2, 8), { data: 9, coverage: 2, modelOnly: -Infinity },
    'the sloped wall fin reads its top where its top is inside the cell')
  const slopedClip = cell(2, 7)
  assert.equal(slopedClip.coverage, 2, 'the lower cell of the sloped fin is wall-covered too')
  assert.ok(Number.isFinite(slopedClip.data) && slopedClip.data < 9,
    `the sloped wall raises its lower cell to the clipped maximum (4.5), never to the `
    + `triangle's global maximum 9 (got ${slopedClip.data})`)

  const coverageCounts = [0, 0, 0, 0]
  for (const byte of expected.wallCoverage!) coverageCounts[byte] += 1
  assert.deepEqual(coverageCounts, [84, 4, 6, 6],
    'exactly 4 model-only, 6 wall-only and 6 both-covered cells, and 84 empty ones')
  let finiteModelOnly = 0
  for (const value of expected.modelOnly!) if (Number.isFinite(value)) finiteModelOnly += 1
  assert.equal(finiteModelOnly, 6, 'exactly the six both-covered cells record a model-only height')

  // The windowed and subset paths must carry the same bookkeeping. The inverted
  // window takes the kernels' early return, which drops the rise key from both.
  const variants: HeightMapBuildOptions[] = [
    { window: { minRow: 1, maxRow: 5, minCol: 3, maxCol: 6 } },
    { triangles: new Uint32Array([0, 6, 18, 24]) },
    // One triangle that is a clip candidate, after a call that collected six:
    // candidate scratch left over from the previous call would raise the model
    // strip's and the sloped fin's cells here.
    { triangles: new Uint32Array([0, 30]) },
    { window: { minRow: 4, maxRow: 3 } },
  ]
  for (const variant of variants) {
    const variantOptions: HeightMapBuildOptions = { ...options, ...variant }
    assert.deepEqual(
      buildRotaryHeightMap({
        axis: 'x', centre: 0, pivot: 0, cos: 1, sin: 0,
        geometry: buildRotaryRasterGeometry(flatPositions, flatIndex, 'x', 0, 0),
      }, bbox, 0.1, variantOptions),
      buildHeightMap(flatPositions, flatIndex, bbox, 0.1, variantOptions),
      `wall bookkeeping survives ${JSON.stringify(variant)}`,
    )
  }
  console.log('retained wall: coverage bits, model-only heights and the clipped wall raise all match')
}

testRetainedWallMetadata()
console.log('rotary raster: exact map and tip-row parity passed')
