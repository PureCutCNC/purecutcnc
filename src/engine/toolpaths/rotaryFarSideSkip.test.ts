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
 * #1185 slice F1: the height-map raster skips the far-side triangles that
 * cannot change the map, and builds exactly the map it built before.
 *
 * Each angle's sampler submits the triangles that reach its strip on the near
 * side of the bar and the ones that reach it on the far side, below the axis.
 * On a solid model the far side is hidden under the near side and was pure
 * cost: dropping it outright left the rect-stock bust's moves unchanged and cut
 * a third of the raster time. Dropping it outright is not sound, though -- on an
 * open or hollow model the far side is the surface the cutter sees -- so the
 * raster now proves it per triangle (`buildRotaryHeightMap`, `farOnlyStart`).
 *
 * Block 1 checks the bound's one input (`rotaryAxisDistances`) against a brute
 * force. Block 2 is the oracle: the same raster with and without the skip, on
 * meshes where the far side is hidden, partly visible and fully visible, and the
 * maps must agree cell for cell. Block 3 pins the sampler's rows by digests
 * captured from the implementation at `e68db099`, before this slice, and checks
 * the skip is armed where it should be and nowhere else.
 *
 * Mutations these blocks catch (each was applied and seen to fail):
 *  - bounding a triangle by its distance alone, without the strip's half-width;
 *  - a bound below the true height (the slack with the wrong sign);
 *  - measuring the strip's half-width short on its low side;
 *  - taking each bar-axis line's highest sample as its floor, or reading the
 *    floor on the triangle's first line only;
 *  - skipping before the cell rise has reached its cap, or on a map that marks
 *    retained walls;
 *  - rounding an axis distance up, or treating a triangle the axis passes
 *    through as far from it;
 *  - listing a triangle the near bucket also holds among the far-only ones,
 *    swapping the near and far buckets, or dropping the far-only triangles;
 *  - never arming the skip at all.
 *
 * Not distinguished: measuring the half-width short on the **high** side only.
 * The half-width is the larger of the two sides, and the window is centred on
 * the centreline to within a cell, so the low side's measure covers it.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { barCentre, barPivotZ, squareStock } from '../../types/barStock'
import { roundStock } from '../../types/project'
import type { BarStock } from '../../types/project'
import { buildRotaryHeightMap, buildRotaryRasterGeometry, rotaryAxisDistances } from './rotaryRaster'
import { createRotarySamplingPrep, sampleAnglesWithPrep } from './rotarySampling'
import type { RotaryModelMesh, RotarySamplingWorkspace } from './rotarySampling'
import type { NormalizedTool } from './types'

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

function toolOf(type: 'ball_endmill' | 'flat_endmill', radius: number): NormalizedTool {
  return {
    id: 't1', name: 't1', sourceUnits: 'mm', units: 'mm', type,
    diameter: radius * 2, radius, vBitAngle: null, flutes: 2, material: 'carbide',
    defaultRpm: 0, defaultFeed: 0, defaultPlungeFeed: 0, defaultStepdown: 0,
    defaultStepover: 0, maxCutDepth: 0,
  }
}

/**
 * A lumpy tube from 12 to 28. `keep(angle, u)` decides which facets exist, so
 * one builder gives a closed body, an open half-shell and a shell with a window.
 */
