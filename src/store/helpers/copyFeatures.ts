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

import { newProject } from '../../types/project'
import type { Clamp, FeatureDefinition, Matrix2D, Point, Project, SketchFeature, Tab } from '../../types/project'
import { nextUniqueGeneratedId } from './ids'
import { moveDelta, multiplyMatrix, rotateDelta } from './instanceTransforms'
import { duplicateClampName, duplicateFeatureName, duplicateTabName } from './naming'
import { inferProfileOrientationAngle, normalizeAngleDegrees } from './normalize'
import { mirrorFeatureFromReference } from './referenceTransforms'
import { resolveProfile } from './resolveFeatures'
import { rotatePointAround, transformProfile, transformStlFeatureData, translatePoint } from './transform'

export type ReferencedSketchFeature = SketchFeature & {
  definitionId: string
  transform: Matrix2D
}

export function buildRotatedCopies(
  sourceFeatures: ReferencedSketchFeature[],
  existingFeatures: Array<{ name: string }>,
  pivot: Point,
  angle: number,
  count: number,
): ReferencedSketchFeature[] {
  const created: ReferencedSketchFeature[] = []
  const projectLike = newProject()

  for (let step = 1; step <= count; step += 1) {
    const stepAngle = angle * step
    const rotatePoint = (point: Point) => rotatePointAround(point, pivot, stepAngle)
    for (const sourceFeature of sourceFeatures) {
      const nextId = nextUniqueGeneratedId(
        projectLike,
        'f',
      )
      const profile = transformProfile(sourceFeature.sketch.profile, rotatePoint)
      created.push({
        ...sourceFeature,
        id: nextId,
        name: duplicateFeatureName(sourceFeature.name, [...existingFeatures, ...created], count, step),
        folderId: sourceFeature.folderId,
        stl: transformStlFeatureData(sourceFeature.stl, rotatePoint),
        sketch: {
          ...sourceFeature.sketch,
          origin: rotatePoint(sourceFeature.sketch.origin),
          orientationAngle: normalizeAngleDegrees(
            (sourceFeature.sketch.orientationAngle ?? inferProfileOrientationAngle(sourceFeature.sketch.profile)) + stepAngle * (180 / Math.PI),
          ),
          profile,
        },
        locked: false,
        transform: multiplyMatrix(rotateDelta(pivot, stepAngle), sourceFeature.transform),
      })
    }
  }

  return created
}

export function buildMirroredCopies(
  sourceFeatures: ReferencedSketchFeature[],
  existingFeatures: Array<{ name: string }>,
  lineStart: Point,
  lineEnd: Point,
): ReferencedSketchFeature[] {
  const created: ReferencedSketchFeature[] = []
  const projectLike = newProject()

  for (const sourceFeature of sourceFeatures) {
    const nextId = nextUniqueGeneratedId(
      projectLike,
      'f',
    )
    const mirrored = mirrorFeatureFromReference(sourceFeature, lineStart, lineEnd)
    if (!mirrored) {
      continue
    }
    created.push({
      ...mirrored,
      id: nextId,
      definitionId: sourceFeature.definitionId,
      transform: mirrored.transform,
      name: duplicateFeatureName(sourceFeature.name, [...existingFeatures, ...created], 1, 1),
      folderId: sourceFeature.folderId,
      locked: false,
    })
  }

  return created
}

