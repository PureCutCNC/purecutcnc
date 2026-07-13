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

import {
  loadImportedTriangleMesh,
  normalizeImportedMeshForStorage,
  serializeImportedMesh,
  type ImportedModelFormat,
} from '../../engine/importedMesh'
import type { PersistedImportedMesh, Project, SketchFeature, STLFeatureData } from '../../types/project'

function modelAssetIdForFeature(featureId: string): string {
  return `model-asset-${featureId}`
}

export function normalizeImportedModelStorage(
  featureId: string,
  stl: STLFeatureData | null | undefined,
  modelAssets: Record<string, PersistedImportedMesh>,
): STLFeatureData | null | undefined {
  if (!stl) return stl
  if (stl.meshAssetId && modelAssets[stl.meshAssetId]) {
    const { mesh, fileData, filePath, ...rest } = stl
    return rest
  }

  const transientMesh = stl.mesh
  if (transientMesh) {
    const meshAssetId = stl.meshAssetId ?? modelAssetIdForFeature(featureId)
    modelAssets[meshAssetId] = transientMesh
    const { mesh, fileData, filePath, ...rest } = stl
    return {
      ...rest,
      meshAssetId,
      scale: stl.scale ?? 1,
      axisSwap: 'none',
    }
  }

  if (!stl.fileData) return stl

  const format: ImportedModelFormat = stl.format ?? 'stl'
  const mesh = loadImportedTriangleMesh(format, stl.fileData, stl.axisSwap ?? 'none')
  if (!mesh) return stl

  const normalizedMesh = normalizeImportedMeshForStorage(mesh, stl.scale ?? 1)
  const meshAssetId = stl.meshAssetId ?? modelAssetIdForFeature(featureId)
  modelAssets[meshAssetId] = serializeImportedMesh(normalizedMesh, format)
  return {
    ...stl,
    format,
    meshAssetId,
    filePath: undefined,
    fileData: undefined,
    mesh: undefined,
    scale: 1,
    axisSwap: 'none',
  }
}

export function pruneUnusedModelAssets(project: Project): Project {
  const usedAssetIds = new Set(
    Object.values(project.featureDefinitions)
      .map((definition) => definition.stl?.meshAssetId ?? null)
      .filter((id): id is string => id !== null),
  )
  const nextAssets: Record<string, PersistedImportedMesh> = {}
  for (const [id, asset] of Object.entries(project.modelAssets ?? {})) {
    if (usedAssetIds.has(id)) {
      nextAssets[id] = asset
    }
  }
  if (Object.keys(nextAssets).length === Object.keys(project.modelAssets ?? {}).length) {
    return project
  }
  return { ...project, modelAssets: nextAssets }
}

export function isImportedModelFeature(feature: SketchFeature): boolean {
  return feature.kind === 'stl' && feature.operation === 'model'
}
