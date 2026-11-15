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
 * Issue #973: the wall-outline corner texture and the edge crossings it is
 * solved from. The solve itself is tested in `heightfieldShader.test.ts`; this
 * covers how the pieces reach each other — crossings created on flat grids
 * only, carried through playback's clone and reset, a dirty region that covers
 * a crossing-only change, one pass compiled from the shared GLSL, one texture
 * every corner reader binds, a refresh rectangle wide enough for the solve's
 * reach, and wrapped grids left on cell edges.
 */
import * as THREE from 'three'
import { aroundFrame, unrolledProject } from '../aroundFrame'
import { newProject, roundStock } from '../../types/project'
import { EDGE_CROSSING_STRIDE } from './edgeCrossings'
import { compileScalarGlsl } from './glslScalar.testSupport'
import { createSimulationGrid } from './grid'
import {
  OUTLINE_CELL_GLSL,
  OUTLINE_CORNER_GLSL,
  OUTLINE_NORMAL_GLSL,
  OUTLINE_WALL_GLSL,
  STEP_GLSL,
} from './heightfieldShader'
import {
  OUTLINE_PASS_FRAGMENT_GLSL,
  OUTLINE_REACH_CELLS,
  outlineCornerRect,
} from './outlineCorners'
import { PlaybackController } from './playback'
import { applyMoveToGrid, replayItemsIntoGrid } from './replay'
import { buildSimulationStockScene } from './simulationScene'
import type { SimulationGrid, SimulationReplayItem } from './types'
import type { ToolpathResult } from '../toolpaths/types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeGrid(cols: number, rows: number): SimulationGrid {
  return {
    originX: 0, originY: 0, cellSize: 1, cols, rows,
    stockBottomZ: 0, stockTopZ: 20, topZ: new Float32Array(cols * rows).fill(20),
    edgeCrossings: new Uint8Array(cols * rows * EDGE_CROSSING_STRIDE),
  }
}

function shaderMaterials(object: THREE.Object3D): THREE.ShaderMaterial[] {
  const found: THREE.ShaderMaterial[] = []
  object.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material instanceof THREE.ShaderMaterial) found.push(child.material)
  })
  return found
}

function disposeScene(group: THREE.Object3D): void {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose()
      ;(child.material as THREE.Material).dispose()
    }
  })
}

function testFlatGridsCarryCrossings(): void {
  console.log('Testing flat grids carry edge crossings through playback, and wrapped grids have none...')
  const flat = createSimulationGrid(newProject())
  assert(flat.edgeCrossings?.length === flat.cols * flat.rows * EDGE_CROSSING_STRIDE, 'a flat grid has 4 crossing bytes per cell')
  const stock = roundStock(20, 85, 'x', { x: 13, y: -17 })
  const frame = aroundFrame(stock)
  const wrapped = createSimulationGrid(unrolledProject({ ...newProject(), stock }, frame), { targetLongAxisCells: 123, wrap: { axis: 'x', period: 10 } })
  assert(wrapped.edgeCrossings === undefined, 'a wrapped grid records no crossings')

  // Playback cuts a copy and resets it from the base, crossings included.
  const base = makeGrid(30, 30)
  applyMoveToGrid(base, { kind: 'cut', from: { x: 3, y: 10.3, z: -0.1 }, to: { x: 27, y: 12.1, z: -0.1 } }, 2.2, 'flat_endmill', null)
  const baseCrossings = new Uint8Array(base.edgeCrossings!)
  assert(baseCrossings.some((byte) => byte !== 0), 'the base cut records crossings')
  const controller = new PlaybackController(base, [
    { kind: 'cut', from: { x: 3, y: 20.6, z: -0.1 }, to: { x: 27, y: 18.2, z: -0.1 } },
  ], { toolRadius: 2.2, toolType: 'flat_endmill', vBitAngle: null })
  assert(controller.liveGrid.edgeCrossings !== base.edgeCrossings, 'the live grid owns its crossings')
  applyMoveToGrid(controller.liveGrid, { kind: 'cut', from: { x: 3, y: 20.6, z: -0.1 }, to: { x: 27, y: 18.2, z: -0.1 } }, 2.2, 'flat_endmill', null)
  assert(controller.liveGrid.edgeCrossings!.some((byte, i) => byte !== baseCrossings[i]), 'cutting the live grid changes its crossings')
  assert(base.edgeCrossings!.every((byte, i) => byte === baseCrossings[i]), 'the base grid keeps its own')
  controller.reset()
  assert(controller.liveGrid.edgeCrossings!.every((byte, i) => byte === baseCrossings[i]), 'a reset restores the base crossings')
  console.log('crossings through playback: PASSED')
}

