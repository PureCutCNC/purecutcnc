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
 * Bar workholding on a square blank (issue #1016 C2-R2V).
 *
 * A chuck or tailstock stays a cylinder about the bar's axis on a square blank
 * too. Its centre sits on the **true turning pivot**, `barPivotZ` = side/2 —
 * never the corner radius side/sqrt(2) — and its own manual diameter is
 * unchanged. Because a round bar and a square blank of the same thickness share
 * the same centreline and pivot, the round mesh is position-for-position
 * identical, which is what keeps the round path byte-identical.
 *
 * Mutations these assertions were checked against, each applied on its own and
 * reverted:
 * - `roundWorkholdingGeometry` using the corner radius for the pivot → "the
 *   square chuck is centred on the true pivot" fails (and the round/square
 *   identity fails).
 *
 * Run with: npx tsx src/engine/csgSquareStock.test.ts
 */

import * as THREE from 'three'
import { rectProfile, roundStock, type Clamp, type Stock } from '../types/project'
import { barCentre, barPivotZ, squareStock, type SquareStock } from '../types/barStock'
import type { Units } from '../utils/units'
import { buildClampMesh, minRenderHeight, profileToShape } from './csg'
import { THEME_PALETTES } from '../theme/palette'

const threePalette = THEME_PALETTES.dark.three
const UNITS: Units = 'mm'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function near(actual: number, expected: number, label: string, epsilon = 1e-6): void {
  assert(Math.abs(actual - expected) <= epsilon, `${label}: expected ${expected}, got ${actual}`)
}

function sceneBox(object: THREE.Object3D): THREE.Box3 {
  object.updateMatrixWorld(true)
  return new THREE.Box3().setFromObject(object)
}

function positionsOf(object: THREE.Object3D): number[] {
  const geometry = (object as THREE.Mesh | THREE.LineSegments).geometry
  const attribute = geometry.getAttribute('position')
  return Array.from(attribute.array as ArrayLike<number>)
}

function assertPositionsEqual(actual: number[], expected: number[], label: string): void {
  assert(actual.length === expected.length, `${label}: ${actual.length} positions, expected ${expected.length}`)
  for (let i = 0; i < actual.length; i++) {
    assert(actual[i] === expected[i], `${label}: position ${i} is ${actual[i]}, expected ${expected[i]}`)
  }
}

function makeChuck(stock: SquareStock, ownDiameter = 50, alongLength = 55): Clamp {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const height = pivot + ownDiameter / 2
  return stock.axis === 'x'
    ? {
        id: 'chuck', name: 'Chuck', type: 'chuck',
        x: -40, y: centre - ownDiameter / 2, w: alongLength, h: ownDiameter,
        height, visible: true,
      }
    : {
        id: 'chuck', name: 'Chuck', type: 'chuck',
        x: centre - ownDiameter / 2, y: -40, w: ownDiameter, h: alongLength,
        height, visible: true,
      }
}

/**
 * A chuck/tailstock cylinder: `ownDiameter` in every direction except the
 * clamp's extent along the bar, centred on the centreline at the true pivot.
 */
function assertWorkholdingPlacement(stock: SquareStock, clamp: Clamp, label: string): void {
  const mesh = buildClampMesh(clamp, false, false, UNITS, threePalette, stock)
  const box = sceneBox(mesh)
  const ownDiameter = stock.axis === 'x' ? clamp.h : clamp.w
  const alongLength = stock.axis === 'x' ? clamp.w : clamp.h
  const alongFrom = stock.axis === 'x' ? clamp.x : clamp.y
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)

  const alongMin = stock.axis === 'x' ? box.min.x : box.min.z
  const alongMax = stock.axis === 'x' ? box.max.x : box.max.z
  const acrossMin = stock.axis === 'x' ? box.min.z : box.min.x
  const acrossMax = stock.axis === 'x' ? box.max.z : box.max.x

  near(alongMin, alongFrom, `${label}: along start`)
  near(alongMax - alongMin, alongLength, `${label}: extent along the bar`)
  near(acrossMax - acrossMin, ownDiameter, `${label}: own diameter across`)
  near(box.max.y - box.min.y, ownDiameter, `${label}: own diameter in Z`)
  near((acrossMin + acrossMax) / 2, centre, `${label}: centred on the bar centreline`)
  // Scene Y is project Z: the cylinder's centre must be the true pivot.
  near((box.min.y + box.max.y) / 2, pivot, `${label}: centred on the true turning pivot`)
  const cornerRadius = stock.thickness * Math.SQRT1_2
  assert(
    Math.abs((box.min.y + box.max.y) / 2 - cornerRadius) > 1e-3,
    `${label}: not floated off the blank at the corner radius`,
  )
  return
}

