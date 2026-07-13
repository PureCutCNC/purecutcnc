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
  clampImportedMeshSilhouetteZSteps,
  extractImportedMeshProfileAndBounds,
  renderImportedMeshTopViewToDataUrl,
} from '../../import/stl'
import { useProjectStore } from '../../store/projectStore'
import {
  clearImportedSourceCaches,
  loadImportedTriangleMesh,
  normalizeImportedMeshForStorage,
  serializeImportedMesh,
  splitMeshByConnectedComponents,
  type ImportedModelFormat,
  type ModelAxisOrientation,
} from '../../engine/importedMesh'
import type { Units } from '../../utils/units'

/** Maximum number of disjoint bodies the model importer will split. */
const MAX_IMPORT_BODIES = 64

function sourceTypeLabel(sourceType: ImportedModelFormat): string {
  if (sourceType === 'stl') return 'STL'
  if (sourceType === 'obj') return 'OBJ'
  return 'Unknown'
}

function defaultSilhouetteZStepSize(units: Units): number {
  return units === 'inch' ? 0.02 : 0.5
}

function recommendedSilhouetteZSteps(modelHeight: number, units: Units): number {
  if (!(modelHeight > 0)) return clampImportedMeshSilhouetteZSteps(96)
  return clampImportedMeshSilhouetteZSteps(
    Math.ceil(modelHeight / defaultSilhouetteZStepSize(units)),
  )
}

function parseSilhouetteZStepsInput(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < 8 || parsed > 512) {
    throw new Error('Silhouette Z steps must be between 8 and 512.')
  }
  return parsed
}

/**
 * Import a 3D model file (STL/OBJ) as one or more silhouette-based features.
 * Pure async utility — not a hook.
 */
export async function importModelFile(params: {
  modelFormat: ImportedModelFormat
  modelBuffer: ArrayBuffer
  fileName: string
  projectUnits: Units
  sourceUnits: Units
  axisSwap: ModelAxisOrientation
  silhouetteZSteps: string
  onProgress: (stage: string, pct: number) => void
}): Promise<string[]> {
  const {
    modelFormat, modelBuffer, fileName, projectUnits, sourceUnits,
    axisSwap, silhouetteZSteps, onProgress,
  } = params
  const modelLabel = sourceTypeLabel(modelFormat)
  const modelScale = sourceUnits === projectUnits ? 1 : (sourceUnits === 'inch' ? 25.4 : 1 / 25.4)
  const requestedSilhouetteZSteps = parseSilhouetteZStepsInput(silhouetteZSteps)

  onProgress('Parsing mesh', 5)
  let parsedMesh = loadImportedTriangleMesh(modelFormat, modelBuffer, axisSwap)
  if (!parsedMesh) throw new Error(`Failed to parse ${modelLabel} mesh`)
  onProgress('Parsing mesh', 10)

  onProgress('Normalizing mesh', 10)
  const importedMesh = normalizeImportedMeshForStorage(parsedMesh, modelScale)
  parsedMesh = null
  clearImportedSourceCaches()
  const resolvedZSteps = requestedSilhouetteZSteps ?? recommendedSilhouetteZSteps(
    importedMesh.bounds.maxZ - importedMesh.bounds.minZ,
    projectUnits,
  )

  onProgress('Detecting bodies', 13)
  const detectedBodies = splitMeshByConnectedComponents(importedMesh)
  let bodiesToImport: typeof detectedBodies
  let truncationWarning: string | null = null
  if (detectedBodies.length <= 1) {
    bodiesToImport = [importedMesh]
  } else if (detectedBodies.length > MAX_IMPORT_BODIES) {
    bodiesToImport = [importedMesh]
    truncationWarning =
      `The imported ${modelLabel} contains ${detectedBodies.length} disjoint bodies, ` +
      `which exceeds the per-import limit of ${MAX_IMPORT_BODIES}. ` +
      `Imported as a single feature; the bodies will not be individually selectable. ` +
      `Split the file into smaller pieces or boolean-union it before importing if you need per-body features.`
  } else {
    bodiesToImport = detectedBodies
  }
  const splitIntoBodies = bodiesToImport.length > 1
  const baseName = fileName.replace(/\.(stl|obj)$/i, '')
  const { addFeature, addFeatureFolder, updateFeatureFolder } = useProjectStore.getState()

  let importFolderId: string | null = null
  if (splitIntoBodies) {
    importFolderId = addFeatureFolder('features')
    updateFeatureFolder(importFolderId, { name: baseName })
  }

  const newFeatureIds: string[] = []
  const projectionBudget = 70
  const projectionStart = 15

  for (let bodyIndex = 0; bodyIndex < bodiesToImport.length; bodyIndex += 1) {
    const bodyMesh = bodiesToImport[bodyIndex]
    const bodyLabel = splitIntoBodies
      ? `Body ${bodyIndex + 1} / ${bodiesToImport.length}`
      : modelLabel
    const bodyStart = projectionStart + (bodyIndex / bodiesToImport.length) * projectionBudget
    const bodyEnd = projectionStart + ((bodyIndex + 1) / bodiesToImport.length) * projectionBudget

    onProgress(`Projecting silhouette — ${bodyLabel} (${resolvedZSteps} Z steps)`, Math.round(bodyStart))
    const modelInfo = await extractImportedMeshProfileAndBounds(bodyMesh, (p) => {
      onProgress(
        `Projecting silhouette — ${bodyLabel} (${resolvedZSteps} Z steps)`,
        Math.round(bodyStart + (bodyEnd - bodyStart) * (p / 100)),
      )
    }, { silhouetteZSteps: resolvedZSteps })
    if (!modelInfo) {
      throw new Error(`Failed to generate silhouette for ${bodyLabel.toLowerCase()} of ${modelLabel} import`)
    }

    let bodyTopViewDataUrl: string | undefined
    try {
      const url = renderImportedMeshTopViewToDataUrl(bodyMesh)
      if (url) bodyTopViewDataUrl = url
    } catch {
      // top-view rendering is best-effort
    }

    const featureId = crypto.randomUUID()
    const featureName = bodyIndex === 0 ? baseName : `${baseName} (${bodyIndex + 1})`
    addFeature({
      id: featureId,
      name: featureName,
      kind: 'stl',
      folderId: importFolderId,
      stl: {
        format: modelFormat,
        filePath: undefined,
        mesh: serializeImportedMesh(bodyMesh, modelFormat),
        scale: 1,
        axisSwap: 'none',
        silhouettePaths: modelInfo.silhouettePaths,
        topViewDataUrl: bodyTopViewDataUrl,
      },
      sketch: {
        profile: modelInfo.profile,
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
      operation: 'model',
      z_top: modelInfo.z_top,
      z_bottom: modelInfo.z_bottom,
      visible: true,
      locked: false,
    })
    newFeatureIds.push(featureId)
  }

  onProgress('Import complete', 100)
  if (truncationWarning) window.alert(truncationWarning)
  return newFeatureIds
}
