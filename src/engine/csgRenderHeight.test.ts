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
 * Unit-aware minimum render height (issue #1009).
 *
 * The 3D view used to floor every height at a unit-blind `0.1`, so in an inch
 * project a 0.0625 in feature was drawn 0.1 in tall — thicker than the 0.0625 in
 * stock drawn beside it. Every site now floors at `minRenderHeight(units)`
 * (0.01 mm) purely to keep a zero-height shape drawable, and draws the entered
 * height otherwise.
 *
 * Run with: npx tsx src/engine/csgRenderHeight.test.ts
 */

import * as THREE from 'three'
import {
  IDENTITY_MATRIX,
  newProject,
  rectProfile,
  type Clamp,
  type Project,
  type SketchFeature,
  type Tab,
} from '../types/project'
import type { Units } from '../utils/units'
import { resolveFeatureInstance } from '../store/helpers/resolveFeatures'
import {
  buildClampMesh,
  buildFeatureMesh,
  buildFeatureSolid,
  buildTabMesh,
  getManifoldModule,
  loadSTLTransformedGeometry,
  minRenderHeight,
} from './csg'
import { THEME_PALETTES } from '../theme/palette'
import { computeMeshBounds, serializeImportedMesh, type ImportedTriangleMesh } from './importedMesh'

const threePalette = THEME_PALETTES.dark.three

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertApprox(actual: number, expected: number, label: string, epsilon = 1e-6): void {
  assert(Math.abs(actual - expected) <= epsilon, `${label}: expected ${expected}, got ${actual}`)
}

function makeFeature(
  id: string,
  operation: SketchFeature['operation'],
  zBottom: number,
  zTop: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 4, 4),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function makeProject(units: Units): Project {
  return newProject('Render height', units)
}

/** World-Y extent — the viewport's vertical axis after `rotateX(-π/2)`. */
function meshHeightY(object: THREE.Object3D): number {
  object.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(object)
  return box.max.y - box.min.y
}

function zExtent(positions: Float32Array): { minZ: number; maxZ: number } {
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 2; i < positions.length; i += 3) {
    minZ = Math.min(minZ, positions[i])
    maxZ = Math.max(maxZ, positions[i])
  }
  return { minZ, maxZ }
}

// ---------------------------------------------------------------------------
// 1. The helper itself: 0.01 mm, converted to the project's units
// ---------------------------------------------------------------------------

assertApprox(minRenderHeight('mm'), 0.01, 'minRenderHeight(mm)')
assertApprox(minRenderHeight('inch'), 0.01 / 25.4, 'minRenderHeight(inch)')
assert(minRenderHeight('inch') < 0.1, 'inch floor is far below the old unit-blind 0.1')

// ---------------------------------------------------------------------------
// 2. Feature extrusion: the entered height, in the project's units
// ---------------------------------------------------------------------------

const inchProject = makeProject('inch')
const mmProject = makeProject('mm')

{
  const feature = makeFeature('thin-inch', 'add', 0, 0.0625)
  const mesh = buildFeatureMesh(inchProject, feature, false, false, undefined, threePalette)
  const height = meshHeightY(mesh)
  assertApprox(height, 0.0625, 'inch 0.0625 feature height')
  assert(Math.abs(height - 0.1) > 1e-6, 'inch feature must not be inflated to the old 0.1 floor')
}

{
  const feature = makeFeature('thin-mm', 'add', 0, 0.05)
  const mesh = buildFeatureMesh(mmProject, feature, false, false, undefined, threePalette)
  assertApprox(meshHeightY(mesh), 0.05, 'mm 0.05 feature height')
}

{
  // A height taller than the old floor is untouched.
  const feature = makeFeature('tall-mm', 'add', 0, 5)
  const mesh = buildFeatureMesh(mmProject, feature, false, false, undefined, threePalette)
  assertApprox(meshHeightY(mesh), 5, 'mm 5 feature height is unchanged')
}

// ---------------------------------------------------------------------------
// 3. Region wall uses the stock thickness as its height
// ---------------------------------------------------------------------------

{
  const feature = makeFeature('region-inch', 'region', 0, 0.0625)
  const mesh = buildFeatureMesh(inchProject, feature, false, false, 0.0625, threePalette)
  const height = meshHeightY(mesh)
  assertApprox(height, 0.0625, 'inch 0.0625 region wall height')
  assert(Math.abs(height - 0.1) > 1e-6, 'inch region wall must not be inflated to 0.1')
}

// ---------------------------------------------------------------------------
// 4. Clamp extrusion
// ---------------------------------------------------------------------------

{
  const clamp: Clamp = {
    id: 'clamp-thin',
    name: 'Thin clamp',
    type: 'step_clamp',
    x: 0,
    y: 0,
    w: 20,
    h: 10,
    height: 0.0625,
    visible: true,
  }
  const mesh = buildClampMesh(clamp, false, false, 'inch', threePalette)
  assertApprox(meshHeightY(mesh), 0.0625, 'inch 0.0625 clamp height')
}

// ---------------------------------------------------------------------------
// 5. Zero height still builds, guarded at exactly minRenderHeight
// ---------------------------------------------------------------------------

{
  const feature = makeFeature('zero-mm', 'add', 0, 0)
  const mesh = buildFeatureMesh(mmProject, feature, false, false, undefined, threePalette)
  assertApprox(meshHeightY(mesh), minRenderHeight('mm'), 'zero-height mm feature height')
}

{
  const feature = makeFeature('zero-inch', 'add', 0, 0)
  const mesh = buildFeatureMesh(inchProject, feature, false, false, undefined, threePalette)
  assertApprox(meshHeightY(mesh), minRenderHeight('inch'), 'zero-height inch feature height')
}

