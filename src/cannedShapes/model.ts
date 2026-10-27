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

import { computeMeshBounds, orientImportedMesh, serializeImportedMesh } from '../engine/importedMesh'
import type {
  DimensionRef,
  FeatureDefinition,
  FeatureInstance,
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
  /** Generated mesh Z extent in definition-local units, before `stl.scale`. */
  meshHeight: number
  /** The uniform scale kept from the definition, applied to the mesh on load. */
  scale: number
}

/**
 * Rebuild one definition's mesh from its `canned` parameters. Returns `null`
 * when the definition is not a model, its generator is absent or unregistered,
 * or its parameters do not normalize.
 *
 * The generated mesh is in definition-local units and is the authoritative
 * geometry, so the STL record keeps only the asset reference and the user's
 * post-import settings — uniform scale and 3D orientation. Import-time
 * artifacts (embedded bytes, silhouette) belonged to the old parameters and are
 * dropped.
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
  const bounds = computeMeshBounds(mesh.positions)
  const asset = serializeImportedMesh(
    {
      positions: mesh.positions,
      index: mesh.indices,
      bounds,
    },
    'stl',
  )
  // The parameters changed; the user's scale and orientation did not. Resetting
  // scale to 1 here halved a scaled model on every save/load (issue #1112 A3).
  const scale = definition.stl?.scale ?? 1
  const stl: STLFeatureData = {
    orientation: definition.stl?.orientation,
    format: 'stl',
    meshAssetId: assetId,
    scale,
    axisSwap: definition.stl?.axisSwap ?? 'none',
  }
  // The loader orients before it fits Z, so the span must use the rotated
  // extent. Identity orientation returns the generated mesh unchanged.
  const oriented = orientImportedMesh(
    { positions: mesh.positions, index: mesh.indices, bounds },
    definition.stl?.orientation,
  )
  return {
    definition: { ...definition, stl },
    assetId,
    asset,
    meshHeight: oriented.bounds.maxZ - oriented.bounds.minZ,
    scale,
  }
}

/** A dimension reference's numeric value, without throwing on an unknown key. */
function numericDimension(
  project: Pick<Project, 'dimensions'>,
  value: DimensionRef,
): number {
  if (typeof value === 'number') return value
  const named = project.dimensions[value]
  if (named) return named.value
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * The instance Z top that makes the regenerated mesh fill its placed span with
 * no Z stretch: the mesh's own height, at the user's uniform scale, measured up
 * from the instance's existing bottom. Consumers (`loadSTLTransformedGeometry`,
 * the 3D preview, simulation, bounds and toolpaths) all read the instance span,
 * so this is the one place a regenerated dimension reaches them — including
 * every linked copy, which keeps its own bottom and gets the same height.
 */
export function cannedModelZTop(
  project: Pick<Project, 'dimensions'>,
  zBottom: DimensionRef,
  rebuilt: Pick<RebuiltCannedShapeModel, 'meshHeight' | 'scale'>,
): number {
  return numericDimension(project, zBottom) + rebuilt.meshHeight * rebuilt.scale
}

/**
 * Apply regenerated mesh heights to every instance of the rebuilt definitions.
 * A linked copy shares the definition but not its placement, so each row keeps
 * its own `z_bottom` and gets the new height above it.
 */
export function applyCannedShapeModelSpans(
  project: Pick<Project, 'dimensions'>,
  features: FeatureInstance[],
  models: ReadonlyMap<string, RebuiltCannedShapeModel>,
): FeatureInstance[] {
  if (models.size === 0) return features
  let changed = false
  const next = features.map((instance) => {
    const rebuilt = models.get(instance.definitionId)
    if (!rebuilt) return instance
    const zTop = cannedModelZTop(project, instance.z_bottom, rebuilt)
    if (Math.abs(numericDimension(project, instance.z_top) - zTop) < 1e-9) return instance
    changed = true
    return { ...instance, z_top: zTop }
  })
  return changed ? next : features
}

/**
 * Rebuild every canned model in a project. Called on load so the persisted
 * parameters, not a stale mesh asset, decide the geometry.
 */
export function rebuildCannedShapeModels(project: Project): Project {
  const rebuilt = rebuildCannedShapeModelDefinitions(
    project,
    new Set(Object.keys(project.featureDefinitions)),
  )
  if (rebuilt.models.size === 0) return project

  return {
    ...project,
    featureDefinitions: rebuilt.featureDefinitions,
    modelAssets: rebuilt.modelAssets,
    features: applyCannedShapeModelSpans(project, project.features, rebuilt.models),
  }
}

/** Definitions whose mesh was regenerated, keyed by definition id. */
export type RebuiltCannedShapeModels = {
  featureDefinitions: Record<string, FeatureDefinition>
  modelAssets: Record<string, PersistedImportedMesh>
  models: Map<string, RebuiltCannedShapeModel>
}

/** Rebuild only the named definitions, as a parameter edit does. */
export function rebuildCannedShapeModelDefinitions(
  project: Project,
  definitionIds: ReadonlySet<string>,
): RebuiltCannedShapeModels {
  let featureDefinitions = project.featureDefinitions
  let modelAssets = project.modelAssets ?? {}
  const models = new Map<string, RebuiltCannedShapeModel>()

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
    models.set(rebuilt.definition.id, rebuilt)
  }

  return models.size > 0
    ? { featureDefinitions, modelAssets, models }
    : { featureDefinitions: project.featureDefinitions, modelAssets: project.modelAssets ?? {}, models }
}
