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
 * The static lower half of a round bar on a flat Top or Bottom setup (issue
 * #1049): the fixed surface that replaces the heightfield's straight vertical
 * sides below the equator.
 *
 * The scene test builds the real setup input, the real grid and then the same
 * `buildSimulationStockScene` the static and playback views mount, so a
 * descriptor that stops reaching the renderer or a builder that stops
 * returning the half-cylinder fails here. The two viewport mounts themselves
 * are exercised in the browser spec `e2e/flatRoundBarLowerHalf.smoke.spec.ts`.
 * Every expected dimension is derived from the bar's own geometry, written out
 * in this file.
 *
 * It also pins the join the next screenshot found (issue #1049 follow-up): a
 * flat round bar draws no stock-underside quad, its walls land on the static
 * lower half instead of floating at the equator, and only the round-bar wall
 * variant changes — block and square scenes are compared by hash. The review
 * added the silhouette case: a grid whose last material boundary falls inside
 * the radius, exactly on it, or beyond it must still meet the lower half with
 * no gap and no overlap past 2e-4 units (Ø40/Ø41 mm and 1.52/1.55 in at 96
 * cells, both bar axes).
 *
 * Mutations these assertions were checked against, each applied on its own
 * from a `cp` backup and reverted:
 * - `flatRoundBarFor` returning the bounding-box profile again (dropping the
 *   descriptor) → `x/mm/top: the setup input carries the flat round-bar profile`;
 * - the builder rendering the full cylinder (`theta` from 0 to π instead of
 *   π to 2π) → `... every vertex is at or below the equator`;
 * - adding the floor quad back for a flat round bar → `round bar: the boundary
 *   is the two wall strips, no floor quad`;
 * - replacing the cylinder floor with the equator plane → `the round-bar wall
 *   shader takes its floor from the tested join rule`;
 * - dropping the silhouette clamp from the wall shader → `the wall shader joins
 *   the silhouette with the tested rule`;
 * - not adding the lower half to the built scene group → `the scene builder
 *   mounts the static lower half`.
 *
 * Run with: npx tsx src/engine/simulation/flatRoundBarLowerHalf.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as THREE from 'three'
import {
  getStockBounds,
  newProject,
  roundStock,
  type MachiningSetup,
  type Project,
  type SetupFace,
  type Stock,
  type StockAxis,
} from '../../types/project'
import { normalizeSquareStock, squareStock } from '../../types/barStock'
import { createSimulationGrid } from './grid'
import {
  createFlatRoundBarLowerHalf,
  FLAT_ROUND_BAR_LOWER_HALF_NAME,
  FLAT_ROUND_BAR_RADIAL_SEGMENTS,
} from './flatRoundBarLowerHalf'
import { createHeightfieldTexture } from './gpuMesh'
import { createInstancedBoundaryGroup, ROUND_BAR_WALL_JOIN_GLSL } from './instancedBoundary'
import { ROUND_BAR_SILHOUETTE_GLSL } from './heightfieldShader'
import { buildSimulationStockScene } from './simulationScene'
import { compileScalarGlsl } from './glslScalar.testSupport'
import type { FlatRoundBarDescriptor, SimulationGrid } from './types'
import { buildSimulationSetupInput } from '../../app/simulationSetup'
import { simulationBuildOptions } from '../../app/simulationCompute'

const DETAIL = 96
const EPSILON = 1e-4
const COLOR = new THREE.Color('#b9a83c')
/** The reported scene's detail slider: 4 in × 2 in at 240 cells along the long axis. */
const REPORTED_DETAIL = 240
/** Block and square boundary scenes from before the join change, byte for byte. */
const BLOCK_SCENE_HASH = 'afc35f6f6f5f4259374e58f409702aad1dcd7f1f53a706de94250df95ed2de99'
const SQUARE_SCENE_HASH = 'd763c33ed33b00b43a013e92d24101adbc1da7153b95557e48b9d47fd592cf91'


function approx(actual: number, expected: number, label: string, epsilon = EPSILON): void {
  assert(
    Math.abs(actual - expected) <= epsilon,
    `${label}: expected ${expected}, got ${actual} (delta ${actual - expected})`,
  )
}

function faceSetup(face: SetupFace): MachiningSetup {
  return {
    id: face === 'bottom' ? 'setup-bottom' : 'setup-top',
    name: face === 'bottom' ? 'Bottom' : 'Top',
    orientation: { axis: 'x', angleDeg: face === 'bottom' ? 180 : 0 },
    indexing: 'manual',
    registration: [],
    notes: '',
    operationIds: [],
  }
}

function flatProject(stock: Stock, units: 'mm' | 'inch' = 'mm'): Project {
  const project = newProject('flat-bar-scene', units)
  project.stock = stock
  project.setups = [faceSetup('top'), faceSetup('bottom')]
  project.activeSetupId = faceSetup('top').id
  return project
}

interface BarFixture {
  project: Project
  axis: StockAxis
  diameter: number
  length: number
  centre: number
}

function barFixture(axis: StockAxis, diameter: number, units: 'mm' | 'inch' = 'mm'): BarFixture {
  const length = units === 'mm' ? 200 : 8
  const at = axis === 'x' ? { x: 10, y: 30 } : { x: 30, y: 10 }
  const stock = roundStock(diameter, length, axis, at)
  const bounds = getStockBounds(stock)
  return {
    project: flatProject(stock, units),
    axis,
    diameter,
    length,
    centre: axis === 'x' ? (bounds.minY + bounds.maxY) / 2 : (bounds.minX + bounds.maxX) / 2,
  }
}

function setupSimulation(fixture: BarFixture, face: SetupFace): {
  input: NonNullable<ReturnType<typeof buildSimulationSetupInput>>
  grid: SimulationGrid
} {
  return setupSimulationAt(fixture, face, DETAIL)
}

function setupSimulationAt(fixture: BarFixture, face: SetupFace, detail: number): {
  input: NonNullable<ReturnType<typeof buildSimulationSetupInput>>
  grid: SimulationGrid
} {
  const setup = fixture.project.setups.find((entry) => entry.id === faceSetup(face).id)!
  const input = buildSimulationSetupInput(fixture.project, setup, new Map())
  assert(input, `${fixture.axis}/${face}: the setup yields a simulation input`)
  return { input, grid: createSimulationGrid(input.project, simulationBuildOptions(input, detail)) }
}

/** Signed distance of a vertex from the bar's axis, in the cross-section. */
function crossSectionRadius(
  descriptor: FlatRoundBarDescriptor,
  position: { along: number; across: number; up: number },
): number {
  return Math.hypot(position.across - descriptor.centre, position.up - descriptor.pivot)
}

interface Vertex {
  along: number
  across: number
  up: number
}

function verticesOf(mesh: THREE.Mesh, axis: 'x' | 'y'): Vertex[] {
  const positions = mesh.geometry.getAttribute('position')
  const vertices: Vertex[] = []
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index)
    const y = positions.getY(index)
    const z = positions.getZ(index)
    vertices.push(axis === 'x'
      ? { along: x, across: z, up: y }
      : { along: z, across: x, up: y })
  }
  return vertices
}

