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

/// <reference types="node" />

/**
 * The Verify view's per-cell tint (issue #1269): the texel layout and that the
 * surface shader samples it only when a tint is passed.
 *
 * Run with: npx tsx src/engine/simulation/cellTint.test.ts
 */

import * as THREE from 'three'
import { createCellTintTexture, writeCellTint } from './cellTint'
import { createHeightfieldTexture } from './gpuMesh'
import { createHeightfieldMaterial } from './heightfieldShader'
import { buildSimulationStockScene } from './simulationScene'
import type { SimulationGrid } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function grid(): SimulationGrid {
  return {
    originX: 0, originY: 0, cellSize: 1, cols: 3, rows: 2, stockBottomZ: 0, stockTopZ: 5,
    topZ: new Float32Array(6).fill(5),
  }
}

function testTexels(): void {
  console.log('Testing tint texels follow the codes...')
  const data = new Uint8Array(12)
  writeCellTint(data, [0, 1, 2], [null, { rgb: 0xff0000, alpha: 1 }, { rgb: 0x00ff80, alpha: 0.5 }])
  assert(data[3] === 0, 'a code without a colour is transparent')
  assert(data[4] === 255 && data[5] === 0 && data[6] === 0 && data[7] === 255, 'red, opaque')
  assert(data[8] === 0 && data[9] === 255 && data[10] === 128 && data[11] === 128, 'green-cyan at half cover')
  let threw = false
  try { writeCellTint(new Uint8Array(4), [0, 1], []) } catch { threw = true }
  assert(threw, 'a buffer of the wrong size is refused')
  const texture = createCellTintTexture(grid(), [0, 1, 0, 1, 0, 1], [null, { rgb: 0xffffff, alpha: 1 }])
  assert(texture.image.width === 3 && texture.image.height === 2, 'one texel per cell')
  assert(texture.format === THREE.RGBAFormat && texture.minFilter === THREE.NearestFilter, 'RGBA8, nearest')
}

function testShader(): void {
  console.log('Testing the surface samples the tint only when one is passed...')
  const g = grid()
  const height = createHeightfieldTexture(g)
  const plain = createHeightfieldMaterial(height, g, new THREE.Color(0xffffff))
  assert(!plain.fragmentShader.includes('uCellTint') && !('uCellTint' in plain.uniforms), 'no tint: the shader is unchanged')
  const tint = createCellTintTexture(g, new Uint8Array(6), [])
  const tinted = createHeightfieldMaterial(height, g, new THREE.Color(0xffffff), undefined, undefined, undefined, undefined, null, tint)
  assert(tinted.fragmentShader.includes('texelFetch(uCellTint, vCell, 0)'), 'the tint is fetched per cell')
  assert(tinted.fragmentShader.includes('cellColor * lighting'), 'the lit colour is the tinted one')
  assert(tinted.uniforms.uCellTint.value === tint, 'the tint texture is bound')
  const scene = buildSimulationStockScene(g, new THREE.Color(0xffffff), undefined, undefined, undefined, tint)
  const surface = scene.surface as THREE.Mesh
  assert((surface.material as THREE.ShaderMaterial).uniforms.uCellTint.value === tint, 'the scene builder forwards the tint')
}

testTexels()
testShader()
console.log('cellTint tests passed')
