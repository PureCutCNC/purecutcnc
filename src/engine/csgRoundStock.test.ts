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
 * Round stock in the 3D scene (#392 slice D).
 *
 * A bar draws as a cylinder on its centreline and an axis-aligned block draws
 * exactly as it did before; a chuck or tailstock on a bar draws as a cylinder
 * about the bar's axis, and every other fixture (or a fixture with no stock to
 * place it on) keeps today's box.
 *
 * Scene coordinates are the viewport's: X is project x, Y is project z and Z is
 * project y, the result of the `rotateX(-π/2)` + `scale.z = -1` every fixture
 * mesh carries. The mesh's own transform is applied before measuring.
 *
 * Run with: npx tsx src/engine/csgRoundStock.test.ts
 */

import * as THREE from 'three'
import {
  rectProfile,
  roundStock,
  roundStockCentre,
  roundStockDiameter,
  type Clamp,
  type RoundStock,
  type Stock,
} from '../types/project'
import type { Units } from '../utils/units'
import {
  buildClampMesh,
  buildStockMesh,
  buildStockWireframe,
  minRenderHeight,
  profileToShape,
} from './csg'
import { THEME_PALETTES } from '../theme/palette'

const threePalette = THEME_PALETTES.dark.three
const UNITS: Units = 'mm'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertApprox(actual: number, expected: number, label: string, epsilon = 1e-6): void {
  assert(Math.abs(actual - expected) <= epsilon, `${label}: expected ${expected}, got ${actual}`)
}

/** The scene bounding box of an object with its own transform applied. */
function sceneBox(object: THREE.Object3D): THREE.Box3 {
  object.updateMatrixWorld(true)
  return new THREE.Box3().setFromObject(object)
}

function assertBoxApprox(actual: THREE.Box3, min: THREE.Vector3, max: THREE.Vector3, label: string): void {
  assertApprox(actual.min.x, min.x, `${label} min.x`)
  assertApprox(actual.min.y, min.y, `${label} min.y`)
  assertApprox(actual.min.z, min.z, `${label} min.z`)
  assertApprox(actual.max.x, max.x, `${label} max.x`)
  assertApprox(actual.max.y, max.y, `${label} max.y`)
  assertApprox(actual.max.z, max.z, `${label} max.z`)
}

function positionsOf(object: THREE.Object3D): number[] {
  const geometry = (object as THREE.Mesh | THREE.LineSegments).geometry
  const attribute = geometry.getAttribute('position')
  return Array.from(attribute.array as ArrayLike<number>)
}

function assertPositionsEqual(actual: number[], expected: number[], label: string): void {
  assert(
    actual.length === expected.length,
    `${label}: ${actual.length} positions, expected ${expected.length}`,
  )
  for (let i = 0; i < actual.length; i++) {
    assert(actual[i] === expected[i], `${label}: position ${i} is ${actual[i]}, expected ${expected[i]}`)
  }
}

/** The same stock with `shape`/`axis` removed — the block the bar stands in for. */
function blockOf(bar: RoundStock): Stock {
  return {
    profile: bar.profile,
    thickness: bar.thickness,
    material: bar.material,
    color: bar.color,
    visible: bar.visible,
    origin: bar.origin,
  }
}

/** The clamp box the code built before this slice, position for position. */
function expectedBoxClampPositions(clamp: Clamp): number[] {
  const geometry = new THREE.ExtrudeGeometry(profileToShape(rectProfile(clamp.x, clamp.y, clamp.w, clamp.h)), {
    depth: Math.max(clamp.height, minRenderHeight(UNITS)),
    bevelEnabled: false,
  })
  geometry.rotateX(-Math.PI / 2)
  return Array.from(geometry.getAttribute('position').array as ArrayLike<number>)
}

/**
 * Every vertex of a bar is either on the axis (a cylinder cap centre) or exactly
 * one radius from the centreline at scene Y = radius, across = the centreline.
 *
 * The geometry is a Float32Array, so at radius 10 one ulp is ~1e-6 and the
 * per-vertex distance carries up to ~1.4e-6 of storage error. The box extremes
 * below are exact and keep the handoff's 1e-6.
 */