function meshesOf(group: THREE.Group): THREE.Mesh[] {
  return group.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh)
}

function wallMeshesOf(group: THREE.Group): THREE.Mesh[] {
  return meshesOf(group).filter((mesh) => mesh.geometry instanceof THREE.InstancedBufferGeometry)
}

function disposeBoundary(group: THREE.Group, texture: THREE.DataTexture): void {
  for (const mesh of meshesOf(group)) {
    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
  }
  texture.dispose()
}

/**
 * Frank's own rotary file, `rotary-polygon-test-01.camj`, reduced to the
 * geometry the screenshot showed: a 4 in long, 2 in diameter round bar along X
 * whose stock box is the bar's bounding box. At the detail slider's steps the
 * grid fits the bar exactly, so every cell holds material and the sheet seen
 * under the bar can only be the stock-underside quad.
 */
function reportedFixture(): BarFixture {
  const project = flatProject(roundStock(2, 4, 'x', { x: 0, y: -0.625 }), 'inch')
  const bounds = getStockBounds(project.stock)
  return {
    project,
    axis: 'x',
    diameter: 2,
    length: 4,
    centre: (bounds.minY + bounds.maxY) / 2,
  }
}

/** Y of the lower half's polyline at one across coordinate, from its vertices. */
function lowerHalfSurfaceY(mesh: THREE.Mesh, descriptor: FlatRoundBarDescriptor, across: number): number {
  const samples = new Map<number, number>()
  for (const vertex of verticesOf(mesh, descriptor.axis)) {
    if (vertex.up > descriptor.pivot + 1e-9) continue
    // The end caps' centre vertex also sits at the equator but in the middle of
    // the bar; the side surface's own equator vertices are the ones at ±radius.
    const atCapCentre =
      Math.abs(vertex.up - descriptor.pivot) <= 1e-9 &&
      Math.abs(vertex.across - descriptor.centre) < descriptor.radius - 1e-6
    if (atCapCentre) continue
    // Float32 vertex positions can collapse two nearly vertical samples onto
    // the same across coordinate near the equator; the join must use the
    // highest of them, which is the one the wall actually meets.
    const existing = samples.get(vertex.across)
    samples.set(vertex.across, existing === undefined ? vertex.up : Math.max(existing, vertex.up))
  }
  const points = [...samples.entries()].sort((a, b) => a[0] - b[0])
  // The grid boundary and the bar radius can differ by a float ulp (the
  // stock's centre is derived separately), so treat a query at the endpoint as
  // that endpoint rather than falling off the polyline.
  if (points.length > 0 && across <= points[0][0] + 1e-9) return points[0][1]
  if (points.length > 0 && across >= points[points.length - 1][0] - 1e-9) {
    return points[points.length - 1][1]
  }
  for (let index = 1; index < points.length; index += 1) {
    const [fromAcross, fromUp] = points[index - 1]
    const [toAcross, toUp] = points[index]
    if (across < fromAcross || across > toAcross) continue
    const t = (across - fromAcross) / (toAcross - fromAcross)
    return fromUp + (toUp - fromUp) * t
  }
  throw new Error(`lower half has no surface at across ${across}`)
}

// ---------------------------------------------------------------------------
// Block / square scene signature, for the "unchanged" half of the contract.
// ---------------------------------------------------------------------------

function plainValue(value: unknown): unknown {
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' || value === null) {
    return value
  }
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map(plainValue)
  const record = value as Record<string, unknown>
  if (typeof record.x === 'number' && typeof record.y === 'number') {
    return typeof record.z === 'number' ? [record.x, record.y, record.z] : [record.x, record.y]
  }
  if (typeof record.r === 'number' && typeof record.g === 'number' && typeof record.b === 'number') {
    return [record.r, record.g, record.b]
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) out[key] = plainValue(record[key])
  return out
}

function geometrySignature(geometry: THREE.BufferGeometry): unknown {
  const attributes: Record<string, unknown> = {}
  for (const name of Object.keys(geometry.attributes).sort()) {
    const attribute = geometry.attributes[name]
    attributes[name] = { count: attribute.count, itemSize: attribute.itemSize, array: Array.from(attribute.array) }
  }
  const index = geometry.getIndex()
  return {
    instanced: geometry instanceof THREE.InstancedBufferGeometry ? geometry.instanceCount : null,
    attributes,
    index: index ? Array.from(index.array) : null,
    boundingBox: geometry.boundingBox
      ? [geometry.boundingBox.min.toArray(), geometry.boundingBox.max.toArray()]
      : null,
  }
}

