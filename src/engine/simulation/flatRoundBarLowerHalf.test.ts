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
 * `createFlatRoundBarLowerHalf` the viewport mounts, so a descriptor that stops
 * reaching the renderer or a builder that stops returning the half-cylinder
 * fails here. Every expected dimension is derived from the bar's own geometry,
 * written out in this file.
 *
 * Mutations these assertions were checked against, each applied on its own
 * from a `cp` backup and reverted:
 * - `flatRoundBarFor` returning the bounding-box profile again (dropping the
 *   descriptor) → `x/mm/top: the setup input carries the flat round-bar profile`;
 * - the builder rendering the full cylinder (`theta` from 0 to π instead of
 *   π to 2π) → `... every vertex is at or below the equator`.
 *
 * Run with: npx tsx src/engine/simulation/flatRoundBarLowerHalf.test.ts
 */

import assert from 'node:assert/strict'
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
} from './flatRoundBarLowerHalf'
import { createHeightfieldTexture } from './gpuMesh'
import { createInstancedBoundaryGroup } from './instancedBoundary'
import type { FlatRoundBarDescriptor, SimulationGrid } from './types'
import { buildSimulationSetupInput } from '../../app/simulationSetup'
import { simulationBuildOptions } from '../../app/simulationCompute'

const DETAIL = 96
const EPSILON = 1e-4
const COLOR = new THREE.Color('#b9a83c')

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
  const setup = fixture.project.setups.find((entry) => entry.id === faceSetup(face).id)!
  const input = buildSimulationSetupInput(fixture.project, setup, new Map())
  assert(input, `${fixture.axis}/${face}: the setup yields a simulation input`)
  return { input, grid: createSimulationGrid(input.project, simulationBuildOptions(input, DETAIL)) }
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
// 3. The heightfield walls stop at the equator only for the round bar.
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

function testWallFloorStopsAtEquatorForRoundBar(): void {
  console.log('Testing the flat round-bar walls stop at the equator; block walls keep the stock bottom...')
  const fixture = barFixture('x', 40)
  const { input, grid } = setupSimulation(fixture, 'top')
  const descriptor = input.flatRoundBar
  assert(descriptor, 'x/mm/top: the setup input carries the flat round-bar profile')

  const roundTexture = createHeightfieldTexture(grid)
  const roundBoundary = createInstancedBoundaryGroup(roundTexture, grid, COLOR, undefined, descriptor.pivot)
  approx(wallFloorZ(roundBoundary), descriptor.pivot, 'round bar: walls start at the equator')
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
  for (const child of blockBoundary.children) {
    if (!(child instanceof THREE.Mesh)) continue
    child.geometry.dispose()
    child.material.dispose()
  }
  blockTexture.dispose()
  console.log('wall floor: PASSED')
}

testRoundBarSceneHasLowerHalf()
testBaseStockScenesHaveNoLowerHalf()
testWallFloorStopsAtEquatorForRoundBar()
console.log('All flat round-bar lower-half tests passed.')