function testCrossingOnlyChangeIsDirty(): void {
  console.log('Testing a pass that moves only a crossing still reports a dirty region...')
  const grid = makeGrid(40, 40)
  const move = (y: number) => ({ kind: 'cut' as const, from: { x: -5, y, z: -0.1 }, to: { x: 45, y, z: -0.1 } })
  applyMoveToGrid(grid, move(20.1), 3, 'flat_endmill', null)
  // A second pass a fifth of a cell further out reaches no new cell centre
  // (the edge stays between rows 22 and 23), only further toward row 23.
  const heights = new Float32Array(grid.topZ)
  const crossings = new Uint8Array(grid.edgeCrossings!)
  const result = applyMoveToGrid(grid, move(20.3), 3, 'flat_endmill', null)
  assert(grid.topZ.every((z, i) => z === heights[i]), 'the second pass lowers no cell')
  assert(grid.edgeCrossings!.some((byte, i) => byte !== crossings[i]), 'the second pass moves crossings')
  assert(result.changedCount === 0 && result.dirtyRegion !== null, 'its dirty region still covers the crossings it moved')
  for (let i = 0; i < crossings.length; i += 1) {
    if (grid.edgeCrossings![i] === crossings[i]) continue
    const cell = Math.floor(i / EDGE_CROSSING_STRIDE)
    const col = cell % grid.cols
    const row = Math.floor(cell / grid.cols)
    const region = result.dirtyRegion!
    assert(col >= region.colMin && col <= region.colMax && row >= region.rowMin && row <= region.rowMax, `moved crossing at ${col},${row} inside the dirty region`)
  }
  console.log('crossing-only change: PASSED')
}

function testEveryCornerReaderSharesOneTexture(): void {
  console.log('Testing the tops, both wall strips and the underside read one corner texture...')
  const grid = makeGrid(12, 9)
  const built = buildSimulationStockScene(grid, new THREE.Color(0x8899aa))
  assert(built.outline !== null, 'a flat scene must build the outline corner pass')
  const outline = built.outline!
  assert(outline.pending, 'a new pass is stale until its first update')

  const surface = (built.surface as THREE.Mesh).material as THREE.ShaderMaterial
  const boundary = shaderMaterials(built.boundary)
  assert(boundary.length === 3, `the flat boundary has two wall strips and the underside (${boundary.length})`)
  const readers: Array<[string, THREE.ShaderMaterial, string, string]> = [
    ['top surface', surface, surface.vertexShader, 'outlineCornerOffset('],
    ...boundary.slice(0, 2).map((material): [string, THREE.ShaderMaterial, string, string] =>
      ['wall strip', material, material.vertexShader, 'outlineCornerOffset(']),
    ['underside', boundary[2], boundary[2].fragmentShader, 'outlineCellAt('],
  ]
  for (const [name, material, source, call] of readers) {
    assert(material.uniforms.uOutlineCorners?.value === outline.texture, `the ${name} must bind the scene's own corner texture`)
    assert(source.includes(OUTLINE_CORNER_GLSL), `the ${name} must place corners with the shared reader`)
    const body = source.split(OUTLINE_CORNER_GLSL)[1] ?? ''
    assert(body.includes(call), `the ${name} must call ${call.slice(0, -1)} after the shared reader`)
    assert(!source.includes('outlineCornerSolve('), `the ${name} must read the texture, not solve per vertex or fragment`)
  }
  assert(boundary[2].fragmentShader.includes(OUTLINE_CELL_GLSL), 'the underside must find its cell with the shared outline lookup')

  // The walls light from the same texture's direction channel; nothing else
  // reads it, so it can change no geometry.
  for (const wall of boundary.slice(0, 2)) {
    assert(wall.vertexShader.includes(OUTLINE_NORMAL_GLSL), 'both wall strips must decode the direction with the shared reader')
    assert((wall.vertexShader.split(OUTLINE_NORMAL_GLSL)[1] ?? '').includes('outlineWallNormal('), 'both wall strips must light with it')
  }
  for (const source of [surface.vertexShader, surface.fragmentShader, boundary[2].vertexShader, boundary[2].fragmentShader]) {
    assert(!source.includes('outlineWallNormal('), 'the tops and the underside must not read the wall direction')
  }

  // The pass solves from the meshes' own predicate and the grid's crossings.
  assert(
    OUTLINE_PASS_FRAGMENT_GLSL.includes(STEP_GLSL) && OUTLINE_PASS_FRAGMENT_GLSL.includes(OUTLINE_WALL_GLSL),
    'the corner pass must compile the shared step predicate and outline solve',
  )
  assert(OUTLINE_PASS_FRAGMENT_GLSL.includes('outlineCornerSolve(') && OUTLINE_PASS_FRAGMENT_GLSL.includes('uEdgeCrossings'), 'the corner pass must solve from the crossings')
  const image = outline.texture.image as { width: number; height: number }
  assert(image.width === grid.cols + 1 && image.height === grid.rows + 1, 'one texel per grid corner')

  outline.dispose()
  disposeScene(built.group)
  built.heightfieldTexture.dispose()
  console.log('shared corner texture: PASSED')
}

