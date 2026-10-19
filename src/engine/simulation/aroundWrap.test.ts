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
import { createHash } from 'node:crypto'
import * as THREE from 'three'
import { aroundFrame, wrapPoint } from '../aroundFrame'
import { stockSpacePoint, toolSpacePoint } from '../rotaryFrame'
import { newProject, roundStock } from '../../types/project'
import { squareStock } from '../../types/barStock'
import { unrolledProject } from '../aroundFrame'
import { createBarTurnGroup, sameAroundFrame, simulationBarAngle, simulationToolPoint, turnSimulationBar, aroundFrameKey } from '../../components/simulation/aroundView'
import { AROUND_CELL_INDEX_GLSL, AROUND_WRAP_GLSL, aroundBounds } from './aroundWrap'
import { compileScalarGlsl } from './glslScalar.testSupport'
import { createHeightfieldMaterial } from './heightfieldShader'
import { createInstancedBoundaryGroup } from './instancedBoundary'
import { createSimulationGrid } from './grid'
import { createHeightfieldTexture, createStockPlaneGeometry } from './gpuMesh'

// Frozen flat shader sources at 1a68980f: Around must add no flat GPU work.
const flatShaderHashes = [
  ['303fe7c8aefe844b80ee688b2d0556e50d1f5e3ca134c87f1d104bb4ba0c2f72', '511ba49d58ec5a0ad1eeb83a2f96f4d3acf389768b0c2bc4c4d8cb338fa0e8e4'],
  ['3d149f26ddd48d221e4648b188cd96a168f08d7eaf94d0447bedd44af4d7c878', 'b46a1ee312cfc6814ecaa77f9042d99d652ed5074f43b0e512f5e4a292bbbe39'],
  ['3d149f26ddd48d221e4648b188cd96a168f08d7eaf94d0447bedd44af4d7c878', 'b46a1ee312cfc6814ecaa77f9042d99d652ed5074f43b0e512f5e4a292bbbe39'],
  ['bb338c5aac5eb8fa279ba129dc52b3ea2766a48da0d083c89875bcfe5dcd043b', '5906875a207cbda8e8d0719747363ec96f4a40216b2689e9b67fbdc4f5029a2b'],
]
const shader = compileScalarGlsl(AROUND_WRAP_GLSL)
const close = (actual: number, expected: number, label: string): void => assert(Math.abs(actual - expected) < 1e-8, `${label}: ${actual} != ${expected}`)
const world = (p: { x: number; y: number; z: number }): THREE.Vector3 => new THREE.Vector3(p.x, p.z, p.y)
for (const axis of ['x', 'y'] as const) {
  const stock = roundStock(20, 85, axis, { x: 13, y: -17 })
  const frame = aroundFrame(stock)
  const project = { ...newProject(), stock }
  const grid = createSimulationGrid(unrolledProject(project, frame), { targetLongAxisCells: 123 })
  const texture = createHeightfieldTexture(grid)
  const color = new THREE.Color('gray')
  const flatMaterial = createHeightfieldMaterial(texture, grid, color)
  const barMaterial = createHeightfieldMaterial(texture, grid, color, frame)
  const flatBoundary = createInstancedBoundaryGroup(texture, grid, color)
  const barBoundary = createInstancedBoundaryGroup(texture, grid, color, frame)
  for (const [index, material] of [flatMaterial, ...flatBoundary.children.map((child) => (child as THREE.Mesh).material as THREE.ShaderMaterial)].entries()) {
    for (const [stage, source] of [material.vertexShader, material.fragmentShader].entries()) {
      assert.equal(createHash('sha256').update(source).digest('hex'), flatShaderHashes[index][stage], 'flat shader is byte-for-byte unchanged')
    }
    assert.equal(material.defines.AROUND_WRAP, undefined, 'flat setup has no wrap define')
    assert(!material.vertexShader.includes('aroundWrap'), 'flat vertex source has no wrap code')
    assert(!material.fragmentShader.includes('aroundWrap'), 'flat fragment source has no wrap code')
    assert.equal(material.uniforms.uAroundPeriod, undefined, 'flat has no extra uniforms')
  }
  for (const material of [barMaterial, ...barBoundary.children.map((child) => (child as THREE.Mesh).material as THREE.ShaderMaterial)]) {
    assert.equal(material.defines.AROUND_WRAP, 1, 'surface, walls and floor have the compile-time variant')
    assert(material.vertexShader.includes(AROUND_WRAP_GLSL), 'every bar vertex stage uses the tested formula')
    assert(material.vertexShader.includes('aroundClampSheet'), 'partial final cell is clipped at the seam')
    // The wire-up, not just the formula: the angle comes from the zero-line
    // uniform (issue #1026) and only the clamp uses the sheet's own start.
    assert(material.vertexShader.includes('aroundWrap(sheet.x, sheet.y, sheet.z, uAroundCentre, uAroundRadius, uAroundZero'), 'the wrap reads the zero line uniform')
    assert(material.vertexShader.includes('aroundNormal(n.x, n.y, n.z, across, uAroundZero'), 'the normals read the zero line uniform')
    assert(material.vertexShader.includes('aroundClampAcross(sheet.z, uAroundStart'), 'the clamp still reads the sheet start')
  }
  assert(barMaterial.fragmentShader.includes('aroundSurfaceNormal(surfaceNormal('), 'surface lighting follows the radial normal')
  assert((barBoundary.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>).material.vertexShader.includes('aroundSurfaceNormal(direction * edgePerp'), 'wall normals turn with the circumference')
  const geometry = createStockPlaneGeometry(grid, frame)
  const bounds = aroundBounds(grid, frame)
  // A round grid's radial envelope is the bar radius, so the default bounds are
  // exactly the nominal cylinder box (`0..2r`) this path always produced.
  assert.equal(grid.stockTopZ, frame.radius, `${axis}: a round grid's envelope is the bar radius`)
  assert(aroundBounds(grid, frame).equals(aroundBounds(grid, frame, frame.radius)), `${axis}: the default bounds stay the round bar's nominal box`)
  close(bounds.min.y, 0, `${axis}: round bounds still start at the stock bottom`)
  close(bounds.max.y, 2 * frame.radius, `${axis}: round bounds still top out at 2r`)
  assert(geometry.boundingBox?.equals(bounds), 'surface bounds enclose the cylinder')
  for (const child of barBoundary.children) assert((child as THREE.Mesh).geometry.boundingBox?.equals(bounds), 'each boundary uses cylinder bounds')
  const seam = frame.sheetStart + frame.circumference
  assert.equal(shader.aroundClampAcross(seam + grid.cellSize * 0.7, frame.sheetStart, frame.circumference), seam, 'partial last cell cannot overlap the first row')
  assert.equal(shader.aroundClampAcross(seam - grid.cellSize * 0.3, frame.sheetStart, frame.circumference), seam - grid.cellSize * 0.3, 'the visible part of the partial cell is retained')
  const turn = createBarTurnGroup(frame)
  for (const angle of [-405, -90, 0, 30, 90, 135, 180, 225, 270, 315, 360, 765]) {
    for (const height of [0, 3.5, frame.radius]) {
      const across = frame.zero + angle * frame.circumference / 360
      const pose = axis === 'x' ? { x: 37, y: across, z: height } : { x: across, y: 23, z: height }
      const wrapped = wrapPoint(pose, frame)
      const expected = world(stockSpacePoint(wrapped, stock))
      const components = [0, 1, 2].map((component) => shader.aroundWrap(pose.x, height, pose.y, frame.centre, frame.radius, frame.zero, frame.circumference, axis === 'x', component) as number)
      components.forEach((component, i) => close(component, expected.getComponent(i), `${axis}/${angle}: shader stock point component ${i}`))
      const point = new THREE.Vector3(...components as [number, number, number])
      close(Math.hypot((axis === 'x' ? point.z : point.x) - frame.centre, point.y - frame.radius), height, 'remaining material radius is the heightfield value')
      assert(bounds.containsPoint(point), 'wrapped point is inside culling/auto-frame bounds')
      const actualAngle = simulationBarAngle(pose, frame)
      close(actualAngle, angle, 'viewport angle follows across coordinate')
      turnSimulationBar(turn.pivot, actualAngle, frame)
      turn.pivot.updateMatrixWorld(true)
      const turned = turn.content.localToWorld(point.clone())
      const expectedTurn = world(toolSpacePoint(stockSpacePoint(wrapped, stock), actualAngle, stock))
      turned.toArray().forEach((component, i) => close(component, expectedTurn.getComponent(i), 'group turn agrees with toolSpacePoint'))
      const tool = simulationToolPoint(pose, frame)
      close(tool.x, wrapped.x, 'vertical tool x')
      close(tool.y, frame.radius + height, 'vertical tool tip height')
      close(tool.z, wrapped.y, 'vertical tool across centreline')
      close(turned.distanceTo(tool), 0, 'cell at playback angle is at the top directly under the tool')
      const normal = [0, 1, 2].map((component) => shader.aroundNormal(0, 1, 0, across, frame.zero, frame.circumference, axis === 'x', component) as number)
      close(normal[1], Math.cos(angle * Math.PI / 180), 'radial lighting up')
      close(normal[axis === 'x' ? 2 : 0], Math.sin(angle * Math.PI / 180), 'radial lighting across')
      for (const n of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)]) {
        const mapped = new THREE.Vector3(...[0, 1, 2].map((component) => shader.aroundNormal(n.x, n.y, n.z, across, frame.zero, frame.circumference, axis === 'x', component) as number) as [number, number, number])
        close(mapped.length(), 1, 'wall normals retain unit length')
        close(mapped.dot(new THREE.Vector3(...normal as [number, number, number])), 0, 'wall normals are perpendicular to the radius')
      }
    }
  }
  assert.deepEqual(simulationToolPoint({ x: 2, y: 3, z: 4 }).toArray(), [2, 4, 3], 'flat tool placement unchanged')
  geometry.dispose()
  texture.dispose()
  flatMaterial.dispose()
  barMaterial.dispose()
  for (const group of [flatBoundary, barBoundary]) for (const child of group.children) {
    const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
    mesh.geometry.dispose()
    mesh.material.dispose()
  }
}

