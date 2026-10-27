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
 * Canned-shape expansion — turn a stored shape into plain outline features
 * with the Add/Subtract the nesting rule gave each outline (issue #1112).
 *
 * Mirrors `textExpansion.ts`: the source row is kept, the pieces go into one
 * grouped folder (Text creates one per glyph; a canned shape has no natural
 * per-glyph split, so it gets one folder named after the shape).
 */

import type { FeatureDefinition, FeatureFolder, FeatureInstance, Project, SketchFeature } from '../../types/project'
import { resolveCannedShapeShapes } from '../../cannedShapes'
import { nextUniqueGeneratedId } from './ids'
import { createFeatureInstance } from './featureDefinitions'

export interface CannedExpansionResult {
  folders: FeatureFolder[]
  features: FeatureInstance[]
  definitions: Record<string, FeatureDefinition>
}

/** Explode a canned shape into one plain feature per generated outline. */
export function expandCannedFeature(
  project: Project,
  cannedFeature: SketchFeature,
): CannedExpansionResult {
  // Sorted by nesting depth so the outer outlines are inserted before the holes
  // they belong to — tree order is what CSG folds (Text's contours arrive in
  // draw order for the same reason).
  const shapes = resolveCannedShapeShapes(cannedFeature)
    .slice()
    .sort((left, right) => left.depth - right.depth)
  if (shapes.length === 0) {
    return { folders: [], features: [], definitions: {} }
  }

  const folderId = nextUniqueGeneratedId(project, 'fg')
  const folders: FeatureFolder[] = [{
    id: folderId,
    name: cannedFeature.name,
    collapsed: false,
    grouped: true,
  }]

  const features: FeatureInstance[] = []
  const definitions: Record<string, FeatureDefinition> = {}

  shapes.forEach((shape, index) => {
    const definitionId = nextUniqueGeneratedId(project, 'def')
    definitions[definitionId] = {
      id: definitionId,
      kind: 'composite',
      profile: shape.profile,
      dimensions: [],
      text: null,
      stl: null,
      operation: shape.operation,
    }

    const feature: SketchFeature = {
      id: nextUniqueGeneratedId(project, 'ft'),
      name: shape.name ?? (index === 0 ? cannedFeature.name : `${cannedFeature.name} ${index + 1}`),
      kind: 'composite',
      text: null,
      stl: null,
      folderId,
      sketch: {
        profile: shape.profile,
        origin: cannedFeature.sketch.origin,
        orientationAngle: cannedFeature.sketch.orientationAngle,
        dimensions: [],
        constraints: [],
      },
      operation: shape.operation,
      z_top: cannedFeature.z_top,
      z_bottom: cannedFeature.z_bottom,
      authoringFace: cannedFeature.authoringFace,
      visible: cannedFeature.visible,
      locked: cannedFeature.locked,
    }

    features.push(createFeatureInstance(feature, definitionId))
  })

  return { folders, features, definitions }
}
