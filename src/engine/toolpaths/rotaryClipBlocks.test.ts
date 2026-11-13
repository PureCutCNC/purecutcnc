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
 * #1185 slice C1: the clip pass of the fused rotary raster judges a block of
 * consecutive triangles with one test, and builds exactly the map it built
 * before.
 *
 * A triangle that covers no cell centre is a clip candidate (#1050): it is
 * projected again to learn whether it stands above the cells it overlaps by more
 * than the peak threshold, and on a fine mesh almost none does. Consecutive
 * triangles of a mesh are usually neighbours, so `rotaryClipBlocks` puts a
 * circle round the cross-section points of each run of `CLIP_BLOCK_SIZE`; turned,
 * nothing in the circle stands above its centre's height plus its radius or
 * lies outside the cells it spans. Where that height does not beat the lowest
 * limit of those cells the whole run is skipped.
 *
 * Block 1 checks the circles against the triangles they hold. Block 2 is the
 * oracle: the same raster on a geometry whose circles are all infinite, which
 * skips nothing and so runs the clip pass as it was before the slice; the two
 * maps must agree array for array. The fixtures have thin fins and a retained
 * collar, so the clip pass really raises cells, and a geometry whose circles are
 * points (an unsound bound) is seen to lose those cells.
 *
 * Mutations these blocks catch (each was applied and seen to fail):
 *  - a circle smaller than its triangles (half the reach, or the reach of the
 *    first triangle only), or one that does not see a NaN corner;
 *  - a block bound without its radius;
 *  - testing the cells under the circle's centre only, across the bar, or the
 *    first triangle's cells only, along it; the circle turned the wrong way;
 *  - skipping when any one cell hides the block instead of every cell;
 *  - judging a model triangle's block against the walls' higher limit;
 *  - carrying one map's verdicts into the next (no new epoch);
 *  - reading a triangle's block with the wrong shift;
 *  - never skipping at all.
 *
 * Not distinguished: the sign of the bound's rounding slack. It is a hundredth
 * of a micron per millimetre, there for the Float32 rounding of a turned
 * corner, and no fixture here puts a block that close to a limit.
 */

import assert from 'node:assert/strict'
import { barCentre, barPivotZ } from '../../types/barStock'
import { roundStock } from '../../types/project'
import type { BarStock } from '../../types/project'
import {
  buildRotaryHeightMap, buildRotaryRasterGeometry, CLIP_BLOCK_SIZE, rotaryClipBlockBytes, rotaryClipBlocks,
} from './rotaryRaster'
import type { RotaryRasterGeometry } from './rotaryRaster'
import type { RotaryModelMesh } from './rotarySampling'

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A tube from 12 to 28 with the given radius. */
function shell(
  stock: BarStock,
  radiusAt: (angle: number, u: number) => number,
  sides: number,
  rings: number,
  from = 12,
  to = 28,
): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (let r = 0; r < rings; r++) {
    const u = r / (rings - 1)
    const along = from + (to - from) * u
    for (let j = 0; j < sides; j++) {
      const t = 2 * Math.PI * j / sides
      const radius = radiusAt(t, u)
      const across = centre + radius * Math.cos(t)
      const up = pivot + radius * Math.sin(t)
      if (stock.axis === 'x') positions.push(along, across, up)
      else positions.push(across, along, up)
    }
  }
  for (let r = 0; r + 1 < rings; r++) {
    for (let j = 0; j < sides; j++) {
      const next = (j + 1) % sides
      const a = r * sides + j
      const b = r * sides + next
      const c = (r + 1) * sides + next
      const d = (r + 1) * sides + j
      index.push(a, b, c, a, c, d)
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/**
 * Thin fins standing out of the bar: each a sliver `thickness` wide from radius
 * `inner` to `outer`, cut into short pieces along the bar. Thinner than a cell,
 * a fin covers no cell centre at most turns and reaches the map only through the
 * clip pass.
 */
function fins(
  stock: BarStock, count: number, inner: number, outer: number, thickness: number, pieces: number, twist: number,
): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  const push = (along: number, radius: number, angle: number, side: number): void => {
    const across = centre + radius * Math.cos(angle) - side * Math.sin(angle)
    const up = pivot + radius * Math.sin(angle) + side * Math.cos(angle)
    if (stock.axis === 'x') positions.push(along, across, up)
    else positions.push(across, along, up)
  }
  for (let f = 0; f < count; f++) {
    for (let p = 0; p < pieces; p++) {
      const base = positions.length / 3
      for (const step of [p, p + 1]) {
        const along = 13 + 14 * step / pieces
        const angle = 2 * Math.PI * f / count + twist * step / pieces
        // The fin's outer edge wanders, so its pieces are not all one height.
        const tip = outer - 0.8 * Math.abs(Math.sin(5 * step / pieces + f))
        push(along, inner, angle, -thickness / 2)
        push(along, tip, angle, 0)
        push(along, inner, angle, thickness / 2)
      }
      // Two faces, base to tip: (0,1 | 3,4) and (2,1 | 5,4).
      index.push(base, base + 1, base + 4, base, base + 4, base + 3)
      index.push(base + 2, base + 5, base + 4, base + 2, base + 4, base + 1)
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

function join(...meshes: RotaryModelMesh[]): RotaryModelMesh {
  const positions = new Float32Array(meshes.reduce((n, m) => n + m.positions.length, 0))
  const index = new Uint32Array(meshes.reduce((n, m) => n + m.index.length, 0))
  let p = 0
  let i = 0
  for (const mesh of meshes) {
    const offset = p / 3
    positions.set(mesh.positions, p)
    for (let k = 0; k < mesh.index.length; k++) index[i + k] = mesh.index[k] + offset
    p += mesh.positions.length
    i += mesh.index.length
  }
  return { positions, index }
}

const lumpy = (angle: number, u: number): number => 5 + 0.7 * Math.sin(3 * angle + 4 * u) + 0.4 * Math.cos(9 * u)

// ── block 1: the circles ────────────────────────────────────────────────────
{
  const random = mulberry32(11851)
  // Not a multiple of the block size: the last block is short.
  const count = CLIP_BLOCK_SIZE * 37 + 3
  const section = new Float64Array(count * 6)
  for (let t = 0; t < count; t++) {
    const b = Math.floor(t / CLIP_BLOCK_SIZE)
    // Every fourth block is scattered across the section, the rest are compact.
    const spread = b % 4 === 0 ? 30 : 1.5
    const cx = Math.sin(b * 1.7) * 9
    const cy = Math.cos(b * 2.3) * 9
    for (let j = 0; j < 3; j++) {
      section[t * 6 + j * 2] = cx + (random() - 0.5) * spread
      section[t * 6 + j * 2 + 1] = cy + (random() - 0.5) * spread
    }
  }
  const geometry: RotaryRasterGeometry = { section, along: new Float32Array(count * 3) }
  const blocks = rotaryClipBlocks(geometry)
  assert.equal(rotaryClipBlocks(geometry), blocks, 'the circles are built once')
  const blockCount = Math.ceil(count / CLIP_BLOCK_SIZE)
  assert.equal(blocks.radius.length, blockCount, 'one circle per block, the short last one included')
  assert.equal(blocks.centre.length, blockCount * 2)
  let tight = 0
  for (let t = 0; t < count; t++) {
    const b = Math.floor(t / CLIP_BLOCK_SIZE)
    for (let j = 0; j < 3; j++) {
      const d = Math.hypot(section[t * 6 + j * 2] - blocks.centre[b * 2], section[t * 6 + j * 2 + 1] - blocks.centre[b * 2 + 1])
      assert.ok(d <= blocks.radius[b], `triangle ${t} corner ${j} is ${d} from its block's centre, outside the radius ${blocks.radius[b]}`)
    }
  }
  for (let b = 0; b < blockCount; b++) {
    // The circle is not slack either: some corner is on it.
    let reach = 0
    const end = Math.min(count, (b + 1) * CLIP_BLOCK_SIZE)
    for (let p = b * CLIP_BLOCK_SIZE * 6; p < end * 6; p += 2) {
      reach = Math.max(reach, Math.hypot(section[p] - blocks.centre[b * 2], section[p + 1] - blocks.centre[b * 2 + 1]))
    }
    assert.ok(blocks.radius[b] - reach < 1e-6, `block ${b}: radius ${blocks.radius[b]} for a reach of ${reach}`)
    if (blocks.radius[b] < 2) tight++
  }
  assert.ok(tight > 20, `${tight} compact blocks have a small circle`)

  // A corner that is not a number bounds nothing.
  const broken = section.slice()
  broken[CLIP_BLOCK_SIZE * 6 * 2 + 3] = Number.NaN
  const brokenBlocks = rotaryClipBlocks({ section: broken, along: new Float32Array(count * 3) })
  assert.equal(brokenBlocks.radius[2], Infinity, 'a block with a NaN corner is never skipped')
  assert.ok(Number.isFinite(brokenBlocks.radius[1]) && Number.isFinite(brokenBlocks.radius[3]))

  assert.equal(rotaryClipBlockBytes(count), blockCount * 36, 'three doubles and three ints per block')
  assert.equal(rotaryClipBlockBytes(0), 0)
  console.log(`  clip blocks: ${blockCount} circles hold every corner, ${tight} of them compact`)
}

// ── block 2: the raster with and without the block test ─────────────────────
interface Fixture {
  readonly label: string
  readonly mesh: (stock: BarStock) => { mesh: RotaryModelMesh; walls?: number }
}

const FIXTURES: Fixture[] = [
  // A fine lumpy body with thin fins standing out of it.
  {
    label: 'finned body',
    mesh: (stock) => ({ mesh: join(shell(stock, lumpy, 96, 81), fins(stock, 7, 2, 8.5, 0.05, 40, 0.9)) }),
  },
  // Fins only: nothing but the clip pass sees most of them.
  { label: 'fins alone', mesh: (stock) => ({ mesh: fins(stock, 11, 1, 8, 0.04, 64, 2.2) }) },
  // The finned body under a retained collar: model and wall triangles are
  // judged against different limits.
  {
    label: 'finned body with a retained collar',
    mesh: (stock) => {
      const model = join(shell(stock, lumpy, 96, 81), fins(stock, 7, 2, 8.5, 0.05, 40, 0.9))
      const collar = join(shell(stock, () => 7.2, 64, 9, 12, 16), fins(stock, 5, 6, 9, 0.05, 40, -1.3))
      return { mesh: join(model, collar), walls: model.index.length / 3 }
    },
  },
]

/** A geometry whose circles are replaced: infinite skips nothing, zero is unsound. */
function withCircles(geometry: RotaryRasterGeometry, radius: number): RotaryRasterGeometry {
  const real = rotaryClipBlocks(geometry)
  geometry.clipBlocks = { centre: real.centre, radius: new Float64Array(real.radius.length).fill(radius) }
  return geometry
}

/** Blocks the last map's clip pass skipped, read off the geometry's verdicts. */
function skippedBlocks(geometry: RotaryRasterGeometry): number {
  const verdicts = geometry.blockVerdict
  const epoch = geometry.blockEpoch
  if (verdicts === undefined || epoch === undefined) return 0
  let skipped = 0
  for (const verdict of verdicts) if (verdict === epoch + 1) skipped++
  return skipped
}

{
  let maps = 0
  let skipped = 0
  let judged = 0
  let unsoundDiffers = 0
  for (const axis of ['x', 'y'] as const) {
    const stock = roundStock(20, 40, axis)
    const centre = barCentre(stock)
    const pivot = barPivotZ(stock)
    for (const fixture of FIXTURES) {
      const { mesh, walls } = fixture.mesh(stock)
      const fresh = (): RotaryRasterGeometry => buildRotaryRasterGeometry(mesh.positions, mesh.index, axis, centre, pivot)
      // One geometry serves every turn and cell size, as it does in a job, so a
      // verdict left by one map is there to be misread by the next.
      const shared = fresh()
      const plainShared = withCircles(fresh(), Infinity)
      for (const cell of [0.33, 0.12]) {
        for (let k = 0; k < 14; k++) {
          const angle = 3 + 26 * k
          const turn = (angle * Math.PI) / 180
          const cos = Math.cos(turn)
          const sin = Math.sin(turn)
          const bbox = axis === 'x'
            ? { minX: 12, maxX: 28, minY: centre - 9.5, maxY: centre + 9.5 }
            : { minX: centre - 9.5, maxX: centre + 9.5, minY: 12, maxY: 28 }
          const centreCell = Math.floor(9.5 / cell)
          const margin = Math.ceil(1.5 / cell) + 1
          const strip = axis === 'x'
            ? { minRow: centreCell - margin, maxRow: centreCell + margin }
            : { minCol: centreCell - margin, maxCol: centreCell + margin }
          // A strip over the centreline, the same strip cut short along the bar, and the whole map.
          const alongCells = Math.ceil(16 / cell)
          const stretch = axis === 'x'
            ? { ...strip, minCol: Math.floor(alongCells * 0.3), maxCol: Math.floor(alongCells * 0.6) }
            : { ...strip, minRow: Math.floor(alongCells * 0.3), maxRow: Math.floor(alongCells * 0.6) }
          for (const window of [strip, stretch, undefined]) {
            if (window === undefined && k % 5 !== 0) continue
            const options = {
              ...(window !== undefined ? { window } : {}),
              ...(walls !== undefined ? { wallTriangleStart: walls } : {}),
              trackCellRise: true,
            }
            const label = `${fixture.label}, ${axis} bar, cell ${cell}, A${angle}, ${window === undefined ? 'whole map' : window === strip ? 'strip' : 'stretch'}`
            const frame = (geometry: RotaryRasterGeometry): Parameters<typeof buildRotaryHeightMap>[0] =>
              ({ axis, centre, pivot, cos, sin, geometry })
            const plain = buildRotaryHeightMap(frame(plainShared), bbox, cell, options)
            assert.equal(skippedBlocks(plainShared), 0, `${label}: infinite circles skip nothing`)
            const fast = buildRotaryHeightMap(frame(shared), bbox, cell, options)
            assert.deepEqual(fast.data, plain.data, `${label}: the same cells`)
            assert.equal(fast.cellRise, plain.cellRise, `${label}: the same cell rise`)
            assert.deepEqual(fast.wallCoverage, plain.wallCoverage, `${label}: the same wall coverage`)
            assert.deepEqual(fast.modelOnly, plain.modelOnly, `${label}: the same model-only heights`)
            maps++
            skipped += skippedBlocks(shared)
            for (const verdict of shared.blockVerdict ?? []) {
              if (verdict === shared.blockEpoch || verdict === (shared.blockEpoch ?? 0) + 1) judged++
            }
            // The fixture bites: circles shrunk to points lose cells the clip pass raised.
            const unsound = buildRotaryHeightMap(frame(withCircles(fresh(), 0)), bbox, cell, options)
            if (unsound.data.some((value, i) => !Object.is(value, plain.data[i]))) unsoundDiffers++
          }
        }
      }
    }
  }
  assert.ok(skipped > judged * 0.3, `the block test skipped ${skipped} of ${judged} blocks it judged`)
  assert.ok(skipped < judged, 'and kept some')
  assert.ok(unsoundDiffers > maps * 0.3, `point circles changed ${unsoundDiffers} of ${maps} maps, so the clip pass decides cells here`)
  console.log(`  raster oracle: ${maps} maps identical; ${skipped} of ${judged} judged blocks skipped; point circles would change ${unsoundDiffers} maps`)
}

console.log('engine/toolpaths/rotaryClipBlocks.test.ts: all assertions passed')