function materialSignature(material: THREE.Material): unknown {
  if (!(material instanceof THREE.ShaderMaterial)) return { type: material.type }
  const uniforms: Record<string, unknown> = {}
  for (const name of Object.keys(material.uniforms).sort()) {
    const value = material.uniforms[name].value
    uniforms[name] = value instanceof THREE.DataTexture
      ? { texture: true, width: value.image.width, height: value.image.height, format: value.format, type: value.type }
      : plainValue(value)
  }
  return {
    type: material.type,
    glslVersion: material.glslVersion,
    side: material.side,
    defines: plainValue(material.defines ?? {}),
    uniforms,
    vertexShader: material.vertexShader,
    fragmentShader: material.fragmentShader,
  }
}

function boundarySceneHash(group: THREE.Group): string {
  const meshes = meshesOf(group).map((mesh) => ({
    name: mesh.name,
    frustumCulled: mesh.frustumCulled,
    geometry: geometrySignature(mesh.geometry),
    material: materialSignature(mesh.material as THREE.Material),
  }))
  return createHash('sha256').update(JSON.stringify({ name: group.name, meshes })).digest('hex')
}

function buildBoundaryScene(stock: Stock, flatRoundBar?: FlatRoundBarDescriptor): {
  group: THREE.Group
  grid: SimulationGrid
  texture: THREE.DataTexture
  descriptor?: FlatRoundBarDescriptor
} {
  const project = flatProject(stock)
  const setup = project.setups.find((entry) => entry.id === faceSetup('top').id)!
  const input = buildSimulationSetupInput(project, setup, new Map())
  assert(input, 'scene fixture: the setup yields an input')
  const grid = createSimulationGrid(input.project, simulationBuildOptions(input, DETAIL))
  const descriptor = input.flatRoundBar
  const texture = createHeightfieldTexture(grid)
  const group = createInstancedBoundaryGroup(
    texture,
    grid,
    COLOR,
    undefined,
    descriptor?.pivot,
    flatRoundBar ?? descriptor,
  )
  return { group, grid, texture, descriptor }
}

// ---------------------------------------------------------------------------
// 1. The round-bar flat scene carries the static lower half.
// ---------------------------------------------------------------------------

function testRoundBarSceneHasLowerHalf(): void {
  console.log('Testing the flat round-bar scene carries the static lower half on both axes, units and faces...')
  let combos = 0
  for (const axis of ['x', 'y'] as const) {
    for (const units of ['mm', 'inch'] as const) {
      const diameter = units === 'mm' ? 40 : 1.5
      const fixture = barFixture(axis, diameter, units)
      for (const face of ['top', 'bottom'] as const) {
        const label = `${axis}/${units}/${face}`
        const { input, grid } = setupSimulation(fixture, face)
        const descriptor = input.flatRoundBar
        assert(descriptor, `${label}: the setup input carries the flat round-bar profile`)
        assert(descriptor.radius === diameter / 2, `${label}: the descriptor radius is the bar radius`)
        assert(descriptor.length === fixture.length, `${label}: the descriptor length is the bar length`)

        const mesh = createFlatRoundBarLowerHalf(grid, descriptor, COLOR)
        assert(mesh, `${label}: the scene builds the static lower half`)
        assert(mesh.name === FLAT_ROUND_BAR_LOWER_HALF_NAME, `${label}: the mesh is identifiable`)
        assert(mesh.geometry.getIndex() !== null, `${label}: the lower half is an indexed surface`)

        const vertices = verticesOf(mesh, axis)
        assert(vertices.length > 0, `${label}: the lower half has vertices`)

        let maxRadius = 0
        let minUp = Number.POSITIVE_INFINITY
        let maxUp = Number.NEGATIVE_INFINITY
        const alongMin = axis === 'x' ? grid.originX : grid.originY
        let minAlong = Number.POSITIVE_INFINITY
        let maxAlong = Number.NEGATIVE_INFINITY
        for (const vertex of vertices) {
          const radial = crossSectionRadius(descriptor, vertex)
          assert(
            radial <= descriptor.radius + EPSILON,
            `${label}: no vertex reaches past the bar radius (${radial} > ${descriptor.radius})`,
          )
          maxRadius = Math.max(maxRadius, radial)
          minUp = Math.min(minUp, vertex.up)
          maxUp = Math.max(maxUp, vertex.up)
          minAlong = Math.min(minAlong, vertex.along)
          maxAlong = Math.max(maxAlong, vertex.along)
        }

        // The half the cutter cannot reach: a half-cylinder of the bar's own
        // radius, from the equator down to the stock bottom, along its length.
        approx(maxRadius, descriptor.radius, `${label}: the surface reaches the bar radius`)
        approx(maxUp, descriptor.pivot, `${label}: the top edge is the equator`)
        approx(minUp, descriptor.pivot - descriptor.radius, `${label}: the bottom is a full radius below the equator`)
        assert(
          maxUp <= descriptor.pivot + EPSILON,
          `${label}: every vertex is at or below the equator`,
        )
        approx(minAlong, alongMin, `${label}: the lower half starts at the bar's start`)
        approx(maxAlong, alongMin + descriptor.length, `${label}: the lower half spans the bar's length`)

        // Axis: a bar along X is long in world X and round across world Z; a
        // bar along Y is the other way round.
        const box = mesh.geometry.boundingBox
        assert(box, `${label}: the geometry has a bounding box`)
        const sizeX = box.max.x - box.min.x
        const sizeY = box.max.y - box.min.y
        const sizeZ = box.max.z - box.min.z
        approx(sizeY, descriptor.radius, `${label}: the lower half is one radius tall`)
        if (axis === 'x') {
          approx(sizeX, descriptor.length, `${label}: the lower half is the bar's length along X`)
          approx(sizeZ, 2 * descriptor.radius, `${label}: the lower half is a diameter across Z`)
        } else {
          approx(sizeZ, descriptor.length, `${label}: the lower half is the bar's length along Y`)
          approx(sizeX, 2 * descriptor.radius, `${label}: the lower half is a diameter across X`)
        }

        combos += 1
      }
    }
  }
  console.log(`flat round-bar lower half: PASSED (${combos} axis/units/face combinations)`)
}

// ---------------------------------------------------------------------------
// 2. Block and square scenes have no static lower half.
// ---------------------------------------------------------------------------

