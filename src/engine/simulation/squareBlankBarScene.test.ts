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
 * The square blank's bar display draws nothing outside the blank (issue #1112
 * rt3-b, item 26): a thin slab stuck out under each uncut square end.
 *
 * The bar view is the wrapped radial heightfield. Its across cells store one
 * radius each, taken at the cell's own angle, and the renderer draws each cell
 * as a flat quad at that radius with a radial wall to its neighbour. A round
 * bar's polygon is inscribed in its own circle, so it cannot leave the stock.
 * A square blank's section is `halfSide / max(|sin|, |cos|)`, which is largest
 * at the cell centres, so near a corner the cell quad overshoots the blank's
 * flats and the wall between two cells straddles the true surface — a fin up to
 * one cell step outside the blank, below its bottom face along both uncut ends
 * and above its top face. The turned middle never shows one: its radius is far
 * smaller than the blank's.
 *
 * These assertions run the shader's own `squareBlankSilhouetteRadius` text (via
 * `glslScalar.testSupport`) against the real seeded grid for both bar axes and
 * both units, pin the scene builder to exactly the stock meshes it mounts, and
 * guard that a block, a flat setup and a round bar compile the shader they had.
 *
 * Mutations these assertions were checked against, each applied on its own from
 * a `cp` backup and reverted:
 * - `squareBlankSilhouetteRadius` returning its `radius` argument unchanged
 *   (the clamp dropped) → `the clamp pulls every rendered radius inside the
 *   blank`;
 * - removing the clamp call from the surface vertex shader → `the square
 *   bar's surface clamps to the tested silhouette`;
 * - removing it from the wall vertex shader → `the square bar's walls clamp to
 *   the tested silhouette`;
 * - mounting the flat-round-bar lower half for a square blank → `the square
 *   bar's scene mounts only the stock meshes`.
 *
 * Run with: npx tsx src/engine/simulation/squareBlankBarScene.test.ts
 */

import assert from 'node:assert/strict'
import * as THREE from 'three'
import { createSimulationGrid } from './grid'
import { createHeightfieldTexture } from './gpuMesh'
import {
  createHeightfieldMaterial,
  SQUARE_BLANK_SILHOUETTE_GLSL,
} from './heightfieldShader'
import { createInstancedBoundaryGroup, createInstancedWallMaterial } from './instancedBoundary'
import { buildSimulationStockScene } from './simulationScene'
import { compileScalarGlsl } from './glslScalar.testSupport'
import type { AroundFrame } from '../aroundFrame'
import { newProject, rectProfile } from '../../types/project'
import type { Project } from '../../types/project'
import type { SimulationBuildOptions, SimulationGrid } from './types'

const COLOR = new THREE.Color('#b9a83c')
const DETAIL = 96
/** Slack for float32 on the GPU versus doubles here. */
const EPSILON = 1e-6

function approx(actual: number, expected: number, label: string, epsilon = EPSILON): void {
  assert(
    Math.abs(actual - expected) <= epsilon,
    `${label}: expected ${expected}, got ${actual} (delta ${actual - expected})`,
  )
}

interface Sheet {
  project: Project
  frame: AroundFrame
  side: number
}

/**
 * The unrolled sheet a square Around grid is seeded from: along the bar on
 * `axis`, one nominal circumference across, one nominal radius thick. This is
 * exactly what `buildSimulationSetupInput` hands the grid, so the seed here is
 * the seed the app renders.
 */
function sheet(side: number, axis: 'x' | 'y', units: 'mm' | 'inch', alongLength: number): Sheet {
  const circumference = Math.PI * side
  const radius = side / 2
  const zero = side / 2
  const frame: AroundFrame = {
    axis,
    centre: zero,
    radius,
    zero,
    sheetStart: zero - circumference / 2,
    circumference,
  }
  const project = newProject('square bar scene', units)
  const xMin = axis === 'x' ? 0 : frame.sheetStart
  const xMax = axis === 'x' ? alongLength : frame.sheetStart + circumference
  const yMin = axis === 'x' ? frame.sheetStart : 0
  const yMax = axis === 'x' ? frame.sheetStart + circumference : alongLength
  project.stock = { ...project.stock, profile: rectProfile(xMin, yMin, xMax - xMin, yMax - yMin), thickness: radius }
  return { project, frame, side }
}