// ---------------------------------------------------------------------------
// 6. Imported model Z fit — all three model sites, no browser needed
// ---------------------------------------------------------------------------

/** Axis-aligned box spanning x∈[0,2], y∈[0,1], z∈[0,3]. */
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

/** Single triangle — `new Manifold(...)` rejects it as non-manifold (see §10). */
function makeOpenMesh(): ImportedTriangleMesh {
  const positions = new Float32Array([0, 0, 0, 2, 0, 0, 2, 1, 0])
  const index = new Uint32Array([0, 1, 2])
  return { positions, index, bounds: computeMeshBounds(positions) }
}

function makeModelProject(
  units: Units,
  zBottom: number,
  zTop: number,
  featureId: string,
  mesh: ImportedTriangleMesh = makeBoxMesh(),
): Project {
  const project = newProject('Render height model', units)
  const assetId = `model-asset-${featureId}`
  project.modelAssets = { [assetId]: serializeImportedMesh(mesh, 'stl') }
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
        orientation: undefined,
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
    authoringFace: 'top',
    folderId: null,
    visible: true,
    locked: false,
  }]
  return project
}

{
  const project = makeModelProject('inch', 0, 0.0625, 'model-inch')
  const feature = resolveFeatureInstance(project, 'model-inch')
  assert(feature, 'inch model feature should resolve')

  const transformed = loadSTLTransformedGeometry(feature, project)
  assert(transformed, 'inch model transformed geometry should load')
  const camBounds = zExtent(transformed.positions)
  assertApprox(camBounds.maxZ - camBounds.minZ, 0.0625, 'inch model CAM Z extent')
  assert(Math.abs(camBounds.maxZ - camBounds.minZ - 0.1) > 1e-6, 'inch model CAM Z must not be 0.1')

  const preview = buildFeatureMesh(project, feature, false, false, undefined, threePalette)
  assertApprox(meshHeightY(preview), 0.0625, 'inch model preview height')

  const manifold = await getManifoldModule()
  const solid = buildFeatureSolid(manifold, project, feature)
  assert(solid, 'inch model CSG solid should build')
  const bbox = solid.boundingBox()
  assertApprox(bbox.max[2] - bbox.min[2], 0.0625, 'inch model CSG solid Z height')
  solid.delete()
}

// ---------------------------------------------------------------------------
// 7. Boolean model solid — the geometry the 3D view actually shows
// ---------------------------------------------------------------------------

{
  const manifold = await getManifoldModule()
  for (const operation of ['add', 'subtract'] as const) {
    const feature = makeFeature(`solid-${operation}-inch`, operation, 0, 0.0625)
    const solid = buildFeatureSolid(manifold, inchProject, feature)
    assert(solid, `inch ${operation} solid should build`)
    const height = solid.boundingBox().max[2] - solid.boundingBox().min[2]
    assertApprox(height, 0.0625, `inch ${operation} solid Z height`)
    assert(Math.abs(height - 0.1) > 1e-6, `inch ${operation} solid must not be inflated to 0.1`)
    solid.delete()
  }
}

// ---------------------------------------------------------------------------
// 8. Tab extrusion
// ---------------------------------------------------------------------------

const baseTab: Tab = {
  id: 'tab-base',
  name: 'Tab',
  x: 0,
  y: 0,
  w: 8,
  h: 8,
  z_top: 4,
  z_bottom: 0,
  visible: true,
}

{
  const tab = buildTabMesh({ ...baseTab, id: 'tab-inch', z_top: 0.05, z_bottom: 0 }, 'inch', false, threePalette)
  const height = meshHeightY(tab)
  assertApprox(height, 0.05, 'inch 0.05 tab height')
  assert(Math.abs(height - 0.1) > 1e-6, 'inch tab must not be inflated to the old 0.1 floor')
}

{
  const tab = buildTabMesh({ ...baseTab, id: 'tab-mm', z_top: 3, z_bottom: 0 }, 'mm', false, threePalette)
  assertApprox(meshHeightY(tab), 3, 'mm 3 tab height is unchanged')
}

// ---------------------------------------------------------------------------
// 9. A zero-height region still builds a wall at the guard height
// ---------------------------------------------------------------------------

{
  // stockThickness 0 drives depth to 0, which the caller floors at the guard.
  // The unit-blind `depth < 0.01` in buildWallGeometry discarded it in inches.
  const feature = makeFeature('zero-region-inch', 'region', 0, 0)
  const mesh = buildFeatureMesh(inchProject, feature, false, false, 0, threePalette)
  const position = (mesh as THREE.Mesh).geometry.getAttribute('position')
  assert(position && position.count > 0, 'zero-height inch region must build a non-empty wall')
  assertApprox(meshHeightY(mesh), minRenderHeight('inch'), 'zero-height inch region wall height')
}

// ---------------------------------------------------------------------------
// 10. STL non-manifold fallback extrusion
// ---------------------------------------------------------------------------

{
  const project = makeModelProject('inch', 0, 0.0625, 'model-nonmanifold', makeOpenMesh())
  const feature = resolveFeatureInstance(project, 'model-nonmanifold')
  assert(feature, 'non-manifold inch model feature should resolve')
  const manifold = await getManifoldModule()
  const solid = buildFeatureSolid(manifold, project, feature)
  assert(solid, 'non-manifold inch STL fallback solid should build')
  const height = solid.boundingBox().max[2] - solid.boundingBox().min[2]
  assertApprox(height, 0.0625, 'non-manifold inch STL fallback Z height')
  assert(Math.abs(height - 0.1) > 1e-6, 'non-manifold fallback must not be inflated to 0.1')
  solid.delete()
}

console.log('csgRenderHeight.test.ts passed')
