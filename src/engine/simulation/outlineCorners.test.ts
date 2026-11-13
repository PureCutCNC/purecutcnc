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
 * Issue #973: the wall-outline corner texture. The rule itself is tested in
 * `heightfieldShader.test.ts`; this covers how it reaches the meshes — one
 * pass compiled from the shared GLSL, one texture every corner reader binds,
 * a refresh rectangle wide enough for the rule's reach, and wrapped grids
 * left on cell edges.
 */
import * as THREE from 'three'
import { aroundFrame, unrolledProject } from '../aroundFrame'
import { newProject, roundStock } from '../../types/project'
import { compileScalarGlsl } from './glslScalar.testSupport'
import { createSimulationGrid } from './grid'
import {
  OUTLINE_CELL_GLSL,
  OUTLINE_CORNER_GLSL,
  OUTLINE_CORNER_SHIFT_CELLS,
  OUTLINE_NORMAL_GLSL,
  OUTLINE_TANGENT_GLSL,
  OUTLINE_TURN_GLSL,
  STEP_GLSL,
} from './heightfieldShader'
import {
  OUTLINE_NORMAL_PASS_FRAGMENT_GLSL,
  OUTLINE_PASS_FRAGMENT_GLSL,
  OUTLINE_REACH_CELLS,
  outlineCornerRect,
  outlineNormalRect,
} from './outlineCorners'
import { buildSimulationStockScene } from './simulationScene'
import type { SimulationGrid } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeGrid(cols: number, rows: number): SimulationGrid {
  return {
    originX: 0, originY: 0, cellSize: 1, cols, rows,
    stockBottomZ: 0, stockTopZ: 20, topZ: new Float32Array(cols * rows).fill(20),
  } as unknown as SimulationGrid
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
    assert(!source.includes('outlineCornerTurn('), `the ${name} must read the texture, not run the rule per vertex or fragment`)
  }
  assert(boundary[2].fragmentShader.includes(OUTLINE_CELL_GLSL), 'the underside must find its cell with the shared outline lookup')

  // Wall lighting follows the smoothed outline; nothing else reads it, so it
  // can change no geometry.
  for (const wall of boundary.slice(0, 2)) {
    assert(wall.uniforms.uOutlineNormals?.value === outline.normals, 'both wall strips must bind the scene\'s smoothed normals')
    assert(wall.vertexShader.includes(OUTLINE_NORMAL_GLSL), 'both wall strips must decode the normals with the shared reader')
    assert((wall.vertexShader.split(OUTLINE_NORMAL_GLSL)[1] ?? '').includes('outlineWallNormal('), 'both wall strips must light with the smoothed normal')
  }
  for (const material of [surface, boundary[2]]) {
    assert(!('uOutlineNormals' in material.uniforms), 'the tops and the underside must not read the lighting normals')
  }
  assert(
    OUTLINE_NORMAL_PASS_FRAGMENT_GLSL.includes(OUTLINE_TANGENT_GLSL) && OUTLINE_NORMAL_PASS_FRAGMENT_GLSL.includes(OUTLINE_CORNER_GLSL),
    'the normal pass must walk the shared outline through the moved corners',
  )

  // The pass computes the codes from the meshes' own predicate.
  assert(
    OUTLINE_PASS_FRAGMENT_GLSL.includes(STEP_GLSL) && OUTLINE_PASS_FRAGMENT_GLSL.includes(OUTLINE_TURN_GLSL),
    'the corner pass must compile the shared step predicate and corner rule',
  )
  assert(OUTLINE_PASS_FRAGMENT_GLSL.includes('outlineCornerTurn('), 'the corner pass must run the rule')
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

