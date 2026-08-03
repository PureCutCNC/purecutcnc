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
 * Post-import 3D model orientation (issue #241).
 *
 * The load-bearing assertion here is the rigid-rotation regression: rotating a
 * model must not change its proportions. A naive implementation that leaves
 * `z_top`/`z_bottom` alone passes every other check in this file and fails that
 * one, because the Z fit in `csg.ts` stretches the mesh to fill the band.
 */

import * as THREE from 'three'
import { newProject, rectProfile, IDENTITY_MATRIX, type ModelOrientation, type Project } from '../types/project'
import { resolveFeatureInstance } from '../store/helpers/resolveFeatures'
import { buildFeatureMesh, buildFeatureSolid, getManifoldModule, loadSTLTransformedGeometry } from './csg'
import { THEME_PALETTES } from '../theme/palette'
import { computeMeshBounds, orientImportedMesh, serializeImportedMesh, type ImportedTriangleMesh } from './importedMesh'
import {
  isIdentityModelOrientation,
  modelOrientationKey,
  modelOrientationMatrix4,
  normalizeModelOrientation,
  rotatePointByModelOrientation,
} from './importedModelTransform'

const threePalette = THEME_PALETTES.dark.three

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-6): boolean {
  return Math.abs(left - right) <= epsilon
}

function assertApprox(actual: number, expected: number, label: string, epsilon = 1e-6): void {
  assert(approx(actual, expected, epsilon), `${label}: expected ${expected}, got ${actual}`)
}

/** Axis-aligned box spanning x∈[0,2], y∈[0,1], z∈[0,3] — three distinct extents. */
function makeBoxMesh(): ImportedTriangleMesh {
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

function makeProject(
  orientation: ModelOrientation | undefined,
  zBottom: number,
  zTop: number,
  featureId = 'model',
): Project {
  const project = newProject('Model orientation', 'mm')
  const assetId = `model-asset-${featureId}`
  project.modelAssets = { [assetId]: serializeImportedMesh(makeBoxMesh(), 'stl') }
  project.featureDefinitions = {
    [featureId]: {
      id: featureId,
      kind: 'stl',
      profile: rectProfile(0, 0, 2, 1),
      dimensions: [],
      text: null,
      stl: {
        format: 'stl',
        scale: 1,
        axisSwap: 'none',
        orientation,
        meshAssetId: assetId,
        silhouettePaths: [[
          { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 },
        ]],
      },
      operation: 'model',
    },
  }
  project.features = [{
    id: featureId,
    name: 'Model',
    definitionId: featureId,
    transform: IDENTITY_MATRIX,
    constraints: [],
    z_top: zTop,
    z_bottom: zBottom,
    folderId: null,
    visible: true,
    locked: false,
  }]
  return project
}

function positionBounds(positions: Float32Array) {
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i])
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1])
    minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2])
  }
  return { minX, maxX, minY, maxY, minZ, maxZ }
}

// ---------------------------------------------------------------------------
// 1. Rotation primitive: axis conventions and application order
// ---------------------------------------------------------------------------

const X90: ModelOrientation = { rx: 90, ry: 0, rz: 0 }
const Y90: ModelOrientation = { rx: 0, ry: 90, rz: 0 }
const Z90: ModelOrientation = { rx: 0, ry: 0, rz: 90 }

{
  const yAfterX = rotatePointByModelOrientation(X90, 0, 1, 0)
  assert(approx(yAfterX.x, 0) && approx(yAfterX.y, 0) && approx(yAfterX.z, 1),
    'rx=90 should map +Y to +Z')

  const zAfterY = rotatePointByModelOrientation(Y90, 0, 0, 1)
  assert(approx(zAfterY.x, 1) && approx(zAfterY.y, 0) && approx(zAfterY.z, 0),
    'ry=90 should map +Z to +X')

  const xAfterZ = rotatePointByModelOrientation(Z90, 1, 0, 0)
  assert(approx(xAfterZ.x, 0) && approx(xAfterZ.y, 1) && approx(xAfterZ.z, 0),
    'rz=90 should map +X to +Y')

  // Order is X, then Y, then Z. Composing the single-axis rotations by hand in
  // that order must reproduce the combined orientation; the reverse order gives
  // a different point, which is what makes this test meaningful.
  const combined: ModelOrientation = { rx: 90, ry: 90, rz: 0 }
  const step1 = rotatePointByModelOrientation(X90, 0, 1, 0)
  const step2 = rotatePointByModelOrientation(Y90, step1.x, step1.y, step1.z)
  const atOnce = rotatePointByModelOrientation(combined, 0, 1, 0)
  assert(approx(atOnce.x, step2.x) && approx(atOnce.y, step2.y) && approx(atOnce.z, step2.z),
    'combined orientation should equal X-then-Y composition')

  const reversedStep1 = rotatePointByModelOrientation(Y90, 0, 1, 0)
  const reversed = rotatePointByModelOrientation(X90, reversedStep1.x, reversedStep1.y, reversedStep1.z)
  assert(!approx(reversed.z, atOnce.z) || !approx(reversed.x, atOnce.x),
    'Y-then-X should differ from X-then-Y, otherwise the order test proves nothing')
}