function testBaseStockScenesHaveNoLowerHalf(): void {
  console.log('Testing a block and a square blank build no static round-bar lower half...')
  const block = flatProject(newProject('block', 'mm').stock)
  for (const face of ['top', 'bottom'] as const) {
    const setup = block.setups.find((entry) => entry.id === faceSetup(face).id)!
    const input = buildSimulationSetupInput(block, setup, new Map())
    assert(input, `block/${face}: yields an input`)
    assert(input.flatRoundBar === undefined, `block/${face}: no flat round-bar profile`)
    const grid = createSimulationGrid(input.project, simulationBuildOptions(input, DETAIL))
    assert(
      createFlatRoundBarLowerHalf(grid, input.flatRoundBar, COLOR) === null,
      `block/${face}: the scene builds no static lower half`,
    )
  }

  // A square blank on a flat face is a flat-topped block, not a bar.
  const square = flatProject(normalizeSquareStock(squareStock(25, 120, 'x', { x: 0, y: 10 })))
  for (const face of ['top', 'bottom'] as const) {
    const setup = square.setups.find((entry) => entry.id === faceSetup(face).id)!
    const input = buildSimulationSetupInput(square, setup, new Map())
    assert(input, `square/${face}: yields an input`)
    assert(input.flatRoundBar === undefined, `square/${face}: no flat round-bar profile`)
    const grid = createSimulationGrid(input.project, simulationBuildOptions(input, DETAIL))
    assert(
      createFlatRoundBarLowerHalf(grid, input.flatRoundBar, COLOR) === null,
      `square/${face}: the scene builds no static lower half`,
    )
  }
  console.log('block/square exclusion: PASSED')
}

// ---------------------------------------------------------------------------
// 3. The flat round-bar wall floor joins the lower half; a block keeps the
//    stock bottom.
// ---------------------------------------------------------------------------

function wallFloorZ(boundary: THREE.Group): number {
  const wall = boundary.children[0]
  assert(wall instanceof THREE.Mesh, 'the boundary has a wall mesh')
  const material = wall.material
  assert(material instanceof THREE.ShaderMaterial, 'the wall is a shader material')
  const uniform = material.uniforms.uWallFloorZ
  assert(uniform, 'the wall material carries the wall floor uniform')
  return uniform.value as number
}

function testWallFloorJoinsLowerHalf(): void {
  console.log('Testing the flat round-bar wall floor joins the lower half; block walls keep the stock bottom...')
  const fixture = barFixture('x', 40)
  const { input, grid } = setupSimulation(fixture, 'top')
  const descriptor = input.flatRoundBar
  assert(descriptor, 'x/mm/top: the setup input carries the flat round-bar profile')

  const roundTexture = createHeightfieldTexture(grid)
  const roundBoundary = createInstancedBoundaryGroup(
    roundTexture,
    grid,
    COLOR,
    undefined,
    descriptor.pivot,
    descriptor,
  )
  approx(wallFloorZ(roundBoundary), descriptor.pivot, 'round bar: walls start at the equator')
  assert(meshesOf(roundBoundary).length === 2, 'round bar: the boundary is the two wall strips, no floor quad')
  const roundWall = roundBoundary.children[0]
  assert(roundWall instanceof THREE.Mesh && roundWall.material instanceof THREE.ShaderMaterial, 'round bar: wall material')
  assert(roundWall.material.uniforms.uBarPivot?.value === descriptor.pivot, 'round bar: the join carries the pivot')
  assert(roundWall.material.uniforms.uBarRadius?.value === descriptor.radius, 'round bar: the join carries the radius')
  assert(roundWall.material.uniforms.uBarCentre?.value === descriptor.centre, 'round bar: the join carries the centre')
  for (const child of roundBoundary.children) {
    if (!(child instanceof THREE.Mesh)) continue
    child.geometry.dispose()
    child.material.dispose()
  }
  roundTexture.dispose()

  const block = flatProject(newProject('block', 'mm').stock)
  const blockSetup = block.setups.find((entry) => entry.id === faceSetup('top').id)!
  const blockInput = buildSimulationSetupInput(block, blockSetup, new Map())
  assert(blockInput, 'block/top: yields an input')
  const blockGrid = createSimulationGrid(blockInput.project, simulationBuildOptions(blockInput, DETAIL))
  const blockTexture = createHeightfieldTexture(blockGrid)
  const blockBoundary = createInstancedBoundaryGroup(blockTexture, blockGrid, COLOR)
  approx(wallFloorZ(blockBoundary), blockGrid.stockBottomZ, 'block: walls keep the stock bottom')
  assert(meshesOf(blockBoundary).length === 3, 'block: walls plus the stock underside')
  for (const child of blockBoundary.children) {
    if (!(child instanceof THREE.Mesh)) continue
    child.geometry.dispose()
    child.material.dispose()
  }
  blockTexture.dispose()
  console.log('wall floor: PASSED')
}

// ---------------------------------------------------------------------------
// 4. No stock underside, and no floor/wall geometry for empty cells.
// ---------------------------------------------------------------------------

