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
 * #1185 slice L1: a link row restores the ring grid's height map instead of
 * rasterising it again, and the row it reads is the same row, bit for bit.
 *
 * An around rough links its rings along the bar at angles the ring grid has
 * already rasterised. The map depends only on the turn, so the second raster
 * was pure cost -- 472 maps and 6.0 s on the rect-stock bust. A `'read'` prep
 * takes the stored map only when it is provably its own, and reads it through
 * the full grid it was cropped from (`restoreRotaryAngleMap`).
 *
 * Every block compares against a **fresh workspace with no cache at all**, which
 * is the code path the link rows took before this slice.
 *
 * Mutations these blocks catch (each was applied and seen to fail):
 *  - returning the stored crop as it is instead of restoring it onto the row's
 *    own grid: block 1's moved-origin map gives a different row. (On an
 *    untampered map the crop's own origin read the same rows in every case
 *    tried -- 24 cutter and cell-size combinations, about half a million samples
 *    -- so the restore is the provable form, not a measured correction.)
 *  - dropping the cosine/sine check: block 3 takes a map rasterised at another
 *    angle and its row differs;
 *  - dropping the cell-size check or the window-extent check: block 4 takes a
 *    map of another grid;
 *  - dropping the wall-array check: block 5 reads a map with no wall coverage
 *    for a prep that marks walls;
 *  - dropping the cell-rise check: block 6 takes a centre-sampled map;
 *  - letting a `'read'` prep store what it builds: block 2's cache grows.
 */

import assert from 'node:assert/strict'
import { barCentre, barPivotZ, squareStock } from '../../types/barStock'
import { roundStock } from '../../types/project'
import type { BarStock } from '../../types/project'
import {
  cachedAngleKey,
  createRotarySamplingPrep,
  sampleAnglesWithPrep,
  sampleRotaryModelWithWorkspace,
} from './rotarySampling'
import type { RotaryModelMesh, RotarySampling, RotarySamplingWorkspace } from './rotarySampling'
import type { NormalizedTool } from './types'

function toolOf(type: 'ball_endmill' | 'flat_endmill', radius: number): NormalizedTool {
  return {
    id: 't1', name: 't1', sourceUnits: 'mm', units: 'mm', type,
    diameter: radius * 2, radius, vBitAngle: null, flutes: 2, material: 'carbide',
    defaultRpm: 0, defaultFeed: 0, defaultPlungeFeed: 0, defaultStepdown: 0,
    defaultStepover: 0, maxCutDepth: 0,
  }
}

/**
 * A twisted, tapered prism with `sides` flats: nothing about it repeats from
 * one angle to the next, so a map taken from the wrong turn reads differently.
 */
