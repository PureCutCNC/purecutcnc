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

/** Imported-model preview, CSG, CAM, export, and cache transform regressions. */

import * as THREE from 'three'
import { newProject, rectProfile, type Matrix2D, type Project } from '../types/project'
import { resolveFeatureInstance } from '../store/helpers/resolveFeatures'
import { buildFeatureMesh, buildFeatureSolid, getManifoldModule, loadSTLTransformedGeometry } from './csg'
import { THEME_PALETTES } from '../theme/palette'
import { computeMeshBounds, serializeImportedMesh, type ImportedTriangleMesh } from './importedMesh'

const threePalette = THEME_PALETTES.dark.three
import { transformImportedModelPoint } from './importedModelTransform'

interface Bounds2D {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-6): boolean {
  return Math.abs(left - right) <= epsilon
}

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

function makeProject(transform: Matrix2D): Project {
  const project = newProject('Imported model transform', 'mm')
  const assetId = 'model-asset'
  project.modelAssets = { [assetId]: serializeImportedMesh(makeBoxMesh(), 'stl') }
  project.featureDefinitions = {
    model: {
      id: 'model',
      kind: 'stl',
      profile: rectProfile(0, 0, 1, 0.5),
      dimensions: [],
      text: null,
      stl: {
        format: 'stl',
        scale: 0.5,
        axisSwap: 'none',
        meshAssetId: assetId,
        silhouettePaths: [[
          { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.5 }, { x: 0, y: 0.5 },
        ]],
      },
      operation: 'model',
    },
  }
  project.features = [{
    id: 'model',
    name: 'Model',
    definitionId: 'model',
    transform,
    constraints: [],
    z_top: 4,
    z_bottom: 1,
    folderId: null,
    visible: true,
    locked: false,
  }]
  return project
}

function expectedBounds(transform: Matrix2D): Bounds2D {
  const points = [
    transformImportedModelPoint(transform, 0, 0),
    transformImportedModelPoint(transform, 1, 0),
    transformImportedModelPoint(transform, 1, 0.5),
    transformImportedModelPoint(transform, 0, 0.5),
  ]
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  }
}

function positionBounds(positions: Float32Array): Bounds2D & { minZ: number, maxZ: number } {
  const xs: number[] = []
  const ys: number[] = []
  const zs: number[] = []
  for (let index = 0; index < positions.length; index += 3) {
    xs.push(positions[index])
    ys.push(positions[index + 1])
    zs.push(positions[index + 2])
  }
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
    minZ: Math.min(...zs), maxZ: Math.max(...zs),
  }
}

function assertBounds(actual: Bounds2D, expected: Bounds2D, label: string): void {
  for (const bound of ['minX', 'maxX', 'minY', 'maxY'] as const) {
    assert(approx(actual[bound], expected[bound]),
      `${label} ${bound}: expected ${expected[bound]}, got ${actual[bound]}`)
  }
}

const transforms: Array<[string, Matrix2D]> = [
  ['identity', { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }],
  ['translated', { a: 1, b: 0, c: 0, d: 1, e: 7, f: -3 }],
  ['rotated', { a: 0, b: 1, c: -1, d: 0, e: 4, f: 2 }],
  ['mirrored', { a: -1, b: 0, c: 0, d: 1, e: 5, f: -1 }],
  ['scaled', { a: 2, b: 0.25, c: 0.5, d: 1.5, e: -2, f: 3 }],
]

const manifold = await getManifoldModule()

for (const [name, transform] of transforms) {
  const project = makeProject(transform)
  const feature = resolveFeatureInstance(project, 'model')
  assert(feature, `${name} model should resolve`)
  const expected = expectedBounds(transform)

  const transformed = loadSTLTransformedGeometry(feature, project)
  assert(transformed, `${name} transformed geometry should load`)
  const transformedBounds = positionBounds(transformed.positions)
  assertBounds(transformedBounds, expected, `${name} transformed geometry`)
  assert(approx(transformedBounds.minZ, 1) && approx(transformedBounds.maxZ, 4),
    `${name} transformed geometry should retain Z fit`)

  const preview = buildFeatureMesh(project, feature, false, false, undefined, threePalette)
  preview.updateMatrixWorld(true)
  const previewBounds = new THREE.Box3().setFromObject(preview)
  assertBounds({
    minX: previewBounds.min.x,
    maxX: previewBounds.max.x,
    minY: previewBounds.min.z,
    maxY: previewBounds.max.z,
  }, expected, `${name} preview`)
  assert(approx(previewBounds.min.y, 1) && approx(previewBounds.max.y, 4),
    `${name} preview should retain Z fit`)

  const solid = buildFeatureSolid(manifold, project, feature)
  assert(solid, `${name} CSG solid should build`)
  const solidBounds = solid.boundingBox()
  assertBounds({
    minX: solidBounds.min[0], maxX: solidBounds.max[0],
    minY: solidBounds.min[1], maxY: solidBounds.max[1],
  }, expected, `${name} CSG solid`)
  assert(approx(solidBounds.min[2], 1) && approx(solidBounds.max[2], 4),
    `${name} CSG solid should retain Z fit`)
  solid.delete()
}

console.log('Imported-model transform tests passed')