function shell(
  stock: BarStock,
  radiusAt: (angle: number, u: number) => number,
  keep: (angle: number, u: number) => boolean = () => true,
  sides = 48,
  rings = 41,
): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (let r = 0; r < rings; r++) {
    const u = r / (rings - 1)
    const along = 12 + 16 * u
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
      if (!keep(2 * Math.PI * (j + 0.5) / sides, (r + 0.5) / (rings - 1))) continue
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

/**
 * A lumpy radius with a ridge on every other ring: the ridges are steep enough
 * (1 mm of radius over 0.4 mm of bar) to take a strip's cell rise to its cap,
 * which is the state a real carved model is in and the one the skip needs.
 */
/** A flat blade through the bar's axis, `halfWidth` either side of it, from 12 to 28. */
function blade(stock: BarStock, halfWidth: number): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  for (const along of [12, 28]) {
    for (const across of [-halfWidth, halfWidth]) {
      if (stock.axis === 'x') positions.push(along, centre + across, pivot)
      else positions.push(centre + across, along, pivot)
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array([0, 1, 3, 0, 3, 2]) }
}

const lumpy = (angle: number, u: number): number =>
  6 + 0.9 * Math.sin(3 * angle + 4 * u) + 0.5 * Math.cos(7 * u) + 0.5 * Math.cos(Math.PI * Math.round(u * 40))

interface Fixture {
  readonly label: string
  readonly mesh: (stock: BarStock) => RotaryModelMesh
}

const FIXTURES: Fixture[] = [
  // The far side is always under the near side.
  { label: 'closed body', mesh: (stock) => shell(stock, lumpy) },
  // Only half the tube exists: for half of every turn the far side is all there is.
  { label: 'open half-shell', mesh: (stock) => shell(stock, lumpy, (angle) => angle < Math.PI) },
  // A window in the wall: through it the cutter sees the far wall's inside.
  {
    label: 'shell with a window',
    mesh: (stock) => shell(stock, lumpy, (angle, u) => !(angle > 1.0 && angle < 1.9 && u > 0.3 && u < 0.7)),
  },
  // A thin core inside a windowed shell: three layers under one footprint.
  {
    label: 'core inside a windowed shell',
    mesh: (stock) => join(
      shell(stock, lumpy, (angle, u) => !(angle > 4.0 && angle < 5.2 && u > 0.2 && u < 0.8)),
      shell(stock, (angle, u) => 1.6 + 0.3 * Math.sin(2 * angle + 9 * u), () => true, 24, 21),
    ),
  },
  // A little over half a thin tube with a blade through the axis. With the open half turned
  // up and the blade steep, the blade's low edge dips just below the tube wall
  // at the edge of the strip: the wall is the surface there although every cell
  // of the strip already holds a sample, and whether it is skipped turns on how
  // high the bound says it can stand -- by a few tenths of a millimetre.
  {
    label: 'half a thin tube with a blade through the axis',
    mesh: (stock) => join(shell(stock, () => 2.6, (angle) => angle >= Math.PI - 0.7, 24, 41), blade(stock, 7)),
  },
  // Smooth and open: the far side is visible, and the near side never reaches
  // the rise cap, so nothing may be skipped when the rise is tracked.
  { label: 'smooth open half-shell', mesh: (stock) => shell(stock, () => 6, (angle) => angle < Math.PI) },
]

// ── block 1: the distance from the axis ─────────────────────────────────────
{
  const random = mulberry32(1185)
  const count = 400
  const section = new Float64Array(count * 6)
  for (let t = 0; t < count; t++) {
    // A third of the triangles are thrown around the axis, the rest away from it.
    const cx = t % 3 === 0 ? 0 : (random() - 0.5) * 30
    const cy = t % 3 === 0 ? 0 : (random() - 0.5) * 30
    for (let j = 0; j < 3; j++) {
      section[t * 6 + j * 2] = cx + (random() - 0.5) * 6
      section[t * 6 + j * 2 + 1] = cy + (random() - 0.5) * 6
    }
  }
  const geometry = { section, along: new Float32Array(count * 3) }
  const distances = rotaryAxisDistances(geometry)
  assert.equal(rotaryAxisDistances(geometry), distances, 'the distances are built once')
  let inside = 0
  let outside = 0
  for (let t = 0; t < count; t++) {
    const a = [section[t * 6], section[t * 6 + 2], section[t * 6 + 4]]
    const u = [section[t * 6 + 1], section[t * 6 + 3], section[t * 6 + 5]]
    // Brute force: the nearest of a dense barycentric sample of the triangle.
    let nearest = Infinity
    const steps = 160
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j + i <= steps; j++) {
        const w0 = i / steps
        const w1 = j / steps
        const w2 = 1 - w0 - w1
        const d = Math.hypot(w0 * a[0] + w1 * a[1] + w2 * a[2], w0 * u[0] + w1 * u[1] + w2 * u[2])
        if (d < nearest) nearest = d
      }
    }
    // Never above the true distance (a larger distance is a lower, unsafe bound)...
    assert.ok(distances[t] <= nearest, `triangle ${t}: distance ${distances[t]} exceeds the nearest sampled point at ${nearest}`)
    // ...and, away from the axis, within the sampling's own resolution of it.
    if (distances[t] === 0) {
      inside++
      assert.ok(nearest < 0.08, `triangle ${t}: reported through the axis but its nearest sampled point is ${nearest} away`)
    } else {
      outside++
      assert.ok(nearest - distances[t] < 0.08, `triangle ${t}: distance ${distances[t]} is far below the nearest sampled point at ${nearest}`)
    }
  }
  assert.ok(inside > 20 && outside > 200, `the sample has ${inside} triangles through the axis and ${outside} clear of it`)
  console.log(`  axis distances: ${outside} clear of the axis, ${inside} through it, none above the brute-force distance`)
}