function twistedPrism(
  stock: BarStock, sides: number, radius: number, from: number, to: number,
): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  const rings = 9
  for (let r = 0; r < rings; r++) {
    const u = r / (rings - 1)
    const along = from + (to - from) * u
    const twist = 0.9 * u
    const ringRadius = radius * (1 - 0.3 * u) + 0.4 * Math.sin(5 * u)
    for (let j = 0; j < sides; j++) {
      const t = twist + 2 * Math.PI * j / sides
      const across = centre + ringRadius * Math.cos(t)
      const up = pivot + ringRadius * Math.sin(t)
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

/** `mesh` with a short collar appended as retained-wall triangles. */
function withCollar(stock: BarStock, mesh: RotaryModelMesh): RotaryModelMesh {
  const collar = twistedPrism(stock, 12, 8.5, 10, 12)
  const offset = mesh.positions.length / 3
  const positions = new Float32Array(mesh.positions.length + collar.positions.length)
  positions.set(mesh.positions)
  positions.set(collar.positions, mesh.positions.length)
  const index = new Uint32Array(mesh.index.length + collar.index.length)
  index.set(mesh.index)
  for (let i = 0; i < collar.index.length; i++) index[mesh.index.length + i] = collar.index[i] + offset
  return { positions, index, retainedTriangleStart: mesh.index.length / 3 }
}

const CELL = 0.1
const RING_ALONG = [13, 15, 17, 19, 21, 23, 25, 27]
/** A link row is denser than the rings and runs over the same span. */
const LINK_ALONG = Array.from({ length: 57 }, (_, i) => 13 + 14 * i / 56)
const GRID_ANGLES = Array.from({ length: 49 }, (_, k) => 360 * k / 48)

function sameRows(actual: RotarySampling, expected: RotarySampling, label: string): void {
  assert.ok(actual.valid && expected.valid, `${label}: both samplings are valid`)
  assert.equal(actual.tipRadius.length, expected.tipRadius.length, `${label}: row count`)
  for (let k = 0; k < expected.tipRadius.length; k++) {
    const a = actual.tipRadius[k]
    const e = expected.tipRadius[k]
    assert.equal(a.length, e.length, `${label}: row ${k} length`)
    for (let i = 0; i < e.length; i++) {
      assert.ok(Object.is(a[i], e[i]), `${label}: row ${k} sample ${i} is ${a[i]}, a fresh raster gives ${e[i]}`)
    }
    assert.equal(actual.lifts[k], expected.lifts[k], `${label}: row ${k} lift`)
  }
}

interface Case {
  readonly label: string
  readonly stock: BarStock
  readonly mesh: RotaryModelMesh
  readonly tool: NormalizedTool
}

function linkRow(
  c: Case, angle: number, workspace: RotarySamplingWorkspace, read: boolean,
  requestedCellSize = CELL, markWalls = true,
): RotarySampling {
  const wallTriangleStart = markWalls ? c.mesh.retainedTriangleStart : undefined
  return sampleRotaryModelWithWorkspace(c.mesh, c.stock, c.tool, {
    anglesDeg: [angle],
    along: LINK_ALONG,
    requestedCellSize,
    conservativeCellBounds: true,
    ...(wallTriangleStart !== undefined ? { wallTriangleStart } : {}),
    ...(read ? { angleMaps: 'read' as const } : {}),
  }, [], workspace)
}

/** The ring grid's pass: every map it builds goes into the workspace. */
function gridWorkspace(c: Case): RotarySamplingWorkspace {
  const workspace: RotarySamplingWorkspace = {}
  const prep = createRotarySamplingPrep(c.mesh, c.stock, c.tool, {
    along: RING_ALONG,
    requestedCellSize: CELL,
    conservativeCellBounds: true,
    ...(c.mesh.retainedTriangleStart !== undefined ? { wallTriangleStart: c.mesh.retainedTriangleStart } : {}),
    angleMaps: 'write',
    workspace,
  })
  assert.ok(sampleAnglesWithPrep(prep, GRID_ANGLES, []).valid, `${c.label}: the ring grid samples`)
  return workspace
}

const roundX = roundStock(20, 40, 'x')
const roundY = roundStock(20, 40, 'y')
const squareX = squareStock(20, 40, 'x', { x: 0, y: 0 })
const CASES: Case[] = [
  { label: 'round X, ball', stock: roundX, mesh: twistedPrism(roundX, 7, 6, 12, 28), tool: toolOf('ball_endmill', 1) },
  { label: 'round Y, flat', stock: roundY, mesh: twistedPrism(roundY, 5, 6, 12, 28), tool: toolOf('flat_endmill', 1.5) },
  { label: 'square X, ball', stock: squareX, mesh: twistedPrism(squareX, 6, 6, 12, 28), tool: toolOf('ball_endmill', 1) },
  { label: 'round X, flat, retained collar', stock: roundX, mesh: withCollar(roundX, twistedPrism(roundX, 7, 6, 12, 28)), tool: toolOf('flat_endmill', 1) },
]

/**
 * The physical angle `linkRowBudget` asks for: the commanded angle wrapped the
 * way `turnAngle` wraps it and then reduced to [0, 360).
 */
function linkKey(commanded: number): number {
  const wrapped = commanded - 360 * Math.round(commanded / 360)
  const turned = wrapped === -180 ? 180 : wrapped
  return ((turned % 360) + 360) % 360
}

// 1. A link row at a grid angle restores the grid's map and reads the same row.
{
  for (const c of CASES) {
    const workspace = gridWorkspace(c)
    const cache = workspace.angleMaps
    assert.ok(cache !== undefined && cache.maps.size > 0, `${c.label}: the grid stored its maps`)
    const stored = cache.maps.size
    const bytes = cache.bytes
    let restored = 0
    // Every grid angle as a ring boundary commands it: on the first turn, a
    // turn later, and (A360) at the seam, which is the A0 map.
    const commanded = [...GRID_ANGLES, ...GRID_ANGLES.map((angle) => angle + 360), 720, 1080]
    for (const angle of commanded) {
      const key = linkKey(angle)
      const read = linkRow(c, key, workspace, true)
      const fresh = linkRow(c, key, {}, false)
      sameRows(read, fresh, `${c.label}, link row at A${angle}`)
      if (read.reused === 1) {
        restored++
        assert.equal(read.rasterWork, 0, `${c.label}: a restored map costs no raster work`)
      }
    }
    // The seam: A360 and A720 are the A0 row, which the grid stored first.
    assert.equal(linkRow(c, linkKey(360), workspace, true).reused, 1, `${c.label}: the seam restores the A0 map`)
    // The grid's angles are 7.5 degrees apart, every one of them exact in a
    // double, so every one is a hit on the first turn and on the next.
    assert.equal(restored, commanded.length, `${c.label}: every grid-angle link row restored a map`)
    assert.equal(cache.maps.size, stored, `${c.label}: reading stored nothing`)
    assert.equal(cache.bytes, bytes, `${c.label}: reading charged nothing`)
    // The grid a restored map is read on is this row's own -- its bounds, not
    // the origin the crop recorded. A stored map whose recorded origin is wrong
    // still restores to the same row, because only its cells are taken.
    const key = cachedAngleKey(52.5)
    const kept = cache.maps.get(key)!
    cache.maps.set(key, { ...kept, originX: kept.originX + 0.37, originY: kept.originY - 0.41 })
    const moved = linkRow(c, 52.5, workspace, true)
    assert.equal(moved.reused, 1, `${c.label}: the map with a moved origin is still this turn's map`)
    sameRows(moved, linkRow(c, 52.5, {}, false), `${c.label}, link row at A52.5 from a map with a moved origin`)
  }
}

// 2. An angle the grid never sampled is rasterised as before, and a `'read'`
//    prep does not store what it builds (the helix's reuse depends on the cache
//    holding exactly what the grid put there).
{
  for (const c of CASES) {
    const workspace = gridWorkspace(c)
    const cache = workspace.angleMaps!
    const stored = cache.maps.size
    const bytes = cache.bytes
    for (const angle of [3.3, 101.01, 359.5]) {
      const read = linkRow(c, angle, workspace, true)
      sameRows(read, linkRow(c, angle, {}, false), `${c.label}, off-grid link row at A${angle}`)
      assert.equal(read.reused, 0, `${c.label}: A${angle} has no stored map`)
      assert.ok(read.rasterWork > 0, `${c.label}: A${angle} was rasterised`)
    }
    assert.equal(cache.maps.size, stored, `${c.label}: a read prep stored nothing`)
    assert.equal(cache.bytes, bytes, `${c.label}: a read prep charged nothing`)
    assert.equal(cache.full, false, `${c.label}: a read prep did not latch the cache`)
  }
  // A workspace with no cache at all is read without creating one.
  const bare: RotarySamplingWorkspace = {}
  sameRows(linkRow(CASES[0], 45, bare, true), linkRow(CASES[0], 45, {}, false), 'no cache')
  assert.equal(bare.angleMaps, undefined, 'a read prep does not create the cache')
}

// 3. A stored map is taken only at its own turn. The key rounds the angle to
//    1e-6 degrees; a map filed under this row's key but rasterised at another
//    angle is somebody else's surface.
{
  for (const c of CASES) {
    const workspace = gridWorkspace(c)
    const cache = workspace.angleMaps!
    const key = cachedAngleKey(90)
    const other = cachedAngleKey(127.5)
    assert.ok(cache.maps.has(key) && cache.maps.has(other), `${c.label}: both angles are stored`)
    // File the A127.5 map under A90's key, keeping its own exact angle.
    cache.maps.set(key, cache.maps.get(other)!)
    cache.angles.set(key, cache.angles.get(other)!)
    const read = linkRow(c, 90, workspace, true)
    assert.equal(read.reused, 0, `${c.label}: a map from another turn is not taken`)
    sameRows(read, linkRow(c, 90, {}, false), `${c.label}, link row at A90 beside a foreign map`)
    // A map with no recorded angle cannot be proven either.
    cache.angles.delete(key)
    assert.equal(linkRow(c, 90, workspace, true).reused, 0, `${c.label}: a map with no recorded angle is not taken`)
  }
}

// 4. A stored map is taken only on its own grid: another cell size is another
//    grid, and another cutter radius reads a wider window than the map holds.
{
  for (const c of CASES) {
    const workspace = gridWorkspace(c)
    const coarse = linkRow(c, 90, workspace, true, CELL * 2)
    assert.equal(coarse.reused, 0, `${c.label}: a map of another cell size is not taken`)
    sameRows(coarse, linkRow(c, 90, {}, false, CELL * 2), `${c.label}, link row at twice the cell size`)
    // A cell size close enough to give the same cell counts is still another
    // grid: every cell sits somewhere else.
    const near = linkRow(c, 90, workspace, true, CELL * 1.0005)
    assert.equal(near.reused, 0, `${c.label}: a map of a slightly different cell size is not taken`)
    sameRows(near, linkRow(c, 90, {}, false, CELL * 1.0005), `${c.label}, link row at a slightly different cell size`)
    const wide: Case = { ...c, tool: toolOf(c.tool.type === 'ball_endmill' ? 'ball_endmill' : 'flat_endmill', c.tool.radius * 2) }
    const wider = linkRow(wide, 90, workspace, true)
    assert.equal(wider.reused, 0, `${c.label}: a map with too narrow a window is not taken`)
    sameRows(wider, linkRow(wide, 90, {}, false), `${c.label}, link row with a wider cutter`)
  }
}

// 5. A stored map is taken only when it carries the wall arrays this prep's
//    raster would write: a grid sampled without the wall marking stores maps
//    with no wall coverage, and a row that marks walls must not read one.
{
  const c = CASES[3]
  const start = c.mesh.retainedTriangleStart
  assert.ok(start !== undefined, 'the collar case marks its wall triangles')
  const unmarked: RotarySamplingWorkspace = {}
  const prep = createRotarySamplingPrep(c.mesh, c.stock, c.tool, {
    along: RING_ALONG, requestedCellSize: CELL, conservativeCellBounds: true, angleMaps: 'write', workspace: unmarked,
  })
  assert.ok(sampleAnglesWithPrep(prep, GRID_ANGLES, []).valid, 'the unmarked grid samples')
  let differs = false
  for (const angle of GRID_ANGLES) {
    const marked = linkRow(c, angle % 360, unmarked, true)
    assert.equal(marked.reused, 0, `A${angle}: a map without wall coverage is not taken by a prep that marks walls`)
    const fresh = linkRow(c, angle % 360, {}, false)
    sameRows(marked, fresh, `collar, link row at A${angle} beside unmarked maps`)
    // The control: the marking does change this fixture's rows, so taking the
    // unmarked map would have been a different answer and not only a flag.
    const plain = linkRow(c, angle % 360, {}, false, CELL, false)
    if (plain.tipRadius[0].some((value, i) => !Object.is(value, fresh.tipRadius[0][i]))) differs = true
  }
  assert.ok(differs, 'the wall marking changes at least one link row of the collar fixture')
  // And the other way round: a prep that marks nothing does not take a marked map.
  const markedWorkspace = gridWorkspace(c)
  const plainRead = sampleRotaryModelWithWorkspace(c.mesh, c.stock, c.tool, {
    anglesDeg: [90], along: LINK_ALONG, requestedCellSize: CELL, conservativeCellBounds: true, angleMaps: 'read',
  }, [], markedWorkspace)
  assert.equal(plainRead.reused, 0, 'a marked map is not taken by a prep that marks no walls')
}

// 6. A stored map is taken only when it carries the cell rise this prep's lift
//    reads. A centre-sampled prep stores maps with no rise; a conservative row
//    that took one would add no lift at all.
{
  for (const c of CASES) {
    const workspace: RotarySamplingWorkspace = {}
    const centreSampled = createRotarySamplingPrep(c.mesh, c.stock, c.tool, {
      along: RING_ALONG, requestedCellSize: CELL, angleMaps: 'write', workspace,
    })
    assert.ok(sampleAnglesWithPrep(centreSampled, GRID_ANGLES, []).valid, `${c.label}: the centre-sampled grid samples`)
    assert.ok((workspace.angleMaps?.maps.size ?? 0) > 0, `${c.label}: the centre-sampled grid stored its maps`)
    const read = linkRow(c, 90, workspace, true, CELL, false)
    assert.equal(read.reused, 0, `${c.label}: a map with no cell rise is not taken by a conservative row`)
    const fresh = linkRow(c, 90, {}, false, CELL, false)
    sameRows(read, fresh, `${c.label}, conservative link row beside centre-sampled maps`)
    assert.ok(fresh.lifts[0] > 0, `${c.label}: the conservative row carries a lift the stored map could not supply`)
  }
}

console.log('engine/toolpaths/rotaryLinkRowMapReuse.test.ts: all assertions passed')