function testWrappedGridKeepsCellEdges(): void {
  console.log('Testing a wrapped grid builds no outline pass and keeps its walls on cell edges...')
  const stock = roundStock(20, 85, 'x', { x: 13, y: -17 })
  const frame = aroundFrame(stock)
  const grid = createSimulationGrid(unrolledProject({ ...newProject(), stock }, frame), { targetLongAxisCells: 123 })
  const built = buildSimulationStockScene(grid, new THREE.Color(0x8899aa), frame)
  assert(built.outline === null, 'a wrapped scene must not build an outline pass')
  for (const material of shaderMaterials(built.group)) {
    assert(!('uOutlineCorners' in material.uniforms), 'a wrapped scene must not bind a corner texture')
    assert(!material.vertexShader.includes('outlineCornerOffset(') && !material.fragmentShader.includes('outlineCellAt('),
      'a wrapped scene must compile the cell-edge shaders')
  }
  disposeScene(built.group)
  built.heightfieldTexture.dispose()
  console.log('wrapped grid: PASSED')
}

function testRefreshRectangleCoversTheSolvesReach(): void {
  console.log('Testing a change to one cell only moves corners inside the refreshed rectangle...')
  const cols = 22
  const rows = 22
  const heights = new Float64Array(cols * rows)
  const crossings = new Uint8Array(cols * rows * EDGE_CROSSING_STRIDE)
  const solve = compileScalarGlsl(`${STEP_GLSL}\n${OUTLINE_WALL_GLSL}`, {
    cellHeightAt: (x: number, z: number) => heights[Math.min(rows - 1, Math.max(0, z)) * cols + Math.min(cols - 1, Math.max(0, x))],
    cellCrossing: (x: number, z: number, channel: number) =>
      x < 0 || z < 0 || x >= cols || z >= rows ? 0 : crossings[(z * cols + x) * EDGE_CROSSING_STRIDE + channel],
  })
  // Every corner's packed texel, the texture's contents.
  const texels = (): number[] => {
    const out: number[] = []
    for (let z = 0; z <= rows; z += 1) {
      for (let x = 0; x <= cols; x += 1) out.push(solve.outlineCornerSolve(x, z, 0, 1) as number)
    }
    return out
  }
  // Deterministic pseudo-random features — discs and slanted pockets at several
  // heights — and random crossings, so walls meet at every kind of corner.
  let seed = 973
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  let moved = 0
  for (let trial = 0; trial < 30; trial += 1) {
    const cx = 4 + random() * 14
    const cz = 4 + random() * 14
    const radius = 2 + random() * 6
    const slope = random() * 2 - 1
    for (let z = 0; z < rows; z += 1) {
      for (let x = 0; x < cols; x += 1) {
        const inDisc = Math.hypot(x + 0.5 - cx, z + 0.5 - cz) < radius
        const inBand = Math.abs(z + 0.5 - cz - slope * (x + 0.5 - cx)) < 1.5
        heights[z * cols + x] = inDisc ? 5 : inBand ? 12 : 20
      }
    }
    for (let i = 0; i < crossings.length; i += 1) crossings[i] = Math.floor(random() * 256)
    const before = texels()
    for (let probe = 0; probe < 12; probe += 1) {
      const col = Math.floor(random() * cols)
      const row = Math.floor(random() * rows)
      const index = row * cols + col
      const savedHeight = heights[index]
      const savedCrossings = crossings.slice(index * EDGE_CROSSING_STRIDE, (index + 1) * EDGE_CROSSING_STRIDE)
      heights[index] = [0, 5, 12, 20][Math.floor(random() * 4)]
      for (let channel = 0; channel < EDGE_CROSSING_STRIDE; channel += 1) crossings[index * EDGE_CROSSING_STRIDE + channel] = Math.floor(random() * 256)
      const after = texels()
      const rect = outlineCornerRect({ cols, rows }, { colMin: col, colMax: col, rowMin: row, rowMax: row })
      for (let z = 0; z <= rows; z += 1) {
        for (let x = 0; x <= cols; x += 1) {
          const i = z * (cols + 1) + x
          if (after[i] === before[i]) continue
          moved += 1
          assert(
            x >= rect.xMin && x <= rect.xMax && z >= rect.yMin && z <= rect.yMax,
            `changing cell ${col},${row} moved corner ${x},${z} outside the refreshed rectangle (reach ${OUTLINE_REACH_CELLS})`,
          )
        }
      }
      heights[index] = savedHeight
      crossings.set(savedCrossings, index * EDGE_CROSSING_STRIDE)
    }
  }
  assert(moved > 50, `the probes must actually change corners (${moved})`)
  // Clamped to the texture at the stock border.
  const edge = outlineCornerRect({ cols, rows }, { colMin: 0, colMax: cols - 1, rowMin: 0, rowMax: rows - 1 })
  assert(edge.xMin === 0 && edge.yMin === 0 && edge.xMax === cols && edge.yMax === rows, 'the rectangle stays inside the corner texture')
  console.log(`refresh rectangles: PASSED (${moved} corner changes, all inside)`)
}

