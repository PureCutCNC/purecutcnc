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

import type { Manifold as ManifoldSolid } from 'manifold-3d'
import { buildFeatureSolid, getManifoldModule, loadSTLTransformedGeometry } from '../csg'
import { expandFeatureGeometry } from '../../text'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import type { Project, SketchFeature } from '../../types/project'
import {
  CURVE_QUALITY_ARC_STEP_RADIANS,
  type ExportTriangleMesh,
  type ModelExportAssembleOptions,
  type ModelExportAssembleResult,
} from './types'

/**
 * Build the boolean union of all visible solid features for export.
 *
 * Output is in PureCutCNC's internal design coordinates (Z-up, Y oriented the
 * same way the rest of the app stores it — i.e. matches the sketch data). This
 * makes round-tripping (export → re-import as STL feature) preserve position,
 * and matches what the 3D viewport and G-code pipeline already treat as
 * canonical. External viewers/slicers will see the model with Y in the same
 * direction the sketch top-view uses; Z is still up so the model imports the
 * right way up. Users who care about a particular Y orientation in a downstream
 * tool can rotate there.
 */
export async function assembleModelExportMesh(
  project: Project,
  options: ModelExportAssembleOptions,
): Promise<ModelExportAssembleResult> {
  const module = await getManifoldModule()
  const warnings: string[] = []
  const arcStepRadians = CURVE_QUALITY_ARC_STEP_RADIANS[options.curveQuality]

  const visibleFeatures = resolvedProjectFeatures(project).filter((feature) => feature.visible)
  const expanded = visibleFeatures.flatMap((feature) => expandFeatureGeometry(feature, false))

  // 1) Build the boolean union of add/subtract features. Imported-mesh
  //    features (operation === 'model') are excluded here — matching the
  //    viewport's behavior — and appended as raw triangles in step (2).
  //    Unioning them here would silently fill pockets when the underlying
  //    STL is non-manifold (buildFeatureSolid falls back to a 2.5D silhouette
  //    extrusion, which is a plain block).
  let booleanMesh: ExportTriangleMesh = { positions: new Float32Array(0), index: new Uint32Array(0) }
  let current: ManifoldSolid | null = null
  try {
    for (const feature of expanded) {
      if (!shouldIncludeInBoolean(feature)) continue

      let solid: ManifoldSolid | null = null
      try {
        solid = buildFeatureSolid(module, project, feature, arcStepRadians)
        if (!solid) continue

        if (!current) {
          if (feature.operation === 'add') {
            current = solid
            solid = null
          }
          continue
        }

        const next = feature.operation === 'subtract'
          ? module.Manifold.difference(current, solid)
          : module.Manifold.union(current, solid)

        current.delete()
        current = next
      } finally {
        solid?.delete()
      }
    }

    if (current) {
      booleanMesh = manifoldMeshToExportMesh(current.getMesh())
    }
  } finally {
    current?.delete()
  }

  // 2) Append imported-mesh features as raw triangles, transformed into
  //    design space (scale, z-stretch, rotate, translate to sketch origin).
  //    This preserves their actual geometry — pockets, holes, fine
  //    detail — independent of whether they're manifold.
  const meshes: ExportTriangleMesh[] = [booleanMesh]
  if (options.includeImportedMeshes) {
    for (const feature of expanded) {
      if (feature.operation !== 'model') continue
      const transformed = loadSTLTransformedGeometry(feature, project)
      if (!transformed) continue
      meshes.push({
        positions: new Float32Array(transformed.positions),
        index: new Uint32Array(transformed.index),
      })
    }
  }

  return { mesh: concatMeshes(meshes), warnings }
}

function shouldIncludeInBoolean(feature: SketchFeature): boolean {
  return feature.operation === 'add' || feature.operation === 'subtract'
}

function concatMeshes(meshes: ExportTriangleMesh[]): ExportTriangleMesh {
  let totalVerts = 0
  let totalIndices = 0
  for (const m of meshes) {
    totalVerts += m.positions.length / 3
    totalIndices += m.index.length
  }
  const positions = new Float32Array(totalVerts * 3)
  const index = new Uint32Array(totalIndices)
  let vOff = 0
  let iOff = 0
  for (const m of meshes) {
    positions.set(m.positions, vOff * 3)
    for (let i = 0; i < m.index.length; i += 1) {
      index[iOff + i] = m.index[i] + vOff
    }
    vOff += m.positions.length / 3
    iOff += m.index.length
  }
  return { positions, index }
}

/**
 * Convert a Manifold mesh into an export triangle mesh, preserving manifold's
 * coordinates and winding 1:1. Manifold's `numProp` may be ≥ 3 (extra
 * properties beyond position), so we strip down to xyz here.
 */
function manifoldMeshToExportMesh(mesh: import('manifold-3d').Mesh): ExportTriangleMesh {
  const numVerts = mesh.numVert
  const positions = new Float32Array(numVerts * 3)
  for (let i = 0; i < numVerts; i += 1) {
    const src = i * mesh.numProp
    const dst = i * 3
    positions[dst] = mesh.vertProperties[src]
    positions[dst + 1] = mesh.vertProperties[src + 1]
    positions[dst + 2] = mesh.vertProperties[src + 2]
  }

  const index = new Uint32Array(mesh.triVerts)
  return { positions, index }
}

export function countTriangles(mesh: ExportTriangleMesh): number {
  return mesh.index.length / 3
}
