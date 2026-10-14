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
 * Around features in the 3D scene (#395 slice G1).
 *
 * An Around subtract is a cut in the bar, its shape wound onto the round solid;
 * an Around add is an island standing inside a surrounding cut and nothing on
 * its own. A project with no visible Around feature produces the scene it
 * always did, exactly.
 *
 * Volumes are compared against the bar solid the model itself starts from
 * (`roundBarSolid`), so the comparison is against the same faceting, not an
 * idealised cylinder. Positions are compared exactly, which is what the sibling
 * round-stock tests compare.
 *
 * Run with: npx tsx src/engine/csgAroundFace.test.ts
 */

import type { Manifold as ManifoldSolid, Vec3 } from 'manifold-3d'
import * as THREE from 'three'
import {
  newProject,
  rectProfile,
  roundStock,
  roundStockCentre,
  roundStockDiameter,
  type MachiningSetup,
  type Project,
  type RoundStock,
  type SketchFeature,
  type SketchProfile,
} from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { THEME_PALETTES } from '../theme/palette'
import { aroundFrame } from './aroundFrame'
import { buildScene, getManifoldModule, roundBarGeometry, roundBarSolid, type SceneObjects } from './csg'

const threePalette = THEME_PALETTES.dark.three

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

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

/** A mesh's vertices with its own transform applied (scene coordinates). */
function worldVertices(mesh: THREE.Mesh): THREE.Vector3[] {
  mesh.updateMatrixWorld(true)
  const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
  const vertex = new THREE.Vector3()
  const out: THREE.Vector3[] = []
  for (let index = 0; index < position.count; index += 1) {
    out.push(vertex.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld).clone())
  }
  return out
}

/** One vertex of a cylinder's rim, in project coordinates. */
interface RimVertex {
  along: number
  across: number
  up: number
}

/** Every vertex on a cylinder's rim, from either a manifold mesh or a THREE geometry. */
function rimVertices(positions: ArrayLike<number>, stride: number, bar: RoundStock): RimVertex[] {
  const radius = roundStockDiameter(bar) / 2
  const centre = roundStockCentre(bar)
  const out: RimVertex[] = []
  for (let index = 0; index + 2 < positions.length; index += stride) {
    const x = positions[index]
    const y = positions[index + 1]
    const z = positions[index + 2]
    const across = (bar.axis === 'x' ? y : x) - centre
    const up = z - radius
    if (Math.abs(Math.hypot(across, up) - radius) > 1e-4) continue
    out.push({ along: bar.axis === 'x' ? x : y, across, up })
  }
  return out
}

/** How many distinct positions around the circle a rim's vertices occupy. */
function distinctRimVertices(vertices: RimVertex[]): number {
  return new Set(vertices.map((vertex) => `${vertex.across.toFixed(3)},${vertex.up.toFixed(3)}`)).size
}

/** The scene bounding box of an object with its own transform applied. */
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

function sceneSummary(scene: SceneObjects): Record<string, unknown> {
  return {
    stock: positionsOf(scene.stockMesh),
    wireframe: positionsOf(scene.stockWireframe),
    // `null` is meaningful here: it says no boolean solid was produced at all.
    model: scene.modelMesh ? positionsOf(scene.modelMesh) : null,
    featureMeshIds: [...scene.featureMeshes.keys()].sort(),
    batchedLines: scene.batchedLines.map(positionsOf),
    batchedLinesMeta: scene.batchedLinesMeta,
  }
}

const AROUND_SETUP: MachiningSetup = {
  id: 'setup-around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 },
  indexing: 'manual', registration: [], notes: '', operationIds: [],
}

// A 40 mm bar 200 mm long, off the origin like the sibling round-stock tests.
const BAR = roundStock(40, 200, 'x', { x: 10, y: 30 })
const BAR_FRAME = aroundFrame(BAR)
const Y_BAR = roundStock(40, 200, 'y', { x: 10, y: 30 })

/** Sheet-space squares and lines; z is Top-style, the surface at thickness. */
const TOP_PAD = { profile: rectProfile(20, 40, 60, 30), operation: 'add' as const, zTop: 40, zBottom: 0 }
const TOP_POCKET = { profile: rectProfile(40, 45, 20, 20), operation: 'subtract' as const, zTop: 40, zBottom: 0 }
const AROUND_POCKET = { profile: rectProfile(100, 35, 20, 15), operation: 'subtract' as const, zTop: 40, zBottom: 32 }
const AROUND_ISLAND = { profile: rectProfile(105, 38, 5, 4), operation: 'add' as const, zTop: 40, zBottom: 32 }
const AROUND_LINE: SketchProfile = {
  start: { x: 20, y: BAR_FRAME.sheetStart + 2 },
  segments: [{ type: 'line', to: { x: 180, y: BAR_FRAME.sheetStart + 1.5 * BAR_FRAME.circumference } }],
  closed: false,
}