// ---------------------------------------------------------------------------
// 2. Matrix form agrees with the point form
// ---------------------------------------------------------------------------

{
  const orientation: ModelOrientation = { rx: 33, ry: -71, rz: 12 }
  const matrix = modelOrientationMatrix4(orientation)
  const point = { x: 1.7, y: -0.4, z: 2.9 }
  const viaMatrix = {
    x: matrix[0] * point.x + matrix[4] * point.y + matrix[8] * point.z + matrix[12],
    y: matrix[1] * point.x + matrix[5] * point.y + matrix[9] * point.z + matrix[13],
    z: matrix[2] * point.x + matrix[6] * point.y + matrix[10] * point.z + matrix[14],
  }
  const viaPoint = rotatePointByModelOrientation(orientation, point.x, point.y, point.z)
  assertApprox(viaMatrix.x, viaPoint.x, 'matrix vs point rotation x')
  assertApprox(viaMatrix.y, viaPoint.y, 'matrix vs point rotation y')
  assertApprox(viaMatrix.z, viaPoint.z, 'matrix vs point rotation z')

  // Rigid: length preserved.
  const sourceLength = Math.hypot(point.x, point.y, point.z)
  const rotatedLength = Math.hypot(viaPoint.x, viaPoint.y, viaPoint.z)
  assertApprox(rotatedLength, sourceLength, 'rotation should preserve length')
}

// ---------------------------------------------------------------------------
// 3. Identity, normalization, and exact 90° round-trips
// ---------------------------------------------------------------------------

{
  assert(isIdentityModelOrientation(undefined), 'absent orientation is identity')
  assert(isIdentityModelOrientation({ rx: 0, ry: 0, rz: 0 }), 'zero orientation is identity')
  assert(isIdentityModelOrientation({ rx: 360, ry: -720, rz: 0 }), 'full turns are identity')
  assert(!isIdentityModelOrientation(X90), '90° is not identity')

  assert(normalizeModelOrientation({ rx: 0, ry: 0, rz: 0 }) === null,
    'identity normalizes to null so nothing is persisted')
  assert(normalizeModelOrientation({ rx: 4 * 90, ry: 0, rz: 0 }) === null,
    'four 90° turns round-trip exactly to identity')
  const wrapped = normalizeModelOrientation({ rx: 270, ry: 0, rz: 0 })
  assert(wrapped && wrapped.rx === -90, '270° should normalize to -90°')

  assert(modelOrientationKey(undefined) === 'none', 'absent orientation keys as none')
  assert(modelOrientationKey({ rx: 0, ry: 0, rz: 0 }) === 'none', 'identity keys as none')
  assert(modelOrientationKey(X90) !== modelOrientationKey(Y90),
    'different orientations must produce different cache keys')

  // Four exact quarter-turns applied to a vertex return it unchanged — this is
  // why the 90° cases short-circuit trig instead of going through Math.sin.
  let point = { x: 1, y: 2, z: 3 }
  for (let turn = 0; turn < 4; turn += 1) {
    point = rotatePointByModelOrientation(X90, point.x, point.y, point.z)
  }
  assert(point.x === 1 && point.y === 2 && point.z === 3,
    'four exact 90° X turns should return the original vertex bit-for-bit')
}

// ---------------------------------------------------------------------------
// 4. orientImportedMesh — bounds recomputed, identity is free
// ---------------------------------------------------------------------------

{
  const mesh = makeBoxMesh()
  assert(orientImportedMesh(mesh, undefined) === mesh, 'identity orientation returns the same mesh')
  assert(orientImportedMesh(mesh, { rx: 0, ry: 0, rz: 0 }) === mesh, 'zero orientation returns the same mesh')

  const rotated = orientImportedMesh(mesh, X90)
  assert(rotated !== mesh, 'a real rotation returns a new mesh')
  // rx=90 maps (x,y,z) → (x, -z, y): x stays 0..2, y becomes -3..0, z becomes 0..1.
  assertApprox(rotated.bounds.minX, 0, 'rotated minX')
  assertApprox(rotated.bounds.maxX, 2, 'rotated maxX')
  assertApprox(rotated.bounds.minY, -3, 'rotated minY')
  assertApprox(rotated.bounds.maxY, 0, 'rotated maxY')
  assertApprox(rotated.bounds.minZ, 0, 'rotated minZ')
  assertApprox(rotated.bounds.maxZ, 1, 'rotated maxZ')
  assert(mesh.bounds.maxZ === 3, 'the source mesh must not be mutated in place')
}

// ---------------------------------------------------------------------------
// 5. Rigid rotation through every geometry consumer (D3 regression)
// ---------------------------------------------------------------------------

const manifold = await getManifoldModule()