// ── block 2: the raster with and without the skip ───────────────────────────
{
  let skippedSomewhere = 0
  let keptSomewhere = 0
  for (const axis of ['x', 'y'] as const) {
    const stock = roundStock(20, 40, axis)
    const centre = barCentre(stock)
    const pivot = barPivotZ(stock)
    for (const fixture of FIXTURES) {
      const mesh = fixture.mesh(stock)
      const triangleCount = mesh.index.length / 3
      for (const cell of [0.1, 0.33]) {
        for (let k = 0; k < 24; k++) {
          const angle = 7 + 15 * k
          const turn = (angle * Math.PI) / 180
          const cos = Math.cos(turn)
          const sin = Math.sin(turn)
          // The turned bounds, and a strip two cutter radii wide over the centreline.
          let minAcross = Infinity
          let maxAcross = -Infinity
          const acrossOffset = axis === 'x' ? 1 : 0
          const turnedAcross = new Float64Array(mesh.positions.length / 3)
          const turnedUp = new Float64Array(mesh.positions.length / 3)
          for (let v = 0; v < turnedAcross.length; v++) {
            const a = mesh.positions[v * 3 + acrossOffset] - centre
            const u = mesh.positions[v * 3 + 2] - pivot
            turnedAcross[v] = a * cos - u * sin
            turnedUp[v] = a * sin + u * cos
            if (turnedAcross[v] < minAcross) minAcross = turnedAcross[v]
            if (turnedAcross[v] > maxAcross) maxAcross = turnedAcross[v]
          }
          const bbox = axis === 'x'
            ? { minX: 12, maxX: 28, minY: Math.fround(centre + minAcross), maxY: Math.fround(centre + maxAcross) }
            : { minX: Math.fround(centre + minAcross), maxX: Math.fround(centre + maxAcross), minY: 12, maxY: 28 }
          const margin = Math.ceil(1.5 / cell) + 1
          const crossMin = axis === 'x' ? bbox.minY : bbox.minX
          const centreCell = Math.floor((centre - crossMin) / cell)
          const window = axis === 'x'
            ? { minRow: centreCell - margin, maxRow: centreCell + margin }
            : { minCol: centreCell - margin, maxCol: centreCell + margin }
          const reach = (margin + 1) * cell
          // Far-only by construction, judged on the triangle's own corners and
          // not by the sampler's index: wholly below the axis and nowhere within
          // the strip's reach of it, so no point of it is in the strip's top half.
          const near: number[] = []
          const far: number[] = []
          const geometry = buildRotaryRasterGeometry(mesh.positions, mesh.index, axis, centre, pivot)
          const distances = rotaryAxisDistances(geometry)
          for (let t = 0; t < triangleCount; t++) {
            const corners = [mesh.index[t * 3], mesh.index[t * 3 + 1], mesh.index[t * 3 + 2]]
            const below = corners.every((v) => turnedUp[v] < 0)
            if (below && distances[t] > reach) far.push(t * 3)
            else near.push(t * 3)
          }
          const triangles = new Uint32Array([...near, ...far])
          const frame = (): Parameters<typeof buildRotaryHeightMap>[0] => ({
            axis, centre, pivot, cos, sin,
            geometry: buildRotaryRasterGeometry(mesh.positions, mesh.index, axis, centre, pivot),
          })
          const label = `${fixture.label}, ${axis} bar, cell ${cell}, A${angle}`
          for (const trackCellRise of [true, false]) {
            const plain = buildRotaryHeightMap(frame(), bbox, cell, { window, triangles, trackCellRise })
            const skipFrame = frame()
            const skipping = buildRotaryHeightMap(skipFrame, bbox, cell, {
              window, triangles, trackCellRise, farOnlyStart: near.length,
            })
            assert.deepEqual(skipping.data, plain.data, `${label}: the same cells with the far side skipped`)
            assert.equal(
              Math.min(skipping.cellRise ?? 0, cell), Math.min(plain.cellRise ?? 0, cell),
              `${label}: the same lift`,
            )
            // Armed means the raster asked for the distances; a map whose near
            // side has not reached the rise cap must not have.
            const armed = skipFrame.geometry.axisDistance !== undefined
            if (trackCellRise && far.length > 0) {
              const nearOnly = buildRotaryHeightMap(frame(), bbox, cell, {
                window, triangles: new Uint32Array(near), trackCellRise,
              })
              if ((nearOnly.cellRise ?? 0) < cell) {
                assert.equal(armed, false, `${label}: no skip before the near side reaches the rise cap`)
              }
            }
            if (armed) skippedSomewhere++
            // The far side really is the surface somewhere: without it the map differs.
            if (far.length > 0) {
              const nearOnly = buildRotaryHeightMap(frame(), bbox, cell, { window, triangles: new Uint32Array(near) })
              if (nearOnly.data.some((value, i) => !Object.is(value, plain.data[i]))) keptSomewhere++
            }
          }
        }
      }
    }
  }
  assert.ok(skippedSomewhere > 100, `the skip was armed on ${skippedSomewhere} maps`)
  assert.ok(keptSomewhere > 100, `the far side decided cells on ${keptSomewhere} maps, and every one still matched`)
  console.log(`  raster oracle: skip armed on ${skippedSomewhere} maps, far side visible on ${keptSomewhere}, all identical`)
}