// ── Square blanks: the actual radial envelope about the true pivot (#1016) ──

{
  for (const axis of ['x', 'y'] as const) {
    const stock = squareStock(20, 85, axis, { x: 13, y: -17 })
    const frame = aroundFrame(stock)
    const project = { ...newProject(), stock }
    const grid = createSimulationGrid(unrolledProject(project, frame), {
      targetLongAxisCells: 123,
      squareBar: { side: stock.thickness, frame },
    })
    const maxRadius = stock.thickness * Math.SQRT1_2
    const bounds = aroundBounds(grid, frame, maxRadius)
    const nominal = aroundBounds(grid, frame, frame.radius)

    // The shared renderers pass no radius: `stockTopZ` must already be the
    // square-capable corner envelope, never the nominal inscribed cylinder.
    assert(Math.abs(grid.stockTopZ - maxRadius) < 1e-9, `${axis}: square stock top is the corner radius`)
    const shared = aroundBounds(grid, frame)
    assert(shared.equals(bounds), `${axis}: the default bounds use the grid's corner envelope`)

    // About the same pivot: the world height is pivot +- maxRadius, never
    // 0..2maxRadius, which would lift the blank off its own axis.
    close(bounds.min.y, frame.radius - maxRadius, `${axis}: square bounds bottom is pivot - maxRadius`)
    close(bounds.max.y, frame.radius + maxRadius, `${axis}: square bounds top is pivot + maxRadius`)
    const acrossMin = axis === 'x' ? bounds.min.z : bounds.min.x
    const acrossMax = axis === 'x' ? bounds.max.z : bounds.max.x
    close(acrossMin, frame.centre - maxRadius, `${axis}: across bounds reach the corners on the low side`)
    close(acrossMax, frame.centre + maxRadius, `${axis}: and on the high side`)
    const alongMin = axis === 'x' ? bounds.min.x : bounds.min.z
    const alongMax = axis === 'x' ? bounds.max.x : bounds.max.z
    close(alongMin, axis === 'x' ? grid.originX : grid.originY, `${axis}: along bounds keep the grid origin`)
    close(
      alongMax,
      (axis === 'x' ? grid.originX + grid.cols * grid.cellSize : grid.originY + grid.rows * grid.cellSize),
      `${axis}: and the grid extent`,
    )

    // The nominal (inscribed) box is a subset; its own values are unchanged.
    close(nominal.min.y, 0, `${axis}: the nominal round box still spans 0..2r`)
    close(nominal.max.y, 2 * frame.radius, `${axis}: the nominal round box is byte-identical`)
    assert(bounds.containsBox(nominal), `${axis}: the square envelope contains the nominal cylinder`)

    // 0/45/90 rays: half the side on a flat, the full corner radius at 45.
    for (const [angle, radius] of [[0, stock.thickness / 2], [45, maxRadius], [90, stock.thickness / 2]] as const) {
      const radians = angle * Math.PI / 180
      const point = new THREE.Vector3(
        axis === 'x' ? (grid.originX + grid.cols * grid.cellSize) / 2 : frame.centre + radius * Math.sin(radians),
        frame.radius + radius * Math.cos(radians),
        axis === 'x' ? frame.centre + radius * Math.sin(radians) : (grid.originY + grid.rows * grid.cellSize) / 2,
      )
      assert(bounds.containsPoint(point), `${axis}: the ${angle}° surface point is inside the square envelope`)
    }
    assert(
      !nominal.containsPoint(new THREE.Vector3(
        axis === 'x' ? grid.originX : frame.centre + maxRadius,
        frame.radius + maxRadius,
        axis === 'x' ? frame.centre + maxRadius : grid.originY,
      )),
      `${axis}: a corner falls outside the old nominal bounds, so the guarantee is not vacuous`,
    )

    // The actual GPU builders, given only the grid: their culling volume must
    // hold the corners too, or a raised corner is clipped while it is cut.
    const texture = createHeightfieldTexture(grid)
    const surface = createStockPlaneGeometry(grid, frame)
    assert(surface.boundingBox?.equals(bounds), `${axis}: the surface sheet's bounds hold the corners`)
    surface.dispose()
    const boundary = createInstancedBoundaryGroup(texture, grid, new THREE.Color('gray'), frame)
    for (const child of boundary.children) {
      const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
      assert(mesh.geometry.boundingBox?.equals(bounds), `${axis}: every boundary part's bounds hold the corners`)
    }
    boundary.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose()
        ;(object.material as THREE.Material).dispose()
      }
    })
    texture.dispose()
  }
}