interface Draft {
  profile: SketchProfile
  operation: SketchFeature['operation']
  zTop: number
  zBottom: number
}

function draft(id: string, spec: Draft, face: 'top' | 'around', visible = true): SketchFeature {
  return {
    id, name: id, kind: 'rect', folderId: null,
    sketch: { profile: spec.profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: spec.operation, z_top: spec.zTop, z_bottom: spec.zBottom,
    authoringFace: face, visible, locked: false,
  }
}

function barProject(bar: RoundStock, features: SketchFeature[]): Project {
  const base = projectWithFeatures({ ...newProject('around-face'), stock: bar }, features)
  return {
    ...base,
    setups: [...base.setups, { ...AROUND_SETUP, orientation: { axis: bar.axis, angleDeg: 0 } }],
    activeSetupId: base.activeSetupId,
  }
}

function topProject(bar: RoundStock, features: SketchFeature[]): Project {
  return projectWithFeatures({ ...newProject('around-face'), stock: bar }, features)
}

/** The radii and angles of a model mesh's vertices, in project coordinates. */
function modelVertices(mesh: THREE.Mesh, bar: RoundStock): { radius: number; angleDegrees: number }[] {
  mesh.updateMatrixWorld(true)
  const frame = aroundFrame(bar)
  const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
  const vertex = new THREE.Vector3()
  const readouts: { radius: number; angleDegrees: number }[] = []
  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld)
    const across = (bar.axis === 'x' ? vertex.z : vertex.x) - frame.centre
    const up = vertex.y - frame.radius
    readouts.push({
      radius: Math.hypot(across, up),
      angleDegrees: (Math.atan2(across, up) * 180) / Math.PI,
    })
  }
  return readouts
}

const R_BOTTOM = 12
const R_TOP = BAR_FRAME.radius * 1.02

/** The annular-sector volume one sheet rectangle stands for. */
function sectorVolume(spec: Draft): number {
  const along = Math.abs(spec.profile.start.x - (spec.profile.segments[0] as { to: { x: number } }).to.x)
  const across = Math.abs(spec.profile.start.y - (spec.profile.segments[2] as { to: { y: number } }).to.y)
  return along * ((across / BAR_FRAME.radius) / 2) * (R_TOP * R_TOP - R_BOTTOM * R_BOTTOM)
}

const module = await getManifoldModule()
const barSolid = roundBarSolid(module, BAR)
const BAR_VOLUME = barSolid.volume()
barSolid.delete()
const POCKET_VOLUME = sectorVolume(AROUND_POCKET)
const ISLAND_VOLUME = sectorVolume(AROUND_ISLAND)

// ── 1. A Top pad, a Top pocket and an Around pocket ──────────────────────────