function testRoundBarSceneHasNoUndersideFloor(): void {
  console.log('Testing a flat round-bar scene draws no stock underside and empty cells draw no wall...')
  const fixture = reportedFixture()
  const { input, grid } = setupSimulationAt(fixture, 'top', REPORTED_DETAIL)
  const descriptor = input.flatRoundBar
  assert(descriptor, 'reported fixture: carries the flat round-bar profile')

  // Frank's file: the across extent is exactly the diameter, so every cell
  // holds material. The sheet seen under the bar is therefore the full-width
  // stock-underside quad, not an empty cell's top — a round bar has no flat
  // underside, so that quad must not exist at all.
  assert(grid.rows * grid.cellSize === descriptor.radius * 2, 'reported fixture: the grid fits the diameter exactly')
  for (const height of grid.topZ) {
    assert(height > grid.stockBottomZ + 1e-6, 'reported fixture: every cell holds material')
  }
  const reportedScene = buildBoundaryScene(fixture.project.stock)
  assert(
    meshesOf(reportedScene.group).length === 2,
    `round bar: walls only, no floor quad, got ${meshesOf(reportedScene.group).length} meshes`,
  )
  assert(wallMeshesOf(reportedScene.group).length === 2, 'round bar: both boundary meshes are wall strips')
  disposeBoundary(reportedScene.group, reportedScene.texture)

  // A bar long enough that the grid's 24-row minimum leaves empty cells beyond
  // the bar: those cells must draw nothing, surface or wall.
  const longBar = barFixture('x', 40)
  const long = setupSimulationAt(longBar, 'top', DETAIL)
  const longDescriptor = long.input.flatRoundBar
  assert(longDescriptor, 'long bar: carries the flat round-bar profile')
  const longScene = buildBoundaryScene(longBar.project.stock)
  assert(meshesOf(longScene.group).length === 2, 'long bar: no stock underside quad on a round bar')
  disposeBoundary(longScene.group, longScene.texture)

  const { roundBarWallFloorZ, wallEdgeCollapsed } = compileScalarGlsl(ROUND_BAR_WALL_JOIN_GLSL)
  const bottom = long.grid.stockBottomZ
  const acrossBar = longDescriptor.axis === 'x'
  const emptyCell = (col: number, row: number): boolean =>
    long.grid.topZ[row * long.grid.cols + col] <= bottom + 1e-6

  let emptyEdges = 0
  let surfaceEdges = 0
  let materialEdges = 0
  const checkPair = (colA: number, rowA: number, colB: number, rowB: number): void => {
    const emptyA = emptyCell(colA, rowA)
    const emptyB = emptyCell(colB, rowB)
    if (!emptyA && !emptyB) {
      materialEdges += 1
      return
    }
    // The wall's across coordinate: a cell centre when the pair runs along the
    // bar, the boundary between the two cells when the pair crosses it.
    const acrossPair = acrossBar ? rowA !== rowB : colA !== colB
    const acrossIndex = acrossBar
      ? (acrossPair ? Math.max(rowA, rowB) : rowA)
      : (acrossPair ? Math.max(colA, colB) : colA)
    const acrossOrigin = acrossBar ? long.grid.originY : long.grid.originX
    const across = acrossOrigin + (acrossIndex + (acrossPair ? 0 : 0.5)) * long.grid.cellSize
    const floorAt = (alongEnd: boolean): number => roundBarWallFloorZ(
      longDescriptor.pivot,
      longDescriptor.radius,
      across - longDescriptor.centre,
      alongEnd,
      longDescriptor.pivot,
      bottom,
    ) as number
    if (emptyA && emptyB) {
      for (const alongEnd of [false, true]) {
        const floor = floorAt(alongEnd)
        assert(
          wallEdgeCollapsed(0, 0, floor) === true,
          `empty edge at (${colA},${rowA})-(${colB},${rowB}) draws no wall (floor ${floor}, alongEnd ${alongEnd})`,
        )
      }
      emptyEdges += 1
      return
    }
    // An edge onto empty space beside real material is still a wall — the rule
    // removes empty cells, not the bar's own surface.
    const materialCol = emptyA ? colB : colA
    const materialRow = emptyA ? rowB : rowA
    const height = long.grid.topZ[materialRow * long.grid.cols + materialCol]
    assert(
      wallEdgeCollapsed(height, 0, floorAt(false)) === false,
      `material edge at (${materialCol},${materialRow}) keeps its wall`,
    )
    surfaceEdges += 1
  }
  for (let row = 0; row < long.grid.rows; row += 1) {
    for (let col = 0; col < long.grid.cols - 1; col += 1) checkPair(col, row, col + 1, row)
  }
  for (let row = 0; row < long.grid.rows - 1; row += 1) {
    for (let col = 0; col < long.grid.cols; col += 1) checkPair(col, row, col, row + 1)
  }
  assert(emptyEdges > 0, 'fixture: the long bar really leaves empty cells in the grid')
  assert(surfaceEdges > 0, 'fixture: the bar has a material edge onto empty space')
  assert(materialEdges > 0, 'fixture: the bar still has material edges to draw its walls on')
  console.log(`round-bar scene without a floor: PASSED (${emptyEdges} empty edges draw nothing)`)
}

// ---------------------------------------------------------------------------
// 5. The heightfield's equator edge and the half-cylinder's top edge meet.
// ---------------------------------------------------------------------------