const RADIUS_EPSILON = 2e-6

function assertAllVerticesAtRadius(mesh: THREE.Mesh, bar: RoundStock, label: string): void {
  mesh.updateMatrixWorld(true)
  const attribute = mesh.geometry.getAttribute('position')
  const vertex = new THREE.Vector3()
  const radius = roundStockDiameter(bar) / 2
  const centre = roundStockCentre(bar)
  const centrelineY = radius
  let rimVertices = 0

  for (let i = 0; i < attribute.count; i++) {
    vertex.fromBufferAttribute(attribute as THREE.BufferAttribute, i).applyMatrix4(mesh.matrixWorld)
    const distance = bar.axis === 'x'
      ? Math.hypot(vertex.y - centrelineY, vertex.z - centre)
      : Math.hypot(vertex.x - centre, vertex.y - centrelineY)
    if (distance <= 1e-9) continue
    rimVertices += 1
    assertApprox(distance, radius, `${label} vertex ${i} distance from centreline`, RADIUS_EPSILON)
  }

  assert(rimVertices > 0, `${label}: no vertex sits on the rim`)
}

/**
 * A round chuck/tailstock: `clamp.w`/`clamp.h` along the axis × its own diameter
 * across × its own diameter in Z, centred on the centreline at half the bar's
 * diameter.
 */
function assertRoundClampBox(clamp: Clamp, bar: RoundStock, label: string): void {
  const mesh = buildClampMesh(clamp, false, false, UNITS, threePalette, bar)
  const box = sceneBox(mesh)
  const ownDiameter = bar.axis === 'x' ? clamp.h : clamp.w
  const alongLength = bar.axis === 'x' ? clamp.w : clamp.h
  const alongFrom = bar.axis === 'x' ? clamp.x : clamp.y
  const centre = roundStockCentre(bar)
  const barRadius = roundStockDiameter(bar) / 2

  // Scene X is project x, scene Y is project z, scene Z is project y.
  const alongMin = bar.axis === 'x' ? box.min.x : box.min.z
  const alongMax = bar.axis === 'x' ? box.max.x : box.max.z
  const acrossMin = bar.axis === 'x' ? box.min.z : box.min.x
  const acrossMax = bar.axis === 'x' ? box.max.z : box.max.x

  assertApprox(alongMin, alongFrom, `${label} along-axis start`)
  assertApprox(alongMax - alongMin, alongLength, `${label} extent along the axis`)
  assertApprox(acrossMax - acrossMin, ownDiameter, `${label} own diameter across`)
  assertApprox(box.max.y - box.min.y, ownDiameter, `${label} own diameter in Z`)
  assertApprox((acrossMin + acrossMax) / 2, centre, `${label} centred on the centreline`)
  assertApprox((box.min.y + box.max.y) / 2, barRadius, `${label} centred at half the bar's diameter`)
}

function makeChuck(bar: RoundStock, id = 'chuck'): Clamp {
  const centre = roundStockCentre(bar)
  const ownDiameter = 50
  const alongLength = 55
  const height = roundStockDiameter(bar) / 2 + ownDiameter / 2
  return bar.axis === 'x'
    ? {
        id, name: 'Chuck', type: 'chuck',
        x: -40, y: centre - ownDiameter / 2, w: alongLength, h: ownDiameter,
        height, visible: true,
      }
    : {
        id, name: 'Chuck', type: 'chuck',
        x: centre - ownDiameter / 2, y: -40, w: ownDiameter, h: alongLength,
        height, visible: true,
      }
}

// ---------------------------------------------------------------------------
// 1. The bar: same box as the block it replaces, round on the centreline
// ---------------------------------------------------------------------------

