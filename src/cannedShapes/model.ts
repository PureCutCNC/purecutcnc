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
 * Canned models — the mesh half of the canned-shape contract (issue #1112 A2).
 *
 * A model kind (Turn, Polygon in slice G) generates a triangle mesh from its
 * parameters. That mesh is stored in `Project.modelAssets` and referenced from
 * `definition.stl.meshAssetId`, exactly like an imported model's mesh, so CSG,
 * the surface toolpaths, the 3D preview and export all consume it through the
 * paths they already use. The definition keeps the kind/params envelope: the
 * mesh is derived output, rebuilt from the parameters on change, unit
 * conversion and load.
 *
 * A sketch kind has no `generateMesh`, so every function here is a no-op for
 * it and the existing outline model is untouched.
 */

import { computeMeshBounds, serializeImportedMesh } from '../engine/importedMesh'
import type {
  FeatureDefinition,
  PersistedImportedMesh,
  Project,
  STLFeatureData,
} from '../types/project'
import { generateCannedShapeMesh } from './index'

/** `Project.modelAssets` key for one definition's generated mesh. */
export function cannedShapeModelAssetId(definitionId: string): string {
  return `canned-model-asset-${definitionId}`
}

export interface RebuiltCannedShapeModel {
  definition: FeatureDefinition
  assetId: string
  asset: PersistedImportedMesh
}

/**
 * Rebuild one definition's mesh from its `canned` parameters. Returns `null`
 * when the definition is not a model, its generator is absent or unregistered,
 * or its parameters do not normalize.
 *
 * The generated mesh is in definition-local units and is the authoritative
 * geometry, so the STL record keeps only the asset reference and a post-import
 * orientation the user may have set. Import-time artifacts (embedded bytes,
 * silhouette) belonged to the old parameters and are dropped.
 */
export function rebuildCannedShapeModel(
  definition: FeatureDefinition,
): RebuiltCannedShapeModel | null {
  if (!definition.canned) return null
  const mesh = generateCannedShapeMesh(definition.canned)
  if (!mesh || mesh.positions.length < 9 || mesh.indices.length < 3) return null

  // One asset per definition, never the id a copied definition inherited: two
  // copies must be able to diverge without overwriting each other's mesh.
  const assetId = cannedShapeModelAssetId(definition.id)
  const asset = serializeImportedMesh(
    {
      positions: mesh.positions,
      index: mesh.indices,
      bounds: computeMeshBounds(mesh.positions),
    },
    'stl',
  )
  const stl: STLFeatureData = {
    orientation: definition.stl?.orientation,
    format: 'stl',
    meshAssetId: assetId,
    scale: 1,
    axisSwap: 'none',
  }
  return {
    definition: { ...definition, stl },
    assetId,
    asset,
  }
}

/**
 * Rebuild every canned model in a project. Called on load so the persisted
 * parameters, not a stale mesh asset, decide the geometry.
 */
export function rebuildCannedShapeModels(project: Project): Project {
  let featureDefinitions = project.featureDefinitions
  let modelAssets = project.modelAssets ?? {}
  let changed = false

  for (const definition of Object.values(project.featureDefinitions)) {
    const rebuilt = rebuildCannedShapeModel(definition)
    if (!rebuilt) continue
    featureDefinitions = {
      ...featureDefinitions,
      [rebuilt.definition.id]: rebuilt.definition,
    }
    modelAssets = { ...modelAssets, [rebuilt.assetId]: rebuilt.asset }
    changed = true
  }

  return changed ? { ...project, featureDefinitions, modelAssets } : project
}

/** Rebuild only the named definitions, as a parameter edit does. */
export function rebuildCannedShapeModelDefinitions(
  project: Project,
  definitionIds: ReadonlySet<string>,
): { featureDefinitions: Record<string, FeatureDefinition>; modelAssets: Record<string, PersistedImportedMesh> } {
  let featureDefinitions = project.featureDefinitions
  let modelAssets = project.modelAssets ?? {}
  let changed = false

  for (const definitionId of definitionIds) {
    const definition = project.featureDefinitions[definitionId]
    if (!definition) continue
    const rebuilt = rebuildCannedShapeModel(definition)
    if (!rebuilt) continue
    featureDefinitions = {
      ...featureDefinitions,
      [rebuilt.definition.id]: rebuilt.definition,
    }
    modelAssets = { ...modelAssets, [rebuilt.assetId]: rebuilt.asset }
    changed = true
  }

  return changed
    ? { featureDefinitions, modelAssets }
    : { featureDefinitions: project.featureDefinitions, modelAssets: project.modelAssets ?? {} }
}
