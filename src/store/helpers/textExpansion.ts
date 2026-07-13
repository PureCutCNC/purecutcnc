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
 * organized per letter/glyph, with each letter becoming a group folder.
 *
 * Each letter becomes a group folder containing one or more contour features
 * (outline fonts can produce multiple contours per letter due to holes).
 * Skeleton fonts always produce open profiles (line features).
 */

import type { FeatureDefinition, FeatureFolder, FeatureInstance, SketchFeature, Project } from '../../types/project'
import { resolveTextFeatureShapes } from '../../text'
import { nextUniqueGeneratedId } from './ids'
import { createFeatureInstance } from './featureDefinitions'

interface TextExpansionResult {
  /** New letter group folders (one per unique letter, with 'grouped' flag set) */
  folders: FeatureFolder[]
  /** Exploded child features (with definitionId + identity transform) */
  features: FeatureInstance[]
  /** Feature definitions keyed by definition id */
  definitions: Record<string, FeatureDefinition>
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
 * 2. Group shapes by glyph letter index.
 * 3. For each letter, create a group folder with the letter character appended.
 * 4. For each shape, create a new feature with a fresh definition (no linking).
 * 5. Skeleton fonts always produce open profiles (line features).
 * 6. Preserve operation, z_range, visibility, and lock state from the source text feature.
 */
export function expandTextFeature(
  project: Project,
  textFeature: SketchFeature,
): TextExpansionResult {
  const shapes = resolveTextFeatureShapes(textFeature)

  if (shapes.length === 0) {
    return { folders: [], features: [], definitions: {} }
  }

  const textString = textFeature.text?.text || 'TEXT'
  const folders: FeatureFolder[] = []
  const features: FeatureInstance[] = []
  const definitions: Record<string, FeatureDefinition> = {}

  // Group shapes by glyph index (letter position)
  const shapesByGlyph = new Map<number, typeof shapes>()
  const glyphCharMap = new Map<number, string>()

  for (const shape of shapes) {
    const glyphIndex = shape.glyphIndex ?? 0
    const glyphChar = shape.glyphChar ?? (textString[glyphIndex - 1] || '?')

    if (!shapesByGlyph.has(glyphIndex)) {
      shapesByGlyph.set(glyphIndex, [])
    }
    shapesByGlyph.get(glyphIndex)!.push(shape)
    glyphCharMap.set(glyphIndex, glyphChar)
  }

  // Create one group folder per unique glyph and explode features into it
  for (const [glyphIndex, glyphShapes] of shapesByGlyph) {
    const folderId = nextUniqueGeneratedId(project, 'fg')
    const glyphChar = glyphCharMap.get(glyphIndex) || '?'
    const folderName = glyphChar

    // Create the glyph group folder
    const folder: FeatureFolder = {
      id: folderId,
      name: folderName,
      collapsed: false,
      grouped: true, // Mark as a grouped folder so the UI knows it's an expansion result
    }
    folders.push(folder)

    // Create a feature for each shape (handles outline fonts with holes/secondary contours)
    for (const shape of glyphShapes) {
      // Create a fresh definition for each exploded feature (no linking)
      const definitionId = nextUniqueGeneratedId(project, 'def')
      definitions[definitionId] = {
        id: definitionId,
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

      features.push(createFeatureInstance(feature, definitionId))
    }
  }

  return { folders, features, definitions }
}
