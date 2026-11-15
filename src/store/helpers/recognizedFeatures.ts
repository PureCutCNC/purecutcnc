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
 * Drawing the pockets and holes found on an imported model (issue #1206).
 *
 * The shapes become ordinary features in one new folder placed directly after
 * the model in the tree. That position is the point: #964 reads a subtract
 * that comes after a model as cutting into it. Nothing links the shapes back
 * to the model, so nothing new is saved in the project.
 */

import { createImportedFeature, isProfileDegenerate } from '../../import/normalize'
import { cannedShapeIsModel, isCannedFeature } from '../../cannedShapes'
import type {
  FeatureDefinition,
  FeatureFolder,
  FeatureTreeEntry,
  FlatFace,
  Project,
  SketchFeature,
  SketchProfile,
} from '../../types/project'
import { createDefinitionForFeatureWithId, createFeatureInstance } from './featureDefinitions'
import { normalizeFeatureZRange, syncFeatureTreeProject } from './normalize'
import { projectType } from './projectType'
import { resolveFeatureInstance } from './resolveFeatures'

export interface RecognizedShapeInput {
  name: string
  profile: SketchProfile
  operation: 'add' | 'subtract'
  zTop: number
  zBottom: number
  face: FlatFace
}

export interface AddRecognizedFeaturesInput {
  modelFeatureId: string
  /** Already localized by the caller; made unique here. */
  folderName: string
  shapes: RecognizedShapeInput[]
}

/**
 * Why pockets and holes cannot be looked for on this feature, or null when
 * they can.
 *
 * - `notAModel`: not an imported model with a mesh.
 * - `generatedModel`: a canned Turn or Polygon — its shape is its parameters.
 * - `aroundModel`: a model on the Around sheet (a later slice).
 * - `plasma`: a plasma project cuts no pockets.
 */
export type ModelRecognitionRefusal = 'notAModel' | 'generatedModel' | 'aroundModel' | 'plasma'

export function modelRecognitionRefusal(project: Project, featureId: string | null): ModelRecognitionRefusal | null {
  const feature = featureId ? resolveFeatureInstance(project, featureId) : null
  if (!feature || feature.operation !== 'model') return 'notAModel'
  if (isCannedFeature(feature) || cannedShapeIsModel(feature.canned)) return 'generatedModel'
  if (feature.kind !== 'stl' || !feature.stl?.meshAssetId) return 'notAModel'
  if (feature.authoringFace === 'around') return 'aroundModel'
  if (projectType(project) === 'plasma') return 'plasma'
  return null
}

export interface RecognizedFeaturesPlan {
  project: Project
  createdIds: string[]
  folderId: string
}

/**
 * The project with the shapes added, or null when there is nothing to add.
 * Pure: ids and names come from the caller's allocators.
 */
export function planRecognizedFeatures(
  project: Project,
  input: AddRecognizedFeaturesInput,
  allocateId: (prefix: string) => string,
  allocateFeatureName: (preferred: string) => string,
  allocateFolderName: (preferred: string) => string,
): RecognizedFeaturesPlan | null {
  if (modelRecognitionRefusal(project, input.modelFeatureId)) return null
  const model = project.features.find((feature) => feature.id === input.modelFeatureId)
  if (!model) return null
  const shapes = input.shapes.filter((shape) => (
    shape.profile.closed && !isProfileDegenerate(shape.profile) && shape.zTop > shape.zBottom
  ))
  if (shapes.length === 0) return null

  const folder: FeatureFolder = {
    id: allocateId('fd'),
    name: allocateFolderName(input.folderName),
    collapsed: false,
  }
  const definitions: Record<string, FeatureDefinition> = {}
  const instances = shapes.map((shape) => {
    const draft: SketchFeature = normalizeFeatureZRange({
      ...createImportedFeature(
        { name: shape.name, sourceType: 'stl', layerName: null, profile: shape.profile },
        project,
        folder.id,
        allocateFeatureName(shape.name),
        shape.operation,
      ),
      id: allocateId('f'),
      z_top: shape.zTop,
      z_bottom: shape.zBottom,
      authoringFace: shape.face,
    })
    const definitionId = allocateId('f-')
    definitions[definitionId] = createDefinitionForFeatureWithId(draft, definitionId).definition
    return createFeatureInstance(draft, definitionId)
  })

  // Directly after the model: after its own row at the root, or after the
  // folder it sits in (folders do not nest).
  const anchor = (entry: FeatureTreeEntry): boolean => (
    model.folderId === null
      ? entry.type === 'feature' && entry.featureId === model.id
      : entry.type === 'folder' && entry.folderId === model.folderId
  )
  // The tree may not list the model yet; `syncFeatureTreeProject` adds missing
  // rows at the end, so settle the order first and insert into that.
  const settled = syncFeatureTreeProject(project)
  const anchorIndex = settled.featureTree.findIndex(anchor)
  const featureTree = [...settled.featureTree]
  featureTree.splice(anchorIndex < 0 ? featureTree.length : anchorIndex + 1, 0, { type: 'folder', folderId: folder.id })

  return {
    project: syncFeatureTreeProject({
      ...settled,
      featureFolders: [...settled.featureFolders, folder],
      featureTree,
      features: [...settled.features, ...instances],
      featureDefinitions: { ...settled.featureDefinitions, ...definitions },
      meta: { ...settled.meta, modified: new Date().toISOString() },
    }),
    createdIds: instances.map((instance) => instance.id),
    folderId: folder.id,
  }
}