{
  const withAround = await buildScene(
    topProject(BAR, [
      draft('pad', TOP_PAD, 'top'),
      draft('top-pocket', TOP_POCKET, 'top'),
      draft('around-pocket', AROUND_POCKET, 'around'),
    ]),
    threePalette,
  )
  const withoutAround = await buildScene(
    topProject(BAR, [draft('pad', TOP_PAD, 'top'), draft('top-pocket', TOP_POCKET, 'top')]),
    threePalette,
  )

  assert(withoutAround.modelMesh, 'fixture: the flat model builds a solid')
  assert(withAround.modelMesh, 'the Around pocket builds a model even beside a flat one')
  assert(
    JSON.stringify(positionsOf(withAround.modelMesh)) !== JSON.stringify(positionsOf(withoutAround.modelMesh)),
    'the Around pocket changes the model',
  )

  // The pocket's floor really is there: vertices at its bottom radius, within
  // its angular span (across 35..50 over the sheet start at 30 on a 40 mm bar).
  const vertices = modelVertices(withAround.modelMesh, BAR)
  const floor = vertices.filter((vertex) => Math.abs(vertex.radius - R_BOTTOM) < 0.05)
  assert(floor.length > 0, 'the Around pocket leaves vertices on its floor')
  const lowest = 180 * ((35 - BAR_FRAME.sheetStart) / BAR_FRAME.radius) / Math.PI
  const highest = 180 * ((50 - BAR_FRAME.sheetStart) / BAR_FRAME.radius) / Math.PI
  assert(
    floor.some((vertex) => vertex.angleDegrees >= lowest - 1 && vertex.angleDegrees <= highest + 1),
    'the pocket floor vertices are at the pocket angle',
  )

  // The flat pad really stays in the union (issue #395 G3): dropping it and
  // keeping the Around solid alone left every assertion above green, because
  // the pocket floor is part of the Around solid too. The pad spans its full
  // height at across 40..70, where the 40 mm bar's circle is narrower, so its
  // corners stand outside the bar and can only come from the flat solid. Scene
  // coordinates are X = project x, Y = project z (height), Z = project y.
  const modelWorld = worldVertices(withAround.modelMesh)
  const hasVertexAt = (corner: THREE.Vector3): boolean =>
    modelWorld.some((vertex) => vertex.distanceTo(corner) <= 1e-4)
  for (const across of [40, 70]) {
    for (const along of [20, 80]) {
      const outside = Math.hypot(across - BAR_FRAME.centre, 0 - BAR_FRAME.radius) > BAR_FRAME.radius
      assert(outside, 'fixture: the pad corner is outside the bar cylinder')
      assert(hasVertexAt(new THREE.Vector3(along, 0, across)), `the model keeps the pad's corner at x=${along}, y=${across}`)
      assert(hasVertexAt(new THREE.Vector3(along, BAR.thickness, across)), `the model keeps the pad's top corner at x=${along}, y=${across}`)
    }
  }
  const modelBox = sceneBox(withAround.modelMesh)
  const covers = (outer: THREE.Box3, inner: THREE.Box3, label: string): void => {
    for (const key of ['x', 'y', 'z'] as const) {
      assert(outer.min[key] <= inner.min[key] + 1e-3, `${label}: reaches ${key} min`)
      assert(outer.max[key] >= inner.max[key] - 1e-3, `${label}: reaches ${key} max`)
    }
  }
  covers(modelBox, sceneBox(withAround.stockMesh), 'the model covers the whole bar')
  covers(
    modelBox,
    new THREE.Box3(new THREE.Vector3(20, 0, 40), new THREE.Vector3(80, BAR.thickness, 70)),
    'the model covers the whole flat pad',
  )
}

// ── 2. An Around subtract alone, on both bar axes ────────────────────────────

for (const bar of [BAR, Y_BAR]) {
  const scene = await buildScene(
    barProject(bar, [draft('around-pocket', AROUND_POCKET, 'around')]),
    threePalette,
  )
  assert(scene.modelMesh, `axis ${bar.axis}: an Around subtract alone builds a model`)

  const modelBox = sceneBox(scene.modelMesh!)
  const barBox = sceneBox(scene.stockMesh)
  assertClose(modelBox.min.x, barBox.min.x, 1e-4, `axis ${bar.axis}: model box min.x is the bar's`)
  assertClose(modelBox.max.x, barBox.max.x, 1e-4, `axis ${bar.axis}: model box max.x is the bar's`)
  assertClose(modelBox.min.y, barBox.min.y, 1e-4, `axis ${bar.axis}: model box min.y is the bar's`)
  assertClose(modelBox.max.y, barBox.max.y, 1e-4, `axis ${bar.axis}: model box max.y is the bar's`)
  assertClose(modelBox.min.z, barBox.min.z, 1e-4, `axis ${bar.axis}: model box min.z is the bar's`)
  assertClose(modelBox.max.z, barBox.max.z, 1e-4, `axis ${bar.axis}: model box max.z is the bar's`)

  const expected = BAR_VOLUME - POCKET_VOLUME
  assertClose(meshVolume(scene.modelMesh!), expected, BAR_VOLUME * 0.005, `axis ${bar.axis}: bar minus the pocket sector`)
}

// ── 3. An Around add alone shows nothing ─────────────────────────────────────

{
  const addScene = await buildScene(barProject(BAR, [draft('island', AROUND_ISLAND, 'around')]), threePalette)
  const bareScene = await buildScene(barProject(BAR, []), threePalette)
  assert(addScene.modelMesh === null, 'an Around add alone produces no model solid')
  assert(
    JSON.stringify(sceneSummary(addScene)) === JSON.stringify(sceneSummary(bareScene)),
    'an Around add alone leaves the scene exactly as the bare bar',
  )
}

// ── 4. Subtract then add inside it; add then subtract over it ────────────────