for (const axis of ['x', 'y'] as const) {
  const at = { x: 5, y: 7 }
  const bar = roundStock(20, 100, axis, at)
  const block = blockOf(bar)

  const barMesh = buildStockMesh(bar, threePalette)
  const blockMesh = buildStockMesh(block, threePalette)
  const barBox = sceneBox(barMesh)
  const blockBox = sceneBox(blockMesh)

  assertBoxApprox(barBox, blockBox.min, blockBox.max, `axis ${axis} bar mesh box matches the block`)
  assertAllVerticesAtRadius(barMesh, bar, `axis ${axis} bar`)

  const barWireframe = buildStockWireframe(bar, threePalette)
  assertBoxApprox(sceneBox(barWireframe), blockBox.min, blockBox.max, `axis ${axis} bar wireframe box matches the block`)
}

// ---------------------------------------------------------------------------
// 2. A block is drawn exactly as it was before this slice
// ---------------------------------------------------------------------------

{
  const block: Stock = {
    profile: rectProfile(5, 7, 100, 20),
    thickness: 20,
    material: 'aluminum_6061',
    color: '#b9a83c',
    visible: true,
    origin: { x: 0, y: 0 },
  }

  const expectedBlockGeometry = new THREE.ExtrudeGeometry(profileToShape(block.profile), {
    depth: block.thickness,
    bevelEnabled: false,
  })
  expectedBlockGeometry.rotateX(-Math.PI / 2)
  assertPositionsEqual(
    positionsOf(buildStockMesh(block, threePalette)),
    Array.from(expectedBlockGeometry.getAttribute('position').array as ArrayLike<number>),
    'block stock mesh is unchanged',
  )

  const expectedEdges = new THREE.EdgesGeometry(expectedBlockGeometry)
  assertPositionsEqual(
    positionsOf(buildStockWireframe(block, threePalette)),
    Array.from(expectedEdges.getAttribute('position').array as ArrayLike<number>),
    'block stock wireframe is unchanged',
  )
}

// ---------------------------------------------------------------------------
// 3. A chuck / tailstock on a bar is a cylinder about the bar's axis
// ---------------------------------------------------------------------------

for (const axis of ['x', 'y'] as const) {
  const bar = roundStock(20, 100, axis, { x: 5, y: 7 })
  assertRoundClampBox(makeChuck(bar, `chuck-${axis}`), bar, `axis ${axis} chuck`)
  assertRoundClampBox(
    { ...makeChuck(bar, `tailstock-${axis}`), type: 'tailstock', name: 'Tailstock' },
    bar,
    `axis ${axis} tailstock`,
  )
}

// The explicit box for the primary case, so the mapping is spelled out once.
{
  const bar = roundStock(20, 100, 'x', { x: 5, y: 7 })
  const chuck = makeChuck(bar)
  const box = sceneBox(buildClampMesh(chuck, false, false, UNITS, threePalette, bar))
  assertBoxApprox(
    box,
    new THREE.Vector3(-40, -15, -8),
    new THREE.Vector3(15, 35, 42),
    'chuck on the x bar',
  )
}

// ---------------------------------------------------------------------------
// 4. Everything else keeps today's box
// ---------------------------------------------------------------------------

{
  const bar = roundStock(20, 100, 'x', { x: 5, y: 7 })
  const stepClamp: Clamp = {
    id: 'step', name: 'Step clamp', type: 'step_clamp',
    x: 0, y: 0, w: 20, h: 10, height: 5, visible: true,
  }
  const chuck = makeChuck(bar)

  const stepOnBar = buildClampMesh(stepClamp, false, false, UNITS, threePalette, bar)
  assertPositionsEqual(positionsOf(stepOnBar), expectedBoxClampPositions(stepClamp), 'step clamp on a bar stays a box')

  const chuckWithoutStock = buildClampMesh(chuck, false, false, UNITS, threePalette)
  assertPositionsEqual(positionsOf(chuckWithoutStock), expectedBoxClampPositions(chuck), 'chuck without a stock stays a box')

  const chuckOnBlock = buildClampMesh(chuck, false, false, UNITS, threePalette, blockOf(bar))
  assertPositionsEqual(positionsOf(chuckOnBlock), expectedBoxClampPositions(chuck), 'chuck on a block stays a box')
}

console.log('csgRoundStock.test.ts passed')
