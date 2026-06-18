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
import type { Clamp, Point, Project, SketchFeature, Tab } from '../../types/project'
import { nextUniqueGeneratedId } from './ids'
import { duplicateClampName, duplicateFeatureName, duplicateTabName } from './naming'
import { inferProfileOrientationAngle, normalizeAngleDegrees } from './normalize'
import { mirrorFeatureFromReference } from './referenceTransforms'
import { rotatePointAround, transformProfile, transformStlFeatureData, translatePoint, translateProfile } from './transform'

export function buildRotatedCopies(
  sourceFeatures: SketchFeature[],
  existingFeatures: SketchFeature[],
  pivot: Point,
  angle: number,
  count: number,
): SketchFeature[] {
  const created: SketchFeature[] = []
  const projectLike: Project = { ...newProject(), features: existingFeatures, tools: [], operations: [] }

  for (let step = 1; step <= count; step += 1) {
    const stepAngle = angle * step
    const rotatePoint = (point: Point) => rotatePointAround(point, pivot, stepAngle)
    for (const sourceFeature of sourceFeatures) {
      const nextId = nextUniqueGeneratedId(
        { ...projectLike, features: [...existingFeatures, ...created] },
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
      })
    }
  }

  return created
}

export function buildMirroredCopies(
  sourceFeatures: SketchFeature[],
  existingFeatures: SketchFeature[],
  lineStart: Point,
  lineEnd: Point,
): SketchFeature[] {
  const created: SketchFeature[] = []
  const projectLike: Project = { ...newProject(), features: existingFeatures, tools: [], operations: [] }

  for (const sourceFeature of sourceFeatures) {
    const nextId = nextUniqueGeneratedId(
      { ...projectLike, features: [...existingFeatures, ...created] },
      'f',
    )
    const mirrored = mirrorFeatureFromReference(sourceFeature, lineStart, lineEnd)
    if (!mirrored) {
      continue
    }

    created.push({
      ...mirrored,
      id: nextId,
      name: duplicateFeatureName(sourceFeature.name, [...existingFeatures, ...created], 1, 1),
      folderId: sourceFeature.folderId,
      locked: false,
    })
  }

  return created
}

export function buildCopiedFeatures(
  sourceFeatures: SketchFeature[],
  existingFeatures: SketchFeature[],
  dx: number,
  dy: number,
  count: number,
): SketchFeature[] {
  const created: SketchFeature[] = []
  const projectLike: Project = {
    ...newProject(),
    features: existingFeatures,
    tools: [],
    operations: [],
  }

  for (let step = 1; step <= count; step += 1) {
    for (const sourceFeature of sourceFeatures) {
      const nextId = nextUniqueGeneratedId(
        {
          ...projectLike,
          features: [...existingFeatures, ...created],
        },
        'f',
      )
      created.push({
        ...sourceFeature,
        id: nextId,
        name: duplicateFeatureName(sourceFeature.name, [...existingFeatures, ...created], count, step),
        folderId: sourceFeature.folderId,
        stl: transformStlFeatureData(sourceFeature.stl, (point) => translatePoint(point, dx * step, dy * step)),
        sketch: {
          ...sourceFeature.sketch,
          origin: ['text', 'stl'].includes(sourceFeature.kind)
            ? { x: sourceFeature.sketch.origin.x + dx * step, y: sourceFeature.sketch.origin.y + dy * step }
            : sourceFeature.sketch.origin,
          profile: translateProfile(sourceFeature.sketch.profile, dx * step, dy * step),
        },
        locked: false,
      })
    }
  }

  return created
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
