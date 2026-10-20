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
 * The bar seeds the model on every face of a rotary project (#1054 slice 1).
 *
 * A rotary project's stock is its part: a Top subtract cuts the bar directly,
 * a Bottom subtract cuts the same bar from its own face, an add restores
 * material clipped to the bar, and an Around cut applies to that same solid. So
 * one model shows all three faces, its volume is the bar's minus the pockets'
 * and its bounds are the bar's own. A block project — milling or plasma — keeps
 * the base-add CSG byte for byte, which the committed baseline pins.
 *
 * Pocket volumes are independent closed-form numbers (a rectangle times its
 * depth, an annular sector), never measured from the solid they check.
 *
 * Mutations these assertions were checked against, each applied on its own and
 * reverted:
 * - removing the bar seed (`buildBarModelSolid` yields no solid) → the model
 *   assertion fails, and no flat face has material to cut;
 * - skipping the Around slabs on the shared solid → the round volume is short
 *   by the Around pocket;
 * - unioning an add without clipping it to the bar → the clipping check fails
 *   in `csgAroundFace.test.ts`;
 * - seeding the square blank with the round cylinder → the square volume and
 *   bounds fail.
 *
 * Run with: npx tsx src/engine/csgRotaryBarSeed.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { newProject, rectProfile, roundStock, type Project, type SketchFeature, type SketchProfile, type StockAxis } from '../types/project'
import { squareStock } from '../types/barStock'
import { projectWithFeatures } from '../test/projectFixtures'
import { THEME_PALETTES } from '../theme/palette'
import { buildScene, barStockSolid, getManifoldModule, squareBarSolid, type SceneObjects } from './csg'

const threePalette = THEME_PALETTES.dark.three

function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual} (tolerance ${tolerance})`,
  )
}

function positionsOf(object: THREE.Object3D): number[] {
  const attribute = (object as THREE.Mesh).geometry.getAttribute('position')
  return Array.from(attribute.array as ArrayLike<number>)
}

function sceneBox(object: THREE.Object3D): THREE.Box3 {
  object.updateMatrixWorld(true)
  return new THREE.Box3().setFromObject(object)
}

/** A closed mesh's volume, in scene units, from the divergence theorem. */
function meshVolume(mesh: THREE.Mesh): number {
  mesh.updateMatrixWorld(true)
  const indexed = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry
  const position = indexed.getAttribute('position')
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  let volume = 0
  for (let index = 0; index < position.count; index += 3) {
    a.fromBufferAttribute(position as THREE.BufferAttribute, index).applyMatrix4(mesh.matrixWorld)
    b.fromBufferAttribute(position as THREE.BufferAttribute, index + 1).applyMatrix4(mesh.matrixWorld)
    c.fromBufferAttribute(position as THREE.BufferAttribute, index + 2).applyMatrix4(mesh.matrixWorld)
    volume += a.dot(b.clone().cross(c)) / 6
  }
  return Math.abs(volume)
}

/** The bar's length along its axis and the side across it. */
const BAR_LENGTH = 200
const BAR_SIDE = 40
const BAR_AT = { x: 10, y: 30 }

/** The along coordinate of the bar's near end. */
function alongOrigin(axis: StockAxis): number {
  return axis === 'x' ? BAR_AT.x : BAR_AT.y
}

/** The centreline's coordinate across the bar, in project X or Y. */
function acrossCentre(axis: StockAxis): number {
  return axis === 'x' ? BAR_AT.y + BAR_SIDE / 2 : BAR_AT.x + BAR_SIDE / 2
}

/** A profile placed by `along` from the bar's near end and `across` from the box's. */
function barRect(
  axis: StockAxis,
  along: number,
  across: number,
  alongLength: number,
  acrossLength: number,
): SketchProfile {
  return axis === 'x'
    ? rectProfile(along, across, alongLength, acrossLength)
    : rectProfile(across, along, acrossLength, alongLength)
}

interface Pocket {
  profile: SketchProfile
  zTop: number
  zBottom: number
  volume: number
}

/**
 * Three pockets that do not overlap, each wholly inside the bar: one cut from
 * the Top face, one from the Bottom face, and one wrapped on the Around sheet.
 * `top` starts below the crown so its whole footprint is material, and all
 * three are well inside the diameter at their widest across offset.
 */
function pockets(axis: StockAxis): { top: Pocket; bottom: Pocket; around: Pocket } {
  const start = alongOrigin(axis)
  const across = acrossCentre(axis)
  const top: Pocket = {
    profile: barRect(axis, start + 20, across - 10, 20, 20),
    zTop: 36,
    zBottom: 10,
    volume: 20 * 20 * (36 - 10),
  }
  const bottom: Pocket = {
    profile: barRect(axis, start + 80, across - 10, 20, 20),
    zTop: 12,
    zBottom: 4,
    volume: 20 * 20 * (12 - 4),
  }
  // Sheet heights 32..38 are radii 12..18 on the 40 mm bar; a 10 mm across
  // span is half a radian of turn (`distance / radius`).
  const around: Pocket = {
    profile: barRect(axis, start + 130, across - 5, 40, 10),
    zTop: 38,
    zBottom: 32,
    volume: 40 * ((10 / (BAR_SIDE / 2)) / 2) * (18 * 18 - 12 * 12),
  }
  return { top, bottom, around }
}

function pocketFeature(id: string, pocket: Pocket, face: 'top' | 'bottom' | 'around'): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: { profile: pocket.profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: pocket.zTop,
    z_bottom: pocket.zBottom,
    authoringFace: face,
    visible: true,
    locked: false,
  }
}

function rotaryProject(stock: Project['stock'], features: SketchFeature[]): Project {
  const base = projectWithFeatures({ ...newProject('bar-seed', 'mm'), stock }, features)
  base.meta.projectType = 'rotary'
  return base
}

const module = await getManifoldModule()

// ── 1. Round bar, both axes: one solid from three faces ──────────────────────

for (const axis of ['x', 'y'] as const) {
  const bar = roundStock(BAR_SIDE, BAR_LENGTH, axis, BAR_AT)
  const { top, bottom, around } = pockets(axis)
  const scene = await buildScene(
    rotaryProject(bar, [
      pocketFeature('top', top, 'top'),
      pocketFeature('bottom', bottom, 'bottom'),
      pocketFeature('around', around, 'around'),
    ]),
    threePalette,
  )
  assert(scene.modelMesh, `round/${axis}: the bar seeds a model`)

  const barSolid = barStockSolid(module, bar)
  const barVolume = barSolid.volume()
  barSolid.delete()

  const expected = barVolume - top.volume - bottom.volume - around.volume
  assertClose(meshVolume(scene.modelMesh!), expected, barVolume * 0.005, `round/${axis}: bar minus the three pockets`)

  // The model is the bar's own extent: the pockets are cut into it, never
  // added beside it.
  const modelBox = sceneBox(scene.modelMesh!)
  const barBox = sceneBox(scene.stockMesh)
  for (const key of ['x', 'y', 'z'] as const) {
    assertClose(modelBox.min[key], barBox.min[key], 1e-4, `round/${axis}: model reaches ${key} min with the bar`)
    assertClose(modelBox.max[key], barBox.max[key], 1e-4, `round/${axis}: model reaches ${key} max with the bar`)
  }
  // Every vertex is on or inside the bar's surface.
  scene.modelMesh!.updateMatrixWorld(true)
  const radius = BAR_SIDE / 2
  const centre = acrossCentre(axis)
  const start = alongOrigin(axis)
  const position = scene.modelMesh!.geometry.getAttribute('position') as THREE.BufferAttribute
  const vertex = new THREE.Vector3()
  const world: THREE.Vector3[] = []
  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position, index).applyMatrix4(scene.modelMesh!.matrixWorld)
    world.push(vertex.clone())
    const across = axis === 'x' ? vertex.z : vertex.x
    const up = vertex.y - radius
    assert(
      Math.hypot(across - centre, up) <= radius + 0.01,
      `round/${axis}: a vertex (${index}) stands outside the bar`,
    )
  }

  // Each pocket's floor is on the stock-space Z its authoring face gave it:
  // the Top pocket (z 36 → 10) bottoms out at 10 and the Bottom pocket
  // (z 4 → 12, cut from the underside) at 12. World Y is project Z, so a
  // mishandled Bottom frame would move the floor.
  const alongOf = (point: THREE.Vector3): number => (axis === 'x' ? point.x : point.z)
  const acrossOf = (point: THREE.Vector3): number => (axis === 'x' ? point.z : point.x)
  const floorAt = (z: number, alongFrom: number, alongTo: number): boolean => world.some((point) => (
    Math.abs(point.y - z) <= 1e-3
    && alongOf(point) >= alongFrom - 1e-3 && alongOf(point) <= alongTo + 1e-3
    && Math.abs(acrossOf(point) - centre) <= 10 + 1e-3
  ))
  assert(floorAt(10, start + 20, start + 40), `round/${axis}: the Top pocket floor is at stock z 10`)
  assert(floorAt(12, start + 80, start + 100), `round/${axis}: the Bottom pocket floor is at stock z 12`)
}

// ── 2. Square blank, both axes: the prism seeds the model ────────────────────

for (const axis of ['x', 'y'] as const) {
  const blank = squareStock(BAR_SIDE, BAR_LENGTH, axis, BAR_AT)
  const { top, bottom } = pockets(axis)
  const scene = await buildScene(
    rotaryProject(blank, [
      pocketFeature('top', top, 'top'),
      pocketFeature('bottom', bottom, 'bottom'),
    ]),
    threePalette,
  )
  assert(scene.modelMesh, `square/${axis}: the blank seeds a model`)

  const expected = BAR_LENGTH * BAR_SIDE * BAR_SIDE - top.volume - bottom.volume
  assertClose(meshVolume(scene.modelMesh!), expected, expected * 0.0001, `square/${axis}: blank minus the two pockets`)

  const modelBox = sceneBox(scene.modelMesh!)
  const barBox = sceneBox(scene.stockMesh)
  for (const key of ['x', 'y', 'z'] as const) {
    assertClose(modelBox.min[key], barBox.min[key], 1e-4, `square/${axis}: model reaches ${key} min with the blank`)
    assertClose(modelBox.max[key], barBox.max[key], 1e-4, `square/${axis}: model reaches ${key} max with the blank`)
  }
}

// ── 3. The square prism itself: the blank's box, about the true pivot ────────

for (const axis of ['x', 'y'] as const) {
  const blank = squareStock(BAR_SIDE, BAR_LENGTH, axis, BAR_AT)
  const solid = squareBarSolid(module, blank)
  try {
    assertClose(solid.volume(), BAR_LENGTH * BAR_SIDE * BAR_SIDE, 1e-6, `square/${axis}: prism volume is length × side²`)
    const box = solid.boundingBox()
    assert(box, `square/${axis}: the prism has a bounding box`)
    const expected = axis === 'x'
      ? { min: [BAR_AT.x, BAR_AT.y, 0], max: [BAR_AT.x + BAR_LENGTH, BAR_AT.y + BAR_SIDE, BAR_SIDE] }
      : { min: [BAR_AT.x, BAR_AT.y, 0], max: [BAR_AT.x + BAR_SIDE, BAR_AT.y + BAR_LENGTH, BAR_SIDE] }
    for (let index = 0; index < 3; index += 1) {
      assertClose(box.min[index], expected.min[index], 1e-6, `square/${axis}: prism min[${index}]`)
      assertClose(box.max[index], expected.max[index], 1e-6, `square/${axis}: prism max[${index}]`)
    }
  } finally {
    solid.delete()
  }
}

// ── 4. Block projects are byte-identical to the base CSG ─────────────────────

/** The baseline captured on the base commit (integration @ f14e0ed3). */
const baseline = JSON.parse(
  readFileSync(new URL('./test-fixtures/csg-block-baseline.json', import.meta.url), 'utf8'),
) as { milling: number[]; plasma: number[] }

function blockFeature(
  id: string,
  operation: SketchFeature['operation'],
  x: number,
  y: number,
  w: number,
  h: number,
  zBottom: number,
  zTop: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: { profile: rectProfile(x, y, w, h), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation,
    z_top: zTop,
    z_bottom: zBottom,
    authoringFace: 'top',
    visible: true,
    locked: false,
  }
}

async function blockScene(projectType: 'milling' | 'plasma', features: SketchFeature[]): Promise<SceneObjects> {
  const base = newProject('block', 'mm')
  const project = projectWithFeatures({ ...base, meta: { ...base.meta, projectType } }, features)
  return buildScene(project, threePalette)
}

{
  const milling = await blockScene('milling', [
    blockFeature('base', 'add', 10, 10, 60, 50, 0, 20),
    blockFeature('pocket', 'subtract', 25, 20, 20, 20, 8, 20),
    blockFeature('island', 'add', 30, 25, 10, 10, 8, 14),
  ])
  assert(milling.modelMesh, 'milling: the block fixture builds a model')
  assert.deepEqual(positionsOf(milling.modelMesh!), baseline.milling, 'milling: the CSG output deep-equals the base')

  const plasma = await blockScene('plasma', [
    blockFeature('cut', 'subtract', 15, 15, 40, 30, 0, 20),
    blockFeature('island', 'add', 25, 25, 10, 10, 0, 20),
  ])
  assert(plasma.modelMesh, 'plasma: the block fixture builds a model')
  assert.deepEqual(positionsOf(plasma.modelMesh!), baseline.plasma, 'plasma: the CSG output deep-equals the base')
}

// ── 5. A block still needs its base add: a lone subtract draws nothing ───────

{
  const milling = await blockScene('milling', [
    blockFeature('pocket', 'subtract', 25, 20, 20, 20, 8, 20),
  ])
  assert.equal(milling.modelMesh, null, 'a milling project with no add has no material to cut')
}

console.log('csgRotaryBarSeed.test.ts passed')