// ── The seam's neighbour lookup (issue #395 G3) ──────────────────────────────

// The compiled code is the GPU's own integer text. The cell before the first
// across row must read the last one (simply deleting the wrap left every other
// test green); the along index must never wrap. `count` is the shader's own
// `int(ceil(uAroundPeriod / uCellSize))`.
for (const axis of ['x', 'y'] as const) {
  const period = 20
  const cellSize = 0.5
  const count = Math.ceil(period / cellSize)
  const aroundCell = compileScalarGlsl(AROUND_CELL_INDEX_GLSL, {
    uAroundPeriod: period,
    uCellSize: cellSize,
    uAroundX: axis === 'x',
  }).aroundCell
  const call = (x: number, y: number): { x: number; y: number } => aroundCell({ x, y }) as { x: number; y: number }
  const wrap = (index: number): number => ((index % count) + count) % count
  for (const index of [-2, -1, 0, 1, count - 2, count - 1, count, count + 1]) {
    const cell = axis === 'x' ? call(7, index) : call(index, 7)
    const across = axis === 'x' ? cell.y : cell.x
    const along = axis === 'x' ? cell.x : cell.y
    assert.equal(across, wrap(index), `${axis}: across index ${index} reads ${wrap(index)}`)
    assert.equal(along, 7, `${axis}: along index stays 7 for across ${index}`)
  }
  // Out of range on the along axis too: the wrap must not reach it there.
  for (const index of [-count - 1, count + 1]) {
    const cell = axis === 'x' ? call(index, 3) : call(3, index)
    const along = axis === 'x' ? cell.x : cell.y
    assert.equal(along, index, `${axis}: along index ${index} is never wrapped`)
  }
}