{
  const subtractThenAdd = await buildScene(
    barProject(BAR, [
      draft('around-pocket', AROUND_POCKET, 'around'),
      draft('island', AROUND_ISLAND, 'around'),
    ]),
    threePalette,
  )
  const addThenSubtract = await buildScene(
    barProject(BAR, [
      draft('island', AROUND_ISLAND, 'around'),
      draft('around-pocket', AROUND_POCKET, 'around'),
    ]),
    threePalette,
  )
  assert(subtractThenAdd.modelMesh && addThenSubtract.modelMesh, 'fixture: both orders build a model')
  const islandStands = meshVolume(subtractThenAdd.modelMesh!)
  const islandErased = meshVolume(addThenSubtract.modelMesh!)
  assertClose(
    islandStands,
    BAR_VOLUME - POCKET_VOLUME + ISLAND_VOLUME,
    BAR_VOLUME * 0.005,
    'subtract then add inside it: the island stands',
  )
  assertClose(
    islandErased,
    BAR_VOLUME - POCKET_VOLUME,
    BAR_VOLUME * 0.005,
    'add then subtract over it: the add has no effect',
  )
  assert(islandStands > islandErased, 'the island really adds material back')

  // Restored material ends exactly at the bar's own surface: the add is
  // clipped to the bar, so nothing stands outside it in either order.
  for (const [label, mesh] of [
    ['subtract then add', subtractThenAdd.modelMesh!],
    ['add then subtract', addThenSubtract.modelMesh!],
  ] as const) {
    for (const vertex of modelVertices(mesh, BAR)) {
      assert(
        vertex.radius <= BAR_FRAME.radius + 0.01,
        `${label}: restored material stands outside the bar (radius ${vertex.radius})`,
      )
    }
  }
}

// ── 5. No visible Around feature draws nothing extra ─────────────────────────

{
  const noAround = await buildScene(
    topProject(BAR, [draft('pad', TOP_PAD, 'top'), draft('top-pocket', TOP_POCKET, 'top')]),
    threePalette,
  )
  const invisibleAround = await buildScene(
    topProject(BAR, [
      draft('pad', TOP_PAD, 'top'),
      draft('top-pocket', TOP_POCKET, 'top'),
      draft('around-pocket', AROUND_POCKET, 'around', false),
    ]),
    threePalette,
  )
  assert(
    JSON.stringify(sceneSummary(noAround)) === JSON.stringify(sceneSummary(invisibleAround)),
    'an invisible Around feature draws nothing, so the scene is unchanged',
  )
}

// ── 6. An Around line is drawn wrapped on the bar ────────────────────────────

{
  const scene = await buildScene(
    barProject(BAR, [draft('around-line', { profile: AROUND_LINE, operation: 'line', zTop: 40, zBottom: 39 }, 'around')]),
    threePalette,
  )
  const bare = await buildScene(barProject(BAR, []), threePalette)
  assert(
    scene.batchedLinesMeta.segmentCount > bare.batchedLinesMeta.segmentCount,
    'the Around line grows the batched segment count',
  )

  // Points are laid out in draw order, so the angle is unwrapped along the line
  // and a 1.5-turn run really measures more than 360°.
  const lineRadius = 40 - BAR_FRAME.radius
  const frame = BAR_FRAME
  const angleOf = (up: number, across: number): number =>
    Math.atan2(across - frame.centre, up - frame.radius)
  const wrapped = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle))
  let previous: number | null = null
  let cumulative = 0
  let minAngle = 0
  let maxAngle = 0
  let points = 0
  for (const line of scene.batchedLines) {
    const geometry = (line as THREE.Mesh).geometry
    for (let index = 0; index < geometry.getAttribute('instanceStart').count; index += 1) {
      for (const attribute of ['instanceStart', 'instanceEnd'] as const) {
        const point = geometry.getAttribute(attribute)
        const radius = Math.hypot(point.getZ(index) - frame.centre, point.getY(index) - frame.radius)
        // The batch's positions are Float32 on the way back out of the
        // LineSegmentsGeometry, so a radius of 20 carries ~1.5e-6 of error;
        // using z_bottom instead of z_top would be off by the whole 1 mm.
        assertClose(radius, lineRadius, 1e-5, 'drawn point radius')
        const angle = angleOf(point.getY(index), point.getZ(index))
        if (previous !== null) cumulative += wrapped(angle - previous)
        previous = angle
        minAngle = Math.min(minAngle, cumulative)
        maxAngle = Math.max(maxAngle, cumulative)
        points += 1
      }
    }
  }
  assert(points > 0, 'the Around line really put points on screen')
  const spanDegrees = ((maxAngle - minAngle) * 180) / Math.PI
  assert(spanDegrees > 360, `the 1.5-turn line covers more than 360°, got ${spanDegrees}`)
}

// ── 7. A full-sheet subtract: the report's timing and triangle count ─────────

