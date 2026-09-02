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

import { serializeImportedMesh } from '../engine/importedMesh'
import { rectProfile } from '../types/project'
import { asSketchFeature, projectWithFeatures, resolvedFeature } from './projectFixtures'
import { hillsWaterlineProject } from './waterlineHillsFixture'

export interface SurfaceTestMesh { positions: Float32Array; index: Uint32Array }

/** Closed analytic height field with a skirt and bottom, independent of CAM. */
export function slopeTestMesh(
  surface: (x: number, y: number) => number,
  width = 60, height = 24, cell = 1,
): SurfaceTestMesh {
  const nx = Math.ceil(width / cell), ny = Math.ceil(height / cell)
  const positions: number[] = [], index: number[] = []
  for (let row = 0; row <= ny; row += 1) for (let col = 0; col <= nx; col += 1) {
    const x = col * width / nx, y = row * height / ny
    positions.push(x, y, surface(x, y))
  }
  const at = (x: number, y: number) => y * (nx + 1) + x
  for (let row = 0; row < ny; row += 1) for (let col = 0; col < nx; col += 1) {
    const a = at(col, row), b = a + 1, d = at(col, row + 1), c = d + 1
    index.push(a, b, c, a, c, d)
  }
  const boundary: number[] = []
  for (let x = 0; x < nx; x += 1) boundary.push(at(x, 0))
  for (let y = 0; y < ny; y += 1) boundary.push(at(nx, y))
  for (let x = nx; x > 0; x -= 1) boundary.push(at(x, ny))
  for (let y = ny; y > 0; y -= 1) boundary.push(at(0, y))
  const base = positions.length / 3
  for (const i of boundary) positions.push(positions[i * 3], positions[i * 3 + 1], -4)
  for (let i = 0; i < boundary.length; i += 1) {
    const j = (i + 1) % boundary.length
    index.push(boundary[i], base + i, base + j, boundary[i], base + j, boundary[j])
    if (i > 0 && i + 1 < boundary.length) index.push(base, base + i + 1, base + i)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

export function surfaceTestProject(mesh: SurfaceTestMesh, diameter = 2) {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < mesh.positions.length; i += 3) {
    minX = Math.min(minX, mesh.positions[i]); maxX = Math.max(maxX, mesh.positions[i])
    minY = Math.min(minY, mesh.positions[i + 1]); maxY = Math.max(maxY, mesh.positions[i + 1])
    minZ = Math.min(minZ, mesh.positions[i + 2]); maxZ = Math.max(maxZ, mesh.positions[i + 2])
  }
  const base = hillsWaterlineProject({ spanX: 2, spanY: 2, cell: 1, toolDiameter: diameter, stepdown: 2 })
  const model = asSketchFeature(resolvedFeature(base.project, 'hills-model'))
  const profile = rectProfile(minX, minY, maxX - minX, maxY - minY)
  const project = projectWithFeatures({ ...base.project, featureDefinitions: {}, features: [], modelAssets: {} }, [{
    ...model, name: 'Slope model', z_top: maxZ, z_bottom: minZ,
    sketch: { ...model.sketch, profile },
    stl: { format: 'stl', scale: 1, axisSwap: 'none', meshAssetId: 'slope-mesh',
      silhouettePaths: [[{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }]] },
  }])
  project.featureDefinitions[project.features[0].definitionId].stl!.meshAssetId = 'slope-mesh'
  project.modelAssets = { 'slope-mesh': serializeImportedMesh({ ...mesh, bounds: { minX, maxX, minY, maxY, minZ, maxZ } }, 'stl') }
  project.stock = { ...project.stock, profile, thickness: maxZ }
  project.operations[0].name = 'Slope finish'
  project.operations[0].stepover = 0.25
  project.operations[0].pocketPattern = 'parallel'
  project.tools[0].maxCutDepth = maxZ - minZ
  return { project, operation: project.operations[0] }
}

/** Two 10-degree shoulders separated by a 45-degree slope. */
export const mixedSlopeHeight = (x: number): number => 2
  + Math.min(x, 20) * Math.tan(Math.PI / 18)
  + Math.max(0, Math.min(x - 20, 20))
  + Math.max(0, x - 40) * Math.tan(Math.PI / 18)