function testHeightfieldEdgeMeetsLowerHalf(): void {
  console.log('Testing the heightfield edge and the half-cylinder top edge coincide...')
  const fixture = reportedFixture()
  const { input, grid } = setupSimulationAt(fixture, 'top', REPORTED_DETAIL)
  const descriptor = input.flatRoundBar
  assert(descriptor, 'reported fixture: carries the flat round-bar profile')
  const scene = buildBoundaryScene(fixture.project.stock)
  const lowerHalf = createFlatRoundBarLowerHalf(grid, descriptor, COLOR)
  assert(lowerHalf, 'reported scene: builds the static lower half')

  const acrossMin = descriptor.axis === 'x' ? grid.originY : grid.originX
  const acrossMax = acrossMin + (descriptor.axis === 'x' ? grid.rows : grid.cols) * grid.cellSize
  approx(acrossMin, descriptor.centre - descriptor.radius, 'the heightfield starts at the bar radius')
  approx(acrossMax, descriptor.centre + descriptor.radius, 'the heightfield ends at the bar radius')

  const { roundBarWallFloorZ } = compileScalarGlsl(ROUND_BAR_WALL_JOIN_GLSL)
  const wallFloorAt = (across: number): number => roundBarWallFloorZ(
    descriptor.pivot,
    descriptor.radius,
    across - descriptor.centre,
    false,
    descriptor.pivot,
    grid.stockBottomZ,
  ) as number

  // The half-cylinder's top edge is its equator vertices; the heightfield's
  // edge is the wall bottom at the grid boundary. They are the same line.
  const equator = verticesOf(lowerHalf, descriptor.axis)
    .filter((vertex) => Math.abs(vertex.up - descriptor.pivot) <= 1e-6)
  for (const [across, side] of [[acrossMin, -1], [acrossMax, 1]] as const) {
    const floor = wallFloorAt(across)
    approx(floor, descriptor.pivot, `wall floor at across ${across} is the equator`, 1e-6)
    const vertex = equator.find((entry) =>
      Math.abs(entry.across - (descriptor.centre + side * descriptor.radius)) <= 1e-6,
    )
    assert(vertex, `the half-cylinder has an equator vertex at across ${across}`)
    approx(vertex!.up, floor, `the heightfield edge and the half-cylinder edge coincide at across ${across}`, 1e-6)
    approx(vertex!.across, across, 'the edges share the across coordinate', 1e-6)
  }

  // Matching outward normals: the half-cylinder's equator normal points
  // straight out along the across axis, which is the direction the round-bar
  // wall adds. Both shaders light in world space with the same depth term, so
  // the lighting is continuous across the join. Only the side surface counts —
  // the end caps reuse the same positions with their own ±along normals.
  const normals = lowerHalf.geometry.getAttribute('normal')
  const lowerVertices = verticesOf(lowerHalf, descriptor.axis)
  const alongMin = descriptor.axis === 'x' ? grid.originX : grid.originY
  let equatorNormals = 0
  for (const side of [-1, 1] as const) {
    const across = descriptor.centre + side * descriptor.radius
    const index = lowerVertices.findIndex((vertex) =>
      Math.abs(vertex.up - descriptor.pivot) <= 1e-6 &&
      Math.abs(vertex.across - across) <= 1e-6 &&
      Math.abs(vertex.along - alongMin) <= 1e-6,
    )
    assert(index >= 0, `the half-cylinder has a side equator vertex at across ${across}`)
    const nx = normals.getX(index), ny = normals.getY(index), nz = normals.getZ(index)
    approx(ny, 0, 'the equator normal is horizontal', 1e-6)
    if (descriptor.axis === 'x') {
      approx(nx, 0, 'the equator normal has no X component', 1e-6)
      approx(nz, side, 'the equator normal points outward across Z', 1e-6)
    } else {
      approx(nz, 0, 'the equator normal has no Z component', 1e-6)
      approx(nx, side, 'the equator normal points outward across X', 1e-6)
    }
    equatorNormals += 1
  }
  assert(equatorNormals === 2, 'the half-cylinder carries an outward equator normal on each side')

  const wallMaterial = scene.group.children[0]
  assert(wallMaterial instanceof THREE.Mesh && wallMaterial.material instanceof THREE.ShaderMaterial, 'wall material')
  const lowerMaterial = lowerHalf.material
  assert(lowerMaterial instanceof THREE.ShaderMaterial, 'lower-half material')
  // The wall shader really calls the floor rule the tests just ran, and it
  // treats the two along ends (the end caps' equator) separately. The helper
  // definitions alone carry these names, so match the call sites.
  const wallSource = wallMaterial.material.vertexShader.replace(/\s+/g, ' ')
  assert(
    wallSource.includes('roundBarWallFloorZ( uBarPivot'),
    'the round-bar wall shader takes its floor from the tested join rule',
  )
  assert(
    wallSource.includes('wallEdgeCollapsed(hNear, hFar, wallFloor)'),
    'the round-bar wall shader collapses edges with the tested rule',
  )
  const endWallFloor = roundBarWallFloorZ(
    descriptor.pivot,
    descriptor.radius,
    0,
    true,
    descriptor.pivot,
    grid.stockBottomZ,
  ) as number
  approx(endWallFloor, descriptor.pivot, 'an along-end wall stops at the end cap equator', 1e-9)
  assert(
    wallMaterial.material.vertexShader.includes('mat3(modelMatrix)'),
    'the round-bar wall lights in world space, like the lower half',
  )
  assert(
    lowerMaterial.vertexShader.includes('mat3(modelMatrix)'),
    'the lower half lights in world space',
  )
  assert(
    wallMaterial.material.fragmentShader.includes('depthDarken(vHeight, uStockTopZ)'),
    'the round-bar wall takes the same depth darkening as the lower half',
  )
  assert(
    lowerMaterial.fragmentShader.includes('depthDarken(vHeight, uStockTopZ)'),
    'the lower half darkens its depth',
  )

  // Where the grid stops short of the radius, the wall must still land on the
  // cylinder rather than float at the equator plane.
  const longBar = barFixture('x', 40)
  const long = setupSimulationAt(longBar, 'top', DETAIL)
  const longDescriptor = long.input.flatRoundBar
  assert(longDescriptor, 'long bar: carries the flat round-bar profile')
  const longLowerHalf = createFlatRoundBarLowerHalf(long.grid, longDescriptor, COLOR)
  assert(longLowerHalf, 'long bar: builds the static lower half')
  let lastMaterialRow = -1
  for (let row = 0; row < long.grid.rows; row += 1) {
    const across = long.grid.originY + (row + 0.5) * long.grid.cellSize
    if (Math.abs(across - longDescriptor.centre) < longDescriptor.radius) lastMaterialRow = row
  }
  assert(lastMaterialRow >= 0, 'long bar: has material rows')
  const boundaryAcross = long.grid.originY + (lastMaterialRow + 1) * long.grid.cellSize
  assert(
    boundaryAcross < longDescriptor.centre + longDescriptor.radius - 1e-6,
    'fixture: the grid boundary really falls inside the bar radius',
  )
  const { roundBarWallFloorZ: longFloorAt } = compileScalarGlsl(ROUND_BAR_WALL_JOIN_GLSL)
  const floor = longFloorAt(
    longDescriptor.pivot,
    longDescriptor.radius,
    boundaryAcross - longDescriptor.centre,
    false,
    longDescriptor.pivot,
    long.grid.stockBottomZ,
  ) as number
  const surface = lowerHalfSurfaceY(longLowerHalf, longDescriptor, boundaryAcross)
  const sagitta = longDescriptor.radius * (1 - Math.cos(Math.PI / FLAT_ROUND_BAR_RADIAL_SEGMENTS)) + 1e-4
  approx(floor, surface, 'the wall lands on the lower-half surface', sagitta)
  assert(floor < longDescriptor.pivot - 1e-6, 'the wall reaches below the equator where the grid stops short')

  disposeBoundary(scene.group, scene.texture)
  console.log('equator join: PASSED')
}

