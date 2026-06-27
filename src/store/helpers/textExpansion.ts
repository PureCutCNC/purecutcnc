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
 * Text Feature Expansion — convert a text feature into exploded child features
 * organized per letter/glyph, with optional source feature removal.
 *
 * Each letter becomes a group folder containing one or more contour features
 * (outline fonts can produce multiple contours per letter due to holes).
 */

import type { FeatureDefinition, FeatureFolder, SketchFeature, Project } from '../../types/project'
import { IDENTITY_MATRIX } from '../../types/project'
import { resolveTextFeatureShapes } from '../../text'
import { nextUniqueGeneratedId } from './ids'

interface TextExpansionResult {
  /** New letter group folders (one per unique letter, with 'grouped' flag set) */
  folders: FeatureFolder[]
  /** Exploded child features (with definitionId + identity transform) */
  features: SketchFeature[]
}

/**
 * Convert a text feature into exploded child features.
 *
 * @param project The current project (needed for resolver context and ID generation)
 * @param textFeature The text feature to expand
 * @returns Folders (per letter) and exploded features
 *
 * Algorithm:
 * 1. Resolve the text feature's glyph shapes (skeleton strokes or outline contours).
 * 2. Group shapes by letter index (extracting the numeric index from shape name).
 * 3. For each letter, create a group folder with the letter as name.
 * 4. For each shape, create a new feature with a fresh definition (no linking).
 * 5. Preserve operation, z_range, visibility, and lock state from the source text feature.
 */
export function expandTextFeature(
  project: Project,
  textFeature: SketchFeature,
): TextExpansionResult {
  const shapes = resolveTextFeatureShapes(textFeature)

  if (shapes.length === 0) {
    return { folders: [], features: [] }
  }

  const folders: FeatureFolder[] = []
  const features: SketchFeature[] = []

  // Group shapes by letter index. Names are typically "TEXT 1", "TEXT 2", etc.
  // For outline fonts with holes, there can be multiple shapes per letter.
  const shapesByLetter = new Map<number, typeof shapes>()
  for (const shape of shapes) {
    // Extract the glyph index from the shape name (e.g., "TEXT 1" → 1, "TEXT 1a" → 1)
    const letterMatch = shape.name.match(/\s(\d+)/)
    const letterIndex = letterMatch ? parseInt(letterMatch[1], 10) : 0

    if (!shapesByLetter.has(letterIndex)) {
      shapesByLetter.set(letterIndex, [])
    }
    shapesByLetter.get(letterIndex)!.push(shape)
  }

  // Create one group folder per unique letter and explode features into it
  for (const [letterIndex, letterShapes] of shapesByLetter) {
    const folderId = nextUniqueGeneratedId(project, 'fg')
    const letterName = `${textFeature.text?.text || 'TEXT'} ${letterIndex}`

    // Create the letter group folder
    const folder: FeatureFolder = {
      id: folderId,
      name: letterName,
      collapsed: false,
      grouped: true, // Mark as a grouped folder so the UI knows it's an expansion result
    }
    folders.push(folder)

    // Create a feature for each shape (handles outline fonts with holes/secondary contours)
    for (const shape of letterShapes) {
      // Create a fresh definition for each exploded feature (no linking)
      const definition: FeatureDefinition = {
        id: nextUniqueGeneratedId(project, 'def'),
        kind: 'composite',
        profile: shape.profile,
        text: null,
        stl: null,
        dimensions: [],
        operation: shape.operation,
      }

      const feature: SketchFeature = {
        id: nextUniqueGeneratedId(project, 'ft'),
        name: shape.name,
        kind: 'composite',
        text: null,
        stl: null,
        folderId,
        sketch: {
          profile: shape.profile,
          origin: textFeature.sketch.origin,
          orientationAngle: textFeature.sketch.orientationAngle,
          dimensions: [],
          constraints: [],
        },
        operation: shape.operation,
        z_top: textFeature.z_top,
        z_bottom: textFeature.z_bottom,
        visible: textFeature.visible,
        locked: textFeature.locked,
      }

      // Add definition refs (for now, features will have definitionId + identity transform)
      const featureWithRefs = feature as SketchFeature & {
        definitionId?: string
        transform?: typeof IDENTITY_MATRIX
      }
      featureWithRefs.definitionId = definition.id
      featureWithRefs.transform = IDENTITY_MATRIX

      features.push(feature)
    }
  }

  return { folders, features }
}
