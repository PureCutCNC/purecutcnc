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
 * The assembled export mesh is in the standard right-handed Z-up frame model
 * files use (issue #824). Project space is Y-down, so the plan Y is negated on
 * the way out — the inverse of what the model import negates — and an exported
 * file therefore re-imports unchanged.
 *
 * Run with: npx tsx src/engine/modelExport/assemble.test.ts
 */

import { newProject, rectProfile, IDENTITY_MATRIX, type Project } from '../../types/project'
import { computeMeshBounds, flipImportedMeshPlanY, serializeImportedMesh, type ImportedTriangleMesh } from '../importedMesh'
import { assembleModelExportMesh } from './assemble'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

/** Signed volume of a closed mesh: positive when its triangles face outward. */
function signedVolume(mesh: { positions: Float32Array; index: Uint32Array }): number {
  const { positions, index } = mesh
  let volume = 0
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3
    const b = index[i + 1] * 3
    const c = index[i + 2] * 3
    volume +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])
  }
  return volume / 6
}

/** Axis-aligned box spanning x in [0,2], y in [0,1], z in [0,3] — three distinct extents. */
function boxMesh(): ImportedTriangleMesh {
  const positions = new Float32Array([
    0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 1, 0,
    0, 0, 3, 2, 0, 3, 2, 1, 3, 0, 1, 3,
  ])
  const index = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ])
  return { positions, index, bounds: computeMeshBounds(positions) }
}

/** The box stored the way an import leaves it: project space, silhouette beside it. */
function makeProject(): Project {
  const project = newProject('Export frame', 'mm')
  const assetId = 'model-asset-model'
  project.modelAssets = { [assetId]: serializeImportedMesh(boxMesh(), 'stl') }
  project.featureDefinitions = {
    model: {
      id: 'model',
      kind: 'stl',
      profile: rectProfile(0, 0, 2, 1),
      dimensions: [],
      text: null,
      stl: {
        format: 'stl',
        scale: 1,
        axisSwap: 'none',
        meshAssetId: assetId,
        silhouettePaths: [[{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 }]],
      },
      operation: 'model',
    },
  }
  project.features = [{
    id: 'model',
    name: 'Model',
    definitionId: 'model',
    transform: IDENTITY_MATRIX,
    constraints: [],
    z_top: 3,
    z_bottom: 0,
    folderId: null,
    visible: true,
    locked: false,
  }]
  return project
}

console.log('modelExport/assemble — project space vs the file world frame (#824)')

const result = await assembleModelExportMesh(makeProject(), {
  includeImportedMeshes: true,
  curveQuality: 'normal',
})
const bounds = computeMeshBounds(result.mesh.positions)

// Stored at y in [0, 1]; the file states the same face at y in [-1, 0].
assert(bounds.minY === -1 && bounds.maxY === 0, 'Y extent: ' + bounds.minY + '..' + bounds.maxY)
assert(bounds.minX === 0 && bounds.maxX === 2, 'X extent: ' + bounds.minX + '..' + bounds.maxX)
assert(bounds.minZ === 0 && bounds.maxZ === 3, 'Z extent: ' + bounds.minZ + '..' + bounds.maxZ)

// A mirror inverts every triangle, so the winding is reversed with the
// positions: an STL whose normals point inward reads as a broken solid.
const sourceMesh = boxMesh()
assert(signedVolume(sourceMesh) > 0, 'the fixture box is wound outward: ' + signedVolume(sourceMesh))
assert(
  Math.abs(signedVolume(result.mesh) - signedVolume(sourceMesh)) < 1e-6,
  'the exported mesh keeps the source winding: ' + signedVolume(result.mesh),
)

// The import negates the same axis back, so re-importing the file returns the
// mesh the project stores: the export -> import round trip is exact.
const reimported = flipImportedMeshPlanY({
  positions: result.mesh.positions,
  index: result.mesh.index,
  bounds,
}, 'none')
const source = sourceMesh.positions
assert(reimported.positions.length === source.length, 'vertex count survives the round trip')
for (let i = 0; i < source.length; i += 1) {
  assert(
    reimported.positions[i] === source[i],
    'vertex ' + i + ': ' + reimported.positions[i] + ' !== ' + source[i],
  )
}
for (let i = 0; i < sourceMesh.index.length; i += 1) {
  assert(reimported.index[i] === sourceMesh.index[i], 'winding ' + i + ' survives the round trip')
}

console.log('modelExport/assemble.test.ts passed')