for (const axis of ['x', 'y'] as const) {
  const square = squareStock(20, 100, axis, { x: 5, y: 7 })
  const round = roundStock(20, 100, axis, { x: 5, y: 7 })
  const defaultChuck = makeChuck(square)
  assertWorkholdingPlacement(square, defaultChuck, `axis ${axis} square default chuck`)
  assertWorkholdingPlacement(
    square,
    { ...defaultChuck, type: 'tailstock', name: 'Tailstock' },
    `axis ${axis} square default tailstock`,
  )

  // Manual dimensions keep their published size and still centre on the pivot.
  const manualOwn = 30
  const manual = makeChuck(square, manualOwn, 40)
  assertWorkholdingPlacement(square, manual, `axis ${axis} square manual chuck`)
  const manualBox = sceneBox(buildClampMesh(manual, false, false, UNITS, threePalette, square))
  near(manualBox.max.y - manualBox.min.y, manualOwn, `axis ${axis} manual diameter is unchanged`)

  // The round path is byte-identical: the same physical box draws the same
  // cylinder, on the same pivot, vertex for vertex.
  assertPositionsEqual(
    positionsOf(buildClampMesh(defaultChuck, false, false, UNITS, threePalette, square)),
    positionsOf(buildClampMesh({ ...defaultChuck }, false, false, UNITS, threePalette, round)),
    `axis ${axis}: the round and square bar workholding are identical`,
  )

  // A non-workholding fixture stays the ordinary box on a square blank too.
  const stepClamp: Clamp = {
    id: 'step', name: 'Step clamp', type: 'step_clamp',
    x: 0, y: 0, w: 20, h: 10, height: 5, visible: true,
  }
  const expected = new THREE.ExtrudeGeometry(profileToShape(rectProfile(stepClamp.x, stepClamp.y, stepClamp.w, stepClamp.h)), {
    depth: Math.max(stepClamp.height, minRenderHeight(UNITS)),
    bevelEnabled: false,
  })
  expected.rotateX(-Math.PI / 2)
  assertPositionsEqual(
    positionsOf(buildClampMesh(stepClamp, false, false, UNITS, threePalette, square)),
    Array.from(expected.getAttribute('position').array as ArrayLike<number>),
    `axis ${axis}: a step clamp stays a box on a square blank`,
  )

  // The block path is untouched.
  const block: Stock = {
    profile: rectProfile(5, 7, 100, 20),
    thickness: 20,
    material: 'aluminum_6061',
    color: '#b9a83c',
    visible: true,
    origin: { x: 0, y: 0 },
  }
  assertPositionsEqual(
    positionsOf(buildClampMesh(defaultChuck, false, false, UNITS, threePalette, block)),
    (() => {
      const geometry = new THREE.ExtrudeGeometry(profileToShape(rectProfile(defaultChuck.x, defaultChuck.y, defaultChuck.w, defaultChuck.h)), {
        depth: Math.max(defaultChuck.height, minRenderHeight(UNITS)),
        bevelEnabled: false,
      })
      geometry.rotateX(-Math.PI / 2)
      return Array.from(geometry.getAttribute('position').array as ArrayLike<number>)
    })(),
    `axis ${axis}: a block keeps the ordinary clamp box`,
  )
}

console.log('csg square stock workholding tests passed')