// ── block 3: the sampler's rows, and where the skip is armed ────────────────
interface Pin {
  readonly label: string
  readonly stock: BarStock
  readonly mesh: RotaryModelMesh
  readonly tool: NormalizedTool
  readonly walls?: number
  readonly armed: boolean
  readonly digest: string
}

function withCollar(stock: BarStock, mesh: RotaryModelMesh): { mesh: RotaryModelMesh; walls: number } {
  const collar = shell(stock, () => 8.5, (_angle, u) => u < 0.12, 24, 9)
  return { mesh: join(mesh, collar), walls: mesh.index.length / 3 }
}

const roundX = roundStock(20, 40, 'x')
const roundY = roundStock(20, 40, 'y')
const squareX = squareStock(20, 40, 'x', { x: 0, y: 0 })
const collared = withCollar(roundX, FIXTURES[0].mesh(roundX))

const PINS: Pin[] = [
  { label: 'closed body, round X, 1 mm flat', stock: roundX, mesh: FIXTURES[0].mesh(roundX), tool: toolOf('flat_endmill', 1), armed: true, digest: 'e8f0f35983c5e677f7a364fdb94aedb84e821f31620cbca757062f9bb513e700' },
  { label: 'closed body, round Y, 1.5 mm ball', stock: roundY, mesh: FIXTURES[0].mesh(roundY), tool: toolOf('ball_endmill', 1.5), armed: true, digest: 'bb0aeca0097a851fa0cf1432224a89c6559f67213a8ed8756c43e844585c61a4' },
  { label: 'open half-shell, round X, 1 mm ball', stock: roundX, mesh: FIXTURES[1].mesh(roundX), tool: toolOf('ball_endmill', 1), armed: true, digest: 'ec843d6188087c262a740a1bbc1cbd05d4822b4304aa3812a9f570effc9ede4d' },
  { label: 'shell with a window, round Y, 1 mm flat', stock: roundY, mesh: FIXTURES[2].mesh(roundY), tool: toolOf('flat_endmill', 1), armed: true, digest: 'e4d1b850972a24dac625b59c810f536a629ce657e93b50f9d0b068faa6367247' },
  { label: 'core inside a windowed shell, square X, 2 mm ball', stock: squareX, mesh: FIXTURES[3].mesh(squareX), tool: toolOf('ball_endmill', 2), armed: true, digest: 'ed88b2a19f72c3f80dea8b01dd5548ee981574a8d55572c882a391eb99dd45c0' },
  { label: 'half tube with a blade, round X, 1 mm flat', stock: roundX, mesh: FIXTURES[4].mesh(roundX), tool: toolOf('flat_endmill', 1), armed: true, digest: '10a634857d5aa287211822e842992e3e60d4a045fecc9bcf5aed81de5a53ba73' },
  { label: 'half tube with a blade, round Y, 0.6 mm ball', stock: roundY, mesh: FIXTURES[4].mesh(roundY), tool: toolOf('ball_endmill', 0.6), armed: true, digest: '8c006ec8bd21f02992463aee4126809350f0f2aabeb97d470c18ed84523c3c20' },
  // A map that marks retained walls skips nothing.
  { label: 'closed body with a retained collar, round X, 1 mm flat', stock: roundX, mesh: collared.mesh, walls: collared.walls, tool: toolOf('flat_endmill', 1), armed: false, digest: 'f4c1c339a5370b2f6840c20083d15f21ad8e2bb0a3950fbc6605a723e2278c7a' },
  // A smooth bar never reaches the rise cap in its strip, so it skips nothing.
  { label: 'smooth bar, round X, 0.5 mm flat', stock: roundX, mesh: shell(roundX, () => 8, () => true, 180, 3), tool: toolOf('flat_endmill', 0.5), armed: false, digest: '2305101a82a05a4485f4c23e22d038a7ccf0b44e59c794d7b2465d0296e1bc34' },
]

