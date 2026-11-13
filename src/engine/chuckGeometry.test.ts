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
import { test } from 'node:test'
import * as THREE from 'three'
import { buildClampMesh } from './csg'
import { defaultRoundWorkholding } from '../store/helpers/roundWorkholding'
import { roundStock, getStockBounds, type Clamp } from '../types/project'
import { barCentre, barPivotZ, squareStock } from '../types/barStock'

test('the shared 3D and Simulation entry draws 3, 4 and 6 gripping jaws on X and Y, with legacy geometry retained', () => {
  for (const axis of ['x', 'y'] as const) for (const square of [false, true]) {
    const stock = square ? squareStock(20, 100, axis) : roundStock(20, 100, axis)
    const clamp: Clamp = { id: 'c', name: 'Chuck', visible: true, ...defaultRoundWorkholding('chuck', stock, 'mm') }
    let previousCount = 0
    for (const jawCount of [3, 4, 6] as const) {
      const mesh = buildClampMesh({ ...clamp, chuck: { ...clamp.chuck, jawCount } }, false, false, 'mm', undefined, stock)
      const count = mesh.geometry.getAttribute('position').count
      if (previousCount) assert.equal(count - previousCount, (jawCount === 4 ? 1 : 2) * 36)
      previousCount = count
      mesh.geometry.computeBoundingBox()
      const box = mesh.geometry.boundingBox!
      assert.ok(Math.abs((axis === 'x' ? box.min.x : box.min.z) - (axis === 'x' ? clamp.x : -clamp.y - clamp.h)) < 1e-4)
      assert.ok(Math.abs(box.max.y - (barPivotZ(stock) + (axis === 'x' ? clamp.h : clamp.w) / 2)) < 1e-4)
      // The first jaw's inner plane is tangent to the bar/flat, never to the body.
      const vertices = mesh.geometry.getAttribute('position')
      const front = axis === 'x' ? clamp.x + clamp.w : clamp.y
      let touches = false
      for (let i = 0; i < vertices.count; i++) {
        const along = axis === 'x' ? vertices.getX(i) : -vertices.getZ(i)
        const across = axis === 'x' ? -vertices.getZ(i) : vertices.getX(i)
        const firstJawAcross = barCentre(stock) + (axis === 'x' ? -1 : 1) * 10
        if (Math.abs(along - front) < 1e-4 && Math.abs(across - firstJawAcross) < 1e-4) touches = true
      }
      assert.ok(touches, `${axis} square=${square}: jaw meets bar at radius 10`)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    const legacy = { ...clamp }; delete legacy.chuck
    const mesh = buildClampMesh(legacy, false, false, 'mm', undefined, stock)
    assert.ok(mesh.geometry instanceof THREE.CylinderGeometry)
    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
  }
})

test('jaws still face the bar when a Bottom setup turns the chuck to the other end', () => {
  for (const axis of ['x', 'y'] as const) {
    const stock = roundStock(20, 100, axis)
    const original: Clamp = { id: 'c', name: 'Chuck', visible: true, ...defaultRoundWorkholding('chuck', stock, 'mm') }
    const bounds = getStockBounds(stock)
    const clamp = axis === 'x'
      ? { ...original, x: bounds.maxX - 15 }
      : { ...original, y: bounds.minY - original.h + 15 }
    const mesh = buildClampMesh(clamp, false, false, 'mm', undefined, stock)
    const vertices = mesh.geometry.getAttribute('position')
    const front = axis === 'x' ? clamp.x : clamp.y + clamp.h
    let insideAtFront = false
    for (let i = 0; i < vertices.count; i++) {
      const along = axis === 'x' ? vertices.getX(i) : -vertices.getZ(i)
      const across = axis === 'x' ? -vertices.getZ(i) : vertices.getX(i)
      if (Math.abs(along - front) < 1e-4 && Math.abs(Math.abs(across - barCentre(stock)) - 10) < 1e-4) insideAtFront = true
    }
    assert.ok(insideAtFront, `${axis}: jaws face inward at the reversed end`)
    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
  }
})