// ---------------------------------------------------------------------------
// 6. Block and square scenes are byte-identical to before the join change.
// ---------------------------------------------------------------------------

function testBaseStockScenesByteIdentical(): void {
  console.log('Testing block and square boundary scenes are byte-identical...')
  const block = buildBoundaryScene(newProject('block', 'mm').stock)
  assert(block.descriptor === undefined, 'block: no flat round-bar descriptor')
  assert(meshesOf(block.group).length === 3, 'block: two wall strips and the stock underside')
  assert(boundarySceneHash(block.group) === BLOCK_SCENE_HASH, 'block: boundary scene is byte-identical')
  disposeBoundary(block.group, block.texture)

  const squareStockScene = normalizeSquareStock(squareStock(25, 120, 'x', { x: 0, y: 10 }))
  const square = buildBoundaryScene(squareStockScene)
  assert(square.descriptor === undefined, 'square: no flat round-bar descriptor')
  assert(meshesOf(square.group).length === 3, 'square: two wall strips and the stock underside')
  assert(boundarySceneHash(square.group) === SQUARE_SCENE_HASH, 'square: boundary scene is byte-identical')
  disposeBoundary(square.group, square.texture)
  console.log('block/square scene identity: PASSED')
}

// ---------------------------------------------------------------------------
// 7. An outermost cell boundary inside or beyond the radius joins the lower
//    half at the bar's real silhouette (issue #1049 review).
// ---------------------------------------------------------------------------

/** Both walls of the join: no gap and no penetration beyond this. */
const JOIN_EPSILON = 2e-4

function testOvershootingBoundaryJoinsSilhouette(): void {
  console.log('Testing a last cell boundary inside and outside the bar radius still joins the lower half...')
  const { roundBarWallFloorZ, roundBarSilhouetteAcross } = compileScalarGlsl(ROUND_BAR_WALL_JOIN_GLSL)
  const silhouette = compileScalarGlsl(ROUND_BAR_SILHOUETTE_GLSL)

  // The shaders must call the rules this test runs, or the geometry below
  // would only prove a TypeScript copy of them.
  const probeFixture = barFixture('x', 41)
  const probe = setupSimulation(probeFixture, 'top')
  const probeDescriptor = probe.input.flatRoundBar
  assert(probeDescriptor, 'probe: carries the flat round-bar profile')
  const probeScene = buildSimulationStockScene(probe.grid, COLOR, undefined, probeDescriptor)
  const probeWallMaterial = (probeScene.boundary.children[0] as THREE.Mesh).material
  const probeSurfaceMaterial = (probeScene.surface as THREE.Mesh).material
  assert(probeWallMaterial instanceof THREE.ShaderMaterial, 'probe: the wall is a shader material')
  assert(probeSurfaceMaterial instanceof THREE.ShaderMaterial, 'probe: the surface is a shader material')
  assert(
    probeWallMaterial.vertexShader.replace(/\s+/g, ' ').includes('roundBarSilhouetteAcross(across, uBarCentre, uBarRadius)'),
    'the wall shader joins the silhouette with the tested rule',
  )
  assert(
    probeSurfaceMaterial.fragmentShader.replace(/\s+/g, ' ').includes('roundBarOutsideSilhouette(vAcrossWorld, uBarCentre, uBarRadius)'),
    'the surface shader clips with the tested silhouette rule',
  )
  probeScene.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    object.geometry.dispose()
    ;(object.material as THREE.Material).dispose()
  })
  probeScene.heightfieldTexture.dispose()

  let insideBoundaries = 0
  let outsideBoundaries = 0
  let exactBoundaries = 0

  // Ø40/Ø41 mm at 96 cells put the last material boundary inside / 0.667 mm
  // outside the radius. The inch diameters do the same at the same detail for
  // an 8 in bar (1.52 in inside, 1.55 in outside).
  const unitCases = [
    { units: 'mm', diameters: [40, 41] },
    { units: 'inch', diameters: [1.52, 1.55] },
  ] as const
  for (const axis of ['x', 'y'] as const) {
    for (const { units, diameters } of unitCases) {
      for (const diameter of diameters) {
        const label = `${axis}/${units}/${diameter}`
        const fixture = barFixture(axis, diameter, units)
        const { input, grid } = setupSimulation(fixture, 'top')
        const descriptor = input.flatRoundBar
        assert(descriptor, `${label}: the setup input carries the flat round-bar profile`)
        const lowerHalf = createFlatRoundBarLowerHalf(grid, descriptor, COLOR)
        assert(lowerHalf, `${label}: builds the static lower half`)

        const acrossOrigin = descriptor.axis === 'x' ? grid.originY : grid.originX
        const acrossCount = descriptor.axis === 'x' ? grid.rows : grid.cols
        let minIndex = -1
        let maxIndex = -1
        for (let across = 0; across < acrossCount; across += 1) {
          const index = descriptor.axis === 'x' ? across * grid.cols : across
          if (grid.topZ[index] > grid.stockBottomZ + 1e-6) {
            if (minIndex < 0) minIndex = across
            maxIndex = across
          }
        }
        assert(minIndex >= 0 && maxIndex >= 0, `${label}: the bar has material across cells`)

        const sides = [
          { name: 'min', across: acrossOrigin + minIndex * grid.cellSize },
          { name: 'max', across: acrossOrigin + (maxIndex + 1) * grid.cellSize },
        ]
        for (const side of sides) {
          const distance = side.across - descriptor.centre
          const relation = Math.abs(Math.abs(distance) - descriptor.radius)
          if (relation <= 1e-9) exactBoundaries += 1
          else if (Math.abs(distance) < descriptor.radius) insideBoundaries += 1
          else outsideBoundaries += 1

          // The wall shader pulls an overshooting boundary onto the silhouette.
          const clamped = side.across
          const clampedAcross = roundBarSilhouetteAcross(clamped, descriptor.centre, descriptor.radius) as number
          if (Math.abs(distance) > descriptor.radius) {
            approx(
              clampedAcross,
              descriptor.centre + Math.sign(distance) * descriptor.radius,
              `${label}/${side.name}: the boundary is joined at the silhouette`,
              1e-12,
            )
            assert(
              silhouette.roundBarOutsideSilhouette(side.across, descriptor.centre, descriptor.radius) === true,
              `${label}/${side.name}: the surface clips the overshoot`,
            )
          } else {
            approx(clampedAcross, side.across, `${label}/${side.name}: a boundary inside the radius is untouched`, 1e-12)
          }

          const floor = roundBarWallFloorZ(
            descriptor.pivot,
            descriptor.radius,
            clampedAcross - descriptor.centre,
            false,
            descriptor.pivot,
            grid.stockBottomZ,
          ) as number
          const surface = lowerHalfSurfaceY(lowerHalf, descriptor, clampedAcross)
          const gap = Math.max(0, floor - surface)
          const overlap = Math.max(0, surface - floor)
          assert(gap <= JOIN_EPSILON, `${label}/${side.name}: no gap at the join (${gap} > ${JOIN_EPSILON})`)
          assert(
            overlap <= JOIN_EPSILON,
            `${label}/${side.name}: no overlap past the lower half (${overlap} > ${JOIN_EPSILON})`,
          )
          if (Math.abs(distance) > descriptor.radius) {
            approx(floor, descriptor.pivot, `${label}/${side.name}: the wall ends at the silhouette equator`, 1e-6)
          }
        }

        lowerHalf.geometry.dispose()
        ;(lowerHalf.material as THREE.Material).dispose()
      }
    }
  }

  assert(insideBoundaries > 0, 'the fixtures include a boundary inside the radius')
  assert(outsideBoundaries > 0, 'the fixtures include a boundary beyond the radius')
  assert(exactBoundaries > 0, 'the fixtures include a boundary exactly on the radius')
  console.log(
    `overshooting boundary join: PASSED (${insideBoundaries} inside, ${outsideBoundaries} outside, ${exactBoundaries} exact)`,
  )
}

