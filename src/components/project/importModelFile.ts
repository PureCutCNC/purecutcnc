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

import { deriveImportedModelArtifacts, recommendedSilhouetteZSteps, type ImportedModelArtifacts } from './importedModelArtifacts'
import { useProjectStore } from '../../store/projectStore'
import {
  applyAxisOrientationToPositions,
  clearImportedSourceCaches,
  concatenateTriangleMeshes,
  flipImportedMeshPlanY,
  loadImportedTriangleMesh,
  normalizeImportedMeshForStorage,
  serializeImportedMesh,
  splitMeshByConnectedComponents,
  type ImportedTriangleMesh,
  type ModelAxisOrientation,
} from '../../engine/importedMesh'
import { translate } from '../../i18n/store'
import { StepImportError, type StepOutputUnit } from '../../import/stepProtocol'
import { tessellateStepFile, type StepBody, type TessellateStepFileOptions } from '../../import/stepImportClient'
import type { ImportedModelSourceFormat, PersistedImportedMesh } from '../../types/project'
import type { Units } from '../../utils/units'

/** Maximum number of disjoint bodies the model importer will split. */
const MAX_IMPORT_BODIES = 64

function sourceTypeLabel(sourceType: ImportedModelSourceFormat): string {
  if (sourceType === 'stl') return 'STL'
  if (sourceType === 'obj') return 'OBJ'
  if (sourceType === 'step') return 'STEP'
  return 'Unknown'
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

/** The surface tolerance as typed: a length in project units. */
function parseStepToleranceInput(value: string): number {
  const trimmed = value.trim()
  const parsed = Number(trimmed)
  if (!trimmed || !Number.isFinite(parsed) || parsed <= 0) {
    throw new StepImportError({ code: 'invalid-tolerance' })
  }
  return parsed
}

/** STEP-only inputs, required when `modelFormat` is `'step'`. */
export interface StepImportSettings {
  /** The unit Open CASCADE emits: `inspectStepFileUnits(...).outputUnit`. */
  outputUnit: StepOutputUnit
  /** Surface tolerance as typed, in project units. */
  tolerance: string
}

export interface ImportModelFileParams {
  modelFormat: ImportedModelSourceFormat
  modelBuffer: ArrayBuffer
  fileName: string
  projectUnits: Units
  sourceUnits: Units
  axisSwap: ModelAxisOrientation
  silhouetteZSteps: string
  step?: StepImportSettings
  /** Aborting before the import commits leaves the project untouched; STEP tessellation stops at once. */
  signal?: AbortSignal
  onProgress: (stage: string, pct: number) => void
  /** Test seam; production tessellates in the STEP worker. */
  tessellateStep?: (buffer: ArrayBuffer, options: TessellateStepFileOptions) => Promise<StepBody[]>
  /** Test seam; production uses `window.alert`. */
  notify?: (message: string) => void
}

interface ImportBody {
  /** The body's name in its file; empty when the file gives none. */
  name: string
  mesh: ImportedTriangleMesh
}

interface LoadedBodies {
  bodies: ImportBody[]
  /** Z extent of the whole model, which sets the default silhouette resolution. */
  height: number
  truncationWarning: string | null
}

function bodyCapWarning(modelLabel: string, bodyCount: number): string {
  return `The imported ${modelLabel} contains ${bodyCount} disjoint bodies, ` +
    `which exceeds the per-import limit of ${MAX_IMPORT_BODIES}. ` +
    `Imported as a single feature; the bodies will not be individually selectable. ` +
    `Split the file into smaller pieces or boolean-union it before importing if you need per-body features.`
}

/** STL and OBJ: parse, scale, and find bodies by connectivity. */
function loadMeshBodies(params: ImportModelFileParams, format: 'stl' | 'obj', modelScale: number): LoadedBodies {
  const { modelBuffer, axisSwap, onProgress } = params
  const modelLabel = sourceTypeLabel(format)

  onProgress('Parsing mesh', 5)
  let parsedMesh = loadImportedTriangleMesh(format, modelBuffer, axisSwap)
  if (!parsedMesh) throw new Error(`Failed to parse ${modelLabel} mesh`)
  onProgress('Parsing mesh', 10)

  onProgress('Normalizing mesh', 10)
  // The parsed mesh is in the file's world frame (Y up); project space is
  // Y-down, so the plan Y is negated before anything downstream reads it.
  const importedMesh = normalizeImportedMeshForStorage(flipImportedMeshPlanY(parsedMesh), modelScale)
  parsedMesh = null
  clearImportedSourceCaches()
  const height = importedMesh.bounds.maxZ - importedMesh.bounds.minZ

  onProgress('Detecting bodies', 13)
  const detectedBodies = splitMeshByConnectedComponents(importedMesh)
  if (detectedBodies.length <= 1) {
    return { bodies: [{ name: '', mesh: importedMesh }], height, truncationWarning: null }
  }
  if (detectedBodies.length > MAX_IMPORT_BODIES) {
    return {
      bodies: [{ name: '', mesh: importedMesh }],
      height,
      truncationWarning: bodyCapWarning(modelLabel, detectedBodies.length),
    }
  }
  return { bodies: detectedBodies.map((mesh) => ({ name: '', mesh })), height, truncationWarning: null }
}

/**
 * STEP: tessellate in the worker, then orient and scale each body as the STL
 * path does. Bodies are the file's own solids, never connectivity — see
 * `src/import/stepTessellation.ts`.
 */
async function loadStepBodies(params: ImportModelFileParams, modelScale: number): Promise<LoadedBodies> {
  const { step, modelBuffer, axisSwap, signal, onProgress } = params
  if (!step) throw new Error('A STEP import needs its output unit and surface tolerance.')
  const tolerance = parseStepToleranceInput(step.tolerance)

  onProgress(translate('dialogs.importGeometry.tessellatingStep'), 5)
  const tessellate = params.tessellateStep ?? tessellateStepFile
  const stepBodies = await tessellate(modelBuffer, {
    outputUnit: step.outputUnit,
    // The tolerance is a length in project units, and the tessellated numbers
    // are scaled by `modelScale` on the way in — so OCCT receives it in theirs.
    linearDeflection: tolerance / modelScale,
    signal,
  })
  if (stepBodies.length === 0) throw new StepImportError({ code: 'no-geometry' })

  onProgress('Normalizing mesh', 10)
  let minZ = Infinity
  let maxZ = -Infinity
  const bodies = stepBodies.map(({ name, mesh }) => {
    applyAxisOrientationToPositions(mesh.positions, axisSwap)
    // Same world-frame → project-space conversion as the STL/OBJ path.
    const normalized = normalizeImportedMeshForStorage(flipImportedMeshPlanY(mesh), modelScale)
    minZ = Math.min(minZ, normalized.bounds.minZ)
    maxZ = Math.max(maxZ, normalized.bounds.maxZ)
    return { name, mesh: normalized }
  })

  if (bodies.length > MAX_IMPORT_BODIES) {
    return {
      bodies: [{ name: '', mesh: concatenateTriangleMeshes(bodies.map((body) => body.mesh)) }],
      height: maxZ - minZ,
      truncationWarning: bodyCapWarning('STEP', bodies.length),
    }
  }
  return { bodies, height: maxZ - minZ, truncationWarning: null }
}

/**
 * Feature names for the imported bodies. A single body takes the file name, as
 * it always has. Several bodies take the names their file gives them — a STEP
 * assembly names its parts — and otherwise the numbered file name. Repeats
 * (four instances of one bolt) are numbered so every row stays distinct.
 */
function bodyFeatureNames(baseName: string, bodyNames: readonly string[]): string[] {
  if (bodyNames.length === 1) return [baseName]
  const used = new Set<string>()
  return bodyNames.map((bodyName, index) => {
    const name = bodyName || (index === 0 ? baseName : `${baseName} (${index + 1})`)
    let candidate = name
    for (let copy = 2; used.has(candidate); copy += 1) candidate = `${name} (${copy})`
    used.add(candidate)
    return candidate
  })
}

/**
 * Import a 3D model file (STL, OBJ or STEP) as one or more silhouette-based
 * features. Pure async utility — not a hook.
 *
 * Two phases, so a failure or a cancel never leaves part of an import behind.
 * Everything that can fail — parsing or tessellation, normalizing, and every
 * body's silhouette and serialized mesh — runs before the project is touched.
 * Only then are the folder and features added, with nothing awaited in between.
 */
export async function importModelFile(params: ImportModelFileParams): Promise<string[]> {
  const { modelFormat, fileName, projectUnits, sourceUnits, signal, onProgress } = params
  const modelLabel = sourceTypeLabel(modelFormat)
  const modelScale = sourceUnits === projectUnits ? 1 : (sourceUnits === 'inch' ? 25.4 : 1 / 25.4)
  const requestedSilhouetteZSteps = parseSilhouetteZStepsInput(params.silhouetteZSteps)

  const loaded = modelFormat === 'step'
    ? await loadStepBodies(params, modelScale)
    : loadMeshBodies(params, modelFormat, modelScale)
  const { bodies } = loaded
  const resolvedZSteps = requestedSilhouetteZSteps ?? recommendedSilhouetteZSteps(loaded.height, projectUnits)

  const splitIntoBodies = bodies.length > 1
  const projectionBudget = 70
  const projectionStart = 15
  const prepared: Array<{ artifacts: ImportedModelArtifacts, mesh: PersistedImportedMesh }> = []

  for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex += 1) {
    signal?.throwIfAborted()
    const bodyLabel = splitIntoBodies
      ? `Body ${bodyIndex + 1} / ${bodies.length}`
      : modelLabel
    const bodyStart = projectionStart + (bodyIndex / bodies.length) * projectionBudget
    const bodyEnd = projectionStart + ((bodyIndex + 1) / bodies.length) * projectionBudget

    onProgress(`Projecting silhouette — ${bodyLabel} (${resolvedZSteps} Z steps)`, Math.round(bodyStart))
    // Shared with the post-import re-orientation path so the two cannot drift.
    const artifacts = await deriveImportedModelArtifacts(bodies[bodyIndex].mesh, {
      silhouetteZSteps: resolvedZSteps,
      onProgress: (p) => {
        onProgress(
          `Projecting silhouette — ${bodyLabel} (${resolvedZSteps} Z steps)`,
          Math.round(bodyStart + (bodyEnd - bodyStart) * (p / 100)),
        )
      },
    })
    if (!artifacts) {
      throw new Error(`Failed to generate silhouette for ${bodyLabel.toLowerCase()} of ${modelLabel} import`)
    }
    prepared.push({ artifacts, mesh: serializeImportedMesh(bodies[bodyIndex].mesh, modelFormat) })
  }
  signal?.throwIfAborted()

  // Commit.
  const baseName = fileName.replace(/\.(stl|obj|step|stp)$/i, '')
  const names = bodyFeatureNames(baseName, bodies.map((body) => body.name))
  const { addFeature, addFeatureFolder, updateFeatureFolder } = useProjectStore.getState()

  let importFolderId: string | null = null
  if (splitIntoBodies) {
    importFolderId = addFeatureFolder('features')
    updateFeatureFolder(importFolderId, { name: baseName })
  }

  const newFeatureIds = prepared.map(({ artifacts, mesh }, bodyIndex) => {
    const featureId = crypto.randomUUID()
    addFeature({
      id: featureId,
      name: names[bodyIndex],
      kind: 'stl',
      folderId: importFolderId,
      stl: {
        format: modelFormat,
        filePath: undefined,
        mesh,
        scale: 1,
        axisSwap: 'none',
        silhouettePaths: artifacts.silhouettePaths,
        topViewDataUrl: artifacts.topViewDataUrl,
      },
      sketch: {
        profile: artifacts.profile,
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
      operation: 'model',
      z_top: artifacts.meshZTop,
      z_bottom: artifacts.meshZBottom,
      visible: true,
      locked: false,
    })
    return featureId
  })

  onProgress('Import complete', 100)
  if (loaded.truncationWarning) {
    const notify = params.notify ?? ((message: string) => window.alert(message))
    notify(loaded.truncationWarning)
  }
  return newFeatureIds
}
