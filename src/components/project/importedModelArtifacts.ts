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
 * The 2D artifacts an imported model carries alongside its mesh, and the two
 * paths that produce them: first import, and post-import re-orientation
 * (issue #241).
 *
 * Both paths run the same derivation so they cannot drift — a rotated model's
 * sketch top view, silhouette, and profile are produced exactly the way the
 * importer produced the originals, just from a rotated mesh.
 */

import {
  clampImportedMeshSilhouetteZSteps,
  extractImportedMeshProfileAndBounds,
  renderImportedMeshTopViewToDataUrl,
} from '../../import/stl'
import { orientImportedMesh, loadPersistedTriangleMesh, type ImportedTriangleMesh } from '../../engine/importedMesh'
import { normalizeModelOrientation } from '../../engine/importedModelTransform'
import { useProjectStore } from '../../store/projectStore'
import type { Units } from '../../utils/units'
import type { ModelOrientation, Point, SketchProfile } from '../../types/project'

function defaultSilhouetteZStepSize(units: Units): number {
  return units === 'inch' ? 0.02 : 0.5
}

/**
 * Silhouette slice count scaled to the model's height, so a tall part is not
 * projected at the same coarse resolution as a thin one. Shared by import and
 * re-orientation — a rotated model changes height, so it re-picks its own.
 */
export function recommendedSilhouetteZSteps(modelHeight: number, units: Units): number {
  if (!(modelHeight > 0)) return clampImportedMeshSilhouetteZSteps(96)
  return clampImportedMeshSilhouetteZSteps(
    Math.ceil(modelHeight / defaultSilhouetteZStepSize(units)),
  )
}

/** Everything derived from an imported mesh that gets persisted next to it. */
export interface ImportedModelArtifacts {
  /** Definition-local outer profile used by the sketch and 2.5D fallbacks. */
  profile: SketchProfile
  /** Definition-local projected silhouette contours. */
  silhouettePaths: Point[][]
  /** Pre-rendered top-down image for the sketch view; best-effort. */
  topViewDataUrl?: string
  /** Mesh-local Z extent, before `stl.scale`. */
  meshZBottom: number
  meshZTop: number
}

/**
 * Project a mesh down to its 2D artifacts.
 *
 * `extractImportedMeshProfileAndBounds` is the expensive part (a Z-slice
 * projection over 8–512 steps), which is why re-orientation re-derives once on
 * commit rather than per frame.
 */
export async function deriveImportedModelArtifacts(
  mesh: ImportedTriangleMesh,
  options: { silhouetteZSteps: number, onProgress?: (percent: number) => void },
): Promise<ImportedModelArtifacts | null> {
  const modelInfo = await extractImportedMeshProfileAndBounds(
    mesh,
    options.onProgress,
    { silhouetteZSteps: options.silhouetteZSteps },
  )
  if (!modelInfo) return null

  let topViewDataUrl: string | undefined
  try {
    const url = renderImportedMeshTopViewToDataUrl(mesh)
    if (url) topViewDataUrl = url
  } catch {
    // top-view rendering is best-effort
  }

  return {
    profile: modelInfo.profile,
    silhouettePaths: modelInfo.silhouettePaths,
    topViewDataUrl,
    meshZBottom: modelInfo.z_bottom,
    meshZTop: modelInfo.z_top,
  }
}

export interface ReorientResult {
  /** New instance Z bounds after the rigid rotation. */
  z_bottom: number
  z_top: number
}

/**
 * Apply a post-import 3D orientation to an imported model.
 *
 * The rotation is **rigid**: `z_top`/`z_bottom` are recomputed from the rotated
 * mesh's true Z extent so the effective Z scale keeps matching XY. Without this
 * the Z fit in `csg.ts` would stretch the rotated mesh back into the old band
 * and silently squash the model — the correctness core of issue #241.
 *
 * The band is anchored at `z_bottom`: the model keeps its base plane and grows
 * upward. Anchoring at the top instead would drive `z_bottom` negative whenever
 * the rotation makes the model taller than its current top plane, and clamping
 * that back to zero would reintroduce the squash. A rotated model may now stand
 * above the stock; that surfaces through the existing stock warnings.
 *
 * Orientation lives on the **definition**, so linked copies re-orient together
 * (ARCHITECTURE §4). Everything commits in a single `updateFeature` call, which
 * is one undo entry, and the mesh asset is never rewritten.
 */
export async function reorientImportedModel(
  featureId: string,
  orientation: ModelOrientation | null,
): Promise<ReorientResult | null> {
  const { project, updateFeature } = useProjectStore.getState()
  const instance = project.features.find((feature) => feature.id === featureId)
  if (!instance) return null
  const definition = project.featureDefinitions[instance.definitionId]
  if (!definition?.stl) return null

  const assetId = definition.stl.meshAssetId
  const asset = assetId ? project.modelAssets?.[assetId] : null
  if (!asset) return null
  const persistedMesh = loadPersistedTriangleMesh(asset)
  if (!persistedMesh) return null

  const normalized = normalizeModelOrientation(orientation)
  const orientedMesh = orientImportedMesh(persistedMesh, normalized, assetId)

  const scale = definition.stl.scale ?? 1
  const artifacts = await deriveImportedModelArtifacts(orientedMesh, {
    silhouetteZSteps: recommendedSilhouetteZSteps(
      (orientedMesh.bounds.maxZ - orientedMesh.bounds.minZ) * scale,
      project.meta.units,
    ),
  })
  if (!artifacts) return null

  const rotatedHeight = Math.abs(artifacts.meshZTop - artifacts.meshZBottom) * scale
  const currentBottom = typeof instance.z_bottom === 'number' ? instance.z_bottom : 0
  const zBottom = Math.max(0, currentBottom)
  const zTop = zBottom + Math.max(0.1, rotatedHeight)

  updateFeature(featureId, {
    stl: {
      ...definition.stl,
      orientation: normalized ?? undefined,
      silhouettePaths: artifacts.silhouettePaths,
      topViewDataUrl: artifacts.topViewDataUrl,
    },
    sketch: {
      profile: artifacts.profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: definition.dimensions,
      constraints: instance.constraints,
    },
    z_top: zTop,
    z_bottom: zBottom,
  })

  return { z_bottom: zBottom, z_top: zTop }
}

/**
 * Move an imported model up or down without deforming it.
 *
 * `z_top` and `z_bottom` move together by the same delta, so the Z band keeps
 * its height and the Z fit in `csg.ts` produces the identical shape at a new
 * height. Editing either bound on its own — which is all the Z range slider can
 * do — changes the band height and therefore stretches the mesh.
 */
export function liftImportedModel(featureId: string, nextBottom: number): void {
  const { project, updateFeature } = useProjectStore.getState()
  const instance = project.features.find((feature) => feature.id === featureId)
  if (!instance) return
  const currentTop = typeof instance.z_top === 'number' ? instance.z_top : 0
  const currentBottom = typeof instance.z_bottom === 'number' ? instance.z_bottom : 0
  const height = Math.abs(currentTop - currentBottom)
  const bottom = Math.max(0, nextBottom)
  if (bottom === currentBottom) return
  updateFeature(featureId, { z_bottom: bottom, z_top: bottom + height })
}