{
  // The box is 2 × 1 × 3. Rotated 90° about X it becomes 2 × 3 × 1, so a rigid
  // rotation is one whose Z band is exactly 1 unit tall. This is the band the
  // reorient commit computes; here we assert the geometry consumers honour it.
  const project = makeProject(X90, 2, 3, 'rigid')
  const feature = resolveFeatureInstance(project, 'rigid')
  assert(feature, 'rotated model should resolve')

  const transformed = loadSTLTransformedGeometry(feature, project)
  assert(transformed, 'rotated transformed geometry should load')
  const bounds = positionBounds(transformed.positions)
  assertApprox(bounds.maxX - bounds.minX, 2, 'rotated X extent')
  assertApprox(bounds.maxY - bounds.minY, 3, 'rotated Y extent')
  assertApprox(bounds.maxZ - bounds.minZ, 1, 'rotated Z extent — a squashed model fails here')
  assertApprox(bounds.minZ, 2, 'rotated geometry sits on its z_bottom')
  assertApprox(bounds.maxZ, 3, 'rotated geometry reaches its z_top')
  assertApprox(bounds.minY, -3, 'rotated geometry Y min')
  assertApprox(bounds.maxY, 0, 'rotated geometry Y max')

  // Preview world axes are (modelX, modelZ, modelY) after rotateX(-π/2) and the
  // final Z flip, mirroring the mapping asserted in importedModelTransform.test.
  const preview = buildFeatureMesh(project, feature, false, false, undefined, threePalette)
  preview.updateMatrixWorld(true)
  const previewBounds = new THREE.Box3().setFromObject(preview)
  assertApprox(previewBounds.min.x, bounds.minX, 'preview X min matches CAM geometry')
  assertApprox(previewBounds.max.x, bounds.maxX, 'preview X max matches CAM geometry')
  assertApprox(previewBounds.min.y, bounds.minZ, 'preview Z min matches CAM geometry')
  assertApprox(previewBounds.max.y, bounds.maxZ, 'preview Z max matches CAM geometry')
  assertApprox(previewBounds.min.z, bounds.minY, 'preview Y min matches CAM geometry')
  assertApprox(previewBounds.max.z, bounds.maxY, 'preview Y max matches CAM geometry')

  const solid = buildFeatureSolid(manifold, project, feature)
  assert(solid, 'rotated CSG solid should build')
  const solidBounds = solid.boundingBox()
  assertApprox(solidBounds.min[0], bounds.minX, 'solid X min matches CAM geometry')
  assertApprox(solidBounds.max[0], bounds.maxX, 'solid X max matches CAM geometry')
  assertApprox(solidBounds.min[1], bounds.minY, 'solid Y min matches CAM geometry')
  assertApprox(solidBounds.max[1], bounds.maxY, 'solid Y max matches CAM geometry')
  assertApprox(solidBounds.min[2], bounds.minZ, 'solid Z min matches CAM geometry')
  assertApprox(solidBounds.max[2], bounds.maxZ, 'solid Z max matches CAM geometry')
  solid.delete()
}

// ---------------------------------------------------------------------------
// 6. A Z band that does not match the rotated height still fits, as before
// ---------------------------------------------------------------------------

{
  // Orientation must not change the meaning of the Z fit itself — a band of a
  // different height still stretches the model, exactly as it does unrotated.
  // (The reorient commit is what keeps the band honest; this guards against
  // accidentally hard-coding rigid behaviour into the geometry layer.)
  const project = makeProject(X90, 0, 5, 'stretched')
  const feature = resolveFeatureInstance(project, 'stretched')
  assert(feature, 'stretched model should resolve')
  const transformed = loadSTLTransformedGeometry(feature, project)
  assert(transformed, 'stretched geometry should load')
  const bounds = positionBounds(transformed.positions)
  assertApprox(bounds.maxZ - bounds.minZ, 5, 'Z band still governs the fitted height')
  assertApprox(bounds.maxY - bounds.minY, 3, 'XY is unaffected by the Z fit')
}

// ---------------------------------------------------------------------------
// 7. Cache key includes orientation (stale-geometry guard)
// ---------------------------------------------------------------------------

{
  // Same feature id, same Z band, same asset — only the orientation differs.
  // If orientation were missing from stlTransformedGeometryCacheKey the second
  // call would hand back the first call's geometry.
  const unrotated = makeProject(undefined, 1, 4, 'cached')
  const unrotatedFeature = resolveFeatureInstance(unrotated, 'cached')
  assert(unrotatedFeature, 'unrotated model should resolve')
  const first = loadSTLTransformedGeometry(unrotatedFeature, unrotated)
  assert(first, 'unrotated geometry should load')
  const firstBounds = positionBounds(first.positions)
  assertApprox(firstBounds.maxY - firstBounds.minY, 1, 'unrotated Y extent')

  const rotated = makeProject(X90, 1, 4, 'cached')
  const rotatedFeature = resolveFeatureInstance(rotated, 'cached')
  assert(rotatedFeature, 'rotated model should resolve')
  const second = loadSTLTransformedGeometry(rotatedFeature, rotated)
  assert(second, 'rotated geometry should load')
  const secondBounds = positionBounds(second.positions)
  assertApprox(secondBounds.maxY - secondBounds.minY, 3,
    'rotated Y extent — equal to the unrotated one means a stale cache hit')
}

console.log('Model orientation tests passed')