function options(entry: Sheet, detail = DETAIL): SimulationBuildOptions {
  return {
    targetLongAxisCells: detail,
    wrap: { axis: entry.frame.axis === 'x' ? 'y' : 'x', period: entry.frame.circumference },
    squareBar: { side: entry.side, frame: entry.frame },
  }
}

/** A wrapped square grid on fresh stock: the bar view an uncut blank shows. */
function squareGrid(entry: Sheet, detail = DETAIL): SimulationGrid {
  return createSimulationGrid(entry.project, options(entry, detail))
}

function angleAt(frame: AroundFrame, across: number): number {
  return (2 * Math.PI * (across - frame.zero)) / frame.circumference
}

/**
 * Every radial height the wrapped bar view draws, as the shaders position them:
 * each across cell's own radius at both of its across boundaries (the surface
 * quads and the end-face fans), plus the two cell radii a wall spans (the
 * smallest and largest neighbour height).
 */
function renderedRadii(grid: SimulationGrid, frame: AroundFrame): { across: number; radius: number }[] {
  const alongIsX = frame.axis === 'x'
  const acrossCount = alongIsX ? grid.rows : grid.cols
  const acrossOrigin = alongIsX ? grid.originY : grid.originX
  const radiusAt = (index: number): number => {
    const col = alongIsX ? 0 : index
    const row = alongIsX ? index : 0
    return grid.topZ[row * grid.cols + col]
  }
  const radii: { across: number; radius: number }[] = []
  for (let index = 0; index < acrossCount; index += 1) {
    const radius = radiusAt(index)
    for (const boundary of [index, index + 1]) {
      radii.push({ across: acrossOrigin + boundary * grid.cellSize, radius })
    }
  }
  for (let boundary = 1; boundary < acrossCount; boundary += 1) {
    const near = radiusAt(boundary - 1)
    const far = radiusAt(boundary)
    const across = acrossOrigin + boundary * grid.cellSize
    radii.push({ across, radius: Math.min(near, far) }, { across, radius: Math.max(near, far) })
  }
  return radii
}

function testSilhouetteClampsEveryRenderedRadius(): void {
  console.log('Testing the clamp pulls every rendered radius inside the blank...')
  const glsl = compileScalarGlsl(SQUARE_BLANK_SILHOUETTE_GLSL)
  const clampRadius = glsl.squareBlankSilhouetteRadius
  const surfaceRadius = glsl.squareBlankSurfaceRadius

  const cases = [
    { side: 20, axis: 'x' as const, units: 'mm' as const, along: 80 },
    { side: 20, axis: 'y' as const, units: 'mm' as const, along: 80 },
    { side: 1.5, axis: 'x' as const, units: 'inch' as const, along: 8 },
    { side: 1.5, axis: 'y' as const, units: 'inch' as const, along: 8 },
  ]
  for (const entry of cases) {
    const label = `${entry.side} ${entry.units} ${entry.axis}`
    const sheetEntry = sheet(entry.side, entry.axis, entry.units, entry.along)
    const grid = squareGrid(sheetEntry)
    const frame = sheetEntry.frame
    const radii = renderedRadii(grid, frame)
    assert(radii.length > 0, `${label}: the grid has across boundaries to draw`)

    let worst = 0
    for (const drawn of radii) {
      const angle = angleAt(frame, drawn.across)
      const surface = Number(surfaceRadius(entry.side, angle))
      const clamped = Number(clampRadius(entry.side, angle, drawn.radius))
      // The clamp only ever moves inward, and never past the blank's surface.
      assert(clamped <= drawn.radius + EPSILON, `${label}: the clamp raises a radius (${drawn.radius} → ${clamped})`)
      assert(clamped <= surface + EPSILON, `${label}: a rendered radius ${clamped} is outside the blank (surface ${surface})`)
      // A point inside the square is inside its two faces as well.
      const up = frame.radius + clamped * Math.cos(angle)
      const acrossWorld = frame.centre + clamped * Math.sin(angle)
      assert(up >= -EPSILON && up <= entry.side + EPSILON, `${label}: rendered height ${up} leaves [0, ${entry.side}]`)
      assert(
        acrossWorld >= -EPSILON && acrossWorld <= entry.side + EPSILON,
        `${label}: rendered across ${acrossWorld} leaves [0, ${entry.side}]`,
      )
      worst = Math.max(worst, drawn.radius - surface)
    }
    // The defect is real: unclamped, these very cells draw outside the blank.
    assert(worst > 1e-4, `${label}: no cell overshoots the blank, so the clamp proves nothing`)
    console.log(`  ${label}: ${radii.length} drawn radii, largest overshoot ${worst.toFixed(4)} ${entry.units}`)
  }
  console.log('silhouette clamp: PASSED')
}

