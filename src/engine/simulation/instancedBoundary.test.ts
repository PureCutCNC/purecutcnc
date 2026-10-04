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
 * Tests for the instanced stock-boundary construction.
 *
 * Run with: npx tsx src/engine/simulation/instancedBoundary.test.ts
 */

import * as THREE from 'three'
import {
  createInstancedBoundaryGroup,
  createWallStripTemplate,
  wallInstanceCount,
} from './instancedBoundary'
import { createHeightfieldTexture } from './gpuMesh'
import {
  createHeightfieldMaterial,
  OUTLINE_CORNER_GLSL,
  OUTLINE_TURN_GLSL,
  STEP_GLSL,
  SURFACE_NORMAL_GLSL,
} from './heightfieldShader'
import type { SimulationGrid } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeGrid(cols: number, rows: number): SimulationGrid {
  return {
    originX: -5,
    originY: 3,
    cellSize: 0.5,
    cols,
    rows,
    stockBottomZ: 0,
    stockTopZ: 10,
    topZ: new Float32Array(cols * rows).fill(10),
  }
}

function testWallInstanceCount(): void {
  console.log('Testing wall instance count covers every interior + perimeter edge...')
  // 2×1 cells: vertical edges (cols+1)×rows = 3, horizontal edges cols×(rows+1) = 4.
  assert(wallInstanceCount({ cols: 2, rows: 1 }) === 7, '2×1 grid has 7 edges')
  // 1×1 cell: 2 vertical + 2 horizontal = the 4 perimeter walls.
  assert(wallInstanceCount({ cols: 1, rows: 1 }) === 4, '1×1 grid has its 4 perimeter edges')
  assert(
    wallInstanceCount({ cols: 100, rows: 60 }) === 101 * 60 + 100 * 61,
    'instance count follows (cols+1)·rows + cols·(rows+1)',
  )
  console.log('wall instance count: PASSED')
}

function testStripTemplateScalesByRowOnly(): void {
  console.log('Testing wall strip template scales with row length, instances with row count...')
  for (const size of [24, 240, 1500]) {
    const grid = makeGrid(size, size)
    const vertical = createWallStripTemplate(grid, grid.cols + 1, grid.rows)
    const horizontal = createWallStripTemplate(grid, grid.cols, grid.rows + 1)

    // O(cols) template memory, O(rows) instances — never O(cols × rows) data.
    assert(vertical.getAttribute('position').count === (size + 1) * 4, 'vertical strip has 4 verts per edge in the row')
    assert(vertical.instanceCount === size, 'vertical strip instances once per row')
    assert(horizontal.getAttribute('position').count === size * 4, 'horizontal strip has 4 verts per edge in the row')
    assert(horizontal.instanceCount === size + 1, 'horizontal strip instances once per row boundary')

    const vIndex = vertical.getIndex()
    assert(vIndex !== null && vIndex.count === (size + 1) * 6, 'strip quads are indexed as two triangles each')

    // Total drawn quads across both strips must equal the edge count.
    const drawnQuads = (vertical.getIndex()!.count / 6) * vertical.instanceCount
      + (horizontal.getIndex()!.count / 6) * horizontal.instanceCount
    assert(drawnQuads === wallInstanceCount(grid), `strips must cover every edge exactly once at ${size}×${size}`)

    // Template corners encode (edgeIndex, along ∈ 0|1, top ∈ 0|1) — real
    // positions come from the vertex shader.
    const position = vertical.getAttribute('position')
    for (let i = 0; i < Math.min(position.count, 8); i += 1) {
      const along = position.getY(i)
      const top = position.getZ(i)
      assert((along === 0 || along === 1) && (top === 0 || top === 1), 'strip corners carry unit along/top codes')
    }
    vertical.dispose()
    horizontal.dispose()
  }
  console.log('row-strip template scaling: PASSED')
}

function testTemplateBoundingSphereCoversStock(): void {
  console.log('Testing template bounding sphere covers the stock, not the unit quad...')
  const grid = makeGrid(40, 20)
  const template = createWallStripTemplate(grid, grid.cols + 1, grid.rows)
  const sphere = template.boundingSphere
  assert(sphere !== null, 'template must carry an explicit bounding sphere')
  const corners = [
    new THREE.Vector3(grid.originX, grid.stockBottomZ, grid.originY),
    new THREE.Vector3(grid.originX + grid.cols * grid.cellSize, grid.stockTopZ, grid.originY + grid.rows * grid.cellSize),
  ]
  for (const corner of corners) {
    assert(
      sphere!.containsPoint(corner),
      `bounding sphere must contain stock corner ${corner.toArray().join(',')}`,
    )
  }
  template.dispose()
  console.log('template bounding sphere: PASSED')
}