// ---------------------------------------------------------------------------
// 8. The one scene builder both the static and the playback view mount.
// ---------------------------------------------------------------------------

function testSceneBuilderMountsLowerHalf(): void {
  console.log('Testing the shared static/playback scene builder mounts the lower half and clips at the silhouette...')
  const fixture = barFixture('x', 41)
  const { input, grid } = setupSimulation(fixture, 'top')
  const descriptor = input.flatRoundBar
  assert(descriptor, 'scene builder: the setup input carries the flat round-bar profile')

  const built = buildSimulationStockScene(grid, COLOR, undefined, descriptor)
  const mounted = built.group.getObjectByName(FLAT_ROUND_BAR_LOWER_HALF_NAME)
  assert(mounted instanceof THREE.Mesh, 'the scene builder mounts the static lower half')
  assert(mounted === built.lowerHalf, 'the mounted mesh is the lower half the builder returns')
  assert(built.group.children.includes(mounted), 'the lower half is a child of the mounted scene group')
  assert(built.group.children.includes(built.surface), 'the heightfield surface is in the same scene group')
  assert(built.group.children.includes(built.boundary), 'the boundary walls are in the same scene group')

  // A round bar's top surface stops at the silhouette; its walls are pulled
  // onto the same circle.
  const surfaceMaterial = (built.surface as THREE.Mesh).material
  assert(surfaceMaterial instanceof THREE.ShaderMaterial, 'the surface is a shader material')
  assert(
    surfaceMaterial.fragmentShader.includes('roundBarOutsideSilhouette(vAcrossWorld, uBarCentre, uBarRadius)'),
    'the round-bar surface clips its flat top at the silhouette',
  )
  const wallMaterial = (built.boundary.children[0] as THREE.Mesh).material
  assert(wallMaterial instanceof THREE.ShaderMaterial, 'the wall is a shader material')
  assert(
    wallMaterial.vertexShader.includes('roundBarSilhouetteAcross(across, uBarCentre, uBarRadius)'),
    'the round-bar wall joins the silhouette, not the overshooting cell boundary',
  )

  // A block scene builds the same group without the round-bar lower half.
  const blockProject = flatProject(newProject('block', 'mm').stock)
  const blockSetup = blockProject.setups.find((entry) => entry.id === faceSetup('top').id)!
  const blockInput = buildSimulationSetupInput(blockProject, blockSetup, new Map())
  assert(blockInput, 'block scene: yields an input')
  const blockGrid = createSimulationGrid(blockInput.project, simulationBuildOptions(blockInput, DETAIL))
  const blockScene = buildSimulationStockScene(blockGrid, COLOR)
  assert(blockScene.lowerHalf === null, 'a block scene mounts no round-bar lower half')
  assert(
    blockScene.group.getObjectByName(FLAT_ROUND_BAR_LOWER_HALF_NAME) === undefined,
    'a block scene group carries no lower-half mesh',
  )

  for (const scene of [built, blockScene]) {
    scene.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return
      object.geometry.dispose()
      ;(object.material as THREE.Material).dispose()
    })
    scene.heightfieldTexture.dispose()
  }
  console.log('shared scene builder mounting: PASSED')
}

testRoundBarSceneHasLowerHalf()
testBaseStockScenesHaveNoLowerHalf()
testWallFloorJoinsLowerHalf()
testRoundBarSceneHasNoUndersideFloor()
testHeightfieldEdgeMeetsLowerHalf()
testBaseStockScenesByteIdentical()
testOvershootingBoundaryJoinsSilhouette()
testSceneBuilderMountsLowerHalf()
console.log('All flat round-bar lower-half tests passed.')