/** The mesh names and counts the bar view must mount for a square blank — exactly. */
function testSceneMountsOnlyTheStockMeshes(): void {
  console.log("Testing the square bar's scene mounts only the stock meshes...")
  const entry = sheet(20, 'x', 'mm', 80)
  const grid = squareGrid(entry)
  const built = buildSimulationStockScene(grid, COLOR, entry.frame, undefined, entry.side)
  try {
    assert(built.lowerHalf === null, 'the square bar mounts no static lower half')
    const children = built.group.children
    assert(children.length === 2, `the stock group mounts exactly the surface and its boundary, got ${children.length}`)
    assert(children.includes(built.surface), 'the surface is mounted')
    assert(children.includes(built.boundary), 'the boundary is mounted')
    assert(built.boundary instanceof THREE.Group, 'the boundary is the instanced wall group')
    assert(built.boundary.name === 'instancedBoundary', 'the boundary keeps its name')
    const boundaryParts = (built.boundary as THREE.Group).children
    assert(boundaryParts.length === 3, `the boundary is the two wall strips and the floor, got ${boundaryParts.length}`)
    const instances = boundaryParts.map((part) => (part as THREE.Mesh).geometry as THREE.InstancedBufferGeometry | THREE.BufferGeometry)
      .map((geometry) => (geometry instanceof THREE.InstancedBufferGeometry ? geometry.instanceCount : undefined))
    assert(
      instances[0] === grid.rows && instances[1] === grid.rows + 1,
      `the wall strips instance one row of edges each, got ${instances[0]} and ${instances[1]}`,
    )
    const floor = boundaryParts[2] as THREE.Mesh
    assert(!(floor.geometry instanceof THREE.InstancedBufferGeometry), 'the third boundary part is the single underside quad')
    // Nothing else may sit in the scene under another name.
    for (const child of children) {
      assert(child === built.surface || child === built.boundary, `an unexpected mesh is mounted: ${child.name || child.type}`)
    }
  } finally {
    built.heightfieldTexture.dispose()
  }
  console.log('scene inventory: PASSED')
}

/** The render may clip; the simulated material may not change. */
function testSceneKeepsTheHeightfield(): void {
  console.log('Testing the render-only clamp leaves every heightfield value untouched...')
  const entry = sheet(20, 'x', 'mm', 80)
  const grid = squareGrid(entry)
  const before = Float32Array.from(grid.topZ)
  const baseline = grid.initialTopZ ? Float32Array.from(grid.initialTopZ) : null
  const built = buildSimulationStockScene(grid, COLOR, entry.frame, undefined, entry.side)
  try {
    assert(grid.topZ.length === before.length, 'the grid keeps its shape')
    for (let index = 0; index < before.length; index += 1) {
      assert(grid.topZ[index] === before[index], `cell ${index} changed from ${before[index]} to ${grid.topZ[index]}`)
    }
    if (baseline && grid.initialTopZ) {
      for (let index = 0; index < baseline.length; index += 1) {
        assert(grid.initialTopZ[index] === baseline[index], `baseline cell ${index} changed`)
      }
    }
  } finally {
    built.heightfieldTexture.dispose()
  }
  console.log('heightfield untouched: PASSED')
}