{
  const fullSheet = rectProfile(10, BAR_FRAME.sheetStart, 200, BAR_FRAME.circumference)
  const started = Date.now()
  const scene = await buildScene(
    barProject(BAR, [draft('full-sheet', { profile: fullSheet, operation: 'subtract', zTop: 40, zBottom: 32 }, 'around')]),
    threePalette,
  )
  const elapsedMs = Date.now() - started
  const triangles = scene.modelMesh
    ? scene.modelMesh.geometry.getAttribute('position').count / 3
    : 0
  assert(scene.modelMesh && triangles > 0, 'a full-sheet Around subtract builds a model')
  console.log(`full-sheet subtract on a 40 × 200 mm bar: ${elapsedMs} ms, ${triangles} model triangles`)
}

// ── 8. The bar solid's facets sit on the stock mesh's (issue #395 G3) ────────

// The uncut bar's stripes come from the translucent stock mesh and the model's
// bar solid disagreeing about where the circle's vertices are. Both use
// `ROUND_BAR_SEGMENTS`, and the solid's vertices must land on the stock
// geometry's: same count around the rim, every solid vertex within 1e-6 of the
// radius of a stock vertex. `roundBarGeometry`'s own positions are pinned
// exactly by `csgRoundStock.test.ts`, so this test must not move them.
for (const bar of [BAR, Y_BAR]) {
  const solid = roundBarSolid(module, bar)
  const mesh = solid.getMesh()
  const solidRims = rimVertices(mesh.vertProperties, mesh.numProp, bar)
  const geometry = roundBarGeometry(bar)
  const geometryRims = rimVertices(
    (geometry.getAttribute('position') as THREE.BufferAttribute).array,
    3,
    bar,
  )
  solid.delete()
  geometry.dispose()

  assert(solidRims.length > 0, `axis ${bar.axis}: the bar solid has rim vertices`)
  assert(distinctRimVertices(geometryRims) > 0, `axis ${bar.axis}: the stock mesh has rim vertices`)
  assert(
    distinctRimVertices(solidRims) === distinctRimVertices(geometryRims),
    `axis ${bar.axis}: the two circles have the same number of distinct rim vertices`,
  )
  const tolerance = (roundStockDiameter(bar) / 2) * 1e-6
  for (const vertex of solidRims) {
    const nearest = Math.min(...geometryRims.map((other) =>
      Math.hypot(vertex.along - other.along, vertex.across - other.across, vertex.up - other.up),
    ))
    assert(
      nearest <= tolerance,
      `axis ${bar.axis}: a solid rim vertex is ${nearest} from the stock mesh's vertices (tolerance ${tolerance})`,
    )
  }
}

// ── 9. The bar solid releases its intermediates (issue #395 G4) ──────────────

// `roundBarSolid` builds a cylinder and a rotated copy and returns a third,
// translated solid. The first two are WASM-backed and the caller never sees
// them, so they must be released or every Around rebuild leaks two solids.
// Wrapping `cylinder` and its own `rotate` catches both; `isDeleted` is
// embind's live check, present on every handle but not in the types.

/** Whether embind has released this handle's WASM object. */
function wasDeleted(solid: ManifoldSolid): boolean {
  return (solid as unknown as { isDeleted(): boolean }).isDeleted()
}

for (const bar of [BAR, Y_BAR]) {
  const cylinders: ManifoldSolid[] = []
  const rotations: ManifoldSolid[] = []
  const originalCylinder = module.Manifold.cylinder
  module.Manifold.cylinder = ((...args: Parameters<typeof originalCylinder>) => {
    const cylinder = originalCylinder(...args)
    cylinders.push(cylinder)
    const rotate = cylinder.rotate.bind(cylinder)
    cylinder.rotate = ((...rotateArgs: [Readonly<Vec3>]) => {
      const rotated = rotate(...rotateArgs)
      rotations.push(rotated)
      return rotated
    }) as typeof cylinder.rotate
    return cylinder
  }) as typeof originalCylinder

  let returned: ManifoldSolid | null = null
  try {
    returned = roundBarSolid(module, bar)
    assert(cylinders.length === 1, `axis ${bar.axis}: roundBarSolid builds one cylinder`)
    assert(rotations.length === 1, `axis ${bar.axis}: roundBarSolid rotates it once`)
    assert(wasDeleted(cylinders[0]), `axis ${bar.axis}: the cylinder is released`)
    assert(wasDeleted(rotations[0]), `axis ${bar.axis}: the rotated solid is released`)
    assert(!wasDeleted(returned), `axis ${bar.axis}: the returned solid belongs to the caller`)
  } finally {
    module.Manifold.cylinder = originalCylinder
    returned?.delete()
  }
}

console.log('csgAroundFace.test.ts passed')