function testTerraceWallsAtFloat32Depths(): void {
  console.log('Testing terrace walls keep their crossings at depths float32 rounds down...')
  // A rough's terraces: a wide pass at one depth and a narrower one below it.
  // Heights are float32, so a depth such as 0.19 is stored a hair below the
  // move's own Z. The static finalizer (and the playback kernel) must still
  // see the move that cut the cell; they used to drop it, leaving a third of a
  // 3D rough's terrace walls on cell edges (#1209 testing).
  for (const [upper, lower] of [[11.4, 7.33], [9.7, 3.1], [12.3, 6.1]]) {
    assert(Math.fround(lower) < lower, 'the lower depth rounds down in float32')
    for (const playback of [false, true]) {
      const grid = makeGrid(30, 30)
      const moves = [
        { kind: 'cut' as const, from: { x: 2, y: 10.3, z: upper }, to: { x: 28, y: 13.7, z: upper } },
        { kind: 'cut' as const, from: { x: 2, y: 13.1, z: lower }, to: { x: 28, y: 16.9, z: lower } },
      ]
      if (playback) {
        for (const move of moves) applyMoveToGrid(grid, move, 3, 'flat_endmill', null)
      } else {
        replayItemsIntoGrid(grid, moves.map((move): SimulationReplayItem => ({
          operationId: 'rough', operationName: 'rough', toolRef: 't', toolType: 'flat_endmill', toolRadius: 3, vBitAngle: null,
          toolpath: { moves: [move] } as unknown as ToolpathResult,
        })))
      }
      // Every edge where the lower floor rises to the upper one has a crossing.
      let walls = 0
      let missing = 0
      for (let row = 0; row + 1 < grid.rows; row += 1) {
        for (let col = 2; col < 28; col += 1) {
          const a = grid.topZ[row * grid.cols + col]
          const b = grid.topZ[(row + 1) * grid.cols + col]
          if (Math.abs(a - b) < 1 || Math.max(a, b) > 19) continue
          walls += 1
          if (grid.edgeCrossings![(row * grid.cols + col) * EDGE_CROSSING_STRIDE + 2] === 0) missing += 1
        }
      }
      assert(walls > 10, `the terraces form walls (${walls})`)
      assert(missing === 0, `${upper}/${lower} ${playback ? 'playback' : 'static'}: ${missing} of ${walls} terrace wall edges have no crossing`)
    }
  }
  console.log('terrace walls at float32 depths: PASSED')
}

try {
  testFlatGridsCarryCrossings()
  testTerraceWallsAtFloat32Depths()
  testCrossingOnlyChangeIsDirty()
  testEveryCornerReaderSharesOneTexture()
  testWrappedGridKeepsCellEdges()
  testRefreshRectangleCoversTheSolvesReach()
  console.log('\nAll outline corner tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