export function buildCopiedFeatures(
  sourceFeatures: ReferencedSketchFeature[],
  existingFeatures: Array<{ name: string }>,
  dx: number,
  dy: number,
  count: number,
  projectDefinitions: Record<string, FeatureDefinition>,
  copyMode: 'reference' | 'independent',
): Array<ReferencedSketchFeature & { _clonedDefinition?: FeatureDefinition }> {
  const created: Array<ReferencedSketchFeature & { _clonedDefinition?: FeatureDefinition }> = []
  const projectLike = newProject()
  const effectiveCopyMode = copyMode
  const definitions = projectDefinitions

  for (let step = 1; step <= count; step += 1) {
    for (const sourceFeature of sourceFeatures) {
      const nextId = nextUniqueGeneratedId(
        projectLike,
        'f',
      )
      const newTransform = multiplyMatrix(moveDelta(dx * step, dy * step), sourceFeature.transform)

      if (effectiveCopyMode === 'reference') {
        // Reference copy: same definitionId, no new definition. Materialize a
        // short-lived resolved profile for the existing copy-placement path.
        const definitionId = sourceFeature.definitionId
        const definition = definitions[definitionId]
        if (!definition) {
          throw new Error(`Cannot copy feature ${sourceFeature.id}: definition ${definitionId} is missing`)
        }
        const resolvedProfile = resolveProfile(definition, newTransform)

        created.push({
          ...sourceFeature,
          id: nextId,
          definitionId,
          name: duplicateFeatureName(sourceFeature.name, [...existingFeatures, ...created], count, step),
          folderId: sourceFeature.folderId,
          stl: transformStlFeatureData(sourceFeature.stl, (point) => translatePoint(point, dx * step, dy * step)),
          sketch: {
            ...sourceFeature.sketch,
            origin: ['text', 'stl'].includes(sourceFeature.kind)
              ? { x: sourceFeature.sketch.origin.x + dx * step, y: sourceFeature.sketch.origin.y + dy * step }
              : sourceFeature.sketch.origin,
            profile: resolvedProfile,
          },
          locked: false,
          transform: newTransform,
        })
      } else {
        // Independent copy: clone definition for each source feature.
        // The caller is expected to merge the cloned definitions into
        // project.featureDefinitions and update definitionId on each
        // created feature row.
        const definitionId = sourceFeature.definitionId
        const definition = definitions[definitionId]
        if (!definition) {
          throw new Error(`Cannot copy feature ${sourceFeature.id}: definition ${definitionId} is missing`)
        }
        const clonedDefinitionId = `f-${nextId}`
        const clonedDef: FeatureDefinition = {
          ...definition,
          id: clonedDefinitionId,
          profile: { ...definition.profile, segments: definition.profile.segments.map((s) => ({ ...s } as typeof s)) },
          dimensions: definition.dimensions.map((d) => ({ ...d })),
          text: definition.text ? { ...definition.text } : null,
          stl: definition.stl ? { ...definition.stl } : null,
        }
        const resolvedProfile = resolveProfile(clonedDef, newTransform)

        created.push({
          ...sourceFeature,
          id: nextId,
          definitionId: clonedDefinitionId,
          name: duplicateFeatureName(sourceFeature.name, [...existingFeatures, ...created], count, step),
          folderId: sourceFeature.folderId,
          stl: transformStlFeatureData(sourceFeature.stl, (point) => translatePoint(point, dx * step, dy * step)),
          sketch: {
            ...sourceFeature.sketch,
            origin: ['text', 'stl'].includes(sourceFeature.kind)
              ? { x: sourceFeature.sketch.origin.x + dx * step, y: sourceFeature.sketch.origin.y + dy * step }
              : sourceFeature.sketch.origin,
            profile: resolvedProfile,
          },
          locked: false,
          transform: newTransform,
          _clonedDefinition: clonedDef,
        })
      }
    }
  }

  return created
}

/**
 * Extract cloned definitions from features created by
 * {@link buildCopiedFeatures} in independent mode.
 */
export function extractClonedDefinitions(
  createdFeatures: SketchFeature[],
): Record<string, FeatureDefinition> {
  const defs: Record<string, FeatureDefinition> = {}
  for (const feature of createdFeatures) {
    const withClone = feature as SketchFeature & { _clonedDefinition?: FeatureDefinition }
    if (withClone._clonedDefinition) {
      defs[withClone._clonedDefinition.id] = withClone._clonedDefinition
    }
  }
  return defs
}

export function buildCopiedClamps(
  sourceClamps: Clamp[],
  existingClamps: Clamp[],
  project: Project,
  dx: number,
  dy: number,
  count: number,
): Clamp[] {
  const created: Clamp[] = []

  for (let step = 1; step <= count; step += 1) {
    for (const sourceClamp of sourceClamps) {
      created.push({
        ...sourceClamp,
        id: nextUniqueGeneratedId(
          {
            ...project,
            clamps: [...existingClamps, ...created],
          },
          'cl',
        ),
        name: duplicateClampName(sourceClamp.name, [...existingClamps, ...created]),
        x: sourceClamp.x + dx * step,
        y: sourceClamp.y + dy * step,
      })
    }
  }

  return created
}

export function buildCopiedTabs(
  sourceTabs: Tab[],
  existingTabs: Tab[],
  project: Project,
  dx: number,
  dy: number,
  count: number,
): Tab[] {
  const created: Tab[] = []

  for (let step = 1; step <= count; step += 1) {
    for (const sourceTab of sourceTabs) {
      created.push({
        ...sourceTab,
        id: nextUniqueGeneratedId(
          {
            ...project,
            tabs: [...existingTabs, ...created],
          },
          'tb',
        ),
        name: duplicateTabName(sourceTab.name, [...existingTabs, ...created]),
        x: sourceTab.x + dx * step,
        y: sourceTab.y + dy * step,
      })
    }
  }

  return created
}