function testRefreshRectangleCoversTheRulesReach(): void {
  console.log('Testing a height change only moves corners inside the refreshed rectangle...')
  const cols = 22
  const rows = 22
  const heights = new Float64Array(cols * rows)
  const lookup = (x: number, z: number): number =>
    x < 0 || z < 0 || x >= cols || z >= rows ? 0 : heights[z * cols + x]
  const rule = compileScalarGlsl(`${STEP_GLSL}\n${OUTLINE_TURN_GLSL}`, { cellHeightAt: lookup })
  const inGrid = (x: number, z: number): boolean => x >= 0 && z >= 0 && x <= cols && z <= rows
  const turnAt = (x: number, z: number): number => (inGrid(x, z) ? rule.outlineCornerTurn(x, z, 0, 1) as number : 0)
  const shift = (turn: number, positive: boolean): number => (turn === 0 ? 0 : positive ? OUTLINE_CORNER_SHIFT_CELLS : -OUTLINE_CORNER_SHIFT_CELLS)
  const walk = compileScalarGlsl(OUTLINE_TANGENT_GLSL, {
    cornerWallMask: (x: number, z: number) => (inGrid(x, z) ? rule.outlineCornerWallMask(x, z, 0, 1) as number : 0),
    cornerTurn: turnAt,
    cornerPositionX: (x: number, z: number) => { const t = turnAt(x, z); return x + shift(t, t === 1 || t === 3) },
    cornerPositionZ: (x: number, z: number) => { const t = turnAt(x, z); return z + shift(t, t === 1 || t === 2) },
  })
  // Each corner's turn code and smoothed direction, the two textures' contents.
  const codes = (): number[] => {
    const out: number[] = []
    for (let z = 0; z <= rows; z += 1) {
      for (let x = 0; x <= cols; x += 1) out.push(turnAt(x, z))
    }
    return out
  }
  const angles = (): number[] => {
    const out: number[] = []
    for (let z = 0; z <= rows; z += 1) {
      for (let x = 0; x <= cols; x += 1) out.push(walk.outlineTangentAngle(x, z) as number)
    }
    return out
  }
  // Deterministic pseudo-random features: discs and slanted pockets at
  // several heights, so jogs, junctions and islands all occur.
  let seed = 973
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  let moved = 0
  let relit = 0
  for (let trial = 0; trial < 40; trial += 1) {
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
    const before = codes()
    const beforeAngles = angles()
    for (let probe = 0; probe < 12; probe += 1) {
      const col = Math.floor(random() * cols)
      const row = Math.floor(random() * rows)
      const index = row * cols + col
      const saved = heights[index]
      heights[index] = [0, 5, 12, 20][Math.floor(random() * 4)]
      const after = codes()
      const afterAngles = angles()
      const rect = outlineCornerRect({ cols, rows }, { colMin: col, colMax: col, rowMin: row, rowMax: row })
      const normalRect = outlineNormalRect({ cols, rows }, rect)
      for (let z = 0; z <= rows; z += 1) {
        for (let x = 0; x <= cols; x += 1) {
          const i = z * (cols + 1) + x
          if (afterAngles[i] !== beforeAngles[i]) {
            relit += 1
            assert(
              x >= normalRect.xMin && x <= normalRect.xMax && z >= normalRect.yMin && z <= normalRect.yMax,
              `changing cell ${col},${row} relit corner ${x},${z} outside the refreshed normal rectangle`,
            )
          }
          if (after[i] === before[i]) continue
          moved += 1
          assert(
            x >= rect.xMin && x <= rect.xMax && z >= rect.yMin && z <= rect.yMax,
            `changing cell ${col},${row} moved corner ${x},${z} outside the refreshed rectangle (reach ${OUTLINE_REACH_CELLS})`,
          )
        }
      }
      heights[index] = saved
    }
  }
  assert(moved > 50, `the probes must actually change corners (${moved})`)
  assert(relit > moved, `the probes must actually change lighting further out than corners (${relit})`)
  // Clamped to the texture at the stock border.
  const edge = outlineCornerRect({ cols, rows }, { colMin: 0, colMax: cols - 1, rowMin: 0, rowMax: rows - 1 })
  assert(edge.xMin === 0 && edge.yMin === 0 && edge.xMax === cols && edge.yMax === rows, 'the rectangle stays inside the corner texture')
  console.log(`refresh rectangles: PASSED (${moved} corner and ${relit} lighting changes, all inside)`)
}

try {
  testEveryCornerReaderSharesOneTexture()
  testWrappedGridKeepsCellEdges()
  testRefreshRectangleCoversTheRulesReach()
  console.log('\nAll outline corner tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