/** The clamp is a compile-time variant: only the wrapped square bar gets it. */
function testOnlyTheWrappedSquareBarClamps(): void {
  console.log('Testing block, flat and round materials keep their exact shaders...')
  const entry = sheet(20, 'x', 'mm', 80)
  const grid = squareGrid(entry)
  const texture = createHeightfieldTexture(grid)
  try {
    const squareSurface = createHeightfieldMaterial(texture, grid, COLOR, entry.frame, undefined, entry.side)
    assert(
      squareSurface.vertexShader.includes('squareBlankSilhouetteRadius(uBlankSide'),
      "the square bar's surface clamps to the tested silhouette",
    )
    approx(squareSurface.uniforms.uBlankSide.value as number, entry.side, 'the surface material carries the blank side')

    const squareWalls = createInstancedWallMaterial(texture, grid, COLOR, true, entry.frame, undefined, undefined, entry.side)
    assert(
      squareWalls.vertexShader.includes('squareBlankSilhouetteRadius(uBlankSide'),
      "the square bar's walls clamp to the tested silhouette",
    )
    approx(squareWalls.uniforms.uBlankSide.value as number, entry.side, 'the wall material carries the blank side')

    // A block (no frame), a flat setup (a side with no wrap) and a round bar (a
    // frame with no side) all compile the shader they always had.
    const blockSurface = createHeightfieldMaterial(texture, grid, COLOR)
    const flatSurface = createHeightfieldMaterial(texture, grid, COLOR, undefined, undefined, entry.side)
    const roundSurface = createHeightfieldMaterial(texture, grid, COLOR, entry.frame)
    for (const [label, material] of [['block', blockSurface], ['flat', flatSurface], ['round', roundSurface]] as const) {
      assert(!material.vertexShader.includes('uBlankSide'), `${label}: the surface gains no silhouette clamp`)
      assert(!('uBlankSide' in material.uniforms), `${label}: the surface gains no blank uniform`)
    }
    const roundWalls = createInstancedWallMaterial(texture, grid, COLOR, false, entry.frame)
    assert(!roundWalls.vertexShader.includes('uBlankSide'), 'round: the walls gain no silhouette clamp')
    assert(!('uBlankSide' in roundWalls.uniforms), 'round: the walls gain no blank uniform')

    // The boundary group mounts the same three meshes with or without the side.
    const plain = createInstancedBoundaryGroup(texture, grid, COLOR, entry.frame)
    const clamped = createInstancedBoundaryGroup(texture, grid, COLOR, entry.frame, undefined, undefined, entry.side)
    assert(plain.children.length === clamped.children.length, 'the clamp adds or removes no boundary mesh')
    assert(plain.children.length === 3, 'the wrapped boundary is the two wall strips and the floor')
    // Both wall strips clamp; the underside quad is degenerate under the wrap
    // (both of its Y coordinates are the axis) and draws nothing, so it keeps
    // the shader it had.
    for (const child of clamped.children.slice(0, 2)) {
      const wall = child as THREE.Mesh
      const material = wall.material as THREE.ShaderMaterial
      assert(material.vertexShader.includes('squareBlankSilhouetteRadius(uBlankSide'), 'both wall strips carry the clamp')
      assert(wall.geometry instanceof THREE.InstancedBufferGeometry, 'the clamped parts are the instanced wall strips')
    }
  } finally {
    texture.dispose()
  }
  console.log('compile-time variants: PASSED')
}

testSilhouetteClampsEveryRenderedRadius()
testSceneMountsOnlyTheStockMeshes()
testSceneKeepsTheHeightfield()
testOnlyTheWrappedSquareBarClamps()

console.log('\nAll square-blank bar-scene tests PASSED.')