function testSurfaceAndWallsShareStepPredicate(): void {
  console.log('Testing the surface sheet and the wall mesh classify an edge with one predicate...')
  // Issue #829: when the wall mesh drew a step the surface did not know about,
  // the flat top beside it borrowed the riser's normal and a tab grew a dark
  // band. Both shaders must call edgeIsStep, not a private copy of the rule.
  const grid = makeGrid(8, 8)
  const texture = createHeightfieldTexture(grid)
  const stock = new THREE.Color(0x8899aa)
  const surface = createHeightfieldMaterial(texture, grid, stock)
  const boundary = createInstancedBoundaryGroup(texture, grid, stock)
  const walls = boundary.children.filter(
    (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.geometry instanceof THREE.InstancedBufferGeometry,
  )

  assert(STEP_GLSL.includes('bool edgeIsStep('), 'the shared predicate must be exported for both shaders')
  assert(surface.fragmentShader.includes('edgeIsStep('), 'the top surface must classify its edges with edgeIsStep')
  assert(walls.length === 2, 'boundary group must expose both wall strips')
  for (const wall of walls) {
    assert(
      (wall.material as THREE.ShaderMaterial).vertexShader.includes('edgeIsStep('),
      'both wall strips must classify their edges with the same predicate as the surface',
    )
  }

  // Issue #939: a riser inside a slope is a piece of the surface. The wall mesh
  // lights it with the surface's own normal code, not a second estimate that
  // could differ by a shade and draw the cell grid back in.
  assert(
    surface.fragmentShader.includes(SURFACE_NORMAL_GLSL) && surface.fragmentShader.includes(STEP_GLSL),
    'the top surface must light itself with the shared surface normal',
  )
  for (const wall of walls) {
    const wallFragment = (wall.material as THREE.ShaderMaterial).fragmentShader
    assert(
      wallFragment.includes(SURFACE_NORMAL_GLSL) && wallFragment.includes(STEP_GLSL),
      'both wall strips must light slope risers with the same surface normal as the tops',
    )
    assert(
      (wall.material as THREE.ShaderMaterial).uniforms.uStockTopZ.value === grid.stockTopZ,
      'wall strips need the stock top to match the surface depth shading on slope risers',
    )
  }

  // Issue #939, part 2: tops, walls and the underside all move a grid corner
  // by one shared rule. A private copy in any of them opens a gap or an
  // overlap along every slanted wall.
  const floor = boundary.children.find(
    (child): child is THREE.Mesh => child instanceof THREE.Mesh && !(child.geometry instanceof THREE.InstancedBufferGeometry),
  )
  assert(floor !== undefined, 'boundary group must expose the underside')
  const outlineUsers: Array<[string, string]> = [
    ['top surface vertex shader', surface.vertexShader],
    ...walls.map((wall): [string, string] => ['wall strip vertex shader', (wall.material as THREE.ShaderMaterial).vertexShader]),
    ['underside fragment shader', (floor!.material as THREE.ShaderMaterial).fragmentShader],
  ]
  for (const [name, source] of outlineUsers) {
    assert(
      source.includes(OUTLINE_TURN_GLSL) && source.includes(OUTLINE_CORNER_GLSL) && source.includes(STEP_GLSL),
      `the ${name} must place grid corners with the shared outline rule`,
    )
    assert(/outline(CornerOffset|CellAt)\(/.test(source.split(OUTLINE_CORNER_GLSL)[1] ?? ''), `the ${name} must use the shared outline rule`)
  }

  surface.dispose()
  boundary.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose()
      ;(object.material as THREE.Material).dispose()
    }
  })
  texture.dispose()
  console.log('shared step predicate: PASSED')
}

function testBoundaryGroupShape(): void {
  console.log('Testing boundary group wiring (meshes, materials, uniforms)...')
  const grid = makeGrid(30, 12)
  const texture = createHeightfieldTexture(grid)
  const group = createInstancedBoundaryGroup(texture, grid, new THREE.Color(0x8899aa))

  const meshes = group.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh)
  assert(meshes.length === 3, `boundary group should hold 2 wall strips + floor, got ${meshes.length} meshes`)

  const walls = meshes.filter((mesh) => mesh.geometry instanceof THREE.InstancedBufferGeometry)
  assert(walls.length === 2, 'two meshes must use instanced wall strips (vertical + horizontal)')
  for (const wallMesh of walls) {
    assert(wallMesh.frustumCulled === false, 'instanced walls must not be frustum culled (positions are shader-derived)')
  }
  const verticalFlags = walls
    .map((mesh) => (mesh.material as THREE.ShaderMaterial).uniforms.uVertical.value as number)
    .sort()
  assert(verticalFlags[0] === 0 && verticalFlags[1] === 1, 'one strip must be vertical (uVertical=1), one horizontal (0)')

  const floor = meshes.find((mesh) => !(mesh.geometry instanceof THREE.InstancedBufferGeometry))
  assert(floor !== undefined, 'one mesh must be the floor quad')
  assert(floor!.geometry.getAttribute('position').count === 6, 'floor is a single quad (2 triangles)')

  for (const mesh of meshes) {
    const material = mesh.material as THREE.ShaderMaterial
    assert(material.glslVersion === THREE.GLSL3, 'boundary shaders require GLSL3 (texelFetch, gl_InstanceID)')
    assert(material.uniforms.uHeightfield.value === texture, 'material must sample the shared heightfield texture')
    assert(material.uniforms.uCols.value === grid.cols && material.uniforms.uRows.value === grid.rows, 'grid dimensions wired as uniforms')
    assert(material.uniforms.uStockBottomZ.value === grid.stockBottomZ, 'stock bottom wired as uniform')
    material.dispose()
    mesh.geometry.dispose()
  }
  texture.dispose()
  console.log('boundary group wiring: PASSED')
}

try {
  testWallInstanceCount()
  testStripTemplateScalesByRowOnly()
  testTemplateBoundingSphereCoversStock()
  testSurfaceAndWallsShareStepPredicate()
  testBoundaryGroupShape()
  console.log('\nAll instanced boundary tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