// ── The frame comparison that keys the viewport's effects (issue #395 G3) ────

// A rebuilt frame with the same values must compare equal, so an unrelated
// project edit does not tear the bar down; a real change must not.
for (const axis of ['x', 'y'] as const) {
  const stock = roundStock(20, 85, axis, { x: 13, y: -17 })
  const frame = aroundFrame(stock)
  const rebuilt = aroundFrame({ ...stock })
  assert(sameAroundFrame(frame, rebuilt), `${axis}: frames rebuilt from the same stock are equal`)
  assert.equal(aroundFrameKey(rebuilt), aroundFrameKey(frame), `${axis}: the key is stable for the same values`)
  assert(!sameAroundFrame(frame, aroundFrame(roundStock(24, 85, axis, { x: 13, y: -17 }))), `${axis}: a different diameter is a different frame`)
  assert(!sameAroundFrame(frame, aroundFrame(roundStock(20, 85, axis === 'x' ? 'y' : 'x', { x: 13, y: -17 }))), `${axis}: a different bar axis is a different frame`)
  assert(!sameAroundFrame(frame, aroundFrame(roundStock(20, 85, axis, { x: 113, y: -117 }))), `${axis}: a moved bar is a different frame`)
}
// Every field counts, including ones a round bar's own frame derives from the
// others (`zero = centre`, `sheetStart = zero - C/2`). Moving the bar changes
// them together, so only a frame that differs in one alone shows the field is
// compared.
{
  const frame = aroundFrame(roundStock(20, 85, 'x', { x: 13, y: -17 }))
  assert(!sameAroundFrame(frame, { ...frame, sheetStart: frame.sheetStart + 1 }), 'the sheet start is part of the comparison')
  assert(!sameAroundFrame(frame, { ...frame, zero: frame.zero + 1 }), 'the zero line is part of the comparison')
}
assert(sameAroundFrame(undefined, undefined), 'two flat setups compare equal')
assert(!sameAroundFrame(undefined, aroundFrame(roundStock(20, 85, 'x', { x: 13, y: -17 }))), 'a flat setup is not a bar frame')

console.log('Around wrap shader and viewport pose tests passed')