const ALONG = Array.from({ length: 33 }, (_, i) => 12 + 16 * i / 32)
const ANGLES = Array.from({ length: 72 }, (_, k) => 2.5 + 5 * k)

for (const pin of PINS) {
  const workspace: RotarySamplingWorkspace = {}
  const prep = createRotarySamplingPrep(pin.mesh, pin.stock, pin.tool, {
    along: ALONG,
    requestedCellSize: 0.2,
    conservativeCellBounds: true,
    ...(pin.walls !== undefined ? { wallTriangleStart: pin.walls } : {}),
    workspace,
  })
  const sampled = sampleAnglesWithPrep(prep, ANGLES, [])
  assert.ok(sampled.valid, `${pin.label}: the rows sample`)
  const hash = createHash('sha256')
  for (const row of sampled.tipRadius) hash.update(new Uint8Array(row.buffer, row.byteOffset, row.byteLength))
  hash.update(new Uint8Array(new Float64Array(sampled.lifts).buffer))
  const digest = hash.digest('hex')
  assert.equal(digest, pin.digest, `${pin.label}: the rows and lifts are the ones the raster gave before the skip`)
  assert.equal(
    workspace.raster?.axisDistance !== undefined, pin.armed,
    `${pin.label}: the far-side skip ${pin.armed ? 'is' : 'is not'} armed`,
  )
  console.log(`  ${pin.label}: digest ${digest.slice(0, 16)}, skip ${pin.armed ? 'armed' : 'not armed'}`)
}

console.log('engine/toolpaths/rotaryFarSideSkip.test.ts: all assertions passed')
